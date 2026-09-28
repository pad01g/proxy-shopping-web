import { useEffect, useState } from 'react';
import { messagesFor, useLang, useT } from '../../i18n';
import { ActionButton, Copyable, Explain, Field, Section } from '../../components/ui';
import { DEMO_ESCROW_FEES } from '../../lib/runtimes/escrow';
import { short } from '../../lib/format';
import { useDemoState, useRuntime } from '../../state';

export function ProfileForm() {
  const rt = useRuntime('escrow');
  const m = useT();
  const e = m.escrow;
  const lang = useLang();
  const { snapshots } = useDemoState();
  const [name, setName] = useState(e.defaultName);
  // The prefilled name follows the language (a published profile keeps the name it was signed with).
  useEffect(() => setName(messagesFor(lang).escrow.defaultName), [lang]);
  const [bps, setBps] = useState(DEMO_ESCROW_FEES.upfront_fee.bps);
  const [minSats, setMinSats] = useState(DEMO_ESCROW_FEES.upfront_fee.min_sats);
  const [minUsdc, setMinUsdc] = useState(DEMO_ESCROW_FEES.upfront_fee.min_usdc);
  const [disputeBps, setDisputeBps] = useState(DEMO_ESCROW_FEES.dispute_fee_bps);
  const [done, setDone] = useState<{ v: string; relays: number }>();
  const terms = { name, upfront_fee: { bps, min_sats: minSats, min_usdc: minUsdc }, dispute_fee_bps: disputeBps };
  const preview = rt.client.profileContent(terms);
  const published = snapshots.escrow?.profile;
  return (
    <Section title={e.profile} testid="escrow-profile">
      <Explain>{e.profileExplain}</Explain>
      <div className="grid2">
        <Field label={e.name}><input data-testid="escrow-profile-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={e.bps}><input data-testid="escrow-profile-bps" type="number" value={bps} onChange={(e) => setBps(Number(e.target.value))} /></Field>
        <Field label={e.minSats}><input data-testid="escrow-profile-min-sats" value={minSats} onChange={(e) => setMinSats(e.target.value)} /></Field>
        <Field label={e.minUsdc}><input data-testid="escrow-profile-min-usdc" value={minUsdc} onChange={(e) => setMinUsdc(e.target.value)} /></Field>
        <Field label={e.disputeBps}><input data-testid="escrow-profile-dispute-bps" type="number" value={disputeBps} onChange={(e) => setDisputeBps(Number(e.target.value))} /></Field>
      </div>
      <p className="muted">tpub: <Copyable value={preview.btc_xpub} display={short(preview.btc_xpub, 14)} />{m.common.sep}{e.feeAddress}{short(preview.btc_fee_address, 10)}</p>
      <ActionButton
        testid="escrow-profile-publish"
        onClick={async () => {
          const { event, result } = await rt.publishProfile(terms);
          setDone({ v: event.tags.find((t) => t[0] === 'v')?.[1] ?? '?', relays: result.ok.length });
        }}
      >
        {e.publish}
      </ActionButton>
      {(done || published) && (
        <p className="muted" data-testid="escrow-profile-published">
          {done ? e.publishedTo(done.v, done.relays) : e.published(published!.bps / 100, published!.disputeBps / 100)}
        </p>
      )}
    </Section>
  );
}
