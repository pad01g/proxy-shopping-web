import { Link } from 'react-router-dom';
import { formatAsset, formatTime, PAYMENT_LABEL, STATUS_LABEL } from '../lib/format';
import { useLive, useRuntime } from '../state';

export function OrdersPage() {
  const rt = useRuntime();
  const [orders] = useLive(() => rt.user.listOrders(), (cb) => rt.user.on('order', cb), [rt]);
  return (
    <div data-testid="orders">
      <h1>注文一覧</h1>
      {!orders?.length && <p className="muted" data-testid="orders-empty">まだ注文はありません。</p>}
      <table>
        <tbody>
          {orders?.map((o) => (
            <tr key={o.id} data-testid="orders-row" data-order-id={o.id}>
              <td><Link to={`/user/orders/${o.id}`} data-testid={`orders-link-${o.id}`}>{o.id.slice(0, 8)}</Link></td>
              <td>{formatTime(o.createdAt)}</td>
              <td>{o.request.shop_url}</td>
              <td>{PAYMENT_LABEL[o.payment]}</td>
              <td>{formatAsset(o.quote?.lock_amount, o.payment)}</td>
              <td><span className="badge" data-testid="orders-status" data-status={o.status}>{STATUS_LABEL[o.status] ?? o.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
