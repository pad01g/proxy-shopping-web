/**
 * Interop with the real Go p2p relay (and the Go shopper node behind it) over WSS — not part of `npm test`.
 *   npm run test:interop -w @proxy-shopping/core
 * Env: PS_P2P_RELAY (default: the public ps-main relay), PS_GO_SHOPPER (the Go shopper's identity pubkey),
 *      PS_INTEROP_ORDER=0 to skip the order round trip with the Go shopper.
 */
import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import {
  generateMnemonic, giftWrap, KeySet, KIND, LocalSigner, MemoryStorage, Session, signInner, UserClient, type UserOrder,
} from '../../src/index.js';
import { MemoryRelayNetwork } from '../../src/testing/memory-transport.js';
import { P2PNode } from '../../src/p2p.js';

const RELAY = process.env.PS_P2P_RELAY ?? '/dns4/gateway.tail2668e8.ts.net/tcp/8443/tls/ws/p2p/16Uiu2HAkx48HBqtwZGZwjDYsv6TyyMc3xvY1nr9DKi13dCMtkeN1';
const GO_SHOPPER = process.env.PS_GO_SHOPPER ?? '6ecffaf33e9a3fb596369ff44d76c7e53c5d3ea5d3238b6bb5cce5c70520e05a';
const PS_MAIN_COORDINATOR = '7a0a27bb7092dc59b5bfe195d9f0e0cf81c69373b0d702a41490ed45cfccbe39';
const NETWORK = 'ps-main';

