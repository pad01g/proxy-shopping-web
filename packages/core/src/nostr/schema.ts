/**
 * Schemas of the message bodies of §4.3–§4.9 (spec §4.10: validate type, digits and lengths;
 * drop what does not fit). Receivers only ever see bodies that passed these checks.
 */
import {
  arr, base64, bool, btcAddress, decStr, either, evmAddress, evmHash, hex64, hexN, int, map, obj, oneOf, opt, str, tryParse,
  uintStr, union, url, utf8Str, type Check,
} from '../util/validate.js';
import type { Inner } from './giftwrap.js';
import {
  MSG, type Attachment, type DisputeEvidence, type DisputeOpen, type DisputeRuling, type EscrowNotice, type Evidence,
  type Money, type OrderEscrowKey, type OrderFunded, type OrderPurchased, type OrderQuote, type OrderRequest,
  type OrderShipping, type Report, type SafeTxJson, type SignedPayout, type TrackingStatus,
} from './messages.js';

const payment = oneOf('btc-signet', 'usdc-evm');
const btcPubkey = hexN(33);
const txid = hex64;
const anyTxid = either(hex64, evmHash);
const text = (max = 4000) => str(max);
const region = str(64, /^[A-Z]{2}(-[A-Z0-9]{1,10}){0,4}$/);
const orderId = str(32, /^[0-9a-f]{32}$/);

/** A signed event as JSON (signature is verified separately with isValidInner). */
export const innerEvent: Check<Inner> = obj({
  id: hex64,
  pubkey: hex64,
  created_at: int(),
  kind: int(0, 65535),
  tags: arr(arr(str(1024), 8, { required: true }), 32, { required: true }),
  content: str(64 * 1024),
  sig: hexN(64),
});

export const money: Check<Money> = obj({ amount: decStr, currency: str(8, /^[A-Za-z]{2,8}$/) });

export const evidence: Check<Evidence> = obj({
  kind: oneOf('screenshot', 'receipt', 'html', 'json'),
  sha256: hex64,
  mime: str(100, /^[\w.+-]+\/[\w.+-]+$/),
  data_b64: opt(base64(16 * 1024)),
});

/** updated_at is UNIX seconds; Go passes the bot's value through, so accept a numeric or ISO string too. */
const unixTime: Check<number> = (v, path) => {
  if (typeof v === 'string') {
    const n = /^\d+$/.test(v) ? Number(v) : Math.floor(Date.parse(v) / 1000);
    return int()(n, path);
  }
  return int()(v, path);
};

export const trackingStatus: Check<TrackingStatus> = obj({
  status: oneOf('processing', 'shipped', 'delivered', 'failed'),
  carrier: opt(str(100)),
  tracking_no: opt(str(100)),
  updated_at: (v, path) => (v === undefined || v === null ? 0 : unixTime(v, path)),
  evidence: arr(evidence, 20),
});

/** §4.10 request limits: at most 20 items, qty 1..99, sku up to 64 bytes. */
export const REQUEST_LIMITS = { items: 20, qtyMax: 99, skuBytes: 64 } as const;

/** Why `items` break the §4.10 request limits (undefined = fine), for clients to refuse before signing. */
export function requestItemsProblem(items: Array<{ sku: string; qty: number }>): string | undefined {
  if (!items.length) return 'no items';
  if (items.length > REQUEST_LIMITS.items) return `at most ${REQUEST_LIMITS.items} items per request`;
  for (const i of items) {
    if (!Number.isSafeInteger(i.qty) || i.qty < 1 || i.qty > REQUEST_LIMITS.qtyMax) return `qty of ${i.sku} must be 1..${REQUEST_LIMITS.qtyMax}`;
    if (!i.sku || new TextEncoder().encode(i.sku).length > REQUEST_LIMITS.skuBytes) return `sku must be 1..${REQUEST_LIMITS.skuBytes} bytes`;
  }
  return undefined;
}

