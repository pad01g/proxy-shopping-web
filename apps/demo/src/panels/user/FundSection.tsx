import { fundingStarted, type UserOrder } from '@proxy-shopping/core/browser';
import { ActionButton, Explain, Mono, Section, type ConfirmSpec } from '../../components/ui';
import { label, useT } from '../../i18n';
import { formatAsset } from '../../lib/format';
import { useRuntime } from '../../state';

export function FundSection({ o }: { o: UserOrder }) {
  const rt = useRuntime('user');
  const u = useT().user;
  const q = o.quote!;
  const isBtc = o.payment === 'btc-signet';
  if (fundingStarted(o)) {
    return (
      <Section title={u.fund} testid="fund">
        <p className="banner warn" data-testid="fund-in-progress">{u.fundStalled}</p>
        <ActionButton testid="order-fund" confirm={{ title: u.fundResumeTitle, recipient: q.escrow_address, okLabel: u.fundResumeOk }} onClick={() => rt.client.fund(o.id)}>
          {u.fundResume}
        </ActionButton>
      </Section>
    );
  }
  const confirm = async (): Promise<ConfirmSpec> => {
    const p = await rt.client.previewFunding(o.id);
    return {
      title: isBtc ? u.fundTitleBtc : u.fundTitleEvm,
      amount: formatAsset(p.total, o.payment),
      recipient: p.recipients[0].address,
      details: (
        <ul data-testid="confirm-details">
          {p.recipients.map((r) => <li key={r.label}>{label(u.fundRecipient, r.label)}: {formatAsset(r.amount, o.payment)} → <Mono>{r.address}</Mono></li>)}
          {p.networkFee !== undefined && <li>{u.networkFee(formatAsset(p.networkFee, o.payment), p.feeRate ?? '?')}</li>}
          {!isBtc && <li>{u.gasNote}</li>}
        </ul>
      ),
      okLabel: u.fundOk,
    };
  };
  return (
    <Section title={u.fund} testid="fund">
      <Explain>{isBtc ? u.fundExplainBtc : u.fundExplainEvm}</Explain>
      <p>{(isBtc ? u.neededBtc : u.neededEvm)(formatAsset(BigInt(q.lock_amount ?? '0') + BigInt(q.escrow_upfront_fee ?? '0'), o.payment))}</p>
      <div className="row">
        <ActionButton testid="order-fund" confirm={confirm} onClick={() => rt.client.fund(o.id)}>
          {isBtc ? u.fundBtc : u.fundEvm}
        </ActionButton>
        <ActionButton testid="fund-cancel" kind="plain" onClick={() => rt.client.cancel(o.id)}>{u.cancel}</ActionButton>
      </div>
    </Section>
  );
}