async function until<T>(what: string, f: () => T | undefined | false | Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const freshKeys = () => KeySet.fromMnemonic(generateMnemonic());

describe('Go p2p relay over WSS (§10)', () => {
  it('reserves a circuit slot and trust-syncs the Go shopper’s events', { timeout: 90_000 }, async () => {
    const node = await P2PNode.start({ secretKey: freshKeys().libp2pSecretKey, network: NETWORK, relays: [RELAY], webrtc: false });
    const events: NostrEvent[] = [];
    node.onEvents((evs) => events.push(...evs));
    try {
      const st = await until('a reservation on the relay', () => {
        const s = node.status();
        return s.relays[0]?.connected && s.relays[0]?.reserved && s.circuitAddrs.length ? s : undefined;
      });
      expect(st.circuitAddrs[0]).toBe(`${RELAY}/p2p-circuit/p2p/${node.peerId}`);
      await until('trust-sync from the relay', () => events.some((e) => e.pubkey === GO_SHOPPER && e.kind === KIND.shopperProfile));
      const kinds = new Set(events.map((e) => e.kind));
      expect(kinds.has(KIND.delegation)).toBe(true);
      expect(kinds.has(KIND.operatorList)).toBe(true);
      console.log(`trust-sync: ${events.length} events, kinds ${[...kinds].join(',')}`);
    } finally {
      await node.stop();
    }
  });

  it('gossip and /ps/msg between two app nodes through the relay (circuit only)', { timeout: 90_000 }, async () => {
    const a = await P2PNode.start({ secretKey: freshKeys().libp2pSecretKey, network: NETWORK, relays: [RELAY], webrtc: false });
    const b = await P2PNode.start({ secretKey: freshKeys().libp2pSecretKey, network: NETWORK, relays: [RELAY], webrtc: false });
    try {
      const synced: NostrEvent[] = [];
      a.onEvents((evs, src) => src === 'sync' && synced.push(...evs));
      const gossiped: NostrEvent[] = [];
      b.onEvents((evs, src) => src === 'gossip' && gossiped.push(...evs));
      await until('both reserved', () => a.status().circuitAddrs.length > 0 && b.status().circuitAddrs.length > 0);
      // Gossip: re-announce a real event (no new junk in the relay's store); the relay passes it on to b.
      const real = await until('an event to re-gossip', () => synced.find((e) => e.kind === KIND.delegation));
      await until('the gossip of a at b, via the relay', async () => {
        await a.publish(real).catch(() => undefined);
        return gossiped.some((e) => e.id === real.id);
      }, 45_000);
      // /ps/msg: a reaches b only through b's circuit address.
      const bIdentity = generateSecretKey();
      const bPub = getPublicKey(bIdentity);
      let got: NostrEvent | undefined;
      b.onWrap(async (w) => {
        got = w;
        return { ok: true };
      });
      const alice = new LocalSigner(generateSecretKey());
      const inner = await signInner(alice, { recipient: bPub, orderId: '0123456789abcdef0123456789abcdef', type: 'chat', body: { text: 'over the relay' } });
      const wrap = await giftWrap(alice, inner, bPub);
      expect(await a.sendWrap(b.self(), wrap)).toBe(true);
      expect(got?.id).toBe(wrap.id);
      expect(a.status().messagesSent).toBe(1);
      expect(b.status().messagesReceived).toBe(1);
      // a wrap for somebody else is refused with ok:false
      b.onWrap(async () => ({ ok: false, error: 'wrap is not for this recipient' }));
      expect(await a.sendWrap(b.self(), wrap)).toBe(false);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it.skipIf(process.env.PS_INTEROP_ORDER === '0')('order round trip with the Go shopper over P2P only (no Nostr relay reachable)', { timeout: 180_000 }, async () => {
    const keys = freshKeys();
    // An isolated in-memory "Nostr": anything that arrives came over P2P.
    const net = new MemoryRelayNetwork();
    const session = new Session({
      keys, transport: net.transport(), storage: new MemoryStorage(),
      config: { network: NETWORK, relays: ['wss://isolated.test'], coordinators: [PS_MAIN_COORDINATOR], trustFromNostr: false, refreshIntervalMs: 0, retryIntervalMs: 60_000 },
    });
    const user = new UserClient(session, {}).attach();
    await session.start();
    const node = await P2PNode.start({ secretKey: keys.libp2pSecretKey, network: NETWORK, relays: [RELAY], webrtc: false, log: (l) => console.log(`[p2p] ${l}`) });
    session.attachP2P(node);
    const via: string[] = [];
    session.messenger.on('sent', (s) => via.push(s.via));
    try {
      await until('our circuit address', () => session.p2pSelf());
      const offer = await until('the Go shopper in the directory (from trust-sync)', () =>
        session.directory.current?.entries.find((e) => e.shopper === GO_SHOPPER) &&
        session.directory.offers({ shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', payment: 'btc-signet' }).find((o) => o.entry.shopper === GO_SHOPPER && o.escrow),
      60_000);
      const shopperP2P = session.p2pTargetOf(GO_SHOPPER);
      console.log(`Go shopper p2p: ${JSON.stringify(shopperP2P)}`);
      expect(shopperP2P?.peer_id).toMatch(/^16Uiu2/);
      const updates: UserOrder[] = [];
      user.on('order', (o) => updates.push(o));
      const order = await user.createOrder({
        offer, shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', items: [{ sku: 'A-100', qty: 1 }], payment: 'btc-signet',
        address: { name: 'P2P interop', postal_code: '100-0001', address: 'Tokyo (test)', phone: '000' },
      });
      // Our request carried reply_p2p (§4.4), and went over P2P.
      const sentRequest = (await session.messenger.pending()).find((i) => JSON.parse(i.content).shop_url);
      if (sentRequest) expect(JSON.parse(sentRequest.content).reply_p2p.peer_id).toBe(node.peerId);
      expect(via[0]).toBe('p2p');
      // The shopper's ack and quote come back over /ps/msg to our circuit address (there is no Nostr here).
      const quoted = await until('the Go shopper’s answer', () => updates.find((o) => o.id === order.id && o.status !== 'requested'), 120_000);
      console.log(`order ${order.id}: ${quoted.status}; p2p status ${JSON.stringify({ sent: node.status().messagesSent, received: node.status().messagesReceived })}`);
      expect(node.status().messagesReceived).toBeGreaterThan(0);
      expect(net.relays.size === 0 || [...net.relays.values()].flat().every((e) => e.kind !== KIND.giftWrap || e.tags.some((t) => t[0] === 'p' && t[1] !== GO_SHOPPER))).toBe(true);
    } finally {
      user.detach();
      session.stop();
      await node.stop();
    }
  });
});
