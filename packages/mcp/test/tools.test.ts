// Tool handlers through a real MCP client, against core's in-memory world (relays, chain, fake shopper, escrow).
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { KeySet, MemoryStorage, Session, UserClient, type NostrEvent } from '@proxy-shopping/core/node';
import { createWorld, LAB_MNEMONICS, MemoryChain, MemoryRelayNetwork, type WorldOptions } from '@proxy-shopping/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { labPreset, parseCoordinators, psMainPreset, PS_MAIN_DEFAULT_COORDINATOR } from '../src/config.js';
import { RegistryTrust, type Runtime } from '../src/runtime.js';
import { createServer } from '../src/server.js';

const RELAYS = ['wss://relay-1.test', 'wss://relay-2.test'];
const SHOP = 'https://safe-shop.test/';
const REGION = 'JP-13-13104';
const ADDRESS = { name: 'Taro Yamada', postal_code: '160-0022', address: 'Shinjuku 1-1-1, Tokyo', phone: '03-0000-0000' };

type Result = { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});

async function setup(shopper: WorldOptions['shopper'] = {}) {
  const net = new MemoryRelayNetwork();
  const chain = new MemoryChain();
  const w = await createWorld({ relays: RELAYS, transport: () => net.transport(), chain, shopper, chainPollMs: 50 });
  chain.fund(w.keys['user-1'].btcWallet.address, 1_000_000);
  const session = w.sessions['user-1'];
  const cfg = { ...labPreset(), relays: RELAYS, relayMap: undefined, coordinators: [{ pubkey: w.keys['coordinator-1'].nostrPublicKey, source: 'test' }] };
  const rt: Runtime = {
    cfg,
    session,
    user: w.user,
    trust: {
      refresh: () => session.directory.refresh(),
      status: () => ({ bundleUrls: [], bundleEvents: 0, registryCoordinators: 0, errors: [] }),
    },
    faucet: {
      btc: async (address, sats) => ({ txid: chain.fund(address, sats) }),
      evm: async () => ({}),
      mine: async (n) => {
        chain.mine(n);
        return { height: chain.height };
      },
    },
    exportMnemonic: async () => LAB_MNEMONICS['user-1'],
    close: () => w.stop(),
  };
  const server = createServer(rt);
  const client = new Client({ name: 'test', version: '0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  cleanups.push(async () => {
    await client.close();
    w.stop();
  });
  const raw = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await raw(name, args);
    if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
    expect(r.content[0].type).toBe('text');
    expect(JSON.parse(r.content[1].text)).toEqual(r.structuredContent);
    return { text: r.content[0].text, data: r.structuredContent as Record<string, any> };
  };
  return { w, chain, rt, client, call, raw };
}

