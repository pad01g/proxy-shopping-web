import { useState } from 'react';
import { ActionButton, Field, Mono, Section } from '../components/ui';
import { useLive, useRuntime } from '../state';

export function CoordinatorPage() {
  const rt = useRuntime();
  const [tick, setTick] = useState(0);
  const [list] = useLive(() => rt.coordinator.delegations(), () => () => undefined, [rt, tick]);
  const [operator, setOperator] = useState('');
  const [note, setNote] = useState('');
  const bump = () => setTick((t) => t + 1);
  return (
    <div data-testid="coordinator">
      <h1>コーディネータの委任書（kind 30500）</h1>
      <p className="muted">あなたの公開鍵を coordinator として設定した利用者は、ここで委任した operator の一覧を信頼します。</p>
      <Section title="委任">
        <table>
          <thead><tr><th>operator</th><th>版</th><th>状態</th><th>メモ</th><th /></tr></thead>
          <tbody>
            {list?.map((d) => (
              <tr key={d.operator} data-testid="coordinator-delegation" data-operator={d.operator} data-revoked={d.revoked ? 'true' : 'false'}>
                <td><Mono>{d.operator}</Mono></td>
                <td data-testid="coordinator-delegation-version">v{d.version}</td>
                <td>{d.revoked ? '失効' : '有効'}</td>
                <td>{d.note}</td>
                <td>
                  {d.revoked ? (
                    <ActionButton testid={`coordinator-restore-${d.operator.slice(0, 8)}`} kind="plain" onClick={async () => { await rt.coordinator.delegate(d.operator, d.note); bump(); }}>再委任</ActionButton>
                  ) : (
                    <ActionButton testid={`coordinator-revoke-${d.operator.slice(0, 8)}`} kind="danger" onClick={async () => { await rt.coordinator.revoke(d.operator, d.note); bump(); }}>失効させる</ActionButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="新しく委任する">
        <Field label="operator の公開鍵（hex）"><input data-testid="coordinator-operator" value={operator} onChange={(e) => setOperator(e.target.value.trim())} /></Field>
        <Field label="メモ（任意）"><input data-testid="coordinator-note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ActionButton testid="coordinator-delegate" disabled={!/^[0-9a-f]{64}$/.test(operator)} onClick={async () => { await rt.coordinator.delegate(operator, note || undefined); setOperator(''); setNote(''); bump(); }}>
          署名して委任
        </ActionButton>
      </Section>
    </div>
  );
}