/**
 * §4.4.1 key_proof: lower-case hex without 0x — 64 bytes (BIP340, btc-signet) or 65 bytes (EIP-191, usdc-evm).
 * Other spellings of the same signature are refused so every implementation sees the same bytes.
 */
export const KEY_PROOF = /^(?:[0-9a-f]{128}|[0-9a-f]{130})$/;

export const orderRequest: Check<OrderRequest> = obj({
  shop_url: url,
  shop_region: region,
  items: arr(obj({ sku: utf8Str(REQUEST_LIMITS.skuBytes), qty: int(1, REQUEST_LIMITS.qtyMax) }), REQUEST_LIMITS.items, { required: true }),
  payment,
  escrow: hex64,
  operator: hex64,
  coordinator: hex64,
  delivery: obj({ ciphertext: base64(8 * 1024), key_for_shopper: str(2048), key_for_escrow_sha256: hex64 }),
  key_proof: str(130, KEY_PROOF),
  user_btc_pubkey: opt(btcPubkey),
  user_btc_address: opt(btcAddress),
  user_evm_address: opt(evmAddress),
  relays: arr(str(256), 16),
});

export const orderQuote: Check<OrderQuote> = obj({
  accept: bool,
  reject_reason: opt(str(64)),
  detail: opt(text(1000)),
  expires_at: opt(int()),
  price: opt(obj({ items: money, shipping: money, shopper_fee: money })),
  fx: opt(obj({
    pair: str(20, /^[A-Z]{2,8}\/[A-Z]{2,8}$/),
    rate: decStr,
    sources: arr(obj({ name: str(64), rate: decStr, at: int() }), 16),
    at: int(),
  })),
  asset: opt(payment),
  lock_amount: opt(uintStr),
  escrow_upfront_fee: opt(uintStr),
  payout_fee_reserve: opt(uintStr),
  timelock: opt(obj({ t1: int(), t2: int() })),
  shopper_btc_pubkey: opt(btcPubkey),
  shopper_btc_address: opt(btcAddress),
  escrow_btc_pubkey: opt(btcPubkey),
  escrow_btc_fee_address: opt(btcAddress),
  shopper_evm_address: opt(evmAddress),
  escrow_evm_address: opt(evmAddress),
  escrow_address: opt(either(btcAddress, evmAddress)),
});

export const orderFunded: Check<OrderFunded> = union<OrderFunded>('asset', {
  'btc-signet': obj({
    asset: oneOf('btc-signet'),
    txid,
    vout: map(opt(int(0, 10_000)), (v) => v ?? 0),
    amount: uintStr,
    fee_txid: map(opt(txid), (v) => v ?? ''),
  }),
  'usdc-evm': obj({
    asset: oneOf('usdc-evm'),
    safe: evmAddress,
    deploy_tx: str(80),
    fund_tx: evmHash,
    fee_tx: map(opt(either(evmHash, str(0))), (v) => v ?? ''),
    amount: uintStr,
  }),
});

export const safeTxJson: Check<SafeTxJson> = obj({
  to: evmAddress,
  value: uintStr,
  data: str(64 * 1024, /^0x([0-9a-fA-F]{2})*$/),
  operation: map(either(oneOf('0', '1'), int(0, 1)), String),
  safeTxGas: uintStr,
  baseGas: uintStr,
  gasPrice: uintStr,
  gasToken: evmAddress,
  refundReceiver: evmAddress,
  nonce: uintStr,
});

/** 65-byte ECDSA signature with v = 27 / 28 (§6.4); Safe reads v = 0 / 1 as contract / approved-hash signatures. */
const evmSignature = str(132, /^0x[0-9a-fA-F]{128}(1b|1c|1B|1C)$/);

export const signedPayout: Check<SignedPayout> = union<SignedPayout>('asset', {
  'btc-signet': obj({ asset: oneOf('btc-signet'), psbt: base64(32 * 1024) }),
  'usdc-evm': obj({ asset: oneOf('usdc-evm'), safe_tx: safeTxJson, signature: evmSignature }),
});

