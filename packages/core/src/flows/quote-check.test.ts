import { describe, expect, it } from 'vitest';
import { p2wshAddress, witnessScript } from '../btc/script.js';
import { StaticSource } from '../fx/sources.js';
import { escrowPubkeyFromXpub, KeySet } from '../keys/derive.js';
import type { OrderQuote, OrderRequest } from '../nostr/messages.js';
import { LAB_MNEMONICS, LAB_TIMELOCK_POLICY } from '../testing/world.js';
import type { EffectiveEntry, EscrowProfileContent } from '../trust/types.js';
import { toHex } from '../util/bytes.js';
import { checkQuote, maxPayoutFeeReserve, type QuoteCheckInput } from './quote-check.js';
import { checkTimelock, clockSkewProblem, timelockBounds, timelockEta } from './timelock-policy.js';

const ORDER = '0123456789abcdef0123456789abcdef';
const user = KeySet.fromMnemonic(LAB_MNEMONICS['user-1']);
const shopper = KeySet.fromMnemonic(LAB_MNEMONICS['shopper-1']);
const escrow = KeySet.fromMnemonic(LAB_MNEMONICS['escrow-1']);
const TIP = 1000;

const escrowProfile: EscrowProfileContent = {
  name: 'escrow-1', btc_xpub: escrow.escrowXpub, btc_fee_address: escrow.btcWallet.address, evm_address: escrow.evmAddress,
  upfront_fee: { bps: 50, min_sats: '1000', min_usdc: '0.50' }, dispute_fee_bps: 200,
};
const entry: EffectiveEntry = {
  region: 'JP-13', shopper: shopper.nostrPublicKey, escrow: escrow.nostrPublicKey, shops: ['*'], payments: ['btc-signet'], tags: [],
  escrow_sla_days: 14, provenance: { coordinator: 'c'.repeat(64), operator: 'o'.repeat(64), listVersion: 1 },
};
const request: OrderRequest = {
  shop_url: 'https://safe-shop.test/', shop_region: 'JP-13-13104', items: [{ sku: 'A-100', qty: 1 }], payment: 'btc-signet',
  escrow: escrow.nostrPublicKey, operator: 'o'.repeat(64), coordinator: 'c'.repeat(64),
  delivery: { ciphertext: '', key_for_shopper: '', key_for_escrow_sha256: '0'.repeat(64) }, key_proof: '',
  user_btc_pubkey: toHex(user.orderKey(ORDER).publicKey), user_btc_address: user.btcWallet.address, relays: [],
};

/** A quote that passes every check; tests break one thing at a time. */
function quote(t = { t1: TIP + 100, t2: TIP + 150 }, patch: Partial<OrderQuote> = {}): OrderQuote {
  const escrowKey = escrowPubkeyFromXpub(escrow.escrowXpub, ORDER);
  const script = witnessScript({ user: user.orderKey(ORDER).publicKey, shopper: shopper.orderKey(ORDER).publicKey, escrow: escrowKey }, t.t1, t.t2);
  return {
    accept: true,
    expires_at: Math.floor(Date.now() / 1000) + 900,
    price: { items: { amount: '3200', currency: 'JPY' }, shipping: { amount: '800', currency: 'JPY' }, shopper_fee: { amount: '300', currency: 'JPY' } },
    fx: { pair: 'BTC/JPY', rate: '15000000', sources: [], at: 0 },
    asset: 'btc-signet', lock_amount: '29667', escrow_upfront_fee: '1000', payout_fee_reserve: '1000', timelock: t,
    shopper_btc_pubkey: toHex(shopper.orderKey(ORDER).publicKey), shopper_btc_address: shopper.btcWallet.address,
    escrow_btc_pubkey: toHex(escrowKey), escrow_btc_fee_address: escrow.btcWallet.address, escrow_address: p2wshAddress(script),
    ...patch,
  };
}

const input = (q: OrderQuote, over: Partial<QuoteCheckInput> = {}): QuoteCheckInput => ({
  orderId: ORDER, request, quote: q, shopper: shopper.nostrPublicKey, escrowProfile, entries: [entry],
  userBtcPubkey: user.orderKey(ORDER).publicKey, rates: [new StaticSource({ 'BTC/JPY': 15_000_000 })],
  chainNow: TIP, timelockPolicy: LAB_TIMELOCK_POLICY, deliveryDays: 5, ...over,
});

