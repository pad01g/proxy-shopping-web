import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/pure';
import { KIND, tagValue, tagValues } from '../nostr/kinds.js';
import type { Payment } from '../nostr/messages.js';
import type { NostrTransport } from '../nostr/transport.js';
import type { Storage } from '../storage/types.js';
import { Emitter } from '../util/emitter.js';
import { KeyedMutex } from '../util/time.js';
import { bundleEvents, fetchBundle, MAX_BUNDLE_EVENTS } from './bundle.js';
import { effectiveCombinations, matchingEntries, type EffectiveResult } from './effective.js';
import { parseDelegation, parseEscrowProfile, parseShopperProfile, verified, type Profile } from './events.js';
import type { EffectiveEntry, EscrowProfileContent, P2PAddr, ShopperProfileContent } from './types.js';
import { latestByAddress } from './versions.js';

export { bundleEvents, MAX_BUNDLE_EVENTS };

const TRUST_KINDS: number[] = [KIND.delegation, KIND.operatorList];
const PROFILE_KINDS: number[] = [KIND.shopperProfile, KIND.escrowProfile, KIND.inboxRelays];
/** Kinds the directory keeps (§2.6): trust events and the profiles of listed parties. */
export const DIRECTORY_KINDS: readonly number[] = [...TRUST_KINDS, ...PROFILE_KINDS];
/** Out-of-scope events held aside in case the scope grows to them (a list before its delegation). */
const MAX_PARKED = 1000;
/** list_url bundles fetched per refresh, at most. */
const MAX_LIST_URLS = 16;

/** Trust events need a `v` (§2.1); profiles may fall back to created_at. */
function latestEvents(events: NostrEvent[]): NostrEvent[] {
  const ok = events.filter(verified);
  return [
    ...latestByAddress(ok.filter((e) => TRUST_KINDS.includes(e.kind))),
    ...latestByAddress(ok.filter((e) => !TRUST_KINDS.includes(e.kind)), { requireVersion: false }),
  ];
}

/** §10 trust-sync order: delegations, then lists, then profiles (a receiver that stops early has the roots). */
export function syncOrder(events: NostrEvent[]): NostrEvent[] {
  const rank = (k: number) => (k === KIND.delegation ? 0 : k === KIND.operatorList ? 1 : 2);
  return [...events].sort((a, b) => rank(a.kind) - rank(b.kind));
}

interface Scope {
  coordinators: Set<string>;
  operators: Set<string>;
  parties: Set<string>;
}

export interface Offer {
  entry: EffectiveEntry;
  shopper?: Profile<ShopperProfileContent>;
  escrow?: Profile<EscrowProfileContent>;
}

export interface DirectorySnapshot extends EffectiveResult {
  shoppers: Map<string, Profile<ShopperProfileContent>>;
  escrows: Map<string, Profile<EscrowProfileContent>>;
  /** Inbox relays (kind 10050) of listed parties, from any path. */
  inboxes: Map<string, string[]>;
  fetchedAt: number;
}

export interface SourceStatus {
  url: string;
  kind: 'bundle' | 'list_url';
  events: number;
  error?: string;
  at: number;
}

export interface DirectoryOptions {
  transport: NostrTransport;
  storage: Storage;
  network: string;
  relays: () => string[];
  coordinators: () => string[];
  /**
   * Trust bundle URLs (§2.6 bundle_urls, e.g. a registry's events.json). They add no trust: their events are
   * verified and scoped exactly like the events of any other path.
   */
  bundles?: () => string[];
  /** Also fetch trust events and profiles from the Nostr relays (§2.6: optional). Default true. */
  nostr?: () => boolean;
  /** Lab only: bundles over http and from private hosts. */
  allowPrivate?: () => boolean;
  fetch?: typeof fetch;
}

type Events = {
  /** The snapshot changed (refresh, or events from P2P). */
  updated: DirectorySnapshot;
};

/**
 * The trust directory (§2.4–§2.6): signed delegations, lists and profiles from every path — bundle URLs, the
 * operators' list_url, P2P (gossip and trust-sync, through `ingest`) and optionally Nostr — verified, scoped to
 * our coordinators and evaluated. All raw events are cached in storage so the app works offline-first.
 */
export class TrustDirectory extends Emitter<Events> {
  private snapshot?: DirectorySnapshot;
  private events: NostrEvent[] = [];
  private loaded = false;
  private readonly parked = new Map<string, NostrEvent>();
  private readonly lock = new KeyedMutex();
  private sourceStatus: SourceStatus[] = [];
  private ingested = 0;

  constructor(private readonly opts: DirectoryOptions) {
    super();
  }

  private get nostrEnabled(): boolean {
    return this.opts.nostr?.() ?? true;
  }

  private async fetchAll(urls: string[], kind: SourceStatus['kind']): Promise<NostrEvent[]> {
    const out = await Promise.all(
      urls.map(async (url): Promise<NostrEvent[]> => {
        try {
          const events = await fetchBundle(url, { fetch: this.opts.fetch, allowPrivate: this.opts.allowPrivate?.() });
          this.setSource({ url, kind, events: events.length, at: Date.now() });
          return events;
        } catch (err) {
          console.warn(`${kind} ${url}: ${(err as Error).message}`);
          this.setSource({ url, kind, events: 0, error: (err as Error).message, at: Date.now() });
          return [];
        }
      }),
    );
    return out.flat();
  }

