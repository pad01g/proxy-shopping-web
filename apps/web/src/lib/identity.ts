import {
  decryptWithPassphrase, encryptWithPassphrase, IndexedDBStorage, KeySet, type EncryptedSecret,
} from '@proxy-shopping/core/browser';

/** The unlocked identity, held in memory only. */
export interface Identity {
  mnemonic: string;
  useNip07: boolean;
  backedUp: boolean;
  /** true when the stored copy is encrypted with a passphrase. */
  encrypted?: boolean;
}

/**
 * What IndexedDB holds. The mnemonic is encrypted (PBKDF2-SHA256 600k + AES-GCM) unless the user
 * explicitly chose plaintext at onboarding (`mnemonic` set, `vault` absent).
 */
export interface StoredIdentity {
  useNip07: boolean;
  backedUp: boolean;
  vault?: EncryptedSecret;
  mnemonic?: string;
  /** Nostr pubkey of the mnemonic (not secret). With NIP-07 the identity (and its database) is the extension's key. */
  pubkey?: string;
  /** The per-identity database last opened for this identity, so logout deletes the right one while locked. */
  dbName?: string;
}

let db: Promise<IndexedDBStorage> | undefined;
const store = () => (db ??= IndexedDBStorage.open('proxy-shopping'));

export async function loadStoredIdentity(): Promise<StoredIdentity | undefined> {
  return (await store()).get<StoredIdentity>('identity');
}

/** Unlock a stored identity; plaintext ones need no passphrase. Throws 'wrong passphrase'. */
export async function unlockIdentity(s: StoredIdentity, passphrase?: string): Promise<Identity> {
  if (!s.vault) {
    if (!s.mnemonic) throw new Error('no mnemonic stored');
    return { mnemonic: s.mnemonic, useNip07: s.useNip07, backedUp: s.backedUp, encrypted: false };
  }
  if (!passphrase) throw new Error('passphrase required');
  return { mnemonic: await decryptWithPassphrase(s.vault, passphrase), useNip07: s.useNip07, backedUp: s.backedUp, encrypted: true };
}

/** Persist `id`, encrypted with `passphrase` — or in plaintext when passphrase is null (explicit opt-out). */
export async function saveIdentity(id: Identity, passphrase: string | null): Promise<void> {
  const pubkey = KeySet.fromMnemonic(id.mnemonic).nostrPublicKey;
  const stored: StoredIdentity = passphrase
    ? { useNip07: id.useNip07, backedUp: id.backedUp, vault: await encryptWithPassphrase(id.mnemonic, passphrase), pubkey }
    : { useNip07: id.useNip07, backedUp: id.backedUp, mnemonic: id.mnemonic, pubkey };
  await (await store()).put('identity', stored);
}

export async function forgetIdentity(): Promise<void> {
  await (await store()).delete('identity');
}

/** One database per identity so importing another mnemonic never mixes orders. */
export const identityDbName = (pubkey: string): string => `proxy-shopping-${pubkey.slice(0, 16)}`;

/** Remember which database the running identity uses (with NIP-07 it is not derivable from the mnemonic). */
export async function rememberDbName(dbName: string): Promise<StoredIdentity | undefined> {
  const s = await loadStoredIdentity();
  if (!s || s.dbName === dbName) return s;
  const next = { ...s, dbName };
  await (await store()).put('identity', next);
  return next;
}

/**
 * The database to delete on logout: the running one, else the one remembered, else — for a NIP-07 identity —
 * the extension's key (never the mnemonic's, which names another identity's database).
 */
export async function logoutDbName(
  s: StoredIdentity | undefined,
  running: string | undefined,
  nip07?: { getPublicKey(): Promise<string> },
): Promise<string | undefined> {
  if (running) return running;
  if (s?.dbName) return s.dbName;
  if (s?.useNip07) {
    const pk = await nip07?.getPublicKey().catch(() => undefined);
    return pk ? identityDbName(pk) : undefined;
  }
  return s?.pubkey ? identityDbName(s.pubkey) : undefined;
}
