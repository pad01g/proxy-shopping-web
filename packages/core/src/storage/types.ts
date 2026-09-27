/**
 * Minimal async key/value store. Values must be JSON-serialisable.
 * Keys are '/'-separated paths so `list(prefix)` can scan a namespace.
 */
export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** All entries whose key starts with `prefix`, sorted by key. */
  list<T>(prefix: string): Promise<Array<[string, T]>>;
}

/** View of a storage restricted to a key prefix. */
export class ScopedStorage implements Storage {
  constructor(
    private readonly inner: Storage,
    private readonly prefix: string,
  ) {}

  get<T>(key: string) {
    return this.inner.get<T>(this.prefix + key);
  }
  put<T>(key: string, value: T) {
    return this.inner.put(this.prefix + key, value);
  }
  delete(key: string) {
    return this.inner.delete(this.prefix + key);
  }
  async list<T>(prefix: string) {
    const rows = await this.inner.list<T>(this.prefix + prefix);
    return rows.map(([k, v]) => [k.slice(this.prefix.length), v] as [string, T]);
  }
}
