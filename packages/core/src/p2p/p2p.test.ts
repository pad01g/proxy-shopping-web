/**
 * P2P without libp2p (§2.6, §4.2, §10): /ps/msg framing on in-memory streams, the Messenger sending P2P first and
 * falling back to the Nostr mailbox, bundles (caps, per-event verification, list_url), the directory without Nostr
 * and events arriving by P2P.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import { LocalSigner } from '../keys/signer.js';
import { giftWrap, signInner } from '../nostr/giftwrap.js';
import { KIND } from '../nostr/kinds.js';
import { Messenger, type IncomingMessage } from '../nostr/messenger.js';
import { MemoryStorage } from '../storage/memory.js';
import { MemoryRelayNetwork } from '../testing/memory-transport.js';
import { fetchBundle, MAX_BUNDLE_BYTES, MAX_BUNDLE_EVENTS } from '../trust/bundle.js';
import { TrustDirectory } from '../trust/directory.js';
import { delegationTemplate, inboxRelaysTemplate, operatorListTemplate, parseDelegation, shopperProfileTemplate } from '../trust/events.js';
import type { OperatorListContent, P2PAddr } from '../trust/types.js';
import { sleep } from '../util/time.js';
import { readLine, readSyncEvents, sendWrapOnStream, serveWrapStream, writeSyncEvents, type LineStream } from './framing.js';
import type { WrapCarrier } from './types.js';

const RELAYS = ['wss://relay-1.test', 'wss://relay-2.test'];
const ORDER = '0123456789abcdef0123456789abcdef';
const NET = 'ps-lab';
/** Wire form (drops the verification cache nostr-tools attaches). */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Two connected in-memory stream ends (half-close like a yamux stream). */
function pipe(): [LineStream, LineStream] {
  type Side = { queue: Uint8Array[]; ended: boolean; wake?: () => void };
  const mk = (): Side => ({ queue: [], ended: false });
  const ab = mk();
  const ba = mk();
  const end = (inbox: Side, outbox: Side): LineStream => ({
    send(data) {
      if (outbox.ended) throw new Error('closed');
      outbox.queue.push(data);
      outbox.wake?.();
      return true;
    },
    async close() {
      outbox.ended = true;
      outbox.wake?.();
    },
    abort() {
      outbox.ended = true;
      inbox.ended = true;
      outbox.wake?.();
      inbox.wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (inbox.queue.length) {
          yield inbox.queue.shift()!;
          continue;
        }
        if (inbox.ended) return;
        await new Promise<void>((r) => (inbox.wake = r));
        inbox.wake = undefined;
      }
    },
  });
  return [end(ba, ab), end(ab, ba)];
}

const key = () => {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
};

async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(10);
  }
}

async function wrapFor(recipient: string) {
  const alice = new LocalSigner(generateSecretKey());
  const inner = await signInner(alice, { recipient, orderId: ORDER, type: 'chat', body: { text: 'hi' } });
  return giftWrap(alice, inner, recipient);
}

