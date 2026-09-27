import { useState } from 'react';
import { ActionButton, Copyable, Explain, Field, Section } from '../../components/ui';
import { DEMO_ESCROW_TERMS } from '../../lib/runtimes/escrow';
import { short } from '../../lib/format';
import { useDemoState, useRuntime } from '../../state';

export function ProfileForm() {
  const rt = useRuntime('escrow');
  const { snapshots } = useDemoState();
  const [name, setName] = useState(DEMO_ESCROW_TERMS.name);
  const [bps, setBps] = useState(DEMO_ESCROW_TERMS.upfront_fee.bps);
  const [minSats, setMinSats] = useState(DEMO_ESCROW_TERMS.upfront_fee.min_sats);
  const [minUsdc, setMinUsdc] = useState(DEMO_ESCROW_TERMS.upfront_fee.min_usdc);
  const [disputeBps, setDisputeBps] = useState(DEMO_ESCROW_TERMS.dispute_fee_bps);
  const [done, setDone] = useState<string>();
  const terms = { name, upfront_fee: { bps, min_sats: minSats, min_usdc: minUsdc }, dispute_fee_bps: disputeBps };
  const preview = rt.client.profileContent(terms);
  const published = snapshots.escrow?.profile;
  return (
    <Section title="escrow のプロフィール（kind 30503）" testid="escrow-profile">
      <Explain>
        プロフィールには、注文ごとの BTC の鍵を導くための拡張公開鍵（tpub, m/7333'/2'）と手数料の条件を載せます。shopper はここから escrow の鍵を導いて見積に入れ、
        利用者はそれでマルチシグのアドレスを計算し直します。
      </Explain>
      <div className="grid2">
        <Field label="名前"><input data-testid="escrow-profile-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="前払い手数料 bps（50 = 0.5%）"><input data-testid="escrow-profile-bps" type="number" value={bps} onChange={(e) => setBps(Number(e.target.value))} /></Field>
        <Field label="前払いの最低額 sats"><input data-testid="escrow-profile-min-sats" value={minSats} onChange={(e) => setMinSats(e.target.value)} /></Field>
        <Field label="前払いの最低額 USDC"><input data-testid="escrow-profile-min-usdc" value={minUsdc} onChange={(e) => setMinUsdc(e.target.value)} /></Field>
        <Field label="紛争手数料 bps（200 = 2%）"><input data-testid="escrow-profile-dispute-bps" type="number" value={disputeBps} onChange={(e) => setDisputeBps(Number(e.target.value))} /></Field>
      </div>
      <p className="muted">tpub: <Copyable value={preview.btc_xpub} display={short(preview.btc_xpub, 14)} /> ・ 手数料の受け取り: {short(preview.btc_fee_address, 10)}</p>
      <ActionButton
        testid="escrow-profile-publish"
        onClick={async () => {
          const { event, result } = await rt.publishProfile(terms);
          setDone(`v${event.tags.find((t) => t[0] === 'v')?.[1]} を ${result.ok.length} 個のリレーに公開しました`);
        }}
      >
        署名して公開する
      </ActionButton>
      {(done || published) && (
        <p className="muted" data-testid="escrow-profile-published">
          {done ?? `公開済み（前払い ${published!.bps / 100}%、紛争手数料 ${published!.disputeBps / 100}%）`}
        </p>
      )}
    </Section>
  );
}