describe('tools', () => {
  it('lists task-named tools', async () => {
    const { client } = await setup();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'accept_quote', 'accept_refund_offer', 'become_shopper', 'cancel_order', 'confirm_receipt', 'countersign_ruling', 'export_backup', 'find_offers',
      'fund_order', 'get_order', 'lab_faucet', 'list_orders', 'network_info', 'open_dispute', 'refund_after_timelock', 'registry_entry', 'report',
      'request_quote', 'review_ruling', 'wallet',
    ]);
  });

  it('find_offers → request_quote → accept → fund → confirm_receipt, with confirm gating', { timeout: 30_000 }, async () => {
    const { w, chain, call, raw } = await setup();

    const info = await call('network_info');
    expect(info.data.trust.combinations).toBe(1);
    expect(info.data.network).toBe('ps-lab');

    const wallet = await call('wallet');
    expect(wallet.data.btc.address).toBe(w.keys['user-1'].btcWallet.address);
    expect(wallet.data.btc.balance_sats).toBe('1000000');

    const offers = await call('find_offers', { shop_url: SHOP, region: REGION, payment: 'btc-signet' });
    expect(offers.data.offers).toHaveLength(1);
    const offer = offers.data.offers[0];
    expect(offer.shopper).toMatchObject({ pubkey: w.keys['shopper-1'].nostrPublicKey, name: 'shopper-1', fee: { bps: 500 }, delivery_days: 5 });
    expect(offer.escrow).toMatchObject({ pubkey: w.keys['escrow-1'].nostrPublicKey, name: 'escrow-1', dispute_fee_bps: 200 });
    expect(offer.provenance).toMatchObject({ coordinator: w.keys['coordinator-1'].nostrPublicKey, operator: w.keys['operator-1'].nostrPublicKey, operator_list: 'Kanto operator' });

    // an offer index needs a find_offers with the same query
    expect((await raw('request_quote', { offer_index: 0, shop_url: 'https://other.test/', region: REGION, items: [{ sku: 'A-100', qty: 1 }], address: ADDRESS })).isError).toBe(true);

    const quoted = await call('request_quote', { offer_index: 0, shop_url: SHOP, region: REGION, payment: 'btc-signet', items: [{ sku: 'A-100', qty: 1 }], address: ADDRESS, wait_seconds: 10 });
    const id = quoted.data.order_id as string;
    expect(quoted.data.status).toBe('quoted');
    expect(quoted.data.quote.lock_amount).toBe('29667');
    expect(quoted.data.validation).toMatchObject({ ok: true, errors: [], acknowledgement_required: [], rate: { level: 'ok' }, escrow_address: { matches: true } });
    expect(quoted.data.validation.timelocks.unit).toBe('block height');
    expect(quoted.text).toContain('Validation: OK');

    const accepted = await call('accept_quote', { order_id: id });
    expect(accepted.data.order.status).toBe('accepted');

    // no confirm: a preview, nothing sent
    const preview = await call('fund_order', { order_id: id });
    expect(preview.data.done).toBe(false);
    expect(preview.data.would_pay.recipients.map((r: { label: string }) => r.label)).toEqual(['escrow', 'escrow fee']);
    expect(preview.text).toMatch(/^Not sent/);
    expect((await w.user.getOrder(id))!.status).toBe('accepted');
    expect((await w.user.getOrder(id))!.fundingProgress).toBeUndefined();
    expect((await call('wallet')).data.btc.balance_sats).toBe('1000000');

    const funded = await call('fund_order', { order_id: id, confirm: true });
    expect(funded.data.done).toBe(true);
    expect(funded.data.order.status).toBe('funded');
    expect(typeof funded.data.txid).toBe('string');
    await call('lab_faucet', { mine_blocks: 1 });

    const delivered = await call('get_order', { order_id: id, wait_for: ['delivered'], wait_seconds: 10 });
    expect(delivered.data.status).toBe('delivered');
    expect(delivered.data.purchased.shop_order_id).toMatch(/^SHOP-/);
    expect(delivered.data.next_steps.join(' ')).toContain('confirm_receipt');

    const releasePreview = await call('confirm_receipt', { order_id: id });
    expect(releasePreview.data.done).toBe(false);
    expect(releasePreview.data.would_pay.to).toBe(w.keys['shopper-1'].btcWallet.address);
    expect((await w.user.getOrder(id))!.status).toBe('delivered');

    const released = await call('confirm_receipt', { order_id: id, confirm: true, wait_seconds: 0 });
    expect(released.data.done).toBe(true);
    chain.mine();
    const done = await call('get_order', { order_id: id, wait_for: ['completed'], wait_seconds: 10 });
    expect(done.data.status).toBe('completed');
    expect(done.data.settlement.completed_txid).toBeTruthy();

    const list = await call('list_orders');
    expect(list.data.orders.map((o: { order_id: string }) => o.order_id)).toEqual([id]);
  });

  it('gates signing tools and the backup behind confirm', { timeout: 30_000 }, async () => {
    const { call, raw } = await setup();
    await call('find_offers', { shop_url: SHOP, region: REGION });
    const q = await call('request_quote', { offer_index: 0, shop_url: SHOP, region: REGION, items: [{ sku: 'A-100', qty: 1 }], address: ADDRESS, wait_seconds: 10 });
    const id = q.data.order_id;
    // before funding there is nothing to release, dispute or refund
    expect((await raw('confirm_receipt', { order_id: id, confirm: true })).isError).toBe(true);
    expect((await raw('fund_order', { order_id: id, confirm: true })).content[0].text).toContain('accept_quote first');
    const ruling = await call('countersign_ruling', { order_id: id });
    expect(ruling.data.done).toBe(false);
    const dispute = await call('open_dispute', { order_id: id, claim: 'not_delivered', text: 'never came' });
    expect(dispute.data.done).toBe(false);

    const noBackup = await call('export_backup');
    expect(noBackup.data).toEqual({ done: false });
    expect(noBackup.text).not.toContain(LAB_MNEMONICS['user-1']);
    const backup = await call('export_backup', { confirm: true });
    expect(backup.data.mnemonic).toBe(LAB_MNEMONICS['user-1']);

    const cancelled = await call('cancel_order', { order_id: id });
    expect(cancelled.data.order.status).toBe('cancelled');
  });

  it('a strongly deviating rate needs acknowledge_rate_deviation', { timeout: 30_000 }, async () => {
    // the shopper quotes 20M JPY/BTC while our sources say 15M (33 %)
    const { call } = await setup({ rates: { 'btc-signet': 20_000_000, 'usdc-evm': 150 } });
    await call('find_offers', { shop_url: SHOP, region: REGION });
    const q = await call('request_quote', { offer_index: 0, shop_url: SHOP, region: REGION, items: [{ sku: 'A-100', qty: 1 }], address: ADDRESS, wait_seconds: 10 });
    expect(q.data.validation.rate.level).toBe('strong');
    expect(q.data.validation.acknowledgement_required.length).toBe(1);
    const refused = await call('accept_quote', { order_id: q.data.order_id });
    expect(refused.data.done).toBe(false);
    const ok = await call('accept_quote', { order_id: q.data.order_id, acknowledge_rate_deviation: true });
    expect(ok.data.order.status).toBe('accepted');
  });

  it('registry_entry and become_shopper', async () => {
    const { w, call, raw } = await setup();
    const e = await call('registry_entry', {
      role: 'shopper', name: 'Tokyo Cash Runner', contact: 'github:someone', description: 'Cash-only shops in Tokyo', regions: ['JP-13'], escrows: ['escrow-one'],
    });
    expect(e.data.path).toBe('shoppers/tokyo-cash-runner.json');
    expect(e.data.content).toEqual({
      pk: w.keys['user-1'].nostrPublicKey, contact: 'github:someone', description: 'Cash-only shops in Tokyo', regions: ['JP-13'], payments: ['btc-signet'], escrows: ['escrow-one'],
    });
    expect(JSON.parse(e.data.json)).toEqual(e.data.content);
    expect(e.data.pull_request.repository).toBe('https://github.com/pad01g/proxy-shopping-registry');
    const pk = w.keys['escrow-1'].nostrPublicKey;
    const esc = await call('registry_entry', { role: 'escrow', name: 'e1', contact: 'x', description: 'y', pubkey: pk, sla_days: 10 });
    expect(esc.data).toMatchObject({ path: 'escrows/e1.json', content: { pk, contact: 'x', description: 'y', sla_days: 10 } });
    expect(Object.keys((await call('registry_entry', { role: 'coordinator', name: 'c', contact: 'x', description: 'y', pubkey: pk })).data.content)).toEqual(['pk', 'contact', 'description']);
    expect((await raw('registry_entry', { role: 'shopper', name: 'x', contact: 'x', description: 'y', pubkey: 'nothex' })).isError).toBe(true);
    // a shopper entry needs its cash regions and escrows
    expect((await raw('registry_entry', { role: 'shopper', name: 'x', contact: 'x', description: 'y', regions: ['JP-13'] })).isError).toBe(true);
    expect((await raw('registry_entry', { role: 'shopper', name: 'x', contact: 'x', description: 'y', regions: ['tokyo'], escrows: ['e'] })).isError).toBe(true);

    const plan = await call('become_shopper', { name: 'Tokyo Cash Runner', cash_regions: ['JP-13'] });
    expect(plan.data.registry.path).toBe('shoppers/tokyo-cash-runner.json');
    expect(plan.data.files['shopper.yaml']).toContain('network: ps-main');
    expect(plan.data.files['shopper.yaml']).toContain(PS_MAIN_DEFAULT_COORDINATOR);
    expect(plan.data.files['shopper.yaml']).toContain('wss://relay.damus.io');
    expect(plan.data.files['compose.yaml']).toContain('ghcr.io/pad01g/proxy-shopping-node');
    expect(plan.data.files['compose.yaml']).toContain('ghcr.io/pad01g/proxy-shopping-shopper-bot');
    expect(plan.text).toContain('always-online');
    expect(plan.text).toContain('escrows');
  });
});

