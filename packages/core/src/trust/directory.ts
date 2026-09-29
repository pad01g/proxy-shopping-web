import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/pure';
import { KIND, tagValue } from '../nostr/kinds.js';
import type { Payment } from '../nostr/messages.js';
import type { NostrTransport } from '../nostr/transport.js';
import type { Storage } from '../storage/types.js';
import { effectiveCombinations, matchingEntries, type EffectiveResult } from './effective.js';
import { parseEscrowProfile, parseShopperProfile, verified, type Profile } from './events.js';
import type { EffectiveEntry, EscrowProfileContent, ShopperProfileContent } from './types.js';
import { latestByAddress } from './versions.js';

const TRUST_KINDS: number[] = [KIND.delegation, KIND.operatorList];

/** Trust events need a `v` (§2.1); profiles may fall back to created_at. */
function latestEvents(events: NostrEvent[]): NostrEvent[] {
  const ok = events.filter(verified);
  return [
    ...latestByAddress(ok.filter((e) => TRUST_KINDS.includes(e.kind))),
    ...latestByAddress(ok.filter((e) => !TRUST_KINDS.includes(e.kind)), { requireVersion: false }),
  ];
}

/** Largest number of events taken from one trust bundle. */
export const MAX_BUNDLE_EVENTS = 5000;

/** The verified events of a trust bundle body ({"events": [...]} or [...]); anything else yields none. */
export function bundleEvents(body: unknown): NostrEvent[] {
  const list = Array.isArray(body) ? body : Array.isArray((body as { events?: unknown })?.events) ? (body as { events: unknown[] }).events : [];
  return list.slice(0, MAX_BUNDLE_EVENTS).filter((e): e is NostrEvent => typeof e === 'object' && e !== null && verified(e as NostrEvent));
}

export interface Offer {
  entry: EffectiveEntry;
  shopper?: Profile<ShopperProfileContent>;
  escrow?: Profile<EscrowProfileContent>;
}

export interface DirectorySnapshot extends EffectiveResult {
  shoppers: Map<string, Profile<ShopperProfileContent>>;
  escrows: Map<string, Profile<EscrowProfileContent>>;
  fetchedAt: number;
}

/**
 * Fetches trust events and profiles from relays and evaluates §2.4.
 * All raw events are cached in storage so the app works offline-first.
 */
export class TrustDirectory {
  private snapshot?: DirectorySnapshot;

  constructor(
    private readonly opts: {
      transport: NostrTransport;
      storage: Storage;
      network: string;
      relays: () => string[];
      coordinators: () => string[];
      /**
       * Trust bundles: URLs of JSON files of signed events ({"events": [...]} such as a registry's events.json, or
       * an array). They add no trust: their events are verified and scoped exactly like the relays' answers.
       */
      bundles?: () => string[];
      fetch?: typeof fetch;
    },
  ) {}

  /** Verified events of the trust bundles; a bundle that cannot be fetched or parsed is skipped. */
  private async fetchBundles(): Promise<NostrEvent[]> {
    const urls = this.opts.bundles?.() ?? [];
    const get = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
    const out = await Promise.all(
      urls.map(async (url) => {
        try {
          const res = await get(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return bundleEvents(await res.json());
        } catch (err) {
          console.warn(`trust bundle ${url}: ${(err as Error).message}`);
          return [];
        }
      }),
    );
    return out.flat();
  }

  get current(): DirectorySnapshot | undefined {
    return this.snapshot;
  }

  async refresh(): Promise<DirectorySnapshot> {
    const relays = this.opts.relays();
    const coordinators = this.opts.coordinators();
    const t = this.opts.transport;
    const cached = (await this.opts.storage.get<NostrEvent[]>('trust/events')) ?? [];

    // Relays under load can answer slowly; an empty answer is retried once before we conclude there is nothing.
    const ask = async (filter: Filter): Promise<NostrEvent[]> => {
      const got = await t.query(relays, filter, { maxWaitMs: 10_000 });
      return got.length ? got : t.query(relays, filter, { maxWaitMs: 10_000 });
    };
    const fetched: NostrEvent[] = [];
    // Bundle events are taken in the same steps and with the same filters as the relays' answers.
    const bundled = await this.fetchBundles();
    const pick = (kinds: number[], authors: string[], d?: string) =>
      bundled.filter((e) => kinds.includes(e.kind) && authors.includes(e.pubkey) && (d === undefined || tagValue(e.tags, 'd') === d));
    if (coordinators.length) {
      fetched.push(...pick([KIND.delegation], coordinators));
      fetched.push(...(await ask({ kinds: [KIND.delegation], authors: coordinators })));
    }
    const all = () => latestEvents([...cached, ...fetched]);
    const operators = [...new Set(all().filter((e) => e.kind === KIND.delegation).map((e) => tagValue(e.tags, 'd') ?? ''))].filter(Boolean);
    if (operators.length) {
      fetched.push(...pick([KIND.operatorList], operators, this.opts.network));
      fetched.push(...(await ask({ kinds: [KIND.operatorList], authors: operators, '#d': [this.opts.network] })));
    }
    const eff = effectiveCombinations({ coordinators, network: this.opts.network, events: all() });
    const parties = [...new Set(eff.entries.flatMap((e) => [e.shopper, e.escrow]))];
    if (parties.length) {
      fetched.push(...pick([KIND.shopperProfile, KIND.escrowProfile], parties));
      fetched.push(
        ...(await ask({ kinds: [KIND.shopperProfile, KIND.escrowProfile], authors: parties })),
      );
    }
    const events = all();
    await this.opts.storage.put('trust/events', events);
    return (this.snapshot = this.evaluate(events));
  }

  /** Evaluate from cache only. */
  async load(): Promise<DirectorySnapshot> {
    const events = (await this.opts.storage.get<NostrEvent[]>('trust/events')) ?? [];
    return (this.snapshot = this.evaluate(events));
  }

  /** Candidate shopper×escrow combinations for an order (entries + profiles, filtered by payment). */
  offers(q: { shopUrl: string; region: string; payment?: Payment }): Offer[] {
    const snap = this.snapshot;
    if (!snap) return [];
    return matchingEntries(snap.entries, q)
      .map((entry) => ({ entry, shopper: snap.shoppers.get(entry.shopper), escrow: snap.escrows.get(entry.escrow) }))
      .filter((o) => !q.payment || !o.shopper || o.shopper.content.payments?.includes(q.payment));
  }

  private evaluate(events: NostrEvent[]): DirectorySnapshot {
    const eff = effectiveCombinations({ coordinators: this.opts.coordinators(), network: this.opts.network, events });
    const shoppers = new Map<string, Profile<ShopperProfileContent>>();
    const escrows = new Map<string, Profile<EscrowProfileContent>>();
    for (const e of events) {
      if (tagValue(e.tags, 'd') !== this.opts.network) continue;
      const s = parseShopperProfile(e);
      if (s) shoppers.set(s.pubkey, s);
      const es = parseEscrowProfile(e);
      if (es) escrows.set(es.pubkey, es);
    }
    return { ...eff, shoppers, escrows, fetchedAt: Date.now() };
  }
}
