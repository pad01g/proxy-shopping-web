import type { UserOrder } from '@proxy-shopping/core/browser';
import { ActionButton, Explain, Mono, Section } from '../../components/ui';
import { label, useT } from '../../i18n';
import { formatAsset, formatTime } from '../../lib/format';
import { useRuntime } from '../../state';
import { useChainNow } from './chain';

/** A timelock as block height (BTC) or chain time (USDC), with how far away it is on the chain's clock. */
export function Timelock({ o, value, now, testid }: { o: UserOrder; value: number; now?: number; testid: string }) {
  const u = useT().user;
  const btc = o.payment === 'btc-signet';
  const left = now === undefined ? undefined : Math.max(0, value - now);
  return (
    <span data-testid={testid} data-value={value}>
      {btc ? u.height(value) : formatTime(value)}
      {left !== undefined && (left === 0 ? u.passed : btc ? u.blocksLeft(left) : u.secondsLeft(left))}
    </span>
  );
}

export function QuoteSection({ o }: { o: UserOrder }) {
  const rt = useRuntime('user');
  const now = useChainNow(rt, o.payment);
  const m = useT();
  const u = m.user;
  const q = o.quote;
  if (!q) {
    return (
      <Section title={u.quote} testid="quote">
        <p className="muted" data-testid="quote-waiting">{u.quoteWaiting}</p>
        {o.status === 'requested' && (
          <div className="row">
            <ActionButton testid="request-resend" kind="plain" onClick={() => rt.client.resendRequest(o.id)}>{u.resend}</ActionButton>
            <ActionButton testid="request-cancel" kind="plain" onClick={() => rt.client.cancel(o.id)}>{u.cancel}</ActionButton>
          </div>
        )}
      </Section>
    );
  }
  if (!q.accept) {
    return (
      <Section title={u.quote} testid="quote">
        <p className="banner error" data-testid="quote-rejected" data-reason={q.reject_reason ?? ''}>
          {u.rejected(q.reject_reason ?? '', q.reject_reason ? label(m.format.reject, q.reject_reason) : u.unknownReason)}
          {/* The shopper's own explanation. */}
          {q.detail && <> — <span data-i18n-exempt="shopper's detail">{q.detail}</span></>}
        </p>
        <Explain>{u.rejectedExplain}</Explain>
      </Section>
    );
  }
  const check = o.quoteCheck;
  const ack = check?.ackRequired ?? [];
  return (
    <Section title={u.quote} testid="quote">
      <Explain>{u.quoteExplain}</Explain>
      <table>
        <tbody>
          <tr><th>{u.price}</th><td>{q.price?.items.amount} + {q.price?.shipping.amount} + {q.price?.shopper_fee.amount} {q.price?.items.currency}</td></tr>
          <tr><th>{u.rate}</th><td data-testid="quote-rate">{q.fx?.pair} = {q.fx?.rate}{check?.fx && u.deviation((check.fx.deviation * 100).toFixed(2))}</td></tr>
          <tr><th>{u.lock}</th><td data-testid="quote-lock-amount">{formatAsset(q.lock_amount, q.asset)}{u.lockReserve(formatAsset(q.payout_fee_reserve, q.asset))}</td></tr>
          <tr><th>{u.upfront}</th><td>{formatAsset(q.escrow_upfront_fee, q.asset)}</td></tr>
          {q.timelock && (
            <>
              <tr><th>{u.t1}</th><td><Timelock o={o} value={q.timelock.t1} now={now} testid="quote-timelock-t1" /></td></tr>
              <tr><th>{u.t2}</th><td><Timelock o={o} value={q.timelock.t2} now={now} testid="quote-timelock-t2" /></td></tr>
            </>
          )}
          <tr><th>{o.payment === 'btc-signet' ? u.multisig : 'Safe'}</th><td><Mono testid="quote-escrow-address">{q.escrow_address}</Mono></td></tr>
        </tbody>
      </table>
      {check && !check.ok && (
        <div className="banner error" data-testid="quote-check-errors">{u.checkFailed}<ul>{check.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>
      )}
      {!!check?.warnings.length && <div className="banner warn" data-testid="quote-check-warnings"><ul>{check.warnings.map((e) => <li key={e}>{e}</li>)}</ul></div>}
      {check?.ok && <p className="banner ok" data-testid="quote-check-ok">{u.checkOk}</p>}
      {o.status === 'quoted' && (
        <div className="row">
          <ActionButton
            testid="quote-accept"
            disabled={!check?.ok}
            confirm={ack.length ? {
              title: u.ackTitle,
              warning: ack.join(' / '),
              details: <p className="muted">{u.ackDetails}</p>,
              okLabel: u.ackOk,
            } : undefined}
            onClick={() => rt.client.acceptQuote(o.id, { acknowledgeRateDeviation: ack.length > 0 })}
          >
            {u.accept}
          </ActionButton>
          <ActionButton testid="quote-recheck" kind="plain" onClick={() => rt.client.recheckQuote(o.id)}>{u.recheck}</ActionButton>
          <ActionButton testid="quote-cancel" kind="plain" onClick={() => rt.client.cancel(o.id)}>{u.cancel}</ActionButton>
        </div>
      )}
    </Section>
  );
}
