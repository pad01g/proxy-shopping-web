import { secp256k1 } from '@noble/curves/secp256k1';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { addressToScript, p2wshAddress, witnessScript } from '../btc/script.js';
import { buildEscrowSpend, signEscrowInput } from '../btc/spend.js';
import { releaseSafeTx, splitSafeTx } from '../evm/safetx.js';
import type { EvmClient } from '../evm/chain.js';
import { btcPayoutProblems, safePayoutProblems, type BtcTemplate } from './payout-check.js';
import { escrowSpent } from './settlement.js';

const priv = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
const pub = (n: number) => secp256k1.getPublicKey(priv(n), true);
const keys = { user: pub(1), shopper: pub(2), escrow: pub(3) };
const script = witnessScript(keys, 1234, 3456);
const outpoint = { txid: 'aa'.repeat(32), vout: 0, amount: 29_667n };
const userAddr = p2wshAddress(witnessScript({ ...keys, user: pub(4) }, 10, 20)); // any address of ours
const shopperAddr = p2wshAddress(witnessScript({ ...keys, user: pub(5) }, 10, 20));

function refund(outputs: Array<{ address: string; amount: bigint }>, p: { witness?: Uint8Array; op?: typeof outpoint; signer?: number } = {}) {
  const tx = buildEscrowSpend({ outpoint: p.op ?? outpoint, witnessScript: p.witness ?? script, outputs });
  signEscrowInput(tx, priv(p.signer ?? 2));
  return tx;
}
const template = (o: Partial<BtcTemplate> = {}): BtcTemplate => ({
  outpoint, witnessScript: script, outputs: { only: [userAddr] }, maxFee: 1000n, signer: keys.shopper, ...o,
});

describe('BTC payout template (§4.10)', () => {
  it('accepts the cooperative refund and the exact ruling', () => {
    expect(btcPayoutProblems(refund([{ address: userAddr, amount: 28_667n }]), template())).toEqual([]);
    const ruling = refund([{ address: userAddr, amount: 20_000n }, { address: shopperAddr, amount: 8_667n }], { signer: 3 });
    expect(btcPayoutProblems(ruling, template({
      signer: keys.escrow,
      outputs: { exact: [{ address: userAddr, amount: 20_000n }, { address: shopperAddr, amount: 8_667n }, { address: 'unused', amount: 0n }] },
    }))).toEqual([]);
  });

  it('refuses a fee over the reserve, foreign outputs, other inputs, scripts or signers', () => {
    expect(btcPayoutProblems(refund([{ address: userAddr, amount: 20_000n }]), template()).join()).toMatch(/miner fee 9667/);
    expect(btcPayoutProblems(refund([{ address: userAddr, amount: 28_000n }, { address: shopperAddr, amount: 667n }]), template()).join()).toMatch(/other than ours/);
    expect(btcPayoutProblems(refund([{ address: userAddr, amount: 28_667n }], { op: { ...outpoint, vout: 1 } }), template()).join()).toMatch(/different outpoint/);
    const other = witnessScript(keys, 1234, 3457);
    expect(btcPayoutProblems(refund([{ address: userAddr, amount: 28_667n }], { witness: other }), template()).join()).toMatch(/witnessScript/);
    expect(btcPayoutProblems(refund([{ address: userAddr, amount: 28_667n }], { signer: 1 }), template()).join()).toMatch(/partial signature/);
    const two = buildEscrowSpend({ outpoint, witnessScript: script, outputs: [{ address: userAddr, amount: 28_667n }] });
    two.addInput({ txid: 'bb'.repeat(32), index: 0, witnessUtxo: { script: addressToScript(userAddr), amount: 1000n } });
    signEscrowInput(two, priv(2));
    expect(btcPayoutProblems(two, template()).join()).toMatch(/exactly one input/);
    const ruling = refund([{ address: userAddr, amount: 20_000n }, { address: shopperAddr, amount: 8_667n }], { signer: 3 });
    expect(btcPayoutProblems(ruling, template({
      signer: keys.escrow,
      outputs: { exact: [{ address: userAddr, amount: 19_000n }, { address: shopperAddr, amount: 9_667n }] },
    })).join()).toMatch(/differ from the expected payout/);
  });
});

