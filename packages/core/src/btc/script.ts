import { sha256 } from '@noble/hashes/sha2';
import { Address, OutScript, Script, TEST_NETWORK } from '@scure/btc-signer';

export const BTC_NETWORK = TEST_NETWORK; // signet shares testnet's tb / tpub encodings

export interface EscrowKeys {
  user: Uint8Array;
  shopper: Uint8Array;
  escrow: Uint8Array;
}

const LOCKTIME_THRESHOLD = 500_000_000;

/**
 * Spec §5.1 witness script. Keys stay in U, S, E order; T1/T2 are block
 * heights encoded as minimal CScriptNum (btc-signer uses OP_N for 0..16).
 */
export function witnessScript(keys: EscrowKeys, t1: number, t2: number): Uint8Array {
  for (const k of [keys.user, keys.shopper, keys.escrow]) {
    if (k.length !== 33) throw new Error('escrow keys must be 33-byte compressed');
  }
  for (const t of [t1, t2]) {
    if (!Number.isSafeInteger(t) || t <= 0 || t >= LOCKTIME_THRESHOLD) throw new Error(`bad timelock height ${t}`);
  }
  if (!(t1 < t2)) throw new Error('T1 must be < T2');
  return Script.encode([
    'IF',
    2, keys.user, keys.shopper, keys.escrow, 3, 'CHECKMULTISIG',
    'ELSE',
    'IF',
    t1, 'CHECKLOCKTIMEVERIFY', 'DROP', keys.shopper, 'CHECKSIG',
    'ELSE',
    t2, 'CHECKLOCKTIMEVERIFY', 'DROP', keys.user, 'CHECKSIG',
    'ENDIF',
    'ENDIF',
  ]);
}

export function p2wshOutputScript(script: Uint8Array): Uint8Array {
  return OutScript.encode({ type: 'wsh', hash: sha256(script) });
}

export function p2wshAddress(script: Uint8Array, network = BTC_NETWORK): string {
  return Address(network).encode({ type: 'wsh', hash: sha256(script) });
}

export function addressToScript(address: string, network = BTC_NETWORK): Uint8Array {
  return OutScript.encode(Address(network).decode(address));
}

export function scriptToAddress(script: Uint8Array, network = BTC_NETWORK): string | undefined {
  try {
    return Address(network).encode(OutScript.decode(script));
  } catch {
    return undefined;
  }
}
