import { useEffect, type ReactNode } from 'react';
import { Guide } from './components/Guide';
import { Header } from './components/Header';
import { ActionButton, ErrorBoundary } from './components/ui';
import { useT } from './i18n';
import { isSessionRole, TABS, type SessionRole, type TabId } from './lib/roles';
import { CoordinatorPanel } from './panels/coordinator/CoordinatorPanel';
import { EscrowPanel } from './panels/escrow/EscrowPanel';
import { LabPanel } from './panels/lab/LabPanel';
import { OperatorPanel } from './panels/operator/OperatorPanel';
import { ShopperPanel } from './panels/shopper/ShopperPanel';
import { UserPanel } from './panels/user/UserPanel';
import { useApp, useDemoState, useFocus } from './state';

const PANELS: Record<TabId, () => ReactNode> = {
  user: () => <UserPanel />,
  shopper: () => <ShopperPanel />,
  escrow: () => <EscrowPanel />,
  operator: () => <OperatorPanel />,
  coordinator: () => <CoordinatorPanel />,
  lab: () => <LabPanel />,
};

export function App() {
  const app = useApp();
  const m = useT();
  const { resetting, guide } = useDemoState();
  const { tab, go } = useFocus();
  // Session roles of other windows have no tab here; the shopper node and the lab are in every window.
  const tabs = TABS.filter((t) => !isSessionRole(t) || app.localRoles.includes(t));
  const next = guide.current?.action ? guide.current.action.tab ?? guide.current.step.actor : undefined;
  useHighlight();

  return (
    <div className="layout">
      <Header />
      {resetting && <p className="banner warn center" data-testid="resetting">{m.app.resetting}</p>}
      {app.deploymentsError && (
        <p className="banner error" data-testid="deployments-error">{m.app.deploymentsError(app.config.deployments, app.deploymentsError)}</p>
      )}
      <div className="columns">
        <Guide />
        <main>
          <nav className="tabs" role="tablist">
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={t === tab}
                className={`tab${t === tab ? ' active' : ''}`}
                data-testid={`tab-${t}`}
                data-active={t === tab ? 'true' : 'false'}
                onClick={() => go(t)}
              >
                {m.roles.label[t]}
                {t === next && <span className="next-dot" title={m.app.nextTab}>●</span>}
              </button>
            ))}
          </nav>
          <p className="role-about" data-testid="role-about">{m.roles.about[tab]}</p>
          <ErrorBoundary key={tab} name={tab}>
            {isSessionRole(tab) ? <RoleGate role={tab}>{PANELS[tab]()}</RoleGate> : PANELS[tab]()}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

/** A session role's panel, once its runtime runs in this window. */
function RoleGate({ role, children }: { role: SessionRole; children: ReactNode }) {
  const app = useApp();
  const m = useT();
  const { running, problems } = useDemoState();
  const name = m.roles.label[role];
  if (running.includes(role)) return <>{children}</>;
  const p = problems[role];
  if (p?.kind === 'elsewhere') {
    return (
      <div className="banner warn" data-testid={`role-elsewhere-${role}`}>
        {m.app.roleElsewhere(name)}
        <div className="row">
          <ActionButton testid={`role-takeover-${role}`} kind="plain" onClick={() => app.startRole(role, true)}>{m.app.takeover}</ActionButton>
        </div>
      </div>
    );
  }
  if (p?.kind === 'error') return <p className="banner error" data-testid={`role-error-${role}`}>{m.app.roleError(name, p.message)}</p>;
  return <p className="muted" data-testid={`role-starting-${role}`}>{m.app.roleStarting(name)}</p>;
}

/** After the guide's "go to this action": scroll the control into view and flash it (it may render a moment later). */
function useHighlight() {
  const { highlight } = useFocus();
  useEffect(() => {
    if (!highlight) return;
    let tries = 0;
    let cleanup: (() => void) | undefined;
    const timer = setInterval(() => {
      const el = document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(highlight.testid)}"]`);
      if (!el && ++tries < 40) return;
      clearInterval(timer);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('guide-highlight');
      const t = setTimeout(() => el.classList.remove('guide-highlight'), 2500);
      cleanup = () => {
        clearTimeout(t);
        el.classList.remove('guide-highlight');
      };
    }, 100);
    return () => {
      clearInterval(timer);
      cleanup?.();
    };
  }, [highlight]);
}
