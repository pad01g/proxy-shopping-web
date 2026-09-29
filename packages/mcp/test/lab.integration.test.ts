// End to end against the running docker compose lab: the built MCP server over stdio, driven only through MCP tool
// calls, completes a BTC order with the lab's Go shopper-1 and escrow-1 (operator-1's list under coordinator-1).
// Skipped unless PS_LAB_INTEGRATION=1. Run:  npm run test:lab   (PS_LAB_URL defaults to http://localhost:8888)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KeySet } from '@proxy-shopping/core/node';
import { LAB_MNEMONICS } from '@proxy-shopping/core/testing';
import { expect, it } from 'vitest';

const enabled = process.env.PS_LAB_INTEGRATION === '1';
const LAB_URL = process.env.PS_LAB_URL ?? 'http://localhost:8888';
const SHOP = 'https://safe-shop.test/';
const REGION = 'JP-13-13104';
const ADDRESS = { name: 'Taro Yamada', postal_code: '160-0022', address: 'Shinjuku 1-1-1, Tokyo', phone: '03-0000-0000' };
const SHOPPER = KeySet.fromMnemonic(LAB_MNEMONICS['shopper-1']).nostrPublicKey;
const ESCROW = KeySet.fromMnemonic(LAB_MNEMONICS['escrow-1']).nostrPublicKey;

it.runIf(enabled)('lab: a BTC order end to end through MCP tool calls', { timeout: 15 * 60_000 }, async () => {
  const dataDir = process.env.PS_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'ps-mcp-lab-'));
  const client = new Client({ name: 'lab-integration', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../dist/server.js', import.meta.url).pathname],
    env: { ...(process.env as Record<string, string>), PS_NETWORK: 'lab', PS_LAB_URL: LAB_URL, PS_DATA_DIR: dataDir },
    stderr: 'inherit',
  }));
  const t0 = Date.now();
  const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: any };
    if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
    log(`${name}: ${r.content[0].text.split('\n')[0]}`);
    return r.structuredContent as any;
  };
  /** Poll get_order (mining a block between polls, as the lab chain mines on demand) until `want`. */
  const until = async (id: string, want: string[], seconds: number) => {
    const end = Date.now() + seconds * 1000;
    for (;;) {
      const o = await call('get_order', { order_id: id, wait_for: want, wait_seconds: 10 });
      if (want.includes(o.status)) return o;
      if (Date.now() > end) throw new Error(`order ${id} at ${o.status} (${o.last_error ?? ''}), wanted ${want.join('|')}`);
      await call('lab_faucet', { mine_blocks: 1 });
    }
  };
  try {
    const tools = (await client.listTools()).tools.map((x) => x.name);
    expect(tools).toContain('lab_faucet');

    const info = await call('network_info');
    expect(info.network).toBe('ps-lab');
    expect(info.trust.combinations).toBeGreaterThan(0);

    const w0 = await call('wallet');
    await call('lab_faucet', { btc_sats: 2_000_000, mine_blocks: 1 });
    for (let i = 0; ; i++) {
      const w = await call('wallet');
      if (BigInt(w.btc.balance_sats ?? '0') > BigInt(w0.btc.balance_sats ?? '0')) break;
      if (i > 30) throw new Error('the faucet coins never showed up');
      await new Promise((r) => setTimeout(r, 1000));
    }

    let index = -1;
    for (let i = 0; index < 0; i++) {
      const offers = await call('find_offers', { shop_url: SHOP, region: REGION, payment: 'btc-signet' });
      index = offers.offers.findIndex((o: any) => o.shopper.pubkey === SHOPPER && o.escrow.pubkey === ESCROW);
      if (index < 0 && i > 10) throw new Error(`shopper-1 × escrow-1 not offered (got ${offers.offers.length})`);
      if (index < 0) await new Promise((r) => setTimeout(r, 3000));
    }

    const q = await call('request_quote', { offer_index: index, shop_url: SHOP, region: REGION, payment: 'btc-signet', items: [{ sku: 'A-100', qty: 1 }], address: ADDRESS, wait_seconds: 120 });
    const id = q.order_id as string;
    expect(q.status).toBe('quoted');
    expect(q.validation.ok).toBe(true);
    expect(q.validation.escrow_address.matches).toBe(true);
    log(`quote: lock ${q.quote.lock_amount_text}, rate ${q.validation.rate?.deviation_percent} % (${q.validation.rate?.level}), T1 ${q.quote.timelock.t1}, T2 ${q.quote.timelock.t2}`);

    await call('accept_quote', { order_id: id, acknowledge_rate_deviation: q.validation.acknowledgement_required.length > 0 });
    const preview = await call('fund_order', { order_id: id });
    expect(preview.done).toBe(false);
    const funded = await call('fund_order', { order_id: id, confirm: true });
    expect(funded.done).toBe(true);
    await call('lab_faucet', { mine_blocks: 1 });

    const delivered = await until(id, ['delivered'], 300);
    log(`purchased ${delivered.purchased?.shop_order_id}, tracking ${delivered.tracking?.tracking_no ?? delivered.tracking?.status}`);

    expect((await call('confirm_receipt', { order_id: id })).done).toBe(false);
    await call('confirm_receipt', { order_id: id, confirm: true, wait_seconds: 5 });
    const done = await until(id, ['completed'], 300);
    expect(done.settlement.completed_txid).toBeTruthy();
    log(`RESULT order ${id} completed, payout ${done.settlement.completed_txid}, funding ${funded.txid}`);
  } finally {
    await client.close();
  }
});
