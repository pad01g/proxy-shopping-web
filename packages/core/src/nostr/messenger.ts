import type { NostrEvent } from 'nostr-tools/pure';
import type { IdentitySigner } from '../keys/signer.js';
import type { Storage } from '../storage/types.js';
import { Emitter } from '../util/emitter.js';
import { isAllowedEndpoint } from '../util/endpoint.js';
import { KeyedMutex, nowSeconds } from '../util/time.js';
import { giftWrap, innerMeta, signInner, unwrap, type Inner } from './giftwrap.js';
import { KIND, tagValues } from './kinds.js';
import { MAX_INNER_BYTES, MSG } from './messages.js';
import { parseBody } from './schema.js';
import { unique, type NostrTransport, type PublishResult, type Subscription } from './transport.js';
import { latestByAddress } from '../trust/versions.js';
import { verified } from '../trust/events.js';

export interface IncomingMessage<T = unknown> {
  inner: Inner;
  from: string;
  orderId: string;
  type: string;
  body: T;
}

interface OutboxEntry {
  inner: Inner;
  wrap: NostrEvent;
  recipient: string;
  relays: string[];
  firstSentAt: number;
  lastSentAt: number;
  acked: boolean;
  /** Resends so far; resends 1, 2, 4, 8, … get a fresh wrap (see `rewrap`). */
  resends?: number;
}

/**
 * How the roles see an incoming message (§4.10):
 *   'counterparty' — from a party of something we track (an order, a case); per-sender limit only.
 *   'stranger'     — no relation yet, but a role takes it (a dispute naming us, a report); also counts
 *                    against the shared limit for strangers.
 *   'reject'       — no role wants it: neither stored nor acked.
 */
export type Acceptance = 'counterparty' | 'stranger' | 'reject';
export type AcceptFn = (inner: Inner, meta: ReturnType<typeof innerMeta>) => Acceptance | Promise<Acceptance>;

interface InboxEntry {
  inner: Inner;
  receivedAt: number;
}

export interface MessengerOptions {
  signer: IdentitySigner;
  transport: NostrTransport;
  storage: Storage;
  /** Our own inbox relays (also used as fallback for peers without kind 10050). */
  relays: string[];
  /** Minimum relays per send (§4.2, default 2). */
  k?: number;
  retryIntervalMs?: number;
  maxRetryAgeMs?: number;
  /** Lab only: accept ws:// and private / loopback relays in peers' kind 10050 (§4.10). */
  allowPrivateRelays?: boolean;
  /** Messages accepted per sender per minute after EOSE before further ones are dropped (§4.10, browser 120). */
  maxPerSenderPerMinute?: number;
  /** Messages per minute from all senders that are not counterparties, together (§4.10, 60). */
  maxStrangersPerMinute?: number;
  /**
   * Stored wraps accepted while catching up (before EOSE and while paging older ones), per sender and for
   * all strangers together. Higher than the live limits: a fresh device sees its whole history at once.
   */
  maxBacklogPerSender?: number;
  maxBacklogStrangers?: number;
  /** Which messages some role accepts; without it every message is treated as from a counterparty. */
  accepts?: AcceptFn;
}

/** Stored gift wraps fetched per page when the inbox subscription starts (the rest arrive live, §4.10). */
export const BACKLOG_LIMIT = 1000;
/** Further pages of older wraps read when the first page was full, so a flood cannot push older messages out. */
const BACKLOG_EXTRA_PAGES = 4;
/** Give up waiting for EOSE after this long and treat what follows as live. */
const EOSE_TIMEOUT_MS = 10_000;

type Events = {
  message: IncomingMessage;
  acked: { id: string };
  /** A message that unwrapped fine but whose body does not fit its schema (§4.10), was rate limited, or no role accepts. */
  dropped: { inner: Inner; reason: string };
  error: Error;
};

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
/** §4.10: only the first 8 inbox relays of a peer are used. */
export const MAX_PEER_RELAYS = 8;
const MAP_LIMIT = 5000;

