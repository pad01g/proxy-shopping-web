import { IndexedDBStorage } from '@proxy-shopping/core/browser';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  clearOverrides, effectiveConfig, loadBaseConfig, loadOverrides, saveOverrides, type AppConfig,
} from './lib/config';
import {
  forgetIdentity, identityDbName, loadStoredIdentity, saveIdentity, unlockIdentity, type Identity, type StoredIdentity,
} from './lib/identity';
import { createRuntime, type Runtime } from './lib/runtime';
import { acquireTabLock, type TabLock } from './lib/single-tab';

interface AppState {
  loading: boolean;
  baseConfig?: AppConfig;
  config?: AppConfig;
  overrides: Partial<AppConfig>;
  /** What is stored (possibly still locked). */
  stored?: StoredIdentity;
  /** The unlocked identity. */
  identity?: Identity;
  /** Stored but encrypted and not unlocked yet. */
  locked: boolean;
  /** Another tab is running this app. */
  otherTab: boolean;
  runtime?: Runtime;
  error?: string;
  setIdentity(id: Identity, passphrase: string | null): Promise<void>;
  unlock(passphrase: string): Promise<void>;
  logout(opts?: { deleteData?: boolean }): Promise<void>;
  takeOverTab(): void;
  updateSettings(o: Partial<AppConfig>): Promise<void>;
  resetSettings(fields?: Array<keyof AppConfig>): Promise<void>;
}

const Ctx = createContext<AppState | undefined>(undefined);

/** This page's tab lock, shared across re-mounts. */
const tab: { current?: TabLock } = {};

export function AppProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [baseConfig, setBase] = useState<AppConfig>();
  const [overrides, setOverrides] = useState<Partial<AppConfig>>({});
  const [stored, setStored] = useState<StoredIdentity>();
  const [identity, setId] = useState<Identity>();
  const [runtime, setRuntime] = useState<Runtime>();
  const [error, setError] = useState<string>();
  const [otherTab, setOtherTab] = useState(false);
  const [active, setActive] = useState(false);
  const current = useRef<Runtime>();

  const config = useMemo(() => (baseConfig ? effectiveConfig(baseConfig, overrides) : undefined), [baseConfig, overrides]);

  const stopRuntime = useCallback(() => {
    current.current?.stop();
    current.current = undefined;
    setRuntime(undefined);
  }, []);

  const claimTab = useCallback((steal: boolean) => {
    // One lock per page load (StrictMode runs effects twice; a second request would see our own lock).
    if (tab.current && !steal) {
      void tab.current.acquired.then((ok) => {
        setActive(ok);
        setOtherTab(!ok);
      });
      return;
    }
    tab.current?.release();
    tab.current = acquireTabLock({
      steal,
      onLost: () => {
        stopRuntime();
        setActive(false);
        setOtherTab(true);
      },
    });
    void tab.current.acquired.then((ok) => {
      setActive(ok);
      setOtherTab(!ok);
    });
  }, [stopRuntime]);

  useEffect(() => {
    void (async () => {
      setBase(await loadBaseConfig());
      setOverrides(loadOverrides());
      const s = await loadStoredIdentity();
      setStored(s);
      // Plaintext identities (explicit opt-out) open without a passphrase.
      if (s && !s.vault) setId(await unlockIdentity(s).catch(() => undefined));
      setLoading(false);
    })();
    claimTab(false);
  }, [claimTab]);

  // (Re)build the runtime whenever identity or effective config changes — only in the active tab.
  useEffect(() => {
    if (!config || !identity?.backedUp || !active) return;
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
  }, [config, identity, active]);

  const setIdentity = useCallback(async (id: Identity, passphrase: string | null) => {
    await saveIdentity(id, passphrase);
    setStored(await loadStoredIdentity());
    setId({ ...id, encrypted: !!passphrase });
  }, []);

  const unlock = useCallback(async (passphrase: string) => {
    if (!stored) throw new Error('no stored identity');
    setId(await unlockIdentity(stored, passphrase));
  }, [stored]);

  const logout = useCallback(async (opts: { deleteData?: boolean } = {}) => {
    const pubkey = current.current?.pubkey ?? stored?.pubkey;
    stopRuntime();
    await forgetIdentity();
    if (opts.deleteData && pubkey) await IndexedDBStorage.deleteDatabase(identityDbName(pubkey));
    setStored(undefined);
    setId(undefined);
  }, [stored, stopRuntime]);

  const updateSettings = useCallback(async (o: Partial<AppConfig>) => {
    saveOverrides(o);
    setOverrides(o);
  }, []);

  const resetSettings = useCallback(async (fields?: Array<keyof AppConfig>) => {
    if (!fields) {
      clearOverrides();
      setOverrides({});
      return;
    }
    const next = { ...overrides };
    for (const f of fields) delete next[f];
    saveOverrides(next);
    setOverrides(next);
  }, [overrides]);

  const value: AppState = {
    loading, baseConfig, config, overrides, stored, identity, locked: !!stored?.vault && !identity, otherTab, runtime, error,
    setIdentity, unlock, logout, takeOverTab: () => claimTab(true), updateSettings, resetSettings,
  };
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
