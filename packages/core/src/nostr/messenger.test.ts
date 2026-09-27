import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { LocalSigner } from '../keys/signer.js';
import { MemoryStorage } from '../storage/memory.js';
import { MemoryRelayNetwork } from '../testing/memory-transport.js';
import { sleep } from '../util/time.js';
import { giftWrap, isValidInner, plainEvent, signInner, unwrap } from './giftwrap.js';
import { KIND } from './kinds.js';
import { Messenger, type IncomingMessage } from './messenger.js';
import type { NostrTransport } from './transport.js';

const RELAYS = ['wss://relay-1.test', 'wss://relay-2.test'];
const ORDER = '0123456789abcdef0123456789abcdef';

describe('gift wrap (§4.1)', () => {
  it('wraps a signed inner and unwraps it for the recipient only', async () => {
    const alice = new LocalSigner(generateSecretKey());
    const bob = new LocalSigner(generateSecretKey());
    const eve = new LocalSigner(generateSecretKey());
    const inner = await signInner(alice, { recipient: bob.pubkey, orderId: ORDER, type: 'chat', body: { text: 'hi' } });
    expect(isValidInner(inner)).toBe(true);
    const wrap = await giftWrap(alice, inner, bob.pubkey);
    expect(wrap.kind).toBe(KIND.giftWrap);
    expect(wrap.pubkey).not.toBe(alice.pubkey);
    expect(wrap.tags).toEqual([['p', bob.pubkey]]);
    const opened = await unwrap(bob, wrap);
    expect(opened).toEqual(plainEvent(inner));
    await expect(unwrap(eve, wrap)).rejects.toThrow();
  });

  it('rejects an inner whose signer differs from the seal', async () => {
    const alice = new LocalSigner(generateSecretKey());
    const mallory = new LocalSigner(generateSecretKey());
    const bob = new LocalSigner(generateSecretKey());
    const forged = await signInner(alice, { recipient: bob.pubkey, orderId: ORDER, type: 'chat', body: {} });
    // mallory seals alice's inner
    const wrap = await giftWrap(mallory, forged, bob.pubkey);
    await expect(unwrap(bob, wrap)).rejects.toThrow(/mismatch/);
  });

  it('rejects a wrap whose p tag names someone else (§4.1)', async () => {
    const alice = new LocalSigner(generateSecretKey());
    const bob = new LocalSigner(generateSecretKey());
    const eve = getPublicKey(generateSecretKey());
    const inner = await signInner(alice, { recipient: bob.pubkey, orderId: ORDER, type: 'chat', body: { text: 'x' } });
    const seal = await alice.signEvent({ kind: KIND.seal, created_at: inner.created_at, tags: [], content: await alice.nip44Encrypt(bob.pubkey, JSON.stringify(inner)) });
    const eph = generateSecretKey();
    const wrap = finalizeEvent({
      kind: KIND.giftWrap, created_at: inner.created_at, tags: [['p', eve]],
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(eph, bob.pubkey)),
    }, eph);
    await expect(unwrap(bob, wrap)).rejects.toThrow(/wrap not addressed/);
  });

  it('accepts a missing o tag only for acks (Go omits it for order-less messages)', async () => {
    const alice = new LocalSigner(generateSecretKey());
    const ack = await signInner(alice, { recipient: alice.pubkey, orderId: '', type: 'ack', body: { ids: [] } });
    expect(ack.tags.some((t) => t[0] === 'o')).toBe(false);
    expect(isValidInner(ack)).toBe(true);
    const chat = await signInner(alice, { recipient: alice.pubkey, orderId: '', type: 'chat', body: { text: 'x' } });
    expect(isValidInner(chat)).toBe(false);
  });

  it('detects tampering with an inner', async () => {
    const alice = new LocalSigner(generateSecretKey());
    const inner = await signInner(alice, { recipient: alice.pubkey, orderId: ORDER, type: 'chat', body: { a: 1 } });
    expect(isValidInner({ ...inner, content: '{"a":2}' })).toBe(false);
  });
});

function pair(net: MemoryRelayNetwork, opts: { retryIntervalMs?: number } = {}) {
  const mk = () =>
    new Messenger({
      signer: new LocalSigner(generateSecretKey()),
      transport: net.transport(),
      storage: new MemoryStorage(),
      relays: RELAYS,
      retryIntervalMs: opts.retryIntervalMs ?? 30_000,
    });
  return [mk(), mk()] as const;
}

async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(10);
  }
}

