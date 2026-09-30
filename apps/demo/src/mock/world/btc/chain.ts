/**
 * The mock mode's BTC chain: a UTXO ledger implementing core's ChainApi (the Esplora subset), standing in for
 * the lab's bitcoind (signet) + esplora-lite. Transactions are real: broadcast parses them, checks that the
 * inputs exist and are unspent, the amounts, the fee (1 sat/vB like bitcoind's minrelaytxfee), dust, finality
 * (nLockTime) and every input's witness (verify.ts: signatures, CHECKMULTISIG, CHECKLOCKTIMEVERIFY). The mempool
 * is mined like the lab's faucet does (a block shortly after a transaction arrives), or on demand.
 *
 * The faucet pays from its own P2WPKH wallet (the lab faucet key) with real transactions; its coins come from
 * a genesis coinbase. The whole state is JSON (`snapshot`) so the world can store it.
 */
import { sha256 } from '@noble/hashes/sha2';
import { OutScript, Script, Transaction } from '@scure/btc-signer';
import {
  addressToScript, buildFundingTx, fromHex, scriptToAddress, toHex, type BtcWallet, type ChainApi, type Outspend, type TxStatus, type Utxo,
} from '@proxy-shopping/core/browser';
import { verifyInput, ScriptError } from './verify';

interface UtxoRec {
  script: string;
  value: number;
  /** Height of the block that confirmed it; undefined while in the mempool. */
  height?: number;
}

interface TxRec {
  hex: string;
  height?: number;
  coinbase?: boolean;
}

interface BlockRec {
  height: number;
  hash: string;
  time: number;
}

export interface BtcState {
  blocks: BlockRec[];
  txs: Record<string, TxRec>;
  utxos: Record<string, UtxoRec>;
  spentBy: Record<string, { txid: string; vin: number }>;
  /** Transactions in the mempool, in arrival order. */
  mempool: string[];
}

export class BroadcastError extends Error {}

const START_HEIGHT = 200;
const GENESIS_SATS = 100_000_000_000; // 1000 BTC for the faucet
const SEQUENCE_FINAL = 0xffffffff;
const LOCKTIME_THRESHOLD = 500_000_000;

const key = (txid: string, vout: number) => `${txid}:${vout}`;

/** bitcoind's dust limits (at 3 sat/vB): P2WPKH 294, P2WSH 330, others 546. */
function dustLimit(script: Uint8Array): number {
  try {
    const o = OutScript.decode(script);
    if (o.type === 'wpkh') return 294;
    if (o.type === 'wsh' || o.type === 'tr') return 330;
  } catch {
    /* unknown */
  }
  return 546;
}

export interface MockBtcChainOptions {
  /** The faucet's wallet (the lab faucet key). */
  faucet: BtcWallet;
  state?: BtcState;
  now?: () => number;
  /** Called after every change (to persist `snapshot()`). */
  onChange?: () => void;
  /** Mine the mempool this long after a transaction arrives (ms); 0 = never by itself. */
  autoMineMs?: number;
}

export class MockBtcChain implements ChainApi {
  private s: BtcState;
  private readonly now: () => number;
  private readonly faucetWallet: BtcWallet;
  private readonly onChange?: () => void;
  private readonly autoMineMs: number;
  private mineTimer?: ReturnType<typeof setTimeout>;

