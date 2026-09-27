import { IndexedDBStorage } from '@proxy-shopping/core/browser';

/**
 * The user's secret material, stored in IndexedDB of this origin.
 * Lab-grade: the mnemonic is not encrypted at rest (see README).
 */
export interface Identity {
  mnemonic: string;
  useNip07: boolean;
  backedUp: boolean;
}

let db: Promise<IndexedDBStorage> | undefined;
const store = () => (db ??= IndexedDBStorage.open('proxy-shopping'));

export async function loadIdentity(): Promise<Identity | undefined> {
  return (await store()).get<Identity>('identity');
}

export async function saveIdentity(id: Identity): Promise<void> {
  await (await store()).put('identity', id);
}

export async function forgetIdentity(): Promise<void> {
  await (await store()).delete('identity');
}
