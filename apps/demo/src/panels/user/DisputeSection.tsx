import { provisionalFunding, type DisputeOpen, type UserOrder } from '@proxy-shopping/core/browser';
import { useEffect, useState } from 'react';
import { ActionButton, Explain, Field, Mono, Section } from '../../components/ui';
import { label, useT } from '../../i18n';
import { formatAsset } from '../../lib/format';
import { useApplyPrefill, useRuntime } from '../../state';

const CLAIMS: Array<DisputeOpen['claim']> = ['not_delivered', 'wrong_item', 'not_released', 'other'];

export function DisputeSection({ o }: { o: UserOrder }) {
  const rt = useRuntime('user');
  const u = useT().user;
  const [claim, setClaim] = useState<DisputeOpen['claim']>('not_delivered');
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<string[]>();
  useApplyPrefill('dispute-open', (p) => {
    if (typeof p.claim === 'string') setClaim(p.claim as DisputeOpen['claim']);
    if (typeof p.text === 'string') setText(p.text);
  });
  const reviewable = !!o.ruling && !o.escrowSpent;
  useEffect(() => {
    if (reviewable) void rt.client.reviewRuling(o.id).then(setProblems);
  }, [reviewable, o.updatedAt, o.id, rt]);

  if (!provisionalFunding(o)) return null;
  const canOpen = !o.escrowSpent && !o.dispute;
  if (!canOpen && !o.dispute && !o.ruling && !o.pendingRuling) return null;
  const r = o.ruling;
  const payTo = o.payment === 'btc-signet' ? o.request.user_btc_address : o.request.user_evm_address;
  return (
    <Section title={u.dispute} testid="dispute">
      {canOpen && (
        <>
          <Explain>{u.disputeExplain}</Explain>
          <div className="grid2">
            <Field label={u.claim}>
              <select data-testid="dispute-claim" value={claim} onChange={(e) => setClaim(e.target.value as DisputeOpen['claim'])}>
                {CLAIMS.map((v) => <option key={v} value={v}>{label(u.claims, v)}</option>)}
              </select>
            </Field>
            <Field label={u.disputeText}>
              <input data-testid="dispute-text" value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          </div>
          <ActionButton testid="dispute-open" kind="danger" onClick={() => rt.client.openDispute(o.id, { claim, text })}>{u.disputeOpen}</ActionButton>
        </>
      )}
      {o.dispute && <p data-testid="dispute-opened">{u.disputeOpened(o.dispute.open.claim)}<span data-i18n-exempt="user's text">{o.dispute.open.text}</span></p>}
      {o.pendingRuling && !r && (
        <p className="banner warn" data-testid="ruling-pending">{u.rulingPending}</p>
      )}
      {r && (
        <div data-testid="ruling" data-split-user={r.split.user} data-split-shopper={r.split.shopper} data-fee={r.split.escrow_fee}>
          <p>
            {u.rulingToUser}<strong>{formatAsset(r.split.user, o.payment)}</strong>{u.rulingToShopper}<strong>{formatAsset(r.split.shopper, o.payment)}</strong>{u.rulingFee}{formatAsset(r.split.escrow_fee, o.payment)}
          </p>
          {/* The escrow's own words. */}
          <p className="muted">{u.reason}<span data-i18n-exempt="escrow's reason">{r.reason}</span></p>
          {problems && problems.length > 0 && (
            <div className="banner error" data-testid="ruling-problems">{u.rulingProblems}<ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>
          )}
          {reviewable && o.pendingSettlement?.from !== rt.pubkey && (
            <>
              <Explain>{u.countersignExplain}</Explain>
              <ActionButton
                testid="ruling-countersign"
                disabled={!problems || problems.length > 0}
                confirm={{
                  title: u.countersignTitle,
                  amount: formatAsset(r.split.user, o.payment),
                  recipient: payTo,
                  details: <p className="muted">{u.countersignDetails(formatAsset(r.split.shopper, o.payment), formatAsset(r.split.escrow_fee, o.payment))}</p>,
                  okLabel: u.countersignOk,
                }}
                onClick={() => rt.client.countersignRuling(o.id)}
              >
                {u.countersign}
              </ActionButton>
            </>
          )}
          {o.settledTxid && <p className="banner ok" data-testid="ruling-settled">{u.settled}<Mono testid="ruling-settled-txid">{o.settledTxid}</Mono></p>}
        </div>
      )}
    </Section>
  );
}
