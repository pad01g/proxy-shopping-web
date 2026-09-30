/**
 * The mock mode's EVM: a real EVM (@ethereumjs/vm, Cancun) running the lab's contract bytecode (Safe v1.4.1,
 * PSEscrowModule, PSSafeSetup, MockUSDC, feeds, PSBond; see genesis.ts), behind the JSON-RPC subset viem and
 * core's EvmClient use. It behaves like the lab's anvil: every transaction is mined in its own block at once
 * (automine), `anvil_setBalance`, `evm_increaseTime` + `evm_mine` exist for the faucet and the lab tab.
 *
 * State is never stored: the chain is a log of operations (genesis time, raw transactions with their block
 * times, balance changes, time warps) that is replayed on start, which gives the same state again because
 * the EVM is deterministic.
 */
import { createBlock, type Block } from '@ethereumjs/block';
import { createCustomCommon, Hardfork, Mainnet, type Common } from '@ethereumjs/common';
import { createTxFromRLP, type TypedTransaction } from '@ethereumjs/tx';
import {
  Account, Address, bytesToHex, createAddressFromString, hexToBytes, type PrefixedHexString,
} from '@ethereumjs/util';
import { createVM, runTx, type VM } from '@ethereumjs/vm';
import { deployGenesis, GENESIS_BALANCE, type GenesisResult } from './genesis';

type Hex = `0x${string}`;

export type EvmOp =
  | { t: 'genesis'; time: number }
  | { t: 'tx'; raw: Hex; time: number }
  | { t: 'balance'; address: Hex; wei: string }
  | { t: 'warp'; seconds: number; time: number };

interface StoredLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  logIndex: number;
}

interface StoredReceipt {
  transactionHash: Hex;
  transactionIndex: number;
  blockHash: Hex;
  blockNumber: number;
  from: Hex;
  to: Hex | null;
  contractAddress: Hex | null;
  status: 0 | 1;
  gasUsed: bigint;
  cumulativeGasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: StoredLog[];
  logsBloom: Hex;
  type: number;
}

interface StoredTx {
  hash: Hex;
  raw: Hex;
  from: Hex;
  to: Hex | null;
  nonce: bigint;
  value: bigint;
  input: Hex;
  gas: bigint;
  type: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  v?: bigint;
  r?: bigint;
  s?: bigint;
  chainId?: bigint;
  blockNumber: number;
  blockHash: Hex;
  transactionIndex: number;
}

interface StoredBlock {
  number: number;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
  gasUsed: bigint;
  txs: Hex[];
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Hex,
  ) {
    super(message);
  }
}

const BASE_FEE = 1_000_000_000n; // 1 gwei, constant (anvil starts at 1 gwei)
const PRIORITY_FEE = 1_000_000_000n;
const BLOCK_GAS_LIMIT = 30_000_000n;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;
const EMPTY_BLOOM = `0x${'00'.repeat(256)}` as Hex;
const COINBASE = createAddressFromString('0x0000000000000000000000000000000000000000');

const hx = (n: bigint | number): Hex => `0x${BigInt(n).toString(16)}`;
const lower = (a: string): Hex => a.toLowerCase() as Hex;
const toBig = (v: unknown, dflt = 0n): bigint => (v === undefined || v === null || v === '' ? dflt : BigInt(v as string));

export interface MockEvmOptions {
  chainId: number;
  /** Clock (UNIX seconds); tests can move it. */
  now?: () => number;
  /** Operations to replay (from storage). */
  log?: EvmOp[];
  /** Called with the full log after every change (to persist it). */
  onLog?: (log: EvmOp[]) => void;
}

export class MockEvm {
  readonly chainId: number;
  private readonly common: Common;
  private vm!: VM;
  private readonly now: () => number;
  private readonly onLog?: (log: EvmOp[]) => void;
  private log: EvmOp[] = [];
  private blocks: StoredBlock[] = [];
  private readonly byHash = new Map<Hex, StoredBlock>();
  private readonly txs = new Map<Hex, StoredTx>();
  private readonly receipts = new Map<Hex, StoredReceipt>();
  /** evm_increaseTime so far (seconds). */
  private offset = 0;
  private queue: Promise<unknown> = Promise.resolve();
  genesis!: GenesisResult;

  private constructor(o: MockEvmOptions) {
    this.chainId = o.chainId;
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.onLog = o.onLog;
    this.common = createCustomCommon({ chainId: o.chainId, name: `chain-${o.chainId}` }, Mainnet, { hardfork: Hardfork.Cancun });
  }

