import type { OrderQuote } from '../nostr/messages.js';
import { getRate, type PairRate } from './rates.js';
import type { RateSource } from './types.js';

export type DeviationLevel = 'ok' | 'warn' | 'strong';

export interface RateCheck {
  pair: string;
  quoted: number;
  own: number;
  deviation: number;
  level: DeviationLevel;
  sources: PairRate['sources'];
  errors: string[];
}

/** Spec §4.5: > 3% → warn, > 10% → strong. */
export function deviationLevel(deviation: number): DeviationLevel {
  if (deviation > 0.1) return 'strong';
  if (deviation > 0.03) return 'warn';
  return 'ok';
}

export async function checkQuoteRate(quote: Pick<OrderQuote, 'fx'>, sources: RateSource[]): Promise<RateCheck> {
  if (!quote.fx) throw new Error('quote has no fx');
  const quoted = Number(quote.fx.rate);
  const own = await getRate(sources, quote.fx.pair);
  const deviation = Math.abs(quoted - own.rate) / own.rate;
  return { pair: quote.fx.pair, quoted, own: own.rate, deviation, level: deviationLevel(deviation), sources: own.sources, errors: own.errors };
}
