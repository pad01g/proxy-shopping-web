/**
 * The mock mode's shopper-1: a TypeScript port of the parts of the Go shopper node
 * (proxy-shopping-go/node/internal/shopper) the demo scenarios go through, running on core's Session (its own
 * keys — the lab's shopper-1 mnemonic —, gift-wrapped messages, trust directory) against the mock relays and
 * chains. Like the Go node it
 *   - quotes after the trust, region, payment, address and shop-risk checks (§4.5, §8): a shop scoring below 70
 *     (allowlist +50, verified HTTPS +20, known gateway +30) is refused with `risk`, a cash-only shop outside
 *     cash_regions with `region`; prices come from the shop's catalog and the rates, timelocks from the chain;
 *   - verifies the funding on chain (§4.6), buys through the bot, reports the shop's tracking;
 *   - offers a cooperative refund when the purchase fails (sold out), countersigns releases (§4.8) and rulings
 *     that give it something (the user countersigns the others), answers the escrow's evidence requests, and
 *     claims alone after T1 when a delivered order is never released;
 *   - can be paused (admin API POST /admin/pause) and shows its orders like GET /orders.
 * Pending actions are retried with back-off; everything is stored so a reload continues where it was.
 */
import {
  btcPayoutProblems, buildEscrowSpend, CONTAINER_TYPES, computeLockAmount, covers, decimalToUnits, decryptAddress, escrowPubkeyFromXpub,
  extractTx, finalizeEscrowInput, fromHex, getRate, innerMeta, keyForEscrowSha256, KeyedMutex, MSG, nowSeconds, orderSafeAddress,
  p2wshAddress, parseUnits, psbtFromBase64, psbtToBase64, recoverSafeTxSigner, releaseSafeTx, safePayoutProblems, safeTxFromJson,
  safeTxHash, safeTxToJson, safeTxTransfers, ScopedStorage, shopAllowed, shopHost, ShopperProfile, signEscrowInput, signSafeTx,
  splitEvidence, toHex, unwrapDeliveryKey, verifyRequestKeyProof, witnessScript, describeOutputs,
  type Address, type DisputeEvidence, type DisputeOpen, type DisputeRuling, type EscrowProfileContent, type Evidence, type IncomingMessage,
  type Inner, type Money, type OrderFunded, type OrderQuote, type OrderRequest, type Session, type SignedPayout, type Storage,
  type TrackingStatus,
} from '@proxy-shopping/core/browser';
import { Transaction } from '@scure/btc-signer';
import type { Hex } from 'viem';
import type { MockBtcChain } from './btc/chain';
import { catalogOf, inspectShop, type MockShops, type PurchaseResult, type ShopInfo } from './shops';

/** The lab's shopper-1 settings (proxy-shopping-go/lab/nodes/shopper-1.yaml, docs/lab.md). */
export const SHOPPER_CONFIG = {
  name: 'shopper-1',
  payments: ['btc-signet', 'usdc-evm'] as const,
  currencies: ['JPY', 'USD'],
  cashRegions: ['JP-27'],
  fee: { bps: 500, min: { amount: '300', currency: 'JPY' } },
  maxOrder: { amount: '200000', currency: 'JPY' },
  deliveryDays: 5,
  risk: { allowlist: ['safe-shop.test', 'us-shop.test', 'cash-store.test'], knownGateways: ['cardgw.test'], threshold: 70 },
  timelock: { btcT1Blocks: 100, btcT2Blocks: 150, evmT1Seconds: 3600, evmT2Seconds: 7200 },
  confirmations: 1,
  quoteTtlSeconds: 900,
  payoutFeeReserveSats: 1000n,
  minT1RemainingSeconds: 1800,
};

export type NodeState =
  | 'requested' | 'rejected' | 'quoted' | 'accepted' | 'cancelled' | 'funding' | 'funded' | 'purchasing' | 'purchased' | 'purchase_failed'
  | 'needs_human' | 'shipped' | 'delivered' | 'shipping_failed' | 'disputed' | 'completed' | 'settled' | 'claimed' | 'closed';

const TERMINAL: ReadonlySet<NodeState> = new Set(['rejected', 'cancelled', 'completed', 'settled', 'claimed', 'closed']);

type ActionKind = 'quote' | 'refund' | 'release' | 'ruling' | 'claim';
const ACTION_ORDER: ActionKind[] = ['quote', 'refund', 'release', 'ruling', 'claim'];

interface Action {
  /** The message that asked for it (order.release, dispute.ruling). */
  inner?: Inner;
  tx?: string;
  since: number;
  attempts: number;
  next: number;
  error?: string;
}

export interface NodeOrder {
  id: string;
  user: string;
  state: NodeState;
  created: number;
  updated: number;
  error?: string;
  request: OrderRequest;
  quote?: OrderQuote;
  quoteId?: string;
  chainExpiresAt?: number;
  funded?: OrderFunded;
  fundingSince?: number;
  escrowKey?: string;
  shop?: ShopInfo;
  risk_score?: number;
  outpoint?: { txid: string; vout: number; amount: string };
  safe?: string;
  purchase?: PurchaseResult;
  tracking: TrackingStatus[];
  ship_status?: string;
  dispute?: { claim: string; text: string; at: number };
  ruling?: DisputeRuling;
  rulingInner?: Inner;
  rulingDecided?: boolean;
  claimedPayout?: string;
  payout_tx?: string;
  payout_by?: 'release' | 'ruling' | 'timelock' | 'other';
  pending: Partial<Record<ActionKind, Action>>;
  /** Every signed message of the order, sent and received (evidence for the escrow, §4.7). */
  messages: Inner[];
  /** The latest message of each type from the user, to replay one that came before what it builds on. */
  early: Record<string, Inner>;
  history: Array<{ at: number; state: string; detail?: string }>;
}

/** GET /orders row. */
export interface NodeOrderSummary {
  id: string;
  state: string;
  user: string;
  asset?: string;
  lock_amount?: string;
  ship_status?: string;
  payout_tx?: string;
  updated: number;
  error?: string;
}

/** A verified funding: the chain objects it uses (one order each), when it confirmed, and the escrow. */
interface Funding {
  uses: string[];
  confirmedAt: number;
  outpoint?: { txid: string; vout: number; amount: string };
  safe?: string;
}

class Rejection extends Error {
  constructor(readonly reason: string, readonly detail: string) {
    super(`${reason}: ${detail}`);
  }
}
/** A problem that will not go away by retrying. */
class Definite extends Error {}
class NotYet extends Error {}

const reject = (reason: string, detail: string): never => {
  throw new Rejection(reason, detail);
};

const DECIMALS: Record<string, number> = { JPY: 0, KRW: 0, BTC: 8, USDC: 6 };
const decimalsOf = (cur: string) => DECIMALS[cur] ?? 2;
/** Minor units → decimal string with the currency's decimals. */
const fmt = (minor: bigint, cur: string) => {
  const d = decimalsOf(cur);
  if (!d) return minor.toString();
  const s = minor.toString().padStart(d + 1, '0');
  return `${s.slice(0, -d)}.${s.slice(-d)}`;
};
/** Like the Go node's fx.FormatRate: 8 decimals, trailing zeros trimmed. */
const formatRate = (r: number) => r.toFixed(8).replace(/\.?0+$/, '');
const isTxid = (s: unknown) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const isTxHash = (s: unknown) => typeof s === 'string' && /^0x[0-9a-f]{64}$/.test(s);
const sameAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export interface ShopperDeps {
  session: Session;
  /** The world's storage (orders live under `shopper/`). */
  storage: Storage;
  btc: MockBtcChain;
  shops: MockShops;
  network: string;
  /** Period of the node's loop (ms); the funding, tracking and escrow checks run every few ticks. */
  tickMs?: number;
  /** Called after an order changed (the tab polls anyway). */
  onChange?: () => void;
}

