import { useState } from 'react';
import { IdentityCard } from '../../components/IdentityCard';
import { ActionButton, Explain, Field, Mono, Section } from '../../components/ui';
import { short } from '../../lib/format';
import { useApp, useApplyPrefill, useLive, useRuntime } from '../../state';

export function CoordinatorPanel() {
  const app = useApp();
  const rt = useRuntime('coordinator');
  const [list, reload] = useLive(() => rt.delegations(), (cb) => rt.onChange(cb), [rt]);
  const [operator, setOperator] = useState(app.ids.operator.pubkey);
  const [note, setNote] = useState('デモの operator');
  useApplyPrefill('coordinator-delegate', (p) => typeof p.operator === 'string' && setOperator(p.operator));
  const label = (pk: string) => (pk === app.ids.operator.pubkey ? 'このデモの operator' : short(pk));
  return (
    <div data-testid="panel-coordinator">
      <IdentityCard role="coordinator" title="coordinator の鍵" />
      <Section title="委任する（kind 30500）" testid="coordinator-delegate-form">
        <Explain>
          coordinator は信頼の起点です。委任書は「この operator に、この網（{app.config.network}）の一覧を作らせる」という署名付きの宣言で、有効期限は無く、
          版（v）を上げた新しい委任書で失効させます。利用者とノードは、自分が設定した coordinator が委任した operator の一覧だけを使います。
        </Explain>
        <div className="grid2">
          <Field label="operator の公開鍵（hex）"><input data-testid="coordinator-operator" value={operator} onChange={(e) => setOperator(e.target.value.trim())} /></Field>
          <Field label="メモ（任意）"><input data-testid="coordinator-note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        <ActionButton
          testid="coordinator-delegate"
          disabled={!/^[0-9a-f]{64}$/.test(operator)}
          onClick={async () => {
            await rt.delegate(operator, note || undefined);
            reload();
          }}
        >
          署名して委任する
        </ActionButton>
      </Section>
      <Section title="委任書の一覧" testid="coordinator-delegations">
        {!list?.length && <p className="muted">まだ委任していません。</p>}
        <table>
          <thead><tr><th>operator</th><th>版</th><th>状態</th><th>メモ</th><th /></tr></thead>
          <tbody>
            {list?.map((d) => (
              <tr key={d.operator} data-testid="coordinator-delegation" data-operator={d.operator} data-revoked={d.revoked ? 'true' : 'false'}>
                <td><Mono title={d.operator}>{label(d.operator)}</Mono></td>
                <td>v{d.version}</td>
                <td>{d.revoked ? '失効' : '有効'}</td>
                <td>{d.note}</td>
                <td>
                  {d.revoked ? (
                    <ActionButton testid={`coordinator-restore-${d.operator.slice(0, 8)}`} kind="plain" onClick={async () => { await rt.delegate(d.operator, d.note); reload(); }}>再委任</ActionButton>
                  ) : (
                    <ActionButton testid={`coordinator-revoke-${d.operator.slice(0, 8)}`} kind="plain" onClick={async () => { await rt.revoke(d.operator, d.note); reload(); }}>失効させる</ActionButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">「デモを初期化」すると operator の鍵が作り直されるので、前の operator の委任書もここに残ります（失効させても構いません）。</p>
      </Section>
    </div>
  );
}
