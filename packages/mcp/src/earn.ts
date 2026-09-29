/**
 * The earning side: what it takes to run as a proxy shopper, and the registry entry for getting listed.
 */
import { PS_MAIN_DEFAULT_COORDINATOR, REGISTRY_REPO, psMainPreset } from './config.js';

export const NODE_IMAGE = 'ghcr.io/pad01g/proxy-shopping-node';
export const BOT_IMAGE = 'ghcr.io/pad01g/proxy-shopping-shopper-bot';

export interface ShopperPlanInput {
  name?: string;
  /** Regions the shopper buys for (card shops anywhere the entries cover), e.g. ["JP-13"]. */
  regions?: string[];
  /** Regions where the shopper can pay cash in person, e.g. ["JP-13"]. */
  cashRegions?: string[];
  feeBps?: number;
  identityPubkey?: string;
}

const slug = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/** The ps-main shopper node config (psnode -config), as in proxy-shopping-docs quickstart "Run on a public network". */
export function shopperNodeConfig(p: Required<Pick<ShopperPlanInput, 'name' | 'cashRegions' | 'feeBps'>>): string {
  const main = psMainPreset();
  return [
    'role: shopper',
    `name: ${p.name}`,
    'network: ps-main',
    'mnemonic_file: /keys/shopper.mnemonic   # a NEW mnemonic for the node; never reuse lab keys or this MCP identity',
    'data_dir: /data',
    'admin: {listen: "127.0.0.1:8080", token: "<long random token>"}',
    'nostr:',
    `  relays: [${main.relays.map((r) => `"${r}"`).join(', ')}]`,
    '  k: 2',
    'p2p:',
    '  listen: ["/ip4/0.0.0.0/tcp/4001"]',
    '  reachability: auto',
    'trust:',
    `  coordinators: ["${PS_MAIN_DEFAULT_COORDINATOR}"]`,
    'chain:',
    `  btc: {network: signet, esplora: "${main.esplora}"}`,
    'fx:',
    '  sources:',
    '    - {type: coingecko, base: "https://api.coingecko.com"}',
    '    - {type: frankfurter, base: "https://api.frankfurter.app"}',
    'shopper:',
    '  bot_url: "http://shopper-bot:7000"',
    '  payments: [btc-signet]            # USDC is not available on ps-main yet',
    '  currencies: [JPY]',
    `  cash_regions: [${p.cashRegions.join(', ')}]`,
    `  fee: {bps: ${p.feeBps}, min: {amount: "300", currency: JPY}}`,
    '  max_order: {amount: "30000", currency: JPY}',
    '  delivery_days: 5',
    '  risk: {allowlist: [<shop hosts you have drivers for>], known_gateways: [<card gateways those shops use>], threshold: 70}',
    '  # timelocks default to the spec: T1 = delivery_days + 21 days, T2 = T1 + 14 days',
    '  confirmations: 1',
    '  payout_confirmations: 3',
    '  accept_rulings: always',
    '',
  ].join('\n');
}

export function composeFile(): string {
  return [
    'services:',
    '  node:',
    `    image: ${NODE_IMAGE}:latest`,
    '    command: ["psnode", "-config", "/config/shopper.yaml"]',
    '    restart: unless-stopped',
    '    ports: ["4001:4001"]          # libp2p; optional but helps other Go nodes reach you',
    '    volumes:',
    '      - ./shopper.yaml:/config/shopper.yaml:ro',
    '      - ./keys:/keys:ro             # keys/shopper.mnemonic, mode 0600',
    '      - node_data:/data',
    '  shopper-bot:',
    `    image: ${BOT_IMAGE}:latest`,
    '    restart: unless-stopped',
    '    environment:',
    '      BOT_CARDS_FILE: /secrets/cards.json   # {"cards": {"default": {"number","exp","cvc","name"}}}; only the bot ever sees card data',
    '    volumes:',
    '      - ./cards.json:/secrets/cards.json:ro',
    '      - bot_data:/data',
    'volumes: {node_data: {}, bot_data: {}}',
    '',
  ].join('\n');
}

