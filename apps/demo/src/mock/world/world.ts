/**
 * Everything the lab runs besides the demo's own role sessions, in one object that lives in the browser (a
 * SharedWorker, so every window of the browser sees the same world): Nostr relays, the BTC chain with its
 * miner, the EVM, the rate mock, the shops and the bot, the faucet, and the shopper-1 node. The demo page talks
 * to it through `call` (worker.ts, client.ts); nothing here opens a network connection.
 *
 * State is kept in a Storage (IndexedDB in the browser) so a reload continues the same world; `reset` wipes it.
 */
import {
  CoingeckoSource, EvmClient, FrankfurterSource, KeySet, KIND, ScopedStorage, Session,
  type FetchLike, type NostrEvent, type NostrTransport, type Storage,
} from '@proxy-shopping/core/browser';
import { custom } from 'viem';
import type { Filter } from 'nostr-tools/filter';
import { MockBtcChain, type BtcState } from './btc/chain';
import { MockEvm, type EvmOp } from './evm/evm';
import { EvmFaucet } from './evm/faucet';
import { LAB_DEPLOYMENTS } from './evm/genesis';
import { MockRates } from './rates';
import { MockRelays } from './relay';
import { MockShopperNode } from './shopper';
import { MockShops, type ShopsState } from './shops';
import {
  MOCK_COORDINATOR_MNEMONIC, MOCK_MAX_CLOCK_SKEW, MOCK_NETWORK, MOCK_RELAYS, MOCK_SHOPPER_MNEMONIC, MOCK_TIMELOCK_POLICY,
} from '../constants';

export { MOCK_MAX_CLOCK_SKEW, MOCK_NETWORK, MOCK_RELAYS, MOCK_TIMELOCK_POLICY };
/** The lab faucet's key (lab/keys/faucet.mnemonic). */
const FAUCET_MNEMONIC = 'defense girl explain south shine scissors view soup code talk fence town';
export const RATES_BASE = { coingecko: 'https://rates.test/coingecko', frankfurter: 'https://rates.test/frankfurter' };

export interface WorldEvents {
  /** A relay subscription's event or end of stored events. */
  event(sub: string, e: NostrEvent): void;
  eose(sub: string): void;
}

export interface Heights {
  btc: number;
  evm_time: number;
}

/** A FetchLike answering the rate mock's URLs (CoinGecko and Frankfurter formats); anything else is refused. */
export function ratesFetch(rates: () => MockRates): FetchLike {
  return async (url) => {
    const path = url.replace(/^https:\/\/rates\.test/, '');
    const body = url.startsWith('https://rates.test/') ? rates().answer(path) : undefined;
    const ok = body !== undefined;
    return {
      ok,
      status: ok ? 200 : 404,
      json: async () => body,
      text: async () => (ok ? JSON.stringify(body) : 'not found'),
    };
  };
}

export class MockWorld {
  relays!: MockRelays;
  btc!: MockBtcChain;
  evm!: MockEvm;
  rates!: MockRates;
  shops!: MockShops;
  shopper!: MockShopperNode;
  private evmFaucet!: EvmFaucet;
  private subs = new Map<string, { close(): void }>();
  private writes: Promise<unknown> = Promise.resolve();
  readonly shopperKeys = KeySet.fromMnemonic(MOCK_SHOPPER_MNEMONIC);
  readonly faucetKeys = KeySet.fromMnemonic(FAUCET_MNEMONIC);
  readonly coordinator = KeySet.fromMnemonic(MOCK_COORDINATOR_MNEMONIC).nostrPublicKey;

  private constructor(
    private readonly storage: Storage,
    private readonly opts: { autoMineMs?: number; now?: () => number; tickMs?: number },
  ) {}

  static async open(storage: Storage, opts: { autoMineMs?: number; now?: () => number; tickMs?: number } = {}): Promise<MockWorld> {
    const w = new MockWorld(storage, opts);
    await w.load();
    return w;
  }

  /** Queue a storage write (in order; the worker may be stopped at any time after it). */
  private write(fn: () => Promise<unknown>): void {
    this.writes = this.writes.then(fn, fn).catch((e) => console.warn('mock world: write failed', e));
  }

  /** Wait until every write so far is stored. */
  flush(): Promise<unknown> {
    return this.writes;
  }

