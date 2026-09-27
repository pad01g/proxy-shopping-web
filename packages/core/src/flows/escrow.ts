import type { Hex } from 'viem';
import { Transaction } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { addressToScript, p2wshAddress, p2wshOutputScript, witnessScript, type EscrowKeys } from '../btc/script.js';
import { buildEscrowSpend, psbtToBase64, signEscrowInput } from '../btc/spend.js';
import { decryptAddress, keyForEscrowSha256, unwrapDeliveryKey } from '../delivery/delivery.js';
import type { Deployments } from '../evm/deployments.js';
import { knownProxyCreationCode } from '../evm/proxy-creation-code.js';
import { orderSafeAddress } from '../evm/safe.js';
import { safeTxToJson, signSafeTx, splitSafeTx } from '../evm/safetx.js';
import { verifyRequestKeyProof } from '../keys/proof.js';
import { innerMeta, isValidInner, type Inner } from '../nostr/giftwrap.js';
import type { IncomingMessage } from '../nostr/messenger.js';
import {
  MSG, type Address, type Attachment, type DisputeEvidence, type DisputeOpen, type DisputeRuling, type EscrowNotice, type Evidence,
  type OrderAccept, type OrderEscrowKey, type OrderFunded, type OrderQuote, type OrderRequest, type Payment, type Split, type TrackingStatus,
} from '../nostr/messages.js';
import { innerBodyAs } from '../nostr/schema.js';
import { escrowProfileTemplate, parseEscrowProfile } from '../trust/events.js';
import type { EscrowProfileContent } from '../trust/types.js';
import { KIND } from '../nostr/kinds.js';
import { fromHex, toHex } from '../util/bytes.js';
import { parseUnits } from '../util/decimal.js';
import { Emitter } from '../util/emitter.js';
import { KeyedMutex, nowSeconds } from '../util/time.js';
import { escrowUpfrontMinimum } from './quote-check.js';
import { BTC_DUST_SATS } from './quote-check.js';
import type { Session } from './session.js';
import { escrowSpent } from './settlement.js';
import type { TimelineEntry } from './user.js';

export type CaseStatus = 'notice' | 'open' | 'ruled' | 'settled';

export interface Obligation {
  paid: boolean;
  detail: string;
  checkedAt: number;
}

/** Result of checking the assembled order against the chain (§4.7). */
export interface CaseVerification {
  /** The order is what request + quote describe and the funds sit in that escrow output / Safe. */
  ok: boolean;
  problems: string[];
  checkedAt: number;
}

/** Inner ids of the four messages that define an order (§4.7). */
export interface OrderParts {
  request: string;
  quote: string;
  accept?: string;
  funded: string;
}

export interface EscrowCase {
  orderId: string;
  status: CaseStatus;
  createdAt: number;
  updatedAt: number;
  /** Whose message made us open this case. */
  createdBy?: string;
  /**
   * §4.7: the case is keyed by the order.request whose request + quote recompute to the funded output on
   * chain; the first such request decides the case (a notice from its signer may replace one found in evidence).
   */
  requestId?: string;
  /** Signer of the order.request (with a valid key_proof). */
  user?: string;
  /** Recipient of the order.request. */
  shopper?: string;
  request?: OrderRequest;
  quote?: OrderQuote;
  funded?: OrderFunded;
  /** The chain-checked request / quote / accept / funded the case was opened with. */
  basis?: OrderParts;
  /** Inner ids from escrow.notice; when present they define the order (§4.7). */
  noticeIds?: { request: string; quote: string; accept: string; funded: string };
  /** The order's parts as assembled: inner ids of request / quote / accept / funded. */
  assembled?: { request?: string; quote?: string; accept?: string; funded?: string };
  /** Messages that contradicted the case (other requests, a second notice, …): ignored, but recorded. */
  conflicts?: string[];
  disputes: Array<{ from: string; body: DisputeOpen; at: number }>;
  /** Verified signed inners collected from all parties, deduplicated by id. */
  messages: Inner[];
  tracking: TrackingStatus[];
  purchaseEvidence: Evidence[];
  /** Full evidence items by sha256, received in chunks (§4.9); dataB64 is set once complete and verified. */
  attachments?: Record<string, { mime: string; total: number; chunks?: Record<number, string>; dataB64?: string }>;
  /** key_for_escrow, only once its SHA-256 matches the signed request (§4.4). */
  deliveryKeyForEscrow?: string;
  obligation?: Obligation;
  verification?: CaseVerification;
  ruling?: DisputeRuling;
  /** A party's dispute.countersigned, waiting for the chain to confirm (§4.8). */
  pendingSettlement?: { txid: string; from: string; at: number };
  settledTxid?: string;
  timeline: TimelineEntry[];
}

/** What a ruling may distribute now (§4.8), for the ruling form. */
export interface RulingTerms {
  asset: Payment;
  /** BTC: escrow output − payout_fee_reserve; USDC: the Safe's balance now. */
  distributable: bigint;
  /** floor(dispute_fee_bps × distributable); user + shopper must be distributable − fee. */
  fee: bigint;
  bps: number;
}

/** Our own terms (kind 30503) as far as rulings need them. */
type Terms = Pick<EscrowProfileContent, 'upfront_fee' | 'dispute_fee_bps'>;

/** A notice or dispute.open for an order we have no case for yet, kept until its order checks out on chain. */
interface PendingItem {
  from: string;
  type: string;
  inner: Inner;
  body: unknown;
  at: number;
}

interface Pending {
  orderId: string;
  items: PendingItem[];
  firstAt: number;
  triedAt: number;
}

/** A request with the quote / accept / funded that go with it, taken from one message. */
interface Candidate {
  request: Inner;
  quote: Inner;
  accept?: Inner;
  funded: Inner;
  user: string;
  shopper: string;
  fromNotice: boolean;
}

type Events = {
  case: EscrowCase;
  error: { orderId?: string; error: Error };
};

