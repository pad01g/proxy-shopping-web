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

export const VERSION = '0.1.2';

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
const PUBKEY = z.string().regex(/^[0-9a-fA-F]{64}$/).describe('Nostr public key, 64 hex characters');
const CONFIRM = z.boolean().optional().describe('true to really do it (sign / send / broadcast); omitted or false = preview only, nothing happens');
const REGION = z.string().min(2).max(40).describe("the shop's region code, prefix-matched: country 'JP', prefecture 'JP-13', Japanese municipality 'JP-13-13104'");
const SHOP_URL = z.string().min(3).max(500).describe("the shop's URL, e.g. https://shop.example/");

export function createServer(rt: Runtime): McpServer {
  const t = new Tools(rt);
  const server = new McpServer({ name: 'proxy-shopping', version: VERSION });
  // Reads: no state change (network reads of relays / chain / registry).
  const ro = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
  // Local only, no network, no state change.
  const local = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
  // Signs and moves funds on chain (only with confirm: true).
  const money = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  // Sends signed protocol messages and changes the order's state; no funds move.
  const msg = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

  server.registerTool('network_info', {
    title: 'Network status',
    description:
      'Show which proxy-shopping network this server is on (ps-main = public Nostr relays + BTC signet, or the local lab), its relays, trusted coordinators, ' +
      'chains, timelock policy, and how many shopper × escrow combinations are trusted right now (with their regions and operator lists). ' +
      'Call it first in a session: on a new network there may be no shoppers yet, and then find_offers will return nothing. ' +
      'Read-only; re-reads the trust lists from the relays and the registry unless refresh is false. Returns a summary and the details as JSON.',
    inputSchema: {
      refresh: z.boolean().optional().describe('re-read the trust lists from the relays and the registry (default true); false uses the last snapshot and is faster'),
    },
    annotations: ro,
  }, safely((a) => t.networkInfo(a)));

  server.registerTool('wallet', {
    title: 'Wallet and identity',
    description:
      "Show this agent's identity (Nostr pubkey), its BTC signet address and balance, and where the network has USDC its EVM address with USDC and ETH balances. " +
      'Use it before fund_order to check that the wallet can pay the quote, and to get the address to fund (signet faucet; on the lab: lab_faucet). ' +
      'Read-only: queries the chain, never signs. The key is created on first run in the data dir; export_backup shows it.',
    inputSchema: {},
    annotations: ro,
  }, safely(() => t.wallet()));

  if (rt.faucet) {
    server.registerTool('lab_faucet', {
      title: 'Lab faucet (test coins)',
      description:
        'Lab network only (PS_NETWORK=lab): send valueless test coins to this wallet — BTC in sats and/or USDC/ETH on the lab chain — and/or mine blocks on the lab signet to confirm pending transactions. ' +
        'Use it to fund practice orders; it does not exist on ps-main. Give at least one of btc_sats, usdc, eth, mine_blocks. Returns what was sent or mined.',
      inputSchema: {
        btc_sats: z.number().int().min(1000).max(100_000_000).optional().describe('test BTC to send, in sats (1 BTC = 100000000 sats), e.g. 1000000'),
        usdc: z.string().regex(/^\d+(\.\d+)?$/).optional().describe('test USDC to send, decimal string in whole USDC, e.g. "1000" (default 1000 when eth is given)'),
        eth: z.string().regex(/^\d+(\.\d+)?$/).optional().describe('test ETH for gas, decimal string in whole ETH, e.g. "1" (default 1 when usdc is given)'),
        mine_blocks: z.number().int().min(1).max(200).optional().describe('number of lab signet blocks to mine (confirms pending transactions)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, safely((a) => t.labFaucet(a)));
  }

  server.registerTool('find_offers', {
    title: 'Find proxy shoppers for a shop',
    description:
      'Step 1 of buying from a cash-only or crypto-unsupported shop: list the trusted proxy shopper × escrow combinations that serve this shop, region and payment method. ' +
      "Each offer has an index, the shopper's fee, delivery days, cash regions and order limit, the escrow's fees and dispute SLA, and which operator list (under which coordinator) vouches for it. " +
      'Pass the index to request_quote with the same shop_url, region and payment. Read-only; an empty list means nobody serves that shop/region yet (network_info shows what exists).',
    inputSchema: { shop_url: SHOP_URL, region: REGION, payment: PAYMENT.optional().describe('how you pay: btc-signet (default; the only one on ps-main) or usdc-evm') },
    annotations: ro,
  }, safely((a) => t.findOffers(a)));

  server.registerTool('request_quote', {
    title: 'Request a quote from a proxy shopper',
    description:
      'Step 2: create an order with one shopper × escrow combination (offer_index from the last find_offers with the same shop_url, region and payment, or both shopper and escrow pubkeys) and wait up to wait_seconds for the quote. ' +
      'Sends a signed, encrypted order request over Nostr; the delivery address is encrypted for the shopper (the escrow can read it only in a dispute). Nothing is paid. ' +
      'Returns the order id, the price breakdown, and our validation of the quote: rate deviation from our own rate sources, the recomputed 2-of-3 escrow address, the timelocks T1/T2. ' +
      'If no quote arrives in time the order stays open; follow it with get_order. Next: accept_quote or cancel_order.',
    inputSchema: {
      offer_index: z.number().int().min(0).optional().describe('index of the offer in the last find_offers result (same shop_url, region, payment)'),
      shopper: PUBKEY.optional().describe("shopper's pubkey (64 hex), instead of offer_index; needs escrow too"),
      escrow: PUBKEY.optional().describe("escrow's pubkey (64 hex), instead of offer_index; needs shopper too"),
      shop_url: SHOP_URL,
      region: REGION,
      payment: PAYMENT.optional().describe('btc-signet (default) or usdc-evm; must match the find_offers call'),
      items: z.array(z.object({
        sku: z.string().min(1).max(100).describe("the shop's item id / SKU, e.g. A-100"),
        qty: z.number().int().min(1).max(99).describe('quantity'),
      })).min(1).max(20).describe('items to buy at the shop (1–20 lines)'),
      address: z.object({
        name: z.string().min(1).describe('recipient name'),
        postal_code: z.string().min(1).describe('postal code'),
        address: z.string().min(1).describe('full street address'),
        phone: z.string().min(1).describe('phone number for the carrier'),
      }).describe('delivery address; encrypted end to end for the shopper'),
      wait_seconds: z.number().int().min(0).max(300).optional().describe('how long to wait for the quote, in seconds (default 60; 0 = do not wait)'),
    },
    annotations: msg,
  }, safely((a) => t.requestQuote(a)));

  server.registerTool('get_order', {
    title: 'Order status',
    description:
      'Show one order: status, quote and its validation, funding, purchase, tracking, dispute, ruling, refund offer and settlement, the recent timeline, and next_steps telling which tool to call next. ' +
      'Optionally waits (bounded) until the order reaches one of wait_for, e.g. ["quoted","rejected"] after request_quote. Read-only (local order state, kept up to date by the running session).',
    inputSchema: {
      order_id: ORDER_ID,
      wait_for: z.array(STATUS).optional().describe('return as soon as the status is one of these (e.g. ["quoted","rejected"] or ["completed"])'),
      wait_seconds: z.number().int().min(0).max(600).optional().describe('upper bound for wait_for, in seconds (default 30)'),
    },
    annotations: { ...local },
  }, safely((a) => t.getOrder(a)));

  server.registerTool('list_orders', {
    title: 'List orders',
    description:
      "List this agent's orders (from its data dir), newest first, with status, shop, items, lock amount and next steps. Use it to find an order id or to see what needs attention; get_order shows one order in full. Read-only.",
    inputSchema: {
      status: z.array(STATUS).optional().describe('only orders in these statuses'),
      limit: z.number().int().min(1).max(100).optional().describe('most orders to return (default 20)'),
    },
    annotations: { ...local },
  }, safely((a) => t.listOrders(a)));

  server.registerTool('accept_quote', {
    title: 'Accept a quote',
    description:
      'Step 3: accept a quoted order (sends a signed acceptance to the shopper; nothing is paid yet — fund_order pays). Only for status quoted. ' +
      'A quote that failed validation is refused. A quote whose rate deviates strongly (> 10 %) from our sources, or could not be checked, is not accepted until you call again with acknowledge_rate_deviation: true — ask your human first.',
    inputSchema: {
      order_id: ORDER_ID,
      acknowledge_rate_deviation: z.boolean().optional().describe('true to accept although the quote needs an acknowledgement (strong rate deviation or rate not checkable)'),
    },
    annotations: msg,
  }, safely((a) => t.acceptQuote(a)));

  server.registerTool('fund_order', {
    title: 'Pay into the escrow',
    description:
      'Step 4, moves money: pay the quoted lock amount into the per-order 2-of-3 escrow (BTC P2WSH address or USDC Safe) plus the escrow upfront fee, from this wallet. Only for status accepted/funding. ' +
      'Without confirm: true it only returns the recipients, amounts and network fee (a preview; call it first). With confirm: true it signs and broadcasts. ' +
      'The funds can then leave only with 2 of 3 signatures, by the shopper alone after T1, or by you alone after T2. Ask your human before confirming.',
    inputSchema: { order_id: ORDER_ID, confirm: CONFIRM },
    annotations: money,
  }, safely((a) => t.fundOrder(a)));

  server.registerTool('confirm_receipt', {
    title: 'Confirm receipt and pay the shopper',
    description:
      'Step 5, moves money: the items arrived and are right, so sign the escrow payout to the shopper (release); the shopper co-signs and broadcasts it. Irreversible. ' +
      'Without confirm: true it only returns the payout (amount, recipient) and a warning if the shopper has not reported delivery. With confirm: true it signs and waits up to wait_seconds for the payout on chain. ' +
      'If the items did not arrive or are wrong, use open_dispute instead.',
    inputSchema: {
      order_id: ORDER_ID,
      confirm: CONFIRM,
      wait_seconds: z.number().int().min(0).max(300).optional().describe('how long to wait for the on-chain completion, in seconds (default 20)'),
    },
    annotations: money,
  }, safely((a) => t.confirmReceipt(a)));

  server.registerTool('open_dispute', {
    title: 'Open a dispute',
    description:
      'Ask the escrow to decide a funded order: items not delivered, wrong item, or the shopper not releasing. Sends the claim with all signed order messages as evidence (copy to the shopper) ' +
      'and the key that lets the escrow decrypt the delivery address. No funds move now; the escrow later rules a split, which you check with review_ruling and execute with countersign_ruling. ' +
      'Without confirm: true it only shows what would be sent.',
    inputSchema: {
      order_id: ORDER_ID,
      claim: z.enum(['not_delivered', 'wrong_item', 'not_released', 'other']).describe('what went wrong'),
      text: z.string().min(1).max(2000).describe('your explanation for the escrow (facts, dates, tracking)'),
      requested_split: z.object({
        user: z.string().regex(/^\d+$/).describe('amount back to you'),
        shopper: z.string().regex(/^\d+$/).describe('amount to the shopper'),
      }).optional().describe('the split you ask for, as integers in sats (BTC) or USDC base units (6 decimals)'),
      confirm: CONFIRM,
    },
    annotations: msg,
  }, safely((a) => t.openDispute(a)));

  server.registerTool('review_ruling', {
    title: "Review the escrow's ruling",
    description:
      "Show the escrow's ruling for a disputed order — the split between you, the shopper and the escrow fee, and its reason — and whether the escrow's transaction really pays exactly that split. " +
      'Read-only. If it matches, countersign_ruling executes it; if not, do not countersign and consider report.',
    inputSchema: { order_id: ORDER_ID },
    annotations: { ...local },
  }, safely((a) => t.reviewRuling(a)));

  server.registerTool('countersign_ruling', {
    title: 'Countersign the ruling',
    description:
      "Moves money: add your signature to the escrow's ruling transaction (2 of 3) and broadcast it, settling the dispute. Refused if the transaction does not pay the ruled split. " +
      'Without confirm: true it returns the same review as review_ruling. Ask your human before confirming.',
    inputSchema: { order_id: ORDER_ID, confirm: CONFIRM },
    annotations: money,
  }, safely((a) => t.countersignRuling(a)));

  server.registerTool('accept_refund_offer', {
    title: "Accept the shopper's refund",
    description:
      'Moves money: co-sign and broadcast a cooperative refund the shopper offered (e.g. the item was sold out or delivery failed), returning the funds to your wallet. ' +
      'Refused if the offer does not pay you as the refund template requires. Without confirm: true it shows the offer and its check. Errors if there is no offer (get_order shows refund_offer).',
    inputSchema: { order_id: ORDER_ID, confirm: CONFIRM },
    annotations: money,
  }, safely((a) => t.acceptRefundOffer(a)));

  server.registerTool('refund_after_timelock', {
    title: 'Take the funds back after T2',
    description:
      'Moves money, last resort: after the T2 timelock you alone can take the locked funds back to your wallet (e.g. the shopper disappeared). ' +
      'Without confirm: true it shows T2, the current block height or chain time, whether T2 is reached, and the amount. Before T2 the chain rejects it; prefer accept_refund_offer or open_dispute while the shopper responds.',
    inputSchema: { order_id: ORDER_ID, confirm: CONFIRM },
    annotations: money,
  }, safely((a) => t.refundAfterTimelock(a)));

  server.registerTool('cancel_order', {
    title: 'Cancel an order before funding',
    description:
      'Cancel an order that is not funded yet (requested, quoted or accepted) and tell the shopper (best effort). Refused once funding has started — then use open_dispute, accept_refund_offer or refund_after_timelock. Nothing is paid or refunded.',
    inputSchema: { order_id: ORDER_ID, reason: z.string().max(500).optional().describe('reason sent to the shopper (default "cancelled by user")') },
    annotations: msg,
  }, safely((a) => t.cancelOrder(a)));

  server.registerTool('report', {
    title: 'Report a shopper or escrow',
    description:
      "Report the order's shopper or escrow to the operator that listed them, attaching the order's signed messages as evidence (e.g. a dishonest ruling, a quote that failed validation, no delivery). " +
      'Sends one signed message; no funds move and the order is not changed otherwise. The operator may remove them from its list.',
    inputSchema: {
      order_id: ORDER_ID,
      subject: z.enum(['shopper', 'escrow']).describe('whom to report'),
      text: z.string().min(1).max(2000).describe('what happened'),
    },
    annotations: msg,
  }, safely((a) => t.report(a)));

  server.registerTool('export_backup', {
    title: 'Export the recovery words',
    description:
      "Show this agent's 12-word BIP39 mnemonic, which controls the identity and every order's escrow key, with restore instructions. Only with confirm: true — the words then stay in the conversation, and anyone who sees them can take the funds; " +
      'use only when your human asks for a backup. Local, no network.',
    inputSchema: { confirm: CONFIRM },
    annotations: local,
  }, safely((a) => t.exportBackup(a)));

  server.registerTool('become_shopper', {
    title: 'Earn as a proxy shopper',
    description:
      'Return a step-by-step plan to earn fees as a proxy shopper (buying at local shops for remote users who pay into the escrow): requirements (always-online host, Docker, the Go node and shopper-bot images, card or cash regions), ' +
      'fees and risks, an honest status of the network, a ps-main node config and compose file, and how to get listed through the registry (then registry_entry). Local, no network, nothing is started.',
    inputSchema: {
      name: z.string().max(48).optional().describe('your shopper display name'),
      regions: z.array(z.string().max(40)).max(20).optional().describe('regions you serve, as region codes (e.g. JP-13)'),
      cash_regions: z.array(z.string().max(40)).max(20).optional().describe('regions where you can pay cash in person (e.g. JP-13-13104)'),
      fee_bps: z.number().int().min(0).max(5000).optional().describe('your fee in basis points (100 = 1 %)'),
    },
    annotations: local,
  }, safely((a) => t.becomeShopper(a)));

  server.registerTool('registry_entry', {
    title: 'Registry entry for getting listed',
    description:
      'Return the exact JSON file and path to add in a pull request to github.com/pad01g/proxy-shopping-registry, so a shopper, escrow, operator or coordinator gets listed once the maintainer merges it: ' +
      'shoppers/<name>.json {pk, contact, description, regions (cash regions), payments, escrows}; escrows/<name>.json {pk, contact, description, sla_days}; ' +
      'operators/<name>.json {pk, contact, description, regions}; coordinators/<name>.json {pk, contact, description, url?, bundle?}. ' +
      "Uses this data dir's identity pubkey unless pubkey is given (a shopper entry must carry the shopper node's key). Local; opens no pull request itself.",
    inputSchema: {
      role: z.enum(['shopper', 'escrow', 'operator', 'coordinator']).describe('which list to join'),
      name: z.string().min(1).max(40).describe('file name: a-z, 0-9 and - (other characters are turned into -)'),
      contact: z.string().min(1).max(200).describe('how reviewers and users reach you, e.g. "github:<user>" or "nostr:npub1…"'),
      description: z.string().min(1).max(300).describe('one or two sentences: what you do, where, how'),
      pubkey: PUBKEY.optional().describe('64 hex Nostr public key (psctl keys: nostr_pubkey)'),
      regions: z.array(z.string().max(40)).max(64).optional().describe('shopper: your cash regions; operator: where you list (JP, JP-13, JP-13-13104)'),
      payments: z.array(z.literal('btc-signet')).optional().describe('shopper: default ["btc-signet"] (the only payment on ps-main)'),
      escrows: z.array(z.string().max(40)).max(32).optional().describe('shopper (required): names of the escrows/<name>.json you work with'),
      sla_days: z.number().int().min(1).max(365).optional().describe('escrow: most days from a dispute to your ruling (default 14)'),
      url: z.string().max(256).optional().describe('coordinator: https URL of your page'),
      bundle: z.string().max(256).optional().describe('coordinator: https URL of your signed events.json'),
    },
    annotations: local,
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
