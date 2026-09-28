import { useEffect, useState } from 'react';
import { IdentityCard } from '../../components/IdentityCard';
import { Explain, Section } from '../../components/ui';
import { label, useT } from '../../i18n';
import { formatTime, short } from '../../lib/format';
import { useDemoState, useLive, useRuntime } from '../../state';
import { CaseDetail } from './CaseDetail';
import { ProfileForm } from './ProfileForm';

export function EscrowPanel() {
  const rt = useRuntime('escrow');
  const m = useT();
  const { scenarioOrderId } = useDemoState();
  const [cases] = useLive(() => rt.client.listCases(), (cb) => rt.client.on('case', cb), [rt]);
  const [picked, setPicked] = useState<string>();
  useEffect(() => setPicked(undefined), [scenarioOrderId]);
  const scenarioCase = cases?.find((c) => c.orderId === scenarioOrderId)?.orderId;
  const selected = picked ?? scenarioCase ?? cases?.[0]?.orderId;
  return (
    <div data-testid="panel-escrow">
      <IdentityCard role="escrow" title={m.escrow.identity} />
      <ProfileForm />
      <Section title={m.escrow.cases} testid="escrow-cases">
        <Explain>{m.escrow.casesExplain}</Explain>
        {!cases?.length && <p className="muted" data-testid="escrow-cases-empty">{m.escrow.casesEmpty}</p>}
        <table>
          <tbody>
            {cases?.map((c) => (
              <tr key={c.orderId} className={c.orderId === selected ? 'selected' : ''} data-testid="escrow-case-row" data-order-id={c.orderId} data-status={c.status}>
                <td><button type="button" className="plain small" data-testid={`escrow-case-open-${c.orderId.slice(0, 8)}`} onClick={() => setPicked(c.orderId)}>{c.orderId.slice(0, 8)}</button></td>
                <td>{formatTime(c.updatedAt)}</td>
                <td>user {short(c.user)} / shopper {short(c.shopper)}</td>
                <td>{c.request?.payment}</td>
                <td><span className="badge">{label(m.format.status, c.status)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {selected && <CaseDetail key={selected} orderId={selected} />}
    </div>
  );
}
