import { normalizeRelayUrl, type TimelockPolicy } from '@proxy-shopping/core/browser';

/**
 * /demo-config.json, served by the demo server (proxy-shopping-go/lab/demo/demo-config.json).
 * Paths are relative to the page's origin; relays are logical URLs (what the protocol sees) mapped to
 * websocket paths on the demo server (what the browser connects to).
 */
export interface DemoConfig {
  network: string;
  /** Logical relay URLs, as the Go nodes inside the lab use them. */
  relays: string[];
  /** Logical relay URL → path on the demo server (e.g. "/relay-1"). */
  relay_paths: Record<string, string>;
  esplora: string;
  evm_rpc: string;
  faucet: string;
  deployments: string;
  rates: Array<{ type: 'coingecko' | 'frankfurter'; base: string }>;
  /** The rate mock's admin API (POST /admin/rates), default "/rates". */
  rates_admin?: string;
  /** The lab's demo coordinator (lab/keys/coordinator-demo.mnemonic); every lab node trusts its pubkey. */
  coordinator_mnemonic: string;
  shoppers: ShopperNode[];
  /** Endpoints the operator list recommends (protocol-visible, so the lab's public names). */
  list_endpoints?: { esplora: string; evm_rpc: string };
  timelock_policy?: TimelockPolicy;
  max_clock_skew_seconds?: number;
  allow_private_endpoints?: boolean;
}

export interface ShopperNode {
  name: string;
  pubkey: string;
  /** Demo server path of the node's admin API (the server adds the bearer token). */
  node: string;
  evm_address?: string;
}

/** The config with every endpoint made absolute for this page. */
export interface ResolvedConfig extends DemoConfig {
  /** Logical relay URL → ws(s)://<this host><path>. */
  physicalRelays: Map<string, string>;
  urls: { esplora: string; evm: string; faucet: string; deployments: string; rates: DemoConfig['rates']; ratesAdmin: string };
}

export async function loadConfig(): Promise<ResolvedConfig> {
  const res = await fetch('/demo-config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`/demo-config.json: HTTP ${res.status}`);
  return resolveConfig((await res.json()) as DemoConfig, window.location);
}

export function resolveConfig(c: DemoConfig, loc: Pick<Location, 'origin' | 'host' | 'protocol'>): ResolvedConfig {
  const missing = (['network', 'relays', 'relay_paths', 'esplora', 'evm_rpc', 'faucet', 'deployments', 'coordinator_mnemonic', 'shoppers'] as const)
    .filter((k) => c[k] === undefined || c[k] === '');
  if (missing.length) throw new Error(`demo-config.json に ${missing.join(', ')} がありません`);
  const http = (p: string) => new URL(p, loc.origin).toString().replace(/\/+$/, '');
  const wsScheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  const physicalRelays = new Map<string, string>();
  for (const [logical, path] of Object.entries(c.relay_paths)) {
    physicalRelays.set(normalizeRelayUrl(logical), `${wsScheme}://${loc.host}${path.startsWith('/') ? path : `/${path}`}`);
  }
  return {
    ...c,
    physicalRelays,
    urls: {
      esplora: http(c.esplora),
      evm: http(c.evm_rpc),
      faucet: http(c.faucet),
      deployments: http(c.deployments),
      rates: c.rates.map((r) => ({ ...r, base: http(r.base) })),
      ratesAdmin: http(c.rates_admin ?? '/rates'),
    },
  };
}

/** Absolute URL of a demo server path (e.g. a shopper node's admin API). */
export const serverUrl = (path: string): string => new URL(path, window.location.origin).toString().replace(/\/+$/, '');
