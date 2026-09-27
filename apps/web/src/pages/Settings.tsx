import { decryptWithPassphrase } from '@proxy-shopping/core/browser';
import { useEffect, useState } from 'react';
import { ConfirmDialog, ErrorText, Field, Section, StringList } from '../components/ui';
import { configProblems, ENDPOINT_FIELDS, overriddenFields, type AppConfig, type RateSourceConfig } from '../lib/config';
import { useApp } from '../state';

const HEX64 = /^[0-9a-f]{64}$/;

export function SettingsPage() {
  const { config, baseConfig, overrides, updateSettings, resetSettings } = useApp();
  const [draft, setDraft] = useState<AppConfig | undefined>(config);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(config), [config]);
  if (!draft || !baseConfig) return null;

  const set = <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => {
    setSaved(false);
    setDraft({ ...draft, [k]: v });
  };
  const overridden = overriddenFields(baseConfig, overrides);
  // Endpoints that would differ from config.json after saving: the operator's defaults are replaced.
  const changedEndpoints = ENDPOINT_FIELDS.filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(baseConfig[k]));

  const save = async () => {
    const bad = draft.coordinators.find((c) => !HEX64.test(c));
    if (bad) return setError(`coordinator の公開鍵が不正です: ${bad}`);
    const problems = configProblems(draft, !!baseConfig.allow_private_endpoints);
    if (problems.length) return setError(problems.join('\n'));
    setError(undefined);
    // Store only the fields that differ from /config.json.
    const next: Partial<AppConfig> = {};
    for (const k of Object.keys(draft) as Array<keyof AppConfig>) {
      if (JSON.stringify(draft[k]) !== JSON.stringify(baseConfig[k])) (next as Record<string, unknown>)[k] = draft[k];
    }
    await updateSettings(next);
    setSaved(true);
  };

  return (
    <div data-testid="settings">
      <h1>設定</h1>
      {overridden.length > 0 && (
        <Section title="config.json を上書きしている項目" testid="settings-overrides">
          <p className="muted">ここに挙げた項目は、配布元の config.json が変わっても、この端末の値のままです。</p>
          <ul>
            {overridden.map((k) => (
              <li key={k} data-testid="settings-override-item" data-field={k}>
                <code className="mono">{k}</code>: <span className="mono">{JSON.stringify(overrides[k])}</span>（config.json: <span className="mono">{JSON.stringify(baseConfig[k])}</span>）
                <button type="button" className="plain small" data-testid={`settings-override-reset-${k}`} onClick={() => void resetSettings([k])}>
                  config.json の値に戻す
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
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
          <Field label="BTC 送金手数料の上限（sat/vB）">
            <input data-testid="settings-max-fee-rate" type="number" value={draft.max_fee_rate ?? 50} onChange={(e) => set('max_fee_rate', Number(e.target.value) || undefined)} />
          </Field>
        </div>
      </Section>
      <Section title="レートの取得元">
        <RatesEditor value={draft.rates} onChange={(v) => set('rates', v)} />
      </Section>
      {changedEndpoints.length > 0 && (
        <p className="banner warn" data-testid="settings-endpoint-warning">
          接続先を config.json から変えています（{changedEndpoints.join(', ')}）。信頼できない接続先は、残高や手数料・コントラクトのアドレスを偽ることができます。
        </p>
      )}
      <div className="row">
        <button type="button" className="primary" data-testid="settings-save" onClick={() => void save()}>
          保存して再接続
        </button>
        <button type="button" data-testid="settings-reset" onClick={() => void resetSettings()}>
          すべて config.json の値に戻す
        </button>
        {saved && <span className="muted" data-testid="settings-saved">保存しました</span>}
      </div>
      <ErrorText error={error} testid="settings-error" />
      <KeySection />
    </div>
  );
}

/** Backup and removal of the key; reachable even when the runtime could not start (item 13). */
function KeySection() {
  const { stored, identity, runtime, logout } = useApp();
  const [pass, setPass] = useState('');
  const [words, setWords] = useState<string>();
  const [error, setError] = useState<string>();
  const [deleteData, setDeleteData] = useState(false);
  const [asking, setAsking] = useState(false);
  if (!stored) return null;

  const reveal = async () => {
    setError(undefined);
    try {
      // Always ask again for the passphrase, even when unlocked.
      setWords(stored.vault ? await decryptWithPassphrase(stored.vault, pass) : identity?.mnemonic);
    } catch (e) {
      setError((e as Error).message === 'wrong passphrase' ? 'パスフレーズが違います' : (e as Error).message);
    }
  };

  const exportOrders = async () => {
    if (!runtime) return setError('接続していないので注文を読めません');
    const data = {
      exported_at: new Date().toISOString(),
      pubkey: runtime.pubkey,
      orders: await runtime.user.listOrders(),
      escrow_cases: await runtime.escrow.listCases(),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `proxy-shopping-orders-${runtime.pubkey.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Section title="鍵" testid="settings-key">
      <p className="muted">{stored.vault ? '復元用の単語はパスフレーズで暗号化して保存しています。' : '復元用の単語は暗号化せずに保存しています。'}</p>
      <div className="row">
        {stored.vault && (
          <input type="password" data-testid="settings-mnemonic-passphrase" placeholder="パスフレーズ" value={pass} onChange={(e) => setPass(e.target.value)} />
        )}
        <button type="button" data-testid="settings-show-mnemonic" onClick={() => void reveal()}>復元用の単語を表示</button>
        <button type="button" data-testid="settings-export-orders" disabled={!runtime} onClick={() => void exportOrders()}>注文を JSON で書き出す</button>
      </div>
      {words && (
        <ol className="words" data-testid="settings-mnemonic-words">
          {words.split(' ').map((w, i) => <li key={i}>{w}</li>)}
        </ol>
      )}
      <ErrorText error={error} testid="settings-key-error" />
      <p className="muted">この端末から鍵を消します。復元用の単語が無いと資金を失います。</p>
      <label className="row muted">
        <input type="checkbox" style={{ width: 'auto' }} data-testid="settings-logout-delete-data" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
        この身元の注文・案件のデータも消す
      </label>
      <button type="button" className="danger" data-testid="settings-logout" onClick={() => setAsking(true)}>
        鍵を消す
      </button>
      {asking && (
        <ConfirmDialog
          action="settings-logout"
          spec={{
            title: 'この端末から鍵を消します',
            warning: deleteData
              ? '鍵と、この身元の注文・案件のデータを消します。入金済みの注文がある場合、復元用の単語と書き出した JSON が無いと取り戻せません。'
              : '鍵を消します（注文のデータは残ります）。復元用の単語が無いと資金を失います。',
            okLabel: '消す',
          }}
          onOk={() => {
            setAsking(false);
            void logout({ deleteData }).catch((e) => setError((e as Error).message));
          }}
          onCancel={() => setAsking(false)}
        />
      )}
    </Section>
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
