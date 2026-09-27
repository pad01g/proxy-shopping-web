import { Transaction } from '@scure/btc-signer';
import type { BtcWallet } from '../keys/derive.js';
import { toHex } from '../util/bytes.js';
import { addressToScript } from './script.js';
import type { Utxo } from './esplora.js';

export interface TxOutputSpec {
  address: string;
  amount: bigint;
}

// Rough vbytes: overhead, P2WPKH input, and outputs by type.
const VB_OVERHEAD = 11;
const VB_P2WPKH_IN = 68;
const vbOutput = (address: string) => (address.length > 50 ? 43 : 31); // P2WSH vs P2WPKH
const DUST = 546n;

export interface FundingTx {
  tx: Transaction;
  hex: string;
  txid: string;
  fee: bigint;
  change?: bigint;
}

/**
 * Build and sign a transaction paying `outputs` (in order) from P2WPKH wallet
 * UTXOs, with change back to the wallet. For the escrow funding (§5.2)
 * outputs are [P2WSH lock_amount, escrow fee address upfront fee].
 */
export function buildFundingTx(p: {
  wallet: BtcWallet;
  utxos: Utxo[];
  outputs: TxOutputSpec[];
  feeRate: number;
  changeAddress?: string;
  /** Refuse fee rates above this many sat/vB (default 1000). */
  maxFeeRate?: number;
}): FundingTx {
  if (!(Number.isFinite(p.feeRate) && p.feeRate > 0 && p.feeRate <= (p.maxFeeRate ?? 1000))) {
    throw new Error(`fee rate ${p.feeRate} sat/vB is outside 0..${p.maxFeeRate ?? 1000}`);
  }
  const target = p.outputs.reduce((s, o) => s + o.amount, 0n);
  const outVb = p.outputs.reduce((s, o) => s + vbOutput(o.address), 0) + 31; // + change
  const sorted = [...p.utxos].sort((a, b) => b.value - a.value);
  const chosen: Utxo[] = [];
  let total = 0n;
  let fee = 0n;
  for (const u of sorted) {
    chosen.push(u);
    total += BigInt(u.value);
    fee = BigInt(Math.ceil((VB_OVERHEAD + chosen.length * VB_P2WPKH_IN + outVb) * p.feeRate));
    if (total >= target + fee) break;
  }
  if (total < target + fee) {
    throw new Error(`insufficient funds: have ${total} sats, need ${target + fee}`);
  }

  const tx = new Transaction();
  for (const u of chosen) {
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: p.wallet.script, amount: BigInt(u.value) } });
  }
  for (const o of p.outputs) tx.addOutput({ script: addressToScript(o.address), amount: o.amount });
  let change: bigint | undefined = total - target - fee;
  if (change >= DUST) {
    tx.addOutput({ script: addressToScript(p.changeAddress ?? p.wallet.address), amount: change });
  } else {
    change = undefined; // below dust: leave it to the miner
  }
  tx.sign(p.wallet.privateKey);
  tx.finalize();
  return { tx, hex: toHex(tx.extract()), txid: tx.id, fee: total - target - (change ?? 0n), change };
}

/** Send everything from the wallet to one address (used for sweeping in tests/tools). */
export function buildSweepTx(p: { wallet: BtcWallet; utxos: Utxo[]; to: string; feeRate: number }): FundingTx {
  const total = p.utxos.reduce((s, u) => s + BigInt(u.value), 0n);
  const fee = BigInt(Math.ceil((VB_OVERHEAD + p.utxos.length * VB_P2WPKH_IN + vbOutput(p.to)) * p.feeRate));
  const tx = new Transaction();
  for (const u of p.utxos) {
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: p.wallet.script, amount: BigInt(u.value) } });
  }
  tx.addOutput({ script: addressToScript(p.to), amount: total - fee });
  tx.sign(p.wallet.privateKey);
  tx.finalize();
  return { tx, hex: toHex(tx.extract()), txid: tx.id, fee };
}
