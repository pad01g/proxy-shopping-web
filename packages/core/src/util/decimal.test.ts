import { describe, expect, it } from 'vitest';
import { computeLockAmount, decimalToUnits, formatUnits, parseDecimal } from './decimal.js';

describe('decimal', () => {
  it('parses decimals', () => {
    expect(parseDecimal('25.00')).toEqual({ num: 2500n, den: 100n });
    expect(() => parseDecimal('1e5')).toThrow();
  });

  it('computes lock_amount per §4.5 (ceil + reserve)', () => {
    // 3200 + 800 + 300 JPY at 15,000,000 JPY/BTC = 28666.67 sats → 28667 + 1000
    expect(computeLockAmount(['3200', '800', '300'], '15000000', 8, 1000n)).toBe(29667n);
    // exact division is not rounded up
    expect(computeLockAmount(['150'], '15000000', 8, 0n)).toBe(1000n);
    // USDC: 25.00 + 10.00 + 1.75 USD at 1 → 36.75 USDC
    expect(computeLockAmount(['25.00', '10.00', '1.75'], '1', 6, 0n)).toBe(36_750_000n);
    // USDC/JPY 150: 4300 JPY → 28.666667 USDC (ceil)
    expect(computeLockAmount(['4300'], '150', 6, 0n)).toBe(28_666_667n);
  });

  it('converts units', () => {
    expect(decimalToUnits('0.50', 6)).toBe(500_000n);
    expect(formatUnits(29_667n, 8)).toBe('0.00029667');
    expect(formatUnits(36_750_000n, 6)).toBe('36.75');
  });
});