  constructor(o: MockBtcChainOptions) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.faucetWallet = o.faucet;
    this.onChange = o.onChange;
    this.autoMineMs = o.autoMineMs ?? 1000;
    this.s = o.state ?? this.genesis();
    if (this.s.mempool.length) this.scheduleMine();
  }

  /** Blocks up to START_HEIGHT, the last with a coinbase paying the faucet. */
  private genesis(): BtcState {
    const t = this.now();
    const blocks: BlockRec[] = [];
    for (let h = 0; h <= START_HEIGHT; h++) blocks.push({ height: h, hash: this.blockHash(h, h ? blocks[h - 1].hash : '', t - (START_HEIGHT - h) * 600), time: t - (START_HEIGHT - h) * 600 });
    const cb = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });
    cb.addOutput({ script: this.faucetWallet.script, amount: BigInt(GENESIS_SATS) });
    cb.addInput({ txid: new Uint8Array(32), index: 0xffffffff, sequence: SEQUENCE_FINAL, finalScriptSig: Script.encode([new Uint8Array([START_HEIGHT & 0xff, START_HEIGHT >> 8]), new TextEncoder().encode('ps-demo mock')]) });
    const hex = toHex(cb.toBytes(true, true));
    const txid = cb.id;
    return {
      blocks,
      txs: { [txid]: { hex, height: START_HEIGHT, coinbase: true } },
      utxos: { [key(txid, 0)]: { script: toHex(this.faucetWallet.script), value: GENESIS_SATS, height: START_HEIGHT } },
      spentBy: {},
      mempool: [],
    };
  }

  private blockHash(height: number, prev: string, time: number): string {
    return toHex(sha256(new TextEncoder().encode(`ps-demo-mock-block:${height}:${prev}:${time}:${Math.random()}`)));
  }

  snapshot(): BtcState {
    return this.s;
  }

  get height(): number {
    return this.s.blocks.length - 1;
  }

  private changed(): void {
    this.onChange?.();
  }

  // ---------- mining ----------

  private scheduleMine(): void {
    if (!this.autoMineMs || this.mineTimer) return;
    this.mineTimer = setTimeout(() => {
      this.mineTimer = undefined;
      if (this.s.mempool.length) this.mine(1);
    }, this.autoMineMs);
  }

  /** Mine `n` blocks; the first one takes the whole mempool. Returns the new height. */
  mine(n = 1): number {
    for (let i = 0; i < n; i++) {
      const prev = this.s.blocks[this.s.blocks.length - 1];
      const height = prev.height + 1;
      // Block times follow the clock but always increase (like generatetoaddress with the median-time rule).
      const time = Math.max(prev.time + 1, this.now());
      this.s.blocks.push({ height, hash: this.blockHash(height, prev.hash, time), time });
      for (const txid of this.s.mempool) {
        this.s.txs[txid].height = height;
        const tx = Transaction.fromRaw(fromHex(this.s.txs[txid].hex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
        for (let o = 0; o < tx.outputsLength; o++) {
          const u = this.s.utxos[key(txid, o)];
          if (u) u.height = height;
        }
      }
      this.s.mempool = [];
    }
    this.changed();
    return this.height;
  }

  // ---------- faucet ----------

  /** Send `sats` from the faucet wallet to `address` and mine a block (the lab faucet's POST /btc). */
  async faucetSend(address: string, sats: number): Promise<string> {
    const utxos = await this.utxos(this.faucetWallet.address);
    const tx = buildFundingTx({ wallet: this.faucetWallet, utxos, outputs: [{ address, amount: BigInt(sats) }], feeRate: 1 });
    const txid = await this.broadcast(tx.hex);
    this.mine(1);
    return txid;
  }

  // ---------- ChainApi ----------

  async utxos(address: string): Promise<Utxo[]> {
    let script: string;
    try {
      script = toHex(addressToScript(address));
    } catch {
      throw new Error(`esplora /address/${address}/utxo: HTTP 400 Invalid Bitcoin address`);
    }
    return Object.entries(this.s.utxos)
      .filter(([, u]) => u.script === script)
      .map(([k, u]) => {
        const [txid, vout] = k.split(':');
        return { txid, vout: Number(vout), value: u.value, status: u.height === undefined ? { confirmed: false } : { confirmed: true, block_height: u.height } };
      });
  }

  async txHex(txid: string): Promise<string> {
    const t = this.s.txs[txid];
    if (!t) throw new Error(`esplora /tx/${txid}/hex: HTTP 404 Transaction not found`);
    return t.hex;
  }

  async broadcast(hex: string): Promise<string> {
    let tx: Transaction;
    try {
      tx = Transaction.fromRaw(fromHex(hex.trim()), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
    } catch (err) {
      throw new BroadcastError(`broadcast failed: HTTP 400 TX decode failed: ${(err as Error).message}`);
    }
    const txid = tx.id;
    if (this.s.txs[txid]) return txid; // already known: same transaction
    const reject = (why: string): never => {
      throw new BroadcastError(`broadcast failed: HTTP 400 sendrawtransaction RPC error: ${why}`);
    };
    if (!tx.inputsLength || !tx.outputsLength) reject('bad-txns-vin-empty / vout-empty');
    const spends: string[] = [];
    let inSum = 0n;
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      const k = key(toHex(inp.txid!), inp.index!);
      if (spends.includes(k)) reject('bad-txns-inputs-duplicate');
      spends.push(k);
      const u = this.s.utxos[k];
      if (!u) reject(this.s.spentBy[k] ? `txn-mempool-conflict / bad-txns-inputs-missingorspent (${k} already spent by ${this.s.spentBy[k].txid})` : `bad-txns-inputs-missingorspent (${k})`);
      inSum += BigInt(u.value);
      try {
        verifyInput(tx, i, fromHex(u.script), BigInt(u.value));
      } catch (err) {
        if (err instanceof ScriptError) reject(`mandatory-script-verify-flag-failed (input ${i}: ${err.message})`);
        throw err;
      }
    }
    let outSum = 0n;
    for (let o = 0; o < tx.outputsLength; o++) {
      const out = tx.getOutput(o);
      if (!out.script || out.amount === undefined) reject('bad output');
      if (out.amount! < BigInt(dustLimit(out.script!))) reject(`dust (output ${o}: ${out.amount} sats)`);
      outSum += out.amount!;
    }
    if (outSum > inSum) reject('bad-txns-in-belowout');
    const fee = inSum - outSum;
    if (fee < BigInt(tx.vsize)) reject(`min relay fee not met, ${fee} < ${tx.vsize}`);
    // Final in the next block? (nLockTime by height; a final sequence everywhere disables it.)
    const lockActive = tx.lockTime !== 0 && Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i).sequence ?? SEQUENCE_FINAL).some((s) => s !== SEQUENCE_FINAL);
    if (lockActive) {
      if (tx.lockTime >= LOCKTIME_THRESHOLD) reject('non-final (time-based nLockTime is not supported by the mock chain)');
      if (tx.lockTime > this.height) reject(`non-final (nLockTime ${tx.lockTime} > tip ${this.height})`);
    }
    // Accept into the mempool.
    spends.forEach((k, vin) => {
      delete this.s.utxos[k];
      this.s.spentBy[k] = { txid, vin };
    });
    for (let o = 0; o < tx.outputsLength; o++) {
      const out = tx.getOutput(o);
      this.s.utxos[key(txid, o)] = { script: toHex(out.script!), value: Number(out.amount!) };
    }
    this.s.txs[txid] = { hex: hex.trim().toLowerCase() };
    this.s.mempool.push(txid);
    this.changed();
    this.scheduleMine();
    return txid;
  }

  async tipHeight(): Promise<number> {
    return this.height;
  }

  async tipTime(): Promise<number> {
    return this.s.blocks[this.s.blocks.length - 1].time;
  }

  async txStatus(txid: string): Promise<TxStatus> {
    const t = this.s.txs[txid];
    if (!t) throw new Error(`esplora /tx/${txid}/status: HTTP 404 Transaction not found`);
    if (t.height === undefined) return { confirmed: false };
    return { confirmed: true, block_height: t.height, block_hash: this.s.blocks[t.height].hash };
  }

  async outspend(txid: string, vout: number): Promise<Outspend> {
    if (!this.s.txs[txid]) throw new Error(`esplora /tx/${txid}/outspend/${vout}: HTTP 404 Transaction not found`);
    const sp = this.s.spentBy[key(txid, vout)];
    if (!sp) return { spent: false };
    const h = this.s.txs[sp.txid]?.height;
    return { spent: true, txid: sp.txid, vin: sp.vin, status: h === undefined ? { confirmed: false } : { confirmed: true, block_height: h, block_hash: this.s.blocks[h].hash } };
  }

  async feeEstimates(): Promise<Record<string, number>> {
    return { '1': 1, '6': 1, '144': 1 };
  }

  // ---------- helpers for the shopper engine and the tab ----------

  /** Confirmations of a transaction (0 in the mempool); throws for an unknown one. */
  confirmations(txid: string): number {
    const t = this.s.txs[txid];
    if (!t) throw new Error(`unknown transaction ${txid}`);
    return t.height === undefined ? 0 : this.height - t.height + 1;
  }

  /** Output `vout` of a known transaction (address, value). */
  output(txid: string, vout: number): { address?: string; value: bigint } | undefined {
    const t = this.s.txs[txid];
    if (!t) return undefined;
    const tx = Transaction.fromRaw(fromHex(t.hex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
    if (vout >= tx.outputsLength) return undefined;
    const o = tx.getOutput(vout);
    return { address: scriptToAddress(o.script!), value: o.amount! };
  }

  stop(): void {
    if (this.mineTimer) clearTimeout(this.mineTimer);
  }
}
