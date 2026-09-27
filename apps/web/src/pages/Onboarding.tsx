import { generateMnemonic, isValidMnemonic, normalizeMnemonic } from '@proxy-shopping/core/browser';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ErrorText, Section } from '../components/ui';
import { useApp } from '../state';

export function OnboardingPage() {
  const { setIdentity, identity } = useApp();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'choose' | 'generated' | 'import'>(identity && !identity.backedUp ? 'generated' : 'choose');
  const [mnemonic, setMnemonic] = useState(identity?.mnemonic ?? '');
  const [input, setInput] = useState('');
  const [useNip07, setUseNip07] = useState(false);
  const [error, setError] = useState<string>();
  const hasNip07 = typeof window !== 'undefined' && !!window.nostr;

  const finish = async (m: string) => {
    await setIdentity({ mnemonic: m, useNip07, backedUp: true });
    navigate('/', { replace: true });
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
                const m = generateMnemonic(12);
                setMnemonic(m);
                setMode('generated');
                // Persist immediately so a reload does not lose the words before backup.
                void setIdentity({ mnemonic: m, useNip07, backedUp: false });
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
          <button type="button" className="primary" data-testid="onboarding-backup-confirm" onClick={() => void finish(mnemonic)}>
            控えました
          </button>
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
          <div className="row">
            <button
              type="button"
              className="primary"
              data-testid="onboarding-import-submit"
              onClick={() => {
                const m = normalizeMnemonic(input);
                if (!isValidMnemonic(m)) return setError('単語が正しくありません（BIP39 の 12 語または 24 語）');
                void finish(m);
              }}
            >
              復元する
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
