/**
 * Network presets and configuration from the environment.
 *
 *   PS_NETWORK      ps-main (default) | lab
 *   PS_CONFIG_URL   a web-app style config.json (proxy-shopping-go/lab/web-config.json format) that overrides the preset
 *   PS_CONFIG_FILE  the same, from a file
 *   PS_LAB_URL      base URL of the lab's demo server (default http://localhost:8888; from Docker http://host.docker.internal:8888)
 *   PS_COORDINATORS comma-separated coordinator pubkeys that replace the preset's (advanced)
 */
import { readFile } from 'node:fs/promises';
import type { TimelockPolicy } from '@proxy-shopping/core/node';

export type RateConfig = { type: 'mempool' | 'coingecko' | 'frankfurter'; base: string };

export interface CoordinatorInfo {
  pubkey: string;
  name?: string;
  /** Where we got it from: 'preset', 'registry', 'config', 'env'. */
  source: string;
}

export interface NetworkConfig {
  /** Preset name: 'ps-main' | 'lab' (or the PS_NETWORK value for a custom config). */
  preset: string;
  /** Protocol network name (the `network` tag, §2.1). */
  network: string;
  /** Logical relay URLs (what the protocol sees). */
  relays: string[];
  /** Logical → physical relay URL, when we reach the relays through another address (lab demo server). */
  relayMap?: Record<string, string>;
  coordinators: CoordinatorInfo[];
  esplora?: string;
  evmRpc?: string;
  chainId?: number;
  deploymentsUrl?: string;
  rates: RateConfig[];
  timelockPolicy?: TimelockPolicy;
  maxClockSkewSeconds?: number;
  allowPrivateEndpoints?: boolean;
  retryIntervalMs?: number;
  /** Lab only: the faucet API (POST /btc, /evm, /mine). */
  faucet?: string;
  /** URLs of signed trust event bundles (JSON array of Nostr events, or {events: [...]}) handed to the trust directory. */
  trustBundleUrls: string[];
  /** URL of a registry coordinators.json whose coordinators are added after the preset ones. */
  coordinatorsUrl?: string;
  /** Plain statements about the state of this network, shown by network_info. */
  notes: string[];
}

export const PS_MAIN_DEFAULT_COORDINATOR = '7a0a27bb7092dc59b5bfe195d9f0e0cf81c69373b0d702a41490ed45cfccbe39';
export const REGISTRY_REPO = 'https://github.com/pad01g/proxy-shopping-registry';
export const REGISTRY_BASE = 'https://pad01g.github.io/proxy-shopping-registry';

export function psMainPreset(): NetworkConfig {
  return {
    preset: 'ps-main',
    network: 'ps-main',
    relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'],
    coordinators: [{ pubkey: PS_MAIN_DEFAULT_COORDINATOR, name: 'default ps-main coordinator', source: 'preset' }],
    esplora: 'https://mempool.space/signet/api',
    rates: [
      // BTC prices without an API key; fiat cross rates (api.frankfurter.app moved to .dev/v1)
      { type: 'mempool', base: 'https://mempool.space' },
      { type: 'frankfurter', base: 'https://api.frankfurter.dev/v1' },
    ],
    retryIntervalMs: 30_000,
    trustBundleUrls: [`${REGISTRY_BASE}/events.json`],
    coordinatorsUrl: `${REGISTRY_BASE}/coordinators.json`,
    notes: [
      'ps-main is the public network. It is new: there may be no trusted shoppers yet, and orders are only as good as the shoppers and escrows that operators list.',
      'Payments on ps-main are BTC on signet (a test network: signet coins have no market value). USDC is not available on ps-main yet.',
    ],
  };
}

/**
 * The docker compose lab through its demo server (proxy-shopping-go/lab/demo/demo-config.json and nginx.conf):
 * relays at /relay-1 and /relay-2 (MappedTransport keeps the logical wss://relay-N.test names), Esplora at /esplora,
 * anvil at /evm, the faucet at /faucet, the rate mock at /rates. Trust roots and timelock policy as in lab/web-config.json.
 */
