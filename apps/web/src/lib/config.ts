import { endpointProblem, type TimelockPolicy } from '@proxy-shopping/core/browser';

/** Runtime configuration: /config.json, overridable in Settings (kept in localStorage). */
export interface RateSourceConfig {
  type: 'frankfurter' | 'coingecko' | 'chainlink' | 'static';
  base?: string;
  /** For `static`: fixed pairs, e.g. {"BTC/JPY": 15000000}. */
  rates?: Record<string, number>;
}

export interface AppConfig {
  network: string;
  relays: string[];
  coordinators: string[];
  esplora: string;
  evm_rpc: string;
  chain_id: number;
  deployments_url: string;
  rates: RateSourceConfig[];
  faucet_url?: string;
  /** §4.5.1 user-side timelock policy (lab ships short values). */
  timelock_policy?: TimelockPolicy;
  /** Lab only: allow http:// / ws:// and private addresses. */
  allow_private_endpoints?: boolean;
  /** Cap for the BTC funding fee rate (sat/vB, default 50). */
  max_fee_rate?: number;
  /**
   * §4.5.1: largest accepted difference between the chain's clock (tip header / latest block time) and ours,
   * in seconds (default 7200). The lab ships a huge value: anvil's time is warped and its signet mines on demand.
   */
  max_clock_skew_seconds?: number;
}

const OVERRIDES_KEY = 'ps.settings.v1';

const FALLBACK: AppConfig = {
  network: 'ps-lab',
  relays: [],
  coordinators: [],
  esplora: '',
  evm_rpc: '',
  chain_id: 31337,
  deployments_url: '/deployments/31337.json',
  rates: [],
};

export async function loadBaseConfig(): Promise<AppConfig> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ...FALLBACK, ...((await res.json()) as Partial<AppConfig>) };
  } catch (err) {
    console.warn('config.json not available, using defaults', err);
    return FALLBACK;
  }
}

/** Settings may only override these; the lab flag, the timelock policy and the clock skew come from config.json alone. */
export const OVERRIDABLE: ReadonlyArray<keyof AppConfig> = [
  'network', 'relays', 'coordinators', 'esplora', 'evm_rpc', 'chain_id', 'deployments_url', 'rates', 'faucet_url', 'max_fee_rate',
];

export function loadOverrides(): Partial<AppConfig> {
  try {
    const raw = JSON.parse(localStorage.getItem(OVERRIDES_KEY) ?? '{}') as Partial<AppConfig>;
    return Object.fromEntries(Object.entries(raw).filter(([k]) => OVERRIDABLE.includes(k as keyof AppConfig))) as Partial<AppConfig>;
  } catch {
    return {};
  }
}

export function saveOverrides(o: Partial<AppConfig>): void {
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(o));
}

export function clearOverrides(): void {
  localStorage.removeItem(OVERRIDES_KEY);
}

export const effectiveConfig = (base: AppConfig, o: Partial<AppConfig>): AppConfig => ({ ...base, ...o });

/** Overridden fields whose value differs from config.json (item 14: overrides must not silently mask it). */
export function overriddenFields(base: AppConfig, o: Partial<AppConfig>): Array<keyof AppConfig> {
  return (Object.keys(o) as Array<keyof AppConfig>).filter((k) => JSON.stringify(o[k]) !== JSON.stringify(base[k]));
}

/** Endpoint fields: https / wss only unless the lab flag is set (§4.10). */
export function configProblems(c: AppConfig, allowPrivate = !!c.allow_private_endpoints): string[] {
  const policy = { allowPrivate };
  const out: string[] = [];
  const check = (label: string, url: string | undefined, kind: 'http' | 'ws') => {
    if (!url) return;
    const p = endpointProblem(url, kind, policy);
    if (p) out.push(`${label}: ${p}`);
  };
  c.relays.forEach((r) => check('relay', r, 'ws'));
  check('esplora', c.esplora, 'http');
  check('evm_rpc', c.evm_rpc, 'http');
  check('faucet_url', c.faucet_url, 'http');
  for (const r of c.rates) if (r.base) check(`rates ${r.type}`, r.base, 'http');
  // deployments_url may be same-origin (relative) — anything absolute must pass the same rule.
  if (c.deployments_url && /^[a-z]+:/i.test(c.deployments_url)) check('deployments_url', c.deployments_url, 'http');
  return out;
}

/** Endpoint fields whose value differs from config.json — the user is warned before saving. */
export const ENDPOINT_FIELDS: ReadonlyArray<keyof AppConfig> = ['relays', 'esplora', 'evm_rpc', 'deployments_url', 'rates', 'faucet_url', 'chain_id'];
