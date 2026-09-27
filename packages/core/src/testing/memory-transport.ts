import { matchFilter, type Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/pure';
import type { NostrTransport, PublishResult, Subscription } from '../nostr/transport.js';
import { unique } from '../nostr/transport.js';

/**
 * A shared in-process "relay network" for unit tests: events published to a
 * relay URL are stored there and pushed to matching live subscriptions.
 */
export class MemoryRelayNetwork {
  readonly relays = new Map<string, NostrEvent[]>();
  private subs = new Set<{ relays: Set<string>; filter: Filter; onEvent: (e: NostrEvent) => void }>();
  /** Relays that currently reject publishes (to test partial failure). */
  readonly down = new Set<string>();

  transport(): NostrTransport {
    return {
      publish: async (relays, event) => this.publish(relays, event),
      query: async (relays, filter) => this.query(relays, filter),
      subscribe: (relays, filter, onEvent, onEose) => this.subscribe(relays, filter, onEvent, onEose),
      close: () => {},
    };
  }

  private publish(relays: string[], event: NostrEvent): PublishResult {
    const res: PublishResult = { ok: [], failed: [] };
    for (const url of unique(relays)) {
      if (this.down.has(url)) {
        res.failed.push({ relay: url, reason: 'down' });
        continue;
      }
      const list = this.relays.get(url) ?? [];
      if (!list.some((e) => e.id === event.id)) list.push(event);
      this.relays.set(url, list);
      res.ok.push(url);
      for (const s of this.subs) {
        if (s.relays.has(url) && matchFilter(s.filter, event)) queueMicrotask(() => s.onEvent(event));
      }
    }
    return res;
  }

  /** Like a relay: matching events, newest first, at most `filter.limit` per relay. */
  private query(relays: string[], filter: Filter): NostrEvent[] {
    const seen = new Map<string, NostrEvent>();
    for (const url of unique(relays)) {
      const hits = (this.relays.get(url) ?? []).filter((e) => matchFilter(filter, e)).sort((a, b) => b.created_at - a.created_at);
      for (const e of filter.limit === undefined ? hits : hits.slice(0, filter.limit)) seen.set(e.id, e);
    }
    return [...seen.values()];
  }

  private subscribe(relays: string[], filter: Filter, onEvent: (e: NostrEvent) => void, onEose?: () => void): Subscription {
    const sub = { relays: new Set(unique(relays)), filter, onEvent };
    this.subs.add(sub);
    for (const e of this.query(relays, filter)) queueMicrotask(() => onEvent(e));
    if (onEose) queueMicrotask(onEose);
    return { close: () => this.subs.delete(sub) };
  }
}
