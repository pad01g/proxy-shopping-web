import 'fake-indexeddb/auto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStorage } from './file.js';
import { IndexedDBStorage } from './indexeddb.js';
import { MemoryStorage } from './memory.js';
import { decryptWithPassphrase, encryptWithPassphrase } from './vault.js';
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

  it('indexeddb databases can be closed and deleted (logout)', async () => {
    const name = `test-${Math.random()}`;
    const s = await IndexedDBStorage.open(name);
    await s.put('user/orders/x', { id: 'x' });
    s.close();
    await IndexedDBStorage.deleteDatabase(name);
    expect(await (await IndexedDBStorage.open(name)).get('user/orders/x')).toBeUndefined();
  });
});

describe('vault (mnemonic at rest)', () => {
  const words = 'news hybrid corn purchase public hedgehog clay survey able alter supreme shove';

  it('encrypts with PBKDF2-SHA256 (600k) + AES-GCM and needs the passphrase back', async () => {
    const secret = await encryptWithPassphrase(words, 'correct horse');
    expect(secret).toMatchObject({ v: 1, kdf: 'PBKDF2-SHA256', iterations: 600_000 });
    expect(JSON.stringify(secret)).not.toContain('hedgehog');
    expect(await decryptWithPassphrase(secret, 'correct horse')).toBe(words);
    await expect(decryptWithPassphrase(secret, 'wrong')).rejects.toThrow(/wrong passphrase/);
    // tampering is detected by the GCM tag
    const ct = Buffer.from(secret.ct, 'base64');
    ct[0] ^= 1;
    await expect(decryptWithPassphrase({ ...secret, ct: ct.toString('base64') }, 'correct horse')).rejects.toThrow();
  });

  it('uses a fresh salt and iv each time', async () => {
    const [a, b] = await Promise.all([encryptWithPassphrase('x', 'p', 1000), encryptWithPassphrase('x', 'p', 1000)]);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    await expect(encryptWithPassphrase('x', '')).rejects.toThrow();
  });
});
