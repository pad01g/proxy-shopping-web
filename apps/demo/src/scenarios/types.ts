import type { Payment } from '@proxy-shopping/core/browser';
import type { ResolvedConfig, ShopperNode } from '../lib/config';
import type { Identities } from '../lib/identities';
import type { NodeOrderSummary } from '../lib/lab-api';
import type { LabSnap } from '../lib/lab-monitor';
import type { Actor, TabId } from '../lib/roles';
import type { RunState } from '../lib/run';
import type { CaseSnap, OrderSnap, Snapshots } from '../lib/snapshots';

/** A shop, item and region to order; the new-order form is prefilled with the scenario's. */
export interface OrderPreset {
  id: string;
  label: string;
  shopUrl: string;
  region: string;
  sku: string;
  payment: Payment;
}

/** Values a step hands to its control's form (read with usePrefill). */
export type Prefill = Record<string, string | number | boolean>;

export interface StepAction {
  /** data-testid of the control to press. */
  testid: string;
  /** Tab that holds the control (default: the step's actor). */
  tab?: TabId;
  /** The control opens a confirmation dialog (confirm-ok) before it acts. */
  confirm?: boolean;
  prefill?: Prefill;
}

/** Everything a step may look at: the snapshots of all roles, the lab and the scenario's own order. */
export interface GuideCtx {
  now: number;
  run: RunState;
  config: ResolvedConfig;
  ids: Identities;
  shopper: ShopperNode;
  snap: Snapshots;
  lab: LabSnap;
  /** The scenario's order: the user's newest order of the preset's SKU created since the run started. */
  order?: OrderSnap;
  /** The escrow's case of that order. */
  escrowCase?: CaseSnap;
  /** The shopper node's view of that order. */
  nodeOrder?: NodeOrderSummary;
  /** When a step of this run was first seen done (ms). */
  doneAt(stepId: string): number | undefined;
}

export interface Step {
  id: string;
  actor: Actor;
  /** Short name of the step. */
  title: string;
  /** What happens and why, for a newcomer. */
  text: string;
  /** The control to press; none for steps where the network, the shopper node or the chain acts. */
  action?: StepAction | ((ctx: GuideCtx) => StepAction | undefined);
  done(ctx: GuideCtx): boolean;
  /** Live progress for waiting steps ("shopper ノードの状態: purchasing"). */
  progress?(ctx: GuideCtx): string | undefined;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  preset?: OrderPreset;
  steps: Step[];
}

export type StepState = 'done' | 'current' | 'pending';

export interface EvaluatedStep {
  step: Step;
  state: StepState;
  action?: StepAction;
  progress?: string;
}

export interface GuideState {
  scenario: Scenario;
  steps: EvaluatedStep[];
  current?: EvaluatedStep;
  complete: boolean;
}
