import { provisionalFunding, type UserOrder } from '@proxy-shopping/core/browser';
import type { ReactNode } from 'react';
import { ErrorBoundary, Mono, Section } from '../../components/ui';
import { formatTime, PAYMENT_LABEL, short, STATUS_LABEL } from '../../lib/format';
import { useLive, useRuntime } from '../../state';
import { DisputeSection } from './DisputeSection';
import { FundSection } from './FundSection';
import { ProgressSection } from './ProgressSection';
import { QuoteSection } from './QuoteSection';
import { RefundOfferSection, TimelockRefundSection } from './RefundSections';
import { ReportSection } from './ReportSection';

const FUNDABLE = ['accepted', 'funding'];

const Panel = ({ name, children }: { name: string; children: ReactNode }) => <ErrorBoundary name={name}>{children}</ErrorBoundary>;

/** One order with every action the user has, in the order they come up. */
export function OrderDetail({ id }: { id: string }) {
  const rt = useRuntime('user');
  const [order] = useLive(() => rt.client.getOrder(id), (cb) => rt.client.on('order', (o) => o.id === id && cb()), [rt, id]);
  if (!order) return <p className="muted">注文を読み込み中…</p>;
  const o: UserOrder = order;
  return (
    <div data-testid="order-detail" data-order-id={o.id} data-status={o.status}>
      <Section title="注文の詳細">
        <p>
          注文 <Mono testid="order-id">{o.id}</Mono> ・ 状態 <span className="badge" data-testid="order-status" data-status={o.status}>{STATUS_LABEL[o.status] ?? o.status}</span>
        </p>
        <p className="muted">
          {o.request.shop_url}（{o.request.shop_region}）・ {o.request.items.map((i) => `${i.sku} × ${i.qty}`).join(', ')} ・ {PAYMENT_LABEL[o.payment]}
          ・ shopper {o.shopperProfile?.name ?? short(o.shopper)} × escrow {o.escrowProfile?.name ?? short(o.escrow)}
        </p>
        {o.lastError && <p className="banner error" data-testid="order-last-error">{o.lastError}</p>}
        {o.pendingSettlement && (
          <p className="banner warn" data-testid="order-pending-settlement" data-kind={o.pendingSettlement.kind}>
            {o.pendingSettlement.from === rt.pubkey ? '取引を放送しました' : `相手が${o.pendingSettlement.kind === 'completed' ? '完了' : '連署'}を報告しました`}
            （<Mono>{short(o.pendingSettlement.txid)}</Mono>）。チェーンで多重署名の出力が使われたのを確かめるまで、この注文は終わっていません。
          </p>
        )}
      </Section>
      <Panel name="quote"><QuoteSection o={o} /></Panel>
      {FUNDABLE.includes(o.status) && <Panel name="fund"><FundSection o={o} /></Panel>}
      <Panel name="progress"><ProgressSection o={o} /></Panel>
      {o.refundOffer && !o.escrowSpent && <Panel name="refund-offer"><RefundOfferSection o={o} /></Panel>}
      <Panel name="dispute"><DisputeSection o={o} /></Panel>
      {provisionalFunding(o) && <Panel name="refund"><TimelockRefundSection o={o} /></Panel>}
      {o.funded && <Panel name="report"><ReportSection o={o} /></Panel>}
      <Section title="経過" testid="order-timeline">
        <ul className="timeline">
          {[...o.timeline].reverse().map((t, i) => (
            <li key={i} data-testid="order-timeline-item" data-kind={t.kind}><time>{formatTime(t.at)}</time>{t.text}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
