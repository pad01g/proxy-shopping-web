import type { Storage } from './types.js';

// Structural subset of the IndexedDB API so core compiles without the DOM lib.
interface IDBRequestLike<T> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}
interface IDBOpenRequestLike extends IDBRequestLike<IDBDatabaseLike> {
  onupgradeneeded: (() => void) | null;
}
interface IDBStoreLike {
  get(key: string): IDBRequestLike<unknown>;
  put(value: unknown, key: string): IDBRequestLike<unknown>;
  delete(key: string): IDBRequestLike<unknown>;
  getAll(range: unknown): IDBRequestLike<unknown[]>;
  getAllKeys(range: unknown): IDBRequestLike<string[]>;
}
interface IDBDatabaseLike {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(store: string, mode: 'readonly' | 'readwrite'): { objectStore(name: string): IDBStoreLike };
}
interface IDBFactoryLike {
  open(name: string, version?: number): IDBOpenRequestLike;
}
interface KeyRangeLike {
  bound(lower: string, upper: string): unknown;
}

const STORE = 'kv';

function req<T>(r: IDBRequestLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Browser storage backed by one IndexedDB object store. */
export class IndexedDBStorage implements Storage {
  private constructor(
    private readonly db: IDBDatabaseLike,
    private readonly keyRange: KeyRangeLike,
  ) {}

  static async open(name = 'proxy-shopping'): Promise<IndexedDBStorage> {
    const g = globalThis as unknown as { indexedDB?: IDBFactoryLike; IDBKeyRange?: KeyRangeLike };
    if (!g.indexedDB || !g.IDBKeyRange) throw new Error('IndexedDB is not available');
    const open = g.indexedDB.open(name, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    return new IndexedDBStorage(await req(open), g.IDBKeyRange);
  }

  private store(mode: 'readonly' | 'readwrite') {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await req(this.store('readonly').get(key))) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    // Round-trip through JSON so stored values are plain data, same as other backends.
    await req(this.store('readwrite').put(JSON.parse(JSON.stringify(value)), key));
  }

  async delete(key: string): Promise<void> {
    await req(this.store('readwrite').delete(key));
  }

  async list<T>(prefix: string): Promise<Array<[string, T]>> {
    const range = this.keyRange.bound(prefix, prefix + '￿');
    const store = this.store('readonly');
    const [keys, values] = await Promise.all([req(store.getAllKeys(range)), req(store.getAll(range))]);
    return keys.map((k, i) => [k, values[i] as T]);
  }
}
