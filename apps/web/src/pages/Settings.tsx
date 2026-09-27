import { useEffect, useState } from 'react';
import { ErrorText, Field, Section, StringList } from '../components/ui';
import type { AppConfig, RateSourceConfig } from '../lib/config';
import { useApp } from '../state';

const HEX64 = /^[0-9a-f]{64}$/;

export function SettingsPage() {
  const { config, baseConfig, updateSettings, resetSettings, logout, runtime } = useApp();
  const [draft, setDraft] = useState<AppConfig | undefined>(config);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(config), [config]);
  if (!draft || !baseConfig) return null;

  const set = <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => {
    setSaved(false);
    setDraft({ ...draft, [k]: v });
  };

  const save = async () => {
    const bad = draft.coordinators.find((c) => !HEX64.test(c));
    if (bad) return setError(`coordinator の公開鍵が不正です: ${bad}`);
    setError(undefined);
    // Store only the fields that differ from /config.json.
    const overrides: Partial<AppConfig> = {};
    for (const k of Object.keys(draft) as Array<keyof AppConfig>) {
      if (JSON.stringify(draft[k]) !== JSON.stringify(baseConfig[k])) (overrides as Record<string, unknown>)[k] = draft[k];
    }
    await updateSettings(overrides);
    setSaved(true);
  };

  return (
    <div data-testid="settings">
      <h1>設定</h1>
      <Section title="Nostr リレー（受信箱）">
        <StringList testid="settings-relays" values={draft.relays} placeholder="wss://…" onChange={(v) => set('relays', v)} />
      </Section>
      <Section title="信頼する coordinator（上ほど優先）">
        <p className="muted">外すと、その coordinator が委任した一覧を信頼しなくなります（解任）。</p>
        <StringList testid="settings-coordinators" values={draft.coordinators} placeholder="公開鍵（hex 64 文字）" onChange={(v) => set('coordinators', v)} />
      </Section>
      <Section title="チェーン">
        <div className="grid2">
          <Field label="ネットワーク名">
            <input data-testid="settings-network" value={draft.network} onChange={(e) => set('network', e.target.value)} />
          </Field>
          <Field label="Esplora（BTC）">
            <input data-testid="settings-esplora" value={draft.esplora} onChange={(e) => set('esplora', e.target.value)} />
          </Field>
          <Field label="EVM RPC">
            <input data-testid="settings-evm-rpc" value={draft.evm_rpc} onChange={(e) => set('evm_rpc', e.target.value)} />
          </Field>
          <Field label="chain id">
            <input data-testid="settings-chain-id" type="number" value={draft.chain_id} onChange={(e) => set('chain_id', Number(e.target.value))} />
          </Field>
          <Field label="deployments の URL">
            <input data-testid="settings-deployments-url" value={draft.deployments_url} onChange={(e) => set('deployments_url', e.target.value)} />
          </Field>
          <Field label="蛇口（lab のみ）">
            <input data-testid="settings-faucet-url" value={draft.faucet_url ?? ''} onChange={(e) => set('faucet_url', e.target.value || undefined)} />
          </Field>
        </div>
      </Section>
      <Section title="レートの取得元">
        <RatesEditor value={draft.rates} onChange={(v) => set('rates', v)} />
      </Section>
      <div className="row">
        <button type="button" className="primary" data-testid="settings-save" onClick={() => void save()}>
          保存して再接続
        </button>
        <button type="button" data-testid="settings-reset" onClick={() => void resetSettings()}>
          config.json の値に戻す
        </button>
        {saved && <span className="muted" data-testid="settings-saved">保存しました</span>}
      </div>
      <ErrorText error={error} testid="settings-error" />
      {runtime && (
        <Section title="鍵">
          <p className="muted">この端末から鍵を消します。復元用の単語が無いと資金を失います。</p>
          <button type="button" className="danger" data-testid="settings-logout" onClick={() => confirm('本当に消しますか？') && void logout()}>
            鍵を消す
          </button>
        </Section>
      )}
    </div>
  );
}

function RatesEditor({ value, onChange }: { value: RateSourceConfig[]; onChange: (v: RateSourceConfig[]) => void }) {
  const [type, setType] = useState<RateSourceConfig['type']>('coingecko');
  const [base, setBase] = useState('');
  return (
    <div data-testid="settings-rates">
      <table>
        <tbody>
          {value.map((r, i) => (
            <tr key={i} data-testid="settings-rates-item">
              <td>{r.type}</td>
              <td className="mono">{r.base ?? (r.rates ? JSON.stringify(r.rates) : '')}</td>
              <td>
                <button type="button" className="plain small" data-testid={`settings-rates-remove-${i}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                  削除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <select data-testid="settings-rates-type" value={type} onChange={(e) => setType(e.target.value as RateSourceConfig['type'])}>
          <option value="coingecko">coingecko</option>
          <option value="frankfurter">frankfurter</option>
          <option value="chainlink">chainlink（deployments の feeds）</option>
          <option value="static">static（JSON）</option>
        </select>
        <input data-testid="settings-rates-base" value={base} placeholder={type === 'static' ? '{"BTC/JPY":15000000}' : 'https://…'} onChange={(e) => setBase(e.target.value)} />
        <button
          type="button"
          className="plain"
          data-testid="settings-rates-add"
          onClick={() => {
            if (type === 'static') {
              try {
                onChange([...value, { type, rates: JSON.parse(base) as Record<string, number> }]);
              } catch {
                return;
              }
            } else onChange([...value, { type, base: base || undefined }]);
            setBase('');
          }}
        >
          追加
        </button>
      </div>
    </div>
  );
}
