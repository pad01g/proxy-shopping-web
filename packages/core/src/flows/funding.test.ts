/** Second review: interrupted funding, stuck requests, clock skew and dropped messages (user side). */
import { describe, expect, it } from 'vitest';
import { MSG } from '../nostr/messages.js';
import { ADDRESS, caseIn, placeFundedOrder, quotedOrder, setupWorld, waitFor, waitStatus } from '../testing/flow-helpers.js';
import { fundingStarted, provisionalFunding } from './user.js';

describe('item 5: an interrupted funding can be resumed, refunded or disputed', () => {
  it('a failure before any transaction leaves the order cancellable', async () => {
    const w = await setupWorld();
    const { id } = await quotedOrder(w);
    await w.user.acceptQuote(id);
    const utxos = w.chain.utxos.bind(w.chain);
    w.chain.utxos = async () => { throw new Error('esplora down'); };
    await expect(w.user.fund(id)).rejects.toThrow(/esplora down/);
    const o = (await w.user.getOrder(id))!;
    expect(o.status).toBe('funding');
    expect(fundingStarted(o)).toBe(false);
    w.chain.utxos = utxos;
    expect((await w.user.cancel(id)).status).toBe('cancelled');
    w.stop();
  });

  it('a broadcast whose answer was lost: no cancel, resume funds with the same tx, refund works without resuming', async () => {
    const w = await setupWorld();
    const { id, get } = await quotedOrder(w);
    await w.user.acceptQuote(id);
    const broadcast = w.chain.broadcast.bind(w.chain);
    // The transaction reaches the chain, but the reply does not reach us (tab closed, network).
    w.chain.broadcast = async (hex) => {
      await broadcast(hex);
      throw new Error('connection reset');
    };
    await expect(w.user.fund(id)).rejects.toThrow(/connection reset/);
    w.chain.broadcast = broadcast;
    const stuck = (await get())!;
    expect(stuck.funded).toBeUndefined();
    expect(fundingStarted(stuck)).toBe(true);
    expect(provisionalFunding(stuck)).toMatchObject({ asset: 'btc-signet', txid: stuck.fundingProgress!.btcTxid });
    await expect(w.user.cancel(id)).rejects.toThrow(/after funding/);
    // Resume (the UI's order-fund-resume): no second transaction, order.funded and the notice go out.
    const funded = await w.user.fund(id);
    expect(funded.status).toBe('funded');
    expect((funded.funded as { txid: string }).txid).toBe(stuck.fundingProgress!.btcTxid);
    await caseIn(w, id, 'notice');
    w.stop();
  });

  it('the T2 refund finishes an interrupted funding from the chain first', async () => {
    const w = await setupWorld();
    const { id, get } = await quotedOrder(w);
    await w.user.acceptQuote(id);
    const broadcast = w.chain.broadcast.bind(w.chain);
    w.chain.broadcast = async (hex) => {
      await broadcast(hex);
      throw new Error('connection reset');
    };
    await expect(w.user.fund(id)).rejects.toThrow();
    w.chain.broadcast = broadcast;
    w.chain.mine(200);
    await w.user.refundAfterTimelock(id);
    const o = await waitStatus(get, 'refunded');
    expect(o.funded).toBeDefined();
    w.stop();
  });
});

describe('item 17: a request that never got out can be resent or cancelled', () => {
  it('createOrder records the publish error; resendRequest delivers it', async () => {
    const w = await setupWorld();
    const [offer] = await w.user.discoverOffers({ shopUrl: 'https://safe-shop.test/', region: 'JP-13', payment: 'btc-signet' });
    const messenger = w.sessions['user-1'].messenger;
    const sendInner = messenger.sendInner.bind(messenger);
    messenger.sendInner = async () => { throw new Error('extension refused to sign the seal'); };
    const o = await w.user.createOrder({ offer, shopUrl: 'https://safe-shop.test/', region: 'JP-13', items: [{ sku: 'A-100', qty: 1 }], payment: 'btc-signet', address: ADDRESS });
    expect(o.status).toBe('requested');
    expect(o.lastError).toMatch(/refused/);
    messenger.sendInner = sendInner;
    await w.user.resendRequest(o.id);
    await waitStatus(() => w.user.getOrder(o.id), 'quoted');
    await waitFor(async () => w.shopper.orders.get(o.id)?.keyForEscrow, (k) => !!k, 'escrow key at the shopper');
    w.stop();
  });

  it('cancel works even when the shopper cannot be told', async () => {
    const w = await setupWorld();
    const [offer] = await w.user.discoverOffers({ shopUrl: 'https://safe-shop.test/', region: 'JP-13', payment: 'btc-signet' });
    const messenger = w.sessions['user-1'].messenger;
    messenger.sendInner = async () => { throw new Error('offline'); };
    const o = await w.user.createOrder({ offer, shopUrl: 'https://safe-shop.test/', region: 'JP-13', items: [{ sku: 'A-100', qty: 1 }], payment: 'btc-signet', address: ADDRESS });
    const c = await w.user.cancel(o.id);
    expect(c.status).toBe('cancelled');
    w.stop();
  });

  it('messages of our parties that are dropped are listed on the order', async () => {
    const w = await setupWorld();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    // e.g. an order.purchased without a total (schema: total is required)
    await w.sessions['shopper-1'].messenger.send(w.keys['user-1'].nostrPublicKey, id, MSG.purchased, { shop_order_id: 'X', evidence: [] });
    const o = await waitFor(get, (x) => !!x?.dropped?.length, 'dropped notice');
    expect(o.dropped![0]).toMatchObject({ type: MSG.purchased, from: 'shopper' });
    expect(o.dropped![0].reason).toMatch(/schema/);
    w.stop();
  });
});

describe('item 14: the timelock policy does not trust a chain clock far from ours', () => {
  it('a tip time 3 h ahead is an error with the default 2 h tolerance', async () => {
    const w = await setupWorld({}, { maxClockSkewSeconds: 7200 });
    w.chain.clockOffset = 3 * 3600;
    const { quoted } = await quotedOrder(w);
    expect(quoted.quoteCheck!.ok).toBe(false);
    expect(quoted.quoteCheck!.errors.join()).toMatch(/chain clock is 10800 s ahead/);
    w.chain.clockOffset = 3600;
    expect((await w.user.recheckQuote(quoted.id)).quoteCheck!.ok).toBe(true);
    w.stop();
  });
});

describe('item 8: messages no role accepts are neither stored nor acked', () => {
  it('a stranger\'s chat about an unknown order is refused', async () => {
    const w = await setupWorld();
    const dropped: string[] = [];
    w.sessions['user-1'].messenger.on('dropped', (d) => dropped.push(d.reason));
    // the shopper's messenger is not restricted, so use it as "a stranger" towards the user for an unknown order
    const inner = await w.sessions['shopper-1'].messenger.send(w.keys['user-1'].nostrPublicKey, 'ab'.repeat(16), MSG.chat, { text: 'hi' });
    await waitFor(async () => dropped, (d) => d.length > 0, 'refusal');
    expect(dropped[0]).toMatch(/no role accepts/);
    expect(await w.sessions['user-1'].messenger.inbox()).not.toContainEqual(inner);
    expect(await w.sessions['shopper-1'].messenger.isAcked(inner.id)).toBe(false);
    w.stop();
  });
});
