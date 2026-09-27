/**
 * Decimal-string arithmetic on bigint. Amounts on the wire are decimal strings
 * (spec preamble), so we never route them through floating point.
 */

export interface Fraction {
  num: bigint;
  den: bigint;
}

export function parseDecimal(s: string): Fraction {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`not a decimal string: ${JSON.stringify(s)}`);
  const frac = m[3] ?? '';
  let num = BigInt(m[2] + frac);
  if (m[1]) num = -num;
  return { num, den: 10n ** BigInt(frac.length) };
}

/** Parse an unsigned integer string (sats, USDC base units). */
export function parseUnits(s: string): bigint {
  if (!/^\d+$/.test(s)) throw new Error(`not an integer amount: ${JSON.stringify(s)}`);
  return BigInt(s);
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('division by non-positive');
  if (a <= 0n) return -((-a) / b);
  return (a + b - 1n) / b;
}

export function addDecimals(values: string[]): Fraction {
  let acc: Fraction = { num: 0n, den: 1n };
  for (const v of values) {
    const f = parseDecimal(v);
    acc = { num: acc.num * f.den + f.num * acc.den, den: acc.den * f.den };
  }
  return acc;
}

/** Scale a decimal by 10^decimals and round up to an integer, e.g. "0.50" USDC -> 500000n. */
export function decimalToUnits(s: string, decimals: number): bigint {
  const f = parseDecimal(s);
  return ceilDiv(f.num * 10n ** BigInt(decimals), f.den);
}

/** Format integer base units as a decimal string, trimming trailing zeros. */
export function formatUnits(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/**
 * Spec §4.5: lock_amount = ceil(total / rate × 10^decimals) + payout_fee_reserve,
 * where total is in fiat, rate is fiat per 1 coin.
 */
export function computeLockAmount(total: string[], rate: string, decimals: number, reserve: bigint): bigint {
  const t = addDecimals(total);
  const r = parseDecimal(rate);
  // (t.num / t.den) / (r.num / r.den) * 10^d
  const num = t.num * r.den * 10n ** BigInt(decimals);
  const den = t.den * r.num;
  return ceilDiv(num, den) + reserve;
}