function parseInner(type: string, inner: Inner): unknown {
  try {
    return parseBody(type, JSON.parse(inner.content));
  } catch {
    return undefined;
  }
}

/** A new wrap on resends 1, 2, 4, 8, … (like the Go node): relays do not pass an event they already have to
 * live subscribers again, so a recipient that missed (or rate limited) the first wrap needs a new event. */
export const rewrap = (resend: number): boolean => resend > 0 && (resend & (resend - 1)) === 0;

/** Drop the oldest entries of an insertion-ordered map once it grows past `limit`. */
function trim<K, V>(m: Map<K, V>, limit = MAP_LIMIT): void {
  for (const k of m.keys()) {
    if (m.size <= limit) break;
    m.delete(k);
  }
}

/**
 * Gift-wrapped 1:1 messaging with ack/retry/dedupe (spec §4.1, §4.2).
 * Outbox and inbox are persisted so a reloaded browser resumes retries.
 */
export class Messenger extends Emitter<Events> {
  private readonly signer: IdentitySigner;
  private readonly transport: NostrTransport;
  private readonly store: Storage;
  private readonly k: number;
  private readonly retryIntervalMs: number;
  private readonly maxRetryAgeMs: number;
  private relays: string[];
  private sub?: Subscription;
  private timer?: ReturnType<typeof setInterval>;
  private inboxCache = new Map<string, { relays: string[]; at: number }>();
  private me?: string;
  private readonly lock = new KeyedMutex();
  private readonly lastAck = new Map<string, number>();
  private readonly allowPrivateRelays: boolean;
  private readonly perMinute: number;
  private readonly strangersPerMinute: number;
  private readonly backlogPerSender: number;
  private readonly backlogStrangers: number;
  private readonly accepts?: AcceptFn;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly backlogCounts = new Map<string, number>();
  /** Set once the relays sent their stored events; stays set across resubscriptions (setRelays). */
  private live = false;
  /** Inner ids whose body failed its schema (so relay copies are not re-reported). */
  private readonly dropped = new Set<string>();

  constructor(opts: MessengerOptions) {
    super();
    this.signer = opts.signer;
    this.transport = opts.transport;
    this.store = opts.storage;
    this.relays = unique(opts.relays);
    this.k = opts.k ?? 2;
    this.retryIntervalMs = opts.retryIntervalMs ?? 30_000;
    this.maxRetryAgeMs = opts.maxRetryAgeMs ?? SEVEN_DAYS_MS;
    this.allowPrivateRelays = opts.allowPrivateRelays ?? false;
    this.perMinute = opts.maxPerSenderPerMinute ?? 120;
    this.strangersPerMinute = opts.maxStrangersPerMinute ?? 60;
    this.backlogPerSender = opts.maxBacklogPerSender ?? this.perMinute * 10;
    this.backlogStrangers = opts.maxBacklogStrangers ?? this.strangersPerMinute * 10;
    this.accepts = opts.accepts;
  }

  get running(): boolean {
    return this.sub !== undefined;
  }

  async pubkey(): Promise<string> {
    return (this.me ??= await this.signer.getPublicKey());
  }