export function becomeShopperPlan(input: ShopperPlanInput = {}) {
  const name = slug(input.name ?? 'my-shopper').slice(0, 40).replace(/-+$/, '') || 'my-shopper';
  const cashRegions = input.cashRegions?.length ? input.cashRegions : ['JP-13'];
  const regions = input.regions?.length ? input.regions : cashRegions;
  const feeBps = input.feeBps ?? 500;
  const config = shopperNodeConfig({ name, cashRegions, feeBps });
  return {
    summary:
      'A proxy shopper buys at shops that do not take crypto (cash-only, unsupported card gateways) for users who pay in BTC into a 2-of-3 escrow ' +
      '(user, shopper, escrow). You earn your fee (shopper_fee in the quote) when the user confirms receipt, or when an escrow rules for you.',
    honest_status:
      'ps-main is new. Users find you only after an operator trusted by a coordinator lists you (shopper × escrow per region). ' +
      'Payments on ps-main are signet BTC today, which has no market value: treat it as a trial run. The images may not be published yet; ' +
      'if a pull fails, build them from source (proxy-shopping-go: node/ and shopper-bot/).',
    requirements: [
      'An always-online host (a small VPS or home server) with Docker: the shopper answers requests, watches the chain and co-signs payouts; users are not online all the time.',
      `The Go node image ${NODE_IMAGE} (psnode, role shopper) and the shopper-bot image ${BOT_IMAGE} (Playwright automation that operates the shop pages).`,
      'A shopper-bot driver for each shop you serve (cards via a known gateway), and/or the ability to buy in person with cash in your cash_regions.',
      'A payment method: a card for card shops (only shopper-bot sees it, via BOT_CARDS_FILE) or cash for cash-only shops; you pay first and are repaid from the escrow.',
      'A delivery route to the user (the shop ships to the address the user sends encrypted to you, or you forward).',
      'A fresh BIP39 mnemonic for the node (identity + BTC keys). Back it up offline; do not reuse this MCP identity for an always-online node.',
    ],
    fees: {
      shopper_fee: `fee.bps of the item total with a minimum (this plan uses ${feeBps} bps = ${(feeBps / 100).toFixed(2)} %, minimum 300 JPY). It is added to the quote and paid with the rest when the user releases.`,
      costs: 'You front the purchase price and bear shop/card fees. The escrow takes its upfront fee from the user (not from you) and dispute_fee_bps only in disputes.',
      risk: 'If a user disputes, the escrow decides the split before T1 using the signed messages and your evidence (receipts, tracking). After T1 you can claim the funds alone if no dispute was opened.',
    },
    regions: { serve: regions, cash_regions: cashRegions },
    steps: [
      'Create a new BIP39 mnemonic for the node, store it as keys/shopper.mnemonic (mode 0600, backed up offline); `psctl keys --mnemonic-file keys/shopper.mnemonic` prints its nostr_pubkey.',
      'Write shopper.yaml (below) and cards.json (card shops only), then docker compose up -d with the compose file below.',
      'Check the node: its admin API on 127.0.0.1:8080 (GET /status with the bearer token) shows the pubkey and trust state. It publishes your shopper profile (kind 30502) with your fee, regions and delivery_days.',
      'Agree with one or more escrows that are (or will be) in the registry (escrows/<name>.json); users only see you paired with an escrow.',
      `Get listed: open a pull request to ${REGISTRY_REPO} adding shoppers/${name}.json: {pk, contact, description, regions (your cash regions), payments: ["btc-signet"], escrows: [names of escrows/<name>.json you agreed with]}. The registry_entry tool writes it (role "shopper", pubkey = the node's nostr_pubkey from psctl keys). After the merge the registry's signed ps-main list pairs you with those escrows.`,
      'Once the signed list includes you, users see you in find_offers. Keep the node online and answer quotes quickly.',
    ],
    files: {
      'shopper.yaml': config,
      'compose.yaml': composeFile(),
    },
    registry: { repository: REGISTRY_REPO, path: `shoppers/${name}.json`, tool: 'registry_entry' },
    identity_note: input.identityPubkey
      ? `This MCP server's identity is ${input.identityPubkey}. Use it for the registry entry only if you really run the node with this mnemonic; normally pass the node's own pubkey.`
      : undefined,
  };
}

export type RegistryRole = 'shopper' | 'escrow' | 'operator' | 'coordinator';

