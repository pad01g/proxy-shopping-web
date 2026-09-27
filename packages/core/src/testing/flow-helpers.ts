/** Helpers shared by the in-memory flow tests (order placement, waiting for states). */
import type { UserOrder, UserOrderStatus } from '../flows/user.js';
import { sleep } from '../util/time.js';
import { MemoryChain } from './memory-chain.js';
import { MemoryRelayNetwork } from './memory-transport.js';
import { createWorld, type WorldOptions } from './world.js';

export const ADDRESS = { name: '山田太郎', postal_code: '160-0022', address: '東京都新宿区新宿1-1-1', phone: '03-0000-0000' };
export const RELAYS = ['wss://relay-1.test', 'wss://relay-2.test'];

export async function waitFor<T>(get: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v) && v != null) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

export async function waitStatus(get: () => Promise<UserOrder | undefined>, status: UserOrderStatus, ms = 5000): Promise<UserOrder> {
  const end = Date.now() + ms;
  for (;;) {
    const o = await get();
    if (o?.status === status) return o;
    if (Date.now() > end) throw new Error(`timeout waiting for ${status}, at ${o?.status} ${o?.lastError ?? ''}`);
    await sleep(10);
  }
}

/** A world on in-memory relays and chain, with 0.01 BTC in user-1's wallet. */
export async function setupWorld(shopper: WorldOptions['shopper'] = {}, more: Partial<WorldOptions> = {}) {
  const net = new MemoryRelayNetwork();
  const chain = new MemoryChain();
  const world = await createWorld({ relays: RELAYS, transport: () => net.transport(), chain, shopper, chainPollMs: 50, ...more });
  chain.fund(world.keys['user-1'].btcWallet.address, 1_000_000);
  return { net, chain, ...world };
}
export type TestWorld = Awaited<ReturnType<typeof setupWorld>>;

/** A BTC order of one A-100 at safe-shop.test, waited for until quoted. */
export async function quotedOrder(w: TestWorld, items = [{ sku: 'A-100', qty: 1 }]) {
  const offers = await w.user.discoverOffers({ shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', payment: 'btc-signet' });
  if (offers.length !== 1) throw new Error(`expected one offer, got ${offers.length}`);
  const created = await w.user.createOrder({
    offer: offers[0], shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', items, payment: 'btc-signet', address: ADDRESS,
  });
  const get = () => w.user.getOrder(created.id);
  return { id: created.id, get, quoted: await waitStatus(get, 'quoted') };
}

/** Accept, fund and mine one block. */
export async function placeFundedOrder(w: TestWorld) {
  const { id, get, quoted } = await quotedOrder(w);
  await w.user.acceptQuote(id);
  await w.user.fund(id);
  w.chain.mine();
  return { id, get, quoted };
}

/** Wait until the escrow has a case in `status`. */
export const caseIn = (w: TestWorld, id: string, status: string, ms?: number) =>
  waitFor(() => w.escrow.getCase(id), (c) => c?.status === status, `case ${status}`, ms);
