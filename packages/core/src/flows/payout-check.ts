/**
 * §4.10: the only transactions a party countersigns are fixed templates. One validator per asset,
 * shared by the cooperative refund (order.refund) and the escrow ruling (dispute.ruling).
 */
import type { Transaction } from '@scure/btc-signer';
import { zeroAddress } from 'viem';
import { p2wshOutputScript } from '../btc/script.js';
import { describeInput, describeOutputs, verifyPartialSig } from '../btc/spend.js';
import { safeTxTransfers, type SafeTx } from '../evm/safetx.js';
import { equalBytes, toHex } from '../util/bytes.js';

/** An allowed output: a destination and, when fixed, its exact amount. */
export interface ExpectedOutput {
  address: string;
  amount?: bigint;
}

export interface BtcTemplate {
  /** The funded escrow output (order.funded). */
  outpoint: { txid: string; vout: number; amount: bigint };
  witnessScript: Uint8Array;
  /**
   * `exact`: these outputs in this order with these amounts (ruling).
   * `only`: every output goes to one of these addresses (refund); amounts are bounded by the fee rule.
   */
  outputs: { exact: ExpectedOutput[] } | { only: string[] };
  /** Largest acceptable miner fee: payout_fee_reserve. */
  maxFee: bigint;
  /** Public key whose partial signature must already be valid (the proposer). */
  signer: Uint8Array;
}

/** Problems with a counterparty's PSBT (empty = it is the template). */
export function btcPayoutProblems(tx: Transaction, t: BtcTemplate): string[] {
  const problems: string[] = [];
  if (tx.inputsLength !== 1) return ['PSBT must spend exactly one input (the escrow output)'];
  const input = describeInput(tx);
  if (input.txid !== t.outpoint.txid || input.vout !== t.outpoint.vout) problems.push('PSBT spends a different outpoint');
  const raw = tx.getInput(0);
  if (!raw.witnessScript || !equalBytes(raw.witnessScript, t.witnessScript)) problems.push('witnessScript differs from our escrow script');
  if (!raw.witnessUtxo || raw.witnessUtxo.amount !== t.outpoint.amount || !equalBytes(raw.witnessUtxo.script, p2wshOutputScript(t.witnessScript))) {
    problems.push('PSBT input amount or script differs from the funded output');
  }
  if (tx.lockTime !== 0 || (input.sequence ?? 0xffffffff) !== 0xffffffff) problems.push('2-of-3 spend must use nLockTime 0 / nSequence 0xffffffff');
  const outs = describeOutputs(tx);
  if (!outs.length) problems.push('PSBT has no outputs');
  if ('exact' in t.outputs) {
    const exp = t.outputs.exact.filter((o) => o.amount === undefined || o.amount > 0n);
    const same = outs.length === exp.length && exp.every((e, i) => outs[i].address === e.address && (e.amount === undefined || outs[i].amount === e.amount));
    if (!same) problems.push('PSBT outputs differ from the expected payout');
  } else {
    const allowed = t.outputs.only;
    if (outs.some((o) => !o.address || !allowed.includes(o.address))) problems.push('PSBT pays an address other than ours');
  }
  const paid = outs.reduce((s, o) => s + o.amount, 0n);
  const fee = t.outpoint.amount - paid;
  if (fee < 0n) problems.push('PSBT outputs exceed the escrow balance');
  else if (fee > t.maxFee) problems.push(`miner fee ${fee} exceeds payout_fee_reserve ${t.maxFee}`);
  if (!verifyPartialSig(tx, t.signer)) problems.push(`no valid partial signature from ${toHex(t.signer).slice(0, 12)}…`);
  return problems;
}

export interface SafeTemplate {
  usdc: `0x${string}`;
  multiSend: `0x${string}`;
  /** The Safe's current nonce (read on chain). */
  nonce: bigint;
  /** The Safe's USDC balance now (read on chain). */
  balance: bigint;
  /**
   * lock_amount. §4.8: anyone can send USDC to a Safe, so a payout signed earlier may move less than the
   * balance now; it is acceptable when lock_amount ≤ total ≤ balance (the excess stays in the Safe).
   */
  lock: bigint;
  /** `exact`: these transfers in this order (ruling); `only`: every transfer goes to one of these (refund). */
  transfers: { exact: Array<{ to: string; amount: bigint }> } | { only: string[] };
}

const lower = (a: string) => a.toLowerCase();

/** Problems with a counterparty's SafeTx (empty = it is the template). The signer is checked by the caller. */
export function safePayoutProblems(tx: SafeTx, t: SafeTemplate): string[] {
  const problems: string[] = [];
  if (tx.value !== 0n || tx.safeTxGas !== 0n || tx.baseGas !== 0n || tx.gasPrice !== 0n) problems.push('SafeTx must have value = safeTxGas = baseGas = gasPrice = 0');
  if (lower(tx.gasToken) !== zeroAddress || lower(tx.refundReceiver) !== zeroAddress) problems.push('SafeTx gasToken and refundReceiver must be zero');
  if (tx.nonce !== t.nonce) problems.push(`SafeTx nonce ${tx.nonce} is not the Safe's nonce ${t.nonce}`);
  let transfers: Array<{ to: `0x${string}`; amount: bigint }>;
  try {
    transfers = safeTxTransfers(tx, t.usdc, t.multiSend);
  } catch (err) {
    return [...problems, (err as Error).message];
  }
  if (!transfers.length) problems.push('SafeTx moves nothing');
  const total = transfers.reduce((s, x) => s + x.amount, 0n);
  if (total < t.lock) problems.push(`SafeTx moves ${total}, less than lock_amount ${t.lock}`);
  else if (total > t.balance) problems.push(`SafeTx moves ${total}, but the Safe holds only ${t.balance}`);
  if ('exact' in t.transfers) {
    const exp = t.transfers.exact.filter((x) => x.amount > 0n);
    const same = transfers.length === exp.length && exp.every((e, i) => lower(transfers[i].to) === lower(e.to) && transfers[i].amount === e.amount);
    if (!same) problems.push('SafeTx transfers differ from the expected payout');
  } else {
    const allowed = t.transfers.only.map(lower);
    if (transfers.some((x) => !allowed.includes(lower(x.to)))) problems.push('SafeTx pays an address other than ours');
  }
  return problems;
}
