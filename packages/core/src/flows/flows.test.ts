import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { keyForEscrowSha256 } from '../delivery/delivery.js';
import { LocalSigner } from '../keys/signer.js';
import { KIND } from '../nostr/kinds.js';
import { MSG, type OrderRequest } from '../nostr/messages.js';
import { giftWrap, signInner } from '../nostr/giftwrap.js';
import { MemoryChain } from '../testing/memory-chain.js';
import { MemoryRelayNetwork } from '../testing/memory-transport.js';
import { createWorld } from '../testing/world.js';
import type { NostrTransport } from '../nostr/transport.js';
import { sleep } from '../util/time.js';
import type { UserOrder, UserOrderStatus } from './user.js';

const ADDRESS = { name: '山田太郎', postal_code: '160-0022', address: '東京都新宿区新宿1-1-1', phone: '03-0000-0000' };
const RELAYS = ['wss://relay-1.test', 'wss://relay-2.test'];

async function waitFor<T>(get: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v) && v != null) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

async function waitStatus(get: () => Promise<UserOrder | undefined>, status: UserOrderStatus, ms = 5000): Promise<UserOrder> {
  const end = Date.now() + ms;
  for (;;) {
    const o = await get();
    if (o?.status === status) return o;
    if (Date.now() > end) throw new Error(`timeout waiting for ${status}, at ${o?.status} ${o?.lastError ?? ''}`);
    await sleep(10);
  }
}

async function setup(opts: Parameters<typeof createWorld>[0]['shopper'] = {}) {
  const net = new MemoryRelayNetwork();
  const chain = new MemoryChain();
  const world = await createWorld({ relays: RELAYS, transport: () => net.transport(), chain, shopper: opts, chainPollMs: 50 });
  chain.fund(world.keys['user-1'].btcWallet.address, 1_000_000);
  return { net, chain, ...world };
}
type World = Awaited<ReturnType<typeof setup>>;

async function quotedOrder(w: World) {
  const offers = await w.user.discoverOffers({ shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', payment: 'btc-signet' });
  expect(offers).toHaveLength(1);
  const created = await w.user.createOrder({
    offer: offers[0], shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', items: [{ sku: 'A-100', qty: 1 }], payment: 'btc-signet', address: ADDRESS,
  });
  const get = () => w.user.getOrder(created.id);
  return { id: created.id, get, quoted: await waitStatus(get, 'quoted') };
}

async function placeFundedOrder(w: World) {
  const { id, get, quoted } = await quotedOrder(w);
  expect(quoted.quoteCheck).toMatchObject({ ok: true, errors: [], ackRequired: [] });
  expect(quoted.quoteCheck!.fx!.level).toBe('ok');
  expect(quoted.quote!.lock_amount).toBe('29667');
  await w.user.acceptQuote(id);
  await w.user.fund(id);
  w.chain.mine();
  return { id, get };
}

/** Wait until the escrow has a case in `status`. */
const caseIn = (w: World, id: string, status: string) =>
  waitFor(() => w.escrow.getCase(id), (c) => c?.status === status, `case ${status}`);

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
    expect(c?.noticeIds).toBeDefined();
    expect(await w.escrow.checkObligation(id)).toMatchObject({ paid: true });
    expect((await w.escrow.getCase(id))!.verification).toMatchObject({ ok: true, problems: [] });
    await w.user.release(id);
    const done = await waitStatus(get, 'completed');
    expect(done.completedTxid).toMatch(/^[0-9a-f]{64}$/);
    expect(done.escrowSpent?.txid).toBe(done.completedTxid);
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
    expect(q.quoteCheck!.errors.join()).toMatch(/T1 is only/);
    await expect(w.user.acceptQuote(o.id)).rejects.toThrow(/validation/);
    w.stop();
  });

  it('dispute: evidence → escrow decrypts address → ruling → user countersigns', async () => {
    const w = await setup();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    await w.user.openDispute(id, { claim: 'wrong_item', text: '違う商品が届いた', requestedSplit: { user: '20000', shopper: '8667' } });
    await caseIn(w, id, 'open');
    expect(await w.escrow.decryptAddress(id)).toEqual(ADDRESS);
    expect(await w.escrow.missingEvidence(id)).toEqual([]);
    await expect(w.escrow.rule(id, { user: '99999999', shopper: '0' }, 'x')).rejects.toThrow(/add up/);
    // fee = floor(2 % of 28667) = 573, so user + shopper must be 28094 (§4.8)
    await expect(w.escrow.rule(id, { user: '20000', shopper: '8100' }, 'x')).rejects.toThrow(/add up to 28094/);
    await expect(w.escrow.rule(id, { user: '20000', shopper: '8094', escrow_fee: '500' }, 'x')).rejects.toThrow(/escrow_fee must be 573/);
    await w.escrow.rule(id, { user: '20000', shopper: '8094' }, '一部返金');
    await expect(w.escrow.rule(id, { user: '0', shopper: '28094' }, 'again')).rejects.toThrow(/already ruled/);
    const ruled = await waitStatus(get, 'ruled');
    expect(ruled.ruling!.split).toEqual({ user: '20000', shopper: '8094', escrow_fee: '573' });
    expect(await w.user.reviewRuling(id)).toEqual([]);
    await w.user.countersignRuling(id);
    await waitStatus(get, 'settled');
    w.chain.mine();
    const userCoins = await w.chain.utxos(w.keys['user-1'].btcWallet.address);
    expect(userCoins.some((u) => u.value === 20000)).toBe(true);
    const escrowCoins = await w.chain.utxos(w.keys['escrow-1'].btcWallet.address);
    expect(escrowCoins.map((u) => u.value).sort()).toEqual([1000, 573]);
    await caseIn(w, id, 'settled');
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
    await waitFor(() => w.operator.reports(), (r) => r.length > 0, 'report');
    const [r] = await w.operator.reports();
    expect(r.report.subject).toBe(w.keys['shopper-1'].nostrPublicKey);
    expect(r.validEvidence).toBeGreaterThan(3);
    // operator drops the entry; the user no longer sees offers
    const before = (await w.operator.currentList())!.version;
    await w.operator.removeEntries((e) => e.shopper === r.report.subject);
    expect(await w.user.discoverOffers({ shopUrl: 'https://safe-shop.test/', region: 'JP-13', payment: 'btc-signet' })).toEqual([]);
    expect((await w.operator.currentList())!.version).toBeGreaterThan(before);
    w.stop();
  });
});