  private setSource(s: SourceStatus): void {
    this.sourceStatus = [...this.sourceStatus.filter((x) => x.url !== s.url), s].slice(-32);
  }

  /** What the last refresh got from each bundle URL and list_url. */
  get sources(): SourceStatus[] {
    return [...this.sourceStatus];
  }

  /** Events taken from P2P (gossip and trust-sync) since start. */
  get p2pEventsStored(): number {
    return this.ingested;
  }

  get current(): DirectorySnapshot | undefined {
    return this.snapshot;
  }

  /** Every event we keep, in trust-sync order (§10), for peers asking with /ps/trust-sync. */
  allEvents(): NostrEvent[] {
    return syncOrder(this.events);
  }

  async refresh(): Promise<DirectorySnapshot> {
    await this.ensureLoaded();
    const relays = this.opts.relays();
    const coordinators = this.opts.coordinators();
    const t = this.opts.transport;
    const nostr = this.nostrEnabled;

    // Relays under load can answer slowly; an empty answer is retried once before we conclude there is nothing.
    const ask = async (filter: Filter): Promise<NostrEvent[]> => {
      if (!nostr || !relays.length) return [];
      const got = await t.query(relays, filter, { maxWaitMs: 10_000 });
      return got.length ? got : t.query(relays, filter, { maxWaitMs: 10_000 });
    };
    const fetched: NostrEvent[] = [];
    // §2.6 order: bundle_urls, then the delegations' list_url, then (when enabled) Nostr. Bundle events are taken
    // in the same steps and with the same filters as the relays' answers.
    const bundled = await this.fetchAll(this.opts.bundles?.() ?? [], 'bundle');
    const pick = (kinds: number[], authors: string[], d?: string) =>
      bundled.filter((e) => kinds.includes(e.kind) && authors.includes(e.pubkey) && (d === undefined || tagValue(e.tags, 'd') === d));
    if (coordinators.length) {
      fetched.push(...pick([KIND.delegation], coordinators));
      fetched.push(...(await ask({ kinds: [KIND.delegation], authors: coordinators })));
    }
    const all = () => latestEvents([...this.events, ...fetched]);
    const listUrls = this.listUrls(all(), coordinators);
    if (listUrls.length) bundled.push(...(await this.fetchAll(listUrls, 'list_url')));
    const operators = [...new Set(all().filter((e) => e.kind === KIND.delegation).map((e) => tagValue(e.tags, 'd') ?? ''))].filter(Boolean);
    if (operators.length) {
      fetched.push(...pick([KIND.operatorList], operators, this.opts.network));
      fetched.push(...(await ask({ kinds: [KIND.operatorList], authors: operators, '#d': [this.opts.network] })));
    }
    const eff = effectiveCombinations({ coordinators, network: this.opts.network, events: all() });
    const parties = [...new Set(eff.entries.flatMap((e) => [e.shopper, e.escrow]))];
    if (parties.length) {
      fetched.push(...pick(PROFILE_KINDS, parties));
      fetched.push(...(await ask({ kinds: PROFILE_KINDS, authors: parties })));
    }
    return this.lock.run('events', async () => {
      this.events = latestEvents([...this.events, ...fetched]);
      await this.opts.storage.put('trust/events', this.events);
      return this.publishSnapshot();
    });
  }

  /** list_url of the effective delegations (§2.2, §2.6): latest, not revoked, from our coordinators, our network. */
  private listUrls(events: NostrEvent[], coordinators: string[]): string[] {
    const urls: string[] = [];
    for (const e of events) {
      if (e.kind !== KIND.delegation || !coordinators.includes(e.pubkey)) continue;
      const d = parseDelegation(e);
      if (!d || d.revoked || d.network !== this.opts.network) continue;
      urls.push(...d.listUrls);
    }
    return [...new Set(urls)].slice(0, MAX_LIST_URLS);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.events = latestEvents((await this.opts.storage.get<NostrEvent[]>('trust/events')) ?? []);
    this.loaded = true;
  }

  /** Evaluate from cache only. */
  async load(): Promise<DirectorySnapshot> {
    await this.ensureLoaded();
    return (this.snapshot = this.evaluate(this.events));
  }

  /** Who is in the scope of our coordinators (§10), from one evaluation of `events`. */
  private scopeOf(events: NostrEvent[]): Scope {
    const coordinators = new Set(this.opts.coordinators());
    const eff = events === this.events && this.snapshot ? this.snapshot : effectiveCombinations({ coordinators: [...coordinators], network: this.opts.network, events });
    return {
      coordinators,
      operators: new Set(eff.delegations.filter((d) => coordinators.has(d.coordinator) && !d.revoked).map((d) => d.operator)),
      parties: new Set(eff.entries.flatMap((x) => [x.shopper, x.escrow])),
    };
  }

