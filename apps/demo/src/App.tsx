import { useEffect, type ReactNode } from 'react';
import { Guide } from './components/Guide';
import { Header } from './components/Header';
import { ActionButton, ErrorBoundary } from './components/ui';
import { isSessionRole, ROLE_ABOUT, ROLE_LABEL, TABS, type SessionRole, type TabId } from './lib/roles';
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
  const { resetting, guide } = useDemoState();
  const { tab, go } = useFocus();
  // Session roles of other windows have no tab here; the shopper node and the lab are in every window.
  const tabs = TABS.filter((t) => !isSessionRole(t) || app.localRoles.includes(t));
  const next = guide.current?.action ? guide.current.action.tab ?? guide.current.step.actor : undefined;
  useHighlight();

  return (
    <div className="layout">
      <Header />
      {resetting && <p className="banner warn center" data-testid="resetting">デモを初期化しています…（終わると再読み込みします）</p>}
      {app.deploymentsError && <p className="banner error" data-testid="deployments-error">{app.deploymentsError}（USDC の注文はできません）</p>}
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
                {ROLE_LABEL[t]}
                {t === next && <span className="next-dot" title="ガイドの次の操作はこのタブです">●</span>}
              </button>
            ))}
          </nav>
          <p className="role-about" data-testid="role-about">{ROLE_ABOUT[tab]}</p>
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
  const { running, problems } = useDemoState();
  if (running.includes(role)) return <>{children}</>;
  const p = problems[role];
  if (p?.kind === 'elsewhere') {
    return (
      <div className="banner warn" data-testid={`role-elsewhere-${role}`}>
        {ROLE_LABEL[role]} は、このブラウザの別のウィンドウ（タブ）で動いています。同じ役割を 2 か所で動かすと、同じメッセージに二重に応えてしまうので、ここでは動かしません。
        <div className="row">
          <ActionButton testid={`role-takeover-${role}`} kind="plain" onClick={() => app.startRole(role, true)}>このウィンドウで動かす</ActionButton>
        </div>
      </div>
    );
  }
  if (p?.kind === 'error') return <p className="banner error" data-testid={`role-error-${role}`}>{ROLE_LABEL[role]} を起動できませんでした: {p.message}</p>;
  return <p className="muted" data-testid={`role-starting-${role}`}>{ROLE_LABEL[role]} を起動しています…</p>;
}

/** After "この操作へ": scroll the control into view and flash it (it may render a moment later). */
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
