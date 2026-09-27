import { ROLE_LABEL } from '../lib/roles';
import { SCENARIOS } from '../scenarios';
import { useApp, useDemoState } from '../state';
import { ActionButton } from './ui';

export function Header() {
  const app = useApp();
  const { run } = useDemoState();
  return (
    <header className="top">
      <div className="brand">
        <strong>proxy-shopping デモ</strong>
        <span className="muted small">
          {app.separateWindows
            ? `このウィンドウの役割: ${app.localRoles.map((r) => ROLE_LABEL[r]).join('・') || 'なし'}`
            : 'すべての役割をこの画面で動かしています'}
        </span>
      </div>
      <label className="row scenario-picker">
        <span>シナリオ</span>
        <select data-testid="scenario-select" value={run.scenarioId} onChange={(e) => app.startScenario(e.target.value)}>
          {SCENARIOS.map((s, i) => (
            <option key={s.id} value={s.id}>{i + 1}. {s.title}</option>
          ))}
        </select>
      </label>
      <button type="button" className="plain" data-testid="scenario-restart" onClick={() => app.startScenario(run.scenarioId)}>
        最初から
      </button>
      <ActionButton
        testid="demo-reset"
        kind="danger"
        confirm={{
          title: 'デモを初期化します',
          warning: '利用者・escrow・operator の鍵と、すべての役割の注文・案件・一覧の記録をこのブラウザから消します（開いている他のウィンドウも再読み込みします）。lab のチェーンやノードの記録は消えません。',
          okLabel: '初期化する',
        }}
        onClick={() => app.reset()}
      >
        デモを初期化
      </ActionButton>
    </header>
  );
}
