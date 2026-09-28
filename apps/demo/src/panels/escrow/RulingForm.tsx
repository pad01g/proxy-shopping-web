import type { EscrowCase, RulingTerms } from '@proxy-shopping/core/browser';
import { useEffect, useRef, useState } from 'react';
import { ActionButton, Explain, Field, Section } from '../../components/ui';
import { useT } from '../../i18n';
import { formatAsset } from '../../lib/format';
import { every, usePrefill, useLive, useRuntime } from '../../state';

type Preset = 'user' | 'shopper';

/** user + shopper of a preset: everything but the dispute fee to one side. */
function presetSplit(t: RulingTerms, to: Preset): { user: string; shopper: string } {
  const rest = (t.distributable - t.fee).toString();
  return to === 'user' ? { user: rest, shopper: '0' } : { user: '0', shopper: rest };
}

export function RulingForm({ c }: { c: EscrowCase }) {
  const rt = useRuntime('escrow');
  const e = useT().escrow;
  // §4.8: what a ruling splits now (USDC: the Safe's balance) and our fee, exactly dispute_fee_bps of it.
  const [terms] = useLive(
    () => rt.client.rulingTerms(c.orderId).then((t) => ({ t, error: undefined }), (e: Error) => ({ t: undefined, error: e.message })),
    every(10_000),
    [rt, c.orderId, c.updatedAt],
  );
  const [user, setUser] = useState('');
  const [shopper, setShopper] = useState('');
  const [reason, setReason] = useState('');
  const t = terms?.t;
  const asset = c.request?.payment;

  // The guide's scenario decides the split; applied once the amounts are known.
  const prefill = usePrefill('ruling-submit');
  const applied = useRef('');
  useEffect(() => {
    const key = prefill ? JSON.stringify(prefill) : '';
    if (!prefill || !t || applied.current === key) return;
    applied.current = key;
    if (prefill.preset === 'user' || prefill.preset === 'shopper') {
      const s = presetSplit(t, prefill.preset);
      setUser(s.user);
      setShopper(s.shopper);
    }
    if (typeof prefill.reason === 'string') setReason(prefill.reason);
  }, [prefill, t]);

  const apply = (to: Preset) => {
    if (!t) return;
    const s = presetSplit(t, to);
    setUser(s.user);
    setShopper(s.shopper);
  };
  const entered = /^\d{1,40}$/.test(user) && /^\d{1,40}$/.test(shopper) ? BigInt(user) + BigInt(shopper) : undefined;
  const splitOk = !!t && entered === t.distributable - t.fee;
  return (
    <Section title={e.ruling} testid="escrow-ruling">
      <Explain>{e.rulingExplain}</Explain>
      {t ? (
        <p className="muted" data-testid="ruling-distributable" data-amount={t.distributable.toString()}>
          {e.distributable({
            amount: formatAsset(t.distributable, asset),
            btc: asset === 'btc-signet',
            pct: t.bps / 100,
            fee: formatAsset(t.fee, asset),
            dust: asset === 'btc-signet' && t.fee === 0n,
            rest: formatAsset(t.distributable - t.fee, asset),
          })}
        </p>
      ) : (
        <p className="banner warn" data-testid="ruling-terms-error">{terms?.error ?? e.checkingTerms}</p>
      )}
      <div className="row">
        <button type="button" className="plain small" data-testid="ruling-preset-user" disabled={!t} onClick={() => apply('user')}>{e.presetUser}</button>
        <button type="button" className="plain small" data-testid="ruling-preset-shopper" disabled={!t} onClick={() => apply('shopper')}>{e.presetShopper}</button>
      </div>
      <div className="grid2">
        <Field label={e.toUser}><input data-testid="ruling-user" value={user} onChange={(e) => setUser(e.target.value)} /></Field>
        <Field label={e.toShopper}><input data-testid="ruling-shopper" value={shopper} onChange={(e) => setShopper(e.target.value)} /></Field>
      </div>
      <p data-testid="ruling-fee" data-fee={t?.fee.toString() ?? ''} data-split-ok={splitOk ? 'true' : 'false'}>
        {e.fee}{t ? formatAsset(t.fee, asset) : '-'}
        {t && entered !== undefined && !splitOk && e.sumHint(formatAsset(t.distributable - t.fee, asset), formatAsset(entered, asset))}
      </p>
      <Field label={e.reason}><input data-testid="ruling-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <ActionButton
        testid="ruling-submit"
        disabled={!splitOk || !!c.ruling || !c.disputes.length}
        onClick={() => rt.client.rule(c.orderId, { user, shopper, escrow_fee: t!.fee.toString() }, reason || e.defaultReason)}
      >
        {e.submit}
      </ActionButton>
      {c.ruling && (
        <p className="banner ok" data-testid="ruling-sent" data-split-user={c.ruling.split.user} data-split-shopper={c.ruling.split.shopper}>
          {e.sent(formatAsset(c.ruling.split.user, asset), formatAsset(c.ruling.split.shopper, asset), formatAsset(c.ruling.split.escrow_fee, asset))}
        </p>
      )}
    </Section>
  );
}