  static async create(o: MockEvmOptions): Promise<MockEvm> {
    const evm = new MockEvm(o);
    await evm.init(o.log ?? []);
    return evm;
  }

  private async init(log: EvmOp[]): Promise<void> {
    this.vm = await createVM({ common: this.common, evmOpts: { allowUnlimitedContractSize: true } });
    const first = log[0]?.t === 'genesis' ? log[0] : { t: 'genesis' as const, time: this.now() };
    this.genesis = await deployGenesis(this.vm, this.blockAt(0, first.time));
    this.pushBlock(0, first.time, 0n, []);
    this.log = [first];
    for (const op of log.slice(1)) {
      try {
        await this.apply(op);
      } catch (err) {
        console.warn('mock evm: replay step failed', op.t, err);
      }
    }
    this.persist();
  }

  /** Serialize changes: RPC calls come from several sessions at once. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private persist(): void {
    this.onLog?.(this.log);
  }

  private async apply(op: EvmOp): Promise<unknown> {
    switch (op.t) {
      case 'genesis':
        return undefined;
      case 'balance': {
        const a = createAddressFromString(op.address);
        const acc = (await this.vm.stateManager.getAccount(a)) ?? new Account();
        acc.balance = BigInt(op.wei);
        await this.vm.stateManager.putAccount(a, acc);
        this.log.push(op);
        return undefined;
      }
      case 'warp':
        this.offset += op.seconds;
        this.pushBlock(this.blocks.length, op.time, 0n, []);
        this.log.push(op);
        return undefined;
      case 'tx': {
        const hash = await this.execute(op.raw, op.time);
        this.log.push(op);
        return hash;
      }
    }
  }

  private blockAt(number: number, time: number): Block {
    return createBlock(
      {
        header: {
          number: BigInt(number),
          timestamp: BigInt(time),
          gasLimit: BLOCK_GAS_LIMIT,
          baseFeePerGas: BASE_FEE,
          coinbase: COINBASE,
          parentHash: hexToBytes(this.blocks[number - 1]?.hash ?? ZERO_HASH),
        },
      },
      { common: this.common, skipConsensusFormatValidation: true },
    );
  }

  private pushBlock(number: number, time: number, gasUsed: bigint, txs: Hex[], hash?: Hex): StoredBlock {
    const b: StoredBlock = {
      number,
      hash: hash ?? bytesToHex(this.blockAt(number, time).hash()) as Hex,
      parentHash: this.blocks[number - 1]?.hash ?? ZERO_HASH,
      timestamp: time,
      gasUsed,
      txs,
    };
    this.blocks.push(b);
    this.byHash.set(b.hash, b);
    return b;
  }

  private get latest(): StoredBlock {
    return this.blocks[this.blocks.length - 1];
  }

  /** Time of the next block: the clock plus the warps, never before the last block. */
  private nextTime(): number {
    return Math.max(this.latest.timestamp + 1, this.now() + this.offset);
  }

  private parseTx(raw: Hex): TypedTransaction {
    try {
      return createTxFromRLP(hexToBytes(raw), { common: this.common }) as TypedTransaction;
    } catch (err) {
      throw new RpcError(-32602, `invalid raw transaction: ${(err as Error).message}`);
    }
  }

