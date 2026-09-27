import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/pure';

export type { Filter };

export interface PublishResult {
  ok: string[];
  failed: Array<{ relay: string; reason: string }>;
}

export interface Subscription {
  close(): void;
}

/** Relay I/O used by the rest of core. Swappable for tests. */
export interface NostrTransport {
  publish(relays: string[], event: NostrEvent): Promise<PublishResult>;
  query(relays: string[], filter: Filter, opts?: { maxWaitMs?: number }): Promise<NostrEvent[]>;
  /** `onEose` fires once the relays have sent their stored events (NIP-01 EOSE). */
  subscribe(relays: string[], filter: Filter, onEvent: (e: NostrEvent) => void, onEose?: () => void): Subscription;
  close(): void;
}

export const normalizeRelayUrl = (u: string): string => u.trim().replace(/\/+$/, '');

export class PoolTransport implements NostrTransport {
  readonly pool: SimplePool;

  constructor(pool?: SimplePool) {
    this.pool = pool ?? new SimplePool({ enableReconnect: true });
  }

  async publish(relays: string[], event: NostrEvent): Promise<PublishResult> {
    const urls = unique(relays);
    const results = await Promise.allSettled(this.pool.publish(urls, event, { maxWait: 8000 }));
    const out: PublishResult = { ok: [], failed: [] };
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') out.ok.push(urls[i]);
      else out.failed.push({ relay: urls[i], reason: String(r.reason?.message ?? r.reason) });
    });
    return out;
  }

  query(relays: string[], filter: Filter, opts?: { maxWaitMs?: number }): Promise<NostrEvent[]> {
    return this.pool.querySync(unique(relays), filter, { maxWait: opts?.maxWaitMs ?? 4000 });
  }

  subscribe(relays: string[], filter: Filter, onEvent: (e: NostrEvent) => void, onEose?: () => void): Subscription {
    return this.pool.subscribeMany(unique(relays), filter, { onevent: onEvent, oneose: onEose });
  }

  close(): void {
    this.pool.destroy();
  }
}

export function unique(relays: string[]): string[] {
  return [...new Set(relays.map(normalizeRelayUrl))].filter(Boolean);
}
