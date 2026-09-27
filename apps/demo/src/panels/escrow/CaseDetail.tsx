import { evidenceIntegrity, innerMeta, isValidInner, type EscrowCase } from '@proxy-shopping/core/browser';
import { ActionButton, Explain, Mono, Section } from '../../components/ui';
import { formatAsset, formatTime, short, STATUS_LABEL } from '../../lib/format';
import { useLive, useRuntime } from '../../state';
import { RulingForm } from './RulingForm';

/** Only image types a browser renders without scripts; anything else is listed, not shown. */
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

export function CaseDetail({ orderId }: { orderId: string }) {
  const rt = useRuntime('escrow');
  const [c] = useLive(() => rt.client.getCase(orderId), (cb) => rt.client.on('case', (x) => x.orderId === orderId && cb()), [rt, orderId]);
  if (!c) return <p className="muted">案件を読み込み中…</p>;
  const q = c.quote;
  const asset = c.request?.payment;
  return (
    <div data-testid="escrow-case" data-order-id={c.orderId} data-status={c.status}>
      <Section title={`案件 ${c.orderId.slice(0, 8)}`}>
        <p>状態: <span className="badge" data-testid="escrow-case-status" data-status={c.status}>{STATUS_LABEL[c.status] ?? c.status}</span></p>
        <p>{c.request?.shop_url}（{c.request?.shop_region}）{c.request?.items.map((i) => `${i.sku} × ${i.qty}`).join(', ')}</p>
        <p className="muted">user {short(c.user)} ・ shopper {short(c.shopper)} ・ 預け額 {formatAsset(q?.lock_amount, asset)} ・ 前払い {formatAsset(q?.escrow_upfront_fee, asset)}</p>
        {c.verification && (
          <div className={`banner ${c.verification.ok ? 'ok' : 'error'}`} data-testid="escrow-verification" data-ok={c.verification.ok ? 'true' : 'false'}>
            {c.verification.ok ? '注文とチェーン上の資金・前払い手数料を確かめました（裁定の義務あり）。' : <>確認できない点:<ul>{c.verification.problems.map((x) => <li key={x}>{x}</li>)}</ul></>}
          </div>
        )}
        {!!c.conflicts?.length && <div className="banner warn" data-testid="escrow-conflicts">食い違う証拠（無視しました）:<ul>{c.conflicts.map((x) => <li key={x}>{x}</li>)}</ul></div>}
        <ActionButton testid="escrow-check-obligation" kind="plain" onClick={() => rt.client.checkObligation(c.orderId)}>入金と前払い手数料をチェーンで確かめる</ActionButton>
      </Section>
      <Disputes c={c} />
      <Evidence c={c} />
      <Address c={c} />
      {c.status !== 'settled' && <RulingForm c={c} />}
      {c.settledTxid && <p className="banner ok" data-testid="escrow-settled">精算されました: <Mono>{c.settledTxid}</Mono></p>}
      <Section title="経過">
        <ul className="timeline">{[...c.timeline].reverse().map((t, i) => <li key={i}><time>{formatTime(t.at)}</time>{t.text}</li>)}</ul>
      </Section>
    </div>
  );
}

function Disputes({ c }: { c: EscrowCase }) {
  const rt = useRuntime('escrow');
  const [missing] = useLive(() => rt.client.missingEvidence(c.orderId), (cb) => rt.client.on('case', cb), [rt, c.orderId]);
  return (
    <Section title="申立">
      {!c.disputes.length && <p className="muted">まだ紛争は申し立てられていません（入金の通知だけです）。</p>}
      {c.disputes.map((d, i) => (
        <p key={i} data-testid="escrow-dispute"><strong>{d.from === c.user ? '利用者' : 'shopper'}</strong>: {d.body.claim} — {d.body.text}</p>
      ))}
      {c.disputes.length > 0 && missing && missing.length > 0 && (
        <div className="banner warn" data-testid="escrow-missing">
          足りない証拠: {missing.join(', ')}
          <ActionButton testid="escrow-request-evidence" kind="plain" onClick={() => rt.client.requestEvidence(c.orderId, missing)}>当事者に求める</ActionButton>
        </div>
      )}
    </Section>
  );
}

