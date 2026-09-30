/**
 * The running participant behind the tools: one core Session with a UserClient attached, started once and kept
 * running while the server runs, so messages from shoppers and escrows keep arriving and are stored.
 */
import {
  bundleEvents, EsploraClient, EvmClient, FileStorage, rateSourceFromConfig, KeySet, MappedTransport, PoolTransport, Session, UserClient,
  type Deployments, type DirectorySnapshot, type NostrTransport, type RateSource,
} from '@proxy-shopping/core/node';
import { parseCoordinators, type CoordinatorInfo, type NetworkConfig } from './config.js';
import { loadOrCreateMnemonic, mnemonicPath, statePath } from './identity.js';

export interface LabFaucet {
  btc(address: string, sats: number): Promise<{ txid?: string }>;
  evm(address: string, opts: { eth?: string; usdc?: string }): Promise<unknown>;
  mine(blocks: number): Promise<{ height?: number }>;
}

export interface TrustStatus {
  bundleUrls: string[];
  /** Verified events in the trust bundles when last checked (the directory fetches them itself on every refresh). */
  bundleEvents: number;
  coordinatorsUrl?: string;
  registryCoordinators: number;
  errors: string[];
  lastRefresh?: number;
}

/** Coordinators and signed trust events that do not come from the relays (registry, bundles). */
export interface TrustSource {
  /** Re-read the registry (when stale), the trust bundles and the relays. */
  refresh(): Promise<DirectorySnapshot>;
  status(): TrustStatus;
}

export interface Runtime {
  cfg: NetworkConfig;
  session: Session;
  user: UserClient;
  trust: TrustSource;
  /** Lab only. */
  faucet?: LabFaucet;
  dataDir?: string;
  identityCreated?: boolean;
  /** Reads the mnemonic for export_backup; absent when the runtime has no data dir (tests). */
  exportMnemonic?: () => Promise<string>;
  /** Why there is no EVM client, when there is none. */
  evmNote?: string;
  close(): void;
}

