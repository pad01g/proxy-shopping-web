import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { DemoApp, DemoState, Runtimes } from './lib/app';
import type { TabId } from './lib/roles';
import type { Prefill } from './scenarios/types';

const AppCtx = createContext<DemoApp | undefined>(undefined);

/** Where the page is looking: the open tab and the control the guide pointed at. */
interface Focus {
  tab: TabId;
  highlight?: { testid: string; at: number };
  go(tab: TabId, testid?: string): void;
}
const FocusCtx = createContext<Focus | undefined>(undefined);

export function DemoProvider({ app, initialTab, children }: { app: DemoApp; initialTab: TabId; children: ReactNode }) {
  const [tab, setTab] = useState<TabId>(initialTab);
  const [highlight, setHighlight] = useState<Focus['highlight']>();
  const go = useCallback((t: TabId, testid?: string) => {
    setTab(t);
    setHighlight(testid ? { testid, at: Date.now() } : undefined);
  }, []);
  return (
    <AppCtx.Provider value={app}>
      <FocusCtx.Provider value={{ tab, highlight, go }}>{children}</FocusCtx.Provider>
    </AppCtx.Provider>
  );
}

export function useApp(): DemoApp {
  const app = useContext(AppCtx);
  if (!app) throw new Error('useApp outside DemoProvider');
  return app;
}

export function useDemoState(): DemoState {
  const app = useApp();
  return useSyncExternalStore(app.subscribe, app.getState);
}

export function useFocus(): Focus {
  const f = useContext(FocusCtx);
  if (!f) throw new Error('useFocus outside DemoProvider');
  return f;
}

/** A role runtime of this window; panels are only rendered when it runs. */
export function useRuntime<R extends keyof Runtimes>(role: R): NonNullable<Runtimes[R]> {
  const app = useApp();
  useDemoState(); // re-render when the runtime appears
  const rt = app.runtimes[role];
  if (!rt) throw new Error(`${role} is not running in this window`);
  return rt as NonNullable<Runtimes[R]>;
}

/** The prefill of the guide's current step, if its control is `testid`. */
export function usePrefill(testid: string): Prefill | undefined {
  const { guide } = useDemoState();
  const a = guide.current?.action;
  return a?.testid === testid ? a.prefill : undefined;
}

/**
 * Apply a prefill to a form once per guide step (the user may edit afterwards). `apply` runs when the
 * current step starts pointing at `testid`, and again when the prefill's values change.
 */
export function useApplyPrefill(testid: string, apply: (p: Prefill) => void): void {
  const prefill = usePrefill(testid);
  const key = prefill ? JSON.stringify(prefill) : '';
  useEffect(() => {
    if (prefill) apply(prefill);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Load async data, reloading when `subscribe` fires or deps change. */
export function useLive<T>(load: () => Promise<T>, subscribe: (cb: () => void) => () => void, deps: unknown[] = []): [T | undefined, () => void] {
  const [value, setValue] = useState<T>();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => subscribe(refresh), deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let alive = true;
    load().then((v) => alive && setValue(v)).catch((e) => console.warn(e));
    return () => {
      alive = false;
    };
  }, [tick, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, refresh];
}

/** Re-run every `ms` (for data only the network can tell, like balances). */
export const every = (ms: number) => (cb: () => void) => {
  const t = setInterval(cb, ms);
  return () => clearInterval(t);
};
