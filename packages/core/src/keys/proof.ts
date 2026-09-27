import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { recoverMessageAddress, type Hex, type LocalAccount } from 'viem';
import type { OrderRequest } from '../nostr/messages.js';
import { fromHex, toHex, utf8 } from '../util/bytes.js';

/**
 * §4.4.1 key_proof: binds the Nostr identity that signs order.request to the chain key that goes
 * into the multisig, so another identity cannot copy the user's public key and claim the order.
 */
export const keyProofMessage = (orderId: string, userNostrPubkey: string): string =>
  `ps-key-proof-v1|${orderId}|${userNostrPubkey}`;

/** btc-signet: hex(BIP340 Schnorr(SHA-256(m))) with the user's order key (§1 m/7333'/1'/idx'). */
export function signKeyProofBtc(orderPrivateKey: Uint8Array, orderId: string, userNostrPubkey: string): string {
  return toHex(schnorr.sign(sha256(utf8(keyProofMessage(orderId, userNostrPubkey))), orderPrivateKey));
}

/** usdc-evm: hex(EIP-191 personal_sign(m)), 65 bytes, by the EVM account (§1 m/44'/60'/0'/0/0). */
export async function signKeyProofEvm(account: LocalAccount, orderId: string, userNostrPubkey: string): Promise<string> {
  if (!account.signMessage) throw new Error('account cannot sign messages');
  const sig = await account.signMessage({ message: keyProofMessage(orderId, userNostrPubkey) });
  return sig.slice(2);
}

export function verifyKeyProofBtc(proofHex: string, userBtcPubkey33: string, orderId: string, userNostrPubkey: string): boolean {
  try {
    const pub = fromHex(userBtcPubkey33);
    if (pub.length !== 33) return false;
    const sig = fromHex(proofHex);
    if (sig.length !== 64) return false;
    return schnorr.verify(sig, sha256(utf8(keyProofMessage(orderId, userNostrPubkey))), pub.slice(1));
  } catch {
    return false;
  }
}

export async function verifyKeyProofEvm(proofHex: string, evmAddress: string, orderId: string, userNostrPubkey: string): Promise<boolean> {
  try {
    const clean = proofHex.startsWith('0x') ? proofHex.slice(2) : proofHex;
    if (!/^[0-9a-fA-F]{130}$/.test(clean)) return false;
    const signer = await recoverMessageAddress({ message: keyProofMessage(orderId, userNostrPubkey), signature: `0x${clean}` as Hex });
    return signer.toLowerCase() === evmAddress.toLowerCase();
  } catch {
    return false;
  }
}

/** Does `request` (signed by `userNostrPubkey` for `orderId`) carry a valid key_proof for its payment? */
export async function verifyRequestKeyProof(request: OrderRequest, orderId: string, userNostrPubkey: string): Promise<boolean> {
  if (!request.key_proof) return false;
  if (request.payment === 'btc-signet') {
    return !!request.user_btc_pubkey && verifyKeyProofBtc(request.key_proof, request.user_btc_pubkey, orderId, userNostrPubkey);
  }
  return !!request.user_evm_address && verifyKeyProofEvm(request.key_proof, request.user_evm_address, orderId, userNostrPubkey);
}