async function getJson(url: string, ms = 15_000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url}: not JSON (${text.slice(0, 60).replace(/\s+/g, ' ')}…)`);
  }
}

/**
 * Registry coordinators (added after the preset ones) and the state of the trust bundles, checked at start and again
 * when older than `maxAgeMs`. The bundle events themselves reach the directory through SessionConfig.trustBundles.
 */
export class RegistryTrust implements TrustSource {
  private st: TrustStatus;
  private fetchedAt = 0;

  constructor(
    private readonly session: Session,
    private readonly cfg: NetworkConfig,
    private readonly maxAgeMs = 10 * 60_000,
  ) {
    this.st = { bundleUrls: cfg.trustBundleUrls, bundleEvents: 0, coordinatorsUrl: cfg.coordinatorsUrl, registryCoordinators: 0, errors: [] };
  }

  status(): TrustStatus {
    return { ...this.st, errors: [...this.st.errors] };
  }

  private async fetchRegistry(): Promise<void> {
    const errors: string[] = [];
    if (this.cfg.coordinatorsUrl) {
      try {
        const found = parseCoordinators(await getJson(this.cfg.coordinatorsUrl));
        this.st.registryCoordinators = found.length;
        const known = new Set(this.cfg.coordinators.map((c) => c.pubkey));
        const added: CoordinatorInfo[] = found.filter((c) => !known.has(c.pubkey)).map((c) => ({ ...c, source: 'registry' }));
        if (added.length) {
          this.cfg.coordinators.push(...added);
          this.session.updateConfig({ coordinators: this.cfg.coordinators.map((c) => c.pubkey) });
        }
      } catch (err) {
        errors.push(`coordinators: ${(err as Error).message}`);
      }
    }
    let events = 0;
    for (const url of this.cfg.trustBundleUrls) {
      try {
        events += bundleEvents(await getJson(url)).length;
      } catch (err) {
        errors.push(`trust bundle: ${(err as Error).message}`);
      }
    }
    this.st.bundleEvents = events;
    this.st.errors = errors;
    this.fetchedAt = Date.now();
  }

  async refresh(): Promise<DirectorySnapshot> {
    if (Date.now() - this.fetchedAt > this.maxAgeMs) await this.fetchRegistry();
    const snap = await this.session.directory.refresh();
    this.st.lastRefresh = Date.now();
    return snap;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(600_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export function labFaucet(base: string): LabFaucet {
  return {
    btc: (address, sats) => postJson(`${base}/btc`, { address, sats }),
    evm: (address, o) => postJson(`${base}/evm`, { address, eth: o.eth ?? '1', usdc: o.usdc ?? '1000' }),
    mine: (blocks) => postJson(`${base}/mine`, { blocks }),
  };
}

export function rateSources(cfg: NetworkConfig): RateSource[] {
  return cfg.rates.map((r) => rateSourceFromConfig(r));
}

export interface StartOptions {
  dataDir: string;
  /** Log line sink (stderr in the server; stdout belongs to the MCP protocol). */
  log?: (line: string) => void;
  /** Replaces the relay transport (tests). */
  transport?: NostrTransport;
}

/** Build and start the session for `cfg` with the data dir's identity. */
export async function startRuntime(cfg: NetworkConfig, opts: StartOptions): Promise<Runtime> {
  const log = opts.log ?? (() => undefined);
  const { mnemonic, created } = await loadOrCreateMnemonic(opts.dataDir);
  const keys = KeySet.fromMnemonic(mnemonic);
  const storage = await FileStorage.open(statePath(opts.dataDir, cfg.network));
  const transport = opts.transport ?? (cfg.relayMap ? new MappedTransport(new PoolTransport(), cfg.relayMap) : new PoolTransport());

  let deployments: Deployments | undefined;
  let evm: EvmClient | undefined;
  let evmNote: string | undefined;
  if (cfg.evmRpc && cfg.deploymentsUrl) {
    try {
      deployments = (await getJson(cfg.deploymentsUrl)) as Deployments;
      evm = new EvmClient(deployments.chain_id, cfg.evmRpc, keys.evmAccount, deployments);
    } catch (err) {
      evmNote = `EVM unavailable: ${(err as Error).message}`;
      log(evmNote);
    }
  } else {
    evmNote = `no EVM chain configured for ${cfg.network}: USDC orders are not available`;
  }

  const session = new Session({
    keys,
    transport,
    storage,
    config: {
      network: cfg.network,
      relays: cfg.relays,
      coordinators: cfg.coordinators.map((c) => c.pubkey),
      trustBundles: cfg.trustBundleUrls,
      retryIntervalMs: cfg.retryIntervalMs,
      timelockPolicy: cfg.timelockPolicy,
      maxClockSkewSeconds: cfg.maxClockSkewSeconds,
      allowPrivateEndpoints: cfg.allowPrivateEndpoints,
    },
    chain: cfg.esplora ? new EsploraClient(cfg.esplora) : undefined,
    evm,
    rates: rateSources(cfg),
  });
  const user = new UserClient(session, { deployments }).attach();
  user.on('error', ({ orderId, error }) => log(`order ${orderId?.slice(0, 8) ?? '-'}: ${error.message}`));
  session.messenger.on('dropped', ({ inner, reason }) => log(`dropped message ${inner.id.slice(0, 8)}: ${reason}`));
  await session.start();
  // Our inbox relays (kind 10050) so shoppers and escrows know where to reach us; best effort.
  void session.publishInboxRelays().catch((err) => log(`publishing inbox relays failed: ${(err as Error).message}`));

  const trust = new RegistryTrust(session, cfg);
  void trust.refresh().catch((err) => log(`trust refresh failed: ${(err as Error).message}`));

  return {
    cfg,
    session,
    user,
    trust,
    faucet: cfg.faucet ? labFaucet(cfg.faucet) : undefined,
    dataDir: opts.dataDir,
    identityCreated: created,
    exportMnemonic: async () => (await loadOrCreateMnemonic(opts.dataDir)).mnemonic,
    evmNote,
    close: () => {
      user.detach();
      session.stop();
      session.transport.close();
    },
  };
}

export { mnemonicPath };
