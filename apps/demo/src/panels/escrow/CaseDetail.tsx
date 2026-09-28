import { evidenceIntegrity, innerMeta, isValidInner, type EscrowCase } from '@proxy-shopping/core/browser';
import { ActionButton, Explain, Mono, Section } from '../../components/ui';
import { TimelineItem } from '../../components/TimelineItem';
import { label, useT } from '../../i18n';
import { formatAsset, formatTime, short } from '../../lib/format';
import { useLive, useRuntime } from '../../state';
import { RulingForm } from './RulingForm';

/** Only image types a browser renders without scripts; anything else is listed, not shown. */
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

export function CaseDetail({ orderId }: { orderId: string }) {
  const rt = useRuntime('escrow');
  const m = useT();
  const e = m.escrow;
  const [c] = useLive(() => rt.client.getCase(orderId), (cb) => rt.client.on('case', (x) => x.orderId === orderId && cb()), [rt, orderId]);
  if (!c) return <p className="muted">{e.caseLoading}</p>;
  const q = c.quote;
  const asset = c.request?.payment;
  return (
    <div data-testid="escrow-case" data-order-id={c.orderId} data-status={c.status}>
      <Section title={e.caseTitle(c.orderId.slice(0, 8))}>
        <p>{m.common.status}<span className="badge" data-testid="escrow-case-status" data-status={c.status}>{label(m.format.status, c.status)}</span></p>
        <p>{c.request?.shop_url}{m.common.paren(c.request?.shop_region ?? '')}{c.request?.items.map((i) => `${i.sku} × ${i.qty}`).join(', ')}</p>
        <p className="muted">{e.caseParties(short(c.user), short(c.shopper), formatAsset(q?.lock_amount, asset), formatAsset(q?.escrow_upfront_fee, asset))}</p>
        {c.verification && (
          <div className={`banner ${c.verification.ok ? 'ok' : 'error'}`} data-testid="escrow-verification" data-ok={c.verification.ok ? 'true' : 'false'}>
            {c.verification.ok ? e.verified : <>{e.unverified}<ul>{c.verification.problems.map((x) => <li key={x}>{x}</li>)}</ul></>}
          </div>
        )}
        {!!c.conflicts?.length && <div className="banner warn" data-testid="escrow-conflicts">{e.conflicts}<ul>{c.conflicts.map((x) => <li key={x}>{x}</li>)}</ul></div>}
        <ActionButton testid="escrow-check-obligation" kind="plain" onClick={() => rt.client.checkObligation(c.orderId)}>{e.checkObligation}</ActionButton>
      </Section>
      <Disputes c={c} />
      <Evidence c={c} />
      <Address c={c} />
      {c.status !== 'settled' && <RulingForm c={c} />}
      {c.settledTxid && <p className="banner ok" data-testid="escrow-settled">{e.settled}<Mono>{c.settledTxid}</Mono></p>}
      <Section title={m.common.timeline}>
        <ul className="timeline">{[...c.timeline].reverse().map((t, i) => <TimelineItem key={i} entry={t} />)}</ul>
      </Section>
    </div>
  );
}

function Disputes({ c }: { c: EscrowCase }) {
  const rt = useRuntime('escrow');
  const [missing] = useLive(() => rt.client.missingEvidence(c.orderId), (cb) => rt.client.on('case', cb), [rt, c.orderId]);
  const e = useT().escrow;
  return (
    <Section title={e.disputes}>
      {!c.disputes.length && <p className="muted">{e.noDisputes}</p>}
      {c.disputes.map((d, i) => (
        // The claim's text is the party's own words.
        <p key={i} data-testid="escrow-dispute"><strong>{d.from === c.user ? e.fromUser : e.fromShopper}</strong>: {d.body.claim} — <span data-i18n-exempt="party's text">{d.body.text}</span></p>
      ))}
      {c.disputes.length > 0 && missing && missing.length > 0 && (
        <div className="banner warn" data-testid="escrow-missing">
          {e.missing}{missing.join(', ')}
          <ActionButton testid="escrow-request-evidence" kind="plain" onClick={() => rt.client.requestEvidence(c.orderId, missing)}>{e.requestEvidence}</ActionButton>
        </div>
      )}
    </Section>
  );
}

function Evidence({ c }: { c: EscrowCase }) {
  const attachments = Object.entries(c.attachments ?? {}).filter(([, a]) => a.dataB64);
  const e = useT().escrow;
  return (
    <Section title={e.evidence} testid="escrow-evidence">
      <Explain>{e.evidenceExplain}</Explain>
      <h3>{e.messages(c.messages.length)}</h3>
      <table>
        <tbody>
          {[...c.messages].sort((a, b) => a.created_at - b.created_at).map((m) => (
            <tr key={m.id} data-testid="escrow-evidence-message">
              <td>{formatTime(m.created_at)}</td>
              <td>{m.pubkey === c.user ? e.fromUser : m.pubkey === c.shopper ? e.fromShopper : short(m.pubkey)}</td>
              <td>{innerMeta(m).type}</td>
              <td>{isValidInner(m) ? e.sigOk : e.sigNg}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>{e.tracking}</h3>
      <ul>{c.tracking.map((t, i) => <li key={i}>{formatTime(t.updated_at)} {t.status} {t.carrier} {t.tracking_no}</li>)}</ul>
      <h3>{e.purchase}</h3>
      <ul>
        {c.purchaseEvidence.map((ev) => {
          const integrity = evidenceIntegrity(ev);
          const full = c.attachments?.[ev.sha256]?.dataB64;
          return (
            <li key={ev.sha256} data-testid="escrow-evidence-item" data-integrity={full ? 'ok' : integrity}>
              {ev.kind} {ev.mime} <Mono>{ev.sha256.slice(0, 16)}</Mono>
              {integrity === 'mismatch' && <span className="badge">{e.mismatch}</span>}
              {integrity === 'no-data' && !full && <span className="muted">{e.noData}</span>}
            </li>
          );
        })}
      </ul>
      {attachments.length > 0 && (
        <>
          <h3>{e.attachments}</h3>
          {attachments.map(([sha, a]) => (
            <div key={sha} data-testid="escrow-attachment" data-sha256={sha}>
              {a.mime} <Mono>{sha.slice(0, 16)}</Mono>
              {IMAGE.test(a.mime) && <img alt={e.imageAlt} className="evidence-image" src={`data:${a.mime};base64,${a.dataB64}`} />}
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
  const e = useT().escrow;
  return (
    <Section title={e.address} testid="escrow-address-section">
      <Explain>{e.addressExplain}</Explain>
      {address ? (
        // The user's address as they entered it.
        <p data-testid="escrow-address" data-i18n-exempt="decrypted address">{e.formatAddress(address)}</p>
      ) : (
        <ActionButton testid="escrow-decrypt-address" kind="plain" disabled={!c.deliveryKeyForEscrow} onClick={async () => { await rt.decryptAddress(c.orderId); refresh(); }}>
          {c.deliveryKeyForEscrow ? e.decrypt : e.noKey}
        </ActionButton>
      )}
    </Section>
  );
}
