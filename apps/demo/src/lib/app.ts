import { deploymentsSchema, type Deployments } from '@proxy-shopping/core/browser';
import { msg, onLangChange } from '../i18n';
import { WorldClient } from '../mock/client';
import { MOCK_DEPLOYMENTS, mockConfig } from '../mock/config';
import { DEFAULT_SCENARIO, scenarioById } from '../scenarios';
import { buildCtx, evaluate } from '../scenarios/evaluate';
import type { GuideState } from '../scenarios/types';
import { labBackend, mockBackend, type Backend } from './backend';
import { loadConfig, type ResolvedConfig, type ShopperNode } from './config';
import { KeyRing, type Identities } from './identities';
import { LabMonitor, type LabSnap } from './lab-monitor';
import { IS_MOCK } from './mode';
import { acquireRoleLock, type RoleLock } from './role-lock';
import { rolesFromQuery, SESSION_ROLES, type SessionRole } from './roles';
import { latch, loadRun, newRun, onRunChange, readStoredRun, saveRun, type RunState } from './run';
import { CoordinatorRuntime } from './runtimes/coordinator';
import { EscrowRuntime } from './runtimes/escrow';
import { OperatorRuntime } from './runtimes/operator';
import { UserRuntime } from './runtimes/user';
import type { RuntimeDeps } from './runtimes/base';
import { onSnapshotChange, readSnapshots, type Snapshots } from './snapshots';
import { clearLocalStorage, dbName, deleteDatabase, onOtherWindowChange, writeJson } from './storage';

export interface Runtimes {
  user?: UserRuntime;
  escrow?: EscrowRuntime;
  operator?: OperatorRuntime;
  coordinator?: CoordinatorRuntime;
}

/** Why a role of this window is not running. */
export type RoleProblem = { kind: 'elsewhere' } | { kind: 'error'; message: string };

/** Everything the page renders; replaced (never mutated) on every change. */
export interface DemoState {
  snapshots: Snapshots;
  lab: LabSnap;
  run: RunState;
  guide: GuideState;
  /** Session roles running in this window. */
  running: SessionRole[];
  problems: Partial<Record<SessionRole, RoleProblem>>;
  /** Another window started "reset demo". */
  resetting: boolean;
  /** The user's order the scenario follows, once there is one. */
  scenarioOrderId?: string;
}

const RESET_KEY = 'reset';

/**
 * The demo page's controller, outside React: starts this window's role runtimes, polls the lab, reads the
 * other windows' snapshots and evaluates the guide. React subscribes with useSyncExternalStore.
 */
export class DemoApp {
  readonly runtimes: Runtimes = {};
  /** The Go shopper node the scenarios use (shopper-1). */
  readonly shopper: ShopperNode;
  readonly lab: LabMonitor;
  private readonly locks = new Map<SessionRole, RoleLock>();
  private readonly listeners = new Set<() => void>();
  private stateValue: DemoState;
  private snapshots: Snapshots = readSnapshots();
  private run: RunState;
  private problems: DemoState['problems'] = {};
  private resetting = false;
  private recomputeQueued = false;

  private constructor(
    readonly config: ResolvedConfig,
    readonly deployments: Deployments | undefined,
    /** Why the deployments could not be read (the page words it in its language). */
    readonly deploymentsError: string | undefined,
    readonly keyRing: KeyRing,
    readonly ids: Identities,
    /** Roles this window was asked to run (?role=…). */
    readonly localRoles: SessionRole[],
    readonly separateWindows: boolean,
    /** The lab's services, or the in-browser mock world (lib/backend.ts). */
    readonly backend: Backend,
  ) {
    this.shopper = config.shoppers[0];
    this.lab = new LabMonitor(backend, this.shopper);
    this.run = loadRun(DEFAULT_SCENARIO);
    this.stateValue = this.compute();
  }

