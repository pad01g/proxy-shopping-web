import { secp256k1 } from '@noble/curves/secp256k1';
import { Script } from '@scure/btc-signer';
import { describe, expect, it } from 'vitest';
import { KeySet } from '../keys/derive.js';
import { toHex } from '../util/bytes.js';
import { buildFundingTx } from './funding.js';
import { p2wshAddress, witnessScript } from './script.js';
import {
  buildEscrowSpend, describeInput, describeOutputs, extractTx, finalizeEscrowInput, psbtFromBase64, psbtToBase64,
  signEscrowInput, verifyPartialSig,
} from './spend.js';

const priv = (n: number) => {
  const k = new Uint8Array(32);
  k[31] = n;
  return k;
};
const pub = (n: number) => secp256k1.getPublicKey(priv(n), true);
const keys = { user: pub(1), shopper: pub(2), escrow: pub(3) };
const outpoint = { txid: 'aa'.repeat(32), vout: 0, amount: 29_667n };
const WALLET = KeySet.fromMnemonic('news hybrid corn purchase public hedgehog clay survey able alter supreme shove').btcWallet;

describe('witness script (§5.1)', () => {
  it('has the exact opcode layout', () => {
    const s = witnessScript(keys, 1234, 3456);
    const [U, S, E] = [keys.user, keys.shopper, keys.escrow].map((k) => '21' + toHex(k));
    // OP_IF OP_2 U S E OP_3 CHECKMULTISIG OP_ELSE OP_IF <1234> CLTV DROP S CHECKSIG OP_ELSE <3456> CLTV DROP U CHECKSIG ENDIF ENDIF
    expect(toHex(s)).toBe(`6352${U}${S}${E}53ae676302d204b175${S}ac6702800db175${U}ac6868`);
    expect(Script.decode(s)[1]).toBe(2);
    // minimal CScriptNum: 128 needs a sign byte, 255 too
    expect(toHex(witnessScript(keys, 128, 255))).toContain('02800' + '0b1');
    expect(p2wshAddress(s)).toMatch(/^tb1q[0-9a-z]{58}$/);
  });

  it('rejects bad timelocks', () => {
    expect(() => witnessScript(keys, 100, 100)).toThrow();
    expect(() => witnessScript(keys, 500_000_000, 500_000_001)).toThrow();
  });
});

describe('escrow spends', () => {
  const script = witnessScript(keys, 1234, 3456);
  const payout = [{ address: WALLET.address, amount: 28_667n }];

  it('2-of-3: signs via PSBT round trip and orders sigs U,S,E', () => {
    const tx = buildEscrowSpend({ outpoint, witnessScript: script, outputs: payout });
    signEscrowInput(tx, priv(3)); // escrow first
    const b64 = psbtToBase64(tx);
    const theirs = psbtFromBase64(b64);
    expect(verifyPartialSig(theirs, keys.escrow)).toBe(true);
    signEscrowInput(theirs, priv(1)); // user
    finalizeEscrowInput(theirs, keys, 'multisig');
    const witness = theirs.getInput(0).finalScriptWitness!;
    expect(witness).toHaveLength(5);
    expect(witness[0]).toHaveLength(0);
    // U before E, regardless of signing order
    expect(verifySig(theirs, witness[1], keys.user)).toBe(true);
    expect(verifySig(theirs, witness[2], keys.escrow)).toBe(true);
    expect(toHex(witness[3])).toBe('01');
    expect(theirs.lockTime).toBe(0);
    expect(describeInput(theirs).sequence).toBe(0xffffffff);
    expect(describeInput(theirs).txid).toBe(outpoint.txid);
    const { txid } = extractTx(theirs);
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
    expect(describeOutputs(theirs)).toEqual([{ address: WALLET.address, amount: 28_667n }]);
  });

  it('combines two independently signed PSBTs', () => {
    const base = psbtToBase64(buildEscrowSpend({ outpoint, witnessScript: script, outputs: payout }));
    const a = psbtFromBase64(base);
    const b = psbtFromBase64(base);
    signEscrowInput(a, priv(2));
    signEscrowInput(b, priv(1));
    a.combine(b);
    finalizeEscrowInput(a, keys, 'multisig');
    const w = a.getInput(0).finalScriptWitness!;
    expect(verifySig(a, w[1], keys.user)).toBe(true);
    expect(verifySig(a, w[2], keys.shopper)).toBe(true);
  });

  it('T1 shopper path and T2 user path set nLockTime / nSequence', () => {
    const t1 = buildEscrowSpend({ outpoint, witnessScript: script, outputs: payout, lockTime: 1234 });
    signEscrowInput(t1, priv(2));
    finalizeEscrowInput(t1, keys, 'shopper-after-t1');
    expect(t1.lockTime).toBe(1234);
    expect(describeInput(t1).sequence).toBe(0xfffffffe);
    const w1 = t1.getInput(0).finalScriptWitness!;
    expect(w1.map((x) => x.length).slice(1, 3)).toEqual([1, 0]);

    const t2 = buildEscrowSpend({ outpoint, witnessScript: script, outputs: payout, lockTime: 3456 });
    signEscrowInput(t2, priv(1));
    finalizeEscrowInput(t2, keys, 'user-after-t2');
    const w2 = t2.getInput(0).finalScriptWitness!;
    expect(w2.map((x) => x.length).slice(1, 3)).toEqual([0, 0]);
    expect(() => finalizeEscrowInput(buildEscrowSpend({ outpoint, witnessScript: script, outputs: payout }), keys, 'multisig')).toThrow();
  });

  it('drops zero outputs in a split', () => {
    const tx = buildEscrowSpend({ outpoint, witnessScript: script, outputs: [...payout, { address: WALLET.address, amount: 0n }] });
    expect(tx.outputsLength).toBe(1);
  });
});

describe('funding tx (§5.2)', () => {
  it('pays P2WSH first, escrow fee second, then change', () => {
    const escrowAddr = p2wshAddress(witnessScript(keys, 1234, 3456));
    const f = buildFundingTx({
      wallet: WALLET,
      utxos: [{ txid: 'bb'.repeat(32), vout: 1, value: 100_000, status: { confirmed: true } }],
      outputs: [{ address: escrowAddr, amount: 29_667n }, { address: WALLET.address, amount: 1000n }],
      feeRate: 2,
    });
    const outs = describeOutputs(f.tx);
    expect(outs.map((o) => o.address)).toEqual([escrowAddr, WALLET.address, WALLET.address]);
    expect(outs[0].amount + outs[1].amount + outs[2].amount + f.fee).toBe(100_000n);
    expect(f.fee).toBeGreaterThan(0n);
    expect(() => buildFundingTx({ wallet: WALLET, utxos: [], outputs: [{ address: escrowAddr, amount: 1n }], feeRate: 1 })).toThrow(/insufficient/);
  });
});

function verifySig(tx: ReturnType<typeof buildEscrowSpend>, sig: Uint8Array, pubkey: Uint8Array): boolean {
  const input = tx.getInput(0);
  const hash = tx.preimageWitnessV0(0, input.witnessScript!, 1, input.witnessUtxo!.amount);
  return secp256k1.verify(sig.slice(0, -1), hash, pubkey, { format: 'der' });
}