  setRelays(relays: string[]): void {
    this.relays = unique(relays);
    if (this.running) {
      // Resubscribe without a new catch-up window: what the new relays replay counts as live (§4.10).
      this.sub?.close();
      this.sub = undefined;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      void this.start();
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    const me = await this.pubkey();
    // Stored events come first. A fresh device (or a memory store) sees all of them as new, so until EOSE
    // the higher backlog limits apply instead of the per-minute ones.
    const catchingUp = !this.live;
    let received = 0;
    let oldest = Infinity;
    const goLive = () => {
      clearTimeout(eoseTimer);
      if (this.live) return;
      this.live = true;
      if (catchingUp && received >= BACKLOG_LIMIT) void this.readOlder(me, oldest).catch((err) => this.emit('error', err as Error));
    };
    const eoseTimer = setTimeout(goLive, EOSE_TIMEOUT_MS);
    this.sub = this.transport.subscribe(
      this.relays,
      { kinds: [KIND.giftWrap], '#p': [me], limit: BACKLOG_LIMIT },
      (e) => {
        const live = this.live;
        if (!live) {
          received++;
          oldest = Math.min(oldest, e.created_at);
        }
        void this.handleWrap(e, live).catch((err) => this.emit('error', err as Error));
      },
      goLive,
    );
    this.timer = setInterval(() => void this.retryDue(), Math.min(this.retryIntervalMs, 5_000));
  }

  /**
   * The first page of stored wraps was full: read older pages too (bounded), so a flood of wraps cannot
   * push a real message out of the window we read at start.
   */
  private async readOlder(me: string, until: number): Promise<void> {
    for (let page = 0; page < BACKLOG_EXTRA_PAGES && Number.isFinite(until); page++) {
      const events = await this.transport.query(this.relays, { kinds: [KIND.giftWrap], '#p': [me], until, limit: BACKLOG_LIMIT });
      for (const e of events) await this.handleWrap(e, false).catch((err) => this.emit('error', err as Error));
      if (events.length < BACKLOG_LIMIT) return;
      // `until` is inclusive; events sharing the boundary second are deduplicated by inner id.
      const next = Math.min(...events.map((e) => e.created_at));
      until = next < until ? next : until - 1;
    }
  }

  stop(): void {
    this.sub?.close();
    this.sub = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Publish our kind 10050 inbox relay list. */
  async publishInboxRelays(): Promise<NostrEvent> {
    const ev = await this.signer.signEvent({
      kind: KIND.inboxRelays,
      created_at: nowSeconds(),
      tags: this.relays.map((r) => ['relay', r]),
      content: '',
    });
    await this.transport.publish(this.relays, ev);
    return ev;
  }

  /**
   * Relays where `pubkey` reads its messages (kind 10050, else our relays). The list is chosen by
   * the peer, so only its first 8 wss:// relays on public hosts are used (§4.10).
   */
  async inboxRelaysOf(pubkey: string): Promise<string[]> {
    const cached = this.inboxCache.get(pubkey);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.relays;
    const events = await this.transport.query(this.relays, { kinds: [KIND.inboxRelays], authors: [pubkey] }, { maxWaitMs: 2500 });
    const latest = latestByAddress(events.filter((e) => e.pubkey === pubkey && verified(e)), { requireVersion: false })[0];
    const listed = latest ? this.usableRelays(tagValues(latest.tags, 'relay')) : [];
    const relays = listed.length ? listed : this.relays;
    this.inboxCache.set(pubkey, { relays, at: Date.now() });
    trim(this.inboxCache, 1000);
    return relays;
  }

  /** A peer-supplied relay list reduced to what we are willing to connect to. */
  usableRelays(urls: string[]): string[] {
    const policy = { allowPrivate: this.allowPrivateRelays };
    return unique(urls).filter((u) => isAllowedEndpoint(u, 'ws', policy)).slice(0, MAX_PEER_RELAYS);
  }

  /** Sign an inner and send it; retried until acked (acks themselves are fire-and-forget). */
  async send(recipient: string, orderId: string, type: string, body: unknown): Promise<Inner> {
    const inner = await this.sign(recipient, orderId, type, body);
    await this.sendInner(inner);
    return inner;
  }

  /** Sign an inner without sending it, so the caller can store it first (replies may beat the publish). */
  async sign(recipient: string, orderId: string, type: string, body: unknown): Promise<Inner> {
    const inner = await signInner(this.signer, { recipient, orderId, type, body });
    const size = new TextEncoder().encode(JSON.stringify(inner)).length;
    if (size > MAX_INNER_BYTES) throw new Error(`${type} message is ${size} bytes, over the ${MAX_INNER_BYTES} byte limit (§4.9)`);
    return inner;
  }

  /** Send an already signed inner (e.g. one re-sent after reload). */
  async sendInner(inner: Inner): Promise<void> {
    const { recipient, type } = innerMeta(inner);
    const wrap = await giftWrap(this.signer, inner, recipient);
    // publishWrap reaches k of these, trying the next ones only when some fail (§4.2, §4.10).
    const relays = await this.inboxRelaysOf(recipient);
    const now = Date.now();
    if (type !== MSG.ack) {
      await this.store.put<OutboxEntry>(`outbox/${inner.id}`, {
        inner, wrap, recipient, relays, firstSentAt: now, lastSentAt: now, acked: false, resends: 0,
      });
    }
    await this.publishWrap(wrap, relays);
  }

  async pending(): Promise<Inner[]> {
    const rows = await this.store.list<OutboxEntry>('outbox/');
    return rows.filter(([, e]) => !e.acked).map(([, e]) => e.inner);
  }

  async isAcked(innerId: string): Promise<boolean> {
    return (await this.store.get<OutboxEntry>(`outbox/${innerId}`))?.acked ?? false;
  }

  /** All received inners, oldest first. */
  async inbox(): Promise<Inner[]> {
    const rows = await this.store.list<InboxEntry>('inbox/');
    return rows.map(([, e]) => e.inner).sort((a, b) => a.created_at - b.created_at);
  }

  /** Publish to the first k relays; for each one that fails, try the next of the list (§4.2: k relays, not all). */
  private async publishWrap(wrap: NostrEvent, relays: string[]): Promise<void> {
    const needed = Math.min(this.k, relays.length);
    const ok: string[] = [];
    const failed: PublishResult['failed'] = [];
    let rest = relays;
    while (ok.length < needed && rest.length) {
      const batch = rest.slice(0, needed - ok.length);
      rest = rest.slice(batch.length);
      const res = await this.transport.publish(batch, wrap);
      ok.push(...res.ok);
      failed.push(...res.failed);
    }
    if (ok.length < needed) {
      const reasons = failed.map((f) => `${f.relay}: ${f.reason}`).join('; ');
      // Not fatal: the retry loop will try again. Surface it for the UI.
      this.emit('error', new Error(`sent to ${ok.length}/${needed} relays (${reasons})`));
    }
  }

  private async retryDue(): Promise<void> {
    const now = Date.now();
    for (const [key, e] of await this.store.list<OutboxEntry>('outbox/')) {
      if (e.acked || now - e.firstSentAt > this.maxRetryAgeMs) continue;
      if (now - e.lastSentAt < this.retryIntervalMs) continue;
      const resends = (e.resends ?? 0) + 1;
      try {
        // The recipient may have published other inbox relays since.
        const relays = await this.inboxRelaysOf(e.recipient).catch(() => e.relays);
        const wrap = rewrap(resends) ? await giftWrap(this.signer, e.inner, e.recipient) : e.wrap;
        await this.store.put<OutboxEntry>(key, { ...e, wrap, relays, resends, lastSentAt: now });
        await this.publishWrap(wrap, relays);
      } catch (err) {
        this.emit('error', err as Error);
      }
    }
  }

  private async handleWrap(wrap: NostrEvent, live = true): Promise<void> {
    let inner: Inner;
    try {
      inner = await unwrap(this.signer, wrap);
    } catch {
      return; // not for us, or forged: ignore silently
    }
    const meta = innerMeta(inner);
    if (meta.type === MSG.ack) {
      // Acks only ever flip our own outbox entries (and only from their recipient), so the per-sender limit is enough.
      const body = this.admit(inner.pubkey, 'counterparty', live) ? parseInner(meta.type, inner) : undefined;
      if (body) await this.handleAck(inner, body as { ids: string[] });
      return;
    }
    const key = `inbox/${inner.id}`;
    let body: unknown;
    // The same wrap usually arrives from several relays at once: decide once per inner id.
    const verdict = await this.lock.run(inner.id, async () => {
      if (this.dropped.has(inner.id) || (await this.store.get<InboxEntry>(key))) return 'duplicate';
      const acceptance = this.accepts ? await Promise.resolve(this.accepts(inner, meta)).catch((): Acceptance => 'reject') : 'counterparty';
      // §4.10: what no role accepts is neither stored nor acked (a later resend is looked at again).
      if (acceptance === 'reject') return 'refused';
      if (!this.admit(inner.pubkey, acceptance, live)) return 'limited';
      body = parseInner(meta.type, inner);
      if (body === undefined) {
        this.dropped.add(inner.id);
        if (this.dropped.size > MAP_LIMIT) this.dropped.delete(this.dropped.values().next().value!);
        return 'invalid';
      }
      await this.store.put<InboxEntry>(key, { inner, receivedAt: nowSeconds() });
      return 'new';
    });
    // No ack when rate limited or refused: the sender retries later, which is the back-pressure we want.
    if (verdict === 'limited') return this.emit('dropped', { inner, reason: 'rate limited' });
    if (verdict === 'refused') return this.emit('dropped', { inner, reason: 'no role accepts this message' });
    // Ack everything else, even duplicates (a resend means our previous ack was lost) and invalid
    // bodies (so the sender stops retrying) — but never hand an unchecked body to the roles.
    await this.sendAck(inner);
    if (verdict === 'invalid') this.emit('dropped', { inner, reason: `body of ${meta.type || 'untyped message'} does not match its schema` });
    if (verdict === 'new') this.emit('message', { inner, from: inner.pubkey, orderId: meta.orderId, type: meta.type, body });
  }

  /**
   * §4.10 limits: live messages take a token from the sender's bucket and, from strangers, also from the
   * shared strangers' bucket; stored ones read while catching up count against the (higher) backlog limits.
   */
  private admit(sender: string, acceptance: Exclude<Acceptance, 'reject'>, live: boolean): boolean {
    const stranger = acceptance === 'stranger';
    if (!live) {
      const mine = this.backlogCounts.get(sender) ?? 0;
      const all = this.backlogCounts.get('*strangers') ?? 0;
      if (mine >= this.backlogPerSender || (stranger && all >= this.backlogStrangers)) return false;
      this.backlogCounts.set(sender, mine + 1);
      if (stranger) this.backlogCounts.set('*strangers', all + 1);
      trim(this.backlogCounts);
      return true;
    }
    if (!this.peek(sender, this.perMinute) || (stranger && !this.peek('*strangers', this.strangersPerMinute))) return false;
    this.take(sender, this.perMinute);
    if (stranger) this.take('*strangers', this.strangersPerMinute);
    return true;
  }

  /** Token bucket of `perMinute` messages, refilled continuously: refill and tell whether a token is there. */
  private peek(key: string, perMinute: number): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    this.buckets.delete(key);
    this.buckets.set(key, b);
    trim(this.buckets);
    return b.tokens >= 1;
  }

  private take(key: string, perMinute: number): void {
    if (this.peek(key, perMinute)) this.buckets.get(key)!.tokens -= 1;
  }

  private async handleAck(inner: Inner, { ids }: { ids: string[] }): Promise<void> {
    for (const id of ids) {
      const key = `outbox/${id}`;
      const e = await this.store.get<OutboxEntry>(key);
      // Only the original recipient may ack a message.
      if (!e || e.acked || e.recipient !== inner.pubkey) continue;
      await this.store.put<OutboxEntry>(key, { ...e, acked: true });
      this.emit('acked', { id });
    }
  }

  private async sendAck(inner: Inner): Promise<void> {
    // Copies from several relays arrive together; one ack per burst is enough.
    const last = this.lastAck.get(inner.id) ?? 0;
    if (Date.now() - last < 5_000) return;
    this.lastAck.set(inner.id, Date.now());
    trim(this.lastAck);
    const ack = await signInner(this.signer, {
      recipient: inner.pubkey,
      orderId: innerMeta(inner).orderId,
      type: MSG.ack,
      body: { ids: [inner.id] },
    });
    await this.sendInner(ack);
  }
}
