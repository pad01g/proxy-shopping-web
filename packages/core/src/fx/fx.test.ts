import { describe, expect, it } from 'vitest';
import { checkQuoteRate, deviationLevel } from './check.js';
import { computePair, median } from './rates.js';
import { ChainlinkSource, CoingeckoSource, FrankfurterSource, MempoolSource, StaticSource, rateSourceFromConfig } from './sources.js';
import type { FetchLike } from './types.js';

const fakeFetch = (routes: Record<string, unknown>): FetchLike => async (url) => {
  const body = Object.entries(routes).find(([k]) => url.startsWith(k))?.[1];
  return {
    ok: body !== undefined,
    status: body === undefined ? 404 : 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};

describe('fx', () => {
  const fetch = fakeFetch({
    'https://rates.test/frankfurter/latest?from=USD&to=JPY': { rates: { JPY: 150 } },
    'https://rates.test/coingecko/api/v3/simple/price?ids=bitcoin,usd-coin&vs_currencies=usd,jpy': {
      bitcoin: { usd: 100000, jpy: 15000000 },
      'usd-coin': { usd: 1, jpy: 150 },
    },
  });
  const sources = [new CoingeckoSource('https://rates.test/coingecko', fetch), new FrankfurterSource('https://rates.test/frankfurter/', ['JPY'], fetch)];

  it('reads BTC prices from mempool.space and builds sources from config', async () => {
    const f = fakeFetch({ 'https://mempool.space/api/v1/prices': { time: 1790727905, USD: 83464, JPY: 13124019, EUR: 73622 } });
    const obs = await new MempoolSource('https://mempool.space/', f).fetch();
    expect(obs.map((o) => `${o.base}/${o.quote}=${o.rate}`).sort()).toEqual(['BTC/EUR=73622', 'BTC/JPY=13124019', 'BTC/USD=83464']);
    const fromConfig = await rateSourceFromConfig({ type: 'mempool', base: 'https://mempool.space' }, f).fetch();
    expect(computePair(fromConfig, 'BTC/JPY').rate).toBe(13124019);
    expect(rateSourceFromConfig({ type: 'frankfurter', base: 'https://x' }).name).toBe('frankfurter');
    expect(() => rateSourceFromConfig({ type: 'nope' as never, base: '' })).toThrow(/unknown rate source/);
  });

  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('synthesises via USD and takes the median across sources', async () => {
    const obs = (await Promise.all(sources.map((s) => s.fetch()))).flat();
    expect(computePair(obs, 'BTC/JPY').rate).toBe(15000000);
    // frankfurter contributes BTC/JPY by borrowing BTC/USD from coingecko
    expect(computePair(obs, 'BTC/JPY').sources.map((s) => s.name).sort()).toEqual(['coingecko', 'frankfurter']);
    expect(computePair(obs, 'USDC/USD').rate).toBe(1);
    const only = await new StaticSource({ 'BTC/USD': 100000, 'JPY/USD': 1 / 150 }).fetch();
    expect(computePair(only, 'BTC/JPY').rate).toBeCloseTo(15000000, 3);
    expect(computePair(only, 'USD/JPY').rate).toBeCloseTo(150, 9);
  });

  it('classifies deviation (§4.5)', async () => {
    expect(deviationLevel(0.03)).toBe('ok');
    expect(deviationLevel(0.031)).toBe('warn');
    expect(deviationLevel(0.11)).toBe('strong');
    const q = (rate: string) => ({ fx: { pair: 'BTC/JPY', rate, sources: [], at: 0 } });
    expect((await checkQuoteRate(q('15000000'), sources)).level).toBe('ok');
    expect((await checkQuoteRate(q('15600000'), sources)).level).toBe('warn');
    const strong = await checkQuoteRate(q('17000000'), sources);
    expect(strong.level).toBe('strong');
    expect(strong.deviation).toBeCloseTo(2 / 15, 6);
  });

  it('reports failing sources without failing the check', async () => {
    const broken = new CoingeckoSource('https://down.test', fetch);
    const r = await checkQuoteRate({ fx: { pair: 'BTC/JPY', rate: '15000000', sources: [], at: 0 } }, [broken, ...sources]);
    expect(r.errors).toHaveLength(1);
    expect(r.level).toBe('ok');
  });

  it('reads chainlink feeds with their decimals', async () => {
    const client = {
      readContract: (async ({ address, functionName }: { address: string; functionName: string }) => {
        if (functionName === 'decimals') return 8;
        const answers: Record<string, bigint> = { '0xb': 100000n * 10n ** 8n, '0xj': 666667n };
        return [1n, answers[address], 0n, 1700000000n, 1n];
      }) as never,
    };
    const obs = await new ChainlinkSource(client, { 'BTC/USD': '0xb', 'JPY/USD': '0xj' }).fetch();
    expect(computePair(obs, 'BTC/JPY').rate).toBeCloseTo(100000 / 0.00666667, 0);
  });
});
