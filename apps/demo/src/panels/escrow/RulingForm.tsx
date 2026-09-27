import type { EscrowCase, RulingTerms } from '@proxy-shopping/core/browser';
import { useEffect, useRef, useState } from 'react';
import { ActionButton, Explain, Field, Section } from '../../components/ui';
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
    <Section title="裁定" testid="escrow-ruling">
      <Explain>
        escrow は配分を決めて、マルチシグから利用者・shopper・escrow（紛争手数料）へ払う取引に 1 つ目の署名をします。どちらかの当事者が連署すれば 2-of-3 がそろいます。
        署名した取引は取り消せないので、1 件の紛争に裁定は 1 回だけです。
      </Explain>
      {t ? (
        <p className="muted" data-testid="ruling-distributable" data-amount={t.distributable.toString()}>
          配分できる額 {formatAsset(t.distributable, asset)}（{asset === 'btc-signet' ? 'マルチシグの出力 − 払い出し手数料の予備' : 'いまの Safe の残高'}）。
          紛争手数料はその {t.bps / 100}%（{formatAsset(t.fee, asset)}{asset === 'btc-signet' && t.fee === 0n ? '、546 sats 未満なので 0' : ''}）で、利用者と shopper への額の合計は {formatAsset(t.distributable - t.fee, asset)} にします。
        </p>
      ) : (
        <p className="banner warn" data-testid="ruling-terms-error">{terms?.error ?? '配分できる額を確かめています…'}</p>
      )}
      <div className="row">
        <button type="button" className="plain small" data-testid="ruling-preset-user" disabled={!t} onClick={() => apply('user')}>全額を利用者へ</button>
        <button type="button" className="plain small" data-testid="ruling-preset-shopper" disabled={!t} onClick={() => apply('shopper')}>全額を shopper へ</button>
      </div>
      <div className="grid2">
        <Field label="利用者へ"><input data-testid="ruling-user" value={user} onChange={(e) => setUser(e.target.value)} /></Field>
        <Field label="shopper へ"><input data-testid="ruling-shopper" value={shopper} onChange={(e) => setShopper(e.target.value)} /></Field>
      </div>
      <p data-testid="ruling-fee" data-fee={t?.fee.toString() ?? ''} data-split-ok={splitOk ? 'true' : 'false'}>
        escrow の手数料: {t ? formatAsset(t.fee, asset) : '-'}
        {t && entered !== undefined && !splitOk && `（合計を ${formatAsset(t.distributable - t.fee, asset)} にしてください。いまは ${formatAsset(entered, asset)}）`}
      </p>
      <Field label="理由"><input data-testid="ruling-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <ActionButton
        testid="ruling-submit"
        disabled={!splitOk || !!c.ruling || !c.disputes.length}
        onClick={() => rt.client.rule(c.orderId, { user, shopper, escrow_fee: t!.fee.toString() }, reason || '裁定')}
      >
        署名して裁定を送る
      </ActionButton>
      {c.ruling && (
        <p className="banner ok" data-testid="ruling-sent" data-split-user={c.ruling.split.user} data-split-shopper={c.ruling.split.shopper}>
          送信済み: 利用者 {formatAsset(c.ruling.split.user, asset)} / shopper {formatAsset(c.ruling.split.shopper, asset)} / 手数料 {formatAsset(c.ruling.split.escrow_fee, asset)}
        </p>
      )}
    </Section>
  );
}
