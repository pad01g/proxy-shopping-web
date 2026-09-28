import { formatUnits, type Payment } from '@proxy-shopping/core/browser';
import { msg } from '../i18n';

export const short = (s?: string, n = 8): string => (!s ? '' : s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-4)}`);

/** Base-unit amount for display; anything that is not an unsigned integer is shown as "?" rather than throwing. */
export function formatAsset(amount: string | bigint | undefined, asset?: Payment | string): string {
  if (amount === undefined || amount === '') return '-';
  if (typeof amount === 'string' && !/^-?\d{1,40}$/.test(amount)) return '?';
  const v = typeof amount === 'bigint' ? amount : BigInt(amount);
  if (asset === 'btc-signet') return `${v.toLocaleString()} sats`;
  if (asset === 'usdc-evm') return `${formatUnits(v, 6)} USDC`;
  return v.toString();
}

export const formatEth = (wei?: string | bigint): string => {
  if (wei === undefined) return '-';
  return `${formatUnits(typeof wei === 'bigint' ? wei : BigInt(wei), 18).replace(/(\.\d{4})\d+$/, '$1')} ETH`;
};

/** Date and time in the page's language. */
export const formatTime = (unix: number): string =>
  Number.isFinite(unix) && unix > 0 ? new Date(unix * 1000).toLocaleString(msg().format.locale) : '-';

export const PAYMENT_LABEL: Record<Payment, string> = {
  'btc-signet': 'BTC (signet)',
  'usdc-evm': 'USDC (EVM)',
};

// Labels of statuses, node states and reject reasons are in the message catalogs (i18n: format.*).