const PREFIX = 'escrow/cases/';
const FEE_USED = 'escrow/fee-used/';
const PENDING = 'escrow/pending/';
const TERMS = 'escrow/terms';
const MESSAGE_LIMIT = 500;
const CONFLICT_LIMIT = 50;
/** Unverified notices / disputes kept: per order and orders in all (spam bound). */
const PENDING_PER_ORDER = 4;
const PENDING_ORDERS = 200;
const PENDING_RETRY_SECONDS = 60;
const PENDING_KEEP_SECONDS = 7 * 86400;
const HANDLED: readonly string[] = [MSG.escrowNotice, MSG.disputeOpen, MSG.evidence, MSG.countersigned, MSG.attachment];

/**
 * Browser escrow (§3.2, §4.7, §4.8): collects evidence, decrypts the delivery
 * address, checks the order and upfront fee on chain and signs a split.
 */
export class EscrowClient extends Emitter<Events> {
  private readonly lock = new KeyedMutex();
  private unsubscribe?: () => void;
  private unaccept?: () => void;
  private poller?: ReturnType<typeof setInterval>;

  constructor(
    private readonly s: Session,
    private readonly opts: { deployments?: Deployments; chainPollMs?: number } = {},
  ) {
    super();
  }

  attach(): this {
    this.unsubscribe ??= this.s.messenger.on('message', (m) => {
      void this.onMessage(m).catch((error) => this.emit('error', { orderId: m.orderId, error }));
    });
    // §4.10: the parties of our cases, and notices / disputes that name us; nothing else.
    this.unaccept ??= this.s.addAcceptor(async (inner, meta) => {
      const c = await this.getCase(meta.orderId);
      if (c && (inner.pubkey === c.user || inner.pubkey === c.shopper)) return 'counterparty';
      if (meta.type === MSG.escrowNotice || meta.type === MSG.disputeOpen) return (await this.namesUs(inner, meta.type)) ? 'stranger' : 'reject';
      return 'reject';
    });
    const every = this.opts.chainPollMs ?? 5000;
    if (every > 0 && !this.poller) {
      this.poller = setInterval(() => void this.poll(), every);
      (this.poller as { unref?: () => void }).unref?.();
    }
    return this;
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unaccept?.();
    this.unaccept = undefined;
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
  }

  setDeployments(d: Deployments | undefined): void {
    this.opts.deployments = d;
  }

  /** Profile content derived from our keys plus the given terms. */
  profileContent(p: Pick<EscrowProfileContent, 'name' | 'upfront_fee' | 'dispute_fee_bps'>): EscrowProfileContent {
    return {
      name: p.name,
      btc_xpub: this.s.keys.escrowXpub,
      btc_fee_address: this.s.keys.btcWallet.address,
      evm_address: this.s.keys.evmAddress,
      upfront_fee: p.upfront_fee,
      dispute_fee_bps: p.dispute_fee_bps,
    };
  }

  /** Publish kind 30503 (bumping v) and our kind 10050 inbox relays. */
  async publishProfile(p: Pick<EscrowProfileContent, 'name' | 'upfront_fee' | 'dispute_fee_bps'>) {
    const v = await this.s.nextVersion(KIND.escrowProfile, this.s.network);
    const res = await this.s.publishOwn(escrowProfileTemplate(this.profileContent(p), this.s.network, v));
    await this.s.storage.put<Terms>(TERMS, { upfront_fee: p.upfront_fee, dispute_fee_bps: p.dispute_fee_bps });
    await this.s.publishInboxRelays();
    return res;
  }

  /** Our published terms: the fee cap we rule with and the upfront minimum we owe rulings for. */
  async terms(): Promise<Terms | undefined> {
    const local = await this.s.storage.get<Terms>(TERMS);
    if (local) return local;
    const ev = await this.s.ownLatest(KIND.escrowProfile, this.s.network).catch(() => undefined);
    const content = ev && parseEscrowProfile(ev)?.content;
    if (!content) return undefined;
    const terms = { upfront_fee: content.upfront_fee, dispute_fee_bps: content.dispute_fee_bps };
    await this.s.storage.put<Terms>(TERMS, terms);
    return terms;
  }

