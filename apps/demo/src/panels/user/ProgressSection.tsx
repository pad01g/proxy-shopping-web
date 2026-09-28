import type { UserOrder } from '@proxy-shopping/core/browser';
import { ActionButton, Explain, Mono, Section, type ConfirmSpec } from '../../components/ui';
import { label, useT } from '../../i18n';
import { formatAsset, formatTime } from '../../lib/format';
import { useRuntime } from '../../state';

/** Before the escrow output is spent the user may always sign the payout. */
const RELEASABLE = ['funded', 'purchased', 'shipped', 'delivered', 'delivery_failed', 'disputed', 'ruled'];

export function ProgressSection({ o }: { o: UserOrder }) {
  const rt = useRuntime('user');
  const m = useT();
  const u = m.user;
  if (!o.funded) return null;
  const q = o.quote!;
  const isBtc = o.payment === 'btc-signet';
  const payout = isBtc ? BigInt(q.lock_amount ?? '0') - BigInt(q.payout_fee_reserve ?? '0') : BigInt(q.lock_amount ?? '0');
  const releaseConfirm: ConfirmSpec = {
    title: u.releaseTitle,
    amount: formatAsset(payout, o.payment),
    recipient: isBtc ? q.shopper_btc_address : q.shopper_evm_address,
    warning: o.status === 'delivered' ? undefined : u.notDelivered(label(m.format.status, o.status)),
    okLabel: u.releaseOk,
  };
  return (
    <Section title={u.progress} testid="progress">
      <p data-testid="order-funded-tx">{u.funded}<Mono>{o.funded.asset === 'btc-signet' ? `${o.funded.txid}:${o.funded.vout}` : o.funded.safe}</Mono></p>
      {o.purchased ? (
        <p data-testid="order-purchased">{u.purchased(o.purchased.shop_order_id, `${o.purchased.total.amount} ${o.purchased.total.currency}`, o.purchased.evidence.length)}</p>
      ) : (
        <p className="muted">{u.waitingPurchase}</p>
      )}
      {o.tracking.length > 0 && (
        <ul data-testid="order-tracking">{o.tracking.map((t, i) => <li key={i}>{formatTime(t.updated_at)} {t.status} {t.carrier} {t.tracking_no}</li>)}</ul>
      )}
      {!o.escrowSpent && RELEASABLE.includes(o.status) && (
        <>
          <Explain>{u.releaseExplain}</Explain>
          <ActionButton testid="order-release" confirm={releaseConfirm} onClick={() => rt.client.release(o.id)}>{u.release}</ActionButton>
        </>
      )}
      {o.completedTxid && (
        <p className="banner ok" data-testid="order-completed">
          {u.completed}<Mono testid="order-completed-txid">{o.completedTxid}</Mono>
        </p>
      )}
    </Section>
  );
}
