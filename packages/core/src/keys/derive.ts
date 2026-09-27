import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { p2wpkh, TEST_NETWORK } from '@scure/btc-signer';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { toHex } from '../util/bytes.js';
import { normalizeMnemonic, isValidMnemonic } from './mnemonic.js';
import { orderIndex } from './order.js';
import { MAINNET_VERSIONS, PATHS, TESTNET_VERSIONS } from './paths.js';

export interface BtcKey {
  privateKey: Uint8Array;
  /** 33-byte compressed public key. */
  publicKey: Uint8Array;
}

export interface BtcWallet extends BtcKey {
  address: string;
  /** scriptPubKey of the P2WPKH output. */
  script: Uint8Array;
}

function privOf(key: HDKey, path: string): Uint8Array {
  const child = key.derive(path);
  if (!child.privateKey) throw new Error(`no private key at ${path}`);
  return child.privateKey;
}

/**
 * All keys of one participant, derived from a BIP39 mnemonic (no passphrase)
 * according to spec §1.
 */
export class KeySet {
  readonly root: HDKey;

  private constructor(root: HDKey) {
    this.root = root;
  }

  static fromMnemonic(mnemonic: string): KeySet {
    const m = normalizeMnemonic(mnemonic);
    if (!isValidMnemonic(m)) throw new Error('invalid mnemonic');
    return new KeySet(HDKey.fromMasterSeed(mnemonicToSeedSync(m), TESTNET_VERSIONS));
  }

  /** NIP-06 identity secret key. */
  get nostrSecretKey(): Uint8Array {
    return privOf(this.root, PATHS.nostr);
  }

  /** x-only hex public key of the identity. */
  get nostrPublicKey(): string {
    return toHex(schnorr.getPublicKey(this.nostrSecretKey));
  }

  /** secp256k1 key used by Go nodes for libp2p (exposed for completeness). */
  get libp2pSecretKey(): Uint8Array {
    return privOf(this.root, PATHS.libp2p);
  }

  /** User / shopper per-order key m/7333'/1'/idx'. */
  orderKey(orderId: string): BtcKey {
    return this.btcKeyAt(PATHS.orderKey(orderIndex(orderId)));
  }

  /** Escrow per-order key m/7333'/2'/idx (non-hardened). */
  escrowOrderKey(orderId: string): BtcKey {
    return this.btcKeyAt(PATHS.escrowOrderKey(orderIndex(orderId)));
  }

  /** tpub of m/7333'/2', published in the escrow profile. */
  get escrowXpub(): string {
    return this.root.derive(PATHS.escrowAccount).publicExtendedKey;
  }

  get btcWallet(): BtcWallet {
    const key = this.btcKeyAt(PATHS.btcWallet);
    const pay = p2wpkh(key.publicKey, TEST_NETWORK);
    return { ...key, address: pay.address!, script: pay.script };
  }

  get evmPrivateKey(): `0x${string}` {
    return `0x${toHex(privOf(this.root, PATHS.evm))}`;
  }

  get evmAccount(): PrivateKeyAccount {
    return privateKeyToAccount(this.evmPrivateKey);
  }

  get evmAddress(): `0x${string}` {
    return this.evmAccount.address;
  }

  private btcKeyAt(path: string): BtcKey {
    const privateKey = privOf(this.root, path);
    return { privateKey, publicKey: secp256k1.getPublicKey(privateKey, true) };
  }
}

/** Parse a tpub (or xpub) and derive the escrow's per-order public key (§1, non-hardened child). */
export function escrowPubkeyFromXpub(xpub: string, orderId: string): Uint8Array {
  const versions = xpub.startsWith('xpub') ? MAINNET_VERSIONS : TESTNET_VERSIONS;
  const node = HDKey.fromExtendedKey(xpub, versions).deriveChild(orderIndex(orderId));
  if (!node.publicKey) throw new Error('xpub derivation failed');
  return node.publicKey;
}