describe('/ps/msg/1.0.0 framing (§10)', () => {
  it('sends one newline-terminated wrap and reads {"ok":true}', async () => {
    const me = key();
    const wrap = await wrapFor(me.pk);
    const [a, b] = pipe();
    let got: NostrEvent | undefined;
    const served = serveWrapStream(b, async (w) => {
      got = w;
      return { ok: true };
    });
    expect(await sendWrapOnStream(a, wrap)).toEqual({ ok: true, error: undefined });
    expect((await served).ok).toBe(true);
    expect(got).toEqual(plain(wrap));
  });

  it('passes the receiver’s refusal on', async () => {
    const [a, b] = pipe();
    void serveWrapStream(b, async () => ({ ok: false, error: 'not addressed to us' }));
    expect(await sendWrapOnStream(a, await wrapFor(key().pk))).toEqual({ ok: false, error: 'not addressed to us' });
  });

  it('writes exactly one JSON line and refuses lines over 64 KiB', async () => {
    const [a, b] = pipe();
    const wrap = await wrapFor(key().pk);
    void sendWrapOnStream(a, wrap, 500);
    const line = await readLine(b, 70_000);
    expect(JSON.parse(line!)).toEqual(plain(wrap));
    const [c, d] = pipe();
    const big = { ...wrap, content: 'x'.repeat(70 * 1024) };
    const served = serveWrapStream(d, async () => ({ ok: true }));
    expect(await sendWrapOnStream(c, big, 2000)).toMatchObject({ ok: false });
    expect((await served).ok).toBe(false);
  });

  it('gives up after the budget when the receiver never answers', async () => {
    const [a] = pipe();
    const t = Date.now();
    const r = await sendWrapOnStream(a, await wrapFor(key().pk), 200);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('trust-sync: one event per line, read until the sender closes', async () => {
    const c = key();
    const evs = [1, 2, 3].map((v) => finalizeEvent(delegationTemplate({ operator: key().pk, version: v, network: NET }), c.sk));
    const [a, b] = pipe();
    void writeSyncEvents(a, evs);
    expect(await readSyncEvents(b, { maxEvents: 10, maxEventBytes: 4096, maxTotalBytes: 1 << 20 })).toEqual(plain(evs));
    const [x, y] = pipe();
    void writeSyncEvents(x, evs);
    expect(await readSyncEvents(y, { maxEvents: 2, maxEventBytes: 4096, maxTotalBytes: 1 << 20 })).toHaveLength(2);
  });
});

/** In-process "P2P network": messengers registered by fake peer id. */
class FakeP2P {
  readonly peers = new Map<string, Messenger>();
  readonly sent: Array<{ to: string; wrap: NostrEvent }> = [];
  down = false;
  carrier(): WrapCarrier {
    return {
      sendWrap: async (target: P2PAddr, wrap: NostrEvent) => {
        this.sent.push({ to: target.peer_id, wrap });
        const m = this.peers.get(target.peer_id);
        if (this.down || !m) return false;
        return (await m.receiveWrap(wrap)).ok;
      },
    };
  }
}

function messenger(net: MemoryRelayNetwork) {
  return new Messenger({
    signer: new LocalSigner(generateSecretKey()), transport: net.transport(), storage: new MemoryStorage(), relays: RELAYS, retryIntervalMs: 60_000,
  });
}

const wrapsOnRelays = (net: MemoryRelayNetwork) => [...net.relays.values()].flat().filter((e) => e.kind === KIND.giftWrap).length;

describe('Messenger: P2P first, Nostr mailbox as fallback (§4.2)', () => {
  async function setup() {
    const net = new MemoryRelayNetwork();
    const p2p = new FakeP2P();
    const a = messenger(net);
    const b = messenger(net);
    const ids = { a: 'peer-a', b: 'peer-b' };
    p2p.peers.set(ids.a, a);
    p2p.peers.set(ids.b, b);
    const where = new Map([[await a.pubkey(), ids.a], [await b.pubkey(), ids.b]]);
    const resolve = (pk: string) => (where.has(pk) ? { peer_id: where.get(pk)!, addrs: [] } : undefined);
    a.setP2P(p2p.carrier(), resolve);
    b.setP2P(p2p.carrier(), resolve);
    return { net, p2p, a, b };
  }

  it('delivers over P2P when the receiver answers ok, and the ack comes back the same way', async () => {
    const { net, p2p, a, b } = await setup();
    const got: IncomingMessage[] = [];
    b.on('message', (m) => got.push(m));
    const via: string[] = [];
    a.on('sent', (s) => via.push(s.via));
    await b.start();
    await a.start();
    const inner = await a.send(await b.pubkey(), ORDER, 'chat', { text: 'p2p' });
    await until(() => a.isAcked(inner.id));
    expect(got.map((m) => m.body)).toEqual([{ text: 'p2p' }]);
    expect(via).toEqual(['p2p']);
    expect(p2p.sent.map((s) => s.to)).toEqual(['peer-b', 'peer-a']); // the message, then b's ack
    expect(wrapsOnRelays(net)).toBe(0);
    a.stop();
    b.stop();
  });

  it('falls back to the Nostr mailbox when P2P does not get through, and dedupes by inner id', async () => {
    const { net, p2p, a, b } = await setup();
    p2p.down = true;
    const got: IncomingMessage[] = [];
    b.on('message', (m) => got.push(m));
    await b.start();
    await a.start();
    const inner = await a.send(await b.pubkey(), ORDER, 'chat', { text: 'mailbox' });
    await until(() => a.isAcked(inner.id));
    expect(p2p.sent[0].to).toBe('peer-b');
    expect(wrapsOnRelays(net)).toBeGreaterThan(0);
    // the same inner arriving again over P2P (a resend) is not a new message
    p2p.down = false;
    expect((await b.receiveWrap(p2p.sent[0].wrap)).ok).toBe(true);
    await sleep(50);
    expect(got).toHaveLength(1);
    a.stop();
    b.stop();
  });

  it('uses only Nostr when the recipient’s P2P address is unknown', async () => {
    const net = new MemoryRelayNetwork();
    const p2p = new FakeP2P();
    const a = messenger(net);
    const b = messenger(net);
    const carrier = p2p.carrier();
    const spy = vi.spyOn(carrier, 'sendWrap');
    a.setP2P(carrier, () => undefined);
    await b.start();
    await a.start();
    const inner = await a.send(await b.pubkey(), ORDER, 'chat', {});
    await until(() => a.isAcked(inner.id));
    expect(spy).not.toHaveBeenCalled();
    a.stop();
    b.stop();
  });

  it('refuses wraps over /ps/msg that are not for us or not signed', async () => {
    const net = new MemoryRelayNetwork();
    const b = messenger(net);
    const other = await wrapFor(key().pk);
    expect(await b.receiveWrap(other)).toEqual({ ok: false, error: 'not addressed to us' });
    const mine = await wrapFor(await b.pubkey());
    expect(await b.receiveWrap({ ...mine, content: mine.content.slice(1) })).toEqual({ ok: false, error: 'bad signature' });
    expect(await b.receiveWrap({ kind: 1 } as NostrEvent)).toEqual({ ok: false, error: 'not a gift wrap' });
    expect((await b.receiveWrap(mine)).ok).toBe(true);
  });
});

function list(shopper: string, extra: Partial<OperatorListContent> = {}): OperatorListContent {
  return {
    network: NET, name: 'op', regions: ['JP-13'], relays: [{ url: 'wss://relay-1.test' }],
    entries: [{ region: 'JP-13', shopper, escrow: 'e'.repeat(64), shops: ['*'], payments: ['btc-signet'], tags: [], escrow_sla_days: 14 }],
    ...extra,
  };
}
const profile = (name: string) => ({ name, payments: ['btc-signet' as const], currencies: ['JPY'], cash_regions: [], fee: { bps: 500 }, delivery_days: 5 });

function stubFetch(files: Record<string, unknown>, opts: { redirect?: Record<string, string> } = {}): typeof fetch {
  return (async (url: string) => {
    const body = files[url];
    if (body === undefined) return new Response('no', { status: 404 });
    const res = new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
    const final = opts.redirect?.[url];
    if (final) Object.defineProperty(res, 'url', { value: final });
    return res;
  }) as unknown as typeof fetch;
}

describe('bundles (§2.6)', () => {
  it('verifies each event on its own and keeps the good ones', async () => {
    const c = key();
    const good = finalizeEvent(delegationTemplate({ operator: key().pk, version: 1, network: NET }), c.sk);
    const forged = { ...finalizeEvent(delegationTemplate({ operator: key().pk, version: 2, network: NET }), c.sk), content: '{"note":"x"}' };
    const f = stubFetch({ 'https://b.test/e.json': { events: [forged, 'junk', good, null] } });
    expect(plain(await fetchBundle('https://b.test/e.json', { fetch: f }))).toEqual([plain(good)]);
  });

  it('takes at most 1000 events and 2 MiB', async () => {
    const c = key();
    const ev = finalizeEvent(delegationTemplate({ operator: key().pk, version: 1, network: NET }), c.sk);
    const many = { events: Array.from({ length: MAX_BUNDLE_EVENTS + 5 }, () => ev) };
    const f = stubFetch({ 'https://b.test/many.json': many, 'https://b.test/big.json': `{"events":[],"pad":"${'x'.repeat(MAX_BUNDLE_BYTES)}"}` });
    expect(await fetchBundle('https://b.test/many.json', { fetch: f })).toHaveLength(MAX_BUNDLE_EVENTS);
    await expect(fetchBundle('https://b.test/big.json', { fetch: f })).rejects.toThrow(/over 2097152 bytes/);
  });

  it('is https only (lab excepted) and follows redirects only within the origin', async () => {
    const f = stubFetch({ 'http://b.test/e.json': { events: [] }, 'https://b.test/moved.json': { events: [] } }, { redirect: { 'https://b.test/moved.json': 'https://evil.test/e.json' } });
    await expect(fetchBundle('http://b.test/e.json', { fetch: f })).rejects.toThrow(/https/);
    expect(await fetchBundle('http://b.test/e.json', { fetch: f, allowPrivate: true })).toEqual([]);
    await expect(fetchBundle('https://b.test/moved.json', { fetch: f })).rejects.toThrow(/another origin/);
  });
});

describe('directory without Nostr: bundle_urls, list_url and P2P events (§2.6)', () => {
  it('reads list_url from the effective delegation and takes the list and profiles from it', async () => {
    const net = new MemoryRelayNetwork();
    const t = net.transport();
    const query = vi.spyOn(t, 'query');
    const c = key();
    const op = key();
    const shopper = key();
    const del = finalizeEvent(delegationTemplate({ operator: op.pk, version: 2, network: NET, listUrls: ['https://op.test/list.json'] }), c.sk);
    expect(parseDelegation(del)?.listUrls).toEqual(['https://op.test/list.json']);
    // a revoked delegation carries no list_url
    expect(delegationTemplate({ operator: op.pk, version: 3, network: NET, revoked: true, listUrls: ['https://op.test/x'] }).tags.some((x) => x[0] === 'list_url')).toBe(false);
    const lst = finalizeEvent(operatorListTemplate(list(shopper.pk, { p2p_relays: ['/dns4/relay.test/tcp/443/tls/ws/p2p/16Uiu2HAkx48HBqtwZGZwjDYsv6TyyMc3xvY1nr9DKi13dCMtkeN1'] }), 2), op.sk);
    const prof = finalizeEvent(shopperProfileTemplate({ ...profile('from list_url'), p2p: { peer_id: '16Uiu2HAmMnvsz9miPEy1kqM9eD6hEU1hSKpS2Ze9q6ko2YUPATbR', addrs: [] } }, NET, 1), shopper.sk);
    const inbox = finalizeEvent(inboxRelaysTemplate(['wss://inbox.test']), shopper.sk);
    // Nostr has a newer revocation, but trust from Nostr is off: it must not be asked
    await t.publish(RELAYS, finalizeEvent(delegationTemplate({ operator: op.pk, version: 9, network: NET, revoked: true }), c.sk));
    const fetchStub = stubFetch({
      'https://registry.test/events.json': { events: [del] },
      'https://op.test/list.json': { events: [lst, prof, inbox] },
    });
    const dir = new TrustDirectory({
      transport: t, storage: new MemoryStorage(), network: NET, relays: () => RELAYS, coordinators: () => [c.pk],
      bundles: () => ['https://registry.test/events.json'], nostr: () => false, fetch: fetchStub,
    });
    const snap = await dir.refresh();
    expect(query).not.toHaveBeenCalled();
    expect(snap.entries.map((e) => e.shopper)).toEqual([shopper.pk]);
    expect(snap.shoppers.get(shopper.pk)?.content.name).toBe('from list_url');
    expect(dir.inboxOf(shopper.pk)).toEqual(['wss://inbox.test']);
    expect(dir.p2pOf(shopper.pk)?.peer_id).toBe('16Uiu2HAmMnvsz9miPEy1kqM9eD6hEU1hSKpS2Ze9q6ko2YUPATbR');
    expect(dir.p2pRelays()).toHaveLength(1);
    expect(dir.sources.map((s) => [s.kind, s.events])).toEqual([['bundle', 1], ['list_url', 3]]);
    // with Nostr on, the relay's revocation wins
    const on = new TrustDirectory({
      transport: t, storage: new MemoryStorage(), network: NET, relays: () => RELAYS, coordinators: () => [c.pk],
      bundles: () => ['https://registry.test/events.json'], nostr: () => true, fetch: fetchStub,
    });
    expect((await on.refresh()).entries).toHaveLength(0);
  });

  it('takes P2P events under the same rules, holding a list aside until its delegation arrives', async () => {
    const net = new MemoryRelayNetwork();
    const c = key();
    const op = key();
    const stranger = key();
    const shopper = key();
    const del = finalizeEvent(delegationTemplate({ operator: op.pk, version: 1, network: NET }), c.sk);
    const lst = finalizeEvent(operatorListTemplate(list(shopper.pk), 1), op.sk);
    const prof = finalizeEvent(shopperProfileTemplate(profile('gossiped'), NET, 1), shopper.sk);
    const foreign = finalizeEvent(delegationTemplate({ operator: op.pk, version: 5, network: NET }), stranger.sk);
    const forged = { ...lst, content: lst.content.replace('"op"', '"xx"') };
    const storage = new MemoryStorage();
    const dir = new TrustDirectory({ transport: net.transport(), storage, network: NET, relays: () => RELAYS, coordinators: () => [c.pk], nostr: () => false });
    await dir.load();
    const updates: number[] = [];
    dir.on('updated', (s) => updates.push(s.entries.length));
    expect(await dir.ingest([prof, lst, forged, foreign])).toBe(0); // nothing in scope yet
    expect(dir.current?.entries).toHaveLength(0);
    expect(await dir.ingest([del])).toBe(1); // the delegation brings the parked list and profile in
    expect(dir.current?.entries.map((e) => e.shopper)).toEqual([shopper.pk]);
    expect(dir.current?.shoppers.get(shopper.pk)?.content.name).toBe('gossiped');
    expect(updates).toEqual([1]);
    const kept = ((await storage.get<NostrEvent[]>('trust/events')) ?? []).map((e) => e.id).sort();
    expect(kept).toEqual([del.id, lst.id, prof.id].sort());
    // trust-sync order: delegations, lists, profiles
    expect(dir.allEvents().map((e) => e.kind)).toEqual([KIND.delegation, KIND.operatorList, KIND.shopperProfile]);
    expect(dir.inScope(foreign)).toBe(false);
    expect(await dir.ingest([del])).toBe(0);
  });
});
