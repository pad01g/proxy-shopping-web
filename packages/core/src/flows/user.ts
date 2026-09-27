import type { Hex } from 'viem';
import { DEFAULT_MAX_FEE_RATE, feeRateFor } from '../btc/esplora.js';
import { buildFundingTx } from '../btc/funding.js';
import { witnessScript, type EscrowKeys } from '../btc/script.js';
import { extractTx, finalizeEscrowInput, psbtFromBase64, psbtToBase64, signEscrowInput, buildEscrowSpend } from '../btc/spend.js';
import { sealDelivery } from '../delivery/delivery.js';
import type { SignedTx } from '../evm/chain.js';
import { crossCheckDeployments, type Deployments } from '../evm/deployments.js';
import { knownProxyCreationCode, SAFE_PROXY_CREATION_CODE } from '../evm/proxy-creation-code.js';
import { recoverSafeTxSigner, releaseSafeTx, safeTxFromJson, safeTxToJson, signSafeTx } from '../evm/safetx.js';
import { signKeyProofBtc, signKeyProofEvm } from '../keys/proof.js';
import { innerMeta, type Inner } from '../nostr/giftwrap.js';
import type { IncomingMessage } from '../nostr/messenger.js';
import { requestItemsProblem } from '../nostr/schema.js';
import {
  CONTAINER_TYPES, MSG, type Address, type DisputeEvidence, type DisputeOpen, type DisputeRuling, type EscrowNotice, type OrderFunded,
  type OrderPurchased, type OrderQuote, type OrderRequest, type OrderShipping, type Payment, type SignedPayout, type TrackingStatus,
} from '../nostr/messages.js';
import type { Offer } from '../trust/directory.js';
import type { EffectiveEntry, EscrowProfileContent, ShopperProfileContent } from '../trust/types.js';
import { fromHex, newOrderId, toHex } from '../util/bytes.js';
import { parseUnits } from '../util/decimal.js';
import { Emitter } from '../util/emitter.js';
import { KeyedMutex, nowSeconds } from '../util/time.js';
import { evidenceWithoutInlineData, splitEvidence } from './evidence.js';
import { btcPayoutProblems, safePayoutProblems } from './payout-check.js';
import { checkQuote, type QuoteCheck } from './quote-check.js';
import type { Session } from './session.js';
import { escrowSpent } from './settlement.js';
import { clockSkewProblem } from './timelock-policy.js';

export type UserOrderStatus =
  | 'requested' | 'quoted' | 'rejected' | 'accepted' | 'funding' | 'funded' | 'purchased' | 'shipped'
  | 'delivered' | 'delivery_failed' | 'released' | 'completed' | 'disputed' | 'ruled' | 'settled'
  | 'refunded' | 'cancelled';

export interface TimelineEntry {
  at: number;
  kind: string;
  text: string;
}

/** A cooperative refund proposed by the shopper (order.refund). Never signed without the user's click. */
export interface RefundOffer {
  body: SignedPayout;
  inner: Inner;
  receivedAt: number;
  /** Why it does not match the §4.10 template (empty = acceptable). */
  problems: string[];
  /** What it pays us, for the confirmation dialog. */
  amount?: string;
  recipient?: string;
}

export interface UserOrder {
  id: string;
  status: UserOrderStatus;
  createdAt: number;
  updatedAt: number;
  payment: Payment;
  shopper: string;
  escrow: string;
  entry: EffectiveEntry;
  shopperProfile?: ShopperProfileContent;
  escrowProfile?: EscrowProfileContent;
  address: Address;
  /** hex(K) — kept so disputes can hand the key to the escrow. */
  deliveryKey: string;
  /** NIP-44(user→escrow, hex(K)); sent to the shopper in order.escrow_key and to the escrow in a dispute (§4.4). */
  keyForEscrow: string;
  request: OrderRequest;
  requestInner: Inner;
  escrowKeyInner?: Inner;
  quote?: OrderQuote;
  quoteInner?: Inner;
  quoteCheck?: QuoteCheck;
  acceptInner?: Inner;
  /**
   * Intermediate funding progress, persisted before anything is sent, so a retry (or another tab) never pays
   * twice. EVM steps keep the signed raw transaction too, so a step signed but never sent can be sent later.
   */
  fundingProgress?: FundingProgress;
  funded?: OrderFunded;
  fundedInner?: Inner;
  purchased?: OrderPurchased;
  tracking: TrackingStatus[];
  releaseTxid?: string;
  /**
   * A payout waiting for on-chain confirmation (§4.8): a peer's order.completed / dispute.countersigned
   * claim, or a transaction we broadcast ourselves (a relay's acceptance is not a spend).
   */
  pendingSettlement?: { kind: 'completed' | 'settled' | 'refunded'; txid: string; from: string; at: number };
  /** Set once the chain shows the escrow output was paid out; only then are the T2 refund and dispute moot. */
  escrowSpent?: { txid?: string; at: number };
  completedTxid?: string;
  dispute?: { open: DisputeOpen; inner: Inner };
  /** A dispute the shopper opened (copy of its dispute.open). */
  shopperDispute?: { open: DisputeOpen; inner: Inner };
  ruling?: DisputeRuling;
  rulingInner?: Inner;
  /** A ruling that arrived before we knew of a dispute; evaluated once we do (§4.8). */
  pendingRuling?: { body: DisputeRuling; inner: Inner; receivedAt: number };
  /** The escrow asked us for evidence, so it knows of a dispute (§4.8). */
  evidenceRequestedAt?: number;
  settledTxid?: string;
  refundOffer?: RefundOffer;
  refundTxid?: string;
  messages: Inner[];
  timeline: TimelineEntry[];
  lastError?: string;
  /** Messages of this order's parties that were dropped (schema, rate limit), newest last, shown to the user. */
  dropped?: Array<{ at: number; type: string; reason: string; from: 'shopper' | 'escrow' }>;
}

export interface FundingProgress {
  btcTxid?: string;
  btcTxHex?: string;
  /** Safe deployment tx hash, or 'already-deployed' when the Safe existed (anyone may deploy it). */
  deployTx?: string;
  fundTx?: string;
  feeTx?: string;
  deployRaw?: string;
  fundRaw?: string;
  feeRaw?: string;
}

/** Only a transaction id / hash counts as "funding started"; before that the order may still be cancelled. */
export function fundingStarted(o: Pick<UserOrder, 'fundingProgress'>): boolean {
  const p = o.fundingProgress;
  return !!(p?.btcTxid || (p?.deployTx && p.deployTx !== 'already-deployed') || p?.fundTx || p?.feeTx);
}

/**
 * The order.funded body implied by a funding that was interrupted before order.funded was sent (tab closed,
 * network error): the escrow output may already hold our money, so refund and dispute must stay reachable.
 * It still has to be confirmed on chain before use.
 */
export function provisionalFunding(o: Pick<UserOrder, 'funded' | 'fundingProgress' | 'quote' | 'payment'>): OrderFunded | undefined {
  if (o.funded) return o.funded;
  const p = o.fundingProgress;
  const q = o.quote;
  if (!p || !q?.lock_amount || !q.escrow_address) return undefined;
  if (o.payment === 'btc-signet') {
    return p.btcTxid ? { asset: 'btc-signet', txid: p.btcTxid, vout: 0, amount: q.lock_amount, fee_txid: p.btcTxid } : undefined;
  }
  return p.fundTx
    ? { asset: 'usdc-evm', safe: q.escrow_address, deploy_tx: p.deployTx ?? '', fund_tx: p.fundTx, fee_tx: p.feeTx ?? '', amount: q.lock_amount }
    : undefined;
}

