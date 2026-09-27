import { Section } from '../../components/ui';
import { formatTime, PAYMENT_LABEL, STATUS_LABEL } from '../../lib/format';
import { useLive, useRuntime } from '../../state';

export function OrderList({ selected, onSelect }: { selected?: string; onSelect: (id: string) => void }) {
  const rt = useRuntime('user');
  const [orders] = useLive(() => rt.client.listOrders(), (cb) => rt.client.on('order', cb), [rt]);
  if (!orders?.length) return null;
  return (
    <Section title="注文の一覧" testid="order-list">
      <table>
        <tbody>
          {orders.slice(0, 12).map((o) => (
            <tr key={o.id} className={o.id === selected ? 'selected' : ''} data-testid="order-row" data-order-id={o.id} data-status={o.status}>
              <td><button type="button" className="plain small" data-testid={`order-open-${o.id.slice(0, 8)}`} onClick={() => onSelect(o.id)}>{o.id.slice(0, 8)}</button></td>
              <td>{formatTime(o.createdAt)}</td>
              <td>{o.request.shop_url.replace(/^https?:\/\//, '')} {o.request.items.map((i) => i.sku).join(', ')}</td>
              <td>{PAYMENT_LABEL[o.payment]}</td>
              <td><span className="badge">{STATUS_LABEL[o.status] ?? o.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
