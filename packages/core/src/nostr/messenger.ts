import type { NostrEvent } from 'nostr-tools/pure';
import type { IdentitySigner } from '../keys/signer.js';
import type { Storage } from '../storage/types.js';
import { Emitter } from '../util/emitter.js';
import { KeyedMutex, nowSeconds } from '../util/time.js';
import { giftWrap, innerBody, innerMeta, signInner, unwrap, type Inner } from './giftwrap.js';
import { KIND, tagValues } from './kinds.js';
import { MAX_INNER_BYTES, MSG } from './messages.js';
import { unique, type NostrTransport, type Subscription } from './transport.js';
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
}

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
}

type Events = {
  message: IncomingMessage;
  acked: { id: string };
  error: Error;
};

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;

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

  constructor(opts: MessengerOptions) {
    super();
    this.signer = opts.signer;
    this.transport = opts.transport;
    this.store = opts.storage;
    this.relays = unique(opts.relays);
    this.k = opts.k ?? 2;
    this.retryIntervalMs = opts.retryIntervalMs ?? 30_000;
    this.maxRetryAgeMs = opts.maxRetryAgeMs ?? SEVEN_DAYS_MS;
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
      this.sub?.close();
      this.sub = undefined;
      void this.start();
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    const me = await this.pubkey();
    this.sub = this.transport.subscribe(this.relays, { kinds: [KIND.giftWrap], '#p': [me] }, (e) => {
      void this.handleWrap(e).catch((err) => this.emit('error', err as Error));
    });
    this.timer = setInterval(() => void this.retryDue(), Math.min(this.retryIntervalMs, 5_000));
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

  /** Relays where `pubkey` reads its messages (kind 10050, else our relays). */
  async inboxRelaysOf(pubkey: string): Promise<string[]> {
    const cached = this.inboxCache.get(pubkey);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.relays;
    const events = await this.transport.query(this.relays, { kinds: [KIND.inboxRelays], authors: [pubkey] }, { maxWaitMs: 2500 });
    const latest = latestByAddress(events.filter((e) => e.pubkey === pubkey && verified(e)), { requireVersion: false })[0];
    const listed = latest ? unique(tagValues(latest.tags, 'relay')) : [];
    const relays = listed.length ? listed : this.relays;
    this.inboxCache.set(pubkey, { relays, at: Date.now() });
    return relays;
  }

  /** Sign an inner and send it; retried until acked (acks themselves are fire-and-forget). */
  async send(recipient: string, orderId: string, type: string, body: unknown): Promise<Inner> {
    const inner = await signInner(this.signer, { recipient, orderId, type, body });
    const size = new TextEncoder().encode(JSON.stringify(inner)).length;
    if (size > MAX_INNER_BYTES) throw new Error(`${type} message is ${size} bytes, over the ${MAX_INNER_BYTES} byte limit (§4.9)`);
    await this.sendInner(inner);
    return inner;
  }

  /** Send an already signed inner (e.g. one re-sent after reload). */
  async sendInner(inner: Inner): Promise<void> {
    const { recipient, type } = innerMeta(inner);
    const wrap = await giftWrap(this.signer, inner, recipient);
    const relays = await this.inboxRelaysOf(recipient);
    const now = Date.now();
    if (type !== MSG.ack) {
      await this.store.put<OutboxEntry>(`outbox/${inner.id}`, {
        inner, wrap, recipient, relays, firstSentAt: now, lastSentAt: now, acked: false,
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

  private async publishWrap(wrap: NostrEvent, relays: string[]): Promise<void> {
    const res = await this.transport.publish(relays, wrap);
    const needed = Math.min(this.k, relays.length);
    if (res.ok.length < needed) {
      const reasons = res.failed.map((f) => `${f.relay}: ${f.reason}`).join('; ');
      // Not fatal: the retry loop will try again. Surface it for the UI.
      this.emit('error', new Error(`sent to ${res.ok.length}/${needed} relays (${reasons})`));
    }
  }

  private async retryDue(): Promise<void> {
    const now = Date.now();
    for (const [key, e] of await this.store.list<OutboxEntry>('outbox/')) {
      if (e.acked || now - e.firstSentAt > this.maxRetryAgeMs) continue;
      if (now - e.lastSentAt < this.retryIntervalMs) continue;
      await this.store.put<OutboxEntry>(key, { ...e, lastSentAt: now });
      await this.publishWrap(e.wrap, e.relays).catch((err) => this.emit('error', err as Error));
    }
  }

  private async handleWrap(wrap: NostrEvent): Promise<void> {
    let inner: Inner;
    try {
      inner = await unwrap(this.signer, wrap);
    } catch {
      return; // not for us, or forged: ignore silently
    }
    const meta = innerMeta(inner);
    if (meta.type === MSG.ack) {
      await this.handleAck(inner);
      return;
    }
    const key = `inbox/${inner.id}`;
    // The same wrap usually arrives from several relays at once.
    const seen = await this.lock.run(inner.id, async () => {
      const prev = await this.store.get<InboxEntry>(key);
      if (!prev) await this.store.put<InboxEntry>(key, { inner, receivedAt: nowSeconds() });
      return prev !== undefined;
    });
    // Always ack, even duplicates: a resend means our previous ack was lost.
    await this.sendAck(inner);
    if (seen) return;
    let body: unknown;
    try {
      body = innerBody(inner);
    } catch {
      body = undefined;
    }
    this.emit('message', { inner, from: inner.pubkey, orderId: meta.orderId, type: meta.type, body });
  }

  private async handleAck(inner: Inner): Promise<void> {
    const { ids } = innerBody<{ ids?: string[] }>(inner);
    for (const id of ids ?? []) {
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
    const ack = await signInner(this.signer, {
      recipient: inner.pubkey,
      orderId: innerMeta(inner).orderId,
      type: MSG.ack,
      body: { ids: [inner.id] },
    });
    await this.sendInner(ack);
  }
}
