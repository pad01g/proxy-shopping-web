import { formatUnits, type Payment } from '@proxy-shopping/core/browser';

export const short = (s?: string, n = 8): string => (!s ? '' : s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-4)}`);

export function formatAsset(amount: string | bigint | undefined, asset?: Payment | string): string {
  if (amount === undefined || amount === '') return '-';
  const v = typeof amount === 'bigint' ? amount : BigInt(amount);
  if (asset === 'btc-signet') return `${v.toLocaleString()} sats (${formatUnits(v, 8)} sBTC)`;
  if (asset === 'usdc-evm') return `${formatUnits(v, 6)} USDC`;
  return v.toString();
}

export const formatTime = (unix: number): string => new Date(unix * 1000).toLocaleString('ja-JP');

export const PAYMENT_LABEL: Record<string, string> = {
  'btc-signet': 'BTC (signet)',
  'usdc-evm': 'USDC (EVM)',
};

export const STATUS_LABEL: Record<string, string> = {
  requested: '見積待ち',
  quoted: '見積受領',
  rejected: '断られました',
  accepted: '承諾済み（入金待ち）',
  funding: '入金中',
  funded: '入金済み',
  purchased: '購入済み',
  shipped: '発送済み',
  delivered: '配達済み',
  delivery_failed: '配送失敗',
  released: '支払い署名済み',
  completed: '完了',
  disputed: '紛争中',
  ruled: '裁定あり',
  settled: '裁定で精算済み',
  refunded: '返金済み',
  cancelled: '取り消し',
  notice: '通知のみ',
  open: '申立中',
};
