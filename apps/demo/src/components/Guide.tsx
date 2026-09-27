import { isSessionRole, ROLE_LABEL, type Actor, type TabId } from '../lib/roles';
import type { EvaluatedStep } from '../scenarios/types';
import { useApp, useDemoState, useFocus } from '../state';

export function RoleBadge({ actor }: { actor: Actor }) {
  return <span className={`role-badge role-${actor}`}>{ROLE_LABEL[actor]}</span>;
}

const MARK: Record<EvaluatedStep['state'], string> = { done: '✓', current: '▶', pending: '・' };

/**
 * The scenario's steps: which role does what next, and why. Test ids (apps/demo/TESTIDS.md): `guide`
 * (data-scenario, data-complete), `guide-step-<id>` (data-state), `guide-current` (data-step, data-role,
 * data-action, data-tab, data-confirm) and its button `guide-go`.
 */
export function Guide() {
  const { guide, run } = useDemoState();
  return (
    <aside className="guide" data-testid="guide" data-scenario={guide.scenario.id} data-run={run.id} data-complete={guide.complete ? 'true' : 'false'}>
      <h2>{guide.scenario.title}</h2>
      <p className="muted">{guide.scenario.description}</p>
      <ol className="steps">
        {guide.steps.map((s) => (
          <li key={s.step.id} className={`step ${s.state}`} data-testid={`guide-step-${s.step.id}`} data-state={s.state}>
            <div className="step-head">
              <span className="mark" aria-hidden>{MARK[s.state]}</span>
              <RoleBadge actor={s.step.actor} />
              <span className="step-title">{s.step.title}</span>
            </div>
            {s.state === 'current' && <CurrentStep s={s} />}
          </li>
        ))}
      </ol>
      {guide.complete && (
        <p className="banner ok" data-testid="guide-complete">
          このシナリオは最後まで進みました。上の「シナリオ」から別のシナリオを選ぶか、「最初から」でもう一度たどれます。
        </p>
      )}
    </aside>
  );
}

function CurrentStep({ s }: { s: EvaluatedStep }) {
  const app = useApp();
  const { running } = useDemoState();
  const { go } = useFocus();
  const a = s.action;
  const tab: TabId | undefined = a ? a.tab ?? (s.step.actor === 'chain' ? undefined : s.step.actor) : undefined;
  // Session roles run in one window each; the shopper and lab tabs are in every window.
  const here = !!tab && (!isSessionRole(tab) || running.includes(tab));
  return (
    <div
      className="current"
      data-testid="guide-current"
      data-step={s.step.id}
      data-role={s.step.actor}
      data-action={a?.testid ?? ''}
      data-tab={tab ?? ''}
      data-confirm={a?.confirm ? 'true' : 'false'}
    >
      <p>{s.step.text}</p>
      {s.progress && <p className="progress" data-testid="guide-progress">{s.progress}</p>}
      {a && here && (
        <button type="button" className="primary" data-testid="guide-go" onClick={() => go(tab!, a.testid)}>
          この操作へ（{ROLE_LABEL[tab!]}）
        </button>
      )}
      {a && !here && (
        <p className="banner warn" data-testid="guide-elsewhere">
          別のウィンドウで {ROLE_LABEL[tab!]} が操作します（このウィンドウでは {app.localRoles.map((r) => ROLE_LABEL[r]).join('・') || 'どの役割も'} だけが動いています）。
        </p>
      )}
      {!a && <p className="muted" data-testid="guide-waiting">待っています…（自動で進みます）</p>}
    </div>
  );
}
