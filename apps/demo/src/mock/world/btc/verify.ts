/**
 * Script checks of the mock BTC chain: segwit v0 inputs only (P2WPKH wallets, the escrow's P2WSH), with the
 * rules of Bitcoin Core's standard policy that matter here — BIP143 signatures (low S, strict DER), MINIMALIF,
 * NULLDUMMY, CLEANSTACK, and BIP65 OP_CHECKLOCKTIMEVERIFY against nLockTime and nSequence. The interpreter knows
 * the opcodes wallets and the escrow script (spec §5.1) use; any other opcode fails the input.
 */
import { ripemd160 } from '@noble/hashes/legacy';
import { sha256 } from '@noble/hashes/sha2';
import { secp256k1 } from '@noble/curves/secp256k1';
import { OutScript, Script, type Transaction } from '@scure/btc-signer';

type Op = ReturnType<typeof Script.decode>[number];

export class ScriptError extends Error {}

const fail = (why: string): never => {
  throw new ScriptError(why);
};

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const hash160 = (b: Uint8Array) => ripemd160(sha256(b));
const LOCKTIME_THRESHOLD = 500_000_000;
const SEQUENCE_FINAL = 0xffffffff;

/** CScriptNum (little endian, sign bit), minimally encoded, at most `max` bytes. */
function scriptNum(b: Uint8Array, max = 4): number {
  if (b.length > max) fail(`script number of ${b.length} bytes`);
  if (!b.length) return 0;
  if ((b[b.length - 1] & 0x7f) === 0 && (b.length === 1 || (b[b.length - 2] & 0x80) === 0)) fail('non-minimal script number');
  let v = 0n;
  for (let i = 0; i < b.length; i++) v |= BigInt(b[i]) << BigInt(8 * i);
  const neg = (b[b.length - 1] & 0x80) !== 0;
  if (neg) v &= ~(0x80n << BigInt(8 * (b.length - 1)));
  return Number(neg ? -v : v);
}

const numBytes = (n: number): Uint8Array => {
  if (n === 0) return new Uint8Array();
  const out: number[] = [];
  let v = Math.abs(n);
  while (v > 0) {
    out.push(v & 0xff);
    v = Math.floor(v / 256);
  }
  if (out[out.length - 1] & 0x80) out.push(n < 0 ? 0x80 : 0);
  else if (n < 0) out[out.length - 1] |= 0x80;
  return new Uint8Array(out);
};

const truthy = (b: Uint8Array): boolean => {
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== 0) return !(i === b.length - 1 && b[i] === 0x80);
  }
  return false;
};

export interface InputContext {
  tx: Transaction;
  idx: number;
  /** Value of the output being spent (sats). */
  amount: bigint;
}

/** A BIP143 signature (DER + hash type) by `pubkey` over input `idx` with `scriptCode`. */
function checkSig(ctx: InputContext, sig: Uint8Array, pubkey: Uint8Array, scriptCode: Uint8Array): boolean {
  if (!sig.length) return false;
  if (pubkey.length !== 33 || (pubkey[0] !== 2 && pubkey[0] !== 3)) fail('public key is not compressed (witness pubkey type)');
  const hashType = sig[sig.length - 1];
  if (![0x01, 0x02, 0x03, 0x81, 0x82, 0x83].includes(hashType)) fail(`bad sighash type ${hashType}`);
  const hash = ctx.tx.preimageWitnessV0(ctx.idx, scriptCode, hashType, ctx.amount);
  let s;
  try {
    s = secp256k1.Signature.fromDER(sig.subarray(0, -1));
  } catch {
    return fail('signature is not strict DER');
  }
  if (s.hasHighS()) fail('signature has a high S (not low-S)');
  try {
    return secp256k1.verify(s.toCompactRawBytes(), hash, pubkey, { lowS: true });
  } catch {
    return false;
  }
}

