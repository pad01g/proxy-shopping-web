import { Component, useState, type ErrorInfo, type ReactNode } from 'react';

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

/** What a confirmation dialog shows before a fund-moving action (item 6). */
export interface ConfirmSpec {
  title: string;
  /** Human-readable amount, e.g. "29,667 sats". */
  amount?: string;
  /** Who receives the funds (address). */
  recipient?: string;
  /** Extra lines (fees, other recipients). */
  details?: ReactNode;
  /** Strong warning, e.g. releasing before delivery. */
  warning?: string;
  okLabel?: string;
}

/**
 * In-page modal (not window.confirm, so Playwright can drive it). Test ids:
 * confirm-dialog (data-action = the button's testid), confirm-amount, confirm-recipient,
 * confirm-warning, confirm-ok, confirm-cancel.
 */
export function ConfirmDialog(p: { spec: ConfirmSpec; action: string; onOk: () => void; onCancel: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="confirm-title" data-testid="confirm-dialog" data-action={p.action}>
        <h2 id="confirm-title">{p.spec.title}</h2>
        {p.spec.amount && <p>額: <strong data-testid="confirm-amount">{p.spec.amount}</strong></p>}
        {p.spec.recipient && <p>宛先: <code className="mono" data-testid="confirm-recipient">{p.spec.recipient}</code></p>}
        {p.spec.details}
        {p.spec.warning && <p className="banner strong" data-testid="confirm-warning">{p.spec.warning}</p>}
        <div className="row">
          <button type="button" className={p.spec.warning ? 'danger' : 'primary'} data-testid="confirm-ok" onClick={p.onOk}>
            {p.spec.okLabel ?? '実行する'}
          </button>
          <button type="button" data-testid="confirm-cancel" onClick={p.onCancel}>やめる</button>
        </div>
      </div>
    </div>
  );
}

/**
 * A button that runs an async action, shows busy state and captures errors. With `confirm`, the
 * action runs only after the confirmation dialog's OK.
 */
export function ActionButton(props: {
  onClick: () => Promise<unknown>;
  children: ReactNode;
  testid: string;
  disabled?: boolean;
  kind?: 'primary' | 'danger' | 'plain';
  onError?: (msg: string | undefined) => void;
  confirm?: ConfirmSpec | (() => Promise<ConfirmSpec>);
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState<ConfirmSpec>();
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
  const click = async () => {
    if (!props.confirm) return run();
    try {
      setAsking(typeof props.confirm === 'function' ? await props.confirm() : props.confirm);
    } catch (e) {
      setError((e as Error).message);
      props.onError?.((e as Error).message);
    }
  };
  return (
    <span className="action">
      <button
        type="button"
        className={props.kind ?? 'primary'}
        data-testid={props.testid}
        disabled={props.disabled || busy || !!asking}
        data-busy={busy ? 'true' : 'false'}
        onClick={() => void click()}
      >
        {busy ? '処理中…' : props.children}
      </button>
      {!props.onError && <ErrorText error={error} testid={`${props.testid}-error`} />}
      {asking && (
        <ConfirmDialog
          spec={asking}
          action={props.testid}
          onOk={() => {
            setAsking(undefined);
            void run();
          }}
          onCancel={() => setAsking(undefined)}
        />
      )}
    </span>
  );
}

/**
 * Keeps one panel's crash (e.g. an unexpected field in a peer's message) from blanking the page.
 * Fallback: `panel-error` with data-panel = name.
 */
export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`panel ${this.props.name} failed`, error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <section className="card banner error" data-testid="panel-error" data-panel={this.props.name}>
          この欄を表示できませんでした（{this.props.name}）: {this.state.error.message}
        </section>
      );
    }
    return this.props.children;
  }
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
