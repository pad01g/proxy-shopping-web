import { describe, expect, it } from 'vitest';
import { MemoryChain } from '../testing/memory-chain.js';
import { MemoryRelayNetwork } from '../testing/memory-transport.js';
import { createWorld } from '../testing/world.js';
import { sleep } from '../util/time.js';
import type { UserOrder, UserOrderStatus } from './user.js';

const ADDRESS = { name: '山田太郎', postal_code: '160-0022', address: '東京都新宿区新宿1-1-1', phone: '03-0000-0000' };
const RELAYS = ['wss://relay-1.test', 'wss://relay-2.test'];

async function waitStatus(get: () => Promise<UserOrder | undefined>, status: UserOrderStatus, ms = 5000): Promise<UserOrder> {
  const end = Date.now() + ms;
  for (;;) {
    const o = await get();
    if (o?.status === status) return o;
    if (Date.now() > end) throw new Error(`timeout waiting for ${status}, at ${o?.status} ${o?.lastError ?? ''}`);
    await sleep(10);
  }
}

async function setup() {
  const net = new MemoryRelayNetwork();
  const chain = new MemoryChain();
  const world = await createWorld({ relays: RELAYS, transport: () => net.transport(), chain });
  chain.fund(world.keys['user-1'].btcWallet.address, 1_000_000);
  return { net, chain, ...world };
}

async function placeFundedOrder(w: Awaited<ReturnType<typeof setup>>) {
  const offers = await w.user.discoverOffers({ shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', payment: 'btc-signet' });
  expect(offers).toHaveLength(1);
  expect(offers[0].entry.provenance.operator).toBe(w.keys['operator-1'].nostrPublicKey);
  const created = await w.user.createOrder({
    offer: offers[0], shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', items: [{ sku: 'A-100', qty: 1 }], payment: 'btc-signet', address: ADDRESS,
  });
  const get = () => w.user.getOrder(created.id);
  const quoted = await waitStatus(get, 'quoted');
  expect(quoted.quoteCheck).toMatchObject({ ok: true, errors: [] });
  expect(quoted.quoteCheck!.fx!.level).toBe('ok');
  expect(quoted.quote!.lock_amount).toBe('29667');
  await w.user.acceptQuote(created.id);
  await w.user.fund(created.id);
  w.chain.mine();
  return { id: created.id, get };
}

describe('flows (in-memory relays and chain)', () => {
  it('happy path: request → quote → accept → fund → delivered → release → completed', async () => {
    const w = await setup();
    const { id, get } = await placeFundedOrder(w);
    const shopperAddress = w.shopper.orders.get(id)!.address;
    expect(shopperAddress).toEqual(ADDRESS);
    await waitStatus(get, 'delivered');
    // the escrow got a notice with all four signed inners
    const c = await w.escrow.getCase(id);
    expect(c?.request && c.quote && c.funded).toBeTruthy();
    expect(await w.escrow.checkObligation(id)).toMatchObject({ paid: true });
    await w.user.release(id);
    const done = await waitStatus(get, 'completed');
    expect(done.completedTxid).toMatch(/^[0-9a-f]{64}$/);
    const paid = await w.chain.utxos(w.keys['shopper-1'].btcWallet.address);
    expect(paid.map((u) => u.value)).toEqual([28667]);
    expect(w.shopper.errors).toEqual([]);
    w.stop();
  });

  it('rejects a quote whose escrow address does not match', async () => {
    const w = await setup();
    const offers = await w.user.discoverOffers({ shopUrl: 'https://safe-shop.test/', region: 'JP-13', payment: 'btc-signet' });
    // shopper lies about timelocks after computing the address → mismatch
    const orig = w.sessions['shopper-1'].messenger.send.bind(w.sessions['shopper-1'].messenger);
    w.sessions['shopper-1'].messenger.send = (to, oid, type, body) =>
      orig(to, oid, type, type === 'order.quote' ? { ...(body as object), timelock: { t1: 1, t2: 999 } } : body);
    const o = await w.user.createOrder({ offer: offers[0], shopUrl: 'https://safe-shop.test/', region: 'JP-13', items: [{ sku: 'A-100', qty: 1 }], payment: 'btc-signet', address: ADDRESS });
    const q = await waitStatus(() => w.user.getOrder(o.id), 'quoted');
    expect(q.quoteCheck!.ok).toBe(false);
    expect(q.quoteCheck!.errors.join()).toMatch(/escrow_address/);
    await expect(w.user.acceptQuote(o.id)).rejects.toThrow(/validation/);
    w.stop();
  });

  it('dispute: evidence → escrow decrypts address → ruling → user countersigns', async () => {
    const w = await setup();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    await w.user.openDispute(id, { claim: 'wrong_item', text: '違う商品が届いた', requestedSplit: { user: '20000', shopper: '8667' } });
    const deadline = Date.now() + 3000;
    while ((await w.escrow.getCase(id))?.status !== 'open') {
      if (Date.now() > deadline) throw new Error('case not opened');
      await sleep(10);
    }
    expect(await w.escrow.decryptAddress(id)).toEqual(ADDRESS);
    expect(await w.escrow.missingEvidence(id)).toEqual([]);
    await expect(w.escrow.rule(id, { user: '99999999', shopper: '0' }, 'x')).rejects.toThrow(/add up/);
    await w.escrow.rule(id, { user: '20000', shopper: '8000' }, '一部返金'); // fee = 28667 - 28000 = 667
    const ruled = await waitStatus(get, 'ruled');
    expect(ruled.ruling!.split).toEqual({ user: '20000', shopper: '8000', escrow_fee: '667' });
    expect(await w.user.reviewRuling(id)).toEqual([]);
    await w.user.countersignRuling(id);
    await waitStatus(get, 'settled');
    w.chain.mine();
    const userCoins = await w.chain.utxos(w.keys['user-1'].btcWallet.address);
    expect(userCoins.some((u) => u.value === 20000)).toBe(true);
    const escrowCoins = await w.chain.utxos(w.keys['escrow-1'].btcWallet.address);
    expect(escrowCoins.map((u) => u.value).sort()).toEqual([1000, 667]);
    const deadline2 = Date.now() + 3000;
    while ((await w.escrow.getCase(id))?.status !== 'settled') {
      if (Date.now() > deadline2) throw new Error('escrow not told');
      await sleep(10);
    }
    w.stop();
  });

  it('refund after T2 and report to the operator', async () => {
    const w = await setup();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    await expect(w.user.refundAfterTimelock(id)).rejects.toThrow(/T2 not reached/);
    w.chain.mine(150);
    const refunded = await w.user.refundAfterTimelock(id);
    expect(refunded.status).toBe('refunded');
    await w.user.report(id, { subject: 'shopper', text: 'did not respond' });
    const deadline = Date.now() + 3000;
    while ((await w.operator.reports()).length === 0) {
      if (Date.now() > deadline) throw new Error('report not received');
      await sleep(10);
    }
    const [r] = await w.operator.reports();
    expect(r.report.subject).toBe(w.keys['shopper-1'].nostrPublicKey);
    expect(r.validEvidence).toBeGreaterThan(3);
    // operator drops the entry; the user no longer sees offers
    await w.operator.removeEntries((e) => e.shopper === r.report.subject);
    expect(await w.user.discoverOffers({ shopUrl: 'https://safe-shop.test/', region: 'JP-13', payment: 'btc-signet' })).toEqual([]);
    expect((await w.operator.currentList())!.version).toBe(2);
    w.stop();
  });
});
