import { Transaction } from '@scure/btc-signer';
import type { ChainApi, TxStatus, Utxo } from '../btc/esplora.js';
import { scriptToAddress } from '../btc/script.js';
import { fromHex, toHex } from '../util/bytes.js';

/**
 * Toy UTXO ledger implementing ChainApi. It checks that inputs exist and
 * are unspent but does NOT run scripts — integration tests use bitcoind for that.
 */
export class MemoryChain implements ChainApi {
  height = 200;
  private utxoSet = new Map<string, { address?: string; value: number; height?: number }>();
  private txs = new Map<string, { hex: string; height?: number }>();

  /** Credit `address` with a fake coinbase-like output. */
  fund(address: string, value: number): string {
    const txid = toHex(crypto.getRandomValues(new Uint8Array(32)));
    this.utxoSet.set(`${txid}:0`, { address, value, height: this.height });
    return txid;
  }

  mine(n = 1): void {
    this.height += n;
    for (const [k, u] of this.utxoSet) if (u.height === undefined) this.utxoSet.set(k, { ...u, height: this.height });
    for (const [k, t] of this.txs) if (t.height === undefined) this.txs.set(k, { ...t, height: this.height });
  }

  async utxos(address: string): Promise<Utxo[]> {
    return [...this.utxoSet.entries()]
      .filter(([, u]) => u.address === address)
      .map(([k, u]) => {
        const [txid, vout] = k.split(':');
        return { txid, vout: Number(vout), value: u.value, status: { confirmed: u.height !== undefined, block_height: u.height } };
      });
  }

  async txHex(txid: string): Promise<string> {
    const t = this.txs.get(txid);
    if (!t) throw new Error(`unknown tx ${txid}`);
    return t.hex;
  }

  async broadcast(hex: string): Promise<string> {
    const tx = Transaction.fromRaw(fromHex(hex), { allowUnknownOutputs: true, allowUnknownInputs: true });
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      const key = `${toHex(inp.txid!)}:${inp.index}`;
      if (!this.utxoSet.has(key)) throw new Error(`missing or spent input ${key}`);
    }
    if (tx.lockTime > this.height) throw new Error('non-final (locktime)');
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      this.utxoSet.delete(`${toHex(inp.txid!)}:${inp.index}`);
    }
    const txid = tx.id;
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i);
      this.utxoSet.set(`${txid}:${i}`, { address: scriptToAddress(o.script!), value: Number(o.amount) });
    }
    this.txs.set(txid, { hex });
    return txid;
  }

  async tipHeight(): Promise<number> {
    return this.height;
  }

  async txStatus(txid: string): Promise<TxStatus> {
    const t = this.txs.get(txid);
    return { confirmed: t?.height !== undefined, block_height: t?.height };
  }

  async feeEstimates(): Promise<Record<string, number>> {
    return { '1': 2, '6': 1 };
  }
}
