import type { Hex } from 'viem';
import { Transaction } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { addressToScript, p2wshAddress, p2wshOutputScript, witnessScript, type EscrowKeys } from '../btc/script.js';
import { buildEscrowSpend, psbtToBase64, signEscrowInput } from '../btc/spend.js';
import { decryptAddress, keyForEscrowSha256, unwrapDeliveryKey } from '../delivery/delivery.js';
import type { Deployments } from '../evm/deployments.js';
import { SAFE_PROXY_CREATION_CODE } from '../evm/proxy-creation-code.js';
import { orderSafeAddress } from '../evm/safe.js';
import { safeTxToJson, signSafeTx, splitSafeTx } from '../evm/safetx.js';
import { verifyRequestKeyProof } from '../keys/proof.js';
import { innerMeta, isValidInner, type Inner } from '../nostr/giftwrap.js';
import type { IncomingMessage } from '../nostr/messenger.js';
import {
  MSG, type Address, type Attachment, type DisputeEvidence, type DisputeOpen, type DisputeRuling, type EscrowNotice, type Evidence,
  type OrderAccept, type OrderEscrowKey, type OrderFunded, type OrderQuote, type OrderRequest, type Split, type TrackingStatus,
} from '../nostr/messages.js';
import { innerBodyAs } from '../nostr/schema.js';
import { escrowProfileTemplate } from '../trust/events.js';
import type { EscrowProfileContent } from '../trust/types.js';
import { KIND } from '../nostr/kinds.js';
import { fromHex, toHex } from '../util/bytes.js';
import { parseUnits } from '../util/decimal.js';
import { Emitter } from '../util/emitter.js';
import { KeyedMutex, nowSeconds } from '../util/time.js';
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

export interface EscrowCase {
  orderId: string;
  status: CaseStatus;
  createdAt: number;
  updatedAt: number;
  /** Who made us open this case (limits cases per sender). */
  createdBy?: string;
  /** Signer of the order.request (with a valid key_proof). */
  user?: string;
  /** Recipient of the order.request. */
  shopper?: string;
  request?: OrderRequest;
  quote?: OrderQuote;
  funded?: OrderFunded;
  /** Inner ids from escrow.notice; when present they define the order (§4.7). */
  noticeIds?: { request: string; quote: string; accept: string; funded: string };
  /** The order's parts as assembled: inner ids of request / quote / accept / funded. */
  assembled?: { request?: string; quote?: string; accept?: string; funded?: string };
  /** Set when the case cannot be ruled, e.g. two different requests without a notice. */
  rejected?: string;
  /** Evidence that contradicted the notice (ignored, but recorded). */
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

type Events = {
  case: EscrowCase;
  error: { orderId?: string; error: Error };
};

const PREFIX = 'escrow/cases/';
const FEE_USED = 'escrow/fee-used/';
/** Cases one sender can open with us (spam bound). */
const MAX_CASES_PER_SENDER = 50;
const MESSAGE_LIMIT = 500;

/**
 * Browser escrow (§3.2, §4.7, §4.8): collects evidence, decrypts the delivery
 * address, checks the order and upfront fee on chain and signs a split.
 */
export class EscrowClient extends Emitter<Events> {
  private readonly lock = new KeyedMutex();
  private unsubscribe?: () => void;
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
    await this.s.publishInboxRelays();
    return res;
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

