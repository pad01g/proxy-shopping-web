/**
 * What the demo needs besides its role sessions: the relays, Esplora, the EVM RPC, the rate sources, and the
 * lab-only services (faucet, mining / time warp, the shopper node's admin API, the rate mock). In lab mode these
 * are the docker compose lab behind the demo server (HTTP and websockets, lab-api.ts); in mock mode the
 * in-browser world (src/mock). The rest of the page only sees this interface.
 */
import {
  CoingeckoSource, EsploraClient, EvmClient, FrankfurterSource, MappedTransport, PoolTransport,
  type ChainApi, type Deployments, type KeySet, type NostrTransport, type RateSource,
} from '@proxy-shopping/core/browser';
import type { WorldClient } from '../mock/client';
import { serverUrl, type ResolvedConfig, type ShopperNode } from './config';
import {
  btcBalance, erc20Balance, ethBalance, faucetApi, nodeApi, ratesApi,
  type Heights, type NodeOrder, type NodeOrderSummary, type NodeStatus, type NodeTrust,
} from './lab-api';

export interface FaucetApi {
  btc(address: string, sats?: number): Promise<{ txid: string }>;
  evm(address: string, opts?: { eth?: string; usdc?: string }): Promise<unknown>;
  mine(blocks: number): Promise<{ height: number }>;
  evmTime(seconds: number): Promise<unknown>;
  height(): Promise<Heights>;
}

export interface NodeApi {
  status(): Promise<NodeStatus>;
  trust(): Promise<NodeTrust>;
  orders(): Promise<NodeOrderSummary[]>;
  order(id: string): Promise<NodeOrder>;
  pause(seconds: number): Promise<{ paused_until: number }>;
  resume(): Promise<{ was_paused: boolean }>;
  resolveRefund(id: string): Promise<unknown>;
}

export interface RatesApi {
  get(): Promise<Record<string, string>>;
  set(rates: Record<string, string>): Promise<Record<string, string>>;
}

export interface Backend {
  readonly mock: boolean;
  /** Mock mode: whether every window of this browser shares the world (SharedWorker). */
  readonly sharedAcrossWindows: boolean;
  readonly faucet: FaucetApi;
  node(shopper: ShopperNode): NodeApi;
  readonly rates: RatesApi;
  balances: {
    btc(address: string): Promise<bigint>;
    eth(address: string): Promise<bigint>;
    erc20(token: string, address: string): Promise<bigint>;
  };
  /** For a role's Session. */
  transport(): NostrTransport;
  chain(): ChainApi;
  evm(keys: KeySet, deployments: Deployments): EvmClient;
  rateSources(): RateSource[];
  /** "Reset demo": the mock world is wiped too (the lab's chains and nodes are not). */
  reset(): Promise<void>;
}

/** The docker compose lab through the demo server (proxy-shopping-go/lab/demo/nginx.conf). */
export function labBackend(config: ResolvedConfig): Backend {
  const u = config.urls;
  return {
    mock: false,
    sharedAcrossWindows: true,
    faucet: faucetApi(u.faucet),
    node: (shopper) => nodeApi(serverUrl(shopper.node)),
    rates: ratesApi(u.ratesAdmin),
    balances: {
      btc: (a) => btcBalance(u.esplora, a),
      eth: (a) => ethBalance(u.evm, a),
      erc20: (t, a) => erc20Balance(u.evm, t, a),
    },
    // The protocol sees the logical relay URLs; MappedTransport connects to the demo server's websocket paths.
    transport: () => new MappedTransport(new PoolTransport(), config.physicalRelays),
    chain: () => new EsploraClient(u.esplora),
    evm: (keys, d) => new EvmClient(d.chain_id, u.evm, keys.evmAccount, d),
    rateSources: () => u.rates.map((r) => (r.type === 'coingecko' ? new CoingeckoSource(r.base) : new FrankfurterSource(r.base, ['JPY']))),
    reset: async () => undefined,
  };
}

/** The in-browser world (src/mock/world), reached through its worker. */
export function mockBackend(world: WorldClient): Backend {
  const call = <T,>(m: string, ...p: unknown[]) => world.call<T>(m, ...p);
  const erc20 = async (token: string, address: string) => {
    const data = `0x70a08231${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
    const r = await call<string>('evm.request', { method: 'eth_call', params: [{ to: token, data }, 'latest'] });
    return BigInt(r === '0x' ? 0 : r);
  };
  return {
    mock: true,
    sharedAcrossWindows: world.shared,
    faucet: {
      btc: (address, sats = 1_000_000) => call('faucet.btc', address, sats),
      evm: (address, opts = {}) => call('faucet.evm', address, { eth: opts.eth ?? '1', usdc: opts.usdc ?? '1000' }),
      mine: (blocks) => call('faucet.mine', blocks),
      evmTime: (seconds) => call('faucet.evmTime', seconds),
      height: () => call('faucet.height'),
    },
    node: () => ({
      status: () => call('node.status'),
      trust: () => call('node.trust'),
      orders: () => call('node.orders'),
      order: (id) => call('node.order', id),
      pause: (seconds) => call('node.pause', seconds),
      resume: () => call('node.resume'),
      resolveRefund: (id) => call('node.resolveRefund', id),
    }),
    rates: { get: () => call('rates.get'), set: (r) => call('rates.set', r) },
    balances: {
      btc: async (a) => (await call<Array<{ value: number }>>('btc.utxos', a)).reduce((n, x) => n + BigInt(x.value), 0n),
      eth: async (a) => BigInt(await call<string>('evm.request', { method: 'eth_getBalance', params: [a, 'latest'] })),
      erc20,
    },
    transport: () => world.transport(),
    chain: () => world.chain(),
    evm: (keys, d) => new EvmClient(d.chain_id, world.evmTransport(), keys.evmAccount, d, { pollingInterval: 250 }),
    rateSources: () => {
      const f = world.ratesFetch();
      return [new CoingeckoSource('https://rates.test/coingecko', f), new FrankfurterSource('https://rates.test/frankfurter', ['JPY'], f)];
    },
    reset: async () => {
      await call('world.reset');
    },
  };
}
