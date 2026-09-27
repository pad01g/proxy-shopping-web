import {
  CoingeckoSource, EsploraClient, EvmClient, FrankfurterSource, IndexedDBStorage, MappedTransport, PoolTransport, Session,
  type Deployments, type KeySet, type RateSource,
} from '@proxy-shopping/core/browser';
import type { ResolvedConfig } from '../config';
import type { SessionRole } from '../roles';
import { writeSnapshot, type RoleSnap } from '../snapshots';
import { dbName } from '../storage';

export interface RuntimeDeps {
  config: ResolvedConfig;
  keys: KeySet;
  deployments?: Deployments;
  /** Pubkey of the demo coordinator: the one root of trust every demo role uses (§2.4). */
  coordinator: string;
}

function rateSources(config: ResolvedConfig): RateSource[] {
  return config.urls.rates.map((r) => (r.type === 'coingecko' ? new CoingeckoSource(r.base) : new FrankfurterSource(r.base, ['JPY'])));
}

/**
 * One role's own Session: its keys, its IndexedDB database and its own relay connections. The protocol sees the
 * logical relay URLs; MappedTransport connects to the demo server's websocket paths instead.
 */
export async function createSession(role: SessionRole, d: RuntimeDeps): Promise<{ session: Session; storage: IndexedDBStorage }> {
  const storage = await IndexedDBStorage.open(dbName(role));
  const c = d.config;
  const session = new Session({
    keys: d.keys,
    transport: new MappedTransport(new PoolTransport(), c.physicalRelays),
    storage,
    config: {
      network: c.network,
      relays: c.relays,
      coordinators: [d.coordinator],
      // The lab is fast: resend unacknowledged messages after 5 s instead of 30 s.
      retryIntervalMs: 5000,
      timelockPolicy: c.timelock_policy,
      maxClockSkewSeconds: c.max_clock_skew_seconds,
      allowPrivateEndpoints: !!c.allow_private_endpoints,
    },
    chain: new EsploraClient(c.urls.esplora),
    evm: d.deployments ? new EvmClient(d.deployments.chain_id, c.urls.evm, d.keys.evmAccount, d.deployments) : undefined,
    rates: rateSources(c),
  });
  return { session, storage };
}

/**
 * Base of the four role runtimes: owns the session and publishes the role's snapshot (debounced after every
 * change, and on a timer for state that only the network or chain can tell).
 */
export abstract class RoleRuntime<R extends SessionRole> {
  private timer?: ReturnType<typeof setTimeout>;
  private poller?: ReturnType<typeof setInterval>;
  private last = '';
  private readonly listeners = new Set<() => void>();
  private stopped = false;
  protected readonly cleanups: Array<() => void> = [];

  protected constructor(
    readonly role: R,
    readonly session: Session,
    protected readonly storage: IndexedDBStorage,
    readonly deps: RuntimeDeps,
    private readonly pollMs: number,
  ) {}

  get keys(): KeySet {
    return this.session.keys;
  }

  get pubkey(): string {
    return this.keys.nostrPublicKey;
  }

  /** The role's current summary for the guide and the other windows. */
  protected abstract snapshot(): Promise<RoleSnap<R>>;

  /** Runs when the runtime starts (attach clients, start the messenger, …). */
  protected abstract begin(): Promise<void>;

  async start(): Promise<void> {
    await this.begin();
    this.poller = setInterval(() => this.changed(), this.pollMs);
    this.changed();
  }

  /** Something changed: rebuild the snapshot soon. */
  changed(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.publishSnapshot();
    }, 150);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async publishSnapshot(): Promise<void> {
    try {
      const snap = await this.snapshot();
      if (this.stopped) return;
      // `at` changes every time; compare the rest.
      const body = JSON.stringify({ ...snap, at: 0 });
      if (body === this.last) return;
      this.last = body;
      writeSnapshot(this.role, snap);
      for (const fn of this.listeners) fn();
    } catch (err) {
      console.warn(`${this.role} snapshot failed`, err);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poller) clearInterval(this.poller);
    for (const fn of this.cleanups.splice(0)) fn();
    this.session.stop();
    this.session.transport.close();
    this.storage.close();
  }
}
