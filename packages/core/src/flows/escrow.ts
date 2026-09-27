import type { Hex } from 'viem';
import { Transaction } from '@scure/btc-signer';
import { addressToScript, witnessScript, type EscrowKeys } from '../btc/script.js';
import { buildEscrowSpend, psbtToBase64, signEscrowInput } from '../btc/spend.js';
import { decryptAddress, unwrapDeliveryKey } from '../delivery/delivery.js';
import type { Deployments } from '../evm/deployments.js';
import { safeTxToJson, signSafeTx, splitSafeTx } from '../evm/safetx.js';
import { innerBody, innerMeta, isValidInner, type Inner } from '../nostr/giftwrap.js';
import type { IncomingMessage } from '../nostr/messenger.js';
import {
  MSG, type Address, type Attachment, type DisputeEvidence, type DisputeOpen, type DisputeRuling, type EscrowNotice, type Evidence,
  type OrderFunded, type OrderQuote, type OrderRequest, type Split, type TrackingStatus,
} from '../nostr/messages.js';
import { escrowProfileTemplate } from '../trust/events.js';
import type { EscrowProfileContent } from '../trust/types.js';
import { KIND } from '../nostr/kinds.js';
import { base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { fromHex, toHex } from '../util/bytes.js';
import { parseUnits } from '../util/decimal.js';
import { Emitter } from '../util/emitter.js';
import { KeyedMutex, nowSeconds } from '../util/time.js';
import type { Session } from './session.js';
import type { TimelineEntry } from './user.js';

export type CaseStatus = 'notice' | 'open' | 'ruled' | 'settled';

export interface Obligation {
  paid: boolean;
  detail: string;
  checkedAt: number;
}

export interface EscrowCase {
  orderId: string;
  status: CaseStatus;
  createdAt: number;
  updatedAt: number;
  user?: string;
  shopper?: string;
  request?: OrderRequest;
  quote?: OrderQuote;
  funded?: OrderFunded;
  disputes: Array<{ from: string; body: DisputeOpen; at: number }>;
  /** Verified signed inners collected from all parties, deduplicated by id. */
  messages: Inner[];
  tracking: TrackingStatus[];
  purchaseEvidence: Evidence[];
  /** Full evidence items by sha256, received in chunks (§4.9); dataB64 is set once complete and verified. */
  attachments?: Record<string, { mime: string; total: number; chunks?: Record<number, string>; dataB64?: string }>;
  deliveryKeyForEscrow?: string;
  deliveryCiphertext?: string;
  obligation?: Obligation;
  ruling?: DisputeRuling;
  settledTxid?: string;
  timeline: TimelineEntry[];
}

type Events = {
  case: EscrowCase;
  error: { orderId?: string; error: Error };
};

const PREFIX = 'escrow/cases/';

/**
 * Browser escrow (§3.2, §4.7, §4.8): collects evidence, decrypts the delivery
 * address, checks the upfront fee on chain and signs a split.
 */
export class EscrowClient extends Emitter<Events> {
  private readonly lock = new KeyedMutex();
  private unsubscribe?: () => void;

  constructor(
    private readonly s: Session,
    private readonly opts: { deployments?: Deployments } = {},
  ) {
    super();
  }

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

  /** Decrypt the delivery address with key_for_escrow (§4.4). */
  async decryptAddress(orderId: string): Promise<Address> {
    const c = await this.require(orderId);
    const wrapped = c.deliveryKeyForEscrow ?? c.request?.delivery.key_for_escrow;
    const ct = c.deliveryCiphertext ?? c.request?.delivery.ciphertext;
    if (!wrapped || !ct || !c.user) throw new Error('delivery key or ciphertext not received yet');
    const key = await unwrapDeliveryKey(this.s.signer, c.user, wrapped);
    return decryptAddress(key, orderId, ct);
  }

  /** Verify the upfront fee reached us on chain; without it we owe no ruling (§3.2). */
  async checkObligation(orderId: string): Promise<Obligation> {
    return this.mutate(orderId, async (c) => {
      c.obligation = await this.verifyUpfrontFee(c);
      this.log(c, 'obligation', c.obligation.paid ? '前払い手数料を確認しました' : `前払い手数料なし: ${c.obligation.detail}`);
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
    if (!c.deliveryKeyForEscrow && !c.request?.delivery.key_for_escrow) want.push('delivery_key_for_escrow');
    return want;
  }

  /**
   * Sign a split and send dispute.ruling to both parties. `escrow_fee` defaults
   * to whatever user + shopper leave of the distributable balance.
   */
  async rule(orderId: string, split: { user: string; shopper: string; escrow_fee?: string }, reason: string): Promise<EscrowCase> {
    return this.mutate(orderId, async (c) => {
      const { request, quote, funded } = c;
      if (!request || !quote || !funded || !c.user || !c.shopper) throw new Error('case lacks request/quote/funded evidence');
      c.obligation ??= await this.verifyUpfrontFee(c).catch((e) => ({ paid: false, detail: (e as Error).message, checkedAt: nowSeconds() }));
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
      if (!c.obligation.paid) ruling.no_obligation = true;

      if (request.payment === 'btc-signet') {
        const f = funded as Extract<OrderFunded, { asset: 'btc-signet' }>;
        const myKey = this.s.keys.escrowOrderKey(orderId);
        if (quote.escrow_btc_pubkey !== toHex(myKey.publicKey)) throw new Error('quote escrow key is not ours');
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
        const tx = splitSafeTx({
          usdc: d.usdc,
          multiSend: d.safe.multisend_call_only,
          payouts: [
            { to: request.user_evm_address as `0x${string}`, amount: user },
            { to: quote.shopper_evm_address as `0x${string}`, amount: shopper },
            { to: this.s.keys.evmAddress, amount: fee },
          ],
        });
        ruling.safe_tx = safeTxToJson(tx);
        ruling.signature = await signSafeTx(this.s.keys.evmAccount, tx, d.chain_id, f.safe as `0x${string}`) as Hex;
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
    const existing = await this.getCase(m.orderId);
    if (!existing && m.type !== MSG.escrowNotice && m.type !== MSG.disputeOpen) return;

    await this.lock.run(m.orderId, async () => {
      const now = nowSeconds();
      const c: EscrowCase = (await this.getCase(m.orderId)) ?? {
        orderId: m.orderId, status: 'notice', createdAt: now, updatedAt: now, disputes: [], messages: [],
        tracking: [], purchaseEvidence: [], timeline: [],
      };
      const before = JSON.stringify(c);
      if (m.type === MSG.attachment) {
        if (m.from !== c.user && m.from !== c.shopper) return;
        this.addChunk(c, m.body as Attachment, m.from);
        if (JSON.stringify(c) !== before) await this.save(c);
        return;
      }
      this.absorb(c, m.inner); // the envelope itself is signed evidence too

      if (m.type === MSG.escrowNotice) {
        const n = m.body as EscrowNotice;
        for (const inner of [n.request, n.quote, n.accept, n.funded]) this.absorb(c, inner);
        if (c.user && m.from !== c.user) return; // notices come from the user
        this.log(c, m.type, '入金の通知を受けました');
      } else if (m.type === MSG.disputeOpen || m.type === MSG.evidence) {
        const body = m.body as DisputeOpen | DisputeEvidence;
        const ev: DisputeEvidence = 'evidence' in body ? body.evidence : body;
        for (const inner of ev.messages ?? []) this.absorb(c, inner);
        for (const t of ev.tracking ?? []) if (!c.tracking.some((x) => JSON.stringify(x) === JSON.stringify(t))) c.tracking.push(t);
        for (const e of ev.purchase_evidence ?? []) if (!c.purchaseEvidence.some((x) => x.sha256 === e.sha256)) c.purchaseEvidence.push(e);
        if (ev.delivery_key_for_escrow) c.deliveryKeyForEscrow = ev.delivery_key_for_escrow;
        if (ev.delivery_ciphertext) c.deliveryCiphertext = ev.delivery_ciphertext;
        if (m.type === MSG.disputeOpen) {
          c.disputes.push({ from: m.from, body: body as DisputeOpen, at: now });
          if (c.status === 'notice') c.status = 'open';
          this.log(c, m.type, `${this.who(c, m.from)} が紛争を申し立てました: ${(body as DisputeOpen).claim} — ${(body as DisputeOpen).text}`);
        } else {
          this.log(c, m.type, `${this.who(c, m.from)} から証拠を受け取りました`);
        }
      } else if (m.type === MSG.countersigned) {
        c.settledTxid = (m.body as { txid: string }).txid;
        c.status = 'settled';
        this.log(c, m.type, `連署・放送されました (${c.settledTxid})`);
      }

      // Only keep cases where we really are the named escrow.
      if (c.request && c.request.escrow !== me) return;
      // A party must be the user or shopper of the order.
      if (c.user && c.shopper && m.from !== c.user && m.from !== c.shopper) return;
      if (JSON.stringify(c) === before) return;
      await this.save(c);
    });
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

  /**
   * Accept a signed inner as evidence if it verifies, and learn the order's
   * request / quote / funded from it (checking who signed what).
   */
  private absorb(c: EscrowCase, inner: Inner): void {
    if (!isValidInner(inner)) return;
    const meta = innerMeta(inner);
    if (meta.orderId !== c.orderId) return;
    if (!c.messages.some((m) => m.id === inner.id)) c.messages.push(inner);
    try {
      if (meta.type === MSG.request && !c.request) {
        c.request = innerBody<OrderRequest>(inner);
        c.user = inner.pubkey;
        c.shopper = meta.recipient;
      } else if (meta.type === MSG.quote && !c.quote && (!c.shopper || inner.pubkey === c.shopper)) {
        c.quote = innerBody<OrderQuote>(inner);
      } else if (meta.type === MSG.funded && !c.funded && (!c.user || inner.pubkey === c.user)) {
        c.funded = innerBody<OrderFunded>(inner);
      } else if (meta.type === MSG.shipping) {
        const t = innerBody<{ tracking?: TrackingStatus }>(inner).tracking;
        if (t && !c.tracking.some((x) => JSON.stringify(x) === JSON.stringify(t))) c.tracking.push(t);
      } else if (meta.type === MSG.purchased) {
        for (const e of innerBody<{ evidence?: Evidence[] }>(inner).evidence ?? []) {
          if (!c.purchaseEvidence.some((x) => x.sha256 === e.sha256)) c.purchaseEvidence.push(e);
        }
      }
    } catch {
      /* malformed body: keep the signed message, ignore its content */
    }
  }

  private async verifyUpfrontFee(c: EscrowCase): Promise<Obligation> {
    const checkedAt = nowSeconds();
    const { quote, funded } = c;
    if (!quote || !funded) return { paid: false, detail: 'no funding information', checkedAt };
    const required = parseUnits(quote.escrow_upfront_fee ?? '0');
    if (required === 0n) return { paid: false, detail: 'quote carried no upfront fee', checkedAt };
    if (funded.asset === 'btc-signet') {
      if (!this.s.chain) return { paid: false, detail: 'no BTC chain API', checkedAt };
      const tx = Transaction.fromRaw(fromHex(await this.s.chain.txHex(funded.fee_txid || funded.txid)), { allowUnknownOutputs: true });
      const target = toHex(addressToScript(this.s.keys.btcWallet.address));
      let paid = 0n;
      for (let i = 0; i < tx.outputsLength; i++) {
        const o = tx.getOutput(i);
        if (o.script && toHex(o.script) === target) paid += o.amount ?? 0n;
      }
      const status = await this.s.chain.txStatus(funded.fee_txid || funded.txid).catch(() => ({ confirmed: false }));
      const ok = paid >= required;
      return { paid: ok, detail: `${paid} sats to ${this.s.keys.btcWallet.address}${status.confirmed ? '' : ' (unconfirmed)'}`, checkedAt };
    }
    if (!this.s.evm) return { paid: false, detail: 'no EVM client', checkedAt };
    if (!funded.fee_tx) return { paid: false, detail: 'no fee_tx', checkedAt };
    const paid = await this.s.evm.usdcTransferredIn(funded.fee_tx as Hex, this.s.keys.evmAddress);
    return { paid: paid >= required, detail: `${paid} USDC units to ${this.s.keys.evmAddress}`, checkedAt };
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
