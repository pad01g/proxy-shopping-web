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

export function loadOverrides(): Partial<AppConfig> {
  try {
    return JSON.parse(localStorage.getItem(OVERRIDES_KEY) ?? '{}') as Partial<AppConfig>;
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
