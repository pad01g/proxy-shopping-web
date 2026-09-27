import type { NostrEvent } from 'nostr-tools/pure';
import { normalizeRelayUrl, unique, type Filter, type NostrTransport, type PublishResult, type Subscription } from './transport.js';

/**
 * A transport that keeps protocol-visible (logical) relay URLs but connects somewhere else.
 *
 * The lab's demo page runs on the host while the Go nodes live inside docker: every message, 10050 and
 * request names `wss://relay-1.test`, which only resolves inside the lab, and the browser reaches the same
 * relay through a path on the demo server (`ws://localhost:8888/relay-1`). Callers pass logical URLs; results
 * name logical URLs again. Relays without a mapping are not reachable from here and are skipped (a publish
 * reports them as failed, so the Messenger tries its next candidate).
 */
export class MappedTransport implements NostrTransport {
  private readonly toPhysical = new Map<string, string>();
  private readonly toLogical = new Map<string, string>();

  constructor(
    private readonly inner: NostrTransport,
    map: ReadonlyMap<string, string> | Record<string, string>,
  ) {
    const entries = map instanceof Map ? [...map.entries()] : Object.entries(map);
    for (const [logical, physical] of entries) {
      this.toPhysical.set(normalizeRelayUrl(logical), normalizeRelayUrl(physical));
      this.toLogical.set(normalizeRelayUrl(physical), normalizeRelayUrl(logical));
    }
  }

  /** The physical URLs of the mapped relays among `relays`. */
  physical(relays: string[]): string[] {
    return unique(relays).flatMap((r) => this.toPhysical.get(r) ?? []);
  }

  async publish(relays: string[], event: NostrEvent): Promise<PublishResult> {
    const logical = unique(relays);
    const unmapped = logical.filter((r) => !this.toPhysical.has(r));
    const res = await (logical.length > unmapped.length ? this.inner.publish(this.physical(logical), event) : Promise.resolve({ ok: [], failed: [] }));
    const back = (u: string) => this.toLogical.get(normalizeRelayUrl(u)) ?? u;
    return {
      ok: res.ok.map(back),
      failed: [...res.failed.map((f) => ({ ...f, relay: back(f.relay) })), ...unmapped.map((relay) => ({ relay, reason: 'no route to this relay from here' }))],
    };
  }

  async query(relays: string[], filter: Filter, opts?: { maxWaitMs?: number }): Promise<NostrEvent[]> {
    const urls = this.physical(relays);
    return urls.length ? this.inner.query(urls, filter, opts) : [];
  }

  subscribe(relays: string[], filter: Filter, onEvent: (e: NostrEvent) => void, onEose?: () => void): Subscription {
    const urls = this.physical(relays);
    if (!urls.length) {
      // Nothing to wait for: tell the caller right away that no stored events will come.
      if (onEose) queueMicrotask(onEose);
      return { close: () => undefined };
    }
    return this.inner.subscribe(urls, filter, onEvent, onEose);
  }

  close(): void {
    this.inner.close();
  }
}