  static async create(): Promise<DemoApp> {
    let config: ResolvedConfig;
    let deployments: Deployments | undefined;
    let deploymentsError: string | undefined;
    let backend: Backend;
    if (IS_MOCK) {
      // Everything runs in this browser: no demo server, no network (src/mock).
      config = mockConfig();
      deployments = MOCK_DEPLOYMENTS;
      const world = WorldClient.connect();
      backend = mockBackend(world);
      // Wait for the world to come up (the first window builds the chains, the EVM deploys the contracts).
      await world.call('faucet.height');
    } else {
      config = await loadConfig();
      try {
        const res = await fetch(config.urls.deployments, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        deployments = deploymentsSchema(await res.json(), 'deployments');
      } catch (err) {
        deploymentsError = (err as Error).message;
      }
      backend = labBackend(config);
    }
    if (!config.shoppers.length) throw new Error(msg().app.noShoppers);
    const keyRing = new KeyRing(config.coordinator_mnemonic);
    let { roles, separate } = rolesFromQuery(window.location.search);
    // Without a SharedWorker each window would have a world of its own: run every role here instead.
    const separateUnavailable = separate && backend.mock && !backend.sharedAcrossWindows;
    if (separateUnavailable) ({ roles, separate } = rolesFromQuery(''));
    const app = new DemoApp(config, deployments, deploymentsError, keyRing, keyRing.identities(), roles, separate, backend);
    app.separateUnavailable = separateUnavailable;
    await app.start();
    return app;
  }

  /** ?role=… was asked for in mock mode, but this browser cannot share the world between windows. */
  separateUnavailable = false;

  get mock(): boolean {
    return this.backend.mock;
  }

  // ---------- React bridge ----------

  get state(): DemoState {
    return this.stateValue;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): DemoState => this.stateValue;

  // ---------- lifecycle ----------

  private async start(): Promise<void> {
    // The guide's texts (scenario steps, progress) are in the page's language.
    onLangChange(() => this.queue());
    onSnapshotChange(() => {
      this.snapshots = readSnapshots();
      this.queue();
    });
    onRunChange(() => {
      const r = readStoredRun();
      if (r) this.run = r;
      this.queue();
    });
    onOtherWindowChange((k) => {
      if (k === RESET_KEY && !this.resetting) void this.onResetElsewhere();
    });
    this.lab.onChange(() => this.queue());
    this.lab.start();
    // Snapshot writes from other windows arrive as storage events; poll as well in case one is missed.
    setInterval(() => {
      this.snapshots = readSnapshots();
      this.queue();
    }, 3000);
    await Promise.all(this.localRoles.map((r) => this.startRole(r)));
    this.queue();
  }

  private deps(role: SessionRole): RuntimeDeps {
    return { config: this.config, keys: this.keyRing.keys(role), deployments: this.deployments, coordinator: this.ids.coordinator.pubkey, backend: this.backend };
  }

  /** Start one role unless another window of this browser runs it (steal = take it over). */
  async startRole(role: SessionRole, steal = false): Promise<void> {
    if (this.runtimes[role]) return;
    const lock = await acquireRoleLock(role, { steal, onLost: () => this.stopRole(role, { kind: 'elsewhere' }) });
    if (!lock.held) {
      this.problems = { ...this.problems, [role]: { kind: 'elsewhere' } };
      this.queue();
      return;
    }
    this.locks.set(role, lock);
    try {
      const rt = await this.createRuntime(role);
      rt.onChange(() => {
        this.snapshots = readSnapshots();
        this.queue();
      });
      await rt.start();
      (this.runtimes as Record<SessionRole, unknown>)[role] = rt;
      const { [role]: _gone, ...rest } = this.problems;
      this.problems = rest;
    } catch (err) {
      lock.release();
      this.locks.delete(role);
      this.problems = { ...this.problems, [role]: { kind: 'error', message: (err as Error).message } };
    }
    this.queue();
  }

  private createRuntime(role: SessionRole) {
    const d = this.deps(role);
    switch (role) {
      case 'user': return UserRuntime.create(d);
      case 'escrow': return EscrowRuntime.create(d);
      case 'operator': return OperatorRuntime.create(d);
      case 'coordinator': return CoordinatorRuntime.create(d);
    }
  }

  private stopRole(role: SessionRole, problem?: RoleProblem): void {
    this.runtimes[role]?.stop();
    delete this.runtimes[role];
    this.locks.get(role)?.release();
    this.locks.delete(role);
    if (problem) this.problems = { ...this.problems, [role]: problem };
    this.queue();
  }

  private stopAll(): void {
    for (const r of SESSION_ROLES) this.stopRole(r);
    this.lab.stop();
  }

  // ---------- scenario ----------

  /** Select a scenario, or start the current one over: a new run with nothing done. */
  startScenario(id: string): void {
    this.run = newRun(scenarioById(id).id);
    saveRun(this.run);
    this.queue();
  }

  // ---------- reset ----------

  /** Wipe every key and all demo data of this browser (all windows; in mock mode the world too), then reload. */
  async reset(): Promise<void> {
    this.resetting = true;
    this.queue();
    // Tell the other windows first, so they close their databases.
    writeJson(RESET_KEY, Date.now());
    this.stopAll();
    await new Promise((r) => setTimeout(r, 800));
    await this.backend.reset();
    for (const role of SESSION_ROLES) await deleteDatabase(dbName(role));
    clearLocalStorage();
    window.location.reload();
  }

  private async onResetElsewhere(): Promise<void> {
    this.resetting = true;
    this.stopAll();
    this.queue();
    await new Promise((r) => setTimeout(r, 2500));
    window.location.reload();
  }

  // ---------- state ----------

  /** Recompute soon (coalesces bursts of snapshot writes and lab polls). */
  queue(): void {
    if (this.recomputeQueued) return;
    this.recomputeQueued = true;
    queueMicrotask(() => {
      this.recomputeQueued = false;
      this.stateValue = this.compute();
      for (const fn of this.listeners) fn();
    });
  }

  private compute(): DemoState {
    const scenario = scenarioById(this.run.scenarioId);
    const ctx = buildCtx({ scenario, run: this.run, config: this.config, ids: this.ids, shopper: this.shopper, snap: this.snapshots, lab: this.lab.current });
    const { guide, newlyDone } = evaluate(scenario, ctx);
    if (newlyDone.length && !this.resetting) {
      this.run = latch(this.run, newlyDone);
      // Steps after the newly done ones may be done too; look again with the latches in place.
      this.queue();
    }
    return {
      snapshots: this.snapshots,
      lab: this.lab.current,
      run: this.run,
      guide,
      running: SESSION_ROLES.filter((r) => !!this.runtimes[r]),
      problems: this.problems,
      resetting: this.resetting,
      scenarioOrderId: ctx.order?.id,
    };
  }
}
