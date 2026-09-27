/** Message bodies of spec §4.3–§4.8. Amounts are decimal strings. */
import type { Inner } from './giftwrap.js';

export type Payment = 'btc-signet' | 'usdc-evm';

export interface Money {
  amount: string;
  currency: string;
}

export interface Address {
  name: string;
  postal_code: string;
  address: string;
  phone: string;
}

export interface Evidence {
  kind: 'screenshot' | 'receipt' | 'html' | 'json';
  sha256: string;
  mime: string;
  data_b64?: string;
}

export interface TrackingStatus {
  status: 'processing' | 'shipped' | 'delivered' | 'failed';
  carrier?: string;
  tracking_no?: string;
  updated_at: number;
  evidence: Evidence[];
}

export interface DeliveryEnvelope {
  ciphertext: string;
  key_for_shopper: string;
  /** hex(SHA-256(key_for_escrow)); the key itself travels in order.escrow_key (§4.4). */
  key_for_escrow_sha256: string;
}

/** order.escrow_key (user → shopper): NIP-44(user→escrow, hex(K)), handed to the escrow only in a dispute. */
export interface OrderEscrowKey {
  key_for_escrow: string;
}

export interface OrderRequest {
  shop_url: string;
  shop_region: string;
  items: Array<{ sku: string; qty: number }>;
  payment: Payment;
  escrow: string;
  operator: string;
  coordinator: string;
  delivery: DeliveryEnvelope;
  /** §4.4.1: binds the signing Nostr identity to the chain key put into the multisig. */
  key_proof: string;
  user_btc_pubkey?: string;
  user_btc_address?: string;
  user_evm_address?: string;
  relays: string[];
}

export interface FxInfo {
  pair: string;
  rate: string;
  sources: Array<{ name: string; rate: string; at: number }>;
  at: number;
}

export interface OrderQuote {
  accept: boolean;
  reject_reason?: string;
  detail?: string;
  expires_at?: number;
  price?: { items: Money; shipping: Money; shopper_fee: Money };
  fx?: FxInfo;
  asset?: Payment;
  lock_amount?: string;
  escrow_upfront_fee?: string;
  payout_fee_reserve?: string;
  timelock?: { t1: number; t2: number };
  shopper_btc_pubkey?: string;
  shopper_btc_address?: string;
  escrow_btc_pubkey?: string;
  escrow_btc_fee_address?: string;
  shopper_evm_address?: string;
  escrow_evm_address?: string;
  escrow_address?: string;
}

export interface OrderAccept {
  quote_id: string;
}

export interface OrderFundedBtc {
  asset: 'btc-signet';
  txid: string;
  vout: number;
  amount: string;
  fee_txid: string;
}

export interface OrderFundedUsdc {
  asset: 'usdc-evm';
  safe: string;
  deploy_tx: string;
  fund_tx: string;
  fee_tx: string;
  amount: string;
}

export type OrderFunded = OrderFundedBtc | OrderFundedUsdc;

export interface EscrowNotice {
  request: Inner;
  quote: Inner;
  accept: Inner;
  funded: Inner;
}

export interface OrderPurchased {
  shop_order_id: string;
  total: Money;
  evidence: Evidence[];
}

export interface OrderShipping {
  status: 'shipped' | 'delivered' | 'failed';
  tracking: TrackingStatus;
}

/** JSON form of a Safe transaction (spec §6.4): numbers as decimal strings. */
export interface SafeTxJson {
  to: string;
  value: string;
  data: string;
  operation: string;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: string;
}

export type SignedPayout =
  | { asset: 'btc-signet'; psbt: string }
  | { asset: 'usdc-evm'; safe_tx: SafeTxJson; signature: string };

export interface OrderCompleted {
  txid: string;
}

export interface DisputeEvidence {
  messages: Inner[];
  tracking: TrackingStatus[];
  purchase_evidence: Evidence[];
  /** key_for_escrow from order.escrow_key; checked against the signed request's key_for_escrow_sha256. */
  delivery_key_for_escrow?: string;
  text?: string;
}

export interface DisputeOpen {
  claim: 'not_delivered' | 'wrong_item' | 'not_released' | 'other';
  text: string;
  requested_split?: { user: string; shopper: string };
  evidence: DisputeEvidence;
}

export interface Split {
  user: string;
  shopper: string;
  escrow_fee: string;
}

export interface DisputeRuling {
  split: Split;
  reason: string;
  asset: Payment;
  psbt?: string;
  safe_tx?: SafeTxJson;
  signature?: string;
  /** Set by an escrow that received no upfront fee and therefore owes no ruling (§3.2). */
  no_obligation?: boolean;
}

export interface Report {
  subject: string;
  order_id: string;
  text: string;
  evidence: Inner[];
}

export const MSG = {
  ack: 'ack',
  request: 'order.request',
  quote: 'order.quote',
  accept: 'order.accept',
  cancel: 'order.cancel',
  escrowKey: 'order.escrow_key',
  funded: 'order.funded',
  escrowNotice: 'escrow.notice',
  purchased: 'order.purchased',
  shipping: 'order.shipping',
  release: 'order.release',
  refund: 'order.refund',
  completed: 'order.completed',
  disputeOpen: 'dispute.open',
  evidenceRequest: 'dispute.evidence_request',
  evidence: 'dispute.evidence',
  ruling: 'dispute.ruling',
  countersigned: 'dispute.countersigned',
  report: 'report',
  chat: 'chat',
  attachment: 'attachment',
} as const;

/**
 * §4.9: NIP-44 encrypts at most 64 KiB and relays commonly cap content at 65535 bytes; the wrap grows to
 * about 2.3x the inner (inners between ~28.7 KB and 30 KB already pad past 65535), so a signed inner must
 * stay at or below this many bytes.
 */
export const MAX_INNER_BYTES = 28_000;

/** Messages that embed other signed messages; they are left out of evidence lists so evidence stays small. */
export const CONTAINER_TYPES: readonly string[] = ['escrow.notice', 'dispute.open', 'dispute.evidence', 'report', 'attachment'];

/** One chunk of a large evidence item (§4.9). */
export interface Attachment {
  sha256: string;
  mime: string;
  index: number;
  total: number;
  data_b64: string;
}

export type MessageType = (typeof MSG)[keyof typeof MSG];
