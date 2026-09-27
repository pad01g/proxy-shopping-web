import type { Payment } from '../nostr/messages.js';

export interface SafeAddresses {
  singleton: string;
  factory: string;
  fallback_handler: string;
  multisend_call_only: string;
  module?: string;
  setup?: string;
}

export interface ListEntry {
  region: string;
  shopper: string;
  escrow: string;
  shops: string[];
  payments: Payment[];
  tags: string[];
  escrow_sla_days: number;
}

/** Content of an operator list, kind 30501 (spec §2.3). */
export interface OperatorListContent {
  network: string;
  name: string;
  regions: string[];
  relays: Array<{ url: string; retention_days?: number }>;
  chain?: {
    btc?: { network: string; esplora: string[] };
    evm?: { chain_id: number; rpc: string[]; usdc: string; safe: SafeAddresses };
  };
  entries: ListEntry[];
  donation?: { btc_address?: string; evm_address?: string; bps: number };
  report_to?: string;
}

export interface Delegation {
  coordinator: string;
  operator: string;
  version: number;
  network: string;
  revoked: boolean;
  note?: string;
  eventId: string;
}

export interface OperatorList {
  operator: string;
  version: number;
  network: string;
  content: OperatorListContent;
  eventId: string;
}

export interface Provenance {
  coordinator: string;
  operator: string;
  listVersion: number;
}

export interface EffectiveEntry extends ListEntry {
  provenance: Provenance;
}

/** Shopper profile content, kind 30502 (§3.1). */
export interface ShopperProfileContent {
  name: string;
  payments: Payment[];
  currencies: string[];
  cash_regions: string[];
  fee: { bps: number; min?: { amount: string; currency: string } };
  max_order?: { amount: string; currency: string };
  delivery_days: number;
  evm_address?: string;
  btc_address?: string;
  p2p?: { peer_id: string; addrs: string[] };
}

/** Escrow profile content, kind 30503 (§3.2). */
export interface EscrowProfileContent {
  name: string;
  btc_xpub: string;
  btc_fee_address: string;
  evm_address: string;
  upfront_fee: { bps: number; min_sats: string; min_usdc: string };
  dispute_fee_bps: number;
  p2p?: { peer_id: string; addrs: string[] };
}
