import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EsploraClient } from '../../src/btc/esplora.js';
import type { UserOrder, UserOrderStatus } from '../../src/flows/user.js';
import { PoolTransport } from '../../src/nostr/transport.js';
import { createWorld, LAB_MNEMONICS } from '../../src/testing/world.js';
import { KeySet } from '../../src/keys/derive.js';
import { sleep } from '../../src/util/time.js';
import { fundedEvm } from './anvil.js';
import { BitcoindRpc, startEsploraShim } from '../../src/testing/bitcoind.js';
import { ENV, loadDeployments, skipReason } from './env.js';

const d = loadDeployments();
const skip = skipReason(['relay', 'bitcoind', 'anvil']) ?? (d ? undefined : 'no deployments file');
if (skip) console.warn(`[flows.it] skipped: ${skip}`);

const ADDRESS = { name: '山田太郎', postal_code: '160-0022', address: '東京都新宿区新宿1-1-1', phone: '03-0000-0000' };
const BURN = KeySet.fromMnemonic(LAB_MNEMONICS.faucet).btcWallet.address;

describe.skipIf(!!skip)('end-to-end flows over relay + bitcoind + anvil', () => {
  let rpc: BitcoindRpc;
  let close: () => void;
  let world: Awaited<ReturnType<typeof createWorld>>;
  let miner: ReturnType<typeof setInterval>;

  beforeAll(async () => {
    rpc = new BitcoindRpc(ENV.bitcoind!);
    await rpc.waitReady();
    const shim = await startEsploraShim(rpc);
    const chain = new EsploraClient(shim.url);
    world = await createWorld({
      relays: [ENV.relay!],
      transport: () => new PoolTransport(),
      chain,
    });
    // EVM clients need ETH/USDC first, so attach them after the world exists.
    for (const name of ['user-1', 'shopper-1', 'escrow-1'] as const) {
      world.sessions[name].evm = await fundedEvm(ENV.anvil!, d!, world.keys[name], name === 'user-1' ? 1_000_000_000n : 0n);
    }
    world.user.setDeployments(d);
    world.escrow.setDeployments(d);
    await rpc.mine(2, world.keys['user-1'].btcWallet.address);
    await rpc.mine(100, BURN);
    // like the lab faucet: mine whenever the mempool is non-empty
    miner = setInterval(async () => {
      const pool = await rpc.call<string[]>('getrawmempool').catch(() => []);
      if (pool.length) await rpc.mine(1, BURN).catch(() => undefined);
    }, 500);
    close = () => shim.server.close();
  }, 180_000);

  afterAll(() => {
    clearInterval(miner);
    world?.stop();
    close?.();
  });

  const wait = async (id: string, status: UserOrderStatus, ms = 30_000): Promise<UserOrder> => {
    const end = Date.now() + ms;
    for (;;) {
      const o = await world.user.getOrder(id);
      if (o?.status === status) return o;
      if (Date.now() > end) throw new Error(`timeout waiting for ${status}; at ${o?.status} ${o?.lastError ?? ''} shopper errors: ${world.shopper.errors.map((e) => e.message).join('; ')}`);
      await sleep(100);
    }
  };

  async function order(payment: 'btc-signet' | 'usdc-evm') {
    const [offer] = await world.user.discoverOffers({ shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', payment });
    expect(offer).toBeDefined();
    const o = await world.user.createOrder({ offer, shopUrl: 'https://safe-shop.test/', region: 'JP-13-13104', items: [{ sku: 'A-100', qty: 1 }], payment, address: ADDRESS });
    const q = await wait(o.id, 'quoted');
    expect(q.quoteCheck?.errors).toEqual([]);
    await world.user.acceptQuote(o.id);
    await world.user.fund(o.id);
    await wait(o.id, 'delivered');
    return o.id;
  }

  it('BTC: happy path to completed; release tx accepted by bitcoind', async () => {
    const id = await order('btc-signet');
    await world.user.release(id);
    const done = await wait(id, 'completed');
    const status = await world.sessions['user-1'].chain!.txStatus(done.completedTxid!);
    expect(status).toBeDefined();
  });

  it('USDC: happy path — Safe deployed at the quoted address, release executed', async () => {
    const id = await order('usdc-evm');
    const shopperEvm = world.sessions['shopper-1'].evm!;
    const before = await shopperEvm.usdcBalance();
    await world.user.release(id);
    const done = await wait(id, 'completed');
    expect((await shopperEvm.usdcBalance()) - before).toBe(BigInt(done.quote!.lock_amount!));
    const c = await world.escrow.checkObligation(id);
    expect(c.paid).toBe(true);
  });

  it('USDC dispute: escrow rules, user countersigns and executes the MultiSend', async () => {
    const id = await order('usdc-evm');
    await world.user.openDispute(id, { claim: 'wrong_item', text: '違う商品' });
    const end = Date.now() + 20_000;
    while ((await world.escrow.getCase(id))?.status !== 'open') {
      if (Date.now() > end) throw new Error('case not opened');
      await sleep(100);
    }
    expect(await world.escrow.decryptAddress(id)).toEqual(ADDRESS);
    const lock = BigInt((await world.user.getOrder(id))!.quote!.lock_amount!);
    await world.escrow.rule(id, { user: String(lock / 2n), shopper: String(lock / 2n - 100_000n) }, '半額返金');
    await wait(id, 'ruled');
    expect(await world.user.reviewRuling(id)).toEqual([]);
    const userEvm = world.sessions['user-1'].evm!;
    const before = await userEvm.usdcBalance();
    await world.user.countersignRuling(id);
    expect((await userEvm.usdcBalance()) - before).toBe(lock / 2n);
  });

  it('BTC dispute: ruling PSBT countersigned by the user is accepted by bitcoind', async () => {
    const id = await order('btc-signet');
    await world.user.openDispute(id, { claim: 'not_delivered', text: '届かない' });
    const end = Date.now() + 20_000;
    while ((await world.escrow.getCase(id))?.status !== 'open') {
      if (Date.now() > end) throw new Error('case not opened');
      await sleep(100);
    }
    await world.escrow.rule(id, { user: '20000', shopper: '8100' }, '一部返金'); // fee 567 ≤ dispute_fee_bps 2 %
    await wait(id, 'ruled');
    expect(await world.user.reviewRuling(id)).toEqual([]);
    const settled = await world.user.countersignRuling(id);
    await sleep(1500);
    const st = await world.sessions['user-1'].chain!.txStatus(settled.settledTxid!);
    expect(st.confirmed).toBe(true);
  });
});
