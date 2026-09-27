import type { RateObservation, RateSource } from './types.js';

export function median(values: number[]): number {
  if (!values.length) throw new Error('median of empty list');
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Rate of `base` in `quote` from one source's observations, directly, inverted, or via USD. */
function fromObservations(obs: RateObservation[], base: string, quote: string): number | undefined {
  if (base === quote) return 1;
  const direct = obs.find((o) => o.base === base && o.quote === quote);
  if (direct) return direct.rate;
  const inverse = obs.find((o) => o.base === quote && o.quote === base);
  if (inverse && inverse.rate > 0) return 1 / inverse.rate;
  return undefined;
}

export interface PairRate {
  pair: string;
  rate: number;
  /** Per-source values that fed the median. */
  sources: Array<{ name: string; rate: number; at: number }>;
}

/**
 * Spec §7: each source gives the pair directly or synthesised via USD;
 * legs missing in a source are borrowed from the median of the others,
 * so a fiat-only source still contributes its USD/JPY leg.
 */
export function computePair(observations: RateObservation[], pair: string): PairRate {
  const [base, quote] = pair.split('/');
  const bySource = new Map<string, RateObservation[]>();
  for (const o of observations) {
    if (!(o.rate > 0) || !Number.isFinite(o.rate)) continue;
    const list = bySource.get(o.source) ?? [];
    list.push(o);
    bySource.set(o.source, list);
  }

  const legMedian = (b: string, q: string): number | undefined => {
    const vals = [...bySource.values()].map((obs) => fromObservations(obs, b, q)).filter((v): v is number => v !== undefined);
    return vals.length ? median(vals) : undefined;
  };

  const sources: PairRate['sources'] = [];
  for (const [name, obs] of bySource) {
    const at = Math.max(...obs.map((o) => o.at));
    const direct = fromObservations(obs, base, quote);
    if (direct !== undefined) {
      sources.push({ name, rate: direct, at });
      continue;
    }
    const toUsd = fromObservations(obs, base, 'USD');
    const fromUsd = fromObservations(obs, 'USD', quote);
    if (toUsd === undefined && fromUsd === undefined) continue;
    const a = toUsd ?? legMedian(base, 'USD');
    const b = fromUsd ?? legMedian('USD', quote);
    if (a !== undefined && b !== undefined) sources.push({ name, rate: a * b, at });
  }
  if (!sources.length) throw new Error(`no source can price ${pair}`);
  return { pair, rate: median(sources.map((s) => s.rate)), sources };
}

export async function fetchAll(sources: RateSource[]): Promise<{ observations: RateObservation[]; errors: string[] }> {
  const results = await Promise.allSettled(sources.map((s) => s.fetch()));
  const observations: RateObservation[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') observations.push(...r.value);
    else errors.push(`${sources[i].name}: ${String((r.reason as Error)?.message ?? r.reason)}`);
  });
  return { observations, errors };
}

export async function getRate(sources: RateSource[], pair: string): Promise<PairRate & { errors: string[] }> {
  const { observations, errors } = await fetchAll(sources);
  return { ...computePair(observations, pair), errors };
}
