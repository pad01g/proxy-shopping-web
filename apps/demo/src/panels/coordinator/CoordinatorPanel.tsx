import { useEffect, useState } from 'react';
import { messagesFor, useLang, useT } from '../../i18n';
import { IdentityCard } from '../../components/IdentityCard';
import { ActionButton, Explain, Field, Mono, Section } from '../../components/ui';
import { short } from '../../lib/format';
import { useApp, useApplyPrefill, useLive, useRuntime } from '../../state';

export function CoordinatorPanel() {
  const app = useApp();
  const m = useT();
  const lang = useLang();
  const rt = useRuntime('coordinator');
  const [list, reload] = useLive(() => rt.delegations(), (cb) => rt.onChange(cb), [rt]);
  const [operator, setOperator] = useState(app.ids.operator.pubkey);
  const [note, setNote] = useState(m.coordinator.defaultNote);
  // The prefilled note follows the language (it is only a default; published delegations keep theirs).
  useEffect(() => setNote(messagesFor(lang).coordinator.defaultNote), [lang]);
  useApplyPrefill('coordinator-delegate', (p) => typeof p.operator === 'string' && setOperator(p.operator));
  const label = (pk: string) => (pk === app.ids.operator.pubkey ? m.coordinator.thisOperator : short(pk));
  return (
    <div data-testid="panel-coordinator">
      <IdentityCard role="coordinator" title={m.coordinator.identity} />
      <Section title={m.coordinator.delegate} testid="coordinator-delegate-form">
        <Explain>{m.coordinator.delegateExplain(app.config.network)}</Explain>
        <div className="grid2">
          <Field label={m.coordinator.operatorKey}><input data-testid="coordinator-operator" value={operator} onChange={(e) => setOperator(e.target.value.trim())} /></Field>
          <Field label={m.coordinator.note}><input data-testid="coordinator-note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        <ActionButton
          testid="coordinator-delegate"
          disabled={!/^[0-9a-f]{64}$/.test(operator)}
          onClick={async () => {
            await rt.delegate(operator, note || undefined);
            reload();
          }}
        >
          {m.coordinator.sign}
        </ActionButton>
      </Section>
      <Section title={m.coordinator.delegations} testid="coordinator-delegations">
        {!list?.length && <p className="muted">{m.coordinator.none}</p>}
        <table>
          <thead><tr><th>operator</th><th>{m.coordinator.colVersion}</th><th>{m.coordinator.colState}</th><th>{m.coordinator.colNote}</th><th /></tr></thead>
          <tbody>
            {list?.map((d) => (
              <tr key={d.operator} data-testid="coordinator-delegation" data-operator={d.operator} data-revoked={d.revoked ? 'true' : 'false'}>
                <td><Mono title={d.operator}>{label(d.operator)}</Mono></td>
                <td>v{d.version}</td>
                <td>{d.revoked ? m.coordinator.revoked : m.coordinator.active}</td>
                {/* The note is part of the signed delegation (possibly written in another language). */}
                <td data-i18n-exempt="delegation note">{d.note}</td>
                <td>
                  {d.revoked ? (
                    <ActionButton testid={`coordinator-restore-${d.operator.slice(0, 8)}`} kind="plain" onClick={async () => { await rt.delegate(d.operator, d.note); reload(); }}>{m.coordinator.restore}</ActionButton>
                  ) : (
                    <ActionButton testid={`coordinator-revoke-${d.operator.slice(0, 8)}`} kind="plain" onClick={async () => { await rt.revoke(d.operator, d.note); reload(); }}>{m.coordinator.revoke}</ActionButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">{m.coordinator.resetNote}</p>
      </Section>
    </div>
  );
}
