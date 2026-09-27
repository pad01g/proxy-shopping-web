import type { Hex } from 'viem';
import { p2wshAddress, witnessScript } from '../btc/script.js';
import { orderSafeAddress } from '../evm/safe.js';
import type { Deployments } from '../evm/deployments.js';
import { checkQuoteRate, type RateCheck } from '../fx/check.js';
import type { RateSource } from '../fx/types.js';
import { escrowPubkeyFromXpub } from '../keys/derive.js';
import type { OrderQuote, OrderRequest } from '../nostr/messages.js';
import type { EffectiveEntry, EscrowProfileContent } from '../trust/types.js';
import { matchingEntries } from '../trust/effective.js';
import { fromHex, toHex } from '../util/bytes.js';
import { computeLockAmount, decimalToUnits, parseUnits } from '../util/decimal.js';
import { nowSeconds } from '../util/time.js';

export interface QuoteCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  fx?: RateCheck;
  /** escrow_address as we computed it. */
  escrowAddress?: string;
}

export interface QuoteCheckInput {
  orderId: string;
  request: OrderRequest;
  quote: OrderQuote;
  shopper: string;
  escrowProfile?: EscrowProfileContent;
  /** Current effective combinations (§2.4). */
  entries: EffectiveEntry[];
  userBtcPubkey?: Uint8Array;
  userEvmAddress?: string;
  deployments?: Deployments;
  proxyCreationCode?: Hex;
  rates: RateSource[];
  now?: number;
}

const DECIMALS = { 'btc-signet': 8, 'usdc-evm': 6 } as const;
const sameAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * User-side validation of an order.quote (§4.5): the combination must be in the
 * effective set, the escrow address is recomputed from its parts, and the FX
 * rate is compared with our own sources.
 */
export async function checkQuote(p: QuoteCheckInput): Promise<QuoteCheck> {
  const { quote, request } = p;
  const errors: string[] = [];
  const warnings: string[] = [];
  const res: QuoteCheck = { ok: false, errors, warnings };

  if (!quote.accept) {
    errors.push(`shopper declined: ${quote.reject_reason ?? 'unknown'}`);
    return res;
  }
  const now = p.now ?? nowSeconds();
  if (quote.expires_at && quote.expires_at < now) errors.push('quote expired');
  if (quote.asset !== request.payment) errors.push(`asset ${quote.asset} != requested ${request.payment}`);

  const combo = matchingEntries(p.entries, { shopUrl: request.shop_url, region: request.shop_region, payment: request.payment })
    .find((e) => e.shopper === p.shopper && e.escrow === request.escrow);
  if (!combo) errors.push('shopper × escrow combination is not in the effective list');

  const esc = p.escrowProfile;
  if (!esc) errors.push('escrow profile unknown');
  const t = quote.timelock;
  if (!t || !(t.t1 < t.t2)) errors.push('invalid timelock');
  if (!quote.lock_amount || !/^\d+$/.test(quote.lock_amount)) errors.push('invalid lock_amount');

  if (request.payment === 'btc-signet' && esc && t) {
    try {
      const expectEscrow = toHex(escrowPubkeyFromXpub(esc.btc_xpub, p.orderId));
      if (quote.escrow_btc_pubkey !== expectEscrow) errors.push('escrow_btc_pubkey does not match the escrow xpub');
      if (quote.escrow_btc_fee_address !== esc.btc_fee_address) errors.push('escrow fee address differs from escrow profile');
      if (p.userBtcPubkey && request.user_btc_pubkey !== toHex(p.userBtcPubkey)) errors.push('user key mismatch');
      const script = witnessScript(
        { user: fromHex(request.user_btc_pubkey ?? ''), shopper: fromHex(quote.shopper_btc_pubkey ?? ''), escrow: fromHex(expectEscrow) },
        t.t1,
        t.t2,
      );
      res.escrowAddress = p2wshAddress(script);
      if (res.escrowAddress !== quote.escrow_address) errors.push('escrow_address does not match our P2WSH');
    } catch (err) {
      errors.push(`cannot rebuild escrow script: ${(err as Error).message}`);
    }
  }

  if (request.payment === 'usdc-evm' && esc && t) {
    if (!p.deployments) errors.push('EVM deployments unknown');
    else if (!quote.shopper_evm_address) errors.push('missing shopper_evm_address');
    else {
      if (!sameAddr(quote.escrow_evm_address, esc.evm_address)) errors.push('escrow EVM address differs from escrow profile');
      if (p.userEvmAddress && !sameAddr(request.user_evm_address, p.userEvmAddress)) errors.push('user EVM address mismatch');
      res.escrowAddress = orderSafeAddress(
        p.deployments,
        {
          user: request.user_evm_address as `0x${string}`,
          shopper: quote.shopper_evm_address as `0x${string}`,
          escrow: esc.evm_address as `0x${string}`,
          t1: BigInt(t.t1),
          t2: BigInt(t.t2),
          orderId: p.orderId,
        },
        p.proxyCreationCode,
      );
      if (!sameAddr(res.escrowAddress, quote.escrow_address)) errors.push('escrow_address does not match our Safe prediction');
    }
  }

  // Amounts: recompute lock_amount from the quoted price and rate (informational).
  if (quote.price && quote.fx && quote.lock_amount && request.payment in DECIMALS) {
    try {
      const reserve = parseUnits(quote.payout_fee_reserve ?? '0');
      const expected = computeLockAmount(
        [quote.price.items.amount, quote.price.shipping.amount, quote.price.shopper_fee.amount],
        quote.fx.rate,
        DECIMALS[request.payment],
        reserve,
      );
      if (expected !== parseUnits(quote.lock_amount)) warnings.push(`lock_amount ${quote.lock_amount} != expected ${expected}`);
    } catch (err) {
      warnings.push(`cannot recompute lock_amount: ${(err as Error).message}`);
    }
  }

  // Upfront fee below the escrow's published minimum means the escrow owes no ruling (§3.2).
  if (esc && quote.lock_amount && quote.escrow_upfront_fee !== undefined) {
    try {
      const lock = parseUnits(quote.lock_amount);
      const fee = parseUnits(quote.escrow_upfront_fee);
      const min = request.payment === 'btc-signet'
        ? parseUnits(esc.upfront_fee.min_sats)
        : decimalToUnits(esc.upfront_fee.min_usdc, 6);
      const byBps = (lock * BigInt(esc.upfront_fee.bps)) / 10000n;
      const required = min > byBps ? min : byBps;
      if (fee < required) warnings.push(`escrow upfront fee ${fee} is below the escrow's minimum ${required}`);
    } catch {
      warnings.push('cannot check escrow upfront fee');
    }
  }

  if (quote.fx && p.rates.length) {
    try {
      res.fx = await checkQuoteRate(quote, p.rates);
      if (res.fx.level === 'warn') warnings.push(`rate deviates ${(res.fx.deviation * 100).toFixed(1)}% from our sources`);
      if (res.fx.level === 'strong') warnings.push(`rate deviates strongly: ${(res.fx.deviation * 100).toFixed(1)}%`);
    } catch (err) {
      warnings.push(`rate check failed: ${(err as Error).message}`);
    }
  } else if (!p.rates.length) {
    warnings.push('no rate sources configured; rate not checked');
  }

  res.ok = errors.length === 0;
  return res;
}
