/**
 * The lab's rate mock (proxy-shopping-go/fakeshop/internal/rates): three base pairs the lab tab can change
 * (BTC/USD 100000, USD/JPY 150, USDC/USD 1), served in the formats of CoinGecko and Frankfurter so that core's
 * CoingeckoSource / FrankfurterSource read them exactly as they read rates.test in the lab.
 */
export const RATE_DEFAULTS: Record<string, string> = { 'BTC/USD': '100000', 'USD/JPY': '150', 'USDC/USD': '1' };

export class MockRates {
  private rates: Record<string, string>;

  constructor(
    initial?: Record<string, string>,
    private readonly onChange?: (r: Record<string, string>) => void,
  ) {
    this.rates = { ...RATE_DEFAULTS, ...(initial ?? {}) };
  }

  get(): Record<string, string> {
    return { ...this.rates };
  }

  /** POST /admin/rates: some or all of the base pairs; nothing changes when one value is invalid. */
  set(values: Record<string, string>): Record<string, string> {
    for (const [pair, v] of Object.entries(values)) {
      if (!(pair in RATE_DEFAULTS)) throw new Error(`unknown pair "${pair}" (want one of ${Object.keys(RATE_DEFAULTS).join(', ')})`);
      if (!/^\d+(\.\d+)?$/.test(String(v)) || !(Number(v) > 0)) throw new Error(`invalid rate "${v}" for ${pair}`);
    }
    this.rates = { ...this.rates, ...values };
    this.onChange?.(this.get());
    return this.get();
  }

  /** Price of one unit in USD. */
  private usd(asset: string): number | undefined {
    switch (asset) {
      case 'USD': return 1;
      case 'JPY': return 1 / Number(this.rates['USD/JPY']);
      case 'BTC': return Number(this.rates['BTC/USD']);
      case 'USDC': return Number(this.rates['USDC/USD']);
    }
    return undefined;
  }

  rate(base: string, quote: string): number | undefined {
    const b = this.usd(base);
    const q = this.usd(quote);
    return b === undefined || q === undefined ? undefined : b / q;
  }

  /** Answer GET /coingecko/… and /frankfurter/… (paths as core's sources build them); undefined for others. */
  answer(path: string): unknown {
    const u = new URL(path, 'http://rates.invalid');
    if (u.pathname.endsWith('/api/v3/simple/price')) {
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      const vs = (u.searchParams.get('vs_currencies') ?? '').split(',').filter(Boolean);
      const asset: Record<string, string> = { bitcoin: 'BTC', 'usd-coin': 'USDC' };
      const out: Record<string, Record<string, number>> = {};
      for (const id of ids) {
        if (!asset[id]) continue;
        out[id] = {};
        for (const v of vs) {
          const r = this.rate(asset[id], v.toUpperCase());
          if (r !== undefined) out[id][v] = r;
        }
      }
      return out;
    }
    if (u.pathname.endsWith('/latest')) {
      const from = u.searchParams.get('from') ?? 'EUR';
      const rates: Record<string, number> = {};
      for (const to of (u.searchParams.get('to') ?? '').split(',').filter(Boolean)) {
        const r = this.rate(from, to);
        if (r !== undefined) rates[to] = r;
      }
      return { amount: 1, base: from, date: new Date().toISOString().slice(0, 10), rates };
    }
    return undefined;
  }
}
