import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha2';
import type { IdentitySigner } from '../keys/signer.js';
import { obj, str } from '../util/validate.js';
import type { Address, DeliveryEnvelope } from '../nostr/messages.js';
import { concatBytes, fromBase64, fromHex, fromUtf8, orderIdBytes, randomBytes, toBase64, toHex, utf8 } from '../util/bytes.js';

const addressSchema = obj({ name: str(200), postal_code: str(40), address: str(1000), phone: str(60) });

/** base64(nonce24 || XChaCha20-Poly1305(K, nonce, JSON(address), aad = order_id bytes)) — spec §4.4. */
export function encryptAddress(key: Uint8Array, orderId: string, address: Address, nonce = randomBytes(24)): string {
  const ct = xchacha20poly1305(key, nonce, orderIdBytes(orderId)).encrypt(utf8(JSON.stringify(address)));
  return toBase64(concatBytes(nonce, ct));
}

export function decryptAddress(key: Uint8Array, orderId: string, ciphertext: string): Address {
  const raw = fromBase64(ciphertext);
  if (raw.length < 24 + 16) throw new Error('delivery ciphertext too short');
  const pt = xchacha20poly1305(key, raw.slice(0, 24), orderIdBytes(orderId)).decrypt(raw.slice(24));
  return addressSchema(JSON.parse(fromUtf8(pt)), 'address');
}

/** hex(SHA-256(key_for_escrow as a string)) — what order.request commits to (§4.4). */
export const keyForEscrowSha256 = (keyForEscrow: string): string => toHex(sha256(utf8(keyForEscrow)));

/**
 * Build the order.request `delivery` object: fresh K wrapped via NIP-44 to the shopper, and to the
 * escrow as `keyForEscrow`, which is NOT part of the request (only its hash is): the user sends it in
 * order.escrow_key, and it reaches the escrow only in a dispute (§4.4).
 */
export async function sealDelivery(p: {
  signer: IdentitySigner;
  orderId: string;
  address: Address;
  shopper: string;
  escrow: string;
  key?: Uint8Array;
}): Promise<{ envelope: DeliveryEnvelope; key: Uint8Array; keyForEscrow: string }> {
  const key = p.key ?? randomBytes(32);
  const keyHex = toHex(key);
  const keyForEscrow = await p.signer.nip44Encrypt(p.escrow, keyHex);
  return {
    key,
    keyForEscrow,
    envelope: {
      ciphertext: encryptAddress(key, p.orderId, p.address),
      key_for_shopper: await p.signer.nip44Encrypt(p.shopper, keyHex),
      key_for_escrow_sha256: keyForEscrowSha256(keyForEscrow),
    },
  };
}

/** Recover K from a NIP-44 wrapped hex key sent by `from` (the user). */
export async function unwrapDeliveryKey(signer: IdentitySigner, from: string, wrapped: string): Promise<Uint8Array> {
  const hexKey = (await signer.nip44Decrypt(from, wrapped)).trim();
  if (!/^[0-9a-f]{64}$/i.test(hexKey)) throw new Error('delivery key is not 32-byte hex');
  return fromHex(hexKey);
}
