import { defaultFetch, type FetchLike } from '../fx/types.js';

export interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

export interface TxStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
}

/** The subset of the Esplora HTTP API we use. */
export interface ChainApi {
  utxos(address: string): Promise<Utxo[]>;
  txHex(txid: string): Promise<string>;
  broadcast(txHex: string): Promise<string>;
  tipHeight(): Promise<number>;
  txStatus(txid: string): Promise<TxStatus>;
  feeEstimates(): Promise<Record<string, number>>;
}

export class EsploraClient implements ChainApi {
  private readonly base: string;

  constructor(
    base: string,
    private readonly fetchFn: FetchLike = defaultFetch,
  ) {
    this.base = base.replace(/\/+$/, '');
  }

  private async get(path: string): Promise<{ json(): Promise<unknown>; text(): Promise<string> }> {
    const res = await this.fetchFn(this.base + path);
    if (!res.ok) throw new Error(`esplora ${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    return res;
  }

  async utxos(address: string): Promise<Utxo[]> {
    return (await (await this.get(`/address/${address}/utxo`)).json()) as Utxo[];
  }

  async txHex(txid: string): Promise<string> {
    return (await (await this.get(`/tx/${txid}/hex`)).text()).trim();
  }

  async broadcast(txHex: string): Promise<string> {
    const res = await this.fetchFn(`${this.base}/tx`, { method: 'POST', body: txHex, headers: { 'content-type': 'text/plain' } });
    const text = (await res.text()).trim();
    if (!res.ok) throw new Error(`broadcast failed: HTTP ${res.status} ${text}`);
    return text;
  }

  async tipHeight(): Promise<number> {
    return Number((await (await this.get('/blocks/tip/height')).text()).trim());
  }

  async txStatus(txid: string): Promise<TxStatus> {
    return (await (await this.get(`/tx/${txid}/status`)).json()) as TxStatus;
  }

  async feeEstimates(): Promise<Record<string, number>> {
    return (await (await this.get('/fee-estimates')).json()) as Record<string, number>;
  }
}

/** sat/vB for a confirmation target, falling back to 1 when the node has no estimate (quiet signet). */
export async function feeRateFor(chain: ChainApi, target = 6): Promise<number> {
  try {
    const est = await chain.feeEstimates();
    const keys = Object.keys(est).map(Number).filter((k) => k >= target).sort((a, b) => a - b);
    const rate = est[String(keys[0] ?? target)];
    return rate && rate > 1 ? rate : 1;
  } catch {
    return 1;
  }
}
