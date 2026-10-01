/**
 * Cross-implementation vectors written by the Go node (proxy-shopping-go/docs/test-vectors.json).
 * Without the file the suite fails, unless SKIP_VECTORS=1.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as nip44 from 'nostr-tools/nip44';
import { describe, expect, it } from 'vitest';
import { p2wshAddress, witnessScript } from './btc/script.js';
import { decryptAddress, encryptAddress, unwrapDeliveryKey } from './delivery/delivery.js';
import { predictSafeAddress, safeInitializer, safeSaltNonce } from './evm/safe.js';
import { packSignatures, releaseSafeTx, safeTxFromJson, safeTxHash, safeTxTransfers, signSafeTx, splitSafeTx } from './evm/safetx.js';
import { SAFE_PROXY_CREATION_CODE, SAFE_V141_CANONICAL_PROXY_CREATION_CODE } from './evm/proxy-creation-code.js';
import { escrowPubkeyFromXpub, KeySet } from './keys/derive.js';
import { libp2pPeerId, libp2pPrivateKey } from './p2p/node.js';
import { publicKeyToProtobuf } from '@libp2p/crypto/keys';
import type { NostrEvent } from 'nostr-tools/pure';
import { serveWrapStream } from './p2p/framing.js';
import { MAX_MSG_BYTES, PROTO_MSG } from './p2p/types.js';
import { p2pAddr, p2pAddrProblem } from './nostr/schema.js';
import { MemoryStorage } from './storage/memory.js';
import { MemoryRelayNetwork } from './testing/memory-transport.js';
import { TrustDirectory } from './trust/directory.js';
import { parseDelegation } from './trust/events.js';
import { orderIndex } from './keys/order.js';
import { LocalSigner } from './keys/signer.js';
import { unwrap } from './nostr/giftwrap.js';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { keyForEscrowSha256 } from './delivery/delivery.js';
import { keyProofMessage, signKeyProofEvm, verifyKeyProofBtc, verifyKeyProofEvm } from './keys/proof.js';
import { utf8 } from './util/bytes.js';
import { fromHex, toHex } from './util/bytes.js';

const FILE = fileURLToPath(new URL('../../../../proxy-shopping-go/docs/test-vectors.json', import.meta.url));
const present = existsSync(FILE);
// Missing vectors must not pass silently (item 19): skipping needs SKIP_VECTORS=1.
const skip = !present && process.env.SKIP_VECTORS === '1';

describe.skipIf(present || skip)('Go test vectors file', () => {
  it('is present (mount ../proxy-shopping-go, or set SKIP_VECTORS=1)', () => {
    expect.fail(`${FILE} not found`);
  });
});
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

  it('libp2p peer IDs (§1 m/7333\'/0\'/0\', §10): the same as the Go node', () => {
    // The "abandon" mnemonic must have one; every key that has a vector must match it.
    expect(V.keys.abandon.libp2p_peer_id).toMatch(/^16Uiu2/);
    for (const [name, k] of Object.entries<Record<string, string>>(V.keys)) {
      if (!k.libp2p_peer_id) continue;
      expect(libp2pPeerId(KeySet.fromMnemonic(k.mnemonic).libp2pSecretKey), name).toBe(k.libp2p_peer_id);
    }
  });

  it.skipIf(!V.libp2p)('libp2p key of the abandon mnemonic (§1, §10)', () => {
    const l = V.libp2p;
    const ks = KeySet.fromMnemonic(l.mnemonic);
    expect(toHex(ks.libp2pSecretKey)).toBe(l.secret);
    const priv = libp2pPrivateKey(ks.libp2pSecretKey);
    expect(toHex(priv.publicKey.raw)).toBe(l.pubkey_compressed);
    expect(toHex(publicKeyToProtobuf(priv.publicKey))).toBe(l.pubkey_protobuf);
    expect(libp2pPeerId(ks.libp2pSecretKey)).toBe(l.peer_id);
  });

  it.skipIf(!V.p2p)('P2P: list bundle with list_url, p2p_relays and profile p2p; reply_p2p; /ps/msg lines (§2.6, §4.4, §10)', async () => {
    const p = V.p2p;
    const coordinator = V.keys['coordinator-1'].nostr_pubkey;
    const shopper = V.keys['shopper-1'].nostr_pubkey;
    const fetchStub = (async (url: string) => new Response(JSON.stringify(url === p.list_url ? p.bundle : { events: [] }), { status: 200 })) as unknown as typeof fetch;
    const net = new MemoryRelayNetwork();
    // Only the delegation is "known" up front (as from a coordinator bundle); the rest comes from its list_url.
    const del = (p.bundle.events as NostrEvent[]).find((e) => e.kind === 30500)!;
    expect(parseDelegation(del)?.listUrls).toEqual([p.list_url]);
    const dir = new TrustDirectory({
      transport: net.transport(), storage: new MemoryStorage(), network: 'ps-lab', relays: () => [], coordinators: () => [coordinator],
      nostr: () => false, fetch: fetchStub, bundles: () => ['https://coordinator.example/events.json'],
    });
    await dir.ingest([del]);
    const snap = await dir.refresh();
    expect(snap.entries.map((e) => e.shopper)).toEqual([shopper]);
    expect(dir.p2pRelays()).toEqual((JSON.parse((p.bundle.events as NostrEvent[]).find((e) => e.kind === 30501)!.content) as { p2p_relays: string[] }).p2p_relays);
    expect(dir.p2pOf(shopper)?.peer_id).toBe(V.keys['shopper-1'].libp2p_peer_id);
    expect(dir.inboxOf(shopper)).toEqual(['wss://relay-1.test', 'wss://relay-2.test']);
    // reply_p2p passes the §4.4 checks; a broken one is dropped, not the request
    expect(p2pAddrProblem(p.reply_p2p.contact)).toBeUndefined();
    expect(p2pAddr({ peer_id: p.reply_p2p.contact.peer_id, addrs: ['/dns4/x/tcp/1/p2p/16Uiu2HAkx48HBqtwZGZwjDYsv6TyyMc3xvY1nr9DKi13dCMtkeN1'] })).toBeUndefined();
    // /ps/msg: the request line is the gift_wrap vector; our answers are byte for byte the Go lines
    expect(p.msg.protocol).toBe(PROTO_MSG);
    expect(p.msg.max_line).toBe(MAX_MSG_BYTES);
    const wrap = JSON.parse(p.msg.request_line) as NostrEvent;
    const shopperSigner = new LocalSigner(keyOf('shopper-1').nostrSecretKey);
    const lines: string[] = [];
    const stream = (input: string) => ({
      send: (b: Uint8Array) => (lines.push(new TextDecoder().decode(b)), true),
      close: async () => undefined,
      abort: () => undefined,
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(input);
      },
    });
    const ok = await serveWrapStream(stream(p.msg.request_line), async (w) => (w.id === wrap.id && (await unwrap(shopperSigner, w)) ? { ok: true } : { ok: false }));
    expect(ok.ok).toBe(true);
    await serveWrapStream(stream(p.msg.request_line), async () => ({ ok: false, error: 'wrap is not for this recipient' }));
    expect(lines).toEqual([p.msg.ok_line, p.msg.error_line]);
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
    // the allowlist carries exactly these two codes
    expect(SAFE_V141_CANONICAL_PROXY_CREATION_CODE).toBe(s.canonical_v141.proxy_creation_code);
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
    const payouts = safeTxTransfers(split, s.usdc, s.multisend_call_only);
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

  it.skipIf(!V.delivery?.key_for_escrow_sha256)('key_for_escrow_sha256 (§4.4)', () => {
    expect(keyForEscrowSha256(V.delivery.key_for_escrow.payload)).toBe(V.delivery.key_for_escrow_sha256);
  });

  it.skipIf(!V.key_proof)('key_proof (§4.4.1)', async () => {
    const k = V.key_proof;
    const user = keyOf(k.user);
    expect(user.nostrPublicKey).toBe(k.user_nostr_pubkey);
    expect(keyProofMessage(k.order_id, k.user_nostr_pubkey)).toBe(k.message);
    // BTC: BIP340 over sha256(m) with the order key; with the same aux_rand we produce the same bytes
    expect(toHex(user.orderKey(k.order_id).publicKey)).toBe(k.btc.user_btc_pubkey);
    expect(verifyKeyProofBtc(k.btc.key_proof, k.btc.user_btc_pubkey, k.order_id, k.user_nostr_pubkey)).toBe(true);
    const ours = schnorr.sign(sha256(utf8(k.message)), user.orderKey(k.order_id).privateKey, fromHex(k.btc.aux_rand));
    expect(toHex(ours)).toBe(k.btc.key_proof);
    // EVM: EIP-191 personal_sign, 65 bytes without 0x; RFC 6979 makes it deterministic
    expect(user.evmAddress).toBe(k.evm.user_evm_address);
    expect(await verifyKeyProofEvm(k.evm.key_proof, k.evm.user_evm_address, k.order_id, k.user_nostr_pubkey)).toBe(true);
    expect(await signKeyProofEvm(user.evmAccount, k.order_id, k.user_nostr_pubkey)).toBe(k.evm.key_proof);
  });
});

