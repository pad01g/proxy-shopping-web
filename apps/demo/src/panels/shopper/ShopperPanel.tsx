import { useEffect, useState } from 'react';
import { ActionButton, Explain, Mono, Section } from '../../components/ui';
import { label, useT } from '../../i18n';
import { formatEth, formatTime, short } from '../../lib/format';
import { every, useApp, useDemoState, useLive } from '../../state';

/** The always-online Go shopper node (read-only: it acts by itself). */
export function ShopperPanel() {
  const app = useApp();
  const m = useT();
  const s = m.shopper;
  const sep = m.common.sep;
  const { lab, scenarioOrderId } = useDemoState();
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<string>();
  useEffect(() => setPicked(undefined), [scenarioOrderId]);
  const st = lab.shopper.status;
  const orders = lab.shopper.orders.filter((o) => all || o.user === app.ids.user.pubkey);
  const selected = picked ?? (orders.some((o) => o.id === scenarioOrderId) ? scenarioOrderId : orders[0]?.id);
  const paused = (st?.paused_until ?? 0) > Date.now() / 1000;
  return (
    <div data-testid="panel-shopper">
      <Section title={s.title(app.shopper.name)} testid="shopper-status">
        <Explain>{s.explain}</Explain>
        {lab.shopper.statusError && <p className="banner error">{s.unreachable}{lab.shopper.statusError}</p>}
        {st && (
          <p data-testid="shopper-node-status" data-paused={paused ? 'true' : 'false'}>
            {s.pubkey}<Mono title={st.pubkey}>{short(st.pubkey, 10)}</Mono>{sep}{s.role}{st.role}{sep}{s.network}{st.network}{sep}{s.reachability}{st.reachability ?? '-'}{sep}{s.gas}{formatEth(lab.shopper.eth)}
            {paused && <strong className="warn-text">{sep}{s.pausedUntil(formatTime(st.paused_until!))}</strong>}
          </p>
        )}
        <p className="muted small">
          {s.trusted}{Object.entries(st?.trust ?? {}).map(([op, v]) => `${op === app.ids.operator.pubkey ? s.thisOperator : short(op)} v${v}`).join(sep) || s.none}
        </p>
      </Section>
      <Section title={s.orders} testid="shopper-orders">
        <label className="row small">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} style={{ width: 'auto' }} />
          {s.showAll}
        </label>
        {!orders.length && <p className="muted" data-testid="shopper-orders-empty">{s.noOrders}</p>}
        <table>
          <tbody>
            {orders.slice(0, 15).map((o) => (
              <tr key={o.id} className={o.id === selected ? 'selected' : ''} data-testid="shopper-order-row" data-order-id={o.id} data-state={o.state}>
                <td><button type="button" className="plain small" onClick={() => setPicked(o.id)}>{o.id.slice(0, 8)}</button></td>
                <td>{formatTime(o.updated)}</td>
                <td>{o.asset}</td>
                <td><span className="badge">{label(m.format.nodeState, o.state)}</span></td>
                {/* The node's own error message. */}
                <td className="muted small" data-i18n-exempt="node error">{o.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {selected && <NodeOrderDetail key={selected} id={selected} />}
    </div>
  );
}

function NodeOrderDetail({ id }: { id: string }) {
  const app = useApp();
  const [o, refresh] = useLive(() => app.lab.node.order(id), every(3000), [id]);
  const m = useT();
  const s = m.shopper;
  const sep = m.common.sep;
  if (!o) return null;
  return (
    <Section title={s.nodeOrder(id.slice(0, 8))} testid="shopper-order" >
      <p data-testid="shopper-order-state" data-state={o.state}>
        {m.common.status}<span className="badge">{label(m.format.nodeState, o.state)}</span>
        {o.risk_score !== undefined && `${sep}${s.riskScore(o.risk_score)}`}
        {o.payout_tx && <>{sep}{s.payout}<Mono>{short(o.payout_tx, 10)}</Mono>{m.common.paren(o.payout_by ?? '')}</>}
      </p>
      {/* What the shop's bot reported, as the node stored it. */}
      {o.purchase && <p className="muted">{s.purchase}<span data-i18n-exempt="node purchase result">{o.purchase.status} {o.purchase.shop_order_id} {o.purchase.total && `${o.purchase.total.amount} ${o.purchase.total.currency}`} {o.purchase.error}</span></p>}
      {o.state === 'needs_human' && (
        <div className="banner warn">
          {s.needsHuman}
          <ActionButton
            testid="shopper-resolve-refund"
            kind="plain"
            confirm={{ title: s.resolveTitle, okLabel: s.resolveOk }}
            onClick={async () => {
              await app.lab.node.resolveRefund(id);
              refresh();
            }}
          >
            {s.resolve}
          </ActionButton>
        </div>
      )}
      {o.pending && Object.keys(o.pending).length > 0 && (
        <p className="muted small">{s.pending}<span data-i18n-exempt="node pending actions">{Object.entries(o.pending).map(([k, a]) => `${k}${a.error ? ` (${a.error})` : ''}`).join(', ')}</span></p>
      )}
      <h3>{s.history}</h3>
      <ul className="timeline" data-testid="shopper-order-history">
        {[...o.history].reverse().map((h, i) => (
          <li key={i}><time>{formatTime(h.at)}</time><span className="badge">{label(m.format.nodeState, h.state)}</span> <span data-i18n-exempt="node history detail">{h.detail}</span></li>
        ))}
      </ul>
    </Section>
  );
}
