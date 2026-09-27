import { useEffect, useState } from 'react';
import { IdentityCard } from '../../components/IdentityCard';
import { Explain, Section } from '../../components/ui';
import { formatTime, short, STATUS_LABEL } from '../../lib/format';
import { useDemoState, useLive, useRuntime } from '../../state';
import { CaseDetail } from './CaseDetail';
import { ProfileForm } from './ProfileForm';

export function EscrowPanel() {
  const rt = useRuntime('escrow');
  const { scenarioOrderId } = useDemoState();
  const [cases] = useLive(() => rt.client.listCases(), (cb) => rt.client.on('case', cb), [rt]);
  const [picked, setPicked] = useState<string>();
  useEffect(() => setPicked(undefined), [scenarioOrderId]);
  const scenarioCase = cases?.find((c) => c.orderId === scenarioOrderId)?.orderId;
  const selected = picked ?? scenarioCase ?? cases?.[0]?.orderId;
  return (
    <div data-testid="panel-escrow">
      <IdentityCard role="escrow" title="escrow の鍵" />
      <ProfileForm />
      <Section title="案件" testid="escrow-cases">
        <Explain>
          利用者が入金すると「入金の通知」（escrow.notice）が届き、案件の控えができます。紛争が申し立てられると案件が開き、escrow は T1 より前に裁定する義務を負います
          （前払い手数料を受け取った注文だけ）。
        </Explain>
        {!cases?.length && <p className="muted" data-testid="escrow-cases-empty">案件はまだありません。</p>}
        <table>
          <tbody>
            {cases?.map((c) => (
              <tr key={c.orderId} className={c.orderId === selected ? 'selected' : ''} data-testid="escrow-case-row" data-order-id={c.orderId} data-status={c.status}>
                <td><button type="button" className="plain small" data-testid={`escrow-case-open-${c.orderId.slice(0, 8)}`} onClick={() => setPicked(c.orderId)}>{c.orderId.slice(0, 8)}</button></td>
                <td>{formatTime(c.updatedAt)}</td>
                <td>user {short(c.user)} / shopper {short(c.shopper)}</td>
                <td>{c.request?.payment}</td>
                <td><span className="badge">{STATUS_LABEL[c.status] ?? c.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {selected && <CaseDetail key={selected} orderId={selected} />}
    </div>
  );
}