export class MockShopperNode {
  private readonly s: Session;
  private readonly store: Storage;
  private readonly lock = new KeyedMutex();
  private readonly busy = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private tick = 0;
  private pausedUntil = 0;
  private started = false;
  readonly errors: string[] = [];

  constructor(private readonly d: ShopperDeps) {
    this.s = d.session;
    this.store = new ScopedStorage(d.storage, 'shopper/');
    this.s.messenger.on('message', (m) => void this.handle(m).catch((e) => this.warn(`handling ${m.type}`, e)));
    this.s.addAcceptor(async (inner, meta) => {
      if (meta.type === MSG.request) return 'stranger';
      const o = meta.orderId ? await this.order(meta.orderId) : undefined;
      if (o && (inner.pubkey === o.user || inner.pubkey === o.request.escrow)) return 'counterparty';
      return 'reject';
    });
  }

  get pubkey(): string {
    return this.s.keys.nostrPublicKey;
  }

  private warn(what: string, err: unknown): void {
    const line = `${what}: ${(err as Error)?.message ?? err}`;
    this.errors.push(line);
    if (this.errors.length > 50) this.errors.shift();
    console.warn(`mock shopper-1: ${line}`);
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    this.pausedUntil = (await this.store.get<number>('paused_until')) ?? 0;
    await this.s.directory.load();
    await this.publishProfile();
    if (!this.paused) await this.s.messenger.start();
    this.started = true;
    this.timer = setInterval(() => void this.loop(), this.d.tickMs ?? 1000);
    void this.loop();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.s.stop();
  }

  private async publishProfile(): Promise<void> {
    const c = SHOPPER_CONFIG;
    const p = new ShopperProfile(this.s);
    await p.publish(p.withOwnAddresses({
      name: c.name, payments: [...c.payments], currencies: c.currencies, cash_regions: c.cashRegions,
      fee: c.fee, max_order: c.maxOrder, delivery_days: c.deliveryDays,
    }));
    await this.s.publishInboxRelays();
  }

  get directory() {
    return this.s.directory;
  }

  get pausedUntilTime(): number {
    return this.pausedUntil;
  }

  get paused(): boolean {
    return this.pausedUntil > nowSeconds();
  }

  /** POST /admin/pause: stop messaging and the periodic work for `seconds`. */
  async pause(seconds: number): Promise<{ paused: true; paused_until: number }> {
    if (!(seconds >= 1 && seconds <= 86400)) throw new Error('seconds must be 1..86400');
    this.pausedUntil = nowSeconds() + Math.floor(seconds);
    await this.store.put('paused_until', this.pausedUntil);
    this.s.messenger.stop();
    return { paused: true, paused_until: this.pausedUntil };
  }

  /** POST /admin/resume. */
  async resume(): Promise<{ paused: false; was_paused: boolean }> {
    const was = this.paused;
    this.pausedUntil = 0;
    await this.store.put('paused_until', 0);
    if (!this.s.messenger.running) await this.s.messenger.start();
    return { paused: false, was_paused: was };
  }

  private async loop(): Promise<void> {
    if (!this.started) return;
    if (this.paused) return;
    if (!this.s.messenger.running) await this.s.messenger.start().catch((e) => this.warn('messenger', e));
    const t = this.tick++;
    const jobs: Array<Promise<void>> = [this.retryPending()];
    if (t % 2 === 0) jobs.push(this.checkFunding(), this.pollTracking());
    if (t % 3 === 0) jobs.push(this.watchEscrows(), this.s.directory.refresh().then(() => undefined));
    await Promise.all(jobs.map((j) => j.catch((e) => this.warn('loop', e))));
  }

