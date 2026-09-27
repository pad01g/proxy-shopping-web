import type { ResolvedConfig, ShopperNode } from '../lib/config';
import type { Identities } from '../lib/identities';
import type { LabSnap } from '../lib/lab-monitor';
import type { RunState } from '../lib/run';
import type { Snapshots } from '../lib/snapshots';
import type { EvaluatedStep, GuideCtx, GuideState, Scenario } from './types';

export function buildCtx(p: {
  scenario: Scenario;
  run: RunState;
  config: ResolvedConfig;
  ids: Identities;
  shopper: ShopperNode;
  snap: Snapshots;
  lab: LabSnap;
}): GuideCtx {
  const pre = p.scenario.preset;
  // Orders are listed newest first; allow a second of clock rounding around the start.
  const order = pre
    ? p.snap.user?.orders.find((o) => o.sku === pre.sku && o.shopUrl === pre.shopUrl && o.createdAt >= p.run.startedAt - 1)
    : undefined;
  return {
    now: Math.floor(Date.now() / 1000),
    run: p.run,
    config: p.config,
    ids: p.ids,
    shopper: p.shopper,
    snap: p.snap,
    lab: p.lab,
    order,
    escrowCase: order && p.snap.escrow?.cases.find((c) => c.orderId === order.id),
    nodeOrder: order && p.lab.shopper.orders.find((o) => o.id === order.id),
    doneAt: (id) => p.run.done[id],
  };
}

/**
 * Walk the steps in order: a step is done if it was seen done before in this run or is done now; the first
 * one that is not is the current step, and the rest are pending (not looked at, so a later step can never be
 * latched before the steps leading to it).
 */
export function evaluate(scenario: Scenario, ctx: GuideCtx): { guide: GuideState; newlyDone: string[] } {
  const newlyDone: string[] = [];
  const steps: EvaluatedStep[] = [];
  let current: EvaluatedStep | undefined;
  for (const step of scenario.steps) {
    if (current) {
      steps.push({ step, state: 'pending' });
      continue;
    }
    let done = ctx.run.done[step.id] !== undefined;
    if (!done) {
      try {
        done = step.done(ctx);
      } catch (err) {
        console.warn(`step ${step.id}: done() failed`, err);
      }
      if (done) newlyDone.push(step.id);
    }
    if (done) {
      steps.push({ step, state: 'done' });
      continue;
    }
    current = {
      step,
      state: 'current',
      action: typeof step.action === 'function' ? step.action(ctx) : step.action,
      progress: step.progress?.(ctx),
    };
    steps.push(current);
  }
  return { guide: { scenario, steps, current, complete: !current }, newlyDone };
}
