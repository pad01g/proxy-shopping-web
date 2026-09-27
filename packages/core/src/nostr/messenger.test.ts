import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { LocalSigner } from '../keys/signer.js';
import { MemoryStorage } from '../storage/memory.js';
import { MemoryRelayNetwork } from '../testing/memory-transport.js';
import { sleep } from '../util/time.js';
import { giftWrap, isValidInner, plainEvent, signInner, unwrap } from './giftwrap.js';
import { KIND } from './kinds.js';
import { BACKLOG_LIMIT, Messenger, rewrap, type IncomingMessage } from './messenger.js';
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
    // §4.10: every other type needs a non-empty o tag; we refuse to sign one that the peer would drop.
    await expect(signInner(alice, { recipient: alice.pubkey, orderId: '', type: 'report', body: { text: 'x' } })).rejects.toThrow(/order id/);
    const emptyO = await alice.signEvent({ kind: KIND.inner, created_at: 1, tags: [['p', alice.pubkey], ['o', ''], ['t', 'chat']], content: '{}' });
    expect(isValidInner(emptyO)).toBe(false);
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

  it('applies the per-minute limit only after EOSE (the stored backlog has a higher one)', async () => {
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

describe('Messenger limits and delivery (second review, §4.2, §4.10)', () => {
  const mk = (net: MemoryRelayNetwork, opts: Partial<ConstructorParameters<typeof Messenger>[0]> = {}) =>
    new Messenger({ signer: new LocalSigner(generateSecretKey()), transport: net.transport(), storage: new MemoryStorage(), relays: RELAYS, ...opts });

  it('caps messages from strangers together, on top of the per-sender limit', async () => {
    const net = new MemoryRelayNetwork();
    const b = mk(net, { maxStrangersPerMinute: 3, accepts: () => 'stranger' });
    const got: string[] = [];
    b.on('message', (m) => got.push(m.inner.id));
    await b.start();
    await sleep(20); // EOSE: live from here
    for (let s = 0; s < 3; s++) {
      const a = mk(net);
      for (let i = 0; i < 2; i++) await a.send(await b.pubkey(), ORDER, 'chat', { text: `${s}/${i}` });
    }
    await sleep(100);
    expect(got).toHaveLength(3);
    b.stop();
  });

  it('neither stores nor acks what no role accepts', async () => {
    const net = new MemoryRelayNetwork();
    const a = mk(net);
    const b = mk(net, { accepts: () => 'reject' });
    const got: string[] = [];
    const dropped: string[] = [];
    b.on('message', (m) => got.push(m.inner.id));
    b.on('dropped', (d) => dropped.push(d.reason));
    await a.start();
    await b.start();
    const inner = await a.send(await b.pubkey(), ORDER, 'chat', { text: 'x' });
    await until(() => dropped.length > 0);
    await sleep(50);
    expect(got).toEqual([]);
    expect(await b.inbox()).toEqual([]);
    expect(await a.isAcked(inner.id)).toBe(false);
    a.stop();
    b.stop();
  });

  it('limits the stored backlog too, with a higher per-sender limit', async () => {
    const net = new MemoryRelayNetwork();
    const a = mk(net);
    const b = mk(net, { maxPerSenderPerMinute: 2, maxBacklogPerSender: 4 });
    for (let i = 0; i < 6; i++) await a.send(await b.pubkey(), ORDER, 'chat', { text: `old ${i}` });
    const got: string[] = [];
    b.on('message', (m) => got.push(m.inner.id));
    await b.start();
    await sleep(100);
    expect(got).toHaveLength(4);
    b.stop();
  });

  it('changing relays does not open a new unlimited catch-up window', async () => {
    const net = new MemoryRelayNetwork();
    const a = mk(net);
    const b = mk(net, { maxPerSenderPerMinute: 3, maxBacklogPerSender: 100 });
    const got: string[] = [];
    b.on('message', (m) => got.push(m.inner.id));
    await b.start();
    await sleep(20);
    for (let i = 0; i < 6; i++) await a.send(await b.pubkey(), ORDER, 'chat', { text: String(i) });
    await sleep(50);
    expect(got).toHaveLength(3);
    // The relays replay all six stored wraps to the new subscription: still live, still limited.
    b.setRelays([...RELAYS]);
    await sleep(100);
    expect(got).toHaveLength(3);
    b.stop();
  });

  it('reads older pages when a flood fills the first page of stored wraps', async () => {
    const net = new MemoryRelayNetwork();
    const a = mk(net);
    const b = mk(net);
    const bPk = await b.pubkey();
    const inner = await a.send(bPk, ORDER, 'chat', { text: 'the real one' });
    // 1000 newer junk wraps for b (not decryptable): the first page of the subscription holds only those.
    for (let i = 0; i < BACKLOG_LIMIT; i++) {
      const junk = finalizeEvent({ kind: KIND.giftWrap, created_at: inner.created_at + 10 + i, tags: [['p', bPk]], content: 'x' }, generateSecretKey());
      await net.transport().publish(['wss://relay-1.test'], junk);
    }
    const got: string[] = [];
    b.on('message', (m) => got.push(m.inner.id));
    await b.start();
    await until(() => got.length > 0, 8000);
    expect(got).toEqual([inner.id]);
    b.stop();
  });

  it('gives resends 1, 2, 4, 8 a fresh wrap', async () => {
    expect([1, 2, 3, 4, 5, 8, 12, 16].map(rewrap)).toEqual([true, true, false, true, false, true, false, true]);
    const net = new MemoryRelayNetwork();
    const wraps = new Set<string>();
    const t = net.transport();
    const a = new Messenger({
      signer: new LocalSigner(generateSecretKey()), storage: new MemoryStorage(), relays: RELAYS, retryIntervalMs: 50,
      transport: { ...t, publish: (relays, e) => { if (e.kind === KIND.giftWrap) wraps.add(e.id); return t.publish(relays, e); } },
    });
    const b = mk(net);
    await a.start();
    const inner = await a.send(await b.pubkey(), ORDER, 'chat', { text: 'x' });
    net.relays.clear(); // lost by the relays: only a resend can deliver it
    await b.start();
    await until(() => a.isAcked(inner.id), 8000);
    expect(wraps.size).toBeGreaterThan(1);
    a.stop();
    b.stop();
  });

  it('sends to k relays of the inbox, and to the next one only when one fails (§4.2)', async () => {
    const net = new MemoryRelayNetwork();
    const calls: string[][] = [];
    const t = net.transport();
    const a = new Messenger({
      signer: new LocalSigner(generateSecretKey()), storage: new MemoryStorage(), relays: RELAYS,
      transport: { ...t, publish: (relays, e) => { if (e.kind === KIND.giftWrap) calls.push(relays); return t.publish(relays, e); } },
    });
    const bSk = generateSecretKey();
    const inbox = ['wss://r1.test', 'wss://r2.test', 'wss://r3.test', 'wss://r4.test'];
    await net.transport().publish(RELAYS, finalizeEvent({ kind: KIND.inboxRelays, created_at: 1, tags: inbox.map((r) => ['relay', r]), content: '' }, bSk));
    net.down.add('wss://r1.test');
    await a.send(getPublicKey(bSk), ORDER, 'chat', { text: 'x' });
    expect(calls).toEqual([['wss://r1.test', 'wss://r2.test'], ['wss://r3.test']]);
    expect(net.relays.has('wss://r4.test')).toBe(false);
  });
});
