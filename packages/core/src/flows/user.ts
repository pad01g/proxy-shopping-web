import type { Hex } from 'viem';
import { feeRateFor } from '../btc/esplora.js';
import { buildFundingTx } from '../btc/funding.js';
import { witnessScript, type EscrowKeys } from '../btc/script.js';
import {
  buildEscrowSpend, describeInput, describeOutputs, extractTx, finalizeEscrowInput, psbtFromBase64, psbtToBase64,
  signEscrowInput, verifyPartialSig,
} from '../btc/spend.js';
import { sealDelivery } from '../delivery/delivery.js';
import type { Deployments } from '../evm/deployments.js';
import {
  recoverSafeTxSigner, releaseSafeTx, safeTxFromJson, safeTxToJson, safeTxTransfers, signSafeTx,
} from '../evm/safetx.js';
import { innerMeta, type Inner } from '../nostr/giftwrap.js';
import type { IncomingMessage } from '../nostr/messenger.js';
import {
  CONTAINER_TYPES, MSG, type Address, type DisputeOpen, type DisputeRuling, type EscrowNotice, type OrderFunded, type OrderPurchased,
  type OrderQuote, type OrderRequest, type OrderShipping, type Payment, type SignedPayout, type TrackingStatus,
} from '../nostr/messages.js';
import type { Offer } from '../trust/directory.js';
import type { EffectiveEntry, EscrowProfileContent, ShopperProfileContent } from '../trust/types.js';
import { fromHex, newOrderId, toHex } from '../util/bytes.js';
import { parseUnits } from '../util/decimal.js';
import { Emitter } from '../util/emitter.js';
import { KeyedMutex, nowSeconds } from '../util/time.js';
import { checkQuote, type QuoteCheck } from './quote-check.js';
import type { Session } from './session.js';

export type UserOrderStatus =
  | 'requested' | 'quoted' | 'rejected' | 'accepted' | 'funding' | 'funded' | 'purchased' | 'shipped'
  | 'delivered' | 'delivery_failed' | 'released' | 'completed' | 'disputed' | 'ruled' | 'settled'
  | 'refunded' | 'cancelled';

export interface TimelineEntry {
  at: number;
  kind: string;
  text: string;
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
  request: OrderRequest;
  requestInner: Inner;
  quote?: OrderQuote;
  quoteInner?: Inner;
  quoteCheck?: QuoteCheck;
  acceptInner?: Inner;
  /** Intermediate funding progress, so a retry never pays twice. */
  fundingProgress?: { btcTxid?: string; deployTx?: string; fundTx?: string; feeTx?: string };
  funded?: OrderFunded;
  fundedInner?: Inner;
  purchased?: OrderPurchased;
  tracking: TrackingStatus[];
  releaseTxid?: string;
  completedTxid?: string;
  dispute?: { open: DisputeOpen; inner: Inner };
  ruling?: DisputeRuling;
  rulingInner?: Inner;
  settledTxid?: string;
  refundTxid?: string;
  messages: Inner[];
  timeline: TimelineEntry[];
  lastError?: string;
}

export interface CreateOrderInput {
  offer: Offer;
  shopUrl: string;
  region: string;
  items: Array<{ sku: string; qty: number }>;
  payment: Payment;
  address: Address;
}

type Events = {
  order: UserOrder;
  error: { orderId?: string; error: Error };
};

const PREFIX = 'user/orders/';

/**
 * The user role (§11): order, validate quote, fund, release, dispute, refund.
 * State lives in storage; every mutation emits 'order'.
 */
export class UserClient extends Emitter<Events> {
  private readonly lock = new KeyedMutex();
  private unsubscribe?: () => void;

  constructor(
    private readonly s: Session,
    private readonly opts: { deployments?: Deployments; proxyCreationCode?: Hex; confirmations?: number } = {},
  ) {
    super();
  }

