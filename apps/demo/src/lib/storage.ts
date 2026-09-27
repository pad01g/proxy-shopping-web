/**
 * Browser storage of the demo. Everything lives under one prefix so "デモを初期化" can wipe it:
 * localStorage keys `ps-demo.*` and one IndexedDB database per role (`ps-demo-<role>`).
 */
import type { SessionRole } from './roles';

export const LS_PREFIX = 'ps-demo.';

export const dbName = (role: SessionRole): string => `ps-demo-${role}`;

export function readJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

export function writeJson(key: string, value: unknown): void {
  localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
}

/** Subscribe to changes of our keys made by other windows (the `storage` event never fires in the writer). */
export function onOtherWindowChange(fn: (key: string) => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === null) fn('*');
    else if (e.key.startsWith(LS_PREFIX)) fn(e.key.slice(LS_PREFIX.length));
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

export function clearLocalStorage(): void {
  for (const key of Object.keys(localStorage)) if (key.startsWith(LS_PREFIX)) localStorage.removeItem(key);
}

/**
 * Delete a database, waiting (up to `ms`) while other windows still hold it open: they are told to close
 * it through the reset broadcast, and the deletion completes once they have.
 */
export function deleteDatabase(name: string, ms = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    const timer = setTimeout(() => reject(new Error(`データベース ${name} を消せません（別のウィンドウが開いたままです）`)), ms);
    req.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    req.onerror = () => {
      clearTimeout(timer);
      reject(req.error ?? new Error(`deleteDatabase ${name} failed`));
    };
    // onblocked: keep waiting; the request completes once the other connections close.
  });
}
