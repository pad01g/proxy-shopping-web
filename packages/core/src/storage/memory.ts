import type { Storage } from './types.js';

/** In-memory storage. Values are deep-copied so callers can't mutate stored state. */
export class MemoryStorage implements Storage {
  protected data = new Map<string, string>();

  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list<T>(prefix: string): Promise<Array<[string, T]>> {
    return [...this.data.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, JSON.parse(v) as T]);
  }
}
