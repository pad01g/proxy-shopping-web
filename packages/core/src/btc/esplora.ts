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

/** Esplora /tx/{txid}/outspend/{vout}. */
export interface Outspend {
  spent: boolean;
  txid?: string;
  vin?: number;
  status?: TxStatus;
}

/** The subset of the Esplora HTTP API we use. */
export interface ChainApi {
  utxos(address: string): Promise<Utxo[]>;
  txHex(txid: string): Promise<string>;
  broadcast(txHex: string): Promise<string>;
  tipHeight(): Promise<number>;
  /** Header time of the tip block (UNIX seconds), to compare the chain's clock with ours (§4.5.1). */
  tipTime(): Promise<number>;
  txStatus(txid: string): Promise<TxStatus>;
  /** Whether output `vout` of `txid` is spent, and by which transaction (§4.8 settlement checks). */
  outspend(txid: string, vout: number): Promise<Outspend>;
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
    const h = Number((await (await this.get('/blocks/tip/height')).text()).trim());
    if (!Number.isSafeInteger(h) || h < 0) throw new Error('esplora: bad tip height');
    return h;
  }

  async tipTime(): Promise<number> {
    const hash = (await (await this.get('/blocks/tip/hash')).text()).trim();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('esplora: bad tip hash');
    const t = Number(((await (await this.get(`/block/${hash}`)).json()) as { timestamp?: unknown }).timestamp);
    if (!Number.isSafeInteger(t) || t <= 0) throw new Error('esplora: bad block timestamp');
    return t;
  }

  async outspend(txid: string, vout: number): Promise<Outspend> {
    if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0) throw new Error('bad outpoint');
    const o = (await (await this.get(`/tx/${txid}/outspend/${vout}`)).json()) as Partial<Outspend>;
    return {
      spent: o.spent === true,
      txid: typeof o.txid === 'string' && /^[0-9a-f]{64}$/.test(o.txid) ? o.txid : undefined,
      vin: typeof o.vin === 'number' ? o.vin : undefined,
      status: o.status,
    };
  }

  async txStatus(txid: string): Promise<TxStatus> {
    return (await (await this.get(`/tx/${txid}/status`)).json()) as TxStatus;
  }

  async feeEstimates(): Promise<Record<string, number>> {
    return (await (await this.get('/fee-estimates')).json()) as Record<string, number>;
  }
}

/** Default cap on the funding fee rate: the Esplora server chooses the estimate, so it must be bounded. */
export const DEFAULT_MAX_FEE_RATE = 50;

/**
 * sat/vB for a confirmation target, falling back to 1 when the node has no estimate (quiet signet),
 * and never above `maxFeeRate`.
 */
export async function feeRateFor(chain: ChainApi, target = 6, maxFeeRate = DEFAULT_MAX_FEE_RATE): Promise<number> {
  let rate = 1;
  try {
    const est = await chain.feeEstimates();
    const keys = Object.keys(est).map(Number).filter((k) => Number.isFinite(k) && k >= target).sort((a, b) => a - b);
    const r = Number(est[String(keys[0] ?? target)]);
    if (Number.isFinite(r) && r > 1) rate = r;
  } catch {
    /* keep 1 sat/vB */
  }
  return Math.min(rate, maxFeeRate);
}