  /**
   * Sign a split and send dispute.ruling to both parties. `escrow_fee` defaults
   * to whatever user + shopper leave of the distributable balance.
   */
  async rule(orderId: string, split: { user: string; shopper: string; escrow_fee?: string }, reason: string): Promise<EscrowCase> {
    return this.mutate(orderId, async (c) => {
      const { request, quote, funded } = c;
      if (c.rejected) throw new Error(`case refused: ${c.rejected}`);
      if (!request || !quote || !funded || !c.user || !c.shopper) throw new Error('case lacks request/quote/funded evidence');
      if (!c.disputes.length) throw new Error('no dispute has been opened');
      // §4.8: one ruling per dispute — a second signed split would conflict with the first.
      if (c.ruling) throw new Error('already ruled');
      await this.verify(c);
      const structural = c.verification!.problems.filter((p) => !p.startsWith('fee:'));
      if (structural.length) throw new Error(`order does not check out on chain: ${structural.join('; ')}`);
      const lock = parseUnits(quote.lock_amount!);
      const reserve = request.payment === 'btc-signet' ? parseUnits(quote.payout_fee_reserve ?? '0') : 0n;
      const distributable = lock - reserve;
      const user = parseUnits(split.user);
      const shopper = parseUnits(split.shopper);
      const fee = split.escrow_fee !== undefined ? parseUnits(split.escrow_fee) : distributable - user - shopper;
      if (fee < 0n || user + shopper + fee !== distributable) {
        throw new Error(`split must add up to ${distributable} (got ${user + shopper + fee})`);
      }
      const finalSplit: Split = { user: user.toString(), shopper: shopper.toString(), escrow_fee: fee.toString() };
      const ruling: DisputeRuling = { split: finalSplit, reason, asset: request.payment };
      if (!c.obligation!.paid) ruling.no_obligation = true;

      if (request.payment === 'btc-signet') {
        const f = funded as Extract<OrderFunded, { asset: 'btc-signet' }>;
        const myKey = this.s.keys.escrowOrderKey(orderId);
        const tx = buildEscrowSpend({
          outpoint: { txid: f.txid, vout: f.vout ?? 0, amount: lock },
          witnessScript: witnessScript(this.escrowKeys(request, quote), quote.timelock!.t1, quote.timelock!.t2),
          outputs: [
            { address: request.user_btc_address!, amount: user },
            { address: quote.shopper_btc_address!, amount: shopper },
            { address: quote.escrow_btc_fee_address!, amount: fee },
          ],
        });
        signEscrowInput(tx, myKey.privateKey);
        ruling.psbt = psbtToBase64(tx);
      } else {
        const f = funded as Extract<OrderFunded, { asset: 'usdc-evm' }>;
        const d = this.deployments();
        const safe = f.safe as `0x${string}`;
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
      await this.s.messenger.send(c.user, orderId, MSG.ruling, ruling);
      await this.s.messenger.send(c.shopper, orderId, MSG.ruling, ruling);
      c.ruling = ruling;
      c.status = 'ruled';
      this.log(c, MSG.ruling, `裁定しました: user ${finalSplit.user} / shopper ${finalSplit.shopper} / fee ${finalSplit.escrow_fee}`);
    });
  }

  // ---------- incoming ----------

  private async onMessage(m: IncomingMessage): Promise<void> {
    if (![MSG.escrowNotice, MSG.disputeOpen, MSG.evidence, MSG.countersigned, MSG.attachment].includes(m.type as never)) return;
    const me = await this.s.pubkey();

    await this.lock.run(m.orderId, async () => {
      let c = await this.getCase(m.orderId);
      if (!c) {
        // Only a notice or dispute that carries a valid request naming us, from one of its parties, opens a case.
        if (m.type !== MSG.escrowNotice && m.type !== MSG.disputeOpen) return;
        const embedded = m.type === MSG.escrowNotice ? [(m.body as EscrowNotice).request] : (m.body as DisputeOpen).evidence.messages;
        const req = await this.findValidRequest(embedded, m.orderId, me);
        if (!req || (m.from !== req.pubkey && m.from !== innerMeta(req).recipient)) return;
        if (m.type === MSG.escrowNotice && m.from !== req.pubkey) return; // notices come from the user
        if ((await this.casesOpenedBy(m.from)) >= MAX_CASES_PER_SENDER) return;
        const now = nowSeconds();
        c = {
          orderId: m.orderId, status: 'notice', createdAt: now, updatedAt: now, createdBy: m.from,
          user: req.pubkey, shopper: innerMeta(req).recipient, disputes: [], messages: [], tracking: [], purchaseEvidence: [], timeline: [],
        };
      }
      // Only the order's two parties talk to us about it.
      if (m.from !== c.user && m.from !== c.shopper) return;
      const before = JSON.stringify(c);

      if (m.type === MSG.attachment) {
        this.addChunk(c, m.body as Attachment, m.from);
      } else if (m.type === MSG.escrowNotice) {
        if (m.from !== c.user) return;
        const n = m.body as EscrowNotice;
        const parts = [n.request, n.quote, n.accept, n.funded];
        const types = [MSG.request, MSG.quote, MSG.accept, MSG.funded];
        const signers = [c.user, c.shopper, c.user, c.user];
        if (!parts.every((x, i) => isValidInner(x) && innerMeta(x).orderId === c!.orderId && innerMeta(x).type === types[i] && x.pubkey === signers[i])) {
          this.log(c, m.type, '入金の通知の署名や差出人が合わないので無視しました');
        } else if (c.noticeIds) {
          this.log(c, m.type, '2 通目の入金の通知は無視しました');
        } else {
          this.addMessage(c, m.inner);
          for (const x of parts) this.addMessage(c, x);
          c.noticeIds = { request: n.request.id, quote: n.quote.id, accept: n.accept.id, funded: n.funded.id };
          this.log(c, m.type, '入金の通知を受けました');
        }
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
        await this.checkSettlement(c).catch((err) => this.log(c!, m.type, `チェーンの確認に失敗: ${(err as Error).message}`));
      }

      await this.assemble(c);
      if (JSON.stringify(c) === before) return;
      await this.save(c);
    });
  }

  /** The first valid, schema-conforming order.request in `inners` for `orderId` that names us and proves its keys. */
  private async findValidRequest(inners: Inner[], orderId: string, me: string): Promise<Inner | undefined> {
    for (const x of inners) {
      if (!isValidInner(x) || innerMeta(x).orderId !== orderId || innerMeta(x).type !== MSG.request) continue;
      const req = innerBodyAs<OrderRequest>(x, MSG.request);
      if (req && req.escrow === me && (await verifyRequestKeyProof(req, orderId, x.pubkey))) return x;
    }
    return undefined;
  }

  private async casesOpenedBy(sender: string): Promise<number> {
    return (await this.listCases()).filter((c) => c.createdBy === sender).length;
  }

  /**
   * Derive request / quote / accept / funded from the collected messages (§4.7): notice ids win;
   * without a notice, two different requests refuse the case; the quote is the accepted one.
   */
  private async assemble(c: EscrowCase): Promise<void> {
    const of = (type: string, signer?: string) =>
      c.messages.filter((x) => innerMeta(x).type === type && (!signer || x.pubkey === signer));
    const conflicts = new Set(c.conflicts ?? []);
    const pick = (type: string, signer: string | undefined, noticeId: string | undefined, prefer?: string): Inner | undefined => {
      const all = of(type, signer);
      if (noticeId) {
        for (const x of all) if (x.id !== noticeId) conflicts.add(`${type} ${x.id.slice(0, 12)} differs from the notice; ignored`);
        return all.find((x) => x.id === noticeId);
      }
      return all.find((x) => x.id === prefer) ?? all[0];
    };
    // Without a notice, two different requests for one order id mean we cannot tell which is real.
    const requests = new Set(of(MSG.request).map((x) => x.id));
    c.rejected = !c.noticeIds && requests.size > 1 ? 'two different order.request messages for this order' : undefined;
    const reqInner = pick(MSG.request, c.user, c.noticeIds?.request);
    const acceptInner = pick(MSG.accept, c.user, c.noticeIds?.accept);
    const accept = acceptInner && innerBodyAs<OrderAccept>(acceptInner, MSG.accept);
    const quoteInner = pick(MSG.quote, c.shopper, c.noticeIds?.quote, accept?.quote_id);
    const fundedInner = pick(MSG.funded, c.user, c.noticeIds?.funded);
    c.assembled = { request: reqInner?.id, quote: quoteInner?.id, accept: acceptInner?.id, funded: fundedInner?.id };
    c.request = reqInner && innerBodyAs<OrderRequest>(reqInner, MSG.request);
    c.quote = quoteInner && innerBodyAs<OrderQuote>(quoteInner, MSG.quote);
    c.funded = fundedInner && innerBodyAs<OrderFunded>(fundedInner, MSG.funded);
    if (conflicts.size) c.conflicts = [...conflicts];

    // Tracking and purchase evidence from the shopper's own signed messages.
    for (const x of of(MSG.shipping, c.shopper)) {
      const t = innerBodyAs<{ tracking: TrackingStatus }>(x, MSG.shipping)?.tracking;
      if (t && !c.tracking.some((y) => JSON.stringify(y) === JSON.stringify(t))) c.tracking.push(t);
    }
    for (const x of of(MSG.purchased, c.shopper)) {
      for (const e of innerBodyAs<{ evidence: Evidence[] }>(x, MSG.purchased)?.evidence ?? []) {
        if (!c.purchaseEvidence.some((y) => y.sha256 === e.sha256)) c.purchaseEvidence.push(e);
      }
    }
    // The user's signed order.escrow_key is evidence of the key too.
    for (const x of of(MSG.escrowKey, c.user)) {
      const k = innerBodyAs<OrderEscrowKey>(x, MSG.escrowKey);
      if (k) this.offerDeliveryKey(c, k.key_for_escrow);
    }
  }

  /** Accept a key_for_escrow only if the signed request commits to it (§4.4). */
  private offerDeliveryKey(c: EscrowCase, key: string, from?: string): void {
    if (c.deliveryKeyForEscrow) return;
    const reqInner = c.messages.find((x) => innerMeta(x).type === MSG.request && x.pubkey === c.user && (!c.noticeIds || x.id === c.noticeIds.request));
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
    const problems: string[] = [];
    const { request, quote, funded } = c;
    if (c.rejected) problems.push(c.rejected);
    if (!request || !quote || !funded || !c.user || !c.shopper) problems.push('request, quote or funded is missing');
    else if (!(await verifyRequestKeyProof(request, c.orderId, c.user))) problems.push('key_proof does not verify');
    else if (request.payment === 'btc-signet') problems.push(...await this.verifyBtc(c, request, quote, funded));
    else problems.push(...await this.verifyUsdc(c, request, quote, funded));
    c.verification = { ok: problems.length === 0, problems, checkedAt };
    const feeProblems = problems.filter((p) => p.startsWith('fee:'));
    c.obligation = problems.length === 0
      ? { paid: true, detail: `upfront fee ${quote!.escrow_upfront_fee} received`, checkedAt }
      : { paid: false, detail: (feeProblems.length ? feeProblems : problems).join('; '), checkedAt };
    if (c.obligation.paid) await this.markFeeUsed(c);
  }

  private async verifyBtc(c: EscrowCase, request: OrderRequest, quote: OrderQuote, funded: OrderFunded): Promise<string[]> {
    if (funded.asset !== 'btc-signet') return ['funded asset differs from the request'];
    if (!this.s.chain) return ['no BTC chain API'];
    const problems: string[] = [];
    const myKey = toHex(this.s.keys.escrowOrderKey(c.orderId).publicKey);
    if (quote.escrow_btc_pubkey !== myKey) return ['quote escrow key is not ours'];
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
    if (required === 0n) problems.push('fee: quote carried no upfront fee');
    else if (paid < required) problems.push(`fee: ${paid} sats to ${this.s.keys.btcWallet.address}, ${required} required`);
    problems.push(...await this.feeReuse(c, `btc:${funded.txid}`));
    return problems;
  }

  private async verifyUsdc(c: EscrowCase, request: OrderRequest, quote: OrderQuote, funded: OrderFunded): Promise<string[]> {
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
      escrow: this.s.keys.evmAddress, t1: BigInt(t.t1), t2: BigInt(t.t2), orderId: c.orderId,
    };
    const predicted = orderSafeAddress(d, params, SAFE_PROXY_CREATION_CODE);
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
    if (required === 0n) problems.push('fee: quote carried no upfront fee');
    else if (!funded.fee_tx) problems.push('fee: no fee_tx');
    else {
      const paid = await evm.usdcTransferredIn(funded.fee_tx as Hex, this.s.keys.evmAddress, params.user).catch(() => 0n);
      if (paid < required) problems.push(`fee: ${paid} USDC units from the user to ${this.s.keys.evmAddress}, ${required} required`);
      problems.push(...await this.feeReuse(c, `usdc:${funded.fee_tx.toLowerCase()}`));
    }
    return problems;
  }