  /**
   * Is this (verified) event within the scope of our coordinators (§10)? Delegations of our coordinators, lists of
   * operators they delegate, and the profiles / 10050 of the parties of the effective entries.
   */
  inScope(e: NostrEvent, scope: Scope = this.scopeOf(this.events)): boolean {
    const network = this.opts.network;
    switch (e.kind) {
      case KIND.delegation:
        return scope.coordinators.has(e.pubkey) && tagValue(e.tags, 'network') === network;
      case KIND.operatorList:
        return tagValue(e.tags, 'd') === network && scope.operators.has(e.pubkey);
      case KIND.shopperProfile:
      case KIND.escrowProfile:
        return tagValue(e.tags, 'd') === network && scope.parties.has(e.pubkey);
      case KIND.inboxRelays:
        return scope.parties.has(e.pubkey);
      default:
        return false;
    }
  }

  /**
   * Take events that arrived by P2P (gossip, trust-sync) or any other path: each is verified and scoped like a
   * relay's answer; events outside the scope are held aside (bounded) until a delegation or list brings them in.
   * Returns how many were new and stored.
   */
  async ingest(events: NostrEvent[]): Promise<number> {
    const fresh = events.filter((e) => typeof e === 'object' && e && DIRECTORY_KINDS.includes(e.kind) && verified(e));
    if (!fresh.length) return 0;
    await this.ensureLoaded();
    return this.lock.run('events', async () => {
      let pending = [...fresh, ...this.parked.values()];
      let current = this.events;
      let changed = false;
      let stored = 0;
      // Accepting a delegation can bring its list into scope, and the list its parties' profiles.
      for (let round = 0; round < 4 && pending.length; round++) {
        const scope = this.scopeOf(current);
        const accepted = pending.filter((e) => this.inScope(e, scope));
        if (!accepted.length) break;
        const next = latestEvents([...current, ...accepted]);
        const ids = new Set(current.map((e) => e.id));
        const added = next.filter((e) => !ids.has(e.id));
        for (const e of accepted) this.parked.delete(e.id);
        pending = pending.filter((e) => !accepted.includes(e));
        if (!added.length) continue;
        stored += added.filter((e) => fresh.includes(e)).length;
        current = next;
        changed = true;
      }
      for (const e of pending) {
        if (this.parked.has(e.id)) continue;
        this.parked.set(e.id, e);
        if (this.parked.size > MAX_PARKED) this.parked.delete(this.parked.keys().next().value!);
      }
      if (!changed) return 0;
      this.events = current;
      this.ingested += stored;
      await this.opts.storage.put('trust/events', this.events);
      this.publishSnapshot();
      return stored;
    });
  }

  private publishSnapshot(): DirectorySnapshot {
    const snap = (this.snapshot = this.evaluate(this.events));
    this.emit('updated', snap);
    return snap;
  }

  /** Candidate shopper×escrow combinations for an order (entries + profiles, filtered by payment). */
  offers(q: { shopUrl: string; region: string; payment?: Payment }): Offer[] {
    const snap = this.snapshot;
    if (!snap) return [];
    return matchingEntries(snap.entries, q)
      .map((entry) => ({ entry, shopper: snap.shoppers.get(entry.shopper), escrow: snap.escrows.get(entry.escrow) }))
      .filter((o) => !q.payment || !o.shopper || o.shopper.content.payments?.includes(q.payment));
  }

  /** p2p relays named by the lists in use (§2.3 p2p_relays). */
  p2pRelays(): string[] {
    const out: string[] = [];
    for (const l of this.snapshot?.lists.values() ?? []) out.push(...(l.content.p2p_relays ?? []));
    return [...new Set(out)].slice(0, 16); // §2.3: 16 from all lists in use
  }

  /** The libp2p destination a listed shopper or escrow put into its profile (§3, §10). */
  p2pOf(pubkey: string): P2PAddr | undefined {
    return this.snapshot?.shoppers.get(pubkey)?.content.p2p ?? this.snapshot?.escrows.get(pubkey)?.content.p2p;
  }

  /** Inbox relays (10050) of a listed party known from any path. */
  inboxOf(pubkey: string): string[] | undefined {
    return this.snapshot?.inboxes.get(pubkey);
  }

  private evaluate(events: NostrEvent[]): DirectorySnapshot {
    const eff = effectiveCombinations({ coordinators: this.opts.coordinators(), network: this.opts.network, events });
    const shoppers = new Map<string, Profile<ShopperProfileContent>>();
    const escrows = new Map<string, Profile<EscrowProfileContent>>();
    const inboxes = new Map<string, string[]>();
    for (const e of events) {
      if (e.kind === KIND.inboxRelays) {
        inboxes.set(e.pubkey, tagValues(e.tags, 'relay'));
        continue;
      }
      if (tagValue(e.tags, 'd') !== this.opts.network) continue;
      const s = parseShopperProfile(e);
      if (s) shoppers.set(s.pubkey, s);
      const es = parseEscrowProfile(e);
      if (es) escrows.set(es.pubkey, es);
    }
    return { ...eff, shoppers, escrows, inboxes, fetchedAt: Date.now() };
  }
}
