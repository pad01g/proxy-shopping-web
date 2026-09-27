import { generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { LocalSigner } from '../keys/signer.js';
import { MemoryStorage } from '../storage/memory.js';
import { MemoryRelayNetwork } from '../testing/memory-transport.js';
import { sleep } from '../util/time.js';
import { giftWrap, isValidInner, plainEvent, signInner, unwrap } from './giftwrap.js';
import { KIND } from './kinds.js';
import { Messenger, type IncomingMessage } from './messenger.js';

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
    const inner = await a.send(await b.pubkey(), ORDER, 'order.request', { x: 1 });
    await until(() => a.isAcked(inner.id));
    expect(got).toHaveLength(1); // arrived via two relays, emitted once
    expect(got[0]).toMatchObject({ type: 'order.request', orderId: ORDER, body: { x: 1 }, from: await a.pubkey() });
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
    const inner = await a.send(await b.pubkey(), ORDER, 'chat', {});
    await until(() => a.isAcked(inner.id));
    expect(errors.some((e) => e.includes('1/2'))).toBe(true);
    a.stop();
    b.stop();
  });
});