  private async load(): Promise<void> {
    const st = this.storage;
    const relayStore = new ScopedStorage(st, 'relay/');
    this.relays = new MockRelays(MOCK_RELAYS, {
      onAdd: (url, e) => this.write(() => relayStore.put(`${url}/${e.id}`, e)),
      onRemove: (url, id) => this.write(() => relayStore.delete(`${url}/${id}`)),
    });
    for (const url of MOCK_RELAYS) this.relays.load(url, (await relayStore.list<NostrEvent>(`${url}/`)).map(([, e]) => e));

    this.btc = new MockBtcChain({
      faucet: this.faucetKeys.btcWallet,
      state: await st.get<BtcState>('btc'),
      now: this.opts.now,
      autoMineMs: this.opts.autoMineMs ?? 1000,
      onChange: () => this.write(() => st.put('btc', this.btc.snapshot())),
    });
    if (!(await st.get('btc'))) this.write(() => st.put('btc', this.btc.snapshot()));

    this.evm = await MockEvm.create({
      chainId: LAB_DEPLOYMENTS.chain_id,
      now: this.opts.now,
      log: await st.get<EvmOp[]>('evm'),
      onLog: (log) => {
        const copy = [...log];
        this.write(() => st.put('evm', copy));
      },
    });
    this.evmFaucet = new EvmFaucet(this.evm, LAB_DEPLOYMENTS);
    this.rates = new MockRates(await st.get<Record<string, string>>('rates'), (r) => this.write(() => st.put('rates', r)));
    this.shops = new MockShops(await st.get<ShopsState>('shops'), () => this.write(() => st.put('shops', this.shops.state)));

    const session = new Session({
      keys: this.shopperKeys,
      transport: this.transport(),
      storage: new ScopedStorage(st, 'shopper-session/'),
      config: {
        network: MOCK_NETWORK, relays: MOCK_RELAYS, coordinators: [this.coordinator], retryIntervalMs: 5000,
        allowPrivateEndpoints: true, maxClockSkewSeconds: MOCK_MAX_CLOCK_SKEW,
      },
      chain: this.btc,
      evm: this.evmClient(this.shopperKeys),
      rates: this.rateSources(),
    });
    this.shopper = new MockShopperNode({ session, storage: st, btc: this.btc, shops: this.shops, network: MOCK_NETWORK, tickMs: this.opts.tickMs });
    await this.shopper.start();
  }

  /** In-process relay access for sessions that live in the world (the shopper node, tests). */
  transport(): NostrTransport {
    return {
      publish: async (relays, e) => this.relays.publish(relays, e),
      query: async (relays, f) => this.relays.query(relays, f),
      subscribe: (relays, f, onEvent, onEose) => this.relays.subscribe(relays, f, onEvent, onEose),
      close: () => undefined,
    };
  }

  evmClient(keys: KeySet): EvmClient {
    return new EvmClient(LAB_DEPLOYMENTS.chain_id, custom({ request: (a) => this.evm.request(a as { method: string; params?: unknown[] }) }), keys.evmAccount, LAB_DEPLOYMENTS, { pollingInterval: 100 });
  }

  rateSources() {
    const f = ratesFetch(() => this.rates);
    return [new CoingeckoSource(RATES_BASE.coingecko, f), new FrankfurterSource(RATES_BASE.frankfurter, ['JPY'], f)];
  }

  stop(): void {
    this.shopper.stop();
    this.btc.stop();
    for (const s of this.subs.values()) s.close();
    this.subs.clear();
  }

  /** Wipe the world (every key of its storage) and start a fresh one. */
  async reset(): Promise<void> {
    this.stop();
    await this.flush();
    for (const [k] of await this.storage.list('')) await this.storage.delete(k);
    this.writes = Promise.resolve();
    await this.load();
  }

  // ---------- lab services (the faucet's HTTP API, the node's admin API) ----------

  heights(): Heights {
    return { btc: this.btc.height, evm_time: this.evm.latestTime() };
  }

  async faucetBtc(address: string, sats = 1_000_000): Promise<{ txid: string }> {
    if (!(sats > 0 && sats <= 100_000_000)) throw new Error('sats must be 1..100000000');
    return { txid: await this.btc.faucetSend(address, sats) };
  }

