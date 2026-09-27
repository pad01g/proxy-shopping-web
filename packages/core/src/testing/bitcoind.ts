import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KeyedMutex } from '../util/time.js';

/** Minimal JSON-RPC client for bitcoind. */
export class BitcoindRpc {
  private readonly url: string;
  private readonly auth: string;
  private readonly scanLock = new KeyedMutex();

  constructor(rpcUrl: string) {
    const u = new URL(rpcUrl);
    this.auth = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
    u.username = '';
    u.password = '';
    this.url = u.toString();
  }

  async call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: this.auth },
      body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }),
    });
    const body = (await res.json()) as { result: T; error?: { message: string } | null };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }

  async waitReady(ms = 60_000): Promise<void> {
    const end = Date.now() + ms;
    for (;;) {
      try {
        await this.call('getblockcount');
        return;
      } catch (err) {
        if (Date.now() > end) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /** Mine exactly n blocks. Signet still needs a little PoW, so maxtries can run out; loop. */
  async mine(n: number, address: string): Promise<string[]> {
    const hashes: string[] = [];
    while (hashes.length < n) {
      hashes.push(...(await this.call<string[]>('generatetoaddress', n - hashes.length, address, 1_000_000_000)));
    }
    return hashes;
  }

  /** scantxoutset cannot run concurrently, so serialise it. */
  scan(address: string) {
    return this.scanLock.run('scan', () =>
      this.call<{ unspents: Array<{ txid: string; vout: number; amount: number; height: number }> }>('scantxoutset', 'start', [`addr(${address})`]),
    );
  }
}

/**
 * The Esplora routes core uses, served from bitcoind RPC. Only confirmed
 * UTXOs are listed (scantxoutset), which is fine because tests mine after
 * each broadcast.
 */
export async function startEsploraShim(rpc: BitcoindRpc, opts: { port?: number; host?: string } = {}): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: string, type = 'text/plain') => {
      res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*' });
      res.end(body);
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' });
      return res.end();
    }
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;
      let m: RegExpExecArray | null;
      if (req.method === 'POST' && p === '/tx') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        return send(200, await rpc.call<string>('sendrawtransaction', Buffer.concat(chunks).toString().trim()));
      }
      if ((m = /^\/address\/([^/]+)\/utxo$/.exec(p))) {
        const { unspents } = await rpc.scan(m[1]);
        const utxos = unspents.map((u) => ({
          txid: u.txid, vout: u.vout, value: Math.round(u.amount * 1e8), status: { confirmed: true, block_height: u.height },
        }));
        return send(200, JSON.stringify(utxos), 'application/json');
      }
      if ((m = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(p))) return send(200, await rpc.call<string>('getrawtransaction', m[1], false));
      if ((m = /^\/tx\/([0-9a-f]{64})\/status$/.exec(p))) {
        const tx = await rpc.call<{ confirmations?: number; blockhash?: string }>('getrawtransaction', m[1], true);
        if (!tx.confirmations) return send(200, JSON.stringify({ confirmed: false }), 'application/json');
        const header = await rpc.call<{ height: number }>('getblockheader', tx.blockhash);
        return send(200, JSON.stringify({ confirmed: true, block_height: header.height, block_hash: tx.blockhash }), 'application/json');
      }
      if (p === '/blocks/tip/height') return send(200, String(await rpc.call<number>('getblockcount')));
      if (p === '/fee-estimates') return send(200, JSON.stringify({ '1': 2, '6': 1 }), 'application/json');
      return send(404, 'not found');
    } catch (err) {
      return send(400, (err as Error).message);
    }
  });
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((r) => server.listen(opts.port ?? 0, host, r));
  return { url: `http://${host}:${(server.address() as AddressInfo).port}`, server };
}
