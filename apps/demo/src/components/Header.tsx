import { setLang, useLang, useT, type Lang } from '../i18n';
import { IS_MOCK, mockSwitchUrl } from '../lib/mode';
import { useScenarios } from '../scenarios';
import { useApp, useDemoState } from '../state';
import { ActionButton } from './ui';

/** Language names in their own language (the switch reads the same in both). */
const LANG_NAMES: Array<[Lang, string]> = [['ja', '日本語'], ['en', 'English']];

export function Header() {
  const app = useApp();
  const m = useT();
  const { run } = useDemoState();
  const scenarios = useScenarios();
  return (
    <header className="top">
      <div className="brand">
        <strong>{m.header.brand}</strong>
        <span className="muted small">
          {app.separateWindows
            ? m.header.windowRoles(app.localRoles.map((r) => m.roles.label[r]).join(m.common.listSep) || m.header.noRoles)
            : m.header.allRoles}
        </span>
      </div>
      <label className="row scenario-picker">
        <span>{m.header.scenario}</span>
        <select data-testid="scenario-select" value={run.scenarioId} onChange={(e) => app.startScenario(e.target.value)}>
          {scenarios.map((s, i) => (
            <option key={s.id} value={s.id}>{i + 1}. {s.title}</option>
          ))}
        </select>
      </label>
      <button type="button" className="plain" data-testid="scenario-restart" onClick={() => app.startScenario(run.scenarioId)}>
        {m.header.restart}
      </button>
      <ActionButton
        testid="demo-reset"
        kind="danger"
        confirm={{ title: m.header.resetTitle, warning: m.header.resetWarning, okLabel: m.header.resetOk }}
        onClick={() => app.reset()}
      >
        {m.header.reset}
      </ActionButton>
      <MockSwitch />
      <LangSwitch />
    </header>
  );
}

/** モック / Mock: reload the page in the other mode (`?mock=1` / `?mock=0`); each mode keeps its own data. */
function MockSwitch() {
  const m = useT();
  return (
    <button
      type="button"
      className={`plain small mock-switch${IS_MOCK ? ' selected' : ''}`}
      data-testid="mock-switch"
      data-mock={IS_MOCK ? 'true' : 'false'}
      aria-pressed={IS_MOCK}
      title={m.mock.switchTitle(IS_MOCK)}
      onClick={() => window.location.assign(mockSwitchUrl(!IS_MOCK))}
    >
      <span aria-hidden>{IS_MOCK ? '☑' : '☐'}</span> {m.mock.switchLabel}
    </button>
  );
}

/** 日本語 / English: `lang-ja`, `lang-en` (data-active); stored in localStorage, `?lang=` overrides it. */
function LangSwitch() {
  const m = useT();
  const lang = useLang();
  return (
    <div className="lang-switch" role="group" aria-label={m.header.language} data-testid="lang-switch" data-lang={lang}>
      {LANG_NAMES.map(([l, name], i) => (
        <span key={l}>
          {i > 0 && <span className="muted" aria-hidden> / </span>}
          <button
            type="button"
            className={`plain small${l === lang ? ' selected' : ''}`}
            lang={l}
            // A language's own name is not UI copy of the other language.
            data-i18n-exempt={l === 'ja' ? 'endonym' : undefined}
            data-testid={`lang-${l}`}
            data-active={l === lang ? 'true' : 'false'}
            aria-pressed={l === lang}
            onClick={() => setLang(l)}
          >
            {name}
          </button>
        </span>
      ))}
    </div>
  );
}
