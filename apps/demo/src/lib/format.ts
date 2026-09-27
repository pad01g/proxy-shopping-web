import { formatUnits, type Payment } from '@proxy-shopping/core/browser';

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

export const formatTime = (unix: number): string =>
  Number.isFinite(unix) && unix > 0 ? new Date(unix * 1000).toLocaleString('ja-JP') : '-';

export const PAYMENT_LABEL: Record<Payment, string> = {
  'btc-signet': 'BTC (signet)',
  'usdc-evm': 'USDC (EVM)',
};

/** User orders (UserOrderStatus) and escrow cases (CaseStatus). */
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
  notice: '入金の通知のみ',
  open: '申立中',
};

/** States of the Go shopper node's orders (proxy-shopping-go/node/internal/shopper/order.go). */
export const NODE_STATE_LABEL: Record<string, string> = {
  requested: '依頼を受信',
  rejected: '断った',
  quoted: '見積を送った',
  accepted: '承諾を受信（入金待ち）',
  cancelled: '取り消し',
  funding: '入金の承認待ち',
  funded: '入金を確認',
  purchasing: '購入中…',
  purchased: '購入済み',
  purchase_failed: '購入に失敗（払い戻しを申し出）',
  needs_human: '人の判断待ち',
  shipped: '発送済み',
  delivered: '配達済み',
  shipping_failed: '配送失敗',
  disputed: '紛争中',
  completed: '完了（利用者が支払った）',
  settled: '裁定で精算',
  claimed: 'T1 後に単独で受け取った',
  closed: '終了（ほかの経路で払い出された）',
};

export const REJECT_LABEL: Record<string, string> = {
  risk: '店が危険と判定された',
  region: '地域外',
  payment: '支払い手段が合わない',
  limit: '上限を超える',
  unavailable: '扱えない',
  trust: '組み合わせが一覧に無い',
  invalid: '依頼の形が不正',
};