export function labPreset(labUrl = 'http://localhost:8888'): NetworkConfig {
  const base = labUrl.replace(/\/+$/, '');
  const ws = base.replace(/^http/, 'ws');
  return {
    preset: 'lab',
    network: 'ps-lab',
    relays: ['wss://relay-1.test', 'wss://relay-2.test'],
    relayMap: { 'wss://relay-1.test': `${ws}/relay-1`, 'wss://relay-2.test': `${ws}/relay-2` },
    coordinators: [
      { pubkey: '6eac25bc912ab49582890fa47837d574e6d7932620d5410fcffec31a8f87d520', name: 'coordinator-1 (lab)', source: 'preset' },
      { pubkey: '23c66e3b8b09d6f242e501ddbff2e6a2c786b4d36a8bdffddb1299b4c5de13dd', name: 'coordinator-2 (lab)', source: 'preset' },
    ],
    esplora: `${base}/esplora`,
    evmRpc: `${base}/evm`,
    chainId: 31337,
    deploymentsUrl: `${base}/deployments/31337.json`,
    rates: [
      { type: 'coingecko', base: `${base}/rates/coingecko` },
      { type: 'frankfurter', base: `${base}/rates/frankfurter` },
    ],
    timelockPolicy: {
      btc_min_t1_blocks: 50,
      evm_min_t1_seconds: 1800,
      btc_min_gap_blocks: 20,
      evm_min_gap_seconds: 1800,
      btc_max_t2_blocks: 1000,
      evm_max_t2_seconds: 86400,
    },
    // The lab chains warp time and mine on demand (lab/web-config.json).
    maxClockSkewSeconds: 315_360_000,
    allowPrivateEndpoints: true,
    retryIntervalMs: 5000,
    faucet: `${base}/faucet`,
    trustBundleUrls: [],
    notes: [
      `lab: the local docker compose test network through its demo server ${base}. Test keys, test chains (custom signet, anvil), fake shops (e.g. https://safe-shop.test/ in region JP-13-13104, SKU A-100). Nothing here has value.`,
    ],
  };
}

/** Subset of the web app's config.json (lab/web-config.json) that may override a preset. */
interface WebConfig {
  network?: string;
  relays?: string[];
  relay_paths?: Record<string, string>;
  coordinators?: string[];
  esplora?: string;
  evm_rpc?: string;
  chain_id?: number;
  deployments_url?: string;
  rates?: RateConfig[];
  faucet_url?: string;
  timelock_policy?: TimelockPolicy;
  max_clock_skew_seconds?: number;
  allow_private_endpoints?: boolean;
  trust_bundles?: string[];
  coordinators_url?: string;
}

/** Apply a web config (paths resolved against `base`) on top of a preset. */
export function applyWebConfig(preset: NetworkConfig, c: WebConfig, base?: string): NetworkConfig {
  const abs = (u: string) => (base ? new URL(u, base).toString().replace(/\/+$/, '') : u);
  const out: NetworkConfig = { ...preset, notes: [...preset.notes] };
  if (c.network) out.network = c.network;
  if (c.relays?.length) out.relays = c.relays;
  if (c.relay_paths) {
    const b = new URL(base ?? 'http://localhost/');
    const ws = `${b.protocol === 'https:' ? 'wss' : 'ws'}://${b.host}`;
    out.relayMap = Object.fromEntries(Object.entries(c.relay_paths).map(([k, p]) => [k, `${ws}${p.startsWith('/') ? p : `/${p}`}`]));
  }
  if (c.coordinators?.length) out.coordinators = c.coordinators.map((pubkey) => ({ pubkey, source: 'config' }));
  if (c.esplora) out.esplora = abs(c.esplora);
  if (c.evm_rpc) out.evmRpc = abs(c.evm_rpc);
  if (c.chain_id) out.chainId = c.chain_id;
  if (c.deployments_url) out.deploymentsUrl = abs(c.deployments_url);
  if (c.rates?.length) out.rates = c.rates.map((r) => ({ ...r, base: abs(r.base) }));
  if (c.faucet_url) out.faucet = abs(c.faucet_url);
  if (c.timelock_policy) out.timelockPolicy = c.timelock_policy;
  if (c.max_clock_skew_seconds !== undefined) out.maxClockSkewSeconds = c.max_clock_skew_seconds;
  if (c.allow_private_endpoints !== undefined) out.allowPrivateEndpoints = c.allow_private_endpoints;
  if (c.trust_bundles) out.trustBundleUrls = c.trust_bundles.map(abs);
  if (c.coordinators_url !== undefined) out.coordinatorsUrl = c.coordinators_url ? abs(c.coordinators_url) : undefined;
  out.notes.push('Configuration overridden by PS_CONFIG_URL / PS_CONFIG_FILE.');
  return out;
}

