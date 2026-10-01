import type { EventTemplate, NostrEvent } from 'nostr-tools/pure';
import type { ChainApi } from '../btc/esplora.js';
import type { EvmClient } from '../evm/chain.js';
import type { RateSource } from '../fx/types.js';
import type { KeySet } from '../keys/derive.js';
import { LocalSigner, type IdentitySigner } from '../keys/signer.js';
import { KIND, tagValue } from '../nostr/kinds.js';
import { innerMeta, isValidInner } from '../nostr/giftwrap.js';
import { p2pAddr } from '../nostr/schema.js';
import { MSG, type EscrowNotice, type OrderRequest } from '../nostr/messages.js';
import type { P2PService } from '../p2p/types.js';
import type { P2PAddr } from '../trust/types.js';
import { Messenger, type Acceptance, type AcceptFn } from '../nostr/messenger.js';
import { unique, type NostrTransport, type PublishResult } from '../nostr/transport.js';
import { ScopedStorage, type Storage } from '../storage/types.js';
import { TrustDirectory } from '../trust/directory.js';
import { verified } from '../trust/events.js';
import { latestByAddress, eventVersion } from '../trust/versions.js';
import { nowSeconds } from '../util/time.js';
import type { TimelockPolicy } from './timelock-policy.js';

export interface SessionConfig {
  network: string;
  relays: string[];
  /** Trusted coordinators, highest priority first (§2.4). */
  coordinators: string[];
  /**
   * Trust bundle URLs (e.g. a registry's events.json): signed events fetched on every directory refresh and
   * verified and scoped like the relays' answers, so the directory works when relays have dropped them.
   */
  trustBundles?: string[];
  /** Minimum relays per message (§4.2). */
  k?: number;
  retryIntervalMs?: number;
  /** User-side timelock policy (§4.5.1); defaults per spec when absent. */
  timelockPolicy?: TimelockPolicy;
  /** Lab only: allow ws:// / http:// and private addresses for peer relays (§4.10). */
  allowPrivateEndpoints?: boolean;
  /** Cap for the BTC funding fee rate in sat/vB (default 50). */
  maxFeeRate?: number;
  /** Largest accepted difference between the chain's clock and ours, in seconds (§4.5.1, default 2 h). */
  maxClockSkewSeconds?: number;
  /**
   * Also fetch trust events and profiles from the Nostr relays (§2.6: optional; bundles, list_url and P2P are the
   * main paths). Default true so existing configurations keep working; the ps-main configs set false.
   */
  trustFromNostr?: boolean;
  /** How often the directory refreshes while the session runs (§2.6: 10 minutes); 0 turns it off. */
  refreshIntervalMs?: number;
}

/** Learned P2P destinations of users (reply_p2p of signed order.request), at most this many. */
const MAX_LEARNED_PEERS = 500;
/** Own events are gossiped again this often, so peers that joined later and relays' stores have them. */
const REGOSSIP_MS = 10 * 60_000;

export interface SessionOptions {
  keys: KeySet;
  /** Identity signer; defaults to the mnemonic's NIP-06 key. Pass a Nip07Signer to use an extension. */
  signer?: IdentitySigner;
  transport: NostrTransport;
  storage: Storage;
  config: SessionConfig;
  /** Esplora-compatible BTC chain API (needed for btc-signet orders). */
  chain?: ChainApi;
  /** EVM client for this participant (needed for usdc-evm orders). */
  evm?: EvmClient;
  rates?: RateSource[];
}

/**
 * Everything a role client needs: keys, identity, relays, trust directory,
 * chain access. One session can host several role clients at once.
 */
export class Session {
  readonly keys: KeySet;
  readonly signer: IdentitySigner;
  readonly transport: NostrTransport;
  readonly storage: Storage;
  readonly messenger: Messenger;
  readonly directory: TrustDirectory;
  chain?: ChainApi;
  evm?: EvmClient;
  rates: RateSource[];
  private cfg: SessionConfig;
  private pubkeyValue?: string;
  private readonly acceptors = new Set<AcceptFn>();
  private p2pService?: P2PService;
  private readonly p2pDetach: Array<() => void> = [];
  private learned = new Map<string, P2PAddr>();
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(opts: SessionOptions) {
    this.keys = opts.keys;
    this.signer = opts.signer ?? new LocalSigner(opts.keys.nostrSecretKey);
    this.transport = opts.transport;
    this.storage = opts.storage;
    this.chain = opts.chain;
    this.evm = opts.evm;
    this.rates = opts.rates ?? [];
    this.cfg = { ...opts.config, relays: unique(opts.config.relays) };
    this.messenger = new Messenger({
      signer: this.signer,
      transport: this.transport,
      storage: new ScopedStorage(this.storage, 'msg/'),
      relays: this.cfg.relays,
      k: this.cfg.k,
      retryIntervalMs: this.cfg.retryIntervalMs,
      allowPrivateRelays: this.cfg.allowPrivateEndpoints,
      accepts: (inner, meta) => this.classify(inner, meta),
      knownInbox: (pk) => this.directory.inboxOf(pk),
      queryInbox: () => this.trustFromNostr,
    });
    this.directory = new TrustDirectory({
      transport: this.transport,
      storage: this.storage,
      network: this.cfg.network,
      relays: () => this.cfg.relays,
      coordinators: () => this.cfg.coordinators,
      bundles: () => this.cfg.trustBundles ?? [],
      nostr: () => this.trustFromNostr,
      allowPrivate: () => !!this.cfg.allowPrivateEndpoints,
    });
    this.messenger.on('message', (m) => void this.learnPeer(m.type, m.from, m.body).catch(() => undefined));
  }