  /** Run `fn` in the background unless the same job for the order is running. */
  private background(job: string, id: string, fn: () => Promise<void>): void {
    const key = `${job}:${id}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    void fn().catch((e) => this.warn(`${job} ${id.slice(0, 8)}`, e)).finally(() => this.busy.delete(key));
  }

  // ---------- storage ----------

  async order(id: string): Promise<NodeOrder | undefined> {
    return this.store.get<NodeOrder>(`order/${id}`);
  }

  async orders(): Promise<NodeOrder[]> {
    return (await this.store.list<NodeOrder>('order/')).map(([, o]) => o).sort((a, b) => b.created - a.created);
  }

  private async save(o: NodeOrder): Promise<void> {
    o.updated = nowSeconds();
    await this.store.put(`order/${o.id}`, o);
    this.d.onChange?.();
  }

  /** Change an order under its lock; `fn` returning false leaves it unchanged. */
  private async update(id: string, fn: (o: NodeOrder) => boolean | void | Promise<boolean | void>): Promise<NodeOrder | undefined> {
    return this.lock.run(id, async () => {
      const o = await this.order(id);
      if (!o) return undefined;
      if ((await fn(o)) === false) return undefined;
      await this.save(o);
      return o;
    });
  }

  private set(o: NodeOrder, state: NodeState, detail?: string): void {
    o.state = state;
    o.history.push({ at: nowSeconds(), state, detail: detail || undefined });
  }

  private note(o: NodeOrder, detail: string): void {
    const last = o.history[o.history.length - 1];
    if (last && last.state === o.state && last.detail === detail) last.at = nowSeconds();
    else o.history.push({ at: nowSeconds(), state: o.state, detail });
  }

  private funded(o: NodeOrder): boolean {
    return (!!o.outpoint || !!o.safe) && !o.payout_tx && !TERMINAL.has(o.state);
  }

  private async send(o: NodeOrder, to: string, type: string, body: unknown): Promise<Inner> {
    const inner = await this.s.messenger.send(to, o.id, type, body);
    await this.update(o.id, (cur) => {
      cur.messages.push(inner);
    });
    return inner;
  }

  // ---------- admin API views ----------

  summary(o: NodeOrder): NodeOrderSummary {
    return {
      id: o.id, state: o.state, user: o.user, asset: o.quote?.asset ?? o.request.payment, lock_amount: o.quote?.lock_amount,
      ship_status: o.ship_status, payout_tx: o.payout_tx, updated: o.updated, error: o.error,
    };
  }

  /** GET /orders/{id} (the fields the demo shows). */
  detail(o: NodeOrder) {
    const pending: Record<string, { attempts?: number; error?: string; tx?: string }> = {};
    for (const [k, a] of Object.entries(o.pending)) if (a) pending[k] = { attempts: a.attempts || undefined, error: a.error, tx: a.tx };
    return {
      ...this.summary(o),
      created: o.created,
      risk_score: o.risk_score,
      payout_by: o.payout_by,
      request: { shop_url: o.request.shop_url, items: o.request.items },
      purchase: o.purchase && { status: o.purchase.status, shop_order_id: o.purchase.shop_order_id, total: o.purchase.total, error: o.purchase.error },
      tracking: o.tracking.map((t) => ({ status: t.status, tracking_no: t.tracking_no, updated_at: t.updated_at })),
      pending,
      history: o.history,
    };
  }

  // ---------- messages ----------

  private async handle(m: IncomingMessage): Promise<void> {
    if (m.type === MSG.request) return this.onRequest(m);
    const o = await this.order(m.orderId);
    if (!o) return;
    const fromUser = m.from === o.user;
    const fromEscrow = m.from === o.request.escrow;
    if (!fromUser && !fromEscrow) return;
    await this.update(o.id, (cur) => {
      if (!cur.messages.some((x) => x.id === m.inner.id)) cur.messages.push(m.inner);
      if (fromUser) cur.early[m.type] = m.inner;
    });
    switch (m.type) {
      case MSG.escrowKey: return fromUser ? this.onEscrowKey(m) : undefined;
      case MSG.accept: return fromUser ? this.onAccept(m) : undefined;
      case MSG.cancel: return fromUser ? this.onCancel(m) : undefined;
      case MSG.funded: return fromUser ? this.onFunded(m) : undefined;
      case MSG.release: return fromUser ? this.onRelease(m) : undefined;
      case MSG.disputeOpen: return fromUser ? this.onDisputeOpen(m) : undefined;
      case MSG.evidenceRequest: return fromEscrow ? this.onEvidenceRequest(m) : undefined;
      case MSG.ruling: return fromEscrow ? this.onRuling(m) : undefined;
      case MSG.countersigned: return fromUser ? this.onCountersigned(m) : undefined;
    }
  }

  /** Hand the stored message of `type` from the user to its handler again (it came before what it builds on). */
  private async replay(id: string, type: string): Promise<void> {
    const o = await this.order(id);
    const inner = o?.early[type];
    if (!o || !inner) return;
    let body: unknown;
    try {
      body = JSON.parse(inner.content);
    } catch {
      return;
    }
    await this.handle({ inner, from: inner.pubkey, orderId: id, type, body });
  }

  private async onRequest(m: IncomingMessage): Promise<void> {
    if (!/^[0-9a-f]{32}$/.test(m.orderId)) return;
    const req = m.body as OrderRequest;
    const created = await this.lock.run(m.orderId, async () => {
      if (await this.order(m.orderId)) return false;
      const now = nowSeconds();
      const o: NodeOrder = {
        id: m.orderId, user: m.from, state: 'requested', created: now, updated: now, request: req, tracking: [], pending: {},
        messages: [m.inner], early: {}, history: [{ at: now, state: 'requested' }],
      };
      o.pending.quote = { since: now, attempts: 0, next: 0 };
      await this.save(o);
      return true;
    });
    if (created) this.kick(m.orderId);
  }

  private async onEscrowKey(m: IncomingMessage): Promise<void> {
    const k = (m.body as { key_for_escrow?: string }).key_for_escrow;
    if (!k) return;
    await this.update(m.orderId, (o) => {
      if (o.escrowKey) return false;
      if (keyForEscrowSha256(k) !== o.request.delivery.key_for_escrow_sha256) {
        this.note(o, 'order.escrow_key does not match key_for_escrow_sha256 of the request, ignored');
        return;
      }
      o.escrowKey = k;
      this.note(o, 'escrow key received');
    });
  }

  private async onAccept(m: IncomingMessage): Promise<void> {
    const qid = (m.body as { quote_id?: string }).quote_id;
    const done = await this.update(m.orderId, (o) => {
      if (o.state !== 'quoted' || !o.quoteId || o.quoteId !== qid) return false;
      if (nowSeconds() > (o.quote?.expires_at ?? 0)) {
        this.set(o, 'cancelled', 'quote expired before accept');
        return;
      }
      this.set(o, 'accepted');
    });
    if (done?.state === 'accepted') await this.replay(m.orderId, MSG.funded);
  }

  private async onCancel(m: IncomingMessage): Promise<void> {
    await this.update(m.orderId, (o) => {
      if (o.state !== 'quoted' && o.state !== 'accepted') return false;
      this.set(o, 'cancelled', (m.body as { reason?: string }).reason);
    });
  }

  private async onFunded(m: IncomingMessage): Promise<void> {
    const f = m.body as OrderFunded;
    if (f.asset === 'btc-signet' ? !isTxid(f.txid) || !isTxid(f.fee_txid) : !isTxHash(f.fund_tx) || !isTxHash(f.deploy_tx) || !isTxHash(f.fee_tx)) return;
    const o = await this.update(m.orderId, (o) => {
      if (o.state !== 'accepted' || o.quote?.asset !== f.asset) return false;
      o.funded = f;
      o.fundingSince = nowSeconds();
      this.set(o, 'funding', 'waiting for confirmations');
    });
    if (o) this.background('verify', o.id, () => this.verifyFunding(o.id));
  }

  private async onRelease(m: IncomingMessage): Promise<void> {
    const o = await this.update(m.orderId, (o) => {
      if (!this.funded(o) || o.pending.release?.tx) return false;
      o.pending.release = { inner: m.inner, since: nowSeconds(), attempts: 0, next: 0 };
      this.note(o, 'release received');
    });
    if (o) this.kick(o.id);
  }

  private async onDisputeOpen(m: IncomingMessage): Promise<void> {
    const d = m.body as DisputeOpen;
    const o = await this.update(m.orderId, (o) => {
      if (o.dispute) return false;
      o.dispute = { claim: d.claim, text: d.text, at: nowSeconds() };
      if (!TERMINAL.has(o.state) && o.state !== 'disputed') this.set(o, 'disputed', `${d.claim}: ${d.text}`);
      this.decideRuling(o);
    });
    if (o) this.kick(o.id);
  }

  private async onEvidenceRequest(m: IncomingMessage): Promise<void> {
    await this.update(m.orderId, (o) => {
      if (!o.dispute) {
        o.dispute = { claim: '(evidence request of the escrow)', text: '', at: nowSeconds() };
        if (!TERMINAL.has(o.state) && o.state !== 'disputed') this.set(o, 'disputed', 'the escrow asks for evidence');
      }
      this.decideRuling(o);
    });
    this.kick(m.orderId);
    this.background('evidence', m.orderId, () => this.sendEvidence(m.orderId));
  }

  private async onRuling(m: IncomingMessage): Promise<void> {
    const r = m.body as DisputeRuling;
    const o = await this.update(m.orderId, (o) => {
      if (o.rulingInner) {
        if (o.rulingInner.id !== m.inner.id) this.note(o, 'a second ruling of the escrow was ignored');
        return false;
      }
      o.ruling = r;
      o.rulingInner = m.inner;
      this.note(o, `ruling user=${r.split.user} shopper=${r.split.shopper} fee=${r.split.escrow_fee}: ${r.reason}`);
      this.decideRuling(o);
    });
    if (o) this.kick(o.id);
  }

  private async onCountersigned(m: IncomingMessage): Promise<void> {
    const txid = (m.body as { txid?: string }).txid;
    if (!isTxid(txid) && !isTxHash(txid)) return;
    await this.update(m.orderId, (o) => {
      if (o.payout_tx) return false;
      if (!o.ruling) {
        this.note(o, 'dispute.countersigned without a ruling, ignored');
        return;
      }
      o.claimedPayout = txid;
      this.note(o, `the user countersigned the ruling (${txid}); waiting for the chain`);
    });
  }

  /** A stored ruling, once the dispute is known: countersign it, or leave it to the user (§4.8). */
  private decideRuling(o: NodeOrder): void {
    if (!o.ruling || o.rulingDecided || o.pending.ruling) return;
    if (!o.dispute) {
      this.note(o, 'ruling kept until the dispute is known');
      return;
    }
    o.rulingDecided = true;
    let why = '';
    if (!this.funded(o)) why = 'the escrow is not open';
    else if (!/^\d+$/.test(o.ruling.split.shopper)) why = 'split.shopper is not a number';
    else if (BigInt(o.ruling.split.shopper) === 0n) why = 'nothing for us; the user countersigns';
    if (why) {
      this.note(o, `ruling not countersigned: ${why}`);
      return;
    }
    o.pending.ruling = { inner: o.rulingInner, since: nowSeconds(), attempts: 0, next: 0 };
  }

  // ---------- quote (§4.5, §8) ----------

  private async doQuote(o: NodeOrder): Promise<void> {
    if (o.quoteId) return;
    let q = o.quote;
    if (o.state === 'requested') {
      let info: ShopInfo | undefined;
      let score: number | undefined;
      try {
        ({ q, info, score } = await this.buildQuote(o));
      } catch (err) {
        const rj = err instanceof Rejection ? err : new Rejection('unavailable', 'the quote could not be made');
        if (!(err instanceof Rejection)) this.warn(`quote ${o.id.slice(0, 8)}`, err);
        q = { accept: false, reject_reason: rj.reason, detail: rj.detail };
        info = (err as { info?: ShopInfo }).info;
        score = (err as { score?: number }).score;
      }
      const quote = q!;
      await this.update(o.id, (cur) => {
        if (cur.state !== 'requested') return false;
        cur.quote = quote;
        cur.shop = info;
        cur.risk_score = score;
        cur.chainExpiresAt = o.chainExpiresAt;
        if (quote.accept) this.set(cur, 'quoted', `lock ${quote.lock_amount} ${quote.asset}`);
        else this.set(cur, 'rejected', `${quote.reject_reason}: ${quote.detail}`);
      });
    }
    if (!q) throw new Definite(`no quote to send in state ${o.state}`);
    const inner = await this.send(o, o.user, MSG.quote, q);
    const done = await this.update(o.id, (cur) => {
      cur.quoteId = inner.id;
    });
    if (done?.state === 'quoted') await this.replay(o.id, MSG.accept);
  }

  private async buildQuote(o: NodeOrder): Promise<{ q: OrderQuote; info?: ShopInfo; score?: number }> {
    const c = SHOPPER_CONFIG;
    const req = o.request;
    const me = this.pubkey;
    if (!(c.payments as readonly string[]).includes(req.payment)) reject('payment', `${req.payment} is not accepted`);
    if (req.payment === 'btc-signet') {
      if (!/^0[23][0-9a-f]{64}$/.test(req.user_btc_pubkey ?? '')) reject('invalid', 'user_btc_pubkey is not a compressed public key');
      if (!req.user_btc_address) reject('invalid', 'user_btc_address is missing');
    } else if (!/^0x[0-9a-fA-F]{40}$/.test(req.user_evm_address ?? '')) reject('invalid', 'user_evm_address is not an address');
    if (!(await verifyRequestKeyProof(req, o.id, o.user))) reject('invalid', 'key_proof does not verify');
    let host: string;
    try {
      host = shopHost(req.shop_url);
    } catch {
      return reject('invalid', 'shop_url is not a URL');
    }
    if (!req.items.length || req.items.length > 20 || req.items.some((i) => !i.sku || i.sku.length > 64 || i.qty < 1 || i.qty > 99)) {
      reject('invalid', '1 to 20 items with a sku of 1-64 bytes and qty 1-99 are needed');
    }
    if (!req.delivery?.ciphertext || !req.delivery.key_for_shopper || !/^[0-9a-f]{64}$/.test(req.delivery.key_for_escrow_sha256 ?? '')) {
      reject('invalid', 'delivery ciphertext, key_for_shopper and key_for_escrow_sha256 are required');
    }

    // The shopper × escrow combination must be in the effective set and cover the region, payment and shop.
    const snap = await this.s.directory.refresh().catch(() => this.s.directory.current);
    const rows = (snap?.entries ?? []).filter((e) => e.shopper === me && e.escrow === req.escrow);
    if (!rows.length) reject('trust', `shopper ${me.slice(0, 12)} with escrow ${req.escrow.slice(0, 12)} is not in the effective list`);
    let match = rows.filter((e) => covers(e.region, req.shop_region));
    if (!match.length) reject('region', `no list entry covers ${req.shop_region}`);
    match = match.filter((e) => e.payments.includes(req.payment));
    if (!match.length) reject('payment', `${req.payment} is not listed for this combination`);
    match = match.filter((e) => shopAllowed(e.shops, req.shop_url));
    if (!match.length) reject('region', `shop ${host} is not listed for this combination`);
    if (!match.some((e) => e.provenance.operator === req.operator)) reject('trust', `operator ${req.operator.slice(0, 12)} does not list this combination`);
    const escrow = snap?.escrows.get(req.escrow)?.content;
    if (!escrow) reject('unavailable', `no profile of escrow ${req.escrow.slice(0, 12)}`);
    const address = await this.openAddress(o).catch((e: Error) => reject('invalid', `delivery address: ${e.message}`));
    for (const [k, v] of Object.entries(address)) {
      if (!String(v ?? '').trim() || String(v).length > 500) reject('invalid', `delivery address: ${k} must have 1-500 bytes`);
    }

    // Shop risk (§8).
    let info: ShopInfo;
    try {
      info = inspectShop(req.shop_url);
    } catch {
      return reject('unavailable', 'shop not reachable');
    }
    let score = 0;
    const withInfo = (e: unknown) => Object.assign(e as object, { info, score });
    try {
      if (info.cashOnly) {
        const region = info.region || req.shop_region;
        if (!c.cashRegions.some((r) => covers(r, region))) reject('region', `cash-only shop in ${region} is outside our cash regions [${c.cashRegions.join(' ')}]`);
      } else {
        const why: string[] = [];
        if (c.risk.allowlist.includes(info.host)) {
          score += 50;
          why.push('allowlisted host +50');
        }
        if (info.certOk) {
          score += 20;
          why.push('verified HTTPS +20');
        }
        if (info.gateway && c.risk.knownGateways.includes(info.gateway)) {
          score += 30;
          why.push(`known payment gateway ${info.gateway} +30`);
        }
        if (score < c.risk.threshold) reject('risk', `risk score ${score} below ${c.risk.threshold} (${why.join(', ')})`);
      }

      // Price.
      const cat = catalogOf(req.shop_url);
      const cur = cat.currency;
      if (!c.currencies.includes(cur)) reject('unavailable', `we do not buy in ${cur}`);
      const dec = decimalsOf(cur);
      let items = 0n;
      for (const it of req.items) {
        const p = cat.products.find((x) => x.sku === it.sku);
        if (!p) reject('unavailable', `item ${it.sku} is not sold`);
        items += decimalToUnits(p!.price.amount, dec) * BigInt(it.qty);
      }
      const shipping = decimalToUnits(cat.shipping.amount, dec);
      const sub = items + shipping;
      let fee = (sub * BigInt(c.fee.bps) + 9999n) / 10000n;
      const minFee = await this.convertUp(c.fee.min, cur);
      if (minFee > fee) fee = minFee;
      const total = sub + fee;
      const limit = await this.convertUp(c.maxOrder, cur);
      if (total > limit) reject('limit', `order of ${fmt(total, cur)} ${cur} exceeds our limit of ${c.maxOrder.amount} ${c.maxOrder.currency}`);

      const asset = req.payment === 'btc-signet' ? 'BTC' : 'USDC';
      const decimals = req.payment === 'btc-signet' ? 8 : 6;
      const reserve = req.payment === 'btc-signet' ? c.payoutFeeReserveSats : 0n;
      let fx;
      try {
        fx = await getRate(this.s.rates, `${asset}/${cur}`);
      } catch (err) {
        return reject('unavailable', `rate ${asset}/${cur}: ${(err as Error).message}`);
      }
      const rateStr = formatRate(fx.rate);
      const price = { items: { amount: fmt(items, cur), currency: cur }, shipping: { amount: fmt(shipping, cur), currency: cur }, shopper_fee: { amount: fmt(fee, cur), currency: cur } };
      const lock = computeLockAmount([price.items.amount, price.shipping.amount, price.shopper_fee.amount], rateStr, decimals, reserve);
      if (reserve > 20_000n || (reserve > 2_000n && reserve * 20n > lock)) reject('limit', `order too small: the payout fee reserve of ${reserve} sats would exceed 5% of the lock`);
      const at = nowSeconds();
      const q: OrderQuote = {
        accept: true,
        detail: `${host} at ${c.name}`,
        expires_at: at + c.quoteTtlSeconds,
        price,
        fx: { pair: `${asset}/${cur}`, rate: rateStr, sources: fx.sources.map((x) => ({ name: x.name, rate: formatRate(x.rate), at: x.at })), at },
        asset: req.payment,
        lock_amount: lock.toString(),
        payout_fee_reserve: reserve.toString(),
      };
      if (req.payment === 'btc-signet') await this.fillBtc(o, q, escrow!, lock);
      else await this.fillUsdc(o, q, escrow!, lock);
      return { q, info, score };
    } catch (err) {
      throw withInfo(err);
    }
  }

  /** An amount of fiat in `to`'s minor units, rounded up (the Go node's convert + CeilTo). */
  private async convertUp(m: Money, to: string): Promise<bigint> {
    const dec = decimalsOf(to);
    if (m.currency === to) return decimalToUnits(m.amount, dec);
    let r: number;
    try {
      r = (await getRate(this.s.rates, `${m.currency}/${to}`)).rate;
    } catch (err) {
      return reject('unavailable', `rate ${m.currency}/${to}: ${(err as Error).message}`);
    }
    return BigInt(Math.ceil(Number(m.amount) * r * 10 ** dec - 1e-6));
  }

  private async fillBtc(o: NodeOrder, q: OrderQuote, escrow: EscrowProfileContent, lock: bigint): Promise<void> {
    const c = SHOPPER_CONFIG;
    const tip = await this.d.btc.tipHeight();
    q.timelock = { t1: tip + c.timelock.btcT1Blocks, t2: tip + c.timelock.btcT2Blocks };
    const shopperKey = this.s.keys.orderKey(o.id).publicKey;
    const escrowKey = escrowPubkeyFromXpub(escrow.btc_xpub, o.id);
    const byBps = (lock * BigInt(escrow.upfront_fee.bps)) / 10000n;
    const min = parseUnits(escrow.upfront_fee.min_sats);
    q.escrow_upfront_fee = (byBps > min ? byBps : min).toString();
    q.shopper_btc_pubkey = toHex(shopperKey);
    q.shopper_btc_address = this.s.keys.btcWallet.address;
    q.escrow_btc_pubkey = toHex(escrowKey);
    q.escrow_btc_fee_address = escrow.btc_fee_address;
    q.escrow_address = p2wshAddress(witnessScript({ user: fromHex(o.request.user_btc_pubkey!), shopper: shopperKey, escrow: escrowKey }, q.timelock.t1, q.timelock.t2));
  }

  private async fillUsdc(o: NodeOrder, q: OrderQuote, escrow: EscrowProfileContent, lock: bigint): Promise<void> {
    const c = SHOPPER_CONFIG;
    const evm = this.evm();
    const now = Number(await evm.blockTimestamp());
    if (!/^0x[0-9a-fA-F]{40}$/.test(escrow.evm_address ?? '')) reject('unavailable', 'escrow has no EVM address');
    q.timelock = { t1: now + c.timelock.evmT1Seconds, t2: now + c.timelock.evmT2Seconds };
    o.chainExpiresAt = now + c.quoteTtlSeconds;
    const byBps = (lock * BigInt(escrow.upfront_fee.bps)) / 10000n;
    const min = decimalToUnits(escrow.upfront_fee.min_usdc, 6);
    q.escrow_upfront_fee = (byBps > min ? byBps : min).toString();
    q.shopper_evm_address = this.s.keys.evmAddress;
    q.escrow_evm_address = escrow.evm_address;
    q.escrow_address = orderSafeAddress(evm.deployments, {
      user: o.request.user_evm_address as `0x${string}`, shopper: this.s.keys.evmAddress, escrow: escrow.evm_address as `0x${string}`,
      t1: BigInt(q.timelock.t1), t2: BigInt(q.timelock.t2), orderId: o.id,
    }, await evm.proxyCreationCode());
  }

  private evm() {
    if (!this.s.evm) throw new Error('no EVM backend');
    return this.s.evm;
  }

  private async openAddress(o: NodeOrder): Promise<Address> {
    const key = await unwrapDeliveryKey(this.s.signer, o.user, o.request.delivery.key_for_shopper);
    return decryptAddress(key, o.id, o.request.delivery.ciphertext);
  }

  private escrowKeys(o: NodeOrder) {
    const q = o.quote!;
    return { user: fromHex(o.request.user_btc_pubkey!), shopper: fromHex(q.shopper_btc_pubkey!), escrow: fromHex(q.escrow_btc_pubkey!) };
  }

  private script(o: NodeOrder): Uint8Array {
    return witnessScript(this.escrowKeys(o), o.quote!.timelock!.t1, o.quote!.timelock!.t2);
  }

  // ---------- funding (§4.6) ----------

  private async checkFunding(): Promise<void> {
    const now = nowSeconds();
    for (const o of await this.orders()) {
      if (o.state === 'accepted' && o.quote?.expires_at && now > o.quote.expires_at + 3600) {
        await this.update(o.id, (cur) => {
          if (cur.state !== 'accepted') return false;
          this.set(cur, 'cancelled', 'not funded before the quote expired');
        });
      } else if (o.state === 'funding') {
        this.background('verify', o.id, () => this.verifyFunding(o.id));
      } else if (o.state === 'funded' || o.state === 'purchasing') {
        this.background('purchase', o.id, () => this.startPurchase(o.id));
      }
    }
  }

  private async verifyFunding(id: string): Promise<void> {
    const o = await this.order(id);
    if (!o || o.state !== 'funding' || !o.funded || !o.quote) return;
    try {
      const found = o.funded.asset === 'btc-signet' ? await this.checkBtcFunding(o) : await this.checkSafeFunding(o);
      const uses = (await this.store.get<Record<string, string>>('funding_uses')) ?? {};
      for (const u of found.uses) if (uses[u] && uses[u] !== id) throw new Definite(`${u} already funds order ${uses[u]}`);
      for (const u of found.uses) uses[u] = id;
      await this.store.put('funding_uses', uses);
      const late = found.confirmedAt > (o.quote.asset === 'usdc-evm' && o.chainExpiresAt ? o.chainExpiresAt : o.quote.expires_at ?? 0) + 3600;
      await this.update(id, (cur) => {
        if (cur.state !== 'funding') return false;
        if (found.outpoint) {
          cur.outpoint = found.outpoint;
          this.set(cur, 'funded', `${found.outpoint.txid}:${found.outpoint.vout} ${found.outpoint.amount} sats`);
        } else {
          cur.safe = found.safe;
          this.set(cur, 'funded', `safe ${found.safe}`);
        }
      });
      if (late) return this.abandon(id, 'funded after the quote expired');
      this.background('purchase', id, () => this.startPurchase(id));
    } catch (err) {
      if (err instanceof NotYet) {
        await this.update(id, (cur) => {
          if (cur.state !== 'funding') return false;
          this.note(cur, `waiting for the funding: ${err.message}`);
        });
        return;
      }
      if (err instanceof Definite) {
        const back = await this.update(id, (cur) => {
          if (cur.state !== 'funding') return false;
          cur.error = err.message;
          this.set(cur, 'accepted', `funding rejected: ${err.message}`);
        });
        if (back) await this.send(back, back.user, MSG.chat, { text: `funding rejected: ${err.message}` }).catch(() => undefined);
        return;
      }
      await this.update(id, (cur) => this.note(cur, `funding check failed, will retry: ${(err as Error).message}`));
    }
  }

  private async checkBtcFunding(o: NodeOrder): Promise<Funding> {
    const f = o.funded as Extract<OrderFunded, { asset: 'btc-signet' }>;
    const q = o.quote!;
    let st;
    try {
      st = await this.d.btc.txStatus(f.txid);
    } catch {
      throw new NotYet('funding transaction not seen yet');
    }
    const out = this.d.btc.output(f.txid, f.vout ?? 0);
    if (!out || out.address !== q.escrow_address) throw new Definite(`output ${f.vout} of ${f.txid} does not pay the escrow address`);
    if (out.value < BigInt(q.lock_amount!)) throw new Definite(`the escrow output holds ${out.value}, less than lock_amount ${q.lock_amount}`);
    if (!st.confirmed || this.d.btc.confirmations(f.txid) < SHOPPER_CONFIG.confirmations) throw new NotYet('not confirmed yet');
    const spent = await this.d.btc.outspend(f.txid, f.vout ?? 0);
    if (spent.spent) throw new Definite('the escrow output is already spent');
    // The upfront fee goes to the escrow in the named transaction (§4.6).
    const feeTx = describeOutputsOf(await this.d.btc.txHex(f.fee_txid).catch(() => ''));
    const fee = feeTx.filter((x) => x.address === q.escrow_btc_fee_address).reduce((s, x) => s + x.amount, 0n);
    if (fee < BigInt(q.escrow_upfront_fee ?? '0')) throw new Definite(`the upfront fee paid to the escrow is ${fee}, less than ${q.escrow_upfront_fee}`);
    const blockTime = await this.d.btc.tipTime();
    return { uses: [`btc:${f.txid}:${f.vout ?? 0}`, `fee:${f.fee_txid}`], confirmedAt: blockTime, outpoint: { txid: f.txid, vout: f.vout ?? 0, amount: out.value.toString() } };
  }

  private async checkSafeFunding(o: NodeOrder): Promise<Funding> {
    const f = o.funded as Extract<OrderFunded, { asset: 'usdc-evm' }>;
    const q = o.quote!;
    const evm = this.evm();
    if (!sameAddr(f.safe, q.escrow_address)) throw new Definite(`safe ${f.safe} is not the quoted ${q.escrow_address}`);
    const safe = f.safe as `0x${string}`;
    for (const h of [f.deploy_tx, f.fund_tx, f.fee_tx]) {
      const ok = await evm.receiptOk(h as Hex);
      if (ok === undefined) throw new NotYet(`${h} not mined yet`);
      if (!ok) throw new Definite(`${h} reverted`);
    }
    const st = await evm.safeState(safe);
    const owners = st.owners.map((a) => a.toLowerCase());
    const want = [o.request.user_evm_address!, q.shopper_evm_address!, q.escrow_evm_address!].map((a) => a.toLowerCase());
    if (owners.length !== 3 || !want.every((a) => owners.includes(a)) || st.threshold !== 2n) throw new Definite('the Safe is not the 2-of-3 of user, shopper and escrow');
    if (!st.moduleEnabled) throw new Definite('the escrow module is not enabled on the Safe');
    const cfg = st.config;
    if (!sameAddr(cfg.token, evm.deployments.usdc) || !sameAddr(cfg.user, o.request.user_evm_address) || !sameAddr(cfg.shopper, q.shopper_evm_address)
      || Number(cfg.t1) !== q.timelock!.t1 || Number(cfg.t2) !== q.timelock!.t2) throw new Definite('the module is registered with other parties or timelocks');
    const into = await evm.usdcTransferredIn(f.fund_tx as Hex, safe);
    if (into < BigInt(q.lock_amount!)) throw new Definite(`fund_tx moves ${into} into the Safe, less than lock_amount ${q.lock_amount}`);
    const fee = await evm.usdcTransferredIn(f.fee_tx as Hex, q.escrow_evm_address as `0x${string}`);
    if (fee < BigInt(q.escrow_upfront_fee ?? '0')) throw new Definite(`fee_tx pays the escrow ${fee}, less than ${q.escrow_upfront_fee}`);
    const confirmedAt = Number(await evm.blockTimestamp());
    return { uses: [`safe:${safe.toLowerCase()}`, `fee:${f.fee_tx}`], confirmedAt, safe };
  }

  // ---------- purchase (§9) ----------

  private async startPurchase(id: string): Promise<void> {
    let o = await this.order(id);
    if (!o) return;
    if (o.state === 'funded') {
      const left = o.quote!.asset === 'btc-signet'
        ? (o.quote!.timelock!.t1 - (await this.d.btc.tipHeight())) * 600
        : o.quote!.timelock!.t1 - Number(await this.evm().blockTimestamp());
      if (left < SHOPPER_CONFIG.minT1RemainingSeconds) return this.abandon(id, `only ${left} s left until T1, ${SHOPPER_CONFIG.minT1RemainingSeconds} s needed`);
      o = await this.update(id, (cur) => {
        if (cur.state !== 'funded') return false;
        this.set(cur, 'purchasing');
      });
      if (!o) return;
    } else if (o.state !== 'purchasing') return;
    const address = await this.openAddress(o);
    const q = o.quote!;
    const max = q.price!.items.currency === q.price!.shipping.currency
      ? { amount: fmt(decimalToUnits(q.price!.items.amount, decimalsOf(q.price!.items.currency)) + decimalToUnits(q.price!.shipping.amount, decimalsOf(q.price!.items.currency)), q.price!.items.currency), currency: q.price!.items.currency }
      : q.price!.items;
    const res = this.d.shops.purchase({
      request_id: o.id, shop_url: o.request.shop_url, items: o.request.items, shipping: address,
      payment_ref: o.shop?.cashOnly ? 'cash' : 'card:default', max_amount: max,
    });
    if (res.status === 'ok' && (!res.total || !(Number(res.total.amount) > 0))) {
      res.status = 'needs_human';
      res.error = 'the bot reported no valid total';
    }
    if (res.status === 'ok') {
      const evidence: Evidence[] = res.evidence.filter((e) => !e.data_b64 || e.data_b64.length < 4096);
      await this.send(o, o.user, MSG.purchased, { shop_order_id: res.shop_order_id!, total: res.total!, evidence });
      await this.update(id, (cur) => {
        cur.purchase = res;
        if (cur.state === 'purchasing') this.set(cur, 'purchased', res.shop_order_id);
        else this.note(cur, `purchased ${res.shop_order_id}`);
      });
    } else if (res.status === 'needs_human') {
      await this.update(id, (cur) => {
        cur.purchase = res;
        if (cur.state === 'purchasing') this.set(cur, 'needs_human', res.error);
        else this.note(cur, `bot needs a human: ${res.error}`);
      });
    } else {
      await this.update(id, (cur) => {
        cur.purchase = res;
      });
      await this.abandon(id, `bot: ${res.error}`);
    }
  }

  /** purchase_failed, with a cooperative refund offered (orders that moved on keep their state). */
  private async abandon(id: string, reason: string): Promise<void> {
    const o = await this.update(id, (cur) => {
      if (cur.state !== 'funded' && cur.state !== 'purchasing' && cur.state !== 'needs_human') {
        this.note(cur, `not buying: ${reason}`);
        return;
      }
      this.set(cur, 'purchase_failed', reason);
      if (this.funded(cur)) cur.pending.refund = { since: nowSeconds(), attempts: 0, next: 0 };
    });
    if (o) this.kick(id);
  }

  /** POST /orders/{id}/resolve {"action":"refund"}: a human decided not to buy. */
  async resolveRefund(id: string): Promise<NodeOrder | undefined> {
    const o = await this.order(id);
    if (!o) throw new Error('unknown order');
    if (o.state !== 'needs_human') throw new Error('order is not waiting for a human');
    await this.abandon(id, 'not bought (resolved by hand)');
    return this.order(id);
  }

  private async pollTracking(): Promise<void> {
    for (const o of await this.orders()) {
      if (!o.purchase?.shop_order_id || TERMINAL.has(o.state) || o.ship_status === 'delivered' || o.ship_status === 'failed') continue;
      let st: TrackingStatus;
      try {
        st = this.d.shops.tracking(o.purchase.shop_order_id);
      } catch {
        continue;
      }
      if (st.status === o.ship_status || st.status === 'processing') continue;
      const cur = await this.update(o.id, (c) => {
        if (c.ship_status === st.status) return false;
        c.ship_status = st.status;
        c.tracking.push(st);
        if (TERMINAL.has(c.state) || c.state === 'disputed') return;
        if (st.status === 'shipped') this.set(c, 'shipped', st.tracking_no);
        else if (st.status === 'delivered') this.set(c, 'delivered', st.tracking_no);
        else if (st.status === 'failed') this.set(c, 'shipping_failed');
      });
      if (cur) await this.send(cur, cur.user, MSG.shipping, { status: st.status as 'shipped' | 'delivered' | 'failed', tracking: st });
    }
  }

  // ---------- evidence (§4.7) ----------

  private async sendEvidence(id: string): Promise<void> {
    const o = await this.order(id);
    if (!o) return;
    const ev: DisputeEvidence = {
      messages: o.messages.filter((m) => !CONTAINER_TYPES.includes(innerMeta(m).type)),
      tracking: o.tracking,
      purchase_evidence: (o.purchase?.evidence ?? []).map((e) => ({ kind: e.kind, sha256: e.sha256, mime: e.mime })),
      delivery_key_for_escrow: o.escrowKey,
    };
    const { parts } = splitEvidence(ev);
    for (const part of parts) await this.send(o, o.request.escrow, MSG.evidence, part);
    await this.update(id, (cur) => this.note(cur, `evidence sent to the escrow: ${parts.length} message(s)`));
  }

  // ---------- pending actions ----------

  private kick(id: string): void {
    this.background('work', id, () => this.work(id));
  }

  private async retryPending(): Promise<void> {
    const now = nowSeconds();
    for (const o of await this.orders()) {
      if (Object.values(o.pending).some((a) => a && a.next <= now)) this.kick(o.id);
    }
  }

  private async work(id: string): Promise<void> {
    if (this.paused) return;
    for (const kind of ACTION_ORDER) {
      const o = await this.order(id);
      if (!o) return;
      const a = o.pending[kind];
      if (!a || a.next > nowSeconds()) continue;
      let err: unknown;
      try {
        await this.run(o, kind, a);
      } catch (e) {
        err = e;
      }
      await this.update(id, (cur) => {
        const p = cur.pending[kind];
        if (!p) return false;
        if (!err) {
          delete cur.pending[kind];
          return;
        }
        const msg = (err as Error).message;
        const since = nowSeconds() - p.since;
        if (err instanceof Definite || (!p.tx && since > 7 * 86400)) {
          delete cur.pending[kind];
          cur.error = `${kind}: ${msg}`;
          this.note(cur, `${kind} abandoned: ${msg}`);
        } else {
          p.attempts++;
          p.error = msg;
          p.next = nowSeconds() + Math.min(60, 3 * 2 ** Math.min(p.attempts - 1, 5));
          this.note(cur, `${kind} failed, will retry: ${msg}`);
        }
      });
    }
  }

  private async run(o: NodeOrder, kind: ActionKind, a: Action): Promise<void> {
    switch (kind) {
      case 'quote': return this.doQuote(o);
      case 'refund': return this.offerRefund(o);
      case 'release': return this.payout(o, 'release', a);
      case 'ruling': return this.payout(o, 'ruling', a);
      case 'claim': return this.payout(o, 'claim', a);
    }
  }

  /** order.refund signed by us (after a failed purchase): everything minus the reserve back to the user. */
  private async offerRefund(o: NodeOrder): Promise<void> {
    if (!this.funded(o)) throw new Definite('the escrow is no longer open');
    const q = o.quote!;
    let body: SignedPayout;
    if (q.asset === 'btc-signet') {
      const op = o.outpoint!;
      const tx = buildEscrowSpend({
        outpoint: { txid: op.txid, vout: op.vout, amount: BigInt(op.amount) }, witnessScript: this.script(o),
        outputs: [{ address: o.request.user_btc_address!, amount: BigInt(op.amount) - BigInt(q.payout_fee_reserve ?? '0') }],
      });
      signEscrowInput(tx, this.s.keys.orderKey(o.id).privateKey);
      body = { asset: 'btc-signet', psbt: psbtToBase64(tx) };
    } else {
      const evm = this.evm();
      const safe = o.safe as `0x${string}`;
      const tx = releaseSafeTx({ usdc: evm.deployments.usdc, to: o.request.user_evm_address as `0x${string}`, amount: await evm.usdcBalance(safe), nonce: await evm.safeNonce(safe) });
      body = { asset: 'usdc-evm', safe_tx: safeTxToJson(tx), signature: await signSafeTx(this.s.keys.evmAccount, tx, evm.chainId, safe) };
    }
    await this.send(o, o.user, MSG.refund, body);
    await this.update(o.id, (cur) => this.note(cur, 'cooperative refund offered'));
  }

  /** Countersign a release or ruling, or claim after T1; broadcast (BTC) or execute (USDC, we pay the gas). */
  private async payout(o: NodeOrder, kind: 'release' | 'ruling' | 'claim', a: Action): Promise<void> {
    if (a.tx) {
      // Sent before (a retry after a reload): finished once the chain knows it.
      if (o.quote!.asset === 'btc-signet' ? await this.d.btc.txStatus(a.tx).then(() => true, () => false) : (await this.evm().receiptOk(a.tx as Hex)) === true) {
        return this.finish(o.id, kind, a.tx);
      }
    }
    if (!this.funded(o)) throw new Definite('the escrow is no longer open');
    const q = o.quote!;
    const body = a.inner ? (JSON.parse(a.inner.content) as SignedPayout & DisputeRuling) : undefined;
    let txid: string;
    if (q.asset === 'btc-signet') {
      const op = o.outpoint!;
      const outpoint = { txid: op.txid, vout: op.vout, amount: BigInt(op.amount) };
      const reserve = BigInt(q.payout_fee_reserve ?? '0');
      const keys = this.escrowKeys(o);
      let tx;
      if (kind === 'claim') {
        tx = buildEscrowSpend({ outpoint, witnessScript: this.script(o), outputs: [{ address: q.shopper_btc_address!, amount: outpoint.amount - reserve }], lockTime: q.timelock!.t1 });
        signEscrowInput(tx, this.s.keys.orderKey(o.id).privateKey);
        finalizeEscrowInput(tx, keys, 'shopper-after-t1');
      } else {
        if (!body?.psbt) throw new Definite(`${kind} without psbt`);
        tx = psbtFromBase64(body.psbt);
        if (kind === 'release') {
          const problems = btcPayoutProblems(tx, { outpoint, witnessScript: this.script(o), outputs: { exact: [{ address: q.shopper_btc_address!, amount: outpoint.amount - reserve }] }, maxFee: reserve, signer: keys.user });
          if (problems.length) throw new Definite(problems.join('; '));
        } else {
          this.checkRulingSplit(o, body, outpoint.amount - reserve);
          const want = new Map<string, bigint>();
          const add = (addr: string, v: string) => BigInt(v) > 0n && want.set(addr, (want.get(addr) ?? 0n) + BigInt(v));
          add(o.request.user_btc_address!, body.split.user);
          add(q.shopper_btc_address!, body.split.shopper);
          add(q.escrow_btc_fee_address!, body.split.escrow_fee);
          const outs = describeOutputs(tx);
          const got = new Map<string, bigint>();
          for (const x of outs) got.set(x.address ?? '?', (got.get(x.address ?? '?') ?? 0n) + x.amount);
          const same = got.size === want.size && [...want].every(([k, v]) => got.get(k) === v);
          const problems = btcPayoutProblems(tx, { outpoint, witnessScript: this.script(o), outputs: { only: [...want.keys()] }, maxFee: reserve, signer: keys.escrow });
          if (!same) problems.push('ruling outputs differ from its split');
          if (problems.length) throw new Definite(problems.join('; '));
        }
        signEscrowInput(tx, this.s.keys.orderKey(o.id).privateKey);
        finalizeEscrowInput(tx, keys, 'multisig');
      }
      const ext = extractTx(tx);
      await this.update(o.id, (cur) => {
        const p = cur.pending[kind];
        if (p) p.tx = ext.txid;
      });
      try {
        txid = await this.d.btc.broadcast(ext.hex);
      } catch (err) {
        await this.update(o.id, (cur) => {
          const p = cur.pending[kind];
          if (p) p.tx = undefined;
        });
        const m = (err as Error).message;
        throw /non-final/.test(m) ? new Error(m) : new Definite(m);
      }
    } else {
      const evm = this.evm();
      const safe = o.safe as `0x${string}`;
      if (kind === 'claim') {
        txid = await evm.claimByShopper(safe);
      } else {
        if (!body?.safe_tx || !body.signature) throw new Definite(`${kind} without safe_tx`);
        const tx = safeTxFromJson(body.safe_tx);
        const [nonce, balance] = await Promise.all([evm.safeNonce(safe), evm.usdcBalance(safe)]);
        const lock = BigInt(q.lock_amount!);
        const signer = kind === 'release' ? o.request.user_evm_address! : q.escrow_evm_address!;
        let problems: string[];
        if (kind === 'release') {
          problems = safePayoutProblems(tx, { usdc: evm.deployments.usdc, multiSend: evm.deployments.safe.multisend_call_only, nonce, balance, lock, transfers: { exact: [{ to: q.shopper_evm_address!, amount: lock }] } });
        } else {
          this.checkRulingSplit(o, body, undefined, lock, balance);
          problems = safePayoutProblems(tx, { usdc: evm.deployments.usdc, multiSend: evm.deployments.safe.multisend_call_only, nonce, balance, lock, transfers: { only: [o.request.user_evm_address!, q.shopper_evm_address!, q.escrow_evm_address!] } });
          const want = new Map<string, bigint>();
          const add = (addr: string, v: string) => BigInt(v) > 0n && want.set(addr.toLowerCase(), (want.get(addr.toLowerCase()) ?? 0n) + BigInt(v));
          add(o.request.user_evm_address!, body.split.user);
          add(q.shopper_evm_address!, body.split.shopper);
          add(q.escrow_evm_address!, body.split.escrow_fee);
          const got = new Map<string, bigint>();
          try {
            for (const t of safeTxTransfers(tx, evm.deployments.usdc, evm.deployments.safe.multisend_call_only)) got.set(t.to.toLowerCase(), (got.get(t.to.toLowerCase()) ?? 0n) + t.amount);
          } catch {
            /* reported by safePayoutProblems */
          }
          if (got.size !== want.size || ![...want].every(([k, v]) => got.get(k) === v)) problems.push('ruling transfers differ from its split');
        }
        const recovered = await recoverSafeTxSigner(tx, evm.chainId, safe, body.signature as Hex).catch(() => undefined);
        if (!sameAddr(recovered, signer)) problems.push(`the SafeTx is not signed by ${signer} (hash ${safeTxHash(tx, evm.chainId, safe).slice(0, 12)}…)`);
        if (problems.length) throw new Definite(problems.join('; '));
        const mine = await signSafeTx(this.s.keys.evmAccount, tx, evm.chainId, safe);
        txid = await evm.execSafeTx(safe, tx, [{ signer: signer as `0x${string}`, signature: body.signature as Hex }, { signer: this.s.keys.evmAddress, signature: mine }]);
      }
    }
    await this.finish(o.id, kind, txid);
  }

  /** §4.8: the split sums to what the escrow divides, and its fee is within the escrow's dispute_fee_bps. */
  private checkRulingSplit(o: NodeOrder, r: DisputeRuling, btcDivided?: bigint, lock?: bigint, balance?: bigint): void {
    const parts = [r.split.user, r.split.shopper, r.split.escrow_fee];
    if (!parts.every((p) => /^\d+$/.test(p))) throw new Definite('split amounts must be integers');
    const [u, s, f] = parts.map(BigInt);
    const sum = u + s + f;
    const esc = this.s.directory.current?.escrows.get(o.request.escrow)?.content;
    if (!esc) throw new Definite('no profile of the escrow to check its dispute fee');
    if (f > (sum * BigInt(esc.dispute_fee_bps)) / 10000n) throw new Definite(`escrow fee ${f} exceeds ${esc.dispute_fee_bps} bps of ${sum}`);
    if (btcDivided !== undefined && sum !== btcDivided) throw new Definite(`split sums to ${sum}, escrow holds ${btcDivided} after the reserve`);
    if (lock !== undefined && (sum < lock || sum > (balance ?? lock))) throw new Definite(`split sums to ${sum}, not between the lock ${lock} and the safe balance ${balance}`);
  }

  private async finish(id: string, kind: 'release' | 'ruling' | 'claim', txid: string): Promise<void> {
    const o = await this.update(id, (cur) => {
      if (cur.payout_tx) return false;
      cur.payout_tx = txid;
      cur.payout_by = kind === 'claim' ? 'timelock' : kind;
      this.set(cur, kind === 'release' ? 'completed' : kind === 'ruling' ? 'settled' : 'claimed', txid);
    });
    if (!o) return;
    if (kind === 'ruling') {
      for (const to of [o.user, o.request.escrow]) await this.send(o, to, MSG.countersigned, { txid });
    } else {
      await this.send(o, o.user, MSG.completed, { txid });
    }
  }

  // ---------- watching the escrows ----------

  private async watchEscrows(): Promise<void> {
    for (const o of await this.orders()) {
      if (!this.funded(o)) continue;
      const q = o.quote!;
      let spentBy: string | undefined;
      let spent = false;
      if (q.asset === 'btc-signet') {
        const sp = await this.d.btc.outspend(o.outpoint!.txid, o.outpoint!.vout).catch(() => undefined);
        if (sp?.spent) [spent, spentBy] = [true, sp.txid];
      } else {
        const evm = this.evm();
        const bal = await evm.usdcBalance(o.safe as `0x${string}`).catch(() => undefined);
        if (bal !== undefined && bal < BigInt(q.lock_amount!)) {
          spent = true;
          const hint = Object.values(o.pending).find((a) => a?.tx)?.tx ?? o.claimedPayout;
          if (hint && (await evm.usdcTransferredFrom(hint as Hex, o.safe as `0x${string}`).catch(() => 0n)) > 0n) spentBy = hint;
        }
      }
      if (spent) {
        if (Object.values(o.pending).some((a) => a?.tx && (!spentBy || a.tx.toLowerCase() === spentBy.toLowerCase()))) {
          this.kick(o.id);
          continue;
        }
        await this.update(o.id, (cur) => {
          if (cur.payout_tx || TERMINAL.has(cur.state)) return false;
          if (cur.ruling && cur.claimedPayout && spentBy && cur.claimedPayout.toLowerCase() === spentBy.toLowerCase()) {
            cur.payout_tx = spentBy;
            cur.payout_by = 'ruling';
            this.set(cur, 'settled', `ruling countersigned by the user: ${spentBy}`);
            return;
          }
          cur.payout_tx = spentBy ?? '(safe emptied)';
          cur.payout_by = 'other';
          this.set(cur, 'closed', `escrow spent ${spentBy ?? ''}`.trim());
        });
        continue;
      }
      // A delivered order nobody released by T1 is claimed alone (§5.1 T1 branch, §6.3 claimByShopper).
      if (o.ship_status !== 'delivered' || o.pending.ruling || o.pending.claim) continue;
      const now = q.asset === 'btc-signet' ? await this.d.btc.tipHeight() : Number(await this.evm().blockTimestamp());
      if (now < q.timelock!.t1) continue;
      const cur = await this.update(o.id, (c) => {
        if (!this.funded(c) || c.pending.claim) return false;
        c.pending.claim = { since: nowSeconds(), attempts: 0, next: 0 };
      });
      if (cur) this.kick(o.id);
    }
  }
}

/** Outputs of a raw transaction ('' → none). */
function describeOutputsOf(hex: string): Array<{ address?: string; amount: bigint }> {
  if (!hex) return [];
  try {
    return describeOutputs(psbtlessTx(hex));
  } catch {
    return [];
  }
}

const psbtlessTx = (hex: string) => Transaction.fromRaw(fromHex(hex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