const HEX64 = /^[0-9a-f]{64}$/;

export async function configFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<NetworkConfig> {
  const name = env.PS_NETWORK?.trim() || 'ps-main';
  let cfg: NetworkConfig;
  if (name === 'ps-main') cfg = psMainPreset();
  else if (name === 'lab') cfg = labPreset(env.PS_LAB_URL || 'http://localhost:8888');
  else if (env.PS_CONFIG_URL || env.PS_CONFIG_FILE) cfg = { ...psMainPreset(), preset: name, coordinators: [], trustBundleUrls: [], coordinatorsUrl: undefined, notes: [] };
  else throw new Error(`PS_NETWORK=${name}: unknown network (use ps-main or lab, or give PS_CONFIG_URL / PS_CONFIG_FILE)`);

  if (env.PS_CONFIG_URL) {
    const res = await fetch(env.PS_CONFIG_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`PS_CONFIG_URL ${env.PS_CONFIG_URL}: HTTP ${res.status}`);
    cfg = applyWebConfig(cfg, (await res.json()) as WebConfig, env.PS_CONFIG_URL);
  } else if (env.PS_CONFIG_FILE) {
    cfg = applyWebConfig(cfg, JSON.parse(await readFile(env.PS_CONFIG_FILE, 'utf8')) as WebConfig);
  }
  if (env.PS_COORDINATORS) {
    const pks = env.PS_COORDINATORS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = pks.filter((p) => !HEX64.test(p));
    if (bad.length) throw new Error(`PS_COORDINATORS: not 64-hex pubkeys: ${bad.join(', ')}`);
    cfg.coordinators = pks.map((pubkey) => ({ pubkey, source: 'env' }));
    cfg.coordinatorsUrl = undefined;
  }
  return cfg;
}

/**
 * Coordinators from a registry coordinators.json. Accepted shapes: ["<pk>", …], [{pubkey|pk, name?}, …],
 * {coordinators: <either of those>}. Entries that are not 64-hex pubkeys are ignored.
 */
export function parseCoordinators(json: unknown): Array<{ pubkey: string; name?: string }> {
  const list = Array.isArray(json) ? json : (json as { coordinators?: unknown })?.coordinators;
  if (!Array.isArray(list)) return [];
  const out: Array<{ pubkey: string; name?: string }> = [];
  for (const x of list) {
    const pubkey = typeof x === 'string' ? x : (x as { pubkey?: unknown; pk?: unknown })?.pubkey ?? (x as { pk?: unknown })?.pk;
    if (typeof pubkey !== 'string' || !HEX64.test(pubkey.toLowerCase())) continue;
    const name = typeof x === 'object' && x && typeof (x as { name?: unknown }).name === 'string' ? (x as { name: string }).name : undefined;
    out.push({ pubkey: pubkey.toLowerCase(), name });
  }
  return out;
}