/** Whether we know of an open dispute on this order: ours, the shopper's copy, or the escrow asking for evidence. */
export const disputeKnown = (o: Pick<UserOrder, 'dispute' | 'shopperDispute' | 'evidenceRequestedAt'>): boolean =>
  !!(o.dispute || o.shopperDispute || o.evidenceRequestedAt);

export interface CreateOrderInput {
  offer: Offer;
  shopUrl: string;
  region: string;
  items: Array<{ sku: string; qty: number }>;
  payment: Payment;
  address: Address;
}

/** What funding will cost, shown before the user confirms (§4.6, item: fee preview). */
export interface FundingPreview {
  asset: Payment;
  lock: bigint;
  upfrontFee: bigint;
  /** BTC only: miner fee at `feeRate` sat/vB. */
  networkFee?: bigint;
  feeRate?: number;
  total: bigint;
  recipients: Array<{ label: string; address: string; amount: bigint }>;
}

type Events = {
  order: UserOrder;
  error: { orderId?: string; error: Error };
};

const PREFIX = 'user/orders/';
/** order.funded must reach the chain within this long after expires_at (§4.6). */
const FUNDING_GRACE_SECONDS = 3600;
const PRE_FUNDING: readonly UserOrderStatus[] = ['requested', 'quoted', 'rejected', 'accepted', 'funding'];
const DROPPED_KEPT = 20;

export interface UserClientOptions {
  deployments?: Deployments;
  confirmations?: number;
  /** How often pending settlement claims are re-checked on chain (ms, default 5000; 0 = never). */
  chainPollMs?: number;
}

/**
 * The user role (§11): order, validate quote, fund, release, dispute, refund.
 * State lives in storage; every mutation emits 'order'.
 */
export class UserClient extends Emitter<Events> {
  private readonly lock = new KeyedMutex();
  private unsubscribe?: () => void;
  private unaccept?: () => void;
  private unsubscribeDropped?: () => void;
  private poller?: ReturnType<typeof setInterval>;
  private polling = false;

  constructor(
    private readonly s: Session,
    private readonly opts: UserClientOptions = {},
  ) {
    super();
  }

  /** Begin handling incoming messages (call before session.start()). */
  attach(): this {
    this.unsubscribe ??= this.s.messenger.on('message', (m) => {
      void this.onMessage(m).catch((error) => this.emit('error', { orderId: m.orderId, error }));
    });
    // §4.10: we take messages about our orders from their shopper and escrow; nothing else.
    this.unaccept ??= this.s.addAcceptor(async (inner, meta) => {
      const o = await this.getOrder(meta.orderId);
      return o && (inner.pubkey === o.shopper || inner.pubkey === o.escrow) ? 'counterparty' : 'reject';
    });
    this.unsubscribeDropped ??= this.s.messenger.on('dropped', (d) => {
      void this.onDropped(d.inner, d.reason).catch((error) => this.emit('error', { error }));
    });
    const every = this.opts.chainPollMs ?? 5000;
    if (every > 0 && !this.poller) {
      this.poller = setInterval(() => void this.pollSettlements(), every);
      (this.poller as { unref?: () => void }).unref?.();
    }
    return this;
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unaccept?.();
    this.unaccept = undefined;
    this.unsubscribeDropped?.();
    this.unsubscribeDropped = undefined;
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
  }

  setDeployments(d: Deployments | undefined): void {
    this.opts.deployments = d;
  }

  // ---------- queries ----------

  async discoverOffers(q: { shopUrl: string; region: string; payment?: Payment; refresh?: boolean }): Promise<Offer[]> {
    if (q.refresh ?? true) await this.s.directory.refresh();
    return this.s.directory.offers(q);
  }

  async listOrders(): Promise<UserOrder[]> {
    const rows = await this.s.storage.list<UserOrder>(PREFIX);
    return rows.map(([, o]) => o).sort((a, b) => b.createdAt - a.createdAt);
  }

  getOrder(orderId: string): Promise<UserOrder | undefined> {
    return this.s.storage.get<UserOrder>(PREFIX + orderId);
  }

  /** Amounts, recipients and (BTC) the miner fee of funding, without sending anything. */
  async previewFunding(orderId: string): Promise<FundingPreview> {
    const o = await this.require(orderId);
    const q = o.quote;
    if (!q?.lock_amount || !q.escrow_address) throw new Error('no accepted quote');
    const lock = parseUnits(q.lock_amount);
    const upfrontFee = parseUnits(q.escrow_upfront_fee ?? '0');
    const recipients = [{ label: 'escrow', address: q.escrow_address, amount: lock }];
    if (o.payment === 'btc-signet') {
      if (upfrontFee > 0n) recipients.push({ label: 'escrow fee', address: q.escrow_btc_fee_address ?? '', amount: upfrontFee });
      const chain = this.chain();
      const feeRate = await feeRateFor(chain, 6, this.maxFeeRate());
      const wallet = this.s.keys.btcWallet;
      const tx = buildFundingTx({
        wallet, utxos: await chain.utxos(wallet.address), feeRate, maxFeeRate: this.maxFeeRate(),
        outputs: recipients.map((r) => ({ address: r.address, amount: r.amount })),
      });
      return { asset: o.payment, lock, upfrontFee, networkFee: tx.fee, feeRate, total: lock + upfrontFee + tx.fee, recipients };
    }
    if (upfrontFee > 0n) recipients.push({ label: 'escrow fee', address: q.escrow_evm_address ?? '', amount: upfrontFee });
    return { asset: o.payment, lock, upfrontFee, total: lock + upfrontFee, recipients };
  }

  // ---------- actions ----------

  async createOrder(input: CreateOrderInput): Promise<UserOrder> {
    const itemsProblem = requestItemsProblem(input.items);
    if (itemsProblem) throw new Error(itemsProblem);
    const orderId = newOrderId();
    const { entry } = input.offer;
    const me = this.s.keys;
    const myPubkey = await this.s.pubkey();
    const { envelope, key, keyForEscrow } = await sealDelivery({
      signer: this.s.signer, orderId, address: input.address, shopper: entry.shopper, escrow: entry.escrow,
    });
    const request: OrderRequest = {
      shop_url: input.shopUrl,
      shop_region: input.region,
      items: input.items,
      payment: input.payment,
      escrow: entry.escrow,
      operator: entry.provenance.operator,
      coordinator: entry.provenance.coordinator,
      delivery: envelope,
      key_proof: input.payment === 'btc-signet'
        ? signKeyProofBtc(me.orderKey(orderId).privateKey, orderId, myPubkey)
        : await signKeyProofEvm(me.evmAccount, orderId, myPubkey),
      relays: this.s.config.relays,
    };
    if (input.payment === 'btc-signet') {
      request.user_btc_pubkey = toHex(me.orderKey(orderId).publicKey);
      request.user_btc_address = me.btcWallet.address;
    } else {
      request.user_evm_address = me.evmAddress;
    }
    // Sign both messages and store the order before publishing: the shopper can answer (a rejection
    // is instant) before our publish returns, and its reply must find the order.
    const inner = await this.s.messenger.sign(entry.shopper, orderId, MSG.request, request);
    // §4.4: the escrow's wrapped key goes to the shopper separately, so escrow.notice never carries it.
    const escrowKeyInner = await this.s.messenger.sign(entry.shopper, orderId, MSG.escrowKey, { key_for_escrow: keyForEscrow });
    const now = nowSeconds();
    const order: UserOrder = {
      id: orderId,
      status: 'requested',
      createdAt: now,
      updatedAt: now,
      payment: input.payment,
      shopper: entry.shopper,
      escrow: entry.escrow,
      entry,
      shopperProfile: input.offer.shopper?.content,
      escrowProfile: input.offer.escrow?.content,
      address: input.address,
      deliveryKey: toHex(key),
      keyForEscrow,
      request,
      requestInner: inner,
      escrowKeyInner,
      tracking: [],
      messages: [inner, escrowKeyInner],
      timeline: [{ at: now, kind: MSG.request, text: '注文を依頼しました' }],
    };
    await this.save(order);
    // A failed publish leaves the order in 'requested' with the error; resendRequest() or cancel() go on from there.
    await this.resendRequest(orderId).catch(() => undefined);
    return (await this.getOrder(orderId)) ?? order;
  }

