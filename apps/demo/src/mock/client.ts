/**
 * The page's side of the mock world (worker.ts): one connection per window, plus the adapters that make the
 * world look like the lab's services to core — a NostrTransport for the relays, a ChainApi for Esplora, a viem
 * transport for the EVM RPC and a fetch for the rate APIs. Nothing here uses the network.
 */
import type { ChainApi, FetchLike, NostrEvent, NostrTransport, Outspend, PublishResult, TxStatus, Utxo } from '@proxy-shopping/core/browser';
import type { Filter } from 'nostr-tools/filter';
import { custom, type Transport } from 'viem';

interface PortLike {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
  start?(): void;
}

export class WorldClient {
  private next = 1;
  private readonly calls = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private readonly subs = new Map<string, { onEvent(e: NostrEvent): void; onEose?(): void }>();
  private readonly prefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  private subCount = 0;

  private constructor(
    private readonly port: PortLike,
    /** Every window of the browser shares this world (SharedWorker). */
    readonly shared: boolean,
  ) {
    port.onmessage = (e) => this.onMessage(e.data);
    port.start?.();
    window.addEventListener('pagehide', () => port.postMessage({ bye: true }));
  }

  /** Start (or join) the world: a SharedWorker where the browser has one, else a Worker of this window. */
  static connect(): WorldClient {
    if (typeof SharedWorker !== 'undefined') {
      const w = new SharedWorker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'ps-demo-mock-world' });
      return new WorldClient(w.port as unknown as PortLike, true);
    }
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'ps-demo-mock-world' });
    return new WorldClient(w as unknown as PortLike, false);
  }

  private onMessage(m: { id?: number; result?: unknown; error?: string; sub?: string; event?: NostrEvent; eose?: boolean }): void {
    if (m.id !== undefined) {
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      if (m.error !== undefined) c.reject(new Error(m.error));
      else c.resolve(m.result);
      return;
    }
    if (m.sub !== undefined) {
      const s = this.subs.get(m.sub);
      if (!s) return;
      if (m.eose) s.onEose?.();
      else if (m.event) s.onEvent(m.event);
    }
  }

  call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ id, method, params });
    });
  }

  subscribe(relays: string[], filter: Filter, onEvent: (e: NostrEvent) => void, onEose?: () => void): { close(): void } {
    const id = `${this.prefix}-${this.subCount++}`;
    this.subs.set(id, { onEvent, onEose });
    void this.call('relay.subscribe', id, relays, filter).catch((e) => console.warn('mock relay subscribe failed', e));
    return {
      close: () => {
        this.subs.delete(id);
        void this.call('relay.unsubscribe', id).catch(() => undefined);
      },
    };
  }

  // ---------- adapters for core ----------

  /** The mock relays as a NostrTransport (the protocol sees the lab's relay URLs). */
  transport(): NostrTransport {
    const open = new Set<{ close(): void }>();
    return {
      publish: (relays, event) => this.call<PublishResult>('relay.publish', relays, event),
      query: (relays, filter) => this.call<NostrEvent[]>('relay.query', relays, filter),
      subscribe: (relays, filter, onEvent, onEose) => {
        const s = this.subscribe(relays, filter, onEvent, onEose);
        open.add(s);
        return { close: () => (open.delete(s), s.close()) };
      },
      close: () => {
        for (const s of open) s.close();
        open.clear();
      },
    };
  }

  /** The mock BTC chain as core's ChainApi (Esplora). */
  chain(): ChainApi {
    return {
      utxos: (a) => this.call<Utxo[]>('btc.utxos', a),
      txHex: (t) => this.call<string>('btc.txHex', t),
      broadcast: (h) => this.call<string>('btc.broadcast', h),
      tipHeight: () => this.call<number>('btc.tipHeight'),
      tipTime: () => this.call<number>('btc.tipTime'),
      txStatus: (t) => this.call<TxStatus>('btc.txStatus', t),
      outspend: (t, v) => this.call<Outspend>('btc.outspend', t, v),
      feeEstimates: () => this.call<Record<string, number>>('btc.feeEstimates'),
    };
  }

  /** The mock EVM as a viem transport (EIP-1193 requests). */
  evmTransport(): Transport {
    return custom({ request: ({ method, params }) => this.call('evm.request', { method, params }) }, { retryCount: 0 });
  }

  /** fetch for the rate sources: https://rates.test/… answered by the rate mock. */
  ratesFetch(): FetchLike {
    return async (url) => {
      const path = url.replace(/^https:\/\/rates\.test/, '');
      try {
        const body = await this.call('rates.fetch', path);
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      } catch (err) {
        const msg = (err as Error).message;
        return { ok: false, status: 404, json: async () => ({ error: msg }), text: async () => msg };
      }
    };
  }
}
