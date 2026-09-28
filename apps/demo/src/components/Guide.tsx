import { useT } from '../i18n';
import { isSessionRole, type Actor, type TabId } from '../lib/roles';
import type { EvaluatedStep } from '../scenarios/types';
import { useApp, useDemoState, useFocus } from '../state';

export function RoleBadge({ actor }: { actor: Actor }) {
  const m = useT();
  return <span className={`role-badge role-${actor}`}>{m.roles.label[actor]}</span>;
}

/**
 * The scenario's steps: which role does what next, and why. Test ids (apps/demo/TESTIDS.md): `guide`
 * (data-scenario, data-complete), `guide-step-<id>` (data-state), `guide-current` (data-step, data-role,
 * data-action, data-tab, data-confirm) and its button `guide-go`.
 */
export function Guide() {
  const m = useT();
  const { guide, run } = useDemoState();
  return (
    <aside className="guide" data-testid="guide" data-scenario={guide.scenario.id} data-run={run.id} data-complete={guide.complete ? 'true' : 'false'}>
      <h2>{guide.scenario.title}</h2>
      <p className="muted">{guide.scenario.description}</p>
      <ol className="steps">
        {guide.steps.map((s) => (
          <li key={s.step.id} className={`step ${s.state}`} data-testid={`guide-step-${s.step.id}`} data-state={s.state}>
            <div className="step-head">
              <span className="mark" aria-hidden>{m.guide.mark[s.state]}</span>
              <RoleBadge actor={s.step.actor} />
              <span className="step-title">{s.step.title}</span>
            </div>
            {s.state === 'current' && <CurrentStep s={s} />}
          </li>
        ))}
      </ol>
      {guide.complete && (
        <p className="banner ok" data-testid="guide-complete">
          {m.guide.complete}
        </p>
      )}
    </aside>
  );
}

function CurrentStep({ s }: { s: EvaluatedStep }) {
  const app = useApp();
  const m = useT();
  const { running } = useDemoState();
  const role = (r: Actor) => m.roles.label[r];
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
          {m.guide.go(role(tab!))}
        </button>
      )}
      {a && !here && (
        <p className="banner warn" data-testid="guide-elsewhere">
          {m.guide.elsewhere(role(tab!), app.localRoles.map(role).join(m.common.listSep) || m.guide.anyRole)}
        </p>
      )}
      {!a && <p className="muted" data-testid="guide-waiting">{m.guide.waiting}</p>}
    </div>
  );
}