export const disputeEvidence: Check<DisputeEvidence> = obj({
  messages: arr(innerEvent, 200),
  tracking: arr(trackingStatus, 100),
  purchase_evidence: arr(evidence, 50),
  delivery_key_for_escrow: opt(str(2048)),
  text: opt(text()),
});

export const disputeOpen: Check<DisputeOpen> = obj({
  claim: oneOf('not_delivered', 'wrong_item', 'not_released', 'other'),
  text: map(opt(text()), (v) => v ?? ''),
  requested_split: opt(obj({ user: uintStr, shopper: uintStr })),
  evidence: map(opt(disputeEvidence), (v) => v ?? { messages: [], tracking: [], purchase_evidence: [] }),
});

export const disputeRuling: Check<DisputeRuling> = obj({
  split: obj({ user: uintStr, shopper: uintStr, escrow_fee: uintStr }),
  reason: map(opt(text()), (v) => v ?? ''),
  asset: payment,
  psbt: opt(base64(32 * 1024)),
  safe_tx: opt(safeTxJson),
  signature: opt(evmSignature),
  no_obligation: opt(bool),
});

export const escrowNotice: Check<EscrowNotice> = obj({ request: innerEvent, quote: innerEvent, accept: innerEvent, funded: innerEvent });

export const orderPurchased: Check<OrderPurchased> = obj({ shop_order_id: str(128), total: money, evidence: arr(evidence, 50) });

export const orderShipping: Check<OrderShipping> = obj({ status: oneOf('shipped', 'delivered', 'failed'), tracking: trackingStatus });

export const report: Check<Report> = obj({ subject: hex64, order_id: either(orderId, str(0)), text: text(), evidence: arr(innerEvent, 200) });

export const attachment: Check<Attachment> = obj({
  sha256: hex64,
  mime: str(100, /^[\w.+-]+\/[\w.+-]+$/),
  index: int(0, 255),
  total: int(1, 256),
  data_b64: base64(24 * 1024),
});

export const orderEscrowKey: Check<OrderEscrowKey> = obj({ key_for_escrow: str(2048) });

/** Body schema per message type (`t` tag). Types without an entry are dropped. */
export const BODY_SCHEMAS: Record<string, Check<unknown>> = {
  [MSG.ack]: obj({ ids: arr(hex64, 256) }),
  [MSG.request]: orderRequest,
  [MSG.quote]: orderQuote,
  [MSG.accept]: obj({ quote_id: hex64 }),
  [MSG.cancel]: obj({ reason: map(opt(text(1000)), (v) => v ?? '') }),
  [MSG.escrowKey]: orderEscrowKey,
  [MSG.funded]: orderFunded,
  [MSG.escrowNotice]: escrowNotice,
  [MSG.purchased]: orderPurchased,
  [MSG.shipping]: orderShipping,
  [MSG.release]: signedPayout,
  [MSG.refund]: signedPayout,
  [MSG.completed]: obj({ txid: anyTxid }),
  [MSG.disputeOpen]: disputeOpen,
  [MSG.evidenceRequest]: obj({ want: arr(str(64), 32) }),
  [MSG.evidence]: disputeEvidence,
  [MSG.ruling]: disputeRuling,
  [MSG.countersigned]: obj({ txid: anyTxid }),
  [MSG.report]: report,
  [MSG.chat]: obj({ text: text() }),
  [MSG.attachment]: attachment,
};

/** Validate the JSON body of a message of `type`; undefined when it does not fit the schema. */
export function parseBody<T = unknown>(type: string, body: unknown): T | undefined {
  const check = BODY_SCHEMAS[type];
  return check ? (tryParse(check, body) as T | undefined) : undefined;
}

/** Parse and validate the content of a signed inner of `type`. */
export function innerBodyAs<T = unknown>(inner: Inner, type: string): T | undefined {
  try {
    return parseBody<T>(type, JSON.parse(inner.content));
  } catch {
    return undefined;
  }
}
