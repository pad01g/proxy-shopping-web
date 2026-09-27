import 'fake-indexeddb/auto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStorage } from './file.js';
import { IndexedDBStorage } from './indexeddb.js';
import { MemoryStorage } from './memory.js';
import { ScopedStorage, type Storage } from './types.js';

async function exercise(s: Storage) {
  await s.put('a/1', { x: 1 });
  await s.put('a/2', { x: 2 });
  await s.put('b/1', 'other');
  expect(await s.get('a/1')).toEqual({ x: 1 });
  expect(await s.get('missing')).toBeUndefined();
  expect(await s.list('a/')).toEqual([['a/1', { x: 1 }], ['a/2', { x: 2 }]]);
  await s.delete('a/1');
  expect(await s.list('a/')).toEqual([['a/2', { x: 2 }]]);
  const scoped = new ScopedStorage(s, 'b/');
  expect(await scoped.list('')).toEqual([['1', 'other']]);
}

describe('storage backends', () => {
  it('memory', () => exercise(new MemoryStorage()));

  it('memory values are copies', async () => {
    const s = new MemoryStorage();
    const v = { n: 1 };
    await s.put('k', v);
    v.n = 2;
    expect(await s.get('k')).toEqual({ n: 1 });
  });

  it('file (persists across reopen)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ps-'));
    try {
      const path = join(dir, 'sub', 'state.json');
      await exercise(await FileStorage.open(path));
      const again = await FileStorage.open(path);
      expect(await again.get('a/2')).toEqual({ x: 2 });
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('indexeddb', async () => exercise(await IndexedDBStorage.open(`test-${Math.random()}`)));
});