describe('USDC payout template (§4.10)', () => {
  const usdc = '0x19D57a0C639e9C151F77D67694EfBA67C489F375' as const;
  const multiSend = '0x88247D117162f4a846883EDBDD01F7171b80Ab03' as const;
  const [U, S] = [1, 2].map((n) => privateKeyToAccount(`0x${n.toString(16).padStart(64, '0')}`).address);
  const base = { usdc, multiSend, nonce: 3n, balance: 100n, lock: 100n };

  it('accepts the refund and the ruling split at the Safe nonce', () => {
    expect(safePayoutProblems(releaseSafeTx({ usdc, to: U, amount: 100n, nonce: 3n }), { ...base, transfers: { only: [U] } })).toEqual([]);
    const split = splitSafeTx({ usdc, multiSend, payouts: [{ to: U, amount: 60n }, { to: S, amount: 40n }], nonce: 3n });
    expect(safePayoutProblems(split, { ...base, transfers: { exact: [{ to: U, amount: 60n }, { to: S, amount: 40n }] } })).toEqual([]);
  });

  it('refuses gas refunds, other nonces, partial amounts, foreign recipients and other delegatecall targets', () => {
    const ok = releaseSafeTx({ usdc, to: U, amount: 100n, nonce: 3n });
    const t = { ...base, transfers: { only: [U] } };
    expect(safePayoutProblems({ ...ok, gasPrice: 1n, refundReceiver: S }, t).join()).toMatch(/gasPrice = 0.*refundReceiver/);
    expect(safePayoutProblems({ ...ok, safeTxGas: 1n }, t).join()).toMatch(/safeTxGas/);
    expect(safePayoutProblems({ ...ok, nonce: 4n }, t).join()).toMatch(/nonce 4/);
    expect(safePayoutProblems(releaseSafeTx({ usdc, to: U, amount: 99n, nonce: 3n }), t).join()).toMatch(/less than lock_amount 100/);
    expect(safePayoutProblems(releaseSafeTx({ usdc, to: S, amount: 100n, nonce: 3n }), t).join()).toMatch(/other than ours/);
    const split = splitSafeTx({ usdc, multiSend, payouts: [{ to: U, amount: 100n }], nonce: 3n });
    expect(safePayoutProblems({ ...split, to: S }, t).join()).toMatch(/MultiSendCallOnly/);
  });
});

describe('USDC dust in the Safe (§4.8, second review)', () => {
  const usdc = '0x19D57a0C639e9C151F77D67694EfBA67C489F375' as const;
  const multiSend = '0x88247D117162f4a846883EDBDD01F7171b80Ab03' as const;
  const [U, S] = [1, 2].map((n) => privateKeyToAccount(`0x${n.toString(16).padStart(64, '0')}`).address);

  it('accepts lock_amount ≤ total ≤ balance: 1 unit sent to the Safe does not block the release or the ruling', () => {
    const t = { usdc, multiSend, nonce: 0n, lock: 100n, balance: 101n };
    expect(safePayoutProblems(releaseSafeTx({ usdc, to: U, amount: 100n }), { ...t, transfers: { only: [U] } })).toEqual([]);
    // a ruling signed over the whole balance (101) and one signed before the dust arrived (100)
    for (const [u, s] of [[60n, 41n], [60n, 40n]]) {
      const split = splitSafeTx({ usdc, multiSend, payouts: [{ to: U, amount: u }, { to: S, amount: s }] });
      expect(safePayoutProblems(split, { ...t, transfers: { exact: [{ to: U, amount: u }, { to: S, amount: s }] } })).toEqual([]);
    }
    const over = splitSafeTx({ usdc, multiSend, payouts: [{ to: U, amount: 102n }] });
    expect(safePayoutProblems(over, { ...t, transfers: { exact: [{ to: U, amount: 102n }] } }).join()).toMatch(/holds only 101/);
  });
});

describe('settlement with dust (§4.8)', () => {
  const safe = '0x00000000000000000000000000000000000000aa';
  const funded = { asset: 'usdc-evm' as const, safe, deploy_tx: '', fund_tx: `0x${'1'.repeat(64)}`, fee_tx: '', amount: '100' };
  const evm = (balance: bigint, out: bigint) => ({
    usdcBalance: async () => balance,
    usdcTransferredFrom: async () => out,
  }) as unknown as EvmClient;
  const tx = `0x${'2'.repeat(64)}`;

  it('is settled once the Safe holds less than lock_amount and the tx moved USDC out of it', async () => {
    expect((await escrowSpent({ evm: evm(1n, 100n), funded, lock: 100n, claimedTx: tx })).spent).toBe(true);
    expect((await escrowSpent({ evm: evm(101n, 0n), funded, lock: 100n, claimedTx: tx })).spent).toBe(false);
    // the balance dropped, but the claimed tx did not pay anything out of the Safe
    expect((await escrowSpent({ evm: evm(0n, 0n), funded, lock: 100n, claimedTx: tx })).spent).toBe(false);
  });
});