  /** Begin handling incoming messages (call before session.start()). */
  attach(): this {
    this.unsubscribe ??= this.s.messenger.on('message', (m) => {
      void this.onMessage(m).catch((error) => this.emit('error', { orderId: m.orderId, error }));
    });
    return this;
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
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

  // ---------- actions ----------

  async createOrder(input: CreateOrderInput): Promise<UserOrder> {
    const orderId = newOrderId();
    const { entry } = input.offer;
    const me = this.s.keys;
    const { envelope, key } = await sealDelivery({
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
      relays: this.s.config.relays,
    };
    if (input.payment === 'btc-signet') {
      request.user_btc_pubkey = toHex(me.orderKey(orderId).publicKey);
      request.user_btc_address = me.btcWallet.address;
    } else {
      request.user_evm_address = me.evmAddress;
    }
    const inner = await this.s.messenger.send(entry.shopper, orderId, MSG.request, request);
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
      request,
      requestInner: inner,
      tracking: [],
      messages: [inner],
      timeline: [{ at: now, kind: MSG.request, text: '注文を依頼しました' }],
    };
    await this.save(order);
    return order;
  }

  /** Re-run quote validation (e.g. after changing rate sources). */
  async recheckQuote(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      if (!o.quote) throw new Error('no quote');
      o.quoteCheck = await this.validate(o, o.quote);
    });
  }

  async acceptQuote(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      if (o.status !== 'quoted' || !o.quoteInner || !o.quote) throw new Error(`cannot accept in status ${o.status}`);
      if (!o.quoteCheck?.ok) throw new Error(`quote failed validation: ${o.quoteCheck?.errors.join('; ')}`);
      if (o.quote.expires_at && o.quote.expires_at < nowSeconds()) throw new Error('quote expired');
      o.acceptInner = await this.send(o, o.shopper, MSG.accept, { quote_id: o.quoteInner.id });
      o.status = 'accepted';
      this.log(o, MSG.accept, '見積を承諾しました');
    });
  }

  async cancel(orderId: string, reason = 'cancelled by user'): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      if (o.funded || o.fundingProgress) throw new Error('cannot cancel after funding');
      await this.send(o, o.shopper, MSG.cancel, { reason });
      o.status = 'cancelled';
      this.log(o, MSG.cancel, `取り消しました: ${reason}`);
    });
  }

  /** Lock funds (and pay the escrow upfront fee), then notify shopper and escrow (§4.6, §5.2, §6.2). */
  async fund(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      if (o.status !== 'accepted' && o.status !== 'funding') throw new Error(`cannot fund in status ${o.status}`);
      const q = o.quote!;
      o.status = 'funding';
      o.fundingProgress ??= {};
      await this.save(o);
      const funded = o.payment === 'btc-signet' ? await this.fundBtc(o, q) : await this.fundUsdc(o, q);
      o.funded = funded;
      o.fundedInner = await this.send(o, o.shopper, MSG.funded, funded);
      const notice: EscrowNotice = { request: o.requestInner, quote: o.quoteInner!, accept: o.acceptInner!, funded: o.fundedInner };
      await this.send(o, o.escrow, MSG.escrowNotice, notice);
      o.status = 'funded';
      this.log(o, MSG.funded, `入金しました (${funded.asset === 'btc-signet' ? funded.txid : funded.fund_tx})`);
    });
  }

  /** Sign the payout to the shopper and send order.release (§4.3, §5.2, §6.4). */
  async release(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      if (!o.funded) throw new Error('not funded');
      if (['released', 'completed', 'settled', 'refunded'].includes(o.status)) throw new Error(`already ${o.status}`);
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
      if (!o.funded) throw new Error('nothing to dispute before funding');
      const body: DisputeOpen = {
        claim: p.claim,
        text: p.text,
        requested_split: p.requestedSplit,
        evidence: {
          messages: evidenceMessages(o),
          tracking: o.tracking,
          purchase_evidence: o.purchased?.evidence ?? [],
          delivery_key_for_escrow: o.request.delivery.key_for_escrow,
          delivery_ciphertext: o.request.delivery.ciphertext,
        },
      };
      const inner = await this.send(o, o.escrow, MSG.disputeOpen, body);
      await this.send(o, o.shopper, MSG.disputeOpen, body);
      o.dispute = { open: body, inner };
      o.status = 'disputed';
      this.log(o, MSG.disputeOpen, `紛争を申し立てました (${p.claim})`);
    });
  }

  /** Answer an evidence request: resend everything we have. */
  async sendEvidence(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      await this.send(o, o.escrow, MSG.evidence, {
        messages: evidenceMessages(o),
        tracking: o.tracking,
        purchase_evidence: o.purchased?.evidence ?? [],
        delivery_key_for_escrow: o.request.delivery.key_for_escrow,
        delivery_ciphertext: o.request.delivery.ciphertext,
      });
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
        const { hex } = extractTx(tx);
        txid = await this.chain().broadcast(hex);
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
      o.settledTxid = txid;
      await this.send(o, o.shopper, MSG.countersigned, { txid });
      await this.send(o, o.escrow, MSG.countersigned, { txid });
      o.status = 'settled';
      this.log(o, MSG.countersigned, `裁定に連署して放送しました (${txid})`);
    });
  }

  /** After T2 the user alone can take everything back (§5.1 T2 path, §6.3 refundToUser). */
  async refundAfterTimelock(orderId: string): Promise<UserOrder> {
    return this.mutate(orderId, async (o) => {
      if (!o.funded) throw new Error('not funded');
      const q = o.quote!;
      const t2 = q.timelock!.t2;
      let txid: string;
      if (o.payment === 'btc-signet') {
        const tip = await this.chain().tipHeight();
        if (tip < t2) throw new Error(`T2 not reached: height ${tip} < ${t2}`);
        const f = o.funded as Extract<OrderFunded, { asset: 'btc-signet' }>;
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
        txid = await this.chain().broadcast(extractTx(tx).hex);
      } else {
        const now = await this.evm().blockTimestamp();
        if (now < BigInt(t2)) throw new Error(`T2 not reached: ${now} < ${t2}`);
        const f = o.funded as Extract<OrderFunded, { asset: 'usdc-evm' }>;
        txid = await this.evm().refundToUser(f.safe as `0x${string}`);
      }
      o.refundTxid = txid;
      o.status = 'refunded';
      this.log(o, 'refund', `T2 経過後に返金を受けました (${txid})`);
    });
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
          if (fromShopper && !o.funded) {
            o.status = 'cancelled';
            this.log(o, m.type, `shopper が取り消しました: ${(m.body as { reason?: string }).reason ?? ''}`);
          }
          break;
        case MSG.purchased:
          if (!fromShopper) break;
          o.purchased = m.body as OrderPurchased;
          if (o.status === 'funded') o.status = 'purchased';
          this.log(o, m.type, `購入されました (店の注文番号 ${o.purchased.shop_order_id})`);
          break;
        case MSG.shipping: {
          if (!fromShopper) break;
          const b = m.body as OrderShipping;
          if (b.tracking) o.tracking.push(b.tracking);
          const next = ({ shipped: 'shipped', delivered: 'delivered', failed: 'delivery_failed' } as const)[b.status];
          if (next && ['funded', 'purchased', 'shipped'].includes(o.status)) o.status = next;
          this.log(o, m.type, `配送状況: ${b.status}${b.tracking?.tracking_no ? ` (${b.tracking.tracking_no})` : ''}`);
          break;
        }
        case MSG.completed:
          if (!fromShopper) break;
          o.completedTxid = (m.body as { txid: string }).txid;
          if (o.status === 'released' || o.status === 'delivered') o.status = 'completed';
          this.log(o, m.type, `完了しました (${o.completedTxid})`);
          break;
        case MSG.refund:
          if (!fromShopper) break;
          await this.onCooperativeRefund(o, m.body as SignedPayout);
          break;
        case MSG.evidenceRequest:
          if (!fromEscrow) break;
          this.log(o, m.type, `escrow が証拠を求めています: ${((m.body as { want?: string[] }).want ?? []).join(', ')}`);
          break;
        case MSG.ruling:
          if (!fromEscrow) break;
          o.ruling = m.body as DisputeRuling;
          o.rulingInner = m.inner;
          if (!['settled', 'refunded', 'completed'].includes(o.status)) o.status = 'ruled';
          this.log(o, m.type, `裁定: user ${o.ruling.split?.user} / shopper ${o.ruling.split?.shopper} — ${o.ruling.reason}`);
          break;
        case MSG.countersigned:
          o.settledTxid = (m.body as { txid: string }).txid;
          o.status = 'settled';
          this.log(o, m.type, `相手が裁定に連署しました (${o.settledTxid})`);
          break;
        case MSG.disputeOpen:
          if (!fromShopper) break;
          this.log(o, m.type, `shopper が紛争を申し立てました (${(m.body as DisputeOpen).claim})`);
          if (!o.dispute) o.status = 'disputed';
          break;
        case MSG.chat:
          this.log(o, m.type, `${fromShopper ? 'shopper' : 'escrow'}: ${(m.body as { text?: string }).text ?? ''}`);
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
      o.quoteCheck = { ok: false, errors: [`shopper declined: ${quote.reject_reason ?? ''}`], warnings: [] };
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
    let proxyCreationCode = this.opts.proxyCreationCode;
    if (o.payment === 'usdc-evm' && !proxyCreationCode && this.s.evm) {
      proxyCreationCode = await this.s.evm.proxyCreationCode().catch(() => undefined);
    }
    return checkQuote({
      orderId: o.id,
      request: o.request,
      quote,
      shopper: o.shopper,
      escrowProfile,
      entries: snap?.entries ?? [],
      userBtcPubkey: o.payment === 'btc-signet' ? this.s.keys.orderKey(o.id).publicKey : undefined,
      userEvmAddress: o.payment === 'usdc-evm' ? this.s.keys.evmAddress : undefined,
      deployments: this.opts.deployments,
      proxyCreationCode,
      rates: this.s.rates,
    });
  }

  private async onCooperativeRefund(o: UserOrder, body: SignedPayout): Promise<void> {
    // The shopper offers to give everything back. Countersign only if it pays us.
    if (o.payment === 'btc-signet' && body.asset === 'btc-signet') {
      const tx = psbtFromBase64(body.psbt);
      const outs = describeOutputs(tx);
      const keys = this.escrowKeys(o);
      if (!verifyPartialSig(tx, keys.shopper) || outs.some((x) => x.address !== o.request.user_btc_address)) {
        this.log(o, MSG.refund, '払い戻しの提案を検証できませんでした');
        return;
      }
      signEscrowInput(tx, this.s.keys.orderKey(o.id).privateKey);
      finalizeEscrowInput(tx, keys, 'multisig');
      o.refundTxid = await this.chain().broadcast(extractTx(tx).hex);
    } else if (o.payment === 'usdc-evm' && body.asset === 'usdc-evm') {
      const d = this.deployments();
      const f = o.funded as Extract<OrderFunded, { asset: 'usdc-evm' }>;
      const safe = f.safe as `0x${string}`;
      const tx = safeTxFromJson(body.safe_tx);
      const transfers = safeTxTransfers(tx, d.usdc);
      const signer = await recoverSafeTxSigner(tx, d.chain_id, safe, body.signature as Hex);
      if (signer.toLowerCase() !== o.quote!.shopper_evm_address!.toLowerCase() || transfers.some((t) => t.to.toLowerCase() !== this.s.keys.evmAddress.toLowerCase())) {
        this.log(o, MSG.refund, '払い戻しの提案を検証できませんでした');
        return;
      }
      const mine = await signSafeTx(this.s.keys.evmAccount, tx, d.chain_id, safe);
      o.refundTxid = await this.evm().execSafeTx(safe, tx, [
        { signer: this.s.keys.evmAddress, signature: mine },
        { signer, signature: body.signature as Hex },
      ]);
    } else return;
    o.status = 'refunded';
    this.log(o, MSG.refund, `shopper の払い戻しを受けました (${o.refundTxid})`);
  }

  // ---------- funding ----------

  private async fundBtc(o: UserOrder, q: OrderQuote): Promise<OrderFunded> {
    const chain = this.chain();
    const lock = parseUnits(q.lock_amount!);
    const fee = parseUnits(q.escrow_upfront_fee ?? '0');
    if (!o.fundingProgress?.btcTxid) {
      const wallet = this.s.keys.btcWallet;
      const outputs = [{ address: q.escrow_address!, amount: lock }];
      if (fee > 0n) outputs.push({ address: q.escrow_btc_fee_address!, amount: fee });
      const tx = buildFundingTx({ wallet, utxos: await chain.utxos(wallet.address), outputs, feeRate: await feeRateFor(chain) });
      const txid = await chain.broadcast(tx.hex);
      o.fundingProgress = { ...o.fundingProgress, btcTxid: txid };
      await this.save(o);
    }
    const txid = o.fundingProgress!.btcTxid!;
    return { asset: 'btc-signet', txid, vout: 0, amount: lock.toString(), fee_txid: txid };
  }

  private async fundUsdc(o: UserOrder, q: OrderQuote): Promise<OrderFunded> {
    const evm = this.evm();
    const safe = q.escrow_address as `0x${string}`;
    const lock = parseUnits(q.lock_amount!);
    const fee = parseUnits(q.escrow_upfront_fee ?? '0');
    const p = (o.fundingProgress ??= {});
    if (!p.deployTx) {
      p.deployTx = (await evm.isDeployed(safe))
        ? 'already-deployed'
        : await evm.deploySafe({
            user: this.s.keys.evmAddress,
            shopper: q.shopper_evm_address as `0x${string}`,
            escrow: q.escrow_evm_address as `0x${string}`,
            t1: BigInt(q.timelock!.t1),
            t2: BigInt(q.timelock!.t2),
            orderId: o.id,
          });
      if (!(await evm.isDeployed(safe))) throw new Error('Safe was not deployed at the predicted address');
      await this.save(o);
    }
    if (!p.fundTx) {
      p.fundTx = await evm.transferUsdc(safe, lock);
      await this.save(o);
    }
    if (!p.feeTx && fee > 0n) {
      p.feeTx = await evm.transferUsdc(q.escrow_evm_address as `0x${string}`, fee);
      await this.save(o);
    }
    return { asset: 'usdc-evm', safe, deploy_tx: p.deployTx, fund_tx: p.fundTx, fee_tx: p.feeTx ?? '', amount: lock.toString() };
  }

  // ---------- helpers ----------

  private async rulingProblems(o: UserOrder, r: DisputeRuling): Promise<string[]> {
    const problems: string[] = [];
    const q = o.quote!;
    if (!r.split) return ['ruling has no split'];
    const split = { user: parseUnits(r.split.user), shopper: parseUnits(r.split.shopper), fee: parseUnits(r.split.escrow_fee) };
    const lock = parseUnits(q.lock_amount!);
    const reserve = parseUnits(q.payout_fee_reserve ?? '0');
    if (split.user + split.shopper + split.fee !== lock - reserve) problems.push('split does not add up to the escrow balance');
    if (o.payment === 'btc-signet') {
      if (!r.psbt) return [...problems, 'no PSBT'];
      const tx = psbtFromBase64(r.psbt);
      const f = o.funded as Extract<OrderFunded, { asset: 'btc-signet' }>;
      const input = describeInput(tx);
      if (tx.inputsLength !== 1 || input.txid !== f.txid || input.vout !== (f.vout ?? 0)) problems.push('PSBT spends a different outpoint');
      if (!verifyPartialSig(tx, this.escrowKeys(o).escrow)) problems.push('escrow signature invalid');
      const expected = [
        { address: o.request.user_btc_address, amount: split.user },
        { address: q.shopper_btc_address, amount: split.shopper },
        { address: q.escrow_btc_fee_address, amount: split.fee },
      ].filter((x) => x.amount > 0n);
      const actual = describeOutputs(tx);
      const same = actual.length === expected.length && expected.every((e, i) => actual[i].address === e.address && actual[i].amount === e.amount);
      if (!same) problems.push('PSBT outputs differ from the split');
    } else {
      if (!r.safe_tx || !r.signature) return [...problems, 'no SafeTx'];
      const d = this.deployments();
      const f = o.funded as Extract<OrderFunded, { asset: 'usdc-evm' }>;
      const tx = safeTxFromJson(r.safe_tx);
      const signer = await recoverSafeTxSigner(tx, d.chain_id, f.safe as `0x${string}`, r.signature as Hex);
      if (signer.toLowerCase() !== (q.escrow_evm_address ?? '').toLowerCase()) problems.push('SafeTx not signed by the escrow');
      if (tx.operation === 1 && tx.to.toLowerCase() !== d.safe.multisend_call_only.toLowerCase()) problems.push('delegatecall to unknown contract');
      try {
        const transfers = safeTxTransfers(tx, d.usdc);
        const expected = [
          { to: o.request.user_evm_address, amount: split.user },
          { to: q.shopper_evm_address, amount: split.shopper },
          { to: q.escrow_evm_address, amount: split.fee },
        ].filter((x) => x.amount > 0n);
        const same = transfers.length === expected.length && expected.every((e, i) => transfers[i].to.toLowerCase() === (e.to ?? '').toLowerCase() && transfers[i].amount === e.amount);
        if (!same) problems.push('SafeTx transfers differ from the split');
      } catch (err) {
        problems.push((err as Error).message);
      }
    }
    return problems;
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