  /** ETH and USDC as decimal strings, like the faucet's POST /evm {"eth": "1", "usdc": "1000"}. */
  async faucetEvm(address: string, amounts: { eth?: string; usdc?: string } = {}): Promise<{ ok: true }> {
    const units = (v: string | undefined, dflt: string, dec: number) => {
      const s = v ?? dflt;
      if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`bad amount ${s}`);
      const [w, f = ''] = s.split('.');
      return BigInt(w) * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
    };
    await this.evmFaucet.fund(address, { eth: units(amounts.eth, '1', 18), usdc: units(amounts.usdc, '1000', 6) });
    return { ok: true };
  }

  mine(blocks: number): { height: number } {
    if (!(blocks >= 1 && blocks <= 1000)) throw new Error('blocks must be 1..1000');
    return { height: this.btc.mine(blocks) };
  }

  async evmTime(seconds: number): Promise<{ evm_time: number }> {
    if (!(seconds >= 1)) throw new Error('seconds must be ≥ 1');
    return { evm_time: await this.evm.increaseTime(seconds) };
  }

  /** psnode GET /status. */
  nodeStatus() {
    const lists: Record<string, number> = {};
    for (const [op, l] of this.shopper.directory.current?.lists ?? []) lists[op] = l.version;
    return {
      pubkey: this.shopperKeys.nostrPublicKey,
      role: 'shopper',
      network: MOCK_NETWORK,
      peer_id: 'mock (no libp2p in the page)',
      reachability: 'in-page',
      trust: lists,
      ...(this.shopper.paused ? { paused_until: this.shopper.pausedUntilTime } : {}),
    };
  }

  /** psnode GET /trust: the events the node holds and the effective rows. */
  nodeTrust() {
    const cur = this.shopper.directory.current;
    return {
      coordinators: [this.coordinator],
      events: [...(cur?.escrows.values() ?? [])].map((p) => ({ kind: KIND.escrowProfile, pubkey: p.pubkey, tags: [] as string[][] })),
      effective: (cur?.entries ?? []).map((e) => ({
        region: e.region, shopper: e.shopper, escrow: e.escrow, operator: e.provenance.operator, coordinator: e.provenance.coordinator, list_version: e.provenance.listVersion,
      })),
    };
  }

  async nodeOrders() {
    return (await this.shopper.orders()).map((o) => this.shopper.summary(o));
  }

  async nodeOrder(id: string) {
    const o = await this.shopper.order(id);
    if (!o) throw new Error(`GET /orders/${id}: HTTP 404 unknown order`);
    return this.shopper.detail(o);
  }

  // ---------- the RPC surface (client.ts) ----------

  /** One call from a page. `events` delivers relay subscription events back to that page. */
  async call(method: string, params: unknown[], events: WorldEvents): Promise<unknown> {
    const p = params as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    switch (method) {
      case 'relay.publish': return this.relays.publish(p[0], p[1]);
      case 'relay.query': return this.relays.query(p[0], p[1] as Filter);
      case 'relay.subscribe': {
        const id = String(p[0]);
        this.subs.get(id)?.close();
        this.subs.set(id, this.relays.subscribe(p[1], p[2] as Filter, (e) => events.event(id, e), () => events.eose(id)));
        return true;
      }
      case 'relay.unsubscribe': {
        this.subs.get(String(p[0]))?.close();
        this.subs.delete(String(p[0]));
        return true;
      }
      case 'btc.utxos': return this.btc.utxos(p[0]);
      case 'btc.txHex': return this.btc.txHex(p[0]);
      case 'btc.broadcast': return this.btc.broadcast(p[0]);
      case 'btc.tipHeight': return this.btc.tipHeight();
      case 'btc.tipTime': return this.btc.tipTime();
      case 'btc.txStatus': return this.btc.txStatus(p[0]);
      case 'btc.outspend': return this.btc.outspend(p[0], p[1]);
      case 'btc.feeEstimates': return this.btc.feeEstimates();
      case 'evm.request': return this.evm.request(p[0]);
      case 'rates.get': return this.rates.get();
      case 'rates.set': return this.rates.set(p[0]);
      case 'rates.fetch': {
        const body = this.rates.answer(String(p[0]));
        if (body === undefined) throw new Error(`${p[0]}: HTTP 404`);
        return body;
      }
      case 'faucet.btc': return this.faucetBtc(p[0], p[1]);
      case 'faucet.evm': return this.faucetEvm(p[0], p[1]);
      case 'faucet.mine': return this.mine(Number(p[0]));
      case 'faucet.evmTime': return this.evmTime(Number(p[0]));
      case 'faucet.height': return this.heights();
      case 'node.status': return this.nodeStatus();
      case 'node.trust': return this.nodeTrust();
      case 'node.orders': return this.nodeOrders();
      case 'node.order': return this.nodeOrder(p[0]);
      case 'node.pause': return this.shopper.pause(Number(p[0]));
      case 'node.resume': return this.shopper.resume();
      case 'node.resolveRefund': return this.shopper.resolveRefund(p[0]).then((o) => o && this.shopper.detail(o));
      case 'world.reset': await this.reset(); return true;
      case 'world.flush': await this.flush(); return true;
      case 'world.info': return { relays: MOCK_RELAYS, events: this.relays.count(), subscriptions: this.relays.subscriptions(), ...this.heights(), shopperErrors: this.shopper.errors.slice(-10) };
      default: throw new Error(`mock world: unknown method ${method}`);
    }
  }

  /** Close the subscriptions of a page that went away. */
  dropSubscriptions(ids: string[]): void {
    for (const id of ids) {
      this.subs.get(id)?.close();
      this.subs.delete(id);
    }
  }
}

