/**
 * HTTP APIs of the lab, reached through the demo server (proxy-shopping-go/lab/demo/nginx.conf):
 * the faucet, the shopper nodes' admin API (the server adds the bearer token) and the rate mock.
 * Lab only — on a real network none of these exist.
 */

async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${new URL(url).pathname}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface Heights {
  btc: number;
  evm_time: number;
}

export function faucetApi(base: string) {
  return {
    btc: (address: string, sats = 1_000_000) => call<{ txid: string }>('POST', `${base}/btc`, { address, sats }),
    evm: (address: string, opts: { eth?: string; usdc?: string } = {}) => call('POST', `${base}/evm`, { address, eth: opts.eth ?? '1', usdc: opts.usdc ?? '1000' }),
    mine: (blocks: number) => call<{ height: number }>('POST', `${base}/mine`, { blocks }),
    evmTime: (seconds: number) => call('POST', `${base}/evm/time`, { seconds }),
    height: () => call<Heights>('GET', `${base}/height`),
  };
}

/** psnode GET /status (docs/lab.md). */
export interface NodeStatus {
  pubkey: string;
  role: string;
  network: string;
  peer_id: string;
  reachability?: string;
  trust: Record<string, number>;
  paused_until?: number;
}

/** One row of GET /orders. */
export interface NodeOrderSummary {
  id: string;
  state: string;
  user: string;
  asset?: string;
  lock_amount?: string;
  ship_status?: string;
  payout_tx?: string;
  updated: number;
  error?: string;
}

/** GET /orders/{id}: the stored order (only the fields the demo shows). */
export interface NodeOrder extends NodeOrderSummary {
  created: number;
  risk_score?: number;
  payout_by?: string;
  request?: { shop_url: string; items: Array<{ sku: string; qty: number }> };
  purchase?: { status: string; shop_order_id?: string; total?: { amount: string; currency: string }; error?: string };
  tracking?: Array<{ status: string; tracking_no?: string; updated_at: number }>;
  pending?: Record<string, { attempts?: number; error?: string; tx?: string }>;
  history: Array<{ at: number; state: string; detail?: string }>;
}

/** GET /trust: the events a node holds and the effective combinations it derives (§2.4). */
export interface NodeTrust {
  coordinators: string[];
  events: Array<{ kind: number; pubkey: string; tags: string[][] }>;
  effective: Array<{ region: string; shopper: string; escrow: string; operator: string; coordinator: string; list_version: number }>;
}

export function nodeApi(base: string) {
  return {
    status: () => call<NodeStatus>('GET', `${base}/status`),
    trust: () => call<NodeTrust>('GET', `${base}/trust`),
    orders: () => call<NodeOrderSummary[]>('GET', `${base}/orders`),
    order: (id: string) => call<NodeOrder>('GET', `${base}/orders/${id}`),
    pause: (seconds: number) => call<{ paused_until: number }>('POST', `${base}/admin/pause`, { seconds }),
    resume: () => call<{ was_paused: boolean }>('POST', `${base}/admin/resume`, {}),
    resolveRefund: (id: string) => call('POST', `${base}/orders/${id}/resolve`, { action: 'refund' }),
  };
}

export function ratesApi(base: string) {
  return {
    get: () => call<Record<string, string>>('GET', `${base}/admin/rates`),
    set: (rates: Record<string, string>) => call<Record<string, string>>('POST', `${base}/admin/rates`, rates),
  };
}

/** ETH balance of any address (wei), straight from the JSON-RPC. */
export async function ethBalance(rpc: string, address: string): Promise<bigint> {
  const r = await call<{ result?: string; error?: { message: string } }>('POST', rpc, { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] });
  if (!r.result) throw new Error(r.error?.message ?? 'eth_getBalance failed');
  return BigInt(r.result);
}

/** USDC (ERC-20 balanceOf) of any address, in base units. */
export async function erc20Balance(rpc: string, token: string, address: string): Promise<bigint> {
  const data = `0x70a08231${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  const r = await call<{ result?: string; error?: { message: string } }>('POST', rpc, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data }, 'latest'] });
  if (!r.result) throw new Error(r.error?.message ?? 'eth_call failed');
  return BigInt(r.result === '0x' ? 0 : r.result);
}

/** Confirmed and unconfirmed sats of a BTC address (Esplora /address/{a}/utxo). */
export async function btcBalance(esplora: string, address: string): Promise<bigint> {
  const utxos = await call<Array<{ value: number }>>('GET', `${esplora}/address/${address}/utxo`);
  return utxos.reduce((n, u) => n + BigInt(u.value), 0n);
}
