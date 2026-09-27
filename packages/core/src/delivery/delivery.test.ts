import { generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { LocalSigner } from '../keys/signer.js';
import { decryptAddress, encryptAddress, sealDelivery, unwrapDeliveryKey } from './delivery.js';

const ORDER = '0123456789abcdef0123456789abcdef';
const ADDRESS = { name: '山田太郎', postal_code: '160-0022', address: '東京都新宿区新宿1-1-1', phone: '03-0000-0000' };

describe('delivery (§4.4)', () => {
  it('round-trips and binds the order id as AAD', () => {
    const key = new Uint8Array(32).fill(7);
    const ct = encryptAddress(key, ORDER, ADDRESS);
    expect(decryptAddress(key, ORDER, ct)).toEqual(ADDRESS);
    expect(() => decryptAddress(key, 'ffffffffffffffffffffffffffffffff', ct)).toThrow();
    expect(() => decryptAddress(new Uint8Array(32), ORDER, ct)).toThrow();
  });

  it('wraps K for shopper and escrow', async () => {
    const user = new LocalSigner(generateSecretKey());
    const shopper = new LocalSigner(generateSecretKey());
    const escrow = new LocalSigner(generateSecretKey());
    const { envelope } = await sealDelivery({ signer: user, orderId: ORDER, address: ADDRESS, shopper: shopper.pubkey, escrow: escrow.pubkey });
    for (const [who, wrapped] of [[shopper, envelope.key_for_shopper], [escrow, envelope.key_for_escrow]] as const) {
      const k = await unwrapDeliveryKey(who, user.pubkey, wrapped);
      expect(decryptAddress(k, ORDER, envelope.ciphertext)).toEqual(ADDRESS);
    }
    await expect(unwrapDeliveryKey(escrow, user.pubkey, envelope.key_for_shopper)).rejects.toThrow();
  });
});
