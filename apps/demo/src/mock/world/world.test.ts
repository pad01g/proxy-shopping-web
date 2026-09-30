/**
 * The mock world against core's real role clients (as the demo page wires them): every scenario of the guide,
 * end to end — gift-wrapped messages over the mock relays, real BTC transactions checked by the mock chain,
 * real Safe contracts in the mock EVM, and the mock shopper-1 node.
 */
import {
  CoordinatorClient, EscrowClient, KeySet, MemoryStorage, OperatorClient, Session, UserClient, generateMnemonic, sleep,
  type ListEntry, type UserOrder, type UserOrderStatus,
} from '@proxy-shopping/core';
import { afterEach, describe, expect, it } from 'vitest';
import { LAB_DEPLOYMENTS } from './evm/genesis';
import { MOCK_MAX_CLOCK_SKEW, MOCK_NETWORK, MOCK_RELAYS, MOCK_TIMELOCK_POLICY, MockWorld } from './world';

const ADDRESS = { name: '山田太郎', postal_code: '160-0022', address: '東京都新宿区新宿1-1-1', phone: '03-0000-0000' };

async function waitFor<T>(get: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end && (globalThis as { dump?: () => Promise<string> }).dump) console.log(await (globalThis as { dump?: () => Promise<string> }).dump!());
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}: ${JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))?.slice(0, 400)}`);
    await sleep(50);
  }
}

let worlds: MockWorld[] = [];
afterEach(() => {
  for (const w of worlds) w.stop();
  worlds = [];
});

async function setup() {
  const world = await MockWorld.open(new MemoryStorage(), { autoMineMs: 50, tickMs: 100 });
  worlds.push(world);
  const keys = {
    coordinator: KeySet.fromMnemonic('message occur banana believe spring shadow deer manage ginger mistake mad process'),
    operator: KeySet.fromMnemonic(generateMnemonic()),
    escrow: KeySet.fromMnemonic(generateMnemonic()),
    user: KeySet.fromMnemonic(generateMnemonic()),
  };
  const session = (k: KeySet) => new Session({
    keys: k, transport: world.transport(), storage: new MemoryStorage(),
    config: {
      network: MOCK_NETWORK, relays: MOCK_RELAYS, coordinators: [world.coordinator], retryIntervalMs: 1000,
      timelockPolicy: MOCK_TIMELOCK_POLICY, maxClockSkewSeconds: MOCK_MAX_CLOCK_SKEW, allowPrivateEndpoints: true,
    },
    chain: world.btc, evm: world.evmClient(k), rates: world.rateSources(),
  });
  const s = { coordinator: session(keys.coordinator), operator: session(keys.operator), escrow: session(keys.escrow), user: session(keys.user) };
  const coordinator = new CoordinatorClient(s.coordinator);
  const operator = new OperatorClient(s.operator).attach();
  const escrow = new EscrowClient(s.escrow, { deployments: LAB_DEPLOYMENTS, chainPollMs: 200 }).attach();
  const user = new UserClient(s.user, { deployments: LAB_DEPLOYMENTS, chainPollMs: 200 }).attach();
  for (const x of [s.operator, s.escrow, s.user]) {
    await x.start();
    await x.publishInboxRelays();
  }
  // The guide's preparation (prepareSteps): delegate, list, escrow profile, faucet.
  await coordinator.delegate(keys.operator.nostrPublicKey, 'demo');
  const shopper = world.shopperKeys.nostrPublicKey;
  const entries: ListEntry[] = ['JP-13', 'US'].map((region) => ({ region, shopper, escrow: keys.escrow.nostrPublicKey, shops: ['*'], payments: ['btc-signet', 'usdc-evm'], tags: [], escrow_sla_days: 14 }));
  const d = LAB_DEPLOYMENTS;
  await operator.publish({
    ...(await operator.draft('demo operator')),
    regions: ['JP-13', 'US'],
    relays: MOCK_RELAYS.map((url) => ({ url, retention_days: 30 })),
    chain: { btc: { network: 'signet', esplora: ['https://esplora.test'] }, evm: { chain_id: d.chain_id, rpc: ['https://evm.test'], usdc: d.usdc, safe: { ...d.safe, module: d.module, setup: d.setup } } },
    entries,
    report_to: keys.operator.nostrPublicKey,
  });
  await escrow.publishProfile({ name: 'demo escrow', upfront_fee: { bps: 50, min_sats: '1000', min_usdc: '0.50' }, dispute_fee_bps: 200 });
  await world.faucetBtc(keys.user.btcWallet.address, 1_000_000);
  await world.faucetEvm(keys.user.evmAddress, { eth: '1', usdc: '1000' });
  // The node picks up the list and the profile (prep-node-trust).
  await waitFor(async () => world.nodeTrust(), (t) => t.effective.some((e) => e.escrow === keys.escrow.nostrPublicKey) && t.events.some((e) => e.pubkey === keys.escrow.nostrPublicKey), 'node trust');

  (globalThis as { dump?: () => Promise<string> }).dump = async () => JSON.stringify({ node: await world.nodeOrders(), errors: world.shopper.errors, orders: (await user.listOrders()).map((o) => ({ s: o.status, t: o.timeline.slice(-6), d: o.dropped })) }, null, 1);
  const order = async (shopUrl: string, region: string, sku: string, payment: 'btc-signet' | 'usdc-evm') => {
    const offers = await user.discoverOffers({ shopUrl, region, payment, refresh: true });
    const offer = offers.find((o) => o.entry.escrow === keys.escrow.nostrPublicKey && o.entry.shopper === shopper);
    if (!offer) throw new Error(`no offer (${offers.length})`);
    const o = await user.createOrder({ offer, shopUrl, region, items: [{ sku, qty: 1 }], payment, address: ADDRESS });
    return o.id;
  };
  const status = (id: string, st: UserOrderStatus | UserOrderStatus[], ms?: number) =>
    waitFor(() => user.getOrder(id), (o) => !!o && ([] as string[]).concat(st).includes(o.status), `order ${st}`, ms) as Promise<UserOrder>;
  const nodeState = (id: string, st: string, ms?: number) => waitFor(() => world.nodeOrder(id).catch(() => undefined), (o) => o?.state === st, `node ${st}`, ms);
  return { world, keys, user, escrow, operator, coordinator, order, status, nodeState, shopper };
}

describe('mock world', () => {
  it('normal-btc: quote, fund, purchase, delivery, release — the shopper countersigns and broadcasts', async () => {
    const t = await setup();
    const id = await t.order('https://safe-shop.test/', 'JP-13-13104', 'A-100', 'btc-signet');
    const quoted = await t.status(id, 'quoted');
    expect(quoted.quoteCheck?.errors).toEqual([]);
    expect(quoted.quoteCheck?.ok).toBe(true);
    // 3200 + 800 + 300 (min fee) JPY at 15,000,000 JPY/BTC + 1000 sats reserve
    expect(quoted.quote?.lock_amount).toBe('29667');
    expect(quoted.quote?.fx?.rate).toBe('15000000');
    await t.user.acceptQuote(id);
    await t.user.fund(id);
    await t.status(id, 'delivered', 60_000);
    await t.user.release(id);
    const done = await t.status(id, 'completed', 30_000);
    expect(done.completedTxid).toMatch(/^[0-9a-f]{64}$/);
    const node = await t.nodeState(id, 'completed');
    expect(node!.payout_by).toBe('release');
    expect(node!.risk_score).toBe(100);
    // The shopper's wallet got the lock minus the reserve.
    expect((await t.world.btc.utxos(t.world.shopperKeys.btcWallet.address)).reduce((s, u) => s + u.value, 0)).toBe(29667 - 1000);
  }, 120_000);

  it('normal-usdc: a real Safe, funded and paid out 2-of-3 (the shopper pays the gas)', async () => {
    const t = await setup();
    await t.world.faucetEvm(t.world.shopperKeys.evmAddress, { eth: '10', usdc: '0' });
    const id = await t.order('https://us-shop.test/', 'US', 'U-100', 'usdc-evm');
    const quoted = await t.status(id, 'quoted');
    expect(quoted.quoteCheck?.errors).toEqual([]);
    // 25.00 + 10.00 + 2.00 (300 JPY) USD at 1 USD/USDC
    expect(quoted.quote?.lock_amount).toBe('37000000');
    await t.user.acceptQuote(id);
    await t.user.fund(id);
    await t.status(id, 'delivered', 60_000);
    await t.user.release(id);
    const done = await t.status(id, 'completed', 30_000);
    expect(done.completedTxid).toMatch(/^0x[0-9a-f]{64}$/);
    const shopperEvm = t.world.evmClient(t.world.shopperKeys);
    expect(await shopperEvm.usdcBalance()).toBe(37_000_000n);
  }, 120_000);

  it('risky: the risky shop is refused with reason risk', async () => {
    const t = await setup();
    const id = await t.order('http://risky-shop.test/', 'US', 'R-100', 'btc-signet');
    const o = await t.status(id, 'rejected');
    expect(o.quote?.reject_reason).toBe('risk');
    expect(o.quote?.detail).toMatch(/risk score 0 below 70/);
  }, 60_000);

  it('cash-only shop outside the cash regions is refused with reason region', async () => {
    const t = await setup();
    const id = await t.order('https://cash-store.test/', 'JP-13-13104', 'C-100', 'btc-signet');
    const o = await t.status(id, 'rejected');
    expect(o.quote?.reject_reason).toBe('region');
  }, 60_000);

  it('sold-out: the purchase fails before payment and the user countersigns the refund offer', async () => {
    const t = await setup();
    const id = await t.order('https://safe-shop.test/', 'JP-13-13104', 'SOLDOUT-100', 'btc-signet');
    await t.status(id, 'quoted');
    await t.user.acceptQuote(id);
    await t.user.fund(id);
    await waitFor(() => t.user.getOrder(id), (o) => !!o?.refundOffer, 'refund offer', 60_000);
    expect(await t.user.reviewRefundOffer(id)).toEqual([]);
    await t.user.acceptRefundOffer(id);
    const o = await t.status(id, 'refunded', 30_000);
    expect(o.refundTxid).toMatch(/^[0-9a-f]{64}$/);
    await t.nodeState(id, 'closed', 30_000);
  }, 120_000);

  it('dispute-refund: delivery fails, the escrow rules for the user, the user countersigns', async () => {
    const t = await setup();
    const id = await t.order('https://safe-shop.test/', 'JP-13-13104', 'FAIL-100', 'btc-signet');
    await t.status(id, 'quoted');
    await t.user.acceptQuote(id);
    await t.user.fund(id);
    await t.status(id, 'delivery_failed', 60_000);
    await t.user.openDispute(id, { claim: 'not_delivered', text: 'never arrived' });
    await waitFor(() => t.escrow.getCase(id), (c) => !!c && c.disputes.length > 0 && c.status === 'open', 'case open');
    expect((await t.escrow.decryptAddress(id)).address).toContain('東京都新宿区');
    const terms = await t.escrow.rulingTerms(id);
    await t.escrow.rule(id, { user: String(terms.distributable), shopper: '0' }, 'refund');
    await t.status(id, 'ruled', 30_000);
    expect(await t.user.reviewRuling(id)).toEqual([]);
    await t.user.countersignRuling(id);
    const o = await t.status(id, 'settled', 30_000);
    expect(o.settledTxid).toMatch(/^[0-9a-f]{64}$/);
    // The node did not countersign (nothing for it) and learns the settlement from the chain.
    await t.nodeState(id, 'settled', 30_000);
  }, 120_000);

  it('fraud: the escrow rules everything to the shopper, which countersigns by itself', async () => {
    const t = await setup();
    const id = await t.order('https://safe-shop.test/', 'JP-13-13104', 'FAIL-100', 'btc-signet');
    await t.status(id, 'quoted');
    await t.user.acceptQuote(id);
    await t.user.fund(id);
    await t.status(id, 'delivery_failed', 60_000);
    await t.user.openDispute(id, { claim: 'not_delivered', text: 'never arrived' });
    await waitFor(() => t.escrow.getCase(id), (c) => !!c && c.disputes.length > 0 && c.status === 'open', 'case open');
    const terms = await t.escrow.rulingTerms(id);
    await t.escrow.rule(id, { user: '0', shopper: String(terms.distributable) }, 'fraud');
    const o = await t.status(id, 'settled', 30_000);
    expect(o.ruling?.split.user).toBe('0');
    const node = await t.nodeState(id, 'settled');
    expect(node!.payout_by).toBe('ruling');
    await t.user.report(id, { subject: t.keys.escrow.nostrPublicKey, text: 'fraud' });
    await waitFor(() => t.operator.reports(), (r) => r.some((x) => x.report.order_id === id), 'report');
    await t.operator.removeEntries((e) => e.escrow === t.keys.escrow.nostrPublicKey);
    const offers = await t.user.discoverOffers({ shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', payment: 'btc-signet', refresh: true });
    expect(offers.some((x) => x.entry.escrow === t.keys.escrow.nostrPublicKey)).toBe(false);
  }, 120_000);

  it('timelock-t2: with the shopper paused, the user takes the coins back alone after T2', async () => {
    const t = await setup();
    const id = await t.order('https://safe-shop.test/', 'JP-13-13104', 'A-100', 'btc-signet');
    const q = await t.status(id, 'quoted');
    await t.user.acceptQuote(id);
    await t.nodeState(id, 'accepted');
    await t.world.shopper.pause(1800);
    expect(t.world.nodeStatus().paused_until).toBeGreaterThan(0);
    await t.user.fund(id);
    await t.status(id, 'funded', 30_000);
    // Before T2 the chain refuses the refund (non-final).
    await expect(t.user.refundAfterTimelock(id)).rejects.toThrow();
    t.world.mine(q.quote!.timelock!.t2 - t.world.btc.height + 1);
    await t.user.refundAfterTimelock(id);
    const o = await t.status(id, 'refunded', 30_000);
    expect(o.refundTxid).toMatch(/^[0-9a-f]{64}$/);
    await t.world.shopper.resume();
    expect(t.world.nodeStatus().paused_until).toBeUndefined();
  }, 120_000);

  it('keeps its state in storage: a reopened world has the same chains, relays and node orders', async () => {
    const storage = new MemoryStorage();
    const a = await MockWorld.open(storage, { autoMineMs: 0, tickMs: 100 });
    const k = KeySet.fromMnemonic(generateMnemonic());
    await a.faucetBtc(k.btcWallet.address, 123_456);
    await a.faucetEvm(k.evmAddress, { eth: '2', usdc: '5' });
    await a.evmTime(3600);
    await a.flush();
    a.stop();
    const b = await MockWorld.open(storage, { autoMineMs: 0, tickMs: 100 });
    worlds.push(b);
    expect((await b.btc.utxos(k.btcWallet.address))[0].value).toBe(123_456);
    expect(await b.evmClient(k).usdcBalance()).toBe(5_000_000n);
    expect(b.heights()).toEqual(a.heights());
    expect(b.relays.count()).toBe(a.relays.count());
    await b.reset();
    expect(await b.btc.utxos(k.btcWallet.address)).toEqual([]);
  }, 60_000);
});
