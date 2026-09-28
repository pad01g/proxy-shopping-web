import { provisionalFunding, type UserOrder } from '@proxy-shopping/core/browser';
import type { ReactNode } from 'react';
import { ErrorBoundary, Mono, Section } from '../../components/ui';
import { TimelineItem } from '../../components/TimelineItem';
import { label, useT } from '../../i18n';
import { PAYMENT_LABEL, short } from '../../lib/format';
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
  const m = useT();
  const u = m.user;
  const sep = m.common.sep;
  const [order] = useLive(() => rt.client.getOrder(id), (cb) => rt.client.on('order', (o) => o.id === id && cb()), [rt, id]);
  if (!order) return <p className="muted">{u.orderLoading}</p>;
  const o: UserOrder = order;
  return (
    <div data-testid="order-detail" data-order-id={o.id} data-status={o.status}>
      <Section title={u.orderDetail}>
        <p>
          {u.order} <Mono testid="order-id">{o.id}</Mono>{sep}{u.state} <span className="badge" data-testid="order-status" data-status={o.status}>{label(m.format.status, o.status)}</span>
        </p>
        <p className="muted">
          {o.request.shop_url}{m.common.paren(o.request.shop_region)}{sep}{o.request.items.map((i) => `${i.sku} × ${i.qty}`).join(', ')}{sep}{PAYMENT_LABEL[o.payment]}
          {/* Profile names are what the shopper and the escrow published (in their own language). */}
          {sep}shopper <span data-i18n-exempt="profile name">{o.shopperProfile?.name ?? short(o.shopper)}</span> × escrow <span data-i18n-exempt="profile name">{o.escrowProfile?.name ?? short(o.escrow)}</span>
        </p>
        {/* Core's error message. */}
        {o.lastError && <p className="banner error" data-testid="order-last-error" data-i18n-exempt="core error">{o.lastError}</p>}
        {o.pendingSettlement && (
          <p className="banner warn" data-testid="order-pending-settlement" data-kind={o.pendingSettlement.kind}>
            {o.pendingSettlement.from === rt.pubkey ? u.broadcast : o.pendingSettlement.kind === 'completed' ? u.peerCompleted : u.peerSettled}
            {m.common.open}<Mono>{short(o.pendingSettlement.txid)}</Mono>{m.common.close}{u.pendingTail}
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
      <Section title={m.common.timeline} testid="order-timeline">
        <ul className="timeline">
          {[...o.timeline].reverse().map((t, i) => (
            <TimelineItem key={i} entry={t} testid="order-timeline-item" />
          ))}
        </ul>
      </Section>
    </div>
  );
}