function Evidence({ c }: { c: EscrowCase }) {
  const attachments = Object.entries(c.attachments ?? {}).filter(([, a]) => a.dataB64);
  return (
    <Section title="証拠" testid="escrow-evidence">
      <Explain>メッセージはどれも送り手の身元鍵で署名されています（NIP-59 の中身も署名付き）。escrow は、入金の通知に写った依頼・見積・承諾・入金を注文の定義として使います。</Explain>
      <h3>署名付きメッセージ（{c.messages.length}）</h3>
      <table>
        <tbody>
          {[...c.messages].sort((a, b) => a.created_at - b.created_at).map((m) => (
            <tr key={m.id} data-testid="escrow-evidence-message">
              <td>{formatTime(m.created_at)}</td>
              <td>{m.pubkey === c.user ? '利用者' : m.pubkey === c.shopper ? 'shopper' : short(m.pubkey)}</td>
              <td>{innerMeta(m).type}</td>
              <td>{isValidInner(m) ? '署名 OK' : '署名 NG'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>配送状況</h3>
      <ul>{c.tracking.map((t, i) => <li key={i}>{formatTime(t.updated_at)} {t.status} {t.carrier} {t.tracking_no}</li>)}</ul>
      <h3>購入の証拠</h3>
      <ul>
        {c.purchaseEvidence.map((e) => {
          const integrity = evidenceIntegrity(e);
          const full = c.attachments?.[e.sha256]?.dataB64;
          return (
            <li key={e.sha256} data-testid="escrow-evidence-item" data-integrity={full ? 'ok' : integrity}>
              {e.kind} {e.mime} <Mono>{e.sha256.slice(0, 16)}</Mono>
              {integrity === 'mismatch' && <span className="badge">ハッシュ不一致（表示しません）</span>}
              {integrity === 'no-data' && !full && <span className="muted">（本体は添付で届きます）</span>}
            </li>
          );
        })}
      </ul>
      {attachments.length > 0 && (
        <>
          <h3>添付（結合してハッシュを確認済み）</h3>
          {attachments.map(([sha, a]) => (
            <div key={sha} data-testid="escrow-attachment" data-sha256={sha}>
              {a.mime} <Mono>{sha.slice(0, 16)}</Mono>
              {IMAGE.test(a.mime) && <img alt="購入画面の証拠" className="evidence-image" src={`data:${a.mime};base64,${a.dataB64}`} />}
            </div>
          ))}
        </>
      )}
    </Section>
  );
}

function Address({ c }: { c: EscrowCase }) {
  const rt = useRuntime('escrow');
  const [address, refresh] = useLive(() => rt.decryptedAddress(c.orderId), (cb) => rt.client.on('case', cb), [rt, c.orderId]);
  return (
    <Section title="届け先" testid="escrow-address-section">
      <Explain>
        届け先は注文のときに暗号化されていて、escrow の鍵（key_for_escrow）は紛争のときだけ渡されます。escrow は、署名付きの依頼に入っているハッシュと一致する鍵だけを受け入れ、
        その依頼の暗号文だけを復号します。
      </Explain>
      {address ? (
        <p data-testid="escrow-address">{address.name} 〒{address.postal_code} {address.address} {address.phone}</p>
      ) : (
        <ActionButton testid="escrow-decrypt-address" kind="plain" disabled={!c.deliveryKeyForEscrow} onClick={async () => { await rt.decryptAddress(c.orderId); refresh(); }}>
          {c.deliveryKeyForEscrow ? '届け先を復号する' : '届け先の鍵はまだ届いていません'}
        </ActionButton>
      )}
    </Section>
  );
}