  get trustFromNostr(): boolean {
    return this.cfg.trustFromNostr ?? true;
  }

  // ---------- P2P (§4.2, §10) ----------

  /**
   * Join the libp2p side: messages go P2P first (§4.2), incoming /ps/msg wraps reach the messenger, gossip and
   * trust-sync events feed the directory under the same rules as every other path, and our own signed events
   * (profiles, 10050, lists, delegations) are gossiped. Returns the detach function.
   */
  attachP2P(p2p: P2PService): () => void {
    this.detachP2P();
    this.p2pService = p2p;
    this.messenger.setP2P(p2p, (pk) => this.p2pTargetOf(pk));
    p2p.onWrap((wrap) => this.messenger.receiveWrap(wrap));
    p2p.setValidator((e) => {
      if (!verified(e)) return 'reject';
      if (this.directory.inScope(e)) return 'accept';
      void this.directory.ingest([e]).catch(() => undefined); // held aside in case the scope grows to it
      return 'ignore';
    });
    p2p.onEvents((events) => void this.directory.ingest(events).catch(() => undefined));
    p2p.setSyncSource(() => [...this.directory.allEvents(), ...this.ownCache.filter((e) => !this.directory.allEvents().some((x) => x.id === e.id))]);
    const relays = () => p2p.addRelays(this.directory.p2pRelays());
    relays();
    this.p2pDetach.push(this.directory.on('updated', relays));
    this.p2pDetach.push(p2p.on('addrs', () => {
      for (const fn of this.addrListeners) fn();
    }));
    let hadPeers = false;
    this.p2pDetach.push(p2p.on('status', (st) => {
      // Someone to gossip to: announce our events (gossipsub keeps nothing for late joiners).
      if (st.peers > 0 && !hadPeers) void this.gossipOwn();
      hadPeers = st.peers > 0;
    }));
    const timer = setInterval(() => void this.gossipOwn(), REGOSSIP_MS);
    (timer as { unref?: () => void }).unref?.();
    this.p2pDetach.push(() => clearInterval(timer));
    void this.loadLearned().then(() => this.gossipOwn());
    return () => this.detachP2P();
  }

  private readonly addrListeners = new Set<() => void>();

  /** Called when our P2P addresses change (and when P2P is attached); returns the unregister function. */
  onP2PAddrs(fn: () => void): () => void {
    this.addrListeners.add(fn);
    return () => this.addrListeners.delete(fn);
  }

  detachP2P(): void {
    for (const fn of this.p2pDetach.splice(0)) fn();
    this.messenger.setP2P(undefined);
    this.p2pService = undefined;
  }

  get p2p(): P2PService | undefined {
    return this.p2pService;
  }

  /** Our destination for reply_p2p and profiles (§10), when P2P runs and we have a circuit or direct address. */
  p2pSelf(): P2PAddr | undefined {
    const st = this.p2pService?.status();
    if (!this.p2pService || !st?.running) return undefined;
    const self = this.p2pService.self();
    return self.addrs.length ? self : undefined;
  }

  /** Where `pubkey` takes P2P messages: the reply_p2p it signed (users), else its profile (shoppers, escrows). */
  p2pTargetOf(pubkey: string): P2PAddr | undefined {
    return this.learned.get(pubkey) ?? this.directory.p2pOf(pubkey);
  }

  private ownCache: NostrEvent[] = [];

  private async loadOwn(): Promise<NostrEvent[]> {
    const rows = await this.storage.list<NostrEvent[]>('own/');
    this.ownCache = latestByAddress(rows.flatMap(([, evs]) => evs).filter(verified), { requireVersion: false });
    return this.ownCache;
  }

  /** Gossip our own latest signed events of the gossiped kinds (§2.6: the signer's node distributes them). */
  async gossipOwn(): Promise<void> {
    const p2p = this.p2pService;
    if (!p2p) return;
    for (const e of await this.loadOwn()) {
      if (![KIND.delegation, KIND.operatorList, KIND.shopperProfile, KIND.escrowProfile, KIND.inboxRelays].includes(e.kind as never)) continue;
      await p2p.publish(e).catch(() => undefined);
    }
  }

  private async loadLearned(): Promise<void> {
    const saved = (await this.storage.get<Array<[string, P2PAddr]>>('p2p/peers')) ?? [];
    for (const [k, v] of saved) if (!this.learned.has(k)) this.learned.set(k, v);
  }