// The registry's own validator (proxy-shopping-registry/scripts/registry.ts validate) on generated entries.
const REGISTRY = [process.env.PS_REGISTRY_DIR, fileURLToPath(new URL('../../../../proxy-shopping-registry', import.meta.url)), '/proxy-shopping-registry']
  .find((d) => d && existsSync(join(d, 'scripts', 'registry.ts')));

describe.skipIf(!REGISTRY && process.env.SKIP_REGISTRY === '1')('registry validator', () => {
  function validate(files: Record<string, string>): { code: number; out: string } {
    if (!REGISTRY) throw new Error('proxy-shopping-registry not found next to proxy-shopping-web (or PS_REGISTRY_DIR); SKIP_REGISTRY=1 skips this');
    const root = mkdtempSync(join(tmpdir(), 'ps-registry-'));
    for (const f of ['coordinator.json', 'operator.json']) copyFileSync(join(REGISTRY, f), join(root, f));
    cpSync(join(REGISTRY, 'coordinators'), join(root, 'coordinators'), { recursive: true });
    for (const d of ['shoppers', 'escrows', 'operators', 'revoked']) mkdirSync(join(root, d), { recursive: true });
    for (const [path, json] of Object.entries(files)) writeFileSync(join(root, path), json);
    const r = spawnSync(process.execPath, ['--no-warnings', join(REGISTRY, 'scripts', 'registry.ts'), 'validate'], {
      env: { ...process.env, REGISTRY_ROOT: root }, encoding: 'utf8',
    });
    rmSync(root, { recursive: true, force: true });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  it('accepts every role the registry_entry tool writes', { timeout: 30_000 }, async () => {
    const { w, call } = await setup();
    const pk = (n: 'shopper-1' | 'escrow-1' | 'operator-1' | 'coordinator-1') => w.keys[n].nostrPublicKey;
    const files: Record<string, string> = {};
    for (const args of [
      { role: 'escrow', name: 'Honest Escrow', contact: 'github:escrow', description: 'Rules disputes within a week', pubkey: pk('escrow-1'), sla_days: 7 },
      { role: 'shopper', name: 'Tokyo Cash Runner', contact: 'github:shopper', description: 'Cash-only shops in Tokyo', pubkey: pk('shopper-1'), regions: ['JP-13', 'JP-14'], escrows: ['honest-escrow'] },
      { role: 'operator', name: 'Kanto Operator', contact: 'github:operator', description: 'Lists shoppers I met in person', pubkey: pk('operator-1'), regions: ['JP-13'] },
      { role: 'coordinator', name: 'Other Coordinator', contact: 'github:coord', description: 'Another root of trust', pubkey: pk('coordinator-1'), url: 'https://example.org/', bundle: 'https://example.org/events.json' },
    ]) {
      const e = await call('registry_entry', args);
      files[e.data.path] = e.data.json;
    }
    expect(Object.keys(files).sort()).toEqual(['coordinators/other-coordinator.json', 'escrows/honest-escrow.json', 'operators/kanto-operator.json', 'shoppers/tokyo-cash-runner.json']);
    const r = validate(files);
    expect(r.out).toMatch(/^ok: 1 shopper\(s\), 1 escrow\(s\)/m);
    expect(r.out).not.toMatch(/warning/);
    expect(r.code).toBe(0);
    // the validator rejects fields outside the format, so the tool must not add any
    const extra = validate({ 'escrows/x.json': JSON.stringify({ ...JSON.parse(files['escrows/honest-escrow.json']), name: 'x' }) });
    expect(extra.code).toBe(1);
    expect(extra.out).toContain('unknown field "name"');
  });
});

describe('trust bundles and config', () => {
  it('registry coordinators and trust bundles give offers without any relay holding the events', { timeout: 30_000 }, async () => {
    const { w } = await setup();
    await w.user.discoverOffers({ shopUrl: SHOP, region: REGION, payment: 'btc-signet' });
    const events = (await w.sessions['user-1'].storage.get<NostrEvent[]>('trust/events'))!;
    expect(events.length).toBeGreaterThan(0);
    const coordinator = w.keys['coordinator-1'].nostrPublicKey;
    // the registry: coordinators.json and events.json (plus junk and a forged copy, which are ignored)
    const forged = { ...events[0], id: 'f'.repeat(64), content: '{}' };
    const http = createHttpServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/coordinators.json') res.end(JSON.stringify({ coordinators: [{ pubkey: coordinator, name: 'lab coordinator-1' }] }));
      else if (req.url === '/events.json') res.end(JSON.stringify({ events: [...events, forged, { junk: true }] }));
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => http.close(() => r())));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

    // a fresh participant on empty relays that trusts no coordinator until the registry names one
    const cfg = { ...labPreset(), relays: RELAYS, coordinators: [], trustBundleUrls: [`${base}/events.json`], coordinatorsUrl: `${base}/coordinators.json` };
    const empty = new MemoryRelayNetwork();
    const s = new Session({
      keys: KeySet.fromMnemonic(LAB_MNEMONICS['user-1']), transport: empty.transport(), storage: new MemoryStorage(),
      config: { network: 'ps-lab', relays: RELAYS, coordinators: [], trustBundles: cfg.trustBundleUrls },
    });
    cleanups.push(() => s.transport.close());
    const trust = new RegistryTrust(s, cfg);
    const snap = await trust.refresh();
    expect(s.config.coordinators).toEqual([coordinator]);
    expect(cfg.coordinators).toEqual([{ pubkey: coordinator, name: 'lab coordinator-1', source: 'registry' }]);
    expect(trust.status()).toMatchObject({ bundleEvents: events.length, registryCoordinators: 1, errors: [] });
    expect(snap.entries).toHaveLength(1);
    const offers = await new UserClient(s).discoverOffers({ shopUrl: SHOP, region: REGION, payment: 'btc-signet', refresh: false });
    expect(offers).toHaveLength(1);
    expect(offers[0].shopper?.content.name).toBe('shopper-1');
  });

  it('reports an unreachable registry instead of failing', async () => {
    const empty = new MemoryRelayNetwork();
    const s = new Session({ keys: KeySet.fromMnemonic(LAB_MNEMONICS['user-1']), transport: empty.transport(), storage: new MemoryStorage(), config: { network: 'ps-main', relays: RELAYS, coordinators: [] } });
    const cfg = { ...psMainPreset(), relays: RELAYS, trustBundleUrls: ['http://127.0.0.1:9/events.json'], coordinatorsUrl: 'http://127.0.0.1:9/coordinators.json' };
    const trust = new RegistryTrust(s, cfg);
    await trust.refresh();
    expect(trust.status().errors).toHaveLength(2);
    s.transport.close();
  });

  it('parses registry coordinators in the accepted shapes', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(parseCoordinators([a, 'nope'])).toEqual([{ pubkey: a, name: undefined }]);
    expect(parseCoordinators({ coordinators: [{ pubkey: a, name: 'A' }, { pk: b }] })).toEqual([{ pubkey: a, name: 'A' }, { pubkey: b, name: undefined }]);
    expect(parseCoordinators('<html>')).toEqual([]);
  });

  it('ps-main preset is honest about its state', () => {
    const c = psMainPreset();
    expect(c.relays).toEqual(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']);
    expect(c.esplora).toBe('https://mempool.space/signet/api');
    expect(c.evmRpc).toBeUndefined();
    expect(c.coordinators[0].pubkey).toBe(PS_MAIN_DEFAULT_COORDINATOR);
    expect(c.notes.join(' ')).toMatch(/new/);
    const lab = labPreset('http://host.docker.internal:8888/');
    expect(lab.relayMap).toEqual({ 'wss://relay-1.test': 'ws://host.docker.internal:8888/relay-1', 'wss://relay-2.test': 'ws://host.docker.internal:8888/relay-2' });
    expect(lab.timelockPolicy?.btc_min_t1_blocks).toBe(50);
    expect(lab.maxClockSkewSeconds).toBe(315_360_000);
  });
});
