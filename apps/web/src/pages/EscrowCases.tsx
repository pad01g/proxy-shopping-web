import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ActionButton, Copyable, Field, Section } from '../components/ui';
import { formatTime, short, STATUS_LABEL } from '../lib/format';
import { useLive, useRuntime } from '../state';

export function EscrowCasesPage() {
  const rt = useRuntime();
  const [cases] = useLive(() => rt.escrow.listCases(), (cb) => rt.escrow.on('case', cb), [rt]);
  return (
    <div data-testid="escrow-cases">
      <h1>エスクロー</h1>
      <Section title="案件">
        {!cases?.length && <p className="muted" data-testid="escrow-cases-empty">案件はありません。</p>}
        <table>
          <tbody>
            {cases?.map((c) => (
              <tr key={c.orderId} data-testid="escrow-case-row" data-order-id={c.orderId}>
                <td><Link to={`/escrow/cases/${c.orderId}`} data-testid={`escrow-case-link-${c.orderId}`}>{c.orderId.slice(0, 8)}</Link></td>
                <td>{formatTime(c.updatedAt)}</td>
                <td>user {short(c.user)} / shopper {short(c.shopper)}</td>
                <td>{c.request?.payment}</td>
                <td><span className="badge" data-testid="escrow-case-status" data-status={c.status}>{STATUS_LABEL[c.status] ?? c.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <EscrowProfileForm />
    </div>
  );
}

function EscrowProfileForm() {
  const rt = useRuntime();
  const [name, setName] = useState('escrow');
  const [bps, setBps] = useState(50);
  const [minSats, setMinSats] = useState('1000');
  const [minUsdc, setMinUsdc] = useState('0.50');
  const [disputeBps, setDisputeBps] = useState(200);
  const [done, setDone] = useState<string>();
  const preview = rt.escrow.profileContent({ name, upfront_fee: { bps, min_sats: minSats, min_usdc: minUsdc }, dispute_fee_bps: disputeBps });
  return (
    <Section title="escrow のプロフィール（kind 30503）" testid="escrow-profile">
      <div className="grid2">
        <Field label="名前"><input data-testid="escrow-profile-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="前払い手数料 bps"><input data-testid="escrow-profile-bps" type="number" value={bps} onChange={(e) => setBps(Number(e.target.value))} /></Field>
        <Field label="最低額 sats"><input data-testid="escrow-profile-min-sats" value={minSats} onChange={(e) => setMinSats(e.target.value)} /></Field>
        <Field label="最低額 USDC"><input data-testid="escrow-profile-min-usdc" value={minUsdc} onChange={(e) => setMinUsdc(e.target.value)} /></Field>
        <Field label="紛争手数料 bps"><input data-testid="escrow-profile-dispute-bps" type="number" value={disputeBps} onChange={(e) => setDisputeBps(Number(e.target.value))} /></Field>
      </div>
      <p className="muted">tpub（m/7333'/2'）: <Copyable value={preview.btc_xpub} /></p>
      <ActionButton
        testid="escrow-profile-publish"
        onClick={async () => {
          const { event, result } = await rt.escrow.publishProfile({ name, upfront_fee: { bps, min_sats: minSats, min_usdc: minUsdc }, dispute_fee_bps: disputeBps });
          setDone(`v${event.tags.find((t) => t[0] === 'v')?.[1]} を ${result.ok.length} 個のリレーに公開しました`);
        }}
      >
        公開する
      </ActionButton>
      {done && <p className="muted" data-testid="escrow-profile-published">{done}</p>}
    </Section>
  );
}