  /** reply_p2p of a signed order.request (directly, or inside an escrow.notice) tells where its user is (§4.4). */
  private async learnPeer(type: string, from: string, body: unknown): Promise<void> {
    let who: string | undefined;
    let addr: P2PAddr | undefined;
    if (type === MSG.request) {
      who = from;
      addr = (body as OrderRequest).reply_p2p;
    } else if (type === MSG.escrowNotice) {
      const req = (body as EscrowNotice).request;
      // The notice comes from the shopper; only the user's own signature makes the address the user's.
      if (!isValidInner(req) || innerMeta(req).type !== MSG.request) return;
      who = req.pubkey;
      try {
        addr = p2pAddr((JSON.parse(req.content) as OrderRequest).reply_p2p);
      } catch {
        addr = undefined;
      }
    }
    if (!who || !addr?.peer_id || !Array.isArray(addr.addrs)) return;
    this.learned.delete(who);
    this.learned.set(who, { peer_id: addr.peer_id, addrs: addr.addrs.slice(0, 8) });
    while (this.learned.size > MAX_LEARNED_PEERS) this.learned.delete(this.learned.keys().next().value!);
    await this.storage.put('p2p/peers', [...this.learned.entries()]);
  }

  /**
   * Register a role's view of incoming messages (§4.10); returns the unregister function. A session with
   * no registered role (e.g. a test shopper listening on the messenger directly) accepts everything.
   */
  addAcceptor(fn: AcceptFn): () => void {
    this.acceptors.add(fn);
    return () => this.acceptors.delete(fn);
  }

  /** The most favourable verdict of the attached roles: a counterparty for one role is a counterparty. */
  private async classify(...args: Parameters<AcceptFn>): Promise<Acceptance> {
    if (!this.acceptors.size) return 'counterparty';
    const verdicts = await Promise.all([...this.acceptors].map((fn) => Promise.resolve(fn(...args)).catch((): Acceptance => 'reject')));
    return verdicts.includes('counterparty') ? 'counterparty' : verdicts.includes('stranger') ? 'stranger' : 'reject';
  }

  get config(): SessionConfig {
    return this.cfg;
  }

  get network(): string {
    return this.cfg.network;
  }

  /** Update relays/coordinators at runtime (settings screen). */
  updateConfig(patch: Partial<SessionConfig>): void {
    this.cfg = { ...this.cfg, ...patch, relays: unique(patch.relays ?? this.cfg.relays) };
    if (patch.relays) this.messenger.setRelays(this.cfg.relays);
  }

  async pubkey(): Promise<string> {
    return (this.pubkeyValue ??= await this.signer.getPublicKey());
  }

  async start(): Promise<void> {
    await this.directory.load();
    await this.messenger.start();
    const every = this.cfg.refreshIntervalMs ?? 10 * 60_000;
    if (every > 0 && !this.refreshTimer) {
      this.refreshTimer = setInterval(() => void this.directory.refresh().catch(() => undefined), every);
      (this.refreshTimer as { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    this.messenger.stop();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.detachP2P();
  }

  async sign(template: EventTemplate): Promise<NostrEvent> {
    return this.signer.signEvent(template);
  }

  async publish(event: NostrEvent, relays = this.cfg.relays): Promise<PublishResult> {
    return this.transport.publish(relays, event);
  }

  /** Our own latest addressable event of `kind` with `d`, looked up on relays and in local storage. */
  async ownLatest(kind: number, d: string): Promise<NostrEvent | undefined> {
    const me = await this.pubkey();
    const local = (await this.storage.get<NostrEvent[]>(`own/${kind}/${d}`)) ?? [];
    const remote = await this.transport.query(this.cfg.relays, { kinds: [kind], authors: [me], '#d': [d] });
    const all = [...local, ...remote].filter((e) => e.pubkey === me && tagValue(e.tags, 'd') === d && verified(e));
    return latestByAddress(all)[0];
  }

  /**
   * Next version for our own event (§2.1: versions only grow). Like the Go node this is
   * max(known + 1, now): if local storage was lost and relays are unreachable, a plain
   * known + 1 would restart at 1 and be shadowed by (or roll back to) an older published version.
   */
  async nextVersion(kind: number, d: string): Promise<number> {
    const cur = await this.ownLatest(kind, d);
    return Math.max(cur ? eventVersion(cur) + 1 : 1, nowSeconds());
  }

  /** Sign, remember and publish one of our addressable events. */
  async publishOwn(template: EventTemplate): Promise<{ event: NostrEvent; result: PublishResult }> {
    const event = await this.sign(template);
    const d = tagValue(event.tags, 'd') ?? '';
    const key = `own/${event.kind}/${d}`;
    const local = (await this.storage.get<NostrEvent[]>(key)) ?? [];
    await this.storage.put(key, latestByAddress([...local, event]));
    void this.p2pService?.publish(event).catch(() => undefined);
    const result = await this.publish(event);
    return { event, result };
  }

  /** Publish our kind 10050 (relays and P2P) and remember it as our own event. */
  async publishInboxRelays(): Promise<NostrEvent> {
    const ev = await this.messenger.publishInboxRelays();
    await this.storage.put(`own/${KIND.inboxRelays}/`, [ev]);
    void this.p2pService?.publish(ev).catch(() => undefined);
    return ev;
  }
}