/** Run a witness script; returns normally when it succeeds. */
function execute(ctx: InputContext, script: Uint8Array, witness: Uint8Array[]): void {
  let ops: Op[];
  try {
    ops = Script.decode(script);
  } catch (err) {
    return fail(`undecodable script: ${(err as Error).message}`);
  }
  const stack = [...witness];
  const pop = (): Uint8Array => stack.pop() ?? fail('stack underflow');
  const top = (): Uint8Array => stack[stack.length - 1] ?? fail('stack underflow');
  const exec: boolean[] = [];
  const running = () => exec.every(Boolean);
  const input = ctx.tx.getInput(ctx.idx);
  for (const op of ops) {
    if (op === 'IF' || op === 'NOTIF') {
      let v = false;
      if (running()) {
        const b = pop();
        // MINIMALIF (segwit v0 policy): the argument is empty or exactly 0x01
        if (b.length > 1 || (b.length === 1 && b[0] !== 1)) fail('OP_IF argument is not minimal');
        v = b.length === 1;
        if (op === 'NOTIF') v = !v;
      }
      exec.push(v);
      continue;
    }
    if (op === 'ELSE') {
      if (!exec.length) fail('OP_ELSE without OP_IF');
      exec[exec.length - 1] = !exec[exec.length - 1];
      continue;
    }
    if (op === 'ENDIF') {
      if (!exec.length) fail('OP_ENDIF without OP_IF');
      exec.pop();
      continue;
    }
    if (!running()) continue;
    if (op instanceof Uint8Array) {
      stack.push(op);
      continue;
    }
    if (typeof op === 'number') {
      stack.push(numBytes(op));
      continue;
    }
    switch (op) {
      case 'DROP':
        pop();
        break;
      case 'DUP':
        stack.push(top());
        break;
      case 'HASH160':
        stack.push(hash160(pop()));
        break;
      case 'EQUAL':
      case 'EQUALVERIFY': {
        const r = eq(pop(), pop());
        if (op === 'EQUALVERIFY') {
          if (!r) fail('OP_EQUALVERIFY failed');
        } else stack.push(r ? new Uint8Array([1]) : new Uint8Array());
        break;
      }
      case 'VERIFY':
        if (!truthy(pop())) fail('OP_VERIFY failed');
        break;
      case 'CHECKSIG':
      case 'CHECKSIGVERIFY': {
        const pk = pop();
        const sig = pop();
        const ok = checkSig(ctx, sig, pk, script);
        if (!ok && sig.length) fail('signature does not verify (NULLFAIL)');
        if (op === 'CHECKSIGVERIFY') {
          if (!ok) fail('OP_CHECKSIGVERIFY failed');
        } else stack.push(ok ? new Uint8Array([1]) : new Uint8Array());
        break;
      }
      case 'CHECKMULTISIG': {
        const n = scriptNum(pop());
        if (n < 0 || n > 20) fail('bad key count');
        const keys = Array.from({ length: n }, pop).reverse();
        const m = scriptNum(pop());
        if (m < 0 || m > n) fail('bad signature count');
        const sigs = Array.from({ length: m }, pop).reverse();
        if (pop().length) fail('CHECKMULTISIG dummy is not empty (NULLDUMMY)');
        let k = 0;
        let ok = true;
        for (const sig of sigs) {
          while (k < keys.length && !checkSig(ctx, sig, keys[k], script)) k++;
          if (k >= keys.length) {
            ok = false;
            break;
          }
          k++;
        }
        if (!ok && sigs.some((s) => s.length)) fail('multisig signatures do not verify (NULLFAIL)');
        stack.push(ok ? new Uint8Array([1]) : new Uint8Array());
        break;
      }
      case 'CHECKLOCKTIMEVERIFY': {
        const lock = scriptNum(top(), 5);
        if (lock < 0) fail('negative locktime');
        const txLock = ctx.tx.lockTime;
        if ((lock < LOCKTIME_THRESHOLD) !== (txLock < LOCKTIME_THRESHOLD)) fail('locktime type mismatch');
        if (lock > txLock) fail(`locktime requirement not satisfied (script ${lock}, nLockTime ${txLock})`);
        if ((input.sequence ?? SEQUENCE_FINAL) === SEQUENCE_FINAL) fail('input sequence is final, OP_CHECKLOCKTIMEVERIFY needs it lower');
        break;
      }
      default:
        fail(`opcode ${String(op)} is not supported by the mock chain`);
    }
  }
  if (exec.length) fail('unbalanced conditional');
  // CLEANSTACK: exactly one true element
  if (stack.length !== 1) fail(`stack has ${stack.length} elements after execution (CLEANSTACK)`);
  if (!truthy(stack[0])) fail('script evaluated to false');
}

/** Check input `idx` spending an output with `prevScript` worth `amount`; throws ScriptError when it fails. */
export function verifyInput(tx: Transaction, idx: number, prevScript: Uint8Array, amount: bigint): void {
  const ctx: InputContext = { tx, idx, amount };
  const input = tx.getInput(idx);
  const witness = input.finalScriptWitness ?? [];
  if (input.finalScriptSig?.length) fail('segwit input with a scriptSig');
  let out;
  try {
    out = OutScript.decode(prevScript);
  } catch {
    return fail('unknown output script');
  }
  if (out.type === 'wpkh') {
    if (witness.length !== 2) fail('P2WPKH witness must have 2 items');
    const [sig, pk] = witness;
    if (!eq(hash160(pk), out.hash)) fail('P2WPKH public key does not match the program');
    const scriptCode = OutScript.encode({ type: 'pkh', hash: out.hash });
    if (!checkSig(ctx, sig, pk, scriptCode)) fail('P2WPKH signature does not verify');
    return;
  }
  if (out.type === 'wsh') {
    if (!witness.length) fail('empty P2WSH witness');
    const script = witness[witness.length - 1];
    if (!eq(sha256(script), out.hash)) fail('witness script does not match the P2WSH program');
    execute(ctx, script, witness.slice(0, -1));
    return;
  }
  fail(`output type ${out.type} is not supported by the mock chain`);
}
