import { describe, expect, it } from 'vitest';
import { MSG } from './messages.js';
import { BODY_SCHEMAS, parseBody } from './schema.js';

const H = (c: string) => c.repeat(64);

describe('message schemas (§4.10)', () => {
  it('has a schema for every message type', () => {
    for (const t of Object.values(MSG)) expect(BODY_SCHEMAS[t], t).toBeDefined();
  });

  it('accepts Go-shaped bodies (nil slices as null, omitted fields, numeric operation)', () => {
    const quote = parseBody(MSG.quote, {
      accept: true, expires_at: 1790000900, asset: 'btc-signet', lock_amount: '29667', payout_fee_reserve: '1000',
      price: { items: { amount: '3200', currency: 'JPY' }, shipping: { amount: '800', currency: 'JPY' }, shopper_fee: { amount: '300', currency: 'JPY' } },
      fx: { pair: 'BTC/JPY', rate: '15000000', sources: null, at: 1 }, timelock: { t1: 300, t2: 350 }, extra_field: 'ignored',
    });
    expect(quote).toMatchObject({ accept: true, fx: { sources: [] } });
    expect(quote).not.toHaveProperty('extra_field');
    expect(parseBody(MSG.funded, { asset: 'btc-signet', txid: H('a'), amount: '1' })).toEqual({ asset: 'btc-signet', txid: H('a'), vout: 0, amount: '1', fee_txid: '' });
    const payout = parseBody<{ safe_tx: { operation: string } }>(MSG.release, {
      asset: 'usdc-evm', signature: `0x${'1'.repeat(130)}`,
      safe_tx: { to: `0x${'2'.repeat(40)}`, value: '0', data: '0x', operation: 1, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: `0x${'0'.repeat(40)}`, refundReceiver: `0x${'0'.repeat(40)}`, nonce: '0' },
    });
    expect(payout?.safe_tx.operation).toBe('1');
    expect(parseBody(MSG.purchased, { shop_order_id: 'X', total: { amount: '3200', currency: 'JPY' }, evidence: null })).toMatchObject({ evidence: [] });
    expect(parseBody(MSG.shipping, { status: 'shipped', tracking: { status: 'shipped', updated_at: '2026-09-27T00:00:00Z', evidence: [] } }))
      .toMatchObject({ tracking: { updated_at: 1790467200 } });
  });

  it('rejects the malformed values that used to crash pages', () => {
    // formatAsset did BigInt(lock_amount)
    expect(parseBody(MSG.quote, { accept: true, lock_amount: '1.5' })).toBeUndefined();
    expect(parseBody(MSG.quote, { accept: true, lock_amount: 29667 })).toBeUndefined();
    // OrderDetail read purchased.total.amount and tracking fields
    expect(parseBody(MSG.purchased, { shop_order_id: 'X', total: null, evidence: [] })).toBeUndefined();
    expect(parseBody(MSG.shipping, { status: 'shipped', tracking: { status: 'lost', updated_at: 1 } })).toBeUndefined();
    // ruling split with non-integers
    expect(parseBody(MSG.ruling, { split: { user: 'x', shopper: '1', escrow_fee: '0' }, reason: '', asset: 'btc-signet' })).toBeUndefined();
    // EscrowCase did e.sha256.slice / e.mime.startsWith
    expect(parseBody(MSG.disputeOpen, { claim: 'other', text: '', evidence: { purchase_evidence: [{ kind: 'json', sha256: 1, mime: 'a/b' }] } })).toBeUndefined();
    // Operator page did report.order_id.slice
    expect(parseBody(MSG.report, { subject: H('a'), order_id: 5, text: '', evidence: [] })).toBeUndefined();
    // requests must carry key_proof and the escrow key hash, never the key itself
    const req = {
      shop_url: 'https://safe-shop.test/', shop_region: 'JP-13', items: [{ sku: 'A', qty: 1 }], payment: 'btc-signet',
      escrow: H('e'), operator: H('0'), coordinator: H('c'), relays: [],
      delivery: { ciphertext: 'AAAA', key_for_shopper: 'x', key_for_escrow_sha256: H('f') },
    };
    expect(parseBody(MSG.request, req)).toBeUndefined();
    expect(parseBody(MSG.request, { ...req, key_proof: 'ab'.repeat(64) })).toBeDefined();
    expect(parseBody(MSG.request, { ...req, key_proof: 'ab'.repeat(64), delivery: { ...req.delivery, key_for_escrow_sha256: undefined } })).toBeUndefined();
    // over-long strings
    expect(parseBody(MSG.chat, { text: 'x'.repeat(5000) })).toBeUndefined();
  });
});
