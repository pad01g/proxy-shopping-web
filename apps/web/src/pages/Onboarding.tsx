import { generateMnemonic, isValidMnemonic, normalizeMnemonic } from '@proxy-shopping/core/browser';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ErrorText, Section } from '../components/ui';
import { useApp } from '../state';

const MIN_PASSPHRASE = 8;

export function OnboardingPage() {
  const { setIdentity } = useApp();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'choose' | 'generated' | 'import'>('choose');
  const [mnemonic, setMnemonic] = useState('');
  const [input, setInput] = useState('');
  const [useNip07, setUseNip07] = useState(false);
  const [pass, setPass] = useState({ passphrase: '', confirm: '', plaintext: false });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const hasNip07 = typeof window !== 'undefined' && !!window.nostr;

  const finish = async (m: string) => {
    if (!pass.plaintext) {
      if (pass.passphrase.length < MIN_PASSPHRASE) return setError(`パスフレーズを ${MIN_PASSPHRASE} 文字以上入れるか、暗号化しないことを選んでください`);
      if (pass.passphrase !== pass.confirm) return setError('パスフレーズが一致しません');
    }
    setError(undefined);
    setBusy(true);
    try {
      await setIdentity({ mnemonic: m, useNip07, backedUp: true }, pass.plaintext ? null : pass.passphrase);
      navigate('/', { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="onboarding">
      <h1>はじめに</h1>
      <p className="muted">
        鍵はこのブラウザの中だけで作られ、署名もブラウザで行います。12 語の復元用の単語を必ず控えてください。
      </p>

      {mode === 'choose' && (
        <Section title="鍵を用意する">
          <div className="row">
            <button
              type="button"
              className="primary"
              data-testid="onboarding-generate"
              onClick={() => {
                // Kept in memory only until the backup is confirmed and a passphrase chosen.
                setMnemonic(generateMnemonic(12));
                setMode('generated');
              }}
            >
              新しく作る
            </button>
            <button type="button" data-testid="onboarding-import-toggle" onClick={() => setMode('import')}>
              復元用の単語を入れる
            </button>
          </div>
        </Section>
      )}

      {mode === 'generated' && (
        <Section title="復元用の単語（12 語）" testid="onboarding-backup">
          <ol className="words" data-testid="onboarding-backup-words">
            {mnemonic.split(' ').map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ol>
          <p className="muted">紙に書き写してください。この単語があれば誰でもあなたの資金を動かせます。</p>
          <Nip07Option hasNip07={hasNip07} value={useNip07} onChange={setUseNip07} />
          <PassphraseFields value={pass} onChange={setPass} />
          <button type="button" className="primary" data-testid="onboarding-backup-confirm" disabled={busy} onClick={() => void finish(mnemonic)}>
            控えました
          </button>
          <ErrorText error={error} testid="onboarding-error" />
        </Section>
      )}

      {mode === 'import' && (
        <Section title="復元">
          <textarea
            data-testid="onboarding-mnemonic-input"
            placeholder="12 語または 24 語をスペース区切りで"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <Nip07Option hasNip07={hasNip07} value={useNip07} onChange={setUseNip07} />
          <PassphraseFields value={pass} onChange={setPass} />
          <div className="row">
            <button
              type="button"
              className="primary"
              data-testid="onboarding-import-submit"
              disabled={busy}
              onClick={() => {
                const m = normalizeMnemonic(input);
                if (!isValidMnemonic(m)) return setError('単語が正しくありません（BIP39 の 12 語または 24 語）');
                void finish(m);
              }}
            >
              {busy ? '暗号化中…' : '復元する'}
            </button>
            <button type="button" className="plain" onClick={() => setMode('choose')}>
              戻る
            </button>
          </div>
          <ErrorText error={error} testid="onboarding-error" />
        </Section>
      )}
    </div>
  );
}

type Pass = { passphrase: string; confirm: string; plaintext: boolean };

/** Passphrase for encrypting the mnemonic at rest; plaintext only by explicit opt-out. */
function PassphraseFields({ value, onChange }: { value: Pass; onChange: (v: Pass) => void }) {
  return (
    <div className="grid2">
      <label className="field">
        <span>パスフレーズ（この端末での暗号化用）</span>
        <input type="password" autoComplete="new-password" data-testid="onboarding-passphrase" disabled={value.plaintext}
          value={value.passphrase} onChange={(e) => onChange({ ...value, passphrase: e.target.value })} />
      </label>
      <label className="field">
        <span>もう一度</span>
        <input type="password" autoComplete="new-password" data-testid="onboarding-passphrase-confirm" disabled={value.plaintext}
          value={value.confirm} onChange={(e) => onChange({ ...value, confirm: e.target.value })} />
      </label>
      <label className="row muted">
        <input type="checkbox" style={{ width: 'auto' }} data-testid="onboarding-no-passphrase" checked={value.plaintext}
          onChange={(e) => onChange({ ...value, plaintext: e.target.checked })} />
        暗号化せずに保存する（非推奨: この端末を使える人は誰でも単語を読めます）
      </label>
    </div>
  );
}

function Nip07Option(p: { hasNip07: boolean; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row muted">
      <input
        type="checkbox"
        style={{ width: 'auto' }}
        data-testid="onboarding-nip07"
        disabled={!p.hasNip07}
        checked={p.value}
        onChange={(e) => p.onChange(e.target.checked)}
      />
      身元の署名を NIP-07 拡張に任せる{p.hasNip07 ? '' : '（拡張が見つかりません）'}。BTC / EVM の鍵はこの単語から作ります。
    </label>
  );
}
