import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { describe, expect, it } from 'vitest';
import { toHex, utf8 } from '../util/bytes.js';
import { escrowPubkeyFromXpub, KeySet } from './derive.js';
import { generateMnemonic, isValidMnemonic, mnemonicFromEntropy } from './mnemonic.js';
import { orderIndex } from './order.js';
import { keyProofMessage, signKeyProofBtc, signKeyProofEvm, verifyKeyProofBtc, verifyKeyProofEvm, verifyRequestKeyProof } from './proof.js';

const LAB_KEYS = fileURLToPath(new URL('../../../../../proxy-shopping-go/lab/keys/', import.meta.url));

describe('keys', () => {
  it('matches the NIP-06 test vector', () => {
    const k = KeySet.fromMnemonic('leader monkey parrot ring guide accident before fence cannon height naive bean');
    expect(toHex(k.nostrSecretKey)).toBe('7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a');
    expect(k.nostrPublicKey).toBe('17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917');
  });

  it('derives lab mnemonics per lab.md (sha256("ps-lab:"+name)[:16] entropy)', () => {
    expect(mnemonicFromEntropy(sha256(utf8('ps-lab:user-1')).slice(0, 16))).toBe(
      'news hybrid corn purchase public hedgehog clay survey able alter supreme shove',
    );
  });

  it.skipIf(!existsSync(LAB_KEYS + 'public.json'))('matches lab/keys/public.json nostr pubkeys', () => {
    const pub = JSON.parse(readFileSync(LAB_KEYS + 'public.json', 'utf8')) as Record<string, { nostr_pubkey: string }>;
    for (const [name, v] of Object.entries(pub)) {
      const mnemonic = readFileSync(`${LAB_KEYS}${name}.mnemonic`, 'utf8');
      expect(KeySet.fromMnemonic(mnemonic).nostrPublicKey, name).toBe(v.nostr_pubkey);
    }
  });

  it('computes the order idx per §1.1', () => {
    const id = '00112233445566778899aabbccddeeff';
    const h = sha256(Uint8Array.from(Buffer.from(id, 'hex')));
    const expected = Buffer.from(h.slice(0, 4)).readUInt32BE(0) & 0x7fffffff;
    expect(orderIndex(id)).toBe(expected);
    expect(orderIndex(id)).toBeLessThan(2 ** 31);
    expect(() => orderIndex('xyz')).toThrow();
  });

  it('lets a counterparty derive the escrow order key from the tpub', () => {
    const escrow = KeySet.fromMnemonic('blue salt fault plastic fault bargain word lady icon actual speed reflect');
    const xpub = escrow.escrowXpub;
    expect(xpub.startsWith('tpub')).toBe(true);
    const id = 'ffeeddccbbaa99887766554433221100';
    expect(toHex(escrowPubkeyFromXpub(xpub, id))).toBe(toHex(escrow.escrowOrderKey(id).publicKey));
  });

  it('derives wallet, order and EVM keys', () => {
    const k = KeySet.fromMnemonic('news hybrid corn purchase public hedgehog clay survey able alter supreme shove');
    expect(k.btcWallet.address).toMatch(/^tb1q[0-9a-z]{38}$/);
    expect(k.orderKey('00112233445566778899aabbccddeeff').publicKey).toHaveLength(33);
    expect(k.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(toHex(schnorr.getPublicKey(k.nostrSecretKey))).toBe(k.nostrPublicKey);
  });

  it('generates valid mnemonics', () => {
    expect(isValidMnemonic(generateMnemonic())).toBe(true);
    expect(generateMnemonic(24).split(' ')).toHaveLength(24);
    expect(isValidMnemonic('abandon abandon abandon')).toBe(false);
  });

  it('key_proof (§4.4.1) binds the Nostr identity to the BTC order key and the EVM account', async () => {
    const user = KeySet.fromMnemonic('news hybrid corn purchase public hedgehog clay survey able alter supreme shove');
    const mallory = KeySet.fromMnemonic('leader monkey parrot ring guide accident before fence cannon height naive bean');
    const order = '0123456789abcdef0123456789abcdef';
    expect(keyProofMessage(order, user.nostrPublicKey)).toBe(`ps-key-proof-v1|${order}|${user.nostrPublicKey}`);
    const btcPub = toHex(user.orderKey(order).publicKey);
    const btc = signKeyProofBtc(user.orderKey(order).privateKey, order, user.nostrPublicKey);
    expect(btc).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyKeyProofBtc(btc, btcPub, order, user.nostrPublicKey)).toBe(true);
    // Mallory copying the user's key into her own request cannot produce a proof for her identity.
    expect(verifyKeyProofBtc(btc, btcPub, order, mallory.nostrPublicKey)).toBe(false);
    expect(verifyKeyProofBtc(btc, btcPub, 'f'.repeat(32), user.nostrPublicKey)).toBe(false);
    // BIP340 over sha256(m): same check as the raw library call
    expect(schnorr.verify(btc, sha256(utf8(keyProofMessage(order, user.nostrPublicKey))), user.orderKey(order).publicKey.slice(1))).toBe(true);
    const evm = await signKeyProofEvm(user.evmAccount, order, user.nostrPublicKey);
    expect(evm).toMatch(/^[0-9a-f]{130}$/);
    expect(await verifyKeyProofEvm(evm, user.evmAddress, order, user.nostrPublicKey)).toBe(true);
    // Spec hex is lower case without a prefix: other spellings of the same signature are refused (item 18).
    expect(await verifyKeyProofEvm(`0x${evm}`, user.evmAddress, order, user.nostrPublicKey)).toBe(false);
    expect(await verifyKeyProofEvm(evm.toUpperCase(), user.evmAddress, order, user.nostrPublicKey)).toBe(false);
    expect(verifyKeyProofBtc(btc.toUpperCase(), btcPub, order, user.nostrPublicKey)).toBe(false);
    expect(await verifyKeyProofEvm(evm, mallory.evmAddress, order, user.nostrPublicKey)).toBe(false);
    expect(await verifyRequestKeyProof({ payment: 'usdc-evm', user_evm_address: user.evmAddress, key_proof: evm } as never, order, mallory.nostrPublicKey)).toBe(false);
  });
});

