import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { short } from './lib/format';
import { CoordinatorPage } from './pages/Coordinator';
import { EscrowCasePage } from './pages/EscrowCase';
import { EscrowCasesPage } from './pages/EscrowCases';
import { HomePage } from './pages/Home';
import { NewOrderPage } from './pages/NewOrder';
import { OnboardingPage } from './pages/Onboarding';
import { OperatorPage } from './pages/Operator';
import { OrderDetailPage } from './pages/OrderDetail';
import { OrdersPage } from './pages/Orders';
import { SettingsPage } from './pages/Settings';
import { ShopperPage } from './pages/Shopper';
import { WalletPage } from './pages/Wallet';
import { useApp } from './state';

const NAV = [
  ['/', 'ホーム', 'nav-home'],
  ['/user/new', '注文する', 'nav-new-order'],
  ['/user/orders', '注文一覧', 'nav-orders'],
  ['/wallet', '財布', 'nav-wallet'],
  ['/escrow', 'エスクロー', 'nav-escrow'],
  ['/operator', 'オペレータ', 'nav-operator'],
  ['/coordinator', 'コーディネータ', 'nav-coordinator'],
  ['/shopper', 'ショッパー', 'nav-shopper'],
  ['/settings', '設定', 'nav-settings'],
] as const;

export function App() {
  const { loading, identity, runtime, error } = useApp();
  const location = useLocation();

  if (loading) return <p className="center" data-testid="app-loading">読み込み中…</p>;
  if (!identity || !identity.backedUp) {
    if (location.pathname !== '/onboarding') return <Navigate to="/onboarding" replace />;
    return (
      <Shell>
        <OnboardingPage />
      </Shell>
    );
  }
  if (!runtime) {
    return (
      <Shell>
        {error ? (
          <p className="error" data-testid="runtime-error">起動できませんでした: {error}</p>
        ) : (
          <p className="center" data-testid="runtime-starting">接続中…</p>
        )}
        <SettingsPage />
      </Shell>
    );
  }
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/user/new" element={<NewOrderPage />} />
        <Route path="/user/orders" element={<OrdersPage />} />
        <Route path="/user/orders/:id" element={<OrderDetailPage />} />
        <Route path="/wallet" element={<WalletPage />} />
        <Route path="/escrow" element={<EscrowCasesPage />} />
        <Route path="/escrow/cases/:id" element={<EscrowCasePage />} />
        <Route path="/operator" element={<OperatorPage />} />
        <Route path="/coordinator" element={<CoordinatorPage />} />
        <Route path="/shopper" element={<ShopperPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { runtime, identity } = useApp();
  return (
    <div className="layout">
      <header>
        <strong className="brand">proxy-shopping</strong>
        {runtime && identity?.backedUp && (
          <nav>
            {NAV.map(([to, label, testid]) => (
              <NavLink key={to} to={to} end={to === '/'} data-testid={testid}>
                {label}
              </NavLink>
            ))}
          </nav>
        )}
        {runtime && (
          <span className="whoami" data-testid="whoami" data-pubkey={runtime.pubkey}>
            {short(runtime.pubkey)}
          </span>
        )}
      </header>
      <main>{children}</main>
    </div>
  );
}
