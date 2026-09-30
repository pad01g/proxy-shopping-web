/**
 * The lab's fake shops, card gateway and shopper-bot, in one place (proxy-shopping-go/fakeshop and
 * shopper-bot, docs/lab.md「店の商品」): what the shopper node sees when it inspects a shop (TLS, payment
 * gateway, cash only, region), the catalogs, a purchase by the bot (SOLDOUT- fails before payment) and the
 * tracking the shop reports (shipped 2 s after the purchase, delivered — or failed for FAIL- — 3 s later).
 */
import { sha256 } from '@noble/hashes/sha2';
import { toHex, type Address, type Evidence, type Money, type TrackingStatus } from '@proxy-shopping/core/browser';

export interface ShopInfo {
  host: string;
  https: boolean;
  certOk: boolean;
  gateway?: string;
  cashOnly: boolean;
  region?: string;
}

interface Shop {
  host: string;
  name: string;
  currency: 'JPY' | 'USD';
  /** Minor units (yen, cents). */
  shipping: number;
  https: boolean;
  gateway?: string;
  cashOnly?: boolean;
  region: string;
  prefix: string;
  carrier: string;
  products: Array<{ sku: string; name: string; price: number }>;
}

export const SHOPS: Shop[] = [
  {
    host: 'safe-shop.test', name: '安心ショップ', currency: 'JPY', shipping: 800, https: true, gateway: 'cardgw.test', region: 'JP-13', prefix: 'SS', carrier: 'Yamato',
    products: [
      { sku: 'A-100', name: '抹茶ティーセット', price: 3200 },
      { sku: 'A-200', name: '南部鉄器の急須', price: 12000 },
      { sku: 'FAIL-100', name: '配送に失敗する商品', price: 2000 },
      { sku: 'SOLDOUT-100', name: '在庫切れの商品', price: 2500 },
    ],
  },
  {
    host: 'us-shop.test', name: 'US Shop', currency: 'USD', shipping: 1000, https: true, gateway: 'cardgw.test', region: 'US', prefix: 'US', carrier: 'UPS',
    products: [{ sku: 'U-100', name: 'Coffee beans 1kg', price: 2500 }],
  },
  {
    host: 'cash-store.test', name: '新宿和菓子店', currency: 'JPY', shipping: 1000, https: true, cashOnly: true, region: 'JP-13-13104', prefix: 'CS', carrier: 'Yamato',
    products: [{ sku: 'C-100', name: '店頭限定の和菓子', price: 1500 }],
  },
  {
    // HTTP only, and a payment page of its own: the shopper's risk check turns it down.
    host: 'risky-shop.test', name: 'Risky Deals', currency: 'USD', shipping: 0, https: false, gateway: 'risky-shop.test', region: 'US', prefix: 'RK', carrier: 'Unknown Post',
    products: [{ sku: 'R-100', name: 'Too-cheap headphones', price: 999 }],
  },
];

const DECIMALS = { JPY: 0, USD: 2 } as const;
const money = (minor: number, cur: 'JPY' | 'USD'): Money => ({ amount: (minor / 10 ** DECIMALS[cur]).toFixed(DECIMALS[cur]), currency: cur });

function shopOf(url: string): Shop | undefined {
  try {
    const u = new URL(url);
    const s = SHOPS.find((x) => x.host === u.hostname.toLowerCase());
    // The shop answers on its own scheme only (risky-shop is http only; the others redirect http → https).
    if (!s || (u.protocol === 'https:' && !s.https)) return undefined;
    return s;
  } catch {
    return undefined;
  }
}

/** What the shopper node's shop inspector reports (node/internal/shop). */
export function inspectShop(url: string): ShopInfo {
  const s = shopOf(url);
  if (!s) throw new Error('shop not reachable');
  return { host: s.host, https: s.https, certOk: s.https, gateway: s.gateway, cashOnly: !!s.cashOnly, region: s.region };
}

export function catalogOf(url: string): { currency: 'JPY' | 'USD'; shipping: Money; products: Array<{ sku: string; name: string; price: Money }> } {
  const s = shopOf(url);
  if (!s) throw new Error('catalog: shop not reachable');
  return { currency: s.currency, shipping: money(s.shipping, s.currency), products: s.products.map((p) => ({ sku: p.sku, name: p.name, price: money(p.price, s.currency) })) };
}

export interface PurchaseResult {
  request_id: string;
  status: 'ok' | 'failed' | 'needs_human';
  shop_order_id?: string;
  total?: Money;
  error?: string;
  evidence: Evidence[];
}

interface ShopOrder {
  id: string;
  shop: string;
  items: Array<{ sku: string; qty: number }>;
  paidAt: number;
}

