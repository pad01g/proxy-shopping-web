import { useState, type ReactNode } from 'react';

export function Section({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return (
    <section className="card" data-testid={testid}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function ErrorText({ error, testid = 'error' }: { error?: string; testid?: string }) {
  return error ? <p className="error" data-testid={testid}>{error}</p> : null;
}

/** A button that runs an async action, shows busy state and captures errors. */
export function ActionButton(props: {
  onClick: () => Promise<unknown>;
  children: ReactNode;
  testid: string;
  disabled?: boolean;
  kind?: 'primary' | 'danger' | 'plain';
  onError?: (msg: string | undefined) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async () => {
    setBusy(true);
    setError(undefined);
    props.onError?.(undefined);
    try {
      await props.onClick();
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      props.onError?.(msg);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="action">
      <button
        type="button"
        className={props.kind ?? 'primary'}
        data-testid={props.testid}
        disabled={props.disabled || busy}
        data-busy={busy ? 'true' : 'false'}
        onClick={() => void run()}
      >
        {busy ? '処理中…' : props.children}
      </button>
      {!props.onError && <ErrorText error={error} testid={`${props.testid}-error`} />}
    </span>
  );
}

export function Mono({ children, testid }: { children: ReactNode; testid?: string }) {
  return <code className="mono" data-testid={testid}>{children}</code>;
}

export function Copyable({ value, testid }: { value: string; testid?: string }) {
  return (
    <span className="copyable">
      <Mono testid={testid}>{value}</Mono>
      <button type="button" className="plain small" onClick={() => void navigator.clipboard?.writeText(value)}>コピー</button>
    </span>
  );
}

/** Editable list of strings (relays, coordinators, regions). */
export function StringList(props: { values: string[]; onChange: (v: string[]) => void; placeholder?: string; testid: string }) {
  const [draft, setDraft] = useState('');
  return (
    <div className="string-list" data-testid={props.testid}>
      <ul>
        {props.values.map((v, i) => (
          <li key={`${v}-${i}`} data-testid={`${props.testid}-item`}>
            <Mono>{v}</Mono>
            <button
              type="button"
              className="plain small"
              data-testid={`${props.testid}-remove-${i}`}
              onClick={() => props.onChange(props.values.filter((_, j) => j !== i))}
            >
              削除
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <input value={draft} placeholder={props.placeholder} data-testid={`${props.testid}-input`} onChange={(e) => setDraft(e.target.value)} />
        <button
          type="button"
          className="plain"
          data-testid={`${props.testid}-add`}
          onClick={() => {
            const v = draft.trim();
            if (v && !props.values.includes(v)) props.onChange([...props.values, v]);
            setDraft('');
          }}
        >
          追加
        </button>
      </div>
    </div>
  );
}
