import type { Payment } from '../nostr/messages.js';

/**
 * §4.5.1 user-side timelock policy. The shopper can take the funds alone after T1, so a T1 that is
 * too close lets it walk away without buying; T2 too far locks the user's refund for too long.
 * Field names match `timelock_policy` in the web config.json.
 */
export interface TimelockPolicy {
  btc_min_t1_blocks?: number;
  evm_min_t1_seconds?: number;
  btc_min_gap_blocks?: number;
  evm_min_gap_seconds?: number;
  btc_max_t2_blocks?: number;
  evm_max_t2_seconds?: number;
}

const DAY = 86_400;
/** BTC converts 600 s = 1 block (§4.5.1). */
export const SECONDS_PER_BLOCK = 600;
/** Heights at or above this are interpreted as UNIX times by CLTV (§5.1). */
export const LOCKTIME_THRESHOLD = 500_000_000;

export interface TimelockBounds {
  minT1: number;
  minGap: number;
  maxT2: number;
}

/** Effective bounds, in blocks for BTC and seconds for USDC; public-network defaults per §4.5.1. */
export function timelockBounds(asset: Payment, deliveryDays: number, policy: TimelockPolicy = {}): TimelockBounds {
  const defaults = { minT1: (deliveryDays + 14) * DAY, minGap: 7 * DAY, maxT2: 120 * DAY };
  if (asset === 'btc-signet') {
    const blocks = (s: number) => Math.ceil(s / SECONDS_PER_BLOCK);
    return {
      minT1: policy.btc_min_t1_blocks ?? blocks(defaults.minT1),
      minGap: policy.btc_min_gap_blocks ?? blocks(defaults.minGap),
      maxT2: policy.btc_max_t2_blocks ?? blocks(defaults.maxT2),
    };
  }
  return {
    minT1: policy.evm_min_t1_seconds ?? defaults.minT1,
    minGap: policy.evm_min_gap_seconds ?? defaults.minGap,
    maxT2: policy.evm_max_t2_seconds ?? defaults.maxT2,
  };
}

/**
 * Errors for a quoted timelock against the current tip height (BTC) or chain time (USDC).
 * All of these block accepting the quote.
 */
export function checkTimelock(p: {
  asset: Payment;
  timelock?: { t1: number; t2: number };
  /** Current block height (BTC) or latest block timestamp (USDC). */
  chainNow?: number;
  deliveryDays: number;
  policy?: TimelockPolicy;
}): string[] {
  const t = p.timelock;
  if (!t || !Number.isSafeInteger(t.t1) || !Number.isSafeInteger(t.t2) || t.t1 <= 0) return ['invalid timelock'];
  if (!(t.t1 < t.t2)) return ['invalid timelock: T1 must be before T2'];
  const errors: string[] = [];
  const btc = p.asset === 'btc-signet';
  if (btc && t.t2 >= LOCKTIME_THRESHOLD) errors.push('BTC timelocks must be block heights (< 500000000)');
  if (p.chainNow === undefined || !Number.isFinite(p.chainNow)) return [...errors, 'cannot check the timelock: current height / chain time unknown'];
  const b = timelockBounds(p.asset, p.deliveryDays, p.policy);
  const unit = btc ? 'blocks' : 's';
  if (t.t1 - p.chainNow < b.minT1) errors.push(`T1 is only ${t.t1 - p.chainNow} ${unit} away (policy: at least ${b.minT1})`);
  if (t.t2 - t.t1 < b.minGap) errors.push(`T2 − T1 is ${t.t2 - t.t1} ${unit} (policy: at least ${b.minGap})`);
  if (t.t2 - p.chainNow > b.maxT2) errors.push(`T2 is ${t.t2 - p.chainNow} ${unit} away (policy: at most ${b.maxT2})`);
  return errors;
}

/** Estimated UNIX time at which a timelock is reached (BTC: 600 s per remaining block). */
export function timelockEta(asset: Payment, value: number, chainNow: number, now = Math.floor(Date.now() / 1000)): number {
  return asset === 'btc-signet' ? now + (value - chainNow) * SECONDS_PER_BLOCK : now + (value - chainNow);
}