describe('replies that beat our own publish', () => {
  it('keeps a quote that arrives while the request is still being published', async () => {
    const net = new MemoryRelayNetwork();
    const chain = new MemoryChain();
    // the user's relays deliver at once but acknowledge slowly, like a busy relay; the shopper answers instantly
    const slow = (): NostrTransport => {
      const t = net.transport();
      return { ...t, publish: async (relays, ev) => { const r = await t.publish(relays, ev); await sleep(300); return r; } };
    };
    const w = await createWorld({ relays: RELAYS, transport: (name) => (name === 'user-1' ? slow() : net.transport()), chain, chainPollMs: 50 });
    chain.fund(w.keys['user-1'].btcWallet.address, 1_000_000);
    const [offer] = await w.user.discoverOffers({ shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', payment: 'btc-signet' });
    const created = await w.user.createOrder({
      offer, shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', items: [{ sku: 'A-100', qty: 1 }], payment: 'btc-signet', address: ADDRESS,
    });
    await waitStatus(() => w.user.getOrder(created.id), 'quoted');
    w.stop();
  });
});

describe('P1 key_proof and P2 order.escrow_key', () => {
  it('the request proves its chain key, and the escrow key travels separately', async () => {
    const w = await setup();
    const { id, get } = await placeFundedOrder(w);
    const o = (await get())!;
    expect(o.request.key_proof).toMatch(/^[0-9a-f]{128}$/);
    expect(o.request.delivery).not.toHaveProperty('key_for_escrow');
    expect(o.request.delivery.key_for_escrow_sha256).toBe(keyForEscrowSha256(o.keyForEscrow));
    expect(o.messages.map((m) => m.tags.find((t) => t[0] === 't')?.[1])).toContain(MSG.escrowKey);
    await waitFor(async () => w.shopper.orders.get(id)?.keyForEscrow, (k) => k === o.keyForEscrow, 'shopper got the key');
    // The escrow.notice copy lets the escrow see the order but not the address.
    await caseIn(w, id, 'notice');
    await expect(w.escrow.decryptAddress(id)).rejects.toThrow(/not received/);
    w.stop();
  });

  it('the shopper refuses a request whose key_proof does not verify', async () => {
    const w = await setup();
    const orig = w.sessions['user-1'].messenger.sign.bind(w.sessions['user-1'].messenger);
    w.sessions['user-1'].messenger.sign = (to, oid, type, body) =>
      orig(to, oid, type, type === MSG.request ? { ...(body as OrderRequest), key_proof: '00'.repeat(64) } : body);
    const [offer] = await w.user.discoverOffers({ shopUrl: 'https://safe-shop.test/', region: 'JP-13', payment: 'btc-signet' });
    const o = await w.user.createOrder({ offer, shopUrl: 'https://safe-shop.test/', region: 'JP-13', items: [{ sku: 'A-100', qty: 1 }], payment: 'btc-signet', address: ADDRESS });
    const r = await waitStatus(() => w.user.getOrder(o.id), 'rejected');
    expect(r.quote?.detail).toMatch(/key_proof/);
    w.stop();
  });

  it('the escrow ignores a key_for_escrow whose hash the request does not commit to', async () => {
    const w = await setup();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    const user = w.sessions['user-1'];
    // A party hands the escrow some other key plus its own ciphertext: neither may be used.
    const fake = await user.signer.nip44Encrypt(w.keys['escrow-1'].nostrPublicKey, 'ab'.repeat(32));
    await user.messenger.send(w.keys['escrow-1'].nostrPublicKey, id, MSG.disputeOpen, {
      claim: 'other', text: 'x', evidence: { messages: [], tracking: [], purchase_evidence: [], delivery_key_for_escrow: fake, delivery_ciphertext: 'AAAA' },
    });
    const c = await caseIn(w, id, 'open');
    expect(c.deliveryKeyForEscrow).toBeUndefined();
    await expect(w.escrow.decryptAddress(id)).rejects.toThrow();
    // The user's own evidence carries the right key.
    await w.user.sendEvidence(id);
    await waitFor(() => w.escrow.getCase(id), (x) => !!x?.deliveryKeyForEscrow, 'key accepted');
    expect(await w.escrow.decryptAddress(id)).toEqual(ADDRESS);
    w.stop();
  });
});

describe('item 1: cooperative refund is never auto-signed', () => {
  it('records the offer, and only an explicit accept countersigns it', async () => {
    const w = await setup();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    await w.shopper.offerRefund(id);
    const offered = await waitFor(get, (o) => !!o?.refundOffer, 'refund offer');
    expect(offered.refundOffer!.problems).toEqual([]);
    expect(offered.status).toBe('delivered'); // nothing signed or broadcast yet
    expect(offered.refundTxid).toBeUndefined();
    const done = await w.user.acceptRefundOffer(id);
    expect(done.status).toBe('refunded');
    w.chain.mine();
    expect((await w.chain.utxos(w.keys['user-1'].btcWallet.address)).some((u) => u.value === 28667)).toBe(true);
    w.stop();
  });

  it('flags offers that pay elsewhere, overpay the miner or spend other inputs', async () => {
    const w = await setup();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    // miner fee far above payout_fee_reserve: everything else goes to the user
    await w.shopper.offerRefund(id, { outputs: (user, lock, reserve) => [{ address: user, amount: lock - reserve - 20_000n }] });
    let o = await waitFor(get, (x) => !!x?.refundOffer, 'offer 1');
    expect(o.refundOffer!.problems.join()).toMatch(/miner fee/);
    await expect(w.user.acceptRefundOffer(id)).rejects.toThrow(/template/);
    // an extra output to the shopper
    const shopperAddr = w.keys['shopper-1'].btcWallet.address;
    await w.shopper.offerRefund(id, { outputs: (user, lock, reserve) => [{ address: user, amount: lock - reserve - 1000n }, { address: shopperAddr, amount: 1000n }] });
    const firstId = o.refundOffer!.inner.id;
    o = await waitFor(get, (x) => x?.refundOffer?.inner.id !== firstId, 'offer 2');
    expect(o.refundOffer!.problems.join()).toMatch(/other than ours/);
    expect((await get())!.status).toBe('delivered');
    w.stop();
  });
});

describe('item 4: peer-asserted terminal states', () => {
  it('order.completed without an on-chain spend does not complete the order', async () => {
    const w = await setup();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    await w.shopper.claimCompleted(id, 'cd'.repeat(32));
    const o = await waitFor(get, (x) => !!x?.pendingSettlement, 'claim recorded');
    await sleep(200); // several poll rounds
    expect((await get())!.status).toBe('delivered');
    expect(o.escrowSpent).toBeUndefined(); // so the T2 refund and dispute stay available
    await w.user.openDispute(id, { claim: 'not_released', text: 'claimed completion but did not pay' });
    w.stop();
  });

  it('ignores a ruling when no dispute is open and a shopper cancel after funding', async () => {
    const w = await setup();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    const escrow = w.sessions['escrow-1'];
    await escrow.messenger.send(w.keys['user-1'].nostrPublicKey, id, MSG.ruling, {
      split: { user: '0', shopper: '28667', escrow_fee: '0' }, reason: 'x', asset: 'btc-signet', psbt: 'AAAA',
    });
    await w.sessions['shopper-1'].messenger.send(w.keys['user-1'].nostrPublicKey, id, MSG.cancel, { reason: 'bye' });
    await waitFor(get, (o) => (o?.timeline.length ?? 0) >= 2 && o!.timeline.some((t) => t.kind === MSG.cancel), 'messages handled');
    await waitFor(get, (o) => !!o?.timeline.some((t) => t.kind === MSG.ruling), 'ruling handled');
    const o = (await get())!;
    expect(o.ruling).toBeUndefined();
    expect(o.status).toBe('delivered');
    w.stop();
  });

  it('the escrow waits for the chain before settling on dispute.countersigned', async () => {
    const w = await setup();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    await w.user.openDispute(id, { claim: 'wrong_item', text: 'x' });
    await caseIn(w, id, 'open');
    await w.escrow.rule(id, { user: '20000', shopper: '8094' }, 'r');
    await w.sessions['shopper-1'].messenger.send(w.keys['escrow-1'].nostrPublicKey, id, MSG.countersigned, { txid: 'ef'.repeat(32) });
    await waitFor(() => w.escrow.getCase(id), (c) => !!c?.pendingSettlement, 'claim');
    await sleep(200);
    expect((await w.escrow.getCase(id))!.status).toBe('ruled');
    w.stop();
  });
});

describe('item 3: rate deviation needs an explicit acknowledgement', () => {
  it('acceptQuote throws unless acknowledgeRateDeviation is set', async () => {
    // The shopper quotes BTC/JPY 20,000,000 against our 15,000,000 (33 %).
    const w = await setup({ rates: { 'btc-signet': 20_000_000, 'usdc-evm': 150 } });
    const { id, quoted } = await quotedOrder(w);
    expect(quoted.quoteCheck!.ok).toBe(true);
    expect(quoted.quoteCheck!.fx!.level).toBe('strong');
    expect(quoted.quoteCheck!.ackRequired.join()).toMatch(/deviates strongly/);
    await expect(w.user.acceptQuote(id)).rejects.toThrow(/acknowledgement/);
    expect((await w.user.acceptQuote(id, { acknowledgeRateDeviation: true })).status).toBe('accepted');
    w.stop();
  });

  it('no rate sources is not a silent pass', async () => {
    const w = await setup();
    w.sessions['user-1'].rates = [];
    const { id, quoted } = await quotedOrder(w);
    expect(quoted.quoteCheck!.ackRequired.join()).toMatch(/no rate sources/);
    await expect(w.user.acceptQuote(id)).rejects.toThrow(/acknowledgement/);
    w.stop();
  });
});

describe('item 8: funding is never sent twice', () => {
  it('a failed broadcast is retried with the same transaction', async () => {
    const w = await setup();
    const { id } = await quotedOrder(w);
    await w.user.acceptQuote(id);
    const orig = w.chain.broadcast.bind(w.chain);
    let fail = true;
    w.chain.broadcast = async (hex) => {
      if (fail) {
        fail = false;
        throw new Error('network down');
      }
      return orig(hex);
    };
    await expect(w.user.fund(id)).rejects.toThrow(/network down/);
    const first = (await w.user.getOrder(id))!.fundingProgress!.btcTxid!;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const funded = await w.user.fund(id);
    expect(funded.status).toBe('funded');
    expect((funded.funded as { txid: string }).txid).toBe(first);
    // exactly one funding transaction reached the chain
    expect((await w.chain.txStatus(first))).toBeDefined();
    const change = (await w.chain.utxos(w.keys['user-1'].btcWallet.address)).map((u) => u.txid);
    expect(change).toEqual([first]);
    w.stop();
  });

  it('previews the funding with a capped fee rate', async () => {
    const w = await setup();
    const { id } = await quotedOrder(w);
    await w.user.acceptQuote(id);
    w.chain.feeRate = 5000; // a hostile Esplora estimate
    const p = await w.user.previewFunding(id);
    expect(p.feeRate).toBe(50);
    expect(p.total).toBe(p.lock + p.upfrontFee + p.networkFee!);
    expect(p.recipients.map((r) => r.label)).toEqual(['escrow', 'escrow fee']);
    w.stop();
  });
});

describe('item 11: escrow case assembly (§4.7)', () => {
  it('a stranger cannot open a case with a copied request', async () => {
    const w = await setup();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    const o = (await get())!;
    const escrowPk = w.keys['escrow-1'].nostrPublicKey;
    // Mallory re-signs the user's request (same keys and key_proof) for a fresh order id.
    const mallory = new LocalSigner(generateSecretKey());
    const orderId = 'ab'.repeat(16);
    const forged = await signInner(mallory, { recipient: o.shopper, orderId, type: MSG.request, body: o.request });
    await w.net.transport().publish(RELAYS, await giftWrap(mallory, await signInner(mallory, {
      recipient: escrowPk, orderId, type: MSG.disputeOpen, body: { claim: 'other', text: 'mine', evidence: { messages: [forged], tracking: [], purchase_evidence: [] } },
    }), escrowPk));
    await sleep(100);
    expect(await w.escrow.getCase(orderId)).toBeUndefined();
    w.stop();
  });

  it('evidence that contradicts the notice is ignored and recorded', async () => {
    const w = await setup();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    const user = w.sessions['user-1'];
    const o = (await get())!;
    const other = await signInner(user.signer, { recipient: o.shopper, orderId: id, type: MSG.request, body: { ...o.request, shop_url: 'https://other.test/' } });
    await user.messenger.send(w.keys['escrow-1'].nostrPublicKey, id, MSG.disputeOpen, {
      claim: 'other', text: 'x', evidence: { messages: [other], tracking: [], purchase_evidence: [] },
    });
    const c = await caseIn(w, id, 'open');
    expect(c.request!.shop_url).toBe('https://safe-shop.test/');
    expect(c.conflicts!.join()).toMatch(/differs from the notice/);
    w.stop();
  });

  it('an upfront fee already used by another order does not oblige the escrow', async () => {
    const w = await setup();
    const { id, get } = await placeFundedOrder(w);
    await waitStatus(get, 'delivered');
    const funded = (await get())!.funded as { txid: string };
    await w.sessions['escrow-1'].storage.put(`escrow/fee-used/btc:${funded.txid}`, 'ff'.repeat(16));
    const ob = await w.escrow.checkObligation(id);
    expect(ob.paid).toBe(false);
    expect(ob.detail).toMatch(/already used/);
    w.stop();
  });
});

describe('item 9: versions never roll back', () => {
  it('nextVersion is at least now, even when local state and relays are gone', async () => {
    const w = await setup();
    const s = w.sessions['operator-1'];
    const published = (await w.operator.currentList())!.version;
    // Same key, fresh storage, relays that return nothing.
    const { Session } = await import('./session.js');
    const { MemoryStorage } = await import('../storage/memory.js');
    const empty = new MemoryRelayNetwork();
    const again = new Session({ keys: s.keys, transport: empty.transport(), storage: new MemoryStorage(), config: s.config });
    const v = await again.nextVersion(KIND.operatorList, s.network);
    expect(v).toBeGreaterThanOrEqual(published);
    expect(v).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000));
    // and a known high version still wins
    const sk = generateSecretKey();
    const high = finalizeEvent({ kind: KIND.operatorList, created_at: 1, tags: [['d', 'n'], ['v', String(4e9)]], content: '{}' }, sk);
    await empty.transport().publish(s.config.relays, high);
    const mine = new Session({ keys: s.keys, signer: new LocalSigner(sk), transport: empty.transport(), storage: new MemoryStorage(), config: s.config });
    expect(getPublicKey(sk)).toBe(await mine.pubkey());
    expect(await mine.nextVersion(KIND.operatorList, 'n')).toBe(4e9 + 1);
    w.stop();
  });
});
