import { secp256k1 } from '@noble/curves/secp256k1';
import { SigHash, Transaction } from '@scure/btc-signer';
import { concatBytes, equalBytes, fromBase64, toBase64, toHex } from '../util/bytes.js';
import { addressToScript, p2wshOutputScript, scriptToAddress, type EscrowKeys } from './script.js';
import type { TxOutputSpec } from './funding.js';

export interface EscrowOutpoint {
  txid: string;
  vout: number;
  amount: bigint;
}

export type SpendPath = 'multisig' | 'shopper-after-t1' | 'user-after-t2';

const SEQUENCE_FINAL = 0xffffffff;
const SEQUENCE_LOCKTIME = 0xfffffffe;

/**
 * Unsigned PSBT spending the escrow output (§5.1 table): 2-of-3 uses
 * nLockTime 0 / nSequence 0xffffffff; the timelock paths use the given
 * nLockTime and nSequence 0xfffffffe so CLTV is enforced.
 */
export function buildEscrowSpend(p: {
  outpoint: EscrowOutpoint;
  witnessScript: Uint8Array;
  outputs: TxOutputSpec[];
  lockTime?: number;
}): Transaction {
  const timelocked = (p.lockTime ?? 0) > 0;
  const tx = new Transaction({ lockTime: p.lockTime ?? 0, allowUnknownInputs: true });
  tx.addInput({
    txid: p.outpoint.txid,
    index: p.outpoint.vout,
    sequence: timelocked ? SEQUENCE_LOCKTIME : SEQUENCE_FINAL,
    witnessUtxo: { script: p2wshOutputScript(p.witnessScript), amount: p.outpoint.amount },
    witnessScript: p.witnessScript,
    sighashType: SigHash.ALL,
  });
  for (const o of p.outputs) {
    if (o.amount <= 0n) continue; // §5.2: no zero-value outputs
    tx.addOutput({ script: addressToScript(o.address), amount: o.amount });
  }
  return tx;
}

export const psbtToBase64 = (tx: Transaction): string => toBase64(tx.toPSBT());
export const psbtFromBase64 = (b64: string): Transaction =>
  Transaction.fromPSBT(fromBase64(b64), { allowUnknownInputs: true });

/** BIP143 SIGHASH_ALL signature for input `idx`, stored as a PSBT partial signature. */
export function signEscrowInput(tx: Transaction, privateKey: Uint8Array, idx = 0): Uint8Array {
  const input = tx.getInput(idx);
  if (!input.witnessScript || !input.witnessUtxo) throw new Error('input lacks witnessScript/witnessUtxo');
  const hash = tx.preimageWitnessV0(idx, input.witnessScript, SigHash.ALL, input.witnessUtxo.amount);
  const der = secp256k1.sign(hash, privateKey, { lowS: true }).toDERRawBytes();
  const sig = concatBytes(der, new Uint8Array([SigHash.ALL]));
  const pubkey = secp256k1.getPublicKey(privateKey, true);
  tx.updateInput(idx, { partialSig: [[pubkey, sig]] }, true);
  return sig;
}

function partialSigFor(tx: Transaction, pubkey: Uint8Array, idx: number): Uint8Array | undefined {
  return tx.getInput(idx).partialSig?.find(([pk]) => equalBytes(pk, pubkey))?.[1];
}

/** Check a partial signature (e.g. the counterparty's) against the sighash. */
export function verifyPartialSig(tx: Transaction, pubkey: Uint8Array, idx = 0): boolean {
  const input = tx.getInput(idx);
  const sig = partialSigFor(tx, pubkey, idx);
  if (!sig || !input.witnessScript || !input.witnessUtxo) return false;
  if (sig[sig.length - 1] !== SigHash.ALL) return false;
  const hash = tx.preimageWitnessV0(idx, input.witnessScript, SigHash.ALL, input.witnessUtxo.amount);
  try {
    return secp256k1.verify(sig.slice(0, -1), hash, pubkey, { format: 'der' });
  } catch {
    return false;
  }
}

/**
 * Write the final witness per §5.1:
 *   2-of-3:  <> <sig1> <sig2> <0x01> <script>  (sigs in U,S,E key order)
 *   T1:      <sigS> <0x01> <> <script>
 *   T2:      <sigU> <> <> <script>
 */
export function finalizeEscrowInput(tx: Transaction, keys: EscrowKeys, path: SpendPath, idx = 0): void {
  const input = tx.getInput(idx);
  const script = input.witnessScript;
  if (!script) throw new Error('missing witnessScript');
  const empty = new Uint8Array(0);
  const one = new Uint8Array([1]);
  let witness: Uint8Array[];
  if (path === 'multisig') {
    const sigs = [keys.user, keys.shopper, keys.escrow]
      .map((pk) => partialSigFor(tx, pk, idx))
      .filter((s): s is Uint8Array => !!s);
    if (sigs.length < 2) throw new Error(`need 2 signatures, have ${sigs.length}`);
    witness = [empty, sigs[0], sigs[1], one, script];
  } else if (path === 'shopper-after-t1') {
    const sig = partialSigFor(tx, keys.shopper, idx);
    if (!sig) throw new Error('missing shopper signature');
    witness = [sig, one, empty, script];
  } else {
    const sig = partialSigFor(tx, keys.user, idx);
    if (!sig) throw new Error('missing user signature');
    witness = [sig, empty, empty, script];
  }
  tx.updateInput(idx, { finalScriptWitness: witness }, true);
}

export function extractTx(tx: Transaction): { hex: string; txid: string } {
  return { hex: toHex(tx.extract()), txid: tx.id };
}

/** Outputs of a (PSBT) transaction as address/amount pairs, for checking a counterparty's proposal. */
export function describeOutputs(tx: Transaction): Array<{ address?: string; amount: bigint }> {
  const out: Array<{ address?: string; amount: bigint }> = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    out.push({ address: o.script ? scriptToAddress(o.script) : undefined, amount: o.amount ?? 0n });
  }
  return out;
}

export function describeInput(tx: Transaction, idx = 0): { txid: string; vout: number; amount?: bigint; sequence?: number } {
  const i = tx.getInput(idx);
  return { txid: i.txid ? toHex(i.txid) : '', vout: i.index ?? -1, amount: i.witnessUtxo?.amount, sequence: i.sequence };
}
