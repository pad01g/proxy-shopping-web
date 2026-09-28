import type { UserOrder } from '@proxy-shopping/core/browser';
import { ActionButton, Explain, Mono, Section } from '../../components/ui';
import { useT } from '../../i18n';
import { formatAsset, formatTime } from '../../lib/format';
import { useRuntime } from '../../state';
import { useChainNow } from './chain';
import { Timelock } from './QuoteSection';

/** The shopper's cooperative refund: shown for review, signed only after the user confirms (§4.10). */
export function RefundOfferSection({ o }: { o: UserOrder }) {
  const rt = useRuntime('user');
  const u = useT().user;
  const offer = o.refundOffer!;
  return (
    <Section title={u.refundOffer} testid="refund-offer">
      <Explain>{u.refundOfferExplain}</Explain>
      <p>{u.refundOfferTo(formatAsset(offer.amount, o.payment))}<Mono>{offer.recipient}</Mono>{u.refundOfferAt(formatTime(offer.receivedAt))}</p>
      {offer.problems.length > 0 ? (
        <div className="banner error" data-testid="refund-offer-problems">{u.refundOfferProblems}<ul>{offer.problems.map((p) => <li key={p}>{p}</li>)}</ul></div>
      ) : (
        <ActionButton
          testid="refund-offer-accept"
          confirm={{ title: u.refundOfferTitle, amount: formatAsset(offer.amount, o.payment), recipient: offer.recipient, okLabel: u.countersignOk }}
          onClick={() => rt.client.acceptRefundOffer(o.id)}
        >
          {u.refundOfferAccept}
        </ActionButton>
      )}
    </Section>
  );
}

/** After T2 the user alone can take everything back (§5.1 T2 path, §6.3 refundToUser). */
export function TimelockRefundSection({ o }: { o: UserOrder }) {
  const rt = useRuntime('user');
  const now = useChainNow(rt, o.payment);
  const u = useT().user;
  const q = o.quote;
  const t2 = q?.timelock?.t2;
  if (!q || !t2) return null;
  if (o.status === 'refunded') {
    return (
      <Section title={u.refundDone} testid="refund">
        <p className="banner ok" data-testid="order-refunded">{u.refunded}<Mono testid="order-refund-txid">{o.refundTxid}</Mono></p>
      </Section>
    );
  }
  if (o.escrowSpent) return null;
  const reached = now !== undefined && now >= t2;
  const isBtc = o.payment === 'btc-signet';
  const reserve = BigInt(q.payout_fee_reserve ?? '0');
  const amount = isBtc ? BigInt(q.lock_amount ?? '0') - (reserve > 0n ? reserve : 500n) : BigInt(q.lock_amount ?? '0');
  return (
    <Section title={u.refundT2} testid="refund">
      <Explain>{u.refundT2Explain(isBtc)}</Explain>
      <p className="muted" data-testid="refund-status" data-reached={reached ? 'true' : 'false'}>
        T2 = <Timelock o={o} value={t2} now={now} testid="refund-t2" />
      </p>
      <ActionButton
        testid="order-refund"
        kind="plain"
        disabled={!reached}
        confirm={{ title: u.refundT2Title, amount: formatAsset(amount, o.payment), recipient: isBtc ? o.request.user_btc_address : o.request.user_evm_address, okLabel: u.refundT2Ok }}
        onClick={() => rt.client.refundAfterTimelock(o.id)}
      >
        {u.refundT2Button}
      </ActionButton>
    </Section>
  );
}
