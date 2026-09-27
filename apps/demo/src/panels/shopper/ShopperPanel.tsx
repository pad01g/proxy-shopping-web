import { useEffect, useState } from 'react';
import { ActionButton, Explain, Mono, Section } from '../../components/ui';
import { formatEth, formatTime, NODE_STATE_LABEL, short } from '../../lib/format';
import { every, useApp, useDemoState, useLive } from '../../state';

/** The always-online Go shopper node (read-only: it acts by itself). */
export function ShopperPanel() {
  const app = useApp();
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
      <Section title={`${app.shopper.name}（Go ノード）`} testid="shopper-status">
        <Explain>
          shopper は常時オンラインの Go ノードで、人の操作なしに動きます: 依頼を受けて店の危険度を判定し、見積を返し、入金を確かめたら shopper-bot で代理購入し、
          配送を追跡して知らせ、利用者の支払いの署名に連署します。ここではノードの管理 API（デモのサーバー経由）で状態を見るだけです。
        </Explain>
        {lab.shopper.statusError && <p className="banner error">ノードに問い合わせられません: {lab.shopper.statusError}</p>}
        {st && (
          <p data-testid="shopper-node-status" data-paused={paused ? 'true' : 'false'}>
            公開鍵 <Mono title={st.pubkey}>{short(st.pubkey, 10)}</Mono> ・ 役割 {st.role} ・ 網 {st.network} ・ 到達性 {st.reachability ?? '-'} ・ ガス代 {formatEth(lab.shopper.eth)}
            {paused && <strong className="warn-text"> ・ 一時停止中（{formatTime(st.paused_until!)} まで）</strong>}
          </p>
        )}
        <p className="muted small">
          信頼している一覧: {Object.entries(st?.trust ?? {}).map(([op, v]) => `${op === app.ids.operator.pubkey ? 'このデモの operator' : short(op)} v${v}`).join(' ・ ') || 'なし'}
        </p>
      </Section>
      <Section title="注文" testid="shopper-orders">
        <label className="row small">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} style={{ width: 'auto' }} />
          ほかの利用者の注文も表示する（lab の e2e の注文など）
        </label>
        {!orders.length && <p className="muted" data-testid="shopper-orders-empty">このデモの利用者の注文はまだありません。</p>}
        <table>
          <tbody>
            {orders.slice(0, 15).map((o) => (
              <tr key={o.id} className={o.id === selected ? 'selected' : ''} data-testid="shopper-order-row" data-order-id={o.id} data-state={o.state}>
                <td><button type="button" className="plain small" onClick={() => setPicked(o.id)}>{o.id.slice(0, 8)}</button></td>
                <td>{formatTime(o.updated)}</td>
                <td>{o.asset}</td>
                <td><span className="badge">{NODE_STATE_LABEL[o.state] ?? o.state}</span></td>
                <td className="muted small">{o.error}</td>
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
  if (!o) return null;
  return (
    <Section title={`ノードの注文 ${id.slice(0, 8)}`} testid="shopper-order" >
      <p data-testid="shopper-order-state" data-state={o.state}>
        状態: <span className="badge">{NODE_STATE_LABEL[o.state] ?? o.state}</span>
        {o.risk_score !== undefined && ` ・ 店の点数 ${o.risk_score}`}
        {o.payout_tx && <> ・ 払い出し <Mono>{short(o.payout_tx, 10)}</Mono>（{o.payout_by}）</>}
      </p>
      {o.purchase && <p className="muted">購入: {o.purchase.status} {o.purchase.shop_order_id} {o.purchase.total && `${o.purchase.total.amount} ${o.purchase.total.currency}`} {o.purchase.error}</p>}
      {o.state === 'needs_human' && (
        <div className="banner warn">
          bot の結果をノードが判断できなかったので、人の判断を待っています。lab では、ここで「買わなかった」ことにして払い戻しを申し出させられます。
          <ActionButton
            testid="shopper-resolve-refund"
            kind="plain"
            confirm={{ title: 'この注文を「買わなかった」として払い戻しを申し出させます', okLabel: '払い戻しにする' }}
            onClick={async () => {
              await app.lab.node.resolveRefund(id);
              refresh();
            }}
          >
            払い戻しにする（lab: 人の判断の代わり）
          </ActionButton>
        </div>
      )}
      {o.pending && Object.keys(o.pending).length > 0 && (
        <p className="muted small">保留中の処理: {Object.entries(o.pending).map(([k, a]) => `${k}${a.error ? `（${a.error}）` : ''}`).join(', ')}</p>
      )}
      <h3>履歴</h3>
      <ul className="timeline" data-testid="shopper-order-history">
        {[...o.history].reverse().map((h, i) => (
          <li key={i}><time>{formatTime(h.at)}</time><span className="badge">{NODE_STATE_LABEL[h.state] ?? h.state}</span> {h.detail}</li>
        ))}
      </ul>
    </Section>
  );
}