  /** §4.6: the same upfront fee payment cannot back two orders. */
  private async feeReuse(c: EscrowCase, key: string): Promise<string[]> {
    const used = await this.s.storage.get<string>(FEE_USED + key);
    return used && used !== c.orderId ? [`fee: upfront fee already used by order ${used}`] : [];
  }

  private async markFeeUsed(c: EscrowCase): Promise<void> {
    const f = c.funded;
    if (!f) return;
    const key = f.asset === 'btc-signet' ? `btc:${f.txid}` : `usdc:${f.fee_tx.toLowerCase()}`;
    if (!(await this.s.storage.get<string>(FEE_USED + key))) await this.s.storage.put(FEE_USED + key, c.orderId);
  }

  private async checkSettlement(c: EscrowCase): Promise<void> {
    const claim = c.pendingSettlement;
    if (!claim || !c.funded) return;
    const res = await escrowSpent({ chain: this.s.chain, evm: this.s.evm, funded: c.funded, claimedTx: claim.txid });
    if (!res.spent) return;
    c.settledTxid = res.txid ?? claim.txid;
    c.pendingSettlement = undefined;
    c.status = 'settled';
    this.log(c, MSG.countersigned, `精算をチェーンで確認しました (${c.settledTxid})`);
  }

  private async pollSettlements(): Promise<void> {
    for (const c of await this.listCases()) {
      if (c.pendingSettlement) await this.verifySettlement(c.orderId).catch(() => undefined);
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
