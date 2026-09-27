import type { UserOrder } from '@proxy-shopping/core/browser';
import { ActionButton, Explain, Mono, Section, type ConfirmSpec } from '../../components/ui';
import { formatAsset, formatTime, STATUS_LABEL } from '../../lib/format';
import { useRuntime } from '../../state';

/** Before the escrow output is spent the user may always sign the payout. */
const RELEASABLE = ['funded', 'purchased', 'shipped', 'delivered', 'delivery_failed', 'disputed', 'ruled'];

export function ProgressSection({ o }: { o: UserOrder }) {
  const rt = useRuntime('user');
  if (!o.funded) return null;
  const q = o.quote!;
  const isBtc = o.payment === 'btc-signet';
  const payout = isBtc ? BigInt(q.lock_amount ?? '0') - BigInt(q.payout_fee_reserve ?? '0') : BigInt(q.lock_amount ?? '0');
  const releaseConfirm: ConfirmSpec = {
    title: 'shopper への支払いに署名します',
    amount: formatAsset(payout, o.payment),
    recipient: isBtc ? q.shopper_btc_address : q.shopper_evm_address,
    warning: o.status === 'delivered' ? undefined : `まだ「配達済み」ではありません（いま: ${STATUS_LABEL[o.status] ?? o.status}）。署名すると shopper は商品を届けなくても受け取れます。`,
    okLabel: '支払いに署名する',
  };
  return (
    <Section title="購入と配送" testid="progress">
      <p data-testid="order-funded-tx">入金: <Mono>{o.funded.asset === 'btc-signet' ? `${o.funded.txid}:${o.funded.vout}` : o.funded.safe}</Mono></p>
      {o.purchased ? (
        <p data-testid="order-purchased">店の注文番号 {o.purchased.shop_order_id} ・ {o.purchased.total.amount} {o.purchased.total.currency} ・ 証拠 {o.purchased.evidence.length} 件</p>
      ) : (
        <p className="muted">shopper の購入を待っています…</p>
      )}
      {o.tracking.length > 0 && (
        <ul data-testid="order-tracking">{o.tracking.map((t, i) => <li key={i}>{formatTime(t.updated_at)} {t.status} {t.carrier} {t.tracking_no}</li>)}</ul>
      )}
      {!o.escrowSpent && RELEASABLE.includes(o.status) && (
        <>
          <Explain>商品を受け取ったら、支払いに署名します（2-of-3 の 1 つ目）。shopper が 2 つ目の署名を加えて放送し、マルチシグのロックが解けます。</Explain>
          <ActionButton testid="order-release" confirm={releaseConfirm} onClick={() => rt.client.release(o.id)}>受け取りました（支払う）</ActionButton>
        </>
      )}
      {o.completedTxid && (
        <p className="banner ok" data-testid="order-completed">
          完了しました（チェーンで確認済み）。支払いの取引: <Mono testid="order-completed-txid">{o.completedTxid}</Mono>
        </p>
      )}
    </Section>
  );
}
