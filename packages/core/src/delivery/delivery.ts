import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import type { IdentitySigner } from '../keys/signer.js';
import type { Address, DeliveryEnvelope } from '../nostr/messages.js';
import { concatBytes, fromBase64, fromHex, fromUtf8, orderIdBytes, randomBytes, toBase64, toHex, utf8 } from '../util/bytes.js';

/** base64(nonce24 || XChaCha20-Poly1305(K, nonce, JSON(address), aad = order_id bytes)) — spec §4.4. */
export function encryptAddress(key: Uint8Array, orderId: string, address: Address, nonce = randomBytes(24)): string {
  const ct = xchacha20poly1305(key, nonce, orderIdBytes(orderId)).encrypt(utf8(JSON.stringify(address)));
  return toBase64(concatBytes(nonce, ct));
}

export function decryptAddress(key: Uint8Array, orderId: string, ciphertext: string): Address {
  const raw = fromBase64(ciphertext);
  if (raw.length < 24 + 16) throw new Error('delivery ciphertext too short');
  const pt = xchacha20poly1305(key, raw.slice(0, 24), orderIdBytes(orderId)).decrypt(raw.slice(24));
  return JSON.parse(fromUtf8(pt)) as Address;
}

/** Build the order.request `delivery` object: fresh K wrapped via NIP-44 to shopper and escrow. */
export async function sealDelivery(p: {
  signer: IdentitySigner;
  orderId: string;
  address: Address;
  shopper: string;
  escrow: string;
  key?: Uint8Array;
}): Promise<{ envelope: DeliveryEnvelope; key: Uint8Array }> {
  const key = p.key ?? randomBytes(32);
  const keyHex = toHex(key);
  return {
    key,
    envelope: {
      ciphertext: encryptAddress(key, p.orderId, p.address),
      key_for_shopper: await p.signer.nip44Encrypt(p.shopper, keyHex),
      key_for_escrow: await p.signer.nip44Encrypt(p.escrow, keyHex),
    },
  };
}

/** Recover K from a NIP-44 wrapped hex key sent by `from` (the user). */
export async function unwrapDeliveryKey(signer: IdentitySigner, from: string, wrapped: string): Promise<Uint8Array> {
  const hexKey = (await signer.nip44Decrypt(from, wrapped)).trim();
  if (!/^[0-9a-f]{64}$/i.test(hexKey)) throw new Error('delivery key is not 32-byte hex');
  return fromHex(hexKey);
}
