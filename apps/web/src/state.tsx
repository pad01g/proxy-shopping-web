import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  clearOverrides, effectiveConfig, loadBaseConfig, loadOverrides, saveOverrides, type AppConfig,
} from './lib/config';
import { forgetIdentity, loadIdentity, saveIdentity, type Identity } from './lib/identity';
import { createRuntime, type Runtime } from './lib/runtime';

interface AppState {
  loading: boolean;
  baseConfig?: AppConfig;
  config?: AppConfig;
  identity?: Identity;
  runtime?: Runtime;
  error?: string;
  setIdentity(id: Identity): Promise<void>;
  logout(): Promise<void>;
  updateSettings(o: Partial<AppConfig>): Promise<void>;
  resetSettings(): Promise<void>;
}

const Ctx = createContext<AppState | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [baseConfig, setBase] = useState<AppConfig>();
  const [overrides, setOverrides] = useState<Partial<AppConfig>>({});
  const [identity, setId] = useState<Identity>();
  const [runtime, setRuntime] = useState<Runtime>();
  const [error, setError] = useState<string>();
  const current = useRef<Runtime>();

  const config = useMemo(() => (baseConfig ? effectiveConfig(baseConfig, overrides) : undefined), [baseConfig, overrides]);

  useEffect(() => {
    void (async () => {
      setBase(await loadBaseConfig());
      setOverrides(loadOverrides());
      setId(await loadIdentity());
      setLoading(false);
    })();
  }, []);

  // (Re)build the runtime whenever identity or effective config changes.
  useEffect(() => {
    if (!config || !identity) return;
    let cancelled = false;
    setError(undefined);
    createRuntime(config, identity)
      .then((rt) => {
        if (cancelled) return rt.stop();
        current.current?.stop();
        current.current = rt;
        setRuntime(rt);
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [config, identity]);

  const setIdentity = useCallback(async (id: Identity) => {
    await saveIdentity(id);
    setId(id);
  }, []);

  const logout = useCallback(async () => {
    current.current?.stop();
    current.current = undefined;
    setRuntime(undefined);
    await forgetIdentity();
    setId(undefined);
  }, []);

  const updateSettings = useCallback(async (o: Partial<AppConfig>) => {
    saveOverrides(o);
    setOverrides(o);
  }, []);

  const resetSettings = useCallback(async () => {
    clearOverrides();
    setOverrides({});
  }, []);

  const value: AppState = { loading, baseConfig, config, identity, runtime, error, setIdentity, logout, updateSettings, resetSettings };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

export function useRuntime(): Runtime {
  const { runtime } = useApp();
  if (!runtime) throw new Error('runtime not ready');
  return runtime;
}

/** Re-render on emitter events and re-run `load` (e.g. orders list). */
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