export interface ShopsState {
  /** Bot results by request_id (the bot answers a repeated request from its records, spec §9). */
  purchases: Record<string, PurchaseResult>;
  orders: Record<string, ShopOrder>;
}

const evidenceOf = (kind: Evidence['kind'], mime: string, text: string): Evidence => {
  const data = new TextEncoder().encode(text);
  return { kind, mime, sha256: toHex(sha256(data)), data_b64: btoa(String.fromCharCode(...data)) };
};

/** shopper-bot + the shops' order and tracking APIs. */
export class MockShops {
  readonly state: ShopsState;

  constructor(
    state?: ShopsState,
    private readonly onChange?: () => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.state = state ?? { purchases: {}, orders: {} };
  }

  /** POST /purchase of shopper-bot. */
  purchase(req: { request_id: string; shop_url: string; items: Array<{ sku: string; qty: number }>; shipping: Address; payment_ref: string; max_amount: Money }): PurchaseResult {
    const done = this.state.purchases[req.request_id];
    if (done) return done;
    const s = shopOf(req.shop_url);
    let result: PurchaseResult;
    if (!s) {
      result = { request_id: req.request_id, status: 'needs_human', error: `no driver for ${req.shop_url}`, evidence: [] };
    } else if (!!s.cashOnly !== (req.payment_ref === 'cash')) {
      result = { request_id: req.request_id, status: 'failed', error: s.cashOnly ? `this store takes cash only, not ${req.payment_ref}` : `this shop takes cards only, not ${req.payment_ref}`, evidence: [] };
    } else {
      const missing = req.items.find((i) => !s.products.some((p) => p.sku === i.sku));
      const soldOut = req.items.find((i) => i.sku.startsWith('SOLDOUT-'));
      const total = req.items.reduce((n, i) => n + (s.products.find((p) => p.sku === i.sku)?.price ?? 0) * i.qty, 0) + s.shipping;
      if (missing) {
        result = { request_id: req.request_id, status: 'failed', error: `the shop has no product ${missing.sku}`, evidence: [] };
      } else if (soldOut) {
        // The shop refuses the order when it is placed: nothing was paid.
        result = { request_id: req.request_id, status: 'failed', error: `sold out: ${soldOut.sku}`, evidence: [] };
      } else if (Number(req.max_amount.amount) * 10 ** DECIMALS[s.currency] < total) {
        result = { request_id: req.request_id, status: 'failed', error: `checkout total ${money(total, s.currency).amount} exceeds ${req.max_amount.amount}`, evidence: [] };
      } else {
        const id = `${s.prefix}-${req.request_id.slice(0, 8).toUpperCase()}`;
        this.state.orders[id] = { id, shop: s.host, items: req.items, paidAt: this.now() };
        const totalMoney = money(total, s.currency);
        const receipt = `<html><body><h1>${s.name}</h1><p>order ${id}</p><ul>${req.items.map((i) => `<li>${i.sku} × ${i.qty}</li>`).join('')}</ul><p>total ${totalMoney.amount} ${totalMoney.currency}</p><p>paid with ${s.cashOnly ? 'cash' : 'card via cardgw.test'} (mock)</p></body></html>`;
        result = {
          request_id: req.request_id, status: 'ok', shop_order_id: id, total: totalMoney,
          evidence: [evidenceOf('receipt', 'text/html', receipt), evidenceOf('json', 'application/json', JSON.stringify({ shop: s.host, order: id, total: totalMoney }))],
        };
      }
    }
    this.state.purchases[req.request_id] = result;
    this.onChange?.();
    return result;
  }

  /** GET /tracking of shopper-bot (the shop's order API). */
  tracking(shopOrderId: string): TrackingStatus {
    const o = this.state.orders[shopOrderId];
    if (!o) throw new Error(`unknown shop order ${shopOrderId}`);
    const shop = SHOPS.find((s) => s.host === o.shop)!;
    const t = this.now();
    const shipAt = o.paidAt + 2000;
    const doneAt = shipAt + 3000;
    const fails = o.items.some((i) => i.sku.startsWith('FAIL-'));
    const status: TrackingStatus['status'] = t >= doneAt ? (fails ? 'failed' : 'delivered') : t >= shipAt ? 'shipped' : 'processing';
    const at = status === 'processing' ? o.paidAt : status === 'shipped' ? shipAt : doneAt;
    return {
      status,
      ...(status === 'processing' ? {} : { carrier: shop.carrier, tracking_no: `${shop.prefix}${toHex(sha256(new TextEncoder().encode(o.id))).slice(0, 10).toUpperCase()}` }),
      updated_at: Math.floor(at / 1000),
      evidence: [],
    };
  }
}
