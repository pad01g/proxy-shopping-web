import { generateMnemonic, isValidMnemonic, KeySet } from '@proxy-shopping/core/browser';
import { msg } from '../i18n';
import type { SessionRole } from './roles';
import { readJson, writeJson } from './storage';

/** Public facts about a role's keys, derivable in every window. */
export interface RoleIdentity {
  role: SessionRole;
  pubkey: string;
  btcAddress: string;
  evmAddress: string;
}

export type Identities = Record<SessionRole, RoleIdentity>;

/**
 * Keys of the demo roles. The coordinator is the lab's fixed demo key (every lab node trusts it); user,
 * escrow and operator get a fresh BIP39 mnemonic on first load, kept in localStorage so the other windows
 * of this browser see the same identities. Lab only: the mnemonics are stored in plain text.
 */
export class KeyRing {
  private readonly cache = new Map<SessionRole, KeySet>();

  constructor(private readonly coordinatorMnemonic: string) {
    if (!isValidMnemonic(coordinatorMnemonic)) throw new Error(msg().app.badMnemonic);
  }

  keys(role: SessionRole): KeySet {
    let k = this.cache.get(role);
    if (!k) {
      k = KeySet.fromMnemonic(this.mnemonic(role));
      this.cache.set(role, k);
    }
    return k;
  }

  identities(): Identities {
    const id = (role: SessionRole): RoleIdentity => {
      const k = this.keys(role);
      return { role, pubkey: k.nostrPublicKey, btcAddress: k.btcWallet.address, evmAddress: k.evmAddress };
    };
    return { user: id('user'), escrow: id('escrow'), operator: id('operator'), coordinator: id('coordinator') };
  }

  private mnemonic(role: SessionRole): string {
    if (role === 'coordinator') return this.coordinatorMnemonic;
    const key = `mnemonic.${role}`;
    const stored = readJson<string>(key);
    if (stored && isValidMnemonic(stored)) return stored;
    writeJson(key, generateMnemonic());
    // Another window may have written first; whoever wrote last wins, and every window reads that one.
    return readJson<string>(key)!;
  }
}