  async listCases(): Promise<EscrowCase[]> {
    const rows = await this.s.storage.list<EscrowCase>(PREFIX);
    return rows.map(([, c]) => c).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getCase(orderId: string): Promise<EscrowCase | undefined> {
    return this.s.storage.get<EscrowCase>(PREFIX + orderId);
  }

  /**
   * Decrypt the delivery address (§4.4): with a key_for_escrow whose hash the signed request
   * commits to, and only the signed request's ciphertext.
   */
  async decryptAddress(orderId: string): Promise<Address> {
    const c = await this.require(orderId);
    const ct = c.request?.delivery.ciphertext;
    if (!c.deliveryKeyForEscrow || !ct || !c.user) throw new Error('delivery key or ciphertext not received yet');
    const key = await unwrapDeliveryKey(this.s.signer, c.user, c.deliveryKeyForEscrow);
    return decryptAddress(key, orderId, ct);
  }

  /** Verify the order on chain and the upfront fee; without the fee we owe no ruling (§3.2, §4.6). */
  async checkObligation(orderId: string): Promise<Obligation> {
    return this.mutate(orderId, async (c) => {
      await this.verify(c);
      this.log(c, 'obligation', c.obligation!.paid ? '前払い手数料を確認しました' : `前払い手数料なし: ${c.obligation!.detail}`);
    }).then((c) => c.obligation!);
  }

  async requestEvidence(orderId: string, want: string[], to: 'user' | 'shopper' | 'both' = 'both'): Promise<EscrowCase> {
    return this.mutate(orderId, async (c) => {
      const targets = to === 'both' ? [c.user, c.shopper] : [to === 'user' ? c.user : c.shopper];
      for (const t of targets) if (t) await this.s.messenger.send(t, orderId, MSG.evidenceRequest, { want });
      this.log(c, MSG.evidenceRequest, `証拠を求めました: ${want.join(', ')}`);
    });
  }

  /** What is still missing before a fair ruling (§4.7). */
  async missingEvidence(orderId: string): Promise<string[]> {
    const c = await this.require(orderId);
    const want: string[] = [];
    if (!c.request) want.push('order.request');
    if (!c.quote) want.push('order.quote');
    if (!c.funded) want.push('order.funded');
    if (!c.messages.some((m) => innerMeta(m).type === MSG.purchased)) want.push('order.purchased');
    if (!c.tracking.length) want.push('tracking');
    if (!c.deliveryKeyForEscrow) want.push('delivery_key_for_escrow');
    return want;
  }

  /** Re-check a pending dispute.countersigned claim on chain. */
  async verifySettlement(orderId: string): Promise<EscrowCase> {
    return this.mutate(orderId, (c) => this.checkSettlement(c));
  }

  /** The amounts a ruling of this case splits now (§4.8): reads the Safe's balance for USDC. */
  async rulingTerms(orderId: string): Promise<RulingTerms> {
    const c = await this.require(orderId);
    const { request, quote, funded } = c;
    if (!request || !quote || !funded) throw new Error('case lacks request/quote/funded evidence');
    const terms = await this.terms();
    if (!terms) throw new Error('publish the escrow profile first: its dispute_fee_bps bounds the ruling fee');
    let distributable: bigint;
    if (funded.asset === 'btc-signet') {
      distributable = parseUnits(quote.lock_amount!) - parseUnits(quote.payout_fee_reserve ?? '0');
    } else {
      // Anyone can send USDC to the Safe; the split covers what it holds when we sign.
      distributable = await this.evm().usdcBalance(funded.safe as `0x${string}`);
      if (distributable < parseUnits(quote.lock_amount!)) throw new Error(`the Safe holds ${distributable}, less than lock_amount: already paid out?`);
    }
    // Like the Go escrow: the fee is exactly dispute_fee_bps of the distributable amount, rounded down,
    // and a BTC fee below the dust limit is dropped (an output that small could not be relayed, §4.8).
    let fee = (distributable * BigInt(terms.dispute_fee_bps)) / 10000n;
    if (funded.asset === 'btc-signet' && fee < BTC_DUST_SATS) fee = 0n;
    return { asset: request.payment, distributable, fee, bps: terms.dispute_fee_bps };
  }

  /**
   * Sign a split and send dispute.ruling to both parties. The escrow fee is floor(dispute_fee_bps ×
   * distributable) (§4.8, we keep our own cap); user + shopper must be the rest. `escrow_fee`, when given,
   * must be that fee.
   */
  async rule(orderId: string, split: { user: string; shopper: string; escrow_fee?: string }, reason: string): Promise<EscrowCase> {
    return this.mutate(orderId, async (c) => {
      const { request, quote, funded } = c;
      if (!request || !quote || !funded || !c.user || !c.shopper) throw new Error('case lacks request/quote/funded evidence');
      if (!c.disputes.length) throw new Error('no dispute has been opened');
      // §4.8: one ruling per dispute — a second signed split would conflict with the first.
      if (c.ruling) throw new Error('already ruled');
      await this.verify(c);
      const structural = c.verification!.problems.filter((p) => !p.startsWith('fee:'));
      if (structural.length) throw new Error(`order does not check out on chain: ${structural.join('; ')}`);
      const { distributable, fee } = await this.rulingTerms(orderId);
      const user = parseUnits(split.user);
      const shopper = parseUnits(split.shopper);
      if (split.escrow_fee !== undefined && parseUnits(split.escrow_fee) !== fee) {
        throw new Error(`escrow_fee must be ${fee} (dispute_fee_bps of ${distributable})`);
      }
      if (request.payment === 'btc-signet' && [user, shopper].some((v) => v > 0n && v < BTC_DUST_SATS)) {
        throw new Error(`a BTC share must be 0 or at least ${BTC_DUST_SATS} sats: a smaller output could not be relayed`);
      }
      if (user + shopper !== distributable - fee) {
        throw new Error(`user + shopper must add up to ${distributable - fee} (${distributable} minus the dispute fee ${fee}), got ${user + shopper}`);
      }
      const finalSplit: Split = { user: user.toString(), shopper: shopper.toString(), escrow_fee: fee.toString() };
      const ruling: DisputeRuling = { split: finalSplit, reason, asset: request.payment };
      if (!c.obligation!.paid) ruling.no_obligation = true;

      if (funded.asset === 'btc-signet') {
        const myKey = this.s.keys.escrowOrderKey(orderId);
        const tx = buildEscrowSpend({
          outpoint: { txid: funded.txid, vout: funded.vout ?? 0, amount: parseUnits(quote.lock_amount!) },
          witnessScript: witnessScript(this.escrowKeys(request, quote), quote.timelock!.t1, quote.timelock!.t2),
          outputs: [
            { address: request.user_btc_address!, amount: user },
            { address: quote.shopper_btc_address!, amount: shopper },
            // Our fee goes to our own wallet, whatever address the quote named.
            { address: this.s.keys.btcWallet.address, amount: fee },
          ],
        });
        signEscrowInput(tx, myKey.privateKey);
        ruling.psbt = psbtToBase64(tx);
      } else {
        const d = this.deployments();
        const safe = funded.safe as `0x${string}`;
        const tx = splitSafeTx({
          usdc: d.usdc,
          multiSend: d.safe.multisend_call_only,
          payouts: [
            { to: request.user_evm_address as `0x${string}`, amount: user },
            { to: quote.shopper_evm_address as `0x${string}`, amount: shopper },
            { to: this.s.keys.evmAddress, amount: fee },
          ],
          nonce: await this.evm().safeNonce(safe),
        });
        ruling.safe_tx = safeTxToJson(tx);
        ruling.signature = await signSafeTx(this.s.keys.evmAccount, tx, d.chain_id, safe) as Hex;
      }
      // Record the ruling before it leaves: after a failed send it must never be signed a second time.
      c.ruling = ruling;
      c.status = 'ruled';
      this.log(c, MSG.ruling, `裁定しました: user ${finalSplit.user} / shopper ${finalSplit.shopper} / fee ${finalSplit.escrow_fee}`);
      await this.save(c);
      await this.s.messenger.send(c.user, orderId, MSG.ruling, ruling);
      await this.s.messenger.send(c.shopper, orderId, MSG.ruling, ruling);
    });
  }

  // ---------- incoming ----------

  private async onMessage(m: IncomingMessage): Promise<void> {
    if (!HANDLED.includes(m.type)) return;
    await this.lock.run(m.orderId, async () => {
      const c = await this.getCase(m.orderId);
      if (c) {
        const before = JSON.stringify(c);
        await this.apply(c, m);
        await this.assemble(c);
        if (JSON.stringify(c) !== before) await this.save(c);
        return;
      }
      // §4.7: no case until a notice or dispute names a request whose funding is on chain.
      if (m.type !== MSG.escrowNotice && m.type !== MSG.disputeOpen) return;
      await this.keepPending(m);
      await this.openFromPending(m.orderId);
    });
  }

  /** Apply one message from `m.from` to an existing case. */
  private async apply(c: EscrowCase, m: Pick<IncomingMessage, 'from' | 'type' | 'inner' | 'body'>): Promise<void> {
    if (m.type === MSG.escrowNotice) return this.applyNotice(c, m.from, m.inner, m.body as EscrowNotice);
    // Only the order's two parties talk to us about it; a stranger's dispute is recorded, never used.
    if (m.from !== c.user && m.from !== c.shopper) {
      if (m.type === MSG.disputeOpen) this.conflict(c, `dispute.open ${m.inner.id.slice(0, 12)} from ${m.from.slice(0, 12)}, not a party of request ${c.requestId?.slice(0, 12)}; ignored`);
      return;
    }
    if (m.type === MSG.attachment) {
      this.addChunk(c, m.body as Attachment, m.from);
    } else if (m.type === MSG.disputeOpen || m.type === MSG.evidence) {
      this.addMessage(c, m.inner);
      const body = m.body as DisputeOpen | DisputeEvidence;
      const ev: DisputeEvidence = 'evidence' in body && 'claim' in body ? body.evidence : (body as DisputeEvidence);
      for (const inner of ev.messages) if (isValidInner(inner)) this.addMessage(c, inner);
      for (const t of ev.tracking) if (!c.tracking.some((x) => JSON.stringify(x) === JSON.stringify(t))) c.tracking.push(t);
      for (const e of ev.purchase_evidence) if (!c.purchaseEvidence.some((x) => x.sha256 === e.sha256)) c.purchaseEvidence.push(e);
      if (ev.delivery_key_for_escrow) this.offerDeliveryKey(c, ev.delivery_key_for_escrow, m.from);
      if (m.type === MSG.disputeOpen) {
        const d = body as DisputeOpen;
        c.disputes.push({ from: m.from, body: d, at: nowSeconds() });
        if (c.status === 'notice') c.status = 'open';
        this.log(c, m.type, `${this.who(c, m.from)} が紛争を申し立てました: ${d.claim} — ${d.text}`);
      } else {
        this.log(c, m.type, `${this.who(c, m.from)} から証拠を受け取りました`);
      }
    } else if (m.type === MSG.countersigned) {
      if (!c.ruling) return;
      c.pendingSettlement = { txid: (m.body as { txid: string }).txid, from: m.from, at: nowSeconds() };
      this.log(c, m.type, `${this.who(c, m.from)} が連署を報告しました (${c.pendingSettlement.txid})。チェーンで確かめます`);
      await this.checkSettlement(c).catch((err) => this.log(c, m.type, `チェーンの確認に失敗: ${(err as Error).message}`));
    }
  }

  /**
   * §4.7: the notice of the request's signer defines the order. It completes a case of the same request; for
   * another request it replaces a case that has no notice yet — but only if that request checks out on chain.
   */
  private async applyNotice(c: EscrowCase, from: string, inner: Inner, n: EscrowNotice): Promise<void> {
    const cand = this.noticeCandidate(n, c.orderId, from, await this.s.pubkey());
    if (!cand) {
      this.log(c, MSG.escrowNotice, '入金の通知の署名や差出人が合わないので無視しました');
      return;
    }
    const ids = { request: cand.request.id, quote: cand.quote.id, accept: cand.accept!.id, funded: cand.funded.id };
    if (c.noticeIds) {
      if (c.noticeIds.request !== ids.request) this.conflict(c, `a second escrow.notice names request ${ids.request.slice(0, 12)}; ignored`);
      return;
    }
    if (ids.request !== c.requestId || cand.user !== c.user) {
      if (c.ruling) {
        this.conflict(c, `escrow.notice for request ${ids.request.slice(0, 12)} after the ruling; ignored`);
        return;
      }
      const problems = await this.chainProblems(c.orderId, cand);
      if (problems.length) {
        this.conflict(c, `escrow.notice for request ${ids.request.slice(0, 12)} does not match the chain (${problems.join('; ')}); ignored`);
        return;
      }
      this.conflict(c, `case was assembled from request ${c.requestId?.slice(0, 12)} (no notice); replaced by the notice of request ${ids.request.slice(0, 12)}`);
      c.requestId = ids.request;
      c.user = cand.user;
      c.shopper = cand.shopper;
      c.basis = { request: ids.request, quote: ids.quote, accept: ids.accept, funded: ids.funded };
      c.disputes = c.disputes.filter((d) => d.from === c.user || d.from === c.shopper);
      c.deliveryKeyForEscrow = undefined;
      c.obligation = undefined;
      c.verification = undefined;
      c.status = c.disputes.length ? 'open' : 'notice';
    }
    this.addMessage(c, inner);
    for (const x of [cand.request, cand.quote, cand.accept!, cand.funded]) this.addMessage(c, x);
    c.noticeIds = ids;
    this.log(c, MSG.escrowNotice, '入金の通知を受けました');
  }

  /** Keep a notice / dispute for an order without a case (bounded), to be opened once it checks out. */
  private async keepPending(m: IncomingMessage): Promise<void> {
    const key = PENDING + m.orderId;
    const now = nowSeconds();
    const p = (await this.s.storage.get<Pending>(key)) ?? { orderId: m.orderId, items: [], firstAt: now, triedAt: 0 };
    if (p.items.some((x) => x.inner.id === m.inner.id)) return;
    p.items = [...p.items, { from: m.from, type: m.type, inner: m.inner, body: m.body, at: now }].slice(-PENDING_PER_ORDER);
    await this.s.storage.put(key, p);
    const all = await this.s.storage.list<Pending>(PENDING);
    if (all.length > PENDING_ORDERS) {
      for (const [k] of all.sort(([, a], [, b]) => a.firstAt - b.firstAt).slice(0, all.length - PENDING_ORDERS)) await this.s.storage.delete(k);
    }
  }

  /**
   * Open the case from the first kept message whose request + quote recompute to the funded output on chain
   * (§4.7: the case is keyed by that request). The other kept messages are then applied like later ones.
   */
  private async openFromPending(orderId: string): Promise<EscrowCase | undefined> {
    const key = PENDING + orderId;
    const p = await this.s.storage.get<Pending>(key);
    if (!p) return undefined;
    const me = await this.s.pubkey();
    const tried: string[] = [];
    for (const item of p.items) {
      for (const cand of await this.candidates(item, orderId, me)) {
        if (tried.includes(cand.request.id)) continue;
        tried.push(cand.request.id);
        if ((await this.chainProblems(orderId, cand)).length) continue;
        const now = nowSeconds();
        const c: EscrowCase = {
          orderId, status: 'notice', createdAt: now, updatedAt: now, createdBy: item.from,
          requestId: cand.request.id, user: cand.user, shopper: cand.shopper,
          basis: { request: cand.request.id, quote: cand.quote.id, accept: cand.accept?.id, funded: cand.funded.id },
          disputes: [], messages: [], tracking: [], purchaseEvidence: [], timeline: [],
        };
        for (const x of [cand.request, cand.quote, ...(cand.accept ? [cand.accept] : []), cand.funded]) this.addMessage(c, x);
        this.log(c, 'case', `request ${cand.request.id.slice(0, 12)} の入金をチェーンで確かめ、案件を開きました`);
        for (const x of p.items) await this.apply(c, x);
        await this.assemble(c);
        await this.s.storage.delete(key);
        await this.save(c);
        return c;
      }
    }
    await this.s.storage.put(key, { ...p, triedAt: nowSeconds() });
    return undefined;
  }

  /** The requests a notice / dispute.open names, each with its quote / accept / funded. */
  private async candidates(item: PendingItem, orderId: string, me: string): Promise<Candidate[]> {
    if (item.type === MSG.escrowNotice) {
      const cand = this.noticeCandidate(item.body as EscrowNotice, orderId, item.from, me);
      return cand && (await verifyRequestKeyProof(innerBodyAs<OrderRequest>(cand.request, MSG.request)!, orderId, cand.user)) ? [cand] : [];
    }
    const inners = (item.body as DisputeOpen).evidence.messages.filter((x) => isValidInner(x) && innerMeta(x).orderId === orderId);
    const out: Candidate[] = [];
    for (const req of await this.validRequests(inners, orderId, me)) {
      const user = req.pubkey;
      const shopper = innerMeta(req).recipient;
      // Only a party of that request may bring it.
      if (item.from !== user && item.from !== shopper) continue;
      const of = (type: string, signer: string) => inners.filter((x) => innerMeta(x).type === type && x.pubkey === signer);
      const quotes = of(MSG.quote, shopper);
      const accept = of(MSG.accept, user).find((a) => quotes.some((q) => q.id === innerBodyAs<OrderAccept>(a, MSG.accept)?.quote_id));
      const quote = accept ? quotes.find((q) => q.id === innerBodyAs<OrderAccept>(accept, MSG.accept)?.quote_id) : quotes.length === 1 ? quotes[0] : undefined;
      const funded = of(MSG.funded, user).sort((a, b) => b.created_at - a.created_at)[0];
      if (quote && funded) out.push({ request: req, quote, accept, funded, user, shopper, fromNotice: false });
    }
    return out;
  }

  /** The four signed parts of a notice, if they are well formed and the notice comes from the request's signer. */
  private noticeCandidate(n: EscrowNotice, orderId: string, from: string, me: string): Candidate | undefined {
    const req = n.request;
    if (!isValidInner(req) || req.pubkey !== from) return undefined;
    const body = innerBodyAs<OrderRequest>(req, MSG.request);
    if (!body || body.escrow !== me) return undefined;
    const shopper = innerMeta(req).recipient;
    const parts = [n.request, n.quote, n.accept, n.funded];
    const types = [MSG.request, MSG.quote, MSG.accept, MSG.funded];
    const signers = [from, shopper, from, from];
    if (!parts.every((x, i) => isValidInner(x) && innerMeta(x).orderId === orderId && innerMeta(x).type === types[i] && x.pubkey === signers[i])) return undefined;
    return { request: n.request, quote: n.quote, accept: n.accept, funded: n.funded, user: from, shopper, fromNotice: true };
  }

  /** Whether a notice / dispute.open carries a request that names us (checked before the messenger stores it). */
  private async namesUs(inner: Inner, type: string): Promise<boolean> {
    const me = await this.s.pubkey();
    const requests = type === MSG.escrowNotice
      ? [innerBodyAs<EscrowNotice>(inner, MSG.escrowNotice)?.request]
      : innerBodyAs<DisputeOpen>(inner, MSG.disputeOpen)?.evidence.messages ?? [];
    return requests.some((x) => x && innerMeta(x).type === MSG.request && innerBodyAs<OrderRequest>(x, MSG.request)?.escrow === me);
  }

  /** The valid, schema-conforming order.requests in `inners` for `orderId` that name us and prove their keys. */
  private async validRequests(inners: Inner[], orderId: string, me: string): Promise<Inner[]> {
    const out: Inner[] = [];
    for (const x of inners) {
      if (!isValidInner(x) || innerMeta(x).orderId !== orderId || innerMeta(x).type !== MSG.request || out.some((y) => y.id === x.id)) continue;
      const req = innerBodyAs<OrderRequest>(x, MSG.request);
      if (req && req.escrow === me && (await verifyRequestKeyProof(req, orderId, x.pubkey))) out.push(x);
    }
    return out;
  }

  /** §4.7 structural checks of a candidate against the chain (fee problems do not block a case). */
  private async chainProblems(orderId: string, cand: Candidate): Promise<string[]> {
    const request = innerBodyAs<OrderRequest>(cand.request, MSG.request);
    const quote = innerBodyAs<OrderQuote>(cand.quote, MSG.quote);
    const funded = innerBodyAs<OrderFunded>(cand.funded, MSG.funded);
    if (!request || !quote || !funded) return ['request, quote or funded does not fit its schema'];
    const problems = await this.orderProblems(orderId, request, quote, funded).catch((err) => [`chain check failed: ${(err as Error).message}`]);
    return problems.filter((p) => !p.startsWith('fee:'));
  }

  /**
   * Derive request / quote / accept / funded from the collected messages (§4.7): the notice's ids, else the
   * chain-checked ones the case was opened with. Other messages of those types are ignored and recorded.
   */
  private async assemble(c: EscrowCase): Promise<void> {
    const of = (type: string, signer?: string) =>
      c.messages.filter((x) => innerMeta(x).type === type && (!signer || x.pubkey === signer));
    const conflicts = new Set(c.conflicts ?? []);
    const pick = (type: string, id: string | undefined): Inner | undefined => {
      const all = of(type);
      for (const x of all) if (x.id !== id) conflicts.add(`${type} ${x.id.slice(0, 12)} differs from the ${c.noticeIds ? 'notice' : 'funded order'}; ignored`);
      return all.find((x) => x.id === id);
    };
    const ids = c.noticeIds ?? c.basis;
    const reqInner = pick(MSG.request, ids?.request);
    const acceptInner = pick(MSG.accept, ids?.accept);
    const quoteInner = pick(MSG.quote, ids?.quote);
    const fundedInner = pick(MSG.funded, ids?.funded);
    c.assembled = { request: reqInner?.id, quote: quoteInner?.id, accept: acceptInner?.id, funded: fundedInner?.id };
    c.request = reqInner && innerBodyAs<OrderRequest>(reqInner, MSG.request);
    c.quote = quoteInner && innerBodyAs<OrderQuote>(quoteInner, MSG.quote);
    c.funded = fundedInner && innerBodyAs<OrderFunded>(fundedInner, MSG.funded);
    if (conflicts.size) c.conflicts = [...conflicts].slice(-CONFLICT_LIMIT);

    // Tracking and purchase evidence from the shopper's own signed messages.
    for (const x of of(MSG.shipping, c.shopper)) {
      const t = innerBodyAs<{ tracking: TrackingStatus }>(x, MSG.shipping)?.tracking;
      if (t && !c.tracking.some((y) => JSON.stringify(y) === JSON.stringify(t))) c.tracking.push(t);
    }
    for (const x of of(MSG.purchased, c.shopper)) {
      for (const e of innerBodyAs<{ evidence: Evidence[] }>(x, MSG.purchased)?.evidence ?? []) {
        const known = c.purchaseEvidence.findIndex((y) => y.sha256 === e.sha256);
        if (known < 0) c.purchaseEvidence.push(e);
        // The signed message carries the inline data; a dispute body lists the item without it (§4.9).
        else if (e.data_b64 && !c.purchaseEvidence[known].data_b64) c.purchaseEvidence[known] = e;
      }
    }
    // The user's signed order.escrow_key is evidence of the key too.
    for (const x of of(MSG.escrowKey, c.user)) {
      const k = innerBodyAs<OrderEscrowKey>(x, MSG.escrowKey);
      if (k) this.offerDeliveryKey(c, k.key_for_escrow);
    }
  }

  private conflict(c: EscrowCase, text: string): void {
    const list = (c.conflicts ??= []);
    if (!list.includes(text)) list.push(text);
    if (list.length > CONFLICT_LIMIT) list.splice(0, list.length - CONFLICT_LIMIT);
    this.log(c, 'conflict', text);
  }

  /** Accept a key_for_escrow only if the signed request commits to it (§4.4). */
  private offerDeliveryKey(c: EscrowCase, key: string, from?: string): void {
    if (c.deliveryKeyForEscrow) return;
    const id = (c.noticeIds ?? c.basis)?.request;
    const reqInner = c.messages.find((x) => innerMeta(x).type === MSG.request && x.pubkey === c.user && x.id === id);
    const req = reqInner && innerBodyAs<OrderRequest>(reqInner, MSG.request);
    if (req && keyForEscrowSha256(key) === req.delivery.key_for_escrow_sha256) c.deliveryKeyForEscrow = key;
    else if (from) this.log(c, 'delivery', `${this.who(c, from)} の届け先の鍵は request の SHA-256 と合わないので捨てました`);
  }

  private addMessage(c: EscrowCase, inner: Inner): void {
    if (innerMeta(inner).orderId !== c.orderId || c.messages.length >= MESSAGE_LIMIT) return;
    if (!c.messages.some((m) => m.id === inner.id)) c.messages.push(inner);
  }

  /** Keep one attachment chunk; join and verify once all arrived. Chunks may come before the evidence naming them. */
  private addChunk(c: EscrowCase, a: Attachment, from: string): void {
    if (!(a.total > 0 && a.total <= 256 && a.index >= 0 && a.index < a.total)) return;
    const all = (c.attachments ??= {});
    const at = all[a.sha256] ?? (Object.keys(all).length < 16 ? (all[a.sha256] = { mime: a.mime, total: a.total, chunks: {} }) : undefined);
    if (!at || at.dataB64 || at.total !== a.total) return;
    at.chunks![a.index] = a.data_b64;
    if (Object.keys(at.chunks!).length < at.total) return;
    const parts = Array.from({ length: at.total }, (_, i) => base64.decode(at.chunks![i]));
    const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((off, p) => (data.set(p, off), off + p.length), 0);
    if (toHex(sha256(data)) !== a.sha256) {
      delete all[a.sha256];
      this.log(c, MSG.attachment, `${this.who(c, from)} の添付 ${a.sha256.slice(0, 12)} はハッシュが一致しないので捨てました`);
      return;
    }
    all[a.sha256] = { mime: at.mime, total: at.total, dataB64: base64.encode(data) };
    this.log(c, MSG.attachment, `${this.who(c, from)} から添付 ${a.mime}（${data.length} byte）を受け取りました`);
  }

  // ---------- verification ----------

  /** §4.7 checks against the chain; fills c.verification and c.obligation. Fee problems are prefixed "fee:". */
  private async verify(c: EscrowCase): Promise<void> {
    const checkedAt = nowSeconds();
    const { request, quote, funded } = c;
    const problems: string[] = [];
    if (!request || !quote || !funded || !c.user || !c.shopper) problems.push('request, quote or funded is missing');
    else if (!(await verifyRequestKeyProof(request, c.orderId, c.user))) problems.push('key_proof does not verify');
    else problems.push(...await this.orderProblems(c.orderId, request, quote, funded));
    c.verification = { ok: problems.length === 0, problems, checkedAt };
    const feeProblems = problems.filter((p) => p.startsWith('fee:'));
    c.obligation = problems.length === 0
      ? { paid: true, detail: `upfront fee ${quote!.escrow_upfront_fee} received`, checkedAt }
      : { paid: false, detail: (feeProblems.length ? feeProblems : problems).join('; '), checkedAt };
    if (c.obligation.paid) await this.markFeeUsed(c);
  }

  /** Every §4.7 problem of an order (structural ones, and "fee:" ones that only affect the obligation). */
  private async orderProblems(orderId: string, request: OrderRequest, quote: OrderQuote, funded: OrderFunded): Promise<string[]> {
    const problems = request.payment === 'btc-signet'
      ? await this.verifyBtc(orderId, request, quote, funded)
      : await this.verifyUsdc(orderId, request, quote, funded);
    return [...problems, ...await this.feeTermsProblems(request, quote)];
  }

  /**
   * §4.7: we owe a ruling only if the quoted upfront fee is above 0, at least our own max(bps × lock, min),
   * and paid as §4.6 says (the payment itself is checked per asset).
   */
  private async feeTermsProblems(request: OrderRequest, quote: OrderQuote): Promise<string[]> {
    const fee = parseUnits(quote.escrow_upfront_fee ?? '0');
    if (fee === 0n) return ['fee: quote carried no upfront fee'];
    const terms = await this.terms();
    if (!terms) return ['fee: our escrow profile is not published, so the upfront minimum is unknown'];
    const min = escrowUpfrontMinimum({ ...this.profileContent({ name: '', ...terms }) }, request.payment, parseUnits(quote.lock_amount!));
    return fee < min ? [`fee: quoted upfront fee ${fee} is below our minimum ${min}`] : [];
  }

  private async verifyBtc(orderId: string, request: OrderRequest, quote: OrderQuote, funded: OrderFunded): Promise<string[]> {
    if (funded.asset !== 'btc-signet') return ['funded asset differs from the request'];
    if (!this.s.chain) return ['no BTC chain API'];
    const problems: string[] = [];
    const myKey = toHex(this.s.keys.escrowOrderKey(orderId).publicKey);
    if (quote.escrow_btc_pubkey !== myKey) return ['quote escrow key is not ours'];
    // The upfront fee must have gone to our wallet; a quote naming another address is not one we took part in.
    if (quote.escrow_btc_fee_address !== this.s.keys.btcWallet.address) problems.push('quote escrow_btc_fee_address is not our wallet address');
    let script: Uint8Array;
    try {
      script = witnessScript(this.escrowKeys(request, quote), quote.timelock!.t1, quote.timelock!.t2);
    } catch (err) {
      return [`cannot rebuild the escrow script: ${(err as Error).message}`];
    }
    if (p2wshAddress(script) !== quote.escrow_address) problems.push('quote escrow_address is not the P2WSH of request + quote');
    const tx = Transaction.fromRaw(fromHex(await this.s.chain.txHex(funded.txid)), { allowUnknownOutputs: true });
    if (tx.id !== funded.txid) return [...problems, 'esplora returned a different transaction'];
    const out = funded.vout < tx.outputsLength ? tx.getOutput(funded.vout) : undefined;
    const lock = parseUnits(quote.lock_amount!);
    if (!out?.script || toHex(out.script) !== toHex(p2wshOutputScript(script)) || out.amount !== lock) {
      problems.push('the funded output is not the escrow P2WSH with lock_amount');
    }
    // §4.6: the upfront fee is an output of the same funding transaction.
    const required = parseUnits(quote.escrow_upfront_fee ?? '0');
    const target = toHex(addressToScript(this.s.keys.btcWallet.address));
    let paid = 0n;
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i);
      if (o.script && toHex(o.script) === target) paid += o.amount ?? 0n;
    }
    if (funded.fee_txid && funded.fee_txid !== funded.txid) problems.push('fee: the upfront fee is not in the funding transaction');
    if (required > 0n && paid < required) problems.push(`fee: ${paid} sats to ${this.s.keys.btcWallet.address}, ${required} required`);
    problems.push(...await this.feeReuse(orderId, `btc:${funded.txid}`));
    return problems;
  }

  private async verifyUsdc(orderId: string, request: OrderRequest, quote: OrderQuote, funded: OrderFunded): Promise<string[]> {
    if (funded.asset !== 'usdc-evm') return ['funded asset differs from the request'];
    const evm = this.s.evm;
    if (!evm) return ['no EVM client'];
    const d = this.deployments();
    const problems: string[] = [];
    const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
    if (!same(quote.escrow_evm_address, this.s.keys.evmAddress)) return ['quote escrow EVM address is not ours'];
    const t = quote.timelock!;
    const params = {
      user: request.user_evm_address as `0x${string}`, shopper: quote.shopper_evm_address as `0x${string}`,
      escrow: this.s.keys.evmAddress, t1: BigInt(t.t1), t2: BigInt(t.t2), orderId,
    };
    let code: Hex;
    try {
      code = knownProxyCreationCode(await evm.proxyCreationCode());
    } catch (err) {
      return [`cannot predict the Safe: ${(err as Error).message}`];
    }
    const predicted = orderSafeAddress(d, params, code);
    if (!same(predicted, funded.safe) || !same(predicted, quote.escrow_address)) problems.push('funded Safe is not the address predicted from request + quote');
    try {
      const st = await evm.safeState(funded.safe as `0x${string}`);
      const owners = st.owners.map((x) => x.toLowerCase());
      if (owners.join() !== [params.user, params.shopper, params.escrow].map((x) => x.toLowerCase()).join()) problems.push('Safe owners are not [user, shopper, escrow]');
      if (st.threshold !== 2n) problems.push(`Safe threshold is ${st.threshold}, not 2`);
      if (!st.moduleEnabled) problems.push('the escrow module is not enabled on the Safe');
      const cfg = st.config;
      if (!same(cfg.token, d.usdc) || !same(cfg.user, params.user) || !same(cfg.shopper, params.shopper) || cfg.t1 !== params.t1 || cfg.t2 !== params.t2) {
        problems.push('the module configuration of the Safe differs from the quote');
      }
      // Funded = fund_tx moved lock_amount from the user into the Safe (the balance may be paid out by now).
      const fundedIn = await evm.usdcTransferredIn(funded.fund_tx as Hex, funded.safe as `0x${string}`, params.user).catch(() => 0n);
      if (fundedIn < parseUnits(quote.lock_amount!)) problems.push(`fund_tx moved ${fundedIn} into the Safe, less than lock_amount`);
    } catch (err) {
      problems.push(`cannot read the Safe: ${(err as Error).message}`);
    }
    // §4.6: fee_tx is a USDC transfer from user_evm_address to us.
    const required = parseUnits(quote.escrow_upfront_fee ?? '0');
    if (required > 0n) {
      if (!funded.fee_tx) problems.push('fee: no fee_tx');
      else {
        const paid = await evm.usdcTransferredIn(funded.fee_tx as Hex, this.s.keys.evmAddress, params.user).catch(() => 0n);
        if (paid < required) problems.push(`fee: ${paid} USDC units from the user to ${this.s.keys.evmAddress}, ${required} required`);
        problems.push(...await this.feeReuse(orderId, `usdc:${funded.fee_tx.toLowerCase()}`));
      }
    }
    return problems;
  }

  /** §4.6: the same upfront fee payment cannot back two orders. */
  private async feeReuse(orderId: string, key: string): Promise<string[]> {
    const used = await this.s.storage.get<string>(FEE_USED + key);
    return used && used !== orderId ? [`fee: upfront fee already used by order ${used}`] : [];
  }

  private async markFeeUsed(c: EscrowCase): Promise<void> {
    const f = c.funded;
    if (!f) return;
    const key = f.asset === 'btc-signet' ? `btc:${f.txid}` : `usdc:${f.fee_tx.toLowerCase()}`;
    if (!(await this.s.storage.get<string>(FEE_USED + key))) await this.s.storage.put(FEE_USED + key, c.orderId);
  }

  private async checkSettlement(c: EscrowCase): Promise<void> {
    const claim = c.pendingSettlement;
    if (!claim || !c.funded || !c.quote?.lock_amount) return;
    const res = await escrowSpent({ chain: this.s.chain, evm: this.s.evm, funded: c.funded, lock: parseUnits(c.quote.lock_amount), claimedTx: claim.txid });
    if (!res.spent) return;
    c.settledTxid = res.txid ?? claim.txid;
    c.pendingSettlement = undefined;
    c.status = 'settled';
    this.log(c, MSG.countersigned, `精算をチェーンで確認しました (${c.settledTxid})`);
  }

  /** Re-check settlement claims, and orders whose notice / dispute did not check out on chain yet. */
  private async poll(): Promise<void> {
    for (const c of await this.listCases()) {
      if (c.pendingSettlement) await this.verifySettlement(c.orderId).catch(() => undefined);
    }
    const now = nowSeconds();
    for (const [key, p] of await this.s.storage.list<Pending>(PENDING)) {
      if (now - p.firstAt > PENDING_KEEP_SECONDS) await this.s.storage.delete(key);
      else if (now - p.triedAt >= PENDING_RETRY_SECONDS) {
        await this.lock.run(p.orderId, async () => {
          if (!(await this.getCase(p.orderId))) await this.openFromPending(p.orderId);
        }).catch(() => undefined);
      }
    }
  }

  private escrowKeys(request: OrderRequest, quote: OrderQuote): EscrowKeys {
    return {
      user: fromHex(request.user_btc_pubkey!),
      shopper: fromHex(quote.shopper_btc_pubkey!),
      escrow: fromHex(quote.escrow_btc_pubkey!),
    };
  }

  private deployments(): Deployments {
    const d = this.opts.deployments ?? this.s.evm?.deployments;
    if (!d) throw new Error('EVM deployments unknown');
    return d;
  }

  private evm() {
    if (!this.s.evm) throw new Error('no EVM client configured');
    return this.s.evm;
  }

  private who(c: EscrowCase, pk: string): string {
    return pk === c.user ? 'user' : pk === c.shopper ? 'shopper' : pk.slice(0, 8);
  }

  private log(c: EscrowCase, kind: string, text: string): void {
    c.timeline.push({ at: nowSeconds(), kind, text });
  }

  private async require(orderId: string): Promise<EscrowCase> {
    const c = await this.getCase(orderId);
    if (!c) throw new Error(`unknown case ${orderId}`);
    return c;
  }

  private async save(c: EscrowCase): Promise<void> {
    c.updatedAt = nowSeconds();
    await this.s.storage.put(PREFIX + c.orderId, c);
    this.emit('case', c);
  }

  private mutate(orderId: string, fn: (c: EscrowCase) => Promise<void>): Promise<EscrowCase> {
    return this.lock.run(orderId, async () => {
      const c = await this.require(orderId);
      await fn(c);
      await this.save(c);
      return c;
    });
  }
}

/** Integrity of an evidence item: inline data must hash to its sha256 (§4.9). */
export function evidenceIntegrity(e: Evidence): 'ok' | 'mismatch' | 'no-data' {
  if (!e.data_b64) return 'no-data';
  try {
    return toHex(sha256(base64.decode(e.data_b64))) === e.sha256 ? 'ok' : 'mismatch';
  } catch {
    return 'mismatch';
  }
}