describe('quote check (§4.5)', () => {
  it('accepts a correct quote', async () => {
    expect(await checkQuote(input(quote()))).toMatchObject({ ok: true, errors: [], ackRequired: [] });
  });

  it('a lock_amount that does not follow from price and rate is an error', async () => {
    const r = await checkQuote(input(quote(undefined, { lock_amount: '30000' })));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/lock_amount 30000 != 29667/);
  });

  it('payout_fee_reserve above min(20000, 5 %) is an error', async () => {
    expect(maxPayoutFeeReserve('btc-signet', 29_667n)).toBe(2_000n); // small orders may still reserve 2000 sats
    expect(maxPayoutFeeReserve('btc-signet', 100_000n)).toBe(5_000n);
    expect(maxPayoutFeeReserve('btc-signet', 10_000_000n)).toBe(20_000n);
    expect(maxPayoutFeeReserve('usdc-evm', 10_000_000n)).toBe(0n);
    // lock stays consistent with the larger reserve, so only the cap trips
    const r = await checkQuote(input(quote(undefined, { payout_fee_reserve: '5000', lock_amount: '33667' })));
    expect(r.errors.join()).toMatch(/payout_fee_reserve 5000 exceeds the cap/);
  });

  it('an upfront fee over twice the escrow terms is an error, below them a warning', async () => {
    const hi = await checkQuote(input(quote(undefined, { escrow_upfront_fee: '2001' })));
    expect(hi.errors.join()).toMatch(/more than twice/);
    const lo = await checkQuote(input(quote(undefined, { escrow_upfront_fee: '999' })));
    expect(lo.ok).toBe(true);
    expect(lo.warnings.join()).toMatch(/owes no ruling/);
  });

  it('a strong rate deviation and an unchecked rate need acknowledgement, not just a warning', async () => {
    const strong = await checkQuote(input(quote(), { rates: [new StaticSource({ 'BTC/JPY': 12_000_000 })] }));
    expect(strong.ok).toBe(true);
    expect(strong.ackRequired.join()).toMatch(/deviates strongly/);
    const none = await checkQuote(input(quote(), { rates: [] }));
    expect(none.ackRequired.join()).toMatch(/no rate sources/);
  });

  it('timelocks are checked against the current height', async () => {
    const near = await checkQuote(input(quote({ t1: TIP + 10, t2: TIP + 60 })));
    expect(near.errors.join()).toMatch(/T1 is only 10 blocks away/);
    const unknownTip = await checkQuote(input(quote(), { chainNow: undefined }));
    expect(unknownTip.errors.join()).toMatch(/current height/);
  });

  it('an unknown shopper profile is an error unless the policy fixes min_t1 (item 18)', async () => {
    const r = await checkQuote(input(quote(), { deliveryDays: undefined, timelockPolicy: {} }));
    expect(r.errors.join()).toMatch(/shopper profile unknown/);
    // the lab policy sets btc_min_t1_blocks, so delivery_days is not needed there
    expect((await checkQuote(input(quote(), { deliveryDays: undefined }))).ok).toBe(true);
  });

  it('a BTC upfront fee below the dust limit is an error (item 18)', async () => {
    const r = await checkQuote(input(quote(undefined, { escrow_upfront_fee: '545' })));
    expect(r.errors.join()).toMatch(/dust limit 546/);
  });
});

describe('clock skew (§4.5.1, item 14)', () => {
  it('refuses a chain clock more than max_clock_skew_seconds away (default 2 h)', () => {
    expect(clockSkewProblem(1_000_000 + 7200, 1_000_000)).toBeUndefined();
    expect(clockSkewProblem(1_000_000 + 7201, 1_000_000)).toMatch(/7201 s ahead/);
    expect(clockSkewProblem(1_000_000 - 7201, 1_000_000)).toMatch(/behind/);
    expect(clockSkewProblem(1_000_000 + 7201, 1_000_000, 315_360_000)).toBeUndefined();
  });
});

describe('timelock policy (§4.5.1)', () => {
  it('uses the public defaults: delivery+14 days, 7 day gap, 120 days max, 600 s per block', () => {
    expect(timelockBounds('btc-signet', 5)).toEqual({ minT1: 19 * 144, minGap: 7 * 144, maxT2: 120 * 144 });
    expect(timelockBounds('usdc-evm', 5)).toEqual({ minT1: 19 * 86400, minGap: 7 * 86400, maxT2: 120 * 86400 });
    expect(timelockBounds('btc-signet', 5, LAB_TIMELOCK_POLICY)).toEqual({ minT1: 50, minGap: 20, maxT2: 1000 });
  });

  it('rejects too-near T1, too-small gap, too-far T2 and non-height BTC locks', () => {
    const c = (t1: number, t2: number, asset: 'btc-signet' | 'usdc-evm' = 'btc-signet', chainNow = TIP) =>
      checkTimelock({ asset, timelock: { t1, t2 }, chainNow, deliveryDays: 5, policy: LAB_TIMELOCK_POLICY }).join();
    expect(c(TIP + 100, TIP + 150)).toBe('');
    expect(c(TIP + 49, TIP + 150)).toMatch(/T1 is only/);
    expect(c(TIP + 100, TIP + 110)).toMatch(/T2 − T1/);
    expect(c(TIP + 100, TIP + 1001)).toMatch(/at most 1000/);
    expect(c(500_000_100, 500_000_200, 'btc-signet', 500_000_000)).toMatch(/block heights/);
    expect(c(150, 100)).toMatch(/T1 must be before T2/);
    const now = 1_790_000_000;
    expect(c(now + 3600, now + 7200, 'usdc-evm', now)).toBe('');
    expect(c(now + 600, now + 7200, 'usdc-evm', now)).toMatch(/T1 is only 600 s/);
  });

  it('estimates when a lock is reached', () => {
    expect(timelockEta('btc-signet', TIP + 6, TIP, 1_000)).toBe(1_000 + 3600);
    expect(timelockEta('usdc-evm', 5_000, 4_000, 1_000)).toBe(2_000);
  });
});
