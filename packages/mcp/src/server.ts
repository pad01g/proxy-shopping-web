#!/usr/bin/env node
/**
 * MCP server (stdio) for the proxy-shopping P2P network: buy from cash-only or unsupported shops with crypto through a
 * proxy shopper, with a 2-of-3 escrow; or earn as a proxy shopper. It runs one participant (a user) with its own key
 * in PS_DATA_DIR and keeps its session running, so shoppers' and escrows' messages keep arriving while it runs.
 *
 *   PS_NETWORK     ps-main (default, public) | lab (the local docker compose lab)
 *   PS_DATA_DIR    mnemonic + order state (default ~/.proxy-shopping-mcp; in Docker mount a volume at /data)
 *   PS_LAB_URL     lab demo server (default http://localhost:8888; from Docker http://host.docker.internal:8888)
 *   PS_CONFIG_URL / PS_CONFIG_FILE  a web-app config.json that overrides the network preset
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { configFromEnv } from './config.js';
import { dataDirFromEnv } from './identity.js';
import { startRuntime, type Runtime } from './runtime.js';
import { Tools, type ToolResult } from './tools.js';

export const VERSION = '0.1.0';

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

function toContent(r: ToolResult) {
  const data = JSON.parse(json(r.data)) as Record<string, unknown>;
  return { content: [{ type: 'text' as const, text: r.text }, { type: 'text' as const, text: json(data) }], structuredContent: data };
}

const safely =
  <A>(f: (a: A) => Promise<ToolResult>) =>
  async (a: A) => {
    try {
      return toContent(await f(a));
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] };
    }
  };

const PAYMENT = z.enum(['btc-signet', 'usdc-evm']);
const STATUS = z.enum([
  'requested', 'quoted', 'rejected', 'accepted', 'funding', 'funded', 'purchased', 'shipped', 'delivered', 'delivery_failed',
  'released', 'completed', 'disputed', 'ruled', 'settled', 'refunded', 'cancelled',
]);
const ORDER_ID = z.string().regex(/^[0-9a-f]{32}$/).describe('order id (32 hex characters) from request_quote or list_orders');
const PUBKEY = z.string().regex(/^[0-9a-fA-F]{64}$/);
const CONFIRM = z.boolean().optional().describe('true to really do it; without it the tool only shows what would happen');
const REGION = z.string().min(2).max(40).describe("the shop's region code, prefix-matched: country 'JP', prefecture 'JP-13', Japanese municipality 'JP-13-13104'");
const SHOP_URL = z.string().min(3).max(500).describe('shop URL, e.g. https://shop.example/');

export function createServer(rt: Runtime): McpServer {
  const t = new Tools(rt);
  const server = new McpServer({ name: 'proxy-shopping', version: VERSION });
  const ro = { readOnlyHint: true, openWorldHint: true };
  const money = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  const msg = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

  server.registerTool('network_info', {
    title: 'Network status',
    description:
      'Which proxy-shopping network this server is on (ps-main public or the local lab), its relays, trusted coordinators, chains, and how many shopper × escrow combinations are trusted right now. ' +
      'Call this first: on a new network there may be no shoppers yet.',
    inputSchema: { refresh: z.boolean().optional().describe('re-read the trust lists from relays and the registry (default true)') },
    annotations: ro,
  }, safely((a) => t.networkInfo(a)));

  server.registerTool('wallet', {
    title: 'Wallet and identity',
    description: "This agent's identity pubkey, BTC signet address and balance (and EVM address/USDC balance where the network has USDC). Fund this address before fund_order.",
    inputSchema: {},
    annotations: ro,
  }, safely(() => t.wallet()));

  if (rt.faucet) {
    server.registerTool('lab_faucet', {
      title: 'Lab faucet (test coins)',
      description: 'Lab network only: send test BTC (sats) and/or test USDC/ETH to this wallet, or mine blocks on the lab signet. The coins have no value.',
      inputSchema: {
        btc_sats: z.number().int().min(1000).max(100_000_000).optional(),
        usdc: z.string().regex(/^\d+(\.\d+)?$/).optional(),
        eth: z.string().regex(/^\d+(\.\d+)?$/).optional(),
        mine_blocks: z.number().int().min(1).max(200).optional().describe('mine blocks (confirms pending transactions)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, safely((a) => t.labFaucet(a)));
  }

  server.registerTool('find_offers', {
    title: 'Find proxy shoppers for a shop',
    description:
      'Buy from a cash-only or crypto-unsupported shop: list the trusted proxy shopper × escrow combinations that serve this shop, region and payment, ' +
      "with the shopper's fee, delivery days, cash regions, the escrow's fees and which operator list (under which coordinator) vouches for them. Use the index with request_quote.",
    inputSchema: { shop_url: SHOP_URL, region: REGION, payment: PAYMENT.optional().describe('default btc-signet') },
    annotations: ro,
  }, safely((a) => t.findOffers(a)));

  server.registerTool('request_quote', {
    title: 'Request a quote from a proxy shopper',
    description:
      'Create an order with one shopper × escrow combination (offer_index from find_offers, or shopper + escrow pubkeys) and wait (bounded) for the quote. ' +
      'The delivery address is encrypted for the shopper (the escrow can read it only in a dispute). Returns the order id, the price and the validation of the quote: ' +
      'rate deviation from our own rate sources, the recomputed 2-of-3 escrow address, the timelocks. Nothing is paid.',
    inputSchema: {
      offer_index: z.number().int().min(0).optional(),
      shopper: PUBKEY.optional(),
      escrow: PUBKEY.optional(),
      shop_url: SHOP_URL,
      region: REGION,
      payment: PAYMENT.optional(),
      items: z.array(z.object({ sku: z.string().min(1).max(100).describe('the shop item id / SKU'), qty: z.number().int().min(1).max(99) })).min(1).max(20),
      address: z.object({ name: z.string().min(1), postal_code: z.string().min(1), address: z.string().min(1), phone: z.string().min(1) }).describe('delivery address'),
      wait_seconds: z.number().int().min(0).max(300).optional().describe('how long to wait for the quote (default 60)'),
    },
    annotations: msg,
  }, safely((a) => t.requestQuote(a)));

  server.registerTool('get_order', {
    title: 'Order status',
    description: 'Status, quote, validation, funding, delivery, dispute and settlement of one order, with its recent timeline and the next steps. Optionally waits until it reaches one of wait_for.',
    inputSchema: {
      order_id: ORDER_ID,
      wait_for: z.array(STATUS).optional(),
      wait_seconds: z.number().int().min(0).max(600).optional().describe('bound for wait_for (default 30)'),
    },
    annotations: ro,
  }, safely((a) => t.getOrder(a)));

  server.registerTool('list_orders', {
    title: 'List orders',
    description: "This agent's orders, newest first, with their status and next steps.",
    inputSchema: { status: z.array(STATUS).optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: ro,
  }, safely((a) => t.listOrders(a)));

  server.registerTool('accept_quote', {
    title: 'Accept a quote',
    description:
      'Accept a validated quote (a signed message to the shopper; nothing is paid yet). A quote whose rate deviates strongly (> 10 %) from our sources, or could not be checked, ' +
      'needs acknowledge_rate_deviation: true. A quote that failed validation cannot be accepted.',
    inputSchema: { order_id: ORDER_ID, acknowledge_rate_deviation: z.boolean().optional() },
    annotations: msg,
  }, safely((a) => t.acceptQuote(a)));

  server.registerTool('fund_order', {
    title: 'Pay into the escrow',
    description:
      'Moves money: pay the quoted lock amount into the 2-of-3 escrow (and the escrow upfront fee) from this wallet. Without confirm: true it only shows amounts, recipients and the network fee.',
    inputSchema: { order_id: ORDER_ID, confirm: CONFIRM },
    annotations: money,
  }, safely((a) => t.fundOrder(a)));

  server.registerTool('confirm_receipt', {
    title: 'Confirm receipt and pay the shopper',
    description:
      'Moves money: you received the items, so sign the escrow payout to the shopper (release). Irreversible. Without confirm: true it only shows the payout. Waits briefly for the on-chain completion.',
    inputSchema: { order_id: ORDER_ID, confirm: CONFIRM, wait_seconds: z.number().int().min(0).max(300).optional() },
    annotations: money,
  }, safely((a) => t.confirmReceipt(a)));

  server.registerTool('open_dispute', {
    title: 'Open a dispute',
    description:
      'Ask the escrow to decide: items not delivered, wrong item, or shopper not releasing. Sends the signed order messages as evidence and lets the escrow decrypt the delivery address. ' +
      'Without confirm: true it only shows what would be sent.',
    inputSchema: {
      order_id: ORDER_ID,
      claim: z.enum(['not_delivered', 'wrong_item', 'not_released', 'other']),
      text: z.string().min(1).max(2000),
      requested_split: z.object({ user: z.string().regex(/^\d+$/), shopper: z.string().regex(/^\d+$/) }).optional().describe('amounts in sats / USDC base units'),
      confirm: CONFIRM,
    },
    annotations: msg,
  }, safely((a) => t.openDispute(a)));

  server.registerTool('review_ruling', {
    title: "Review the escrow's ruling",
    description: "Show the escrow's ruling (split between you, the shopper and the escrow fee) and whether its transaction really pays that split.",
    inputSchema: { order_id: ORDER_ID },
    annotations: ro,
  }, safely((a) => t.reviewRuling(a)));

  server.registerTool('countersign_ruling', {
    title: 'Countersign the ruling',
    description: "Moves money: add your signature to the escrow's ruling (2 of 3) and broadcast it. Refused if the transaction does not match the split. Without confirm: true it shows the review.",
    inputSchema: { order_id: ORDER_ID, confirm: CONFIRM },
    annotations: money,
  }, safely((a) => t.countersignRuling(a)));

  server.registerTool('accept_refund_offer', {
    title: "Accept the shopper's refund",
    description: 'Moves money: co-sign and broadcast a cooperative refund the shopper offered (e.g. sold out). Refused if it does not pay you as the template requires. Without confirm: true it shows the offer and its check.',
    inputSchema: { order_id: ORDER_ID, confirm: CONFIRM },
    annotations: money,
  }, safely((a) => t.acceptRefundOffer(a)));

  server.registerTool('refund_after_timelock', {
    title: 'Take the funds back after T2',
    description: 'Moves money: after the T2 timelock you alone can take the locked funds back (e.g. the shopper disappeared). Without confirm: true it shows T2, the current height/time and the amount.',
    inputSchema: { order_id: ORDER_ID, confirm: CONFIRM },
    annotations: money,
  }, safely((a) => t.refundAfterTimelock(a)));

  server.registerTool('cancel_order', {
    title: 'Cancel an order before funding',
    description: 'Cancel an order that is not funded yet and tell the shopper.',
    inputSchema: { order_id: ORDER_ID, reason: z.string().max(500).optional() },
    annotations: msg,
  }, safely((a) => t.cancelOrder(a)));

  server.registerTool('report', {
    title: 'Report a shopper or escrow',
    description: "Report the order's shopper or escrow to the operator that listed them, with the order's signed messages as evidence (e.g. a dishonest ruling or a quote that failed validation).",
    inputSchema: { order_id: ORDER_ID, subject: z.enum(['shopper', 'escrow']), text: z.string().min(1).max(2000) },
    annotations: msg,
  }, safely((a) => t.report(a)));

  server.registerTool('export_backup', {
    title: 'Export the recovery words',
    description: "Show this agent's 12-word BIP39 mnemonic (controls the identity and every escrow key). Only with confirm: true; the words stay in the conversation.",
    inputSchema: { confirm: CONFIRM },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safely((a) => t.exportBackup(a)));

  server.registerTool('become_shopper', {
    title: 'Earn as a proxy shopper',
    description:
      'A precise plan to earn fees as a proxy shopper: requirements (always-online host, Docker, the Go node and shopper-bot images, card/cash regions), fees and risks, ' +
      'a ps-main node config and compose file, and how to get listed through the registry.',
    inputSchema: {
      name: z.string().max(48).optional(),
      regions: z.array(z.string().max(40)).max(20).optional(),
      cash_regions: z.array(z.string().max(40)).max(20).optional(),
      fee_bps: z.number().int().min(0).max(5000).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safely((a) => t.becomeShopper(a)));

  server.registerTool('registry_entry', {
    title: 'Registry entry for getting listed',
    description:
      'The exact JSON file and path to add in a pull request to github.com/pad01g/proxy-shopping-registry, in its format: ' +
      'shoppers/<name>.json {pk, contact, description, regions (cash regions), payments, escrows}; escrows/<name>.json {pk, contact, description, sla_days}; ' +
      'operators/<name>.json {pk, contact, description, regions}; coordinators/<name>.json {pk, contact, description, url?, bundle?}. ' +
      "Uses this data dir's identity pubkey unless pubkey is given (a shopper entry must carry the shopper node's key).",
    inputSchema: {
      role: z.enum(['shopper', 'escrow', 'operator', 'coordinator']),
      name: z.string().min(1).max(40).describe('file name: a-z, 0-9 and - (other characters are turned into -)'),
      contact: z.string().min(1).max(200).describe('how reviewers and users reach you, e.g. "github:<user>" or "nostr:npub1…"'),
      description: z.string().min(1).max(300),
      pubkey: PUBKEY.optional().describe('64 hex Nostr public key (psctl keys: nostr_pubkey)'),
      regions: z.array(z.string().max(40)).max(64).optional().describe('shopper: your cash regions; operator: where you list (JP, JP-13, JP-13-13104)'),
      payments: z.array(z.literal('btc-signet')).optional().describe('shopper: default ["btc-signet"] (the only payment on ps-main)'),
      escrows: z.array(z.string().max(40)).max(32).optional().describe('shopper (required): names of the escrows/<name>.json you work with'),
      sla_days: z.number().int().min(1).max(365).optional().describe('escrow: most days from a dispute to your ruling (default 14)'),
      url: z.string().max(256).optional().describe('coordinator: https URL of your page'),
      bundle: z.string().max(256).optional().describe('coordinator: https URL of your signed events.json'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safely((a) => t.registryEntry(a)));

  return server;
}

async function main(): Promise<void> {
  // stdout is the MCP channel: anything else goes to stderr.
  console.log = console.error;
  console.info = console.error;
  const cfg = await configFromEnv();
  const rt = await startRuntime(cfg, { dataDir: dataDirFromEnv(), log: (l) => console.error(`[proxy-shopping-mcp] ${l}`) });
  console.error(`[proxy-shopping-mcp] ${VERSION} on ${cfg.network}, identity ${await rt.session.pubkey()}${rt.identityCreated ? ' (new)' : ''}`);
  const server = createServer(rt);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    rt.close();
    // Let replies in flight and the last state write finish.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdin.on('end', stop);
  await server.connect(new StdioServerTransport());
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((err) => {
    console.error(`[proxy-shopping-mcp] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
}
