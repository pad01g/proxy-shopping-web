/** Schemas of the signed trust / profile contents (§2.3, §3.1, §3.2); anything else is ignored. */
import { money, p2pAddr } from '../nostr/schema.js';
import type { Payment } from '../nostr/messages.js';
import {
  arr, btcAddress, evmAddress, hex64, int, map, obj, opt, str, uintStr, decStr, type Check,
} from '../util/validate.js';
import type { EscrowProfileContent, ListEntry, OperatorListContent, ShopperProfileContent } from './types.js';

const PAYMENTS: readonly Payment[] = ['btc-signet', 'usdc-evm'];
/** Unknown payment methods (a newer peer) are skipped, not fatal. */
const payments = map(arr(str(32), 16), (xs) => xs.filter((x): x is Payment => PAYMENTS.includes(x as Payment)));
const region = str(64, /^[A-Z]{2}(-[A-Z0-9]{1,10}){0,4}$/);
const name = str(200);
const p2p = p2pAddr;

export const shopperProfileContent: Check<ShopperProfileContent> = obj({
  name,
  payments,
  currencies: arr(str(8), 16),
  cash_regions: arr(region, 64),
  fee: opt(obj({ bps: int(0, 10_000), min: opt(money) })),
  max_order: opt(money),
  delivery_days: int(0, 365),
  evm_address: opt(evmAddress),
  btc_address: opt(btcAddress),
  p2p,
});

export const escrowProfileContent: Check<EscrowProfileContent> = obj({
  name,
  btc_xpub: str(200, /^[tx]pub[1-9A-HJ-NP-Za-km-z]{100,120}$/),
  btc_fee_address: btcAddress,
  evm_address: evmAddress,
  upfront_fee: obj({ bps: int(0, 10_000), min_sats: uintStr, min_usdc: decStr }),
  dispute_fee_bps: int(0, 10_000),
  p2p,
});

export const listEntry: Check<ListEntry> = obj({
  region,
  shopper: hex64,
  escrow: hex64,
  // Missing shops means every shop, as before.
  shops: map(opt(arr(str(253), 256)), (v) => (v && v.length ? v : ['*'])),
  payments,
  tags: arr(str(64), 32),
  escrow_sla_days: map(opt(int(0, 3650)), (v) => v ?? 0),
});

const safeAddresses = obj({
  singleton: evmAddress,
  factory: evmAddress,
  fallback_handler: evmAddress,
  multisend_call_only: evmAddress,
  module: opt(evmAddress),
  setup: opt(evmAddress),
});

/** Entries that fail their schema are dropped individually; the rest of the list must be well formed. */
export const operatorListContent: Check<OperatorListContent> = (v, path) => {
  const entries = Array.isArray((v as { entries?: unknown })?.entries) ? ((v as { entries: unknown[] }).entries) : undefined;
  const base = obj({
    network: str(64),
    name: map(opt(name), (x) => x ?? ''),
    regions: arr(region, 256),
    relays: arr(obj({ url: str(256), retention_days: opt(int(0, 3650)) }), 32),
    // §2.3: unreadable entries are ignored, never the list.
    p2p_relays: (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.startsWith('/') && x.length <= 1024).slice(0, 16) : undefined),
    chain: opt(obj({
      btc: opt(obj({ network: str(32), esplora: arr(str(256), 8) })),
      evm: opt(obj({ chain_id: int(1), rpc: arr(str(256), 8), usdc: evmAddress, safe: safeAddresses })),
    })),
    donation: opt(obj({ btc_address: opt(str(100)), evm_address: opt(str(42)), bps: int(0, 10_000) })),
    report_to: opt(hex64),
  })(v, path);
  if (!entries || entries.length > 2000) throw new Error('entries: expected an array of at most 2000');
  const ok: ListEntry[] = [];
  for (const e of entries) {
    try {
      ok.push(listEntry(e));
    } catch {
      /* one bad row must not take the whole list down */
    }
  }
  return { ...base, entries: ok };
};