describe('Messenger (§4.2)', () => {
  it('delivers, acks and dedupes', async () => {
    const net = new MemoryRelayNetwork();
    const [a, b] = pair(net);
    const got: IncomingMessage[] = [];
    b.on('message', (m) => got.push(m));
    await a.start();
    await b.start();
    const inner = await a.send(await b.pubkey(), ORDER, 'chat', { text: 'x' });
    await until(() => a.isAcked(inner.id));
    expect(got).toHaveLength(1); // arrived via two relays, emitted once
    expect(got[0]).toMatchObject({ type: 'chat', orderId: ORDER, body: { text: 'x' }, from: await a.pubkey() });
    expect(await a.pending()).toHaveLength(0);
    a.stop();
    b.stop();
  });

  it('retries while running until the recipient comes online', async () => {
    const net = new MemoryRelayNetwork();
    const [a, b] = pair(net, { retryIntervalMs: 50 });
    await a.start();
    // wraps are stored by relays; clear them to simulate relay loss, forcing a resend
    const inner = await a.send(await b.pubkey(), ORDER, 'chat', { text: 'x' });
    net.relays.clear();
    const got: string[] = [];
    b.on('message', (m) => got.push(m.inner.id));
    await b.start();
    await until(() => a.isAcked(inner.id), 8000);
    expect(got).toEqual([inner.id]);
    a.stop();
    b.stop();
  });

  it('uses the recipient kind 10050 relays', async () => {
    const net = new MemoryRelayNetwork();
    const [a, b] = pair(net);
    b.setRelays(['wss://relay-2.test']);
    await b.publishInboxRelays();
    // a only knows relay-1 + relay-2 to look up 10050; b listens on relay-2 only
    expect(await a.inboxRelaysOf(await b.pubkey())).toEqual(['wss://relay-2.test']);
  });

  it('keeps sending when some relays are down', async () => {
    const net = new MemoryRelayNetwork();
    net.down.add('wss://relay-1.test');
    const [a, b] = pair(net);
    const errors: string[] = [];
    a.on('error', (e) => errors.push(e.message));
    await b.start();
    await a.start();
    const inner = await a.send(await b.pubkey(), ORDER, 'chat', { text: '' });
    await until(() => a.isAcked(inner.id));
    expect(errors.some((e) => e.includes('1/2'))).toBe(true);
    a.stop();
    b.stop();
  });

  it('drops bodies that do not match the schema of their type (§4.10), but still acks them', async () => {
    const net = new MemoryRelayNetwork();
    const [a, b] = pair(net);
    const got: IncomingMessage[] = [];
    const dropped: string[] = [];
    b.on('message', (m) => got.push(m));
    b.on('dropped', (d) => dropped.push(d.reason));
    await a.start();
    await b.start();
    const bad = await a.send(await b.pubkey(), ORDER, 'order.quote', { accept: 'yes', lock_amount: 1.5 });
    const unknown = await a.send(await b.pubkey(), ORDER, 'no.such.type', {});
    const good = await a.send(await b.pubkey(), ORDER, 'order.shipping', {
      status: 'shipped', tracking: { status: 'shipped', updated_at: 1, evidence: null }, // Go sends null for empty slices
    });
    await until(async () => (await a.isAcked(bad.id)) && (await a.isAcked(unknown.id)) && (await a.isAcked(good.id)));
    expect(got.map((m) => m.type)).toEqual(['order.shipping']);
    expect(got[0].body).toEqual({ status: 'shipped', tracking: { status: 'shipped', updated_at: 1, evidence: [] } });
    expect(dropped).toHaveLength(2);
    a.stop();
    b.stop();
  });

  it('limits messages per sender', async () => {
    const net = new MemoryRelayNetwork();
    const a = new Messenger({ signer: new LocalSigner(generateSecretKey()), transport: net.transport(), storage: new MemoryStorage(), relays: RELAYS });
    const b = new Messenger({ signer: new LocalSigner(generateSecretKey()), transport: net.transport(), storage: new MemoryStorage(), relays: RELAYS, maxPerSenderPerMinute: 3 });
    const got: string[] = [];
    b.on('message', (m) => got.push(m.inner.id));
    await b.start();
    for (let i = 0; i < 6; i++) await a.send(await b.pubkey(), ORDER, 'chat', { text: String(i) });
    await sleep(100);
    expect(got).toHaveLength(3);
    b.stop();
  });

  it('does not rate limit the stored backlog, only messages that arrive after EOSE', async () => {
    const net = new MemoryRelayNetwork();
    const a = new Messenger({ signer: new LocalSigner(generateSecretKey()), transport: net.transport(), storage: new MemoryStorage(), relays: RELAYS });
    const b = new Messenger({ signer: new LocalSigner(generateSecretKey()), transport: net.transport(), storage: new MemoryStorage(), relays: RELAYS, maxPerSenderPerMinute: 3 });
    // a fresh device restoring from its mnemonic: everything on the relays is new to it
    for (let i = 0; i < 6; i++) await a.send(await b.pubkey(), ORDER, 'chat', { text: `old ${i}` });
    const got: string[] = [];
    b.on('message', (m) => got.push(m.inner.id));
    await b.start();
    await sleep(100);
    expect(got).toHaveLength(6);
    for (let i = 0; i < 6; i++) await a.send(await b.pubkey(), ORDER, 'chat', { text: `new ${i}` });
    await sleep(100);
    expect(got).toHaveLength(9);
    b.stop();
  });

  it('does not rate limit the stored backlog, only messages that arrive after EOSE', async () => {
    const net = new MemoryRelayNetwork();
    const a = new Messenger({ signer: new LocalSigner(generateSecretKey()), transport: net.transport(), storage: new MemoryStorage(), relays: RELAYS });
    const b = new Messenger({ signer: new LocalSigner(generateSecretKey()), transport: net.transport(), storage: new MemoryStorage(), relays: RELAYS, maxPerSenderPerMinute: 3 });
    // a fresh device restoring from its mnemonic: everything on the relays is new to it
    for (let i = 0; i < 6; i++) await a.send(await b.pubkey(), ORDER, 'chat', { text: `old ${i}` });
    const got: string[] = [];
    b.on('message', (m) => got.push(m.inner.id));
    await b.start();
    await sleep(100);
    expect(got).toHaveLength(6);
    for (let i = 0; i < 6; i++) await a.send(await b.pubkey(), ORDER, 'chat', { text: `new ${i}` });
    await sleep(100);
    expect(got).toHaveLength(9);
    b.stop();
  });

  it('uses at most 8 public wss relays from a peer kind 10050, and acks to at most k', async () => {
    const net = new MemoryRelayNetwork();
    const published: Array<{ relays: string[]; kind: number }> = [];
    const spy = (t: NostrTransport): NostrTransport => ({
      ...t,
      publish: (relays, e: NostrEvent) => {
        published.push({ relays, kind: e.kind });
        return t.publish(relays, e);
      },
    });
    const bSk = generateSecretKey();
    const a = new Messenger({ signer: new LocalSigner(generateSecretKey()), transport: net.transport(), storage: new MemoryStorage(), relays: RELAYS });
    const b = new Messenger({ signer: new LocalSigner(bSk), transport: spy(net.transport()), storage: new MemoryStorage(), relays: RELAYS });
    const listed = [
      'ws://plain.test', 'wss://127.0.0.1', 'wss://10.1.2.3', 'wss://[::1]', 'wss://localhost', 'https://not-a-relay.test',
      ...RELAYS, ...Array.from({ length: 10 }, (_, i) => `wss://r${i}.test`),
    ];
    await net.transport().publish(RELAYS, finalizeEvent({ kind: KIND.inboxRelays, created_at: 1, tags: listed.map((r) => ['relay', r]), content: '' }, bSk));
    expect(await a.inboxRelaysOf(getPublicKey(bSk))).toEqual([...RELAYS, ...Array.from({ length: 6 }, (_, i) => `wss://r${i}.test`)]);
    // a's own 10050 lists 4 relays; b's ack goes to only k = 2 of them
    const aRelays = ['wss://relay-1.test', 'wss://relay-2.test', 'wss://relay-3.test', 'wss://relay-4.test'];
    a.setRelays(aRelays);
    await a.publishInboxRelays();
    await a.start();
    await b.start();
    const inner = await a.send(getPublicKey(bSk), ORDER, 'chat', { text: 'hi' });
    await until(() => a.isAcked(inner.id));
    const acks = published.filter((p) => p.kind === KIND.giftWrap);
    expect(acks.length).toBeGreaterThan(0);
    expect(acks.every((p) => p.relays.length <= 2)).toBe(true);
    a.stop();
    b.stop();
  });

  it('allows private relays only when configured (lab)', () => {
    const lab = new Messenger({ signer: new LocalSigner(generateSecretKey()), transport: new MemoryRelayNetwork().transport(), storage: new MemoryStorage(), relays: RELAYS, allowPrivateRelays: true });
    expect(lab.usableRelays(['ws://relay:8080', 'wss://127.0.0.1'])).toEqual(['ws://relay:8080', 'wss://127.0.0.1']);
  });
});
