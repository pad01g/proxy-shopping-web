import { evidenceIntegrity, innerMeta, isValidInner, type Address } from '@proxy-shopping/core/browser';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ActionButton, ErrorBoundary, Field, Mono, Section } from '../components/ui';
import { formatAsset, formatTime, short, STATUS_LABEL } from '../lib/format';
import { useLive, useRuntime } from '../state';

export function EscrowCasePage() {
  const { id = '' } = useParams();
  const rt = useRuntime();
  const [c] = useLive(() => rt.escrow.getCase(id), (cb) => rt.escrow.on('case', (x) => x.orderId === id && cb()), [rt, id]);
  const [missing] = useLive(() => rt.escrow.missingEvidence(id), (cb) => rt.escrow.on('case', cb), [rt, id]);
  const [address, setAddress] = useState<Address>();
  const [user, setUser] = useState('');
  const [shopper, setShopper] = useState('');
  const [reason, setReason] = useState('');
  if (!c) return <p className="muted">案件を読み込み中…</p>;

  const q = c.quote;
  // Only image types a browser renders without scripts; everything else is listed, not shown.
  const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
  const asset = c.request?.payment;
  const lock = q?.lock_amount ? BigInt(q.lock_amount) : 0n;
  const reserve = asset === 'btc-signet' && q?.payout_fee_reserve ? BigInt(q.payout_fee_reserve) : 0n;
  const distributable = lock - reserve;
  const fee = user && shopper && /^\d+$/.test(user) && /^\d+$/.test(shopper) ? distributable - BigInt(user) - BigInt(shopper) : undefined;

  return (
    <div data-testid="escrow-case" data-order-id={c.orderId}>
      <h1>案件 <Mono>{c.orderId}</Mono></h1>
      <p>状態: <span className="badge" data-testid="escrow-case-detail-status" data-status={c.status}>{STATUS_LABEL[c.status] ?? c.status}</span></p>
      {c.rejected && <p className="banner error" data-testid="escrow-case-rejected">この案件は受けられません: {c.rejected}</p>}
      {!!c.conflicts?.length && (
        <div className="banner warn" data-testid="escrow-conflicts">入金の通知と食い違う証拠（無視しました）:<ul>{c.conflicts.map((x) => <li key={x}>{x}</li>)}</ul></div>
      )}
      {c.verification && (
        <div className={`banner ${c.verification.ok ? 'ok' : 'error'}`} data-testid="escrow-verification" data-ok={c.verification.ok ? 'true' : 'false'}>
          {c.verification.ok ? '注文とチェーン上の資金を確かめました。' : <>確認できない点:<ul>{c.verification.problems.map((x) => <li key={x}>{x}</li>)}</ul></>}
        </div>
      )}
      {c.pendingSettlement && <p className="banner warn" data-testid="escrow-pending-settlement">連署の報告（<Mono>{c.pendingSettlement.txid.slice(0, 16)}</Mono>）をチェーンで確認中です。</p>}
      <ErrorBoundary name="escrow-case">

      <Section title="注文">
        <p>{c.request?.shop_url}（{c.request?.shop_region}）{c.request?.items.map((i) => `${i.sku}×${i.qty}`).join(', ')}</p>
        <p className="muted">user {short(c.user)} ・ shopper {short(c.shopper)}</p>
        <p>預け額 {formatAsset(q?.lock_amount, asset)} ・ 予備 {formatAsset(q?.payout_fee_reserve, asset)} ・ 前払い {formatAsset(q?.escrow_upfront_fee, asset)}</p>
        <p className="muted">多重署名 <Mono>{q?.escrow_address}</Mono></p>
        <div className="row">
          <ActionButton testid="escrow-check-obligation" kind="plain" onClick={() => rt.escrow.checkObligation(c.orderId)}>前払い手数料をチェーンで確かめる</ActionButton>
          {c.obligation && (
            <span className={`badge`} data-testid="escrow-obligation" data-paid={c.obligation.paid ? 'true' : 'false'}>
              {c.obligation.paid ? '前払い済み（裁定の義務あり）' : '前払いなし: 義務なし'} — {c.obligation.detail}
            </span>
          )}
        </div>
      </Section>

      <Section title="申立">
        {c.disputes.map((d, i) => (
          <div key={i} data-testid="escrow-dispute">
            <p><strong>{d.from === c.user ? 'user' : 'shopper'}</strong>: {d.body.claim} — {d.body.text}</p>
            {d.body.requested_split && <p className="muted">希望 user {d.body.requested_split.user} / shopper {d.body.requested_split.shopper}</p>}
          </div>
        ))}
        {missing && missing.length > 0 && (
          <div className="banner warn" data-testid="escrow-missing">
            足りない証拠: {missing.join(', ')}
            <ActionButton testid="escrow-request-evidence" kind="plain" onClick={() => rt.escrow.requestEvidence(c.orderId, missing)}>当事者に求める</ActionButton>
          </div>
        )}
      </Section>

      <Section title="証拠" testid="escrow-evidence">
        <h3>署名付きメッセージ（{c.messages.length}）</h3>
        <table>
          <tbody>
            {[...c.messages].sort((a, b) => a.created_at - b.created_at).map((m) => (
              <tr key={m.id} data-testid="escrow-evidence-message">
                <td>{formatTime(m.created_at)}</td>
                <td>{m.pubkey === c.user ? 'user' : m.pubkey === c.shopper ? 'shopper' : short(m.pubkey)}</td>
                <td>{innerMeta(m).type}</td>
                <td>{isValidInner(m) ? '署名 OK' : '署名 NG'}</td>
                <td><details><summary>本文</summary><pre className="mono">{m.content}</pre></details></td>
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
            const data = integrity === 'ok' ? e.data_b64 : full;
            return (
              <li key={e.sha256} data-testid="escrow-evidence-item" data-integrity={full ? 'ok' : integrity}>
                {e.kind} {e.mime} <Mono>{e.sha256.slice(0, 16)}</Mono>
                {integrity === 'mismatch' && <span className="badge" data-testid="escrow-evidence-mismatch">ハッシュ不一致（表示しません）</span>}
                {integrity === 'no-data' && !full && <span className="muted">（本体は添付で届きます）</span>}
                {data && IMAGE.test(e.mime) && <img alt="" data-testid="escrow-evidence-image" style={{ maxWidth: 240, display: 'block' }} src={`data:${e.mime};base64,${data}`} />}
              </li>
            );
          })}
        </ul>
        {Object.entries(c.attachments ?? {}).filter(([, a]) => a.dataB64).length > 0 && (
          <>
            <h3>添付（結合してハッシュを確認済み）</h3>
            <ul>
              {Object.entries(c.attachments ?? {}).filter(([, a]) => a.dataB64).map(([sha, a]) => (
                <li key={sha} data-testid="escrow-attachment" data-sha256={sha}>
                  {a.mime} <Mono>{sha.slice(0, 16)}</Mono>
                  {IMAGE.test(a.mime) && <img alt="" style={{ maxWidth: 480, display: 'block' }} src={`data:${a.mime};base64,${a.dataB64}`} />}
                </li>
              ))}
            </ul>
          </>
        )}
        <h3>届け先</h3>
        {address ? (
          <p data-testid="escrow-address">{address.name} 〒{address.postal_code} {address.address} {address.phone}</p>
        ) : (
          <ActionButton testid="escrow-decrypt-address" kind="plain" onClick={async () => setAddress(await rt.escrow.decryptAddress(c.orderId))}>届け先を復号する</ActionButton>
        )}
      </Section>

      {c.status !== 'settled' && (
        <Section title="裁定" testid="escrow-ruling">
          <p className="muted">配分の合計は {formatAsset(distributable, asset)}（多重署名の残高 − 払い出し手数料の予備）。残りが escrow の手数料になります。</p>
          <div className="grid2">
            <Field label="user へ"><input data-testid="ruling-user" value={user} onChange={(e) => setUser(e.target.value)} /></Field>
            <Field label="shopper へ"><input data-testid="ruling-shopper" value={shopper} onChange={(e) => setShopper(e.target.value)} /></Field>
          </div>
          <p data-testid="ruling-fee">escrow 手数料: {fee === undefined ? '-' : formatAsset(fee < 0n ? 0n : fee, asset)}{fee !== undefined && fee < 0n && '（合計が多すぎます）'}</p>
          <Field label="理由"><textarea data-testid="ruling-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <ActionButton testid="ruling-submit" disabled={fee === undefined || fee < 0n || !!c.ruling || !!c.rejected} onClick={() => rt.escrow.rule(c.orderId, { user, shopper }, reason)}>
            署名して裁定を送る
          </ActionButton>
          {c.ruling && <p className="banner ok" data-testid="ruling-sent">送信済み: user {c.ruling.split.user} / shopper {c.ruling.split.shopper} / 手数料 {c.ruling.split.escrow_fee}</p>}
        </Section>
      )}
      {c.settledTxid && <p className="banner ok" data-testid="escrow-settled">精算されました: <Mono>{c.settledTxid}</Mono></p>}

      </ErrorBoundary>
      <Section title="経過">
        <ul className="timeline">{[...c.timeline].reverse().map((t, i) => <li key={i}><time>{formatTime(t.at)}</time>{t.text}</li>)}</ul>
      </Section>
    </div>
  );
}