export interface RegistryEntryInput {
  role: RegistryRole;
  name: string;
  contact: string;
  description: string;
  pubkey: string;
  /** shopper: cash regions; operator: regions where the operator lists. */
  regions?: string[];
  /** shopper: payments offered (only btc-signet on ps-main). */
  payments?: string[];
  /** shopper: names of the escrows/<name>.json the shopper works with. */
  escrows?: string[];
  /** escrow: most days from a dispute to the ruling (1-365). */
  slaDays?: number;
  /** coordinator: https URL of its page. */
  url?: string;
  /** coordinator: https URL of its signed events.json. */
  bundle?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REGION = /^[A-Z]{2}(-[A-Z0-9]{1,10}){0,4}$/;
const HTTPS = /^https:\/\/[^\s"<>]+$/;

function regionList(v: string[] | undefined, what: string): string[] {
  if (!v?.length || v.length > 64) throw new Error(`${what}: give 1-64 region codes, e.g. ["JP-13"]`);
  const bad = v.filter((r) => !REGION.test(r));
  if (bad.length) throw new Error(`${what}: not region codes (JP, JP-13, JP-13-13104): ${bad.join(', ')}`);
  if (new Set(v).size !== v.length) throw new Error(`${what}: a region is listed twice`);
  return v;
}

/**
 * The file for a pull request to proxy-shopping-registry, exactly in the registry's format (README "Roles",
 * scripts/registry.ts validate, which rejects unknown fields):
 *   shoppers/<name>.json     {pk, contact, description, regions (cash regions), payments, escrows}
 *   escrows/<name>.json      {pk, contact, description, sla_days}
 *   operators/<name>.json    {pk, contact, description, regions}
 *   coordinators/<name>.json {pk, contact, description, url?, bundle?}
 */
export function registryEntry(p: RegistryEntryInput) {
  const pk = p.pubkey.trim().toLowerCase();
  if (!HEX64.test(pk)) throw new Error('pubkey must be the 64-character hex Nostr public key (x-only, not npub)');
  const name = slug(p.name).slice(0, 40).replace(/-+$/, '');
  if (!NAME.test(name)) throw new Error('name must contain letters or digits (the file name is a-z, 0-9 and -, at most 40 characters)');
  const contact = p.contact.trim();
  const description = p.description.trim();
  if (!contact || contact.length > 200) throw new Error('contact is required (e.g. "github:<user>"), at most 200 characters');
  if (!description || description.length > 300) throw new Error('description is required, at most 300 characters');
  const content: Record<string, unknown> = { pk, contact, description };
  if (p.role === 'shopper') {
    content.regions = regionList(p.regions, 'regions (your cash regions)');
    const payments = p.payments?.length ? p.payments : ['btc-signet'];
    const bad = payments.filter((x) => x !== 'btc-signet');
    if (bad.length) throw new Error(`payments: ps-main offers only btc-signet (not ${bad.join(', ')})`);
    content.payments = [...new Set(payments)];
    const escrows = p.escrows ?? [];
    if (!escrows.length || escrows.length > 32) throw new Error('escrows: give the names (escrows/<name>.json) of 1-32 escrows you agreed to work with');
    const badE = escrows.filter((e) => !NAME.test(e));
    if (badE.length) throw new Error(`escrows: not registry names: ${badE.join(', ')}`);
    if (new Set(escrows).size !== escrows.length) throw new Error('escrows: an escrow is listed twice');
    content.escrows = escrows;
  } else if (p.role === 'escrow') {
    const sla = p.slaDays ?? 14;
    if (!Number.isInteger(sla) || sla < 1 || sla > 365) throw new Error('sla_days must be an integer 1-365');
    content.sla_days = sla;
  } else if (p.role === 'operator') {
    content.regions = regionList(p.regions, 'regions (where you list)');
  } else {
    if (p.url !== undefined) {
      if (!HTTPS.test(p.url) || p.url.length > 256) throw new Error('url must be an https URL');
      content.url = p.url;
    }
    if (p.bundle !== undefined) {
      if (!HTTPS.test(p.bundle) || p.bundle.length > 256) throw new Error('bundle must be the https URL of your signed events.json');
      content.bundle = p.bundle;
    }
  }
  const path = `${p.role}s/${name}.json`;
  const json = `${JSON.stringify(content, null, 2)}\n`;
  const how: Record<RegistryRole, string> = {
    shopper: 'Run your shopper node on ps-main with this key first; the escrows you name must be (or become) escrows/<name>.json, others are skipped with a warning.',
    escrow: 'Run an escrow node (or the web app escrow page) on ps-main with this key; sla_days goes into every list entry with you.',
    operator: 'After the merge the coordinator publishes its delegation to you; sign and publish your own list (psctl list … --publish wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net).',
    coordinator: 'Being listed only makes you findable in the directory; users choose their coordinators themselves.',
  };
  return {
    path,
    content,
    json,
    pull_request: {
      repository: REGISTRY_REPO,
      title: `Add ${p.role} ${name}`,
      steps: [
        `Fork ${REGISTRY_REPO} and add ${path} with exactly this JSON (unknown fields are rejected).`,
        'Check it with `npm ci && node scripts/registry.ts validate` in the registry checkout (Node 24).',
        `Open a pull request titled "Add ${p.role} ${name}".`,
        how[p.role],
      ],
    },
  };
}
