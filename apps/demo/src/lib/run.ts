/**
 * The scenario being followed, shared by all windows of this browser (localStorage). Steps once seen done stay
 * done for the run ("latched"), so a later change (the wallet balance going down after funding, the operator
 * removing the escrow in the fraud scenario) does not send the guide back to an earlier step.
 */
import { onOtherWindowChange, readJson, writeJson } from './storage';

export interface RunState {
  /** Changes on every start of a scenario. */
  id: string;
  scenarioId: string;
  /** UNIX seconds; the scenario's order is the newest matching one created since. */
  startedAt: number;
  /** Step id → when it was first seen done (ms). */
  done: Record<string, number>;
}

const KEY = 'run';

export function newRun(scenarioId: string): RunState {
  return { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, scenarioId, startedAt: Math.floor(Date.now() / 1000), done: {} };
}

export function loadRun(defaultScenario: string): RunState {
  const r = readJson<RunState>(KEY);
  if (r?.id && r.scenarioId && typeof r.startedAt === 'number' && r.done) return r;
  const fresh = newRun(defaultScenario);
  writeJson(KEY, fresh);
  return fresh;
}

export function saveRun(r: RunState): void {
  writeJson(KEY, r);
}

/** Record steps as done; merges with what other windows wrote for the same run. */
export function latch(r: RunState, stepIds: string[]): RunState {
  const stored = readJson<RunState>(KEY);
  const base = stored?.id === r.id ? { ...r, done: { ...r.done, ...stored.done } } : r;
  const now = Date.now();
  const next = { ...base, done: { ...base.done } };
  for (const id of stepIds) next.done[id] ??= now;
  writeJson(KEY, next);
  return next;
}

export function onRunChange(fn: () => void): () => void {
  return onOtherWindowChange((k) => (k === '*' || k === KEY) && fn());
}

export function readStoredRun(): RunState | undefined {
  return readJson<RunState>(KEY);
}
