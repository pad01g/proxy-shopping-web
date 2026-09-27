import type { PublicClient } from 'viem';
import { nowSeconds } from '../util/time.js';
import { aggregatorV3Abi } from '../evm/abi.js';
import { defaultFetch, type FetchLike, type RateObservation, type RateSource } from './types.js';

const trimBase = (b: string) => b.replace(/\/+$/, '');

async function getJson(fetchFn: FetchLike, url: string): Promise<unknown> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Fiat rates: GET {base}/latest?from=USD&to=JPY → {"rates":{"JPY":150.1}}. */
export class FrankfurterSource implements RateSource {
  readonly name = 'frankfurter';
  constructor(
    private readonly base: string,
    private readonly fiat: string[] = ['JPY'],
    private readonly fetchFn: FetchLike = defaultFetch,
  ) {}

  async fetch(): Promise<RateObservation[]> {
    const url = `${trimBase(this.base)}/latest?from=USD&to=${this.fiat.join(',')}`;
    const body = (await getJson(this.fetchFn, url)) as { rates?: Record<string, number> };
    const at = nowSeconds();
    return Object.entries(body.rates ?? {}).map(([quote, rate]) => ({ base: 'USD', quote, rate: Number(rate), source: this.name, at }));
  }
}

const COINGECKO_IDS: Record<string, string> = { bitcoin: 'BTC', 'usd-coin': 'USDC' };

/** GET {base}/api/v3/simple/price?ids=bitcoin,usd-coin&vs_currencies=usd,jpy. */
export class CoingeckoSource implements RateSource {
  readonly name = 'coingecko';
  constructor(
    private readonly base: string,
    private readonly fetchFn: FetchLike = defaultFetch,
  ) {}

  async fetch(): Promise<RateObservation[]> {
    const url = `${trimBase(this.base)}/api/v3/simple/price?ids=bitcoin,usd-coin&vs_currencies=usd,jpy`;
    const body = (await getJson(this.fetchFn, url)) as Record<string, Record<string, number>>;
    const at = nowSeconds();
    const out: RateObservation[] = [];
    for (const [id, prices] of Object.entries(body)) {
      const base = COINGECKO_IDS[id];
      if (!base) continue;
      for (const [vs, rate] of Object.entries(prices)) {
        out.push({ base, quote: vs.toUpperCase(), rate: Number(rate), source: this.name, at });
      }
    }
    return out;
  }
}

/** Chainlink AggregatorV3 feeds, e.g. {"BTC/USD": "0x…", "JPY/USD": "0x…"}. */
export class ChainlinkSource implements RateSource {
  readonly name = 'chainlink';
  constructor(
    private readonly client: Pick<PublicClient, 'readContract'>,
    private readonly feeds: Record<string, string>,
  ) {}

  async fetch(): Promise<RateObservation[]> {
    const out: RateObservation[] = [];
    for (const [pair, address] of Object.entries(this.feeds)) {
      const [base, quote] = pair.split('/');
      const addr = address as `0x${string}`;
      const [round, decimals] = await Promise.all([
        this.client.readContract({ address: addr, abi: aggregatorV3Abi, functionName: 'latestRoundData' }),
        this.client.readContract({ address: addr, abi: aggregatorV3Abi, functionName: 'decimals' }).catch(() => 8),
      ]);
      const [, answer, , updatedAt] = round as readonly [bigint, bigint, bigint, bigint, bigint];
      out.push({
        base,
        quote,
        rate: Number(answer) / 10 ** Number(decimals),
        source: this.name,
        at: Number(updatedAt),
      });
    }
    return out;
  }
}

/** Fixed rates, for tests: {"BTC/USD": 100000, "USD/JPY": 150}. */
export class StaticSource implements RateSource {
  constructor(
    private readonly rates: Record<string, number>,
    readonly name = 'static',
  ) {}

  async fetch(): Promise<RateObservation[]> {
    const at = nowSeconds();
    return Object.entries(this.rates).map(([pair, rate]) => {
      const [base, quote] = pair.split('/');
      return { base, quote, rate, source: this.name, at };
    });
  }
}