  /** (Re)send order.request and order.escrow_key, e.g. after the first publish failed (both are retried until acked). */
  async resendRequest(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      if (o.status !== 'requested') throw new Error(`the request was answered already (status ${o.status})`);
      await this.s.messenger.sendInner(o.requestInner);
      if (o.escrowKeyInner) await this.s.messenger.sendInner(o.escrowKeyInner);
    });
  }

  /** Re-run quote validation (e.g. after changing rate sources). */
  async recheckQuote(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      if (!o.quote) throw new Error('no quote');
      o.quoteCheck = await this.validate(o, o.quote);
    });
  }

  /**
   * Accept a validated quote. A strong rate deviation, or a rate that could not be checked, needs
   * `acknowledgeRateDeviation: true` — the user's explicit confirmation (§4.5).
   */
  async acceptQuote(orderId: string, opts: { acknowledgeRateDeviation?: boolean } = {}): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      if (o.status !== 'quoted' || !o.quoteInner || !o.quote) throw new Error(`cannot accept in status ${o.status}`);
      if (!o.quoteCheck?.ok) throw new Error(`quote failed validation: ${o.quoteCheck?.errors.join('; ')}`);
      const ack = o.quoteCheck.ackRequired ?? [];
      if (ack.length && !opts.acknowledgeRateDeviation) throw new Error(`explicit acknowledgement required: ${ack.join('; ')}`);
      if (o.quote.expires_at && o.quote.expires_at < nowSeconds()) throw new Error('quote expired');
      o.acceptInner = await this.send(o, o.shopper, MSG.accept, { quote_id: o.quoteInner.id });
      o.status = 'accepted';
      this.log(o, MSG.accept, ack.length ? `見積を承諾しました（確認済み: ${ack.join('; ')}）` : '見積を承諾しました');
    });
  }

  async cancel(orderId: string, reason = 'cancelled by user'): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      // Funding has started only once a transaction exists; until then nothing of ours is locked.
      if (o.funded || fundingStarted(o)) throw new Error('cannot cancel after funding');
      if (!PRE_FUNDING.includes(o.status)) throw new Error(`cannot cancel in status ${o.status}`);
      o.status = 'cancelled';
      // Telling the shopper is best effort: an order whose request never got out must still be cancellable.
      const told = await this.send(o, o.shopper, MSG.cancel, { reason }).then(() => true, () => false);
      this.log(o, MSG.cancel, `取り消しました: ${reason}${told ? '' : '（shopper への通知は送れませんでした）'}`);
    });
  }

  /** Lock funds (and pay the escrow upfront fee), then notify shopper and escrow (§4.6, §5.2, §6.2). */
  async fund(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      if (o.status !== 'accepted' && o.status !== 'funding') throw new Error(`cannot fund in status ${o.status}`);
      if (!o.quoteCheck?.ok) throw new Error('quote failed validation');
      const q = o.quote!;
      // A funding already under way is finished whatever the quote's age: the money may be in the escrow output.
      if (!fundingStarted(o) && q.expires_at && q.expires_at + FUNDING_GRACE_SECONDS < nowSeconds()) {
        throw new Error('the quote expired too long ago to fund; ask for a new quote');
      }
      o.status = 'funding';
      await this.save(o);
      const funded = o.payment === 'btc-signet' ? await this.fundBtc(o, q) : await this.fundUsdc(o, q);
      await this.announceFunding(o, funded);
      this.log(o, MSG.funded, `入金しました (${funded.asset === 'btc-signet' ? funded.txid : funded.fund_tx})`);
    });
  }

  /** order.funded to the shopper and escrow.notice to the escrow (§4.6, §4.7). */
  private async announceFunding(o: UserOrder, funded: OrderFunded): Promise<void> {
    const fundedInner = o.fundedInner ?? (await this.s.messenger.sign(o.shopper, o.id, MSG.funded, funded));
    o.funded = funded;
    o.fundedInner = fundedInner;
    if (!o.messages.some((m) => m.id === fundedInner.id)) o.messages.push(fundedInner);
    // Stored before publishing: the shopper's replies may beat our publish, and a retry reuses the same inner.
    await this.save(o);
    await this.s.messenger.sendInner(fundedInner);
    const notice: EscrowNotice = { request: o.requestInner, quote: o.quoteInner!, accept: o.acceptInner!, funded: fundedInner };
    await this.send(o, o.escrow, MSG.escrowNotice, notice);
    if (['accepted', 'funding'].includes(o.status)) o.status = 'funded';
  }

  /**
   * An interrupted funding whose escrow output is on chain: finish it (order.funded, escrow.notice) so the
   * dispute and T2 refund work. Throws when nothing was funded.
   */
  private async ensureFunded(o: UserOrder): Promise<OrderFunded> {
    if (o.funded) return o.funded;
    const f = provisionalFunding(o);
    if (!f) throw new Error('not funded');
    const lock = parseUnits(o.quote!.lock_amount!);
    if (f.asset === 'btc-signet') {
      const tx = await this.chain().txHex(f.txid).catch(() => undefined);
      if (!tx) throw new Error(`the funding transaction ${f.txid} is not on chain`);
    } else {
      const moved = await this.evm().usdcTransferredIn(f.fund_tx as Hex, f.safe as `0x${string}`, this.s.keys.evmAddress).catch(() => 0n);
      if (moved < lock) throw new Error(`the funding transaction ${f.fund_tx} did not move lock_amount into the Safe`);
    }
    await this.announceFunding(o, f);
    this.log(o, MSG.funded, `中断した入金をチェーンで確認しました (${f.asset === 'btc-signet' ? f.txid : f.fund_tx})`);
    return f;
  }

  /** Sign the payout to the shopper and send order.release (§4.3, §5.2, §6.4). */
  async release(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      if (!o.funded) throw new Error('not funded');
      if (o.escrowSpent || ['released', 'completed', 'settled', 'refunded'].includes(o.status)) throw new Error(`already ${o.status}`);
      const q = o.quote!;
      let body: SignedPayout;
      if (o.payment === 'btc-signet') {
        const f = o.funded as Extract<OrderFunded, { asset: 'btc-signet' }>;
        const lock = parseUnits(q.lock_amount!);
        const reserve = parseUnits(q.payout_fee_reserve ?? '0');
        const tx = buildEscrowSpend({
          outpoint: { txid: f.txid, vout: f.vout ?? 0, amount: lock },
          witnessScript: this.script(o),
          outputs: [{ address: q.shopper_btc_address!, amount: lock - reserve }],
        });
        signEscrowInput(tx, this.s.keys.orderKey(o.id).privateKey);
        body = { asset: 'btc-signet', psbt: psbtToBase64(tx) };
      } else {
        const f = o.funded as Extract<OrderFunded, { asset: 'usdc-evm' }>;
        const d = this.deployments();
        const tx = releaseSafeTx({ usdc: d.usdc, to: q.shopper_evm_address as `0x${string}`, amount: parseUnits(q.lock_amount!) });
        const signature = await signSafeTx(this.s.keys.evmAccount, tx, d.chain_id, f.safe as `0x${string}`);
        body = { asset: 'usdc-evm', safe_tx: safeTxToJson(tx), signature };
      }
      await this.send(o, o.shopper, MSG.release, body);
      o.status = 'released';
      this.log(o, MSG.release, '受取を確認し、支払いに署名しました');
    });
  }

  /** dispute.open to the escrow with full evidence (§4.7), copy to the shopper. */
  async openDispute(
    orderId: string,
    p: { claim: DisputeOpen['claim']; text: string; requestedSplit?: { user: string; shopper: string } },
  ): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      if (!o.funded && !provisionalFunding(o)) throw new Error('nothing to dispute before funding');
      if (o.escrowSpent) throw new Error('the escrow output has already been paid out');
      await this.ensureFunded(o);
      // §4.9: the first part goes with the claim; further messages follow as dispute.evidence.
      const [first, ...more] = this.evidenceParts(o);
      const body: DisputeOpen = { claim: p.claim, text: p.text, requested_split: p.requestedSplit, evidence: first };
      const inner = await this.send(o, o.escrow, MSG.disputeOpen, body);
      for (const part of more) await this.send(o, o.escrow, MSG.evidence, part);
      await this.send(o, o.shopper, MSG.disputeOpen, body);
      o.dispute = { open: body, inner };
      // §4.8: a dispute opened after a ruling does not hide the countersignature.
      if (!o.ruling) o.status = 'disputed';
      this.log(o, MSG.disputeOpen, `紛争を申し立てました (${p.claim})${more.length ? `（証拠は ${more.length + 1} 通に分けて送りました）` : ''}`);
      this.adoptPendingRuling(o);
    });
  }

  /** Answer an evidence request: resend everything we have (split to fit, §4.9). */
  async sendEvidence(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      for (const part of this.evidenceParts(o)) await this.send(o, o.escrow, MSG.evidence, part);
      this.log(o, MSG.evidence, '証拠を送りました');
    });
  }

  /** Inspect a ruling's transaction before countersigning. Returns problems (empty = matches the split). */
  async reviewRuling(orderId: string): Promise<string[]> {
    const o = await this.require(orderId);
    if (!o.ruling) return ['no ruling'];
    return this.rulingProblems(o, o.ruling);
  }

  /** Countersign the escrow's ruling and broadcast it (2-of-3, §4.8). The user decides when to call this. */
  async countersignRuling(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      const r = o.ruling;
      if (!r) throw new Error('no ruling to countersign');
      const problems = await this.rulingProblems(o, r);
      if (problems.length) throw new Error(`ruling does not match its split: ${problems.join('; ')}`);
      let txid: string;
      if (o.payment === 'btc-signet') {
        const tx = psbtFromBase64(r.psbt!);
        signEscrowInput(tx, this.s.keys.orderKey(o.id).privateKey);
        finalizeEscrowInput(tx, this.escrowKeys(o), 'multisig');
        txid = await this.broadcast(extractTx(tx));
      } else {
        const d = this.deployments();
        const f = o.funded as Extract<OrderFunded, { asset: 'usdc-evm' }>;
        const safe = f.safe as `0x${string}`;
        const tx = safeTxFromJson(r.safe_tx!);
        const mine = await signSafeTx(this.s.keys.evmAccount, tx, d.chain_id, safe);
        txid = await this.evm().execSafeTx(safe, tx, [
          { signer: this.s.keys.evmAddress, signature: mine },
          { signer: o.quote!.escrow_evm_address as `0x${string}`, signature: r.signature as Hex },
        ]);
      }
      this.log(o, MSG.countersigned, `裁定に連署して放送しました (${txid})`);
      // A relay or node accepting the broadcast is not a spend: 'settled' waits for the chain (§4.8).
      o.pendingSettlement = { kind: 'settled', txid, from: await this.s.pubkey(), at: nowSeconds() };
      await this.checkSettlement(o).catch((err) => this.log(o, MSG.countersigned, `チェーンの確認に失敗: ${(err as Error).message}`));
      await this.send(o, o.shopper, MSG.countersigned, { txid });
      await this.send(o, o.escrow, MSG.countersigned, { txid });
    });
  }

  /** Re-check a shopper's cooperative refund offer (fresh chain state). Empty = acceptable. */
  async reviewRefundOffer(orderId: string): Promise<string[]> {
    const o = await this.require(orderId);
    if (!o.refundOffer) return ['no refund offer'];
    return this.refundProblems(o, o.refundOffer.body);
  }

  /** Countersign and broadcast the shopper's order.refund. Only ever called from an explicit user action (§4.10). */
  async acceptRefundOffer(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      const offer = o.refundOffer;
      if (!offer) throw new Error('no refund offer');
      const problems = await this.refundProblems(o, offer.body);
      if (problems.length) throw new Error(`refund offer does not match the template: ${problems.join('; ')}`);
      if (offer.body.asset === 'btc-signet') {
        const tx = psbtFromBase64(offer.body.psbt);
        signEscrowInput(tx, this.s.keys.orderKey(o.id).privateKey);
        finalizeEscrowInput(tx, this.escrowKeys(o), 'multisig');
        o.refundTxid = await this.broadcast(extractTx(tx));
      } else {
        const d = this.deployments();
        const f = o.funded as Extract<OrderFunded, { asset: 'usdc-evm' }>;
        const safe = f.safe as `0x${string}`;
        const tx = safeTxFromJson(offer.body.safe_tx);
        const signer = await recoverSafeTxSigner(tx, d.chain_id, safe, offer.body.signature as Hex);
        const mine = await signSafeTx(this.s.keys.evmAccount, tx, d.chain_id, safe);
        o.refundTxid = await this.evm().execSafeTx(safe, tx, [
          { signer: this.s.keys.evmAddress, signature: mine },
          { signer, signature: offer.body.signature as Hex },
        ]);
      }
      this.log(o, MSG.refund, `shopper の払い戻しに連署しました (${o.refundTxid})`);
      o.pendingSettlement = { kind: 'refunded', txid: o.refundTxid, from: await this.s.pubkey(), at: nowSeconds() };
      await this.checkSettlement(o).catch((err) => this.log(o, MSG.refund, `チェーンの確認に失敗: ${(err as Error).message}`));
    });
  }

  /** After T2 the user alone can take everything back (§5.1 T2 path, §6.3 refundToUser). */
  async refundAfterTimelock(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      // An interrupted funding must not block the refund: finish it from the chain first.
      const funded = await this.ensureFunded(o);
      const q = o.quote!;
      const t2 = q.timelock!.t2;
      let txid: string;
      if (o.payment === 'btc-signet') {
        const tip = await this.chain().tipHeight();
        if (tip < t2) throw new Error(`T2 not reached: height ${tip} < ${t2}`);
        const f = funded as Extract<OrderFunded, { asset: 'btc-signet' }>;
        const lock = parseUnits(q.lock_amount!);
        const reserve = parseUnits(q.payout_fee_reserve ?? '0');
        const tx = buildEscrowSpend({
          outpoint: { txid: f.txid, vout: f.vout ?? 0, amount: lock },
          witnessScript: this.script(o),
          // The fee comes out of payout_fee_reserve; never build a zero-fee tx that cannot relay.
          outputs: [{ address: o.request.user_btc_address!, amount: lock - (reserve > 0n ? reserve : 500n) }],
          lockTime: t2,
        });
        signEscrowInput(tx, this.s.keys.orderKey(o.id).privateKey);
        finalizeEscrowInput(tx, this.escrowKeys(o), 'user-after-t2');
        txid = await this.broadcast(extractTx(tx));
      } else {
        const now = await this.evm().blockTimestamp();
        if (now < BigInt(t2)) throw new Error(`T2 not reached: ${now} < ${t2}`);
        const f = funded as Extract<OrderFunded, { asset: 'usdc-evm' }>;
        txid = await this.evm().refundToUser(f.safe as `0x${string}`);
      }
      o.refundTxid = txid;
      this.log(o, 'refund', `T2 経過後の返金を放送しました (${txid})`);
      o.pendingSettlement = { kind: 'refunded', txid, from: await this.s.pubkey(), at: nowSeconds() };
      await this.checkSettlement(o).catch((err) => this.log(o, 'refund', `チェーンの確認に失敗: ${(err as Error).message}`));
    });
  }

  /** Re-check a pending order.completed / dispute.countersigned claim on chain now. */
  async verifySettlement(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, (o) => this.checkSettlement(o));
  }

  /** Report a party to the list operator (§4.3 report). Evidence = the order's signed messages. */
  async report(orderId: string, p: { subject: 'shopper' | 'escrow' | string; text: string }): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      const subject = p.subject === 'shopper' ? o.shopper : p.subject === 'escrow' ? o.escrow : p.subject;
      const operator = this.s.directory.current?.lists.get(o.entry.provenance.operator)?.content.report_to ?? o.entry.provenance.operator;
      await this.send(o, operator, MSG.report, { subject, order_id: o.id, text: p.text, evidence: evidenceMessages(o) });
      this.log(o, MSG.report, 'オペレータに通報しました');
    });
  }

  async chat(orderId: string, to: 'shopper' | 'escrow', text: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      await this.send(o, to === 'shopper' ? o.shopper : o.escrow, MSG.chat, { text });
      this.log(o, MSG.chat, `送信: ${text}`);
    });
  }

  /** Current balances of our wallets. */
  async balances(): Promise<{ btcSats?: bigint; eth?: bigint; usdc?: bigint }> {
    const out: { btcSats?: bigint; eth?: bigint; usdc?: bigint } = {};
    if (this.s.chain) {
      const utxos = await this.s.chain.utxos(this.s.keys.btcWallet.address);
      out.btcSats = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
    }
    if (this.s.evm) {
      out.eth = await this.s.evm.ethBalance();
      out.usdc = await this.s.evm.usdcBalance().catch(() => undefined);
    }
    return out;
  }

  // ---------- incoming ----------

  private async onMessage(m: IncomingMessage): Promise<void> {
    const existing = await this.getOrder(m.orderId);
    if (!existing) return;
    const fromShopper = m.from === existing.shopper;
    const fromEscrow = m.from === existing.escrow;
    if (!fromShopper && !fromEscrow) return;

    await this.mutate(m.orderId, async (o) => {
      o.messages.push(m.inner);
      switch (m.type) {
        case MSG.quote:
          if (!fromShopper || o.status !== 'requested') break;
          await this.onQuote(o, m.inner, m.body as OrderQuote);
          break;
        case MSG.cancel:
          // Only before any funding: afterwards a peer's "cancel" must not hide the refund path.
          if (fromShopper && !o.funded && !o.fundingProgress && PRE_FUNDING.includes(o.status)) {
            o.status = 'cancelled';
            this.log(o, m.type, `shopper が取り消しました: ${(m.body as { reason: string }).reason}`);
          } else {
            this.log(o, m.type, 'shopper の取り消しを無視しました（入金後）');
          }
          break;
        case MSG.purchased:
          if (!fromShopper || !o.funded) break;
          o.purchased = m.body as OrderPurchased;
          if (o.status === 'funded') o.status = 'purchased';
          this.log(o, m.type, `購入されました (店の注文番号 ${o.purchased.shop_order_id})`);
          break;
        case MSG.shipping: {
          if (!fromShopper || !o.funded) break;
          const b = m.body as OrderShipping;
          o.tracking.push(b.tracking);
          const next = ({ shipped: 'shipped', delivered: 'delivered', failed: 'delivery_failed' } as const)[b.status];
          if (['funded', 'purchased', 'shipped'].includes(o.status)) o.status = next;
          this.log(o, m.type, `配送状況: ${b.status}${b.tracking.tracking_no ? ` (${b.tracking.tracking_no})` : ''}`);
          break;
        }
        case MSG.completed:
          if (!fromShopper || !o.funded) break;
          o.pendingSettlement = { kind: 'completed', txid: (m.body as { txid: string }).txid, from: m.from, at: nowSeconds() };
          this.log(o, m.type, `shopper が完了を報告しました (${o.pendingSettlement.txid})。チェーンで確かめます`);
          await this.checkSettlement(o).catch((err) => this.log(o, m.type, `チェーンの確認に失敗: ${(err as Error).message}`));
          break;
        case MSG.refund:
          if (!fromShopper || !o.funded) break;
          await this.onRefundOffer(o, m.inner, m.body as SignedPayout);
          break;
        case MSG.evidenceRequest:
          if (!fromEscrow || !o.funded) break;
          o.evidenceRequestedAt ??= nowSeconds();
          this.log(o, m.type, `escrow が証拠を求めています: ${(m.body as { want: string[] }).want.join(', ')}`);
          this.adoptPendingRuling(o);
          break;
        case MSG.ruling: {
          if (!fromEscrow || !o.funded) break;
          // §4.8: the escrow rules once; a second (conflicting) signed split is ignored.
          if (o.ruling || o.pendingRuling) {
            this.log(o, m.type, '2 回目の裁定は無視しました');
            break;
          }
          // A ruling that beats the news of the dispute (the shopper's copy may still be on its way) is kept, not dropped.
          o.pendingRuling = { body: m.body as DisputeRuling, inner: m.inner, receivedAt: nowSeconds() };
          if (!this.adoptPendingRuling(o)) this.log(o, m.type, '紛争を知る前に裁定が届きました。紛争を確かめられるまで保留します');
          break;
        }
        case MSG.countersigned:
          if (!o.funded || !o.ruling) break;
          o.pendingSettlement = { kind: 'settled', txid: (m.body as { txid: string }).txid, from: m.from, at: nowSeconds() };
          this.log(o, m.type, `相手が裁定に連署したと報告しました (${o.pendingSettlement.txid})。チェーンで確かめます`);
          await this.checkSettlement(o).catch((err) => this.log(o, m.type, `チェーンの確認に失敗: ${(err as Error).message}`));
          break;
        case MSG.disputeOpen:
          if (!fromShopper || !o.funded) break;
          o.shopperDispute ??= { open: m.body as DisputeOpen, inner: m.inner };
          this.log(o, m.type, `shopper が紛争を申し立てました (${(m.body as DisputeOpen).claim})`);
          // §4.8: never back from 'ruled' — that would hide the countersignature.
          if (!o.escrowSpent && !o.dispute && !o.ruling) o.status = 'disputed';
          this.adoptPendingRuling(o);
          break;
        case MSG.chat:
          this.log(o, m.type, `${fromShopper ? 'shopper' : 'escrow'}: ${(m.body as { text: string }).text}`);
          break;
        default:
          this.log(o, m.type, `受信: ${m.type}`);
      }
    });
  }

  private async onQuote(o: UserOrder, inner: Inner, quote: OrderQuote): Promise<void> {
    o.quote = quote;
    o.quoteInner = inner;
    if (!quote.accept) {
      o.status = 'rejected';
      o.quoteCheck = { ok: false, errors: [`shopper declined: ${quote.reject_reason ?? ''}`], warnings: [], ackRequired: [] };
      this.log(o, MSG.quote, `断られました: ${quote.reject_reason ?? ''} ${quote.detail ?? ''}`);
      return;
    }
    o.quoteCheck = await this.validate(o, quote);
    o.status = 'quoted';
    const level = o.quoteCheck.fx?.level;
    this.log(o, MSG.quote, `見積を受け取りました (${quote.lock_amount} ${quote.asset})${o.quoteCheck.ok ? '' : ' — 検証に失敗'}${level && level !== 'ok' ? ` — レート注意 ${level}` : ''}`);
  }

  private async validate(o: UserOrder, quote: OrderQuote): Promise<QuoteCheck> {
    // Refresh the trust view so a just-revoked combination is caught.
    const snap = await this.s.directory.refresh().catch(() => this.s.directory.current);
    const escrowProfile = snap?.escrows.get(o.escrow)?.content ?? o.escrowProfile;
    if (escrowProfile) o.escrowProfile = escrowProfile;
    const shopperProfile = snap?.shoppers.get(o.shopper)?.content ?? o.shopperProfile;
    const infraErrors: string[] = [];
    const infraWarnings: string[] = [];
    let chainNow: number | undefined;
    try {
      chainNow = o.payment === 'btc-signet' ? await this.chain().tipHeight() : Number(await this.evm().blockTimestamp());
      // §4.5.1 compares timelocks with the chain's "now"; a chain API whose clock is off could fake it.
      const chainTime = o.payment === 'btc-signet' ? await this.chain().tipTime() : chainNow;
      const skew = clockSkewProblem(chainTime, nowSeconds(), this.s.config.maxClockSkewSeconds);
      if (skew) infraErrors.push(skew);
    } catch (err) {
      infraErrors.push(`cannot read the current ${o.payment === 'btc-signet' ? 'block height' : 'chain time'}: ${(err as Error).message}`);
    }
    const deployments = this.opts.deployments ?? this.s.evm?.deployments;
    let proxyCreationCode: Hex = SAFE_PROXY_CREATION_CODE;
    if (o.payment === 'usdc-evm') {
      // The Safe address is predicted with the factory's proxy code, but only with a code we know (§6.2).
      if (this.s.evm) {
        try {
          proxyCreationCode = knownProxyCreationCode(await this.s.evm.proxyCreationCode());
        } catch (err) {
          infraErrors.push(`cannot use the factory's proxyCreationCode: ${(err as Error).message}`);
        }
        if (deployments && this.s.evm.chainId !== deployments.chain_id) infraErrors.push(`EVM RPC chain ${this.s.evm.chainId} != deployments chain ${deployments.chain_id}`);
      }
      // The signed operator list must vouch for every contract address the Safe depends on.
      const listEvm = snap?.lists.get(o.entry.provenance.operator)?.content.chain?.evm;
      if (deployments && listEvm) infraErrors.push(...crossCheckDeployments(deployments, listEvm));
      else if (deployments) infraErrors.push('the operator list has no chain.evm, so the contract addresses cannot be checked');
    }
    const check = await checkQuote({
      orderId: o.id,
      request: o.request,
      quote,
      shopper: o.shopper,
      escrowProfile,
      entries: snap?.entries ?? [],
      userBtcPubkey: o.payment === 'btc-signet' ? this.s.keys.orderKey(o.id).publicKey : undefined,
      userEvmAddress: o.payment === 'usdc-evm' ? this.s.keys.evmAddress : undefined,
      deployments,
      proxyCreationCode,
      rates: this.s.rates,
      chainNow,
      timelockPolicy: this.s.config.timelockPolicy,
      deliveryDays: shopperProfile?.delivery_days,
    });
    check.errors.push(...infraErrors);
    check.warnings.push(...infraWarnings);
    check.ok = check.errors.length === 0;
    return check;
  }

  /** Record the shopper's refund offer with its problems; signing waits for the user (§4.10). */
  private async onRefundOffer(o: UserOrder, inner: Inner, body: SignedPayout): Promise<void> {
    const problems = await this.refundProblems(o, body).catch((err) => [(err as Error).message]);
    const lock = o.quote?.lock_amount ? parseUnits(o.quote.lock_amount) : 0n;
    const reserve = o.payment === 'btc-signet' ? parseUnits(o.quote?.payout_fee_reserve ?? '0') : 0n;
    o.refundOffer = {
      body, inner, problems, receivedAt: nowSeconds(),
      amount: String(lock - reserve),
      recipient: o.payment === 'btc-signet' ? o.request.user_btc_address : o.request.user_evm_address,
    };
    this.log(o, MSG.refund, problems.length
      ? `shopper の払い戻しの提案を検証できませんでした: ${problems.join('; ')}`
      : 'shopper が払い戻しを提案しています。内容を確かめて連署してください');
  }

  /** Take a held-back ruling once a dispute is known (§4.8). Returns whether the order now has it. */
  private adoptPendingRuling(o: UserOrder): boolean {
    const r = o.pendingRuling;
    if (!r || o.ruling || !disputeKnown(o)) return false;
    o.ruling = r.body;
    o.rulingInner = r.inner;
    o.pendingRuling = undefined;
    if (!o.escrowSpent) o.status = 'ruled';
    this.log(o, MSG.ruling, `裁定: user ${r.body.split.user} / shopper ${r.body.split.shopper} — ${r.body.reason}`);
    return true;
  }

  /** Record a dropped message of one of our orders' parties, so the user sees that something did not arrive. */
  private async onDropped(inner: Inner, reason: string): Promise<void> {
    const { orderId, type } = innerMeta(inner);
    const existing = orderId ? await this.getOrder(orderId) : undefined;
    if (!existing || (inner.pubkey !== existing.shopper && inner.pubkey !== existing.escrow)) return;
    await this.lock.run(orderId, async () => {
      const o = await this.getOrder(orderId);
      if (!o) return;
      const list = (o.dropped ??= []);
      // The same inner arrives from several relays and as resends; one notice per inner is enough.
      if (list.some((d) => d.type === type && d.reason === reason && d.at > nowSeconds() - 60)) return;
      list.push({ at: nowSeconds(), type, reason, from: inner.pubkey === o.shopper ? 'shopper' : 'escrow' });
      if (list.length > DROPPED_KEPT) list.splice(0, list.length - DROPPED_KEPT);
      await this.save(o);
    });
  }

  // ---------- funding ----------

  private async fundBtc(o: UserOrder, q: OrderQuote): Promise<OrderFunded> {
    const chain = this.chain();
    const lock = parseUnits(q.lock_amount!);
    const fee = parseUnits(q.escrow_upfront_fee ?? '0');
    const p = (o.fundingProgress ??= {});
    if (!p.btcTxid) {
      const wallet = this.s.keys.btcWallet;
      const outputs = [{ address: q.escrow_address!, amount: lock }];
      if (fee > 0n) outputs.push({ address: q.escrow_btc_fee_address!, amount: fee });
      const tx = buildFundingTx({
        wallet, utxos: await chain.utxos(wallet.address), outputs,
        feeRate: await feeRateFor(chain, 6, this.maxFeeRate()), maxFeeRate: this.maxFeeRate(),
      });
      // Persist the (locally computed) txid before broadcasting: a retry rebroadcasts this tx, never a new one.
      p.btcTxid = tx.txid;
      p.btcTxHex = tx.hex;
      await this.save(o);
      await this.broadcast(tx);
    } else if (p.btcTxHex && !(await chain.txStatus(p.btcTxid).then(() => true, () => false))) {
      await this.broadcast({ hex: p.btcTxHex, txid: p.btcTxid });
    }
    const txid = p.btcTxid;
    return { asset: 'btc-signet', txid, vout: 0, amount: lock.toString(), fee_txid: txid };
  }

  private async fundUsdc(o: UserOrder, q: OrderQuote): Promise<OrderFunded> {
    const evm = this.evm();
    const safe = q.escrow_address as `0x${string}`;
    const lock = parseUnits(q.lock_amount!);
    const fee = parseUnits(q.escrow_upfront_fee ?? '0');
    const p = (o.fundingProgress ??= {});
    type Step = 'deploy' | 'fund' | 'fee';
    // Each step persists the signed transaction before sending it; a retry sends that one again, never a new one.
    const persist = (step: Step) => async (tx: SignedTx) => {
      p[`${step}Tx` as const] = tx.hash;
      p[`${step}Raw` as const] = tx.raw;
      await this.save(o);
    };
    /** Finish a step signed earlier: wait for its receipt, sending the persisted raw tx again if the node lost it. */
    const resume = async (step: Step): Promise<void> => {
      const hash = p[`${step}Tx` as const] as Hex;
      const raw = p[`${step}Raw` as const] as Hex | undefined;
      if ((await evm.receiptOk(hash)) === undefined && raw && !(await evm.knowsTx(hash))) await evm.sendSigned({ hash, raw });
      await evm.confirm(hash);
    };
    if (p.deployTx && p.deployTx !== 'already-deployed') await resume('deploy').catch(() => undefined);
    if (!(await evm.isDeployed(safe))) {
      if (p.deployTx && p.deployTx !== 'already-deployed') throw new Error(`Safe deployment ${p.deployTx} has not been mined; try again later`);
      await evm.deploySafe({
        user: this.s.keys.evmAddress,
        shopper: q.shopper_evm_address as `0x${string}`,
        escrow: q.escrow_evm_address as `0x${string}`,
        t1: BigInt(q.timelock!.t1),
        t2: BigInt(q.timelock!.t2),
        orderId: o.id,
      }, persist('deploy'));
      if (!(await evm.isDeployed(safe))) throw new Error('Safe was not deployed at the predicted address');
    } else if (!p.deployTx) {
      p.deployTx = 'already-deployed';
      await this.save(o);
    }
    if (p.fundTx) {
      await resume('fund');
    } else {
      const held = await evm.usdcBalance(safe);
      if (held >= lock) {
        // Funded earlier but the hash was lost: find our transfer instead of paying again.
        const found = await evm.findUsdcTransfer(this.s.keys.evmAddress, safe, lock);
        if (!found) throw new Error('the Safe already holds the funds but our transfer was not found; not sending again');
        p.fundTx = found;
        await this.save(o);
      } else {
        // Someone else's dust in the Safe (§4.8) does not count as our funding.
        await evm.transferUsdc(safe, lock, persist('fund'));
      }
    }
    if (fee > 0n) {
      if (p.feeTx) await resume('fee');
      else await evm.transferUsdc(q.escrow_evm_address as `0x${string}`, fee, persist('fee'));
    }
    return { asset: 'usdc-evm', safe, deploy_tx: p.deployTx!, fund_tx: p.fundTx!, fee_tx: p.feeTx ?? '', amount: lock.toString() };
  }

  // ---------- helpers ----------

  /** Promote a pending payout (a peer's claim or our own broadcast) to a terminal status once the chain agrees (§4.8). */
  private async checkSettlement(o: UserOrder): Promise<void> {
    const claim = o.pendingSettlement;
    if (!claim || !o.funded) return;
    const res = await escrowSpent({ chain: this.s.chain, evm: this.s.evm, funded: o.funded, lock: parseUnits(o.quote!.lock_amount!), claimedTx: claim.txid });
    if (!res.spent) return;
    o.escrowSpent = { txid: res.txid, at: nowSeconds() };
    o.pendingSettlement = undefined;
    const txid = res.txid ?? claim.txid;
    if (claim.kind === 'completed') {
      o.completedTxid = txid;
      o.status = 'completed';
      this.log(o, MSG.completed, `完了をチェーンで確認しました (${txid})`);
    } else if (claim.kind === 'refunded') {
      o.refundTxid = txid;
      o.status = 'refunded';
      this.log(o, MSG.refund, `返金をチェーンで確認しました (${txid})`);
    } else {
      o.settledTxid = txid;
      o.status = 'settled';
      this.log(o, MSG.countersigned, `裁定の精算をチェーンで確認しました (${txid})`);
    }
  }

  private async pollSettlements(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const o of await this.listOrders()) {
        if (o.pendingSettlement) await this.verifySettlement(o.id).catch(() => undefined);
      }
    } finally {
      this.polling = false;
    }
  }

  /** §4.10 template for the shopper's cooperative refund: everything back to us, fee within the reserve. */
  private async refundProblems(o: UserOrder, body: SignedPayout): Promise<string[]> {
    if (!o.funded || !o.quote) return ['order is not funded'];
    if (o.escrowSpent) return ['the escrow output has already been paid out'];
    const q = o.quote;
    if (o.payment === 'btc-signet' && body.asset === 'btc-signet') {
      const f = o.funded as Extract<OrderFunded, { asset: 'btc-signet' }>;
      return btcPayoutProblems(psbtFromBase64(body.psbt), {
        outpoint: { txid: f.txid, vout: f.vout ?? 0, amount: parseUnits(q.lock_amount!) },
        witnessScript: this.script(o),
        outputs: { only: [o.request.user_btc_address!] },
        maxFee: parseUnits(q.payout_fee_reserve ?? '0'),
        signer: this.escrowKeys(o).shopper,
      });
    }
    if (o.payment === 'usdc-evm' && body.asset === 'usdc-evm') {
      const tx = safeTxFromJson(body.safe_tx);
      const problems = await this.safeProblems(o, tx, { only: [this.s.keys.evmAddress] });
      const d = this.deployments();
      const f = o.funded as Extract<OrderFunded, { asset: 'usdc-evm' }>;
      const signer = await recoverSafeTxSigner(tx, d.chain_id, f.safe as `0x${string}`, body.signature as Hex).catch(() => undefined);
      if (signer?.toLowerCase() !== q.shopper_evm_address?.toLowerCase()) problems.push('SafeTx not signed by the shopper');
      return problems;
    }
    return ['refund offer is for a different asset'];
  }

  private async safeProblems(o: UserOrder, tx: ReturnType<typeof safeTxFromJson>, transfers: Parameters<typeof safePayoutProblems>[1]['transfers']): Promise<string[]> {
    const d = this.deployments();
    const safe = (o.funded as Extract<OrderFunded, { asset: 'usdc-evm' }>).safe as `0x${string}`;
    let nonce: bigint;
    let balance: bigint;
    try {
      [nonce, balance] = await Promise.all([this.evm().safeNonce(safe), this.evm().usdcBalance(safe)]);
    } catch (err) {
      return [`cannot read the Safe state: ${(err as Error).message}`];
    }
    const lock = parseUnits(o.quote!.lock_amount!);
    return safePayoutProblems(tx, { usdc: d.usdc, multiSend: d.safe.multisend_call_only, nonce, balance, lock, transfers });
  }

  private async rulingProblems(o: UserOrder, r: DisputeRuling): Promise<string[]> {
    const problems: string[] = [];
    const q = o.quote!;
    if (!disputeKnown(o)) problems.push('there is no open dispute for this order');
    if (o.escrowSpent) return [...problems, 'the escrow output has already been paid out'];
    const split = { user: parseUnits(r.split.user), shopper: parseUnits(r.split.shopper), fee: parseUnits(r.split.escrow_fee) };
    const total = split.user + split.shopper + split.fee;
    const lock = parseUnits(q.lock_amount!);
    const reserve = o.payment === 'btc-signet' ? parseUnits(q.payout_fee_reserve ?? '0') : 0n;
    // §4.8: BTC splits the escrow output minus the reserve; USDC the Safe's balance when the escrow signed,
    // which may exceed lock_amount (dust); safeProblems checks lock_amount ≤ total ≤ balance now.
    if (o.payment === 'btc-signet' && total !== lock - reserve) problems.push(`split adds up to ${total}, not the escrow balance ${lock - reserve}`);
    const bps = o.escrowProfile?.dispute_fee_bps;
    if (bps === undefined) problems.push('escrow profile unknown: cannot bound the escrow fee');
    else if (split.fee * 10000n > BigInt(bps) * total) problems.push(`escrow_fee ${split.fee} exceeds dispute_fee_bps ${bps}`);
    if (o.payment === 'btc-signet') {
      if (!r.psbt) return [...problems, 'no PSBT'];
      const f = o.funded as Extract<OrderFunded, { asset: 'btc-signet' }>;
      problems.push(...btcPayoutProblems(psbtFromBase64(r.psbt), {
        outpoint: { txid: f.txid, vout: f.vout ?? 0, amount: lock },
        witnessScript: this.script(o),
        outputs: {
          exact: [
            { address: o.request.user_btc_address!, amount: split.user },
            { address: q.shopper_btc_address!, amount: split.shopper },
            { address: q.escrow_btc_fee_address!, amount: split.fee },
          ],
        },
        maxFee: reserve,
        signer: this.escrowKeys(o).escrow,
      }));
    } else {
      if (!r.safe_tx || !r.signature) return [...problems, 'no SafeTx'];
      const d = this.deployments();
      const f = o.funded as Extract<OrderFunded, { asset: 'usdc-evm' }>;
      const tx = safeTxFromJson(r.safe_tx);
      const signer = await recoverSafeTxSigner(tx, d.chain_id, f.safe as `0x${string}`, r.signature as Hex).catch(() => undefined);
      if (signer?.toLowerCase() !== (q.escrow_evm_address ?? '').toLowerCase()) problems.push('SafeTx not signed by the escrow');
      problems.push(...await this.safeProblems(o, tx, {
        exact: [
          { to: o.request.user_evm_address!, amount: split.user },
          { to: q.shopper_evm_address!, amount: split.shopper },
          { to: q.escrow_evm_address!, amount: split.fee },
        ],
      }));
    }
    return problems;
  }

  private evidence(o: UserOrder): DisputeEvidence {
    return evidenceWithoutInlineData({
      messages: evidenceMessages(o),
      tracking: o.tracking,
      purchase_evidence: o.purchased?.evidence ?? [],
      delivery_key_for_escrow: o.keyForEscrow,
    });
  }

  /** The evidence split into bodies that fit a message (§4.9); what cannot fit at all is noted on the order. */
  private evidenceParts(o: UserOrder): DisputeEvidence[] {
    const { parts, skipped } = splitEvidence(this.evidence(o));
    if (skipped.length) this.log(o, MSG.evidence, `大きすぎて証拠に入れられないメッセージが ${skipped.length} 通ありました`);
    return parts;
  }

  private escrowKeys(o: UserOrder): EscrowKeys {
    const q = o.quote!;
    return {
      user: this.s.keys.orderKey(o.id).publicKey,
      shopper: fromHex(q.shopper_btc_pubkey!),
      escrow: fromHex(q.escrow_btc_pubkey!),
    };
  }

  private script(o: UserOrder): Uint8Array {
    const t = o.quote!.timelock!;
    return witnessScript(this.escrowKeys(o), t.t1, t.t2);
  }

  /** Broadcast and return the txid we computed ourselves (the Esplora server's answer is not trusted). */
  private async broadcast(tx: { hex: string; txid: string }): Promise<string> {
    const reported = await this.chain().broadcast(tx.hex);
    if (reported && reported !== tx.txid) console.warn(`esplora reported txid ${reported}, expected ${tx.txid}`);
    return tx.txid;
  }

  private maxFeeRate(): number {
    return this.s.config.maxFeeRate ?? DEFAULT_MAX_FEE_RATE;
  }

  private chain() {
    if (!this.s.chain) throw new Error('no BTC chain API configured');
    return this.s.chain;
  }

  private evm() {
    if (!this.s.evm) throw new Error('no EVM client configured');
    return this.s.evm;
  }

  private deployments(): Deployments {
    const d = this.opts.deployments ?? this.s.evm?.deployments;
    if (!d) throw new Error('EVM deployments unknown');
    return d;
  }

  private async send(o: UserOrder, to: string, type: string, body: unknown): Promise<Inner> {
    const inner = await this.s.messenger.send(to, o.id, type, body);
    o.messages.push(inner);
    return inner;
  }

  private log(o: UserOrder, kind: string, text: string): void {
    o.timeline.push({ at: nowSeconds(), kind, text });
  }

  private async require(orderId: string): Promise<UserOrder> {
    const o = await this.getOrder(orderId);
    if (!o) throw new Error(`unknown order ${orderId}`);
    return o;
  }

  private async save(o: UserOrder): Promise<void> {
    o.updatedAt = nowSeconds();
    await this.s.storage.put(PREFIX + o.id, o);
    this.emit('order', o);
  }

  /** Load, mutate and save one order under its lock. Errors are recorded on the order and rethrown. */
  private mutate(orderId: string, fn: (o: UserOrder) => Promise<void>): Promise<UserOrder> {
    return this.lock.run(orderId, async () => {
      const o = await this.require(orderId);
      try {
        await fn(o);
        o.lastError = undefined;
      } catch (err) {
        o.lastError = (err as Error).message;
        await this.save(o);
        throw err;
      }
      await this.save(o);
      return o;
    });
  }
}

/** The order's signed messages without the ones that embed others (§4.9), so evidence stays under the size limit. */
function evidenceMessages(o: UserOrder): Inner[] {
  return o.messages.filter((m) => !CONTAINER_TYPES.includes(innerMeta(m).type));
}