  /** Run a signed transaction in a new block (automine). Invalid ones throw and change nothing. */
  private async execute(raw: Hex, time: number): Promise<Hex> {
    const tx = this.parseTx(raw);
    const hash = bytesToHex(tx.hash()) as Hex;
    if (this.txs.has(hash)) return hash;
    if (!tx.isSigned()) throw new RpcError(-32602, 'transaction is not signed');
    if (tx.common.chainId() !== BigInt(this.chainId)) throw new RpcError(-32602, `wrong chain id ${tx.common.chainId()}`);
    const number = this.blocks.length;
    const block = this.blockAt(number, time);
    let res;
    try {
      res = await runTx(this.vm, { tx, block, skipHardForkValidation: true });
    } catch (err) {
      // Nonce, balance or fee problems: the node refuses the transaction (nothing is mined).
      throw new RpcError(-32003, (err as Error).message.replace(/ -> .*$/s, ''));
    }
    const b = this.pushBlock(number, time, res.totalGasSpent, [hash], bytesToHex(block.hash()) as Hex);
    const from = lower(tx.getSenderAddress().toString());
    const to = tx.to ? lower(tx.to.toString()) : null;
    const status = res.execResult.exceptionError ? 0 : 1;
    const t = tx as TypedTransaction & { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint };
    const effectiveGasPrice = t.maxFeePerGas !== undefined
      ? BASE_FEE + (t.maxPriorityFeePerGas! < t.maxFeePerGas - BASE_FEE ? t.maxPriorityFeePerGas! : t.maxFeePerGas - BASE_FEE)
      : t.gasPrice ?? BASE_FEE;
    this.txs.set(hash, {
      hash, raw, from, to, nonce: tx.nonce, value: tx.value, input: bytesToHex(tx.data) as Hex, gas: tx.gasLimit, type: tx.type,
      maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas, gasPrice: t.gasPrice,
      v: tx.v, r: tx.r, s: tx.s, chainId: BigInt(this.chainId), blockNumber: number, blockHash: b.hash, transactionIndex: 0,
    });
    this.receipts.set(hash, {
      transactionHash: hash,
      transactionIndex: 0,
      blockHash: b.hash,
      blockNumber: number,
      from,
      to,
      contractAddress: res.createdAddress ? lower(res.createdAddress.toString()) : null,
      status,
      gasUsed: res.totalGasSpent,
      cumulativeGasUsed: res.totalGasSpent,
      effectiveGasPrice,
      logs: (res.execResult.logs ?? []).map(([address, topics, data], i) => ({
        address: lower(bytesToHex(address)), topics: topics.map((x) => bytesToHex(x) as Hex), data: bytesToHex(data) as Hex, logIndex: i,
      })),
      logsBloom: bytesToHex(res.bloom.bitvector) as Hex,
      type: tx.type,
    });
    return hash;
  }

  // ---------- lab operations (faucet, time) ----------

  sendRaw(raw: Hex): Promise<Hex> {
    return this.serial(async () => {
      const op: EvmOp = { t: 'tx', raw, time: this.nextTime() };
      const hash = (await this.apply(op)) as Hex;
      this.persist();
      return hash;
    });
  }

  setBalance(address: string, wei: bigint): Promise<void> {
    return this.serial(async () => {
      await this.apply({ t: 'balance', address: lower(address), wei: wei.toString() });
      this.persist();
    });
  }

  /** evm_increaseTime + evm_mine. */
  increaseTime(seconds: number): Promise<number> {
    return this.serial(async () => {
      const time = Math.max(this.latest.timestamp + 1, this.now() + this.offset + seconds);
      await this.apply({ t: 'warp', seconds, time });
      this.persist();
      return time;
    });
  }

  /** Chain time: the latest block's timestamp. */
  latestTime(): number {
    return this.latest.timestamp;
  }

  async balance(address: string): Promise<bigint> {
    return (await this.vm.stateManager.getAccount(createAddressFromString(address)))?.balance ?? 0n;
  }

  /** Read-only call (eth_call) at the latest state. */
  async call(p: { from?: string; to?: string; data?: string; value?: bigint; gas?: bigint }): Promise<{ ok: boolean; returnValue: Hex; gasUsed: bigint }> {
    await this.vm.stateManager.checkpoint();
    try {
      const block = this.blockAt(this.blocks.length, this.nextTime());
      const caller = p.from ? createAddressFromString(p.from) : createAddressFromString(`0x${'00'.repeat(20)}`);
      const r = await this.vm.evm.runCall({
        caller,
        origin: caller,
        to: p.to ? createAddressFromString(p.to) : undefined,
        data: p.data ? hexToBytes(p.data as PrefixedHexString) : new Uint8Array(),
        value: p.value ?? 0n,
        gasLimit: p.gas ?? BLOCK_GAS_LIMIT,
        block,
        skipBalance: true,
      });
      return { ok: !r.execResult.exceptionError, returnValue: bytesToHex(r.execResult.returnValue) as Hex, gasUsed: r.execResult.executionGasUsed };
    } finally {
      await this.vm.stateManager.revert();
    }
  }

  // ---------- JSON-RPC ----------

