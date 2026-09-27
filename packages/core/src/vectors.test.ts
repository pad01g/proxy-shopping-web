/**
 * Cross-implementation vectors written by the Go node
 * (proxy-shopping-go/docs/test-vectors.json). Skipped when the file is absent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as nip44 from 'nostr-tools/nip44';
import { describe, expect, it } from 'vitest';
import { p2wshAddress, witnessScript } from './btc/script.js';
import { decryptAddress, encryptAddress, unwrapDeliveryKey } from './delivery/delivery.js';
import { predictSafeAddress, safeInitializer, safeSaltNonce } from './evm/safe.js';
import { packSignatures, releaseSafeTx, safeTxFromJson, safeTxHash, safeTxTransfers, signSafeTx, splitSafeTx } from './evm/safetx.js';
import { SAFE_PROXY_CREATION_CODE } from './evm/proxy-creation-code.js';
import { escrowPubkeyFromXpub, KeySet } from './keys/derive.js';
import { orderIndex } from './keys/order.js';
import { LocalSigner } from './keys/signer.js';
import { unwrap } from './nostr/giftwrap.js';
import { fromHex, toHex } from './util/bytes.js';

const FILE = fileURLToPath(new URL('../../../../proxy-shopping-go/docs/test-vectors.json', import.meta.url));
const present = existsSync(FILE);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = present ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const keyOf = (name: string) => KeySet.fromMnemonic(V.keys[name].mnemonic);

describe.skipIf(!present)('Go test vectors', () => {
  it('keys (§1)', () => {
    for (const [name, k] of Object.entries<Record<string, string>>(V.keys)) {
      const ks = KeySet.fromMnemonic(k.mnemonic);
      expect(ks.nostrPublicKey, name).toBe(k.nostr_pubkey);
      expect(ks.evmAddress, name).toBe(k.evm_address);
      expect(ks.btcWallet.address, name).toBe(k.btc_address);
      expect(ks.escrowXpub, name).toBe(k.btc_escrow_xpub);
    }
  });

  it('order idx and order keys (§1.1)', () => {
    const o = V.order;
    expect(orderIndex(o.order_id)).toBe(o.idx);
    expect(toHex(keyOf(o.user).orderKey(o.order_id).publicKey)).toBe(o.user_order_pubkey);
    expect(toHex(keyOf(o.shopper).orderKey(o.order_id).publicKey)).toBe(o.shopper_order_pubkey);
    expect(toHex(escrowPubkeyFromXpub(o.escrow_xpub, o.order_id))).toBe(o.escrow_order_pubkey);
    expect(toHex(keyOf(o.escrow).escrowOrderKey(o.order_id).publicKey)).toBe(o.escrow_order_pubkey);
  });

  it('witness script and P2WSH address (§5.1)', () => {
    const b = V.btc_escrow;
    const script = witnessScript({ user: fromHex(b.user_pubkey), shopper: fromHex(b.shopper_pubkey), escrow: fromHex(b.escrow_pubkey) }, b.t1, b.t2);
    expect(toHex(script)).toBe(b.witness_script);
    expect(p2wshAddress(script)).toBe(b.address);
  });

  it('Safe initializer, salt nonce and CREATE2 address (§6.2)', () => {
    const s = V.safe;
    const d = { usdc: s.usdc, module: s.module, setup: s.setup, safe: { singleton: s.singleton, factory: s.factory, fallback_handler: s.fallback_handler, multisend_call_only: s.multisend_call_only } };
    const params = { user: s.owners[0], shopper: s.owners[1], escrow: s.owners[2], t1: BigInt(s.t1), t2: BigInt(s.t2), orderId: s.order_id };
    const init = safeInitializer(d, params);
    expect(init).toBe(s.initializer);
    expect(safeSaltNonce(s.order_id)).toBe(BigInt(s.salt_nonce));
    expect(SAFE_PROXY_CREATION_CODE).toBe(s.proxy_creation_code);
    const at = (code: `0x${string}`) => predictSafeAddress({ factory: s.factory, singleton: s.singleton, initializer: init, saltNonce: BigInt(s.salt_nonce), proxyCreationCode: code });
    expect(at(s.proxy_creation_code)).toBe(s.address);
    expect(at(s.canonical_v141.proxy_creation_code)).toBe(s.canonical_v141.address);
  });

  it('SafeTx EIP-712 hashes and sorted signatures (§6.4)', async () => {
    const t = V.safe_tx;
    const s = V.safe;
    const owners: Record<string, string> = { 'user-1': s.owners[0], 'shopper-1': s.owners[1], 'escrow-1': s.owners[2] };
    for (const kind of ['release', 'split'] as const) {
      const v = t[kind];
      const tx = safeTxFromJson(v.safe_tx);
      expect(safeTxHash(tx, t.chain_id, t.safe), kind).toBe(v.hash);
      const sigs = [];
      for (const [name, sig] of Object.entries<string>(v.signatures)) {
        const ours = await signSafeTx(keyOf(name).evmAccount, tx, t.chain_id, t.safe);
        expect(ours, `${kind} ${name}`).toBe(sig); // RFC 6979 deterministic
        sigs.push({ signer: owners[name] as `0x${string}`, signature: sig as `0x${string}` });
      }
      expect(packSignatures(sigs), kind).toBe(v.joined_signatures);
    }
    // our builders produce the same transactions
    const rel = safeTxFromJson(t.release.safe_tx);
    const relTo = `0x${rel.data.slice(34, 74)}` as `0x${string}`;
    const relAmount = BigInt(`0x${rel.data.slice(74)}`);
    expect(releaseSafeTx({ usdc: rel.to, to: relTo, amount: relAmount })).toEqual({ ...rel, to: rel.to });
    const split = safeTxFromJson(t.split.safe_tx);
    const payouts = safeTxTransfers(split, s.usdc);
    expect(splitSafeTx({ usdc: s.usdc, multiSend: split.to, payouts }).data).toBe(split.data);
  });

  it('delivery ciphertext and wrapped keys (§4.4)', async () => {
    const d = V.delivery;
    const key = fromHex(d.k);
    expect(JSON.stringify(d.address)).toBe(d.address_json);
    expect(encryptAddress(key, d.order_id, d.address, fromHex(d.nonce))).toBe(d.ciphertext);
    expect(decryptAddress(key, d.order_id, d.ciphertext)).toEqual(d.address);
    const sender = keyOf(d.sender);
    for (const w of [d.key_for_shopper, d.key_for_escrow]) {
      const recipient = keyOf(w.recipient);
      const conv = nip44.getConversationKey(sender.nostrSecretKey, recipient.nostrPublicKey);
      expect(nip44.encrypt(d.k, conv, fromHex(w.nip44_nonce))).toBe(w.payload);
      const k = await unwrapDeliveryKey(new LocalSigner(recipient.nostrSecretKey), sender.nostrPublicKey, w.payload);
      expect(toHex(k)).toBe(d.k);
    }
  });

  it('gift wrap (§4.1): unwraps the Go wrap to the signed inner', async () => {
    const g = V.gift_wrap;
    const shopper = new LocalSigner(keyOf(g.recipient).nostrSecretKey);
    const inner = await unwrap(shopper, g.wrap);
    expect(inner).toEqual(g.inner);
    const seal = JSON.parse(await shopper.nip44Decrypt(g.wrap.pubkey, g.wrap.content));
    expect(seal).toEqual(g.seal);
    // encryption direction: same plaintext + nonce gives the same payload
    const sender = keyOf(g.sender);
    const conv = nip44.getConversationKey(sender.nostrSecretKey, keyOf(g.recipient).nostrPublicKey);
    const sealPlain = nip44.decrypt(g.seal.content, conv);
    expect(nip44.encrypt(sealPlain, conv, fromHex(g.seal_nip44_nonce))).toBe(g.seal.content);
    expect(JSON.parse(sealPlain)).toEqual(g.inner);
  });
});
