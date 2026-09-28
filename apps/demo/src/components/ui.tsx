import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { msg, useT } from '../i18n';

export function Section({ title, children, testid, note }: { title: string; children: ReactNode; testid?: string; note?: ReactNode }) {
  return (
    <section className="card" data-testid={testid}>
      <h2>{title}</h2>
      {note && <p className="note">{note}</p>}
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

export function Mono({ children, testid, title }: { children: ReactNode; testid?: string; title?: string }) {
  return <code className="mono" data-testid={testid} title={title}>{children}</code>;
}

export function Copyable({ value, testid, display }: { value: string; testid?: string; display?: string }) {
  const m = useT();
  return (
    <span className="copyable">
      <Mono testid={testid} title={value}>{display ?? value}</Mono>
      <button type="button" className="plain small" onClick={() => void navigator.clipboard?.writeText(value)}>{m.common.copy}</button>
    </span>
  );
}

/** What a confirmation dialog shows before a fund-moving action. */
export interface ConfirmSpec {
  title: string;
  /** Human-readable amount, e.g. "29,667 sats". */
  amount?: string;
  /** Who receives the funds (address). */
  recipient?: string;
  details?: ReactNode;
  /** Strong warning (e.g. a rate deviation). */
  warning?: string;
  okLabel?: string;
}

/**
 * In-page modal (not window.confirm, so the e2e can drive it). Test ids: confirm-dialog (data-action = the
 * button's testid), confirm-amount, confirm-recipient, confirm-warning, confirm-ok, confirm-cancel.
 */
export function ConfirmDialog(p: { spec: ConfirmSpec; action: string; onOk: () => void; onCancel: () => void }) {
  const m = useT();
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="confirm-title" data-testid="confirm-dialog" data-action={p.action}>
        <h2 id="confirm-title">{p.spec.title}</h2>
        {p.spec.amount && <p>{m.common.amount}<strong data-testid="confirm-amount">{p.spec.amount}</strong></p>}
        {p.spec.recipient && <p>{m.common.recipient}<code className="mono" data-testid="confirm-recipient">{p.spec.recipient}</code></p>}
        {p.spec.details}
        {p.spec.warning && <p className="banner strong" data-testid="confirm-warning">{p.spec.warning}</p>}
        <div className="row">
          <button type="button" className={p.spec.warning ? 'danger' : 'primary'} data-testid="confirm-ok" onClick={p.onOk}>
            {p.spec.okLabel ?? m.common.ok}
          </button>
          <button type="button" data-testid="confirm-cancel" onClick={p.onCancel}>{m.common.cancel}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * A button that runs an async action, shows its busy state and error. With `confirm`, the action runs only
 * after the dialog's OK. Errors appear as `<testid>-error`.
 */
export function ActionButton(props: {
  onClick: () => Promise<unknown>;
  children: ReactNode;
  testid: string;
  disabled?: boolean;
  kind?: 'primary' | 'danger' | 'plain';
  confirm?: ConfirmSpec | (() => Promise<ConfirmSpec>);
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState<ConfirmSpec>();
  const m = useT();
  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await props.onClick();
    } catch (e) {
      setError((e as Error).message);
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
        {busy ? m.common.busy : props.children}
      </button>
      <ErrorText error={error} testid={`${props.testid}-error`} />
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

/** Keeps one panel's crash from blanking the page. Fallback: `panel-error` with data-panel = name. */
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
          {msg().app.panelError(this.props.name, this.state.error.message)}
        </section>
      );
    }
    return this.props.children;
  }
}

/** A short explanation of what a panel is for (the "why" for newcomers). */
export function Explain({ children }: { children: ReactNode }) {
  return <p className="explain">{children}</p>;
}