  /** EIP-1193 request: the methods viem and core use, plus the anvil helpers. */
  request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
    const p = params as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    switch (method) {
      case 'eth_chainId': return Promise.resolve(hx(this.chainId));
      case 'net_version': return Promise.resolve(String(this.chainId));
      case 'eth_blockNumber': return Promise.resolve(hx(this.latest.number));
      case 'eth_gasPrice': return Promise.resolve(hx(BASE_FEE + PRIORITY_FEE));
      case 'eth_maxPriorityFeePerGas': return Promise.resolve(hx(PRIORITY_FEE));
      case 'eth_feeHistory': return Promise.resolve(this.feeHistory(Number(p[0] ?? 1)));
      case 'eth_getBalance': return this.balance(p[0]).then(hx);
      case 'eth_getTransactionCount':
        return this.vm.stateManager.getAccount(createAddressFromString(p[0])).then((a) => hx(a?.nonce ?? 0n));
      case 'eth_getCode':
        return this.vm.stateManager.getCode(createAddressFromString(p[0])).then((c) => bytesToHex(c));
      case 'eth_getStorageAt':
        return this.vm.stateManager
          .getStorage(createAddressFromString(p[0]), hexToBytes(`0x${BigInt(p[1]).toString(16).padStart(64, '0')}`))
          .then((v) => `0x${bytesToHex(v).slice(2).padStart(64, '0')}`);
      case 'eth_call': return this.rpcCall(p[0]);
      case 'eth_estimateGas': return this.estimateGas(p[0]);
      case 'eth_sendRawTransaction': return this.sendRaw(p[0]);
      case 'eth_getTransactionReceipt': return Promise.resolve(this.formatReceipt(this.receipts.get(lower(p[0]))));
      case 'eth_getTransactionByHash': return Promise.resolve(this.formatTx(this.txs.get(lower(p[0]))));
      case 'eth_getBlockByNumber': return Promise.resolve(this.formatBlock(this.blockByTag(p[0]), !!p[1]));
      case 'eth_getBlockByHash': return Promise.resolve(this.formatBlock(this.byHash.get(lower(p[0])), !!p[1]));
      case 'eth_getLogs': return Promise.resolve(this.getLogs(p[0] ?? {}));
      case 'anvil_setBalance': return this.setBalance(p[0], BigInt(p[1])).then(() => null);
      case 'evm_increaseTime': return this.increaseTime(Number(p[0])).then(() => hx(Number(p[0])));
      case 'evm_mine': return this.increaseTime(0).then(() => '0x0');
      default: return Promise.reject(new RpcError(-32601, `method ${method} is not supported by the mock EVM`));
    }
  }

  private blockByTag(tag: unknown): StoredBlock | undefined {
    if (tag === undefined || tag === 'latest' || tag === 'pending' || tag === 'safe' || tag === 'finalized') return this.latest;
    if (tag === 'earliest') return this.blocks[0];
    return this.blocks[Number(BigInt(tag as string))];
  }

  private feeHistory(count: number) {
    const n = Math.max(1, Math.min(count, this.blocks.length));
    return {
      oldestBlock: hx(this.latest.number - n + 1),
      baseFeePerGas: Array.from({ length: n + 1 }, () => hx(BASE_FEE)),
      gasUsedRatio: Array.from({ length: n }, () => 0.1),
      reward: Array.from({ length: n }, () => [hx(PRIORITY_FEE)]),
    };
  }

  private async rpcCall(c: { from?: string; to?: string; data?: string; input?: string; value?: string; gas?: string }): Promise<Hex> {
    const r = await this.call({ from: c.from, to: c.to, data: c.data ?? c.input, value: toBig(c.value), gas: c.gas ? BigInt(c.gas) : undefined });
    if (!r.ok) throw new RpcError(3, 'execution reverted', r.returnValue);
    return r.returnValue;
  }

  private async estimateGas(c: { from?: string; to?: string; data?: string; input?: string; value?: string }): Promise<Hex> {
    const data = c.data ?? c.input ?? '0x';
    const r = await this.call({ from: c.from, to: c.to, data, value: toBig(c.value) });
    if (!r.ok) throw new RpcError(3, 'execution reverted', r.returnValue);
    // Intrinsic gas (21000, calldata, creation) plus what the call used, with room for the 63/64 rule and refunds.
    const bytes = hexToBytes(data as PrefixedHexString);
    let intrinsic = 21_000n + (c.to ? 0n : 32_000n);
    for (const b of bytes) intrinsic += b === 0 ? 4n : 16n;
    const est = ((intrinsic + r.gasUsed) * 13n) / 10n + 25_000n;
    return hx(est > BLOCK_GAS_LIMIT ? BLOCK_GAS_LIMIT : est);
  }

  private getLogs(f: { address?: string | string[]; topics?: Array<string | string[] | null>; fromBlock?: string; toBlock?: string; blockHash?: string }) {
    const from = f.blockHash ? this.byHash.get(lower(f.blockHash))?.number ?? -1 : this.blockByTag(f.fromBlock ?? 'latest')?.number ?? 0;
    const to = f.blockHash ? from : this.blockByTag(f.toBlock ?? 'latest')?.number ?? this.latest.number;
    const addrs = f.address === undefined ? undefined : (Array.isArray(f.address) ? f.address : [f.address]).map(lower);
    const out: unknown[] = [];
    for (let n = Math.max(0, from); n <= to && n < this.blocks.length; n++) {
      for (const h of this.blocks[n].txs) {
        const rc = this.receipts.get(h);
        if (!rc || rc.status !== 1) continue;
        for (const l of rc.logs) {
          if (addrs && !addrs.includes(l.address)) continue;
          const topicsOk = (f.topics ?? []).every((want, i) => {
            if (want === null || want === undefined) return true;
            const set = (Array.isArray(want) ? want : [want]).map(lower);
            return l.topics[i] !== undefined && set.includes(lower(l.topics[i]));
          });
          if (topicsOk) out.push(this.formatLog(l, rc));
        }
      }
    }
    return out;
  }

  private formatLog(l: StoredLog, rc: StoredReceipt) {
    return {
      address: l.address, topics: l.topics, data: l.data, logIndex: hx(l.logIndex), transactionIndex: hx(rc.transactionIndex),
      transactionHash: rc.transactionHash, blockHash: rc.blockHash, blockNumber: hx(rc.blockNumber), removed: false,
    };
  }

  private formatReceipt(rc?: StoredReceipt) {
    if (!rc) return null;
    return {
      transactionHash: rc.transactionHash, transactionIndex: hx(rc.transactionIndex), blockHash: rc.blockHash, blockNumber: hx(rc.blockNumber),
      from: rc.from, to: rc.to, contractAddress: rc.contractAddress, status: hx(rc.status), gasUsed: hx(rc.gasUsed),
      cumulativeGasUsed: hx(rc.cumulativeGasUsed), effectiveGasPrice: hx(rc.effectiveGasPrice), logs: rc.logs.map((l) => this.formatLog(l, rc)),
      logsBloom: rc.logsBloom, type: hx(rc.type),
    };
  }

  private formatTx(t?: StoredTx) {
    if (!t) return null;
    return {
      hash: t.hash, from: t.from, to: t.to, nonce: hx(t.nonce), value: hx(t.value), input: t.input, gas: hx(t.gas), type: hx(t.type),
      ...(t.maxFeePerGas !== undefined ? { maxFeePerGas: hx(t.maxFeePerGas), maxPriorityFeePerGas: hx(t.maxPriorityFeePerGas ?? 0n), gasPrice: hx(BASE_FEE) } : { gasPrice: hx(t.gasPrice ?? BASE_FEE) }),
      v: hx(t.v ?? 0n), r: hx(t.r ?? 0n), s: hx(t.s ?? 0n), chainId: hx(t.chainId ?? BigInt(this.chainId)), accessList: [],
      blockNumber: hx(t.blockNumber), blockHash: t.blockHash, transactionIndex: hx(t.transactionIndex),
    };
  }

  private formatBlock(b: StoredBlock | undefined, full: boolean) {
    if (!b) return null;
    return {
      number: hx(b.number), hash: b.hash, parentHash: b.parentHash, timestamp: hx(b.timestamp), gasLimit: hx(BLOCK_GAS_LIMIT), gasUsed: hx(b.gasUsed),
      baseFeePerGas: hx(BASE_FEE), miner: COINBASE.toString(), difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x0',
      nonce: '0x0000000000000000', mixHash: ZERO_HASH, sha3Uncles: ZERO_HASH, logsBloom: EMPTY_BLOOM, stateRoot: ZERO_HASH,
      receiptsRoot: ZERO_HASH, transactionsRoot: ZERO_HASH, uncles: [], withdrawals: [], withdrawalsRoot: ZERO_HASH,
      blobGasUsed: '0x0', excessBlobGas: '0x0', parentBeaconBlockRoot: ZERO_HASH,
      transactions: full ? b.txs.map((h) => this.formatTx(this.txs.get(h))) : b.txs,
    };
  }
}

export { GENESIS_BALANCE };
export type { Address };
