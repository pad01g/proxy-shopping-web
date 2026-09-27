import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, keccak256, parseAbiItem, parseEventLogs,
  type Chain, type Hex, type PrivateKeyAccount, type PublicClient, type Transport, type WalletClient,
} from 'viem';
import { erc20Abi, psBondAbi, psEscrowModuleAbi, safeAbi, safeProxyFactoryAbi } from './abi.js';
import type { Deployments } from './deployments.js';
import { safeInitializer, safeSaltNonce, type SafeParams } from './safe.js';
import { packSignatures, type SafeTx } from './safetx.js';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** A transaction signed locally: its hash is known before it is sent, so it can be persisted first. */
export interface SignedTx {
  hash: Hex;
  raw: Hex;
}

export function evmChain(chainId: number, rpc: string): Chain {
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

/** On-chain actions for one account (§6). All writes wait for the receipt. */
export class EvmClient {
  readonly public: PublicClient<Transport, Chain>;
  readonly wallet: WalletClient<Transport, Chain, PrivateKeyAccount>;
  private creationCode?: Hex;

  constructor(
    readonly chainId: number,
    rpc: string,
    readonly account: PrivateKeyAccount,
    readonly deployments: Deployments,
  ) {
    const chain = evmChain(chainId, rpc);
    // No CCIP-Read (EIP-3668): a contract we call must never make the client fetch arbitrary URLs.
    this.public = createPublicClient({ chain, transport: http(rpc), ccipRead: false });
    this.wallet = createWalletClient({ chain, transport: http(rpc), account, ccipRead: false });
  }

  get address(): `0x${string}` {
    return this.account.address;
  }

  /** Wait for `hash` to be mined; throws if it reverted. */
  async confirm(hash: Hex): Promise<Hex> {
    const receipt = await this.public.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
    return hash;
  }

  private send(hash: Hex): Promise<Hex> {
    return this.confirm(hash);
  }

  /** true / false for a mined tx, undefined when the node does not know it (yet). */
  async receiptOk(hash: Hex): Promise<boolean | undefined> {
    try {
      return (await this.public.getTransactionReceipt({ hash })).status === 'success';
    } catch {
      return undefined;
    }
  }

  async ethBalance(address: `0x${string}` = this.address): Promise<bigint> {
    return this.public.getBalance({ address });
  }

  async usdcBalance(address: `0x${string}` = this.address): Promise<bigint> {
    return this.public.readContract({ address: this.deployments.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
  }

  async blockTimestamp(): Promise<bigint> {
    return (await this.public.getBlock()).timestamp;
  }

  /** proxyCreationCode read from the factory (cached). */
  async proxyCreationCode(): Promise<Hex> {
    return (this.creationCode ??= await this.public.readContract({
      address: this.deployments.safe.factory,
      abi: safeProxyFactoryAbi,
      functionName: 'proxyCreationCode',
    }));
  }

  async isDeployed(address: `0x${string}`): Promise<boolean> {
    const code = await this.public.getCode({ address });
    return !!code && code !== '0x';
  }

  /**
   * Sign a call with our key without sending it. Persisting the result before `sendSigned` means a crash
   * (or another tab taking over) between signing and sending can never lead to a second, different payment.
   */
  async signCall(to: `0x${string}`, data: Hex): Promise<SignedTx> {
    const request = await this.wallet.prepareTransactionRequest({ to, data, account: this.account, chain: this.wallet.chain });
    const raw = await this.wallet.signTransaction(request as Parameters<typeof this.wallet.signTransaction>[0]);
    return { hash: keccak256(raw), raw };
  }

  /** Broadcast a signed transaction; a node that already has it is fine (same hash). */
  async sendSigned(tx: SignedTx): Promise<Hex> {
    try {
      await this.public.sendRawTransaction({ serializedTransaction: tx.raw });
    } catch (err) {
      if (!(await this.knowsTx(tx.hash))) throw err;
    }
    return tx.hash;
  }

  /** Whether the node has `hash` mined or in its pool. */
  async knowsTx(hash: Hex): Promise<boolean> {
    return this.public.getTransaction({ hash }).then(() => true, () => false);
  }

  /** Sign, hand the signed tx to `onSigned` (to persist it), send and wait for the receipt. */
  private async signAndSend(to: `0x${string}`, data: Hex, onSigned?: (tx: SignedTx) => Promise<void>): Promise<Hex> {
    const tx = await this.signCall(to, data);
    await onSigned?.(tx);
    return this.send(await this.sendSigned(tx));
  }

  /**
   * createProxyWithNonce(singleton, initializer, saltNonce); returns the tx hash once mined.
   * `onSigned` receives the signed tx before it is sent, so callers can persist it (a retry must not resend a new one).
   */
  async deploySafe(p: SafeParams, onSigned?: (tx: SignedTx) => Promise<void>): Promise<Hex> {
    const data = encodeFunctionData({
      abi: safeProxyFactoryAbi,
      functionName: 'createProxyWithNonce',
      args: [this.deployments.safe.singleton, safeInitializer(this.deployments, p), safeSaltNonce(p.orderId)],
    });
    return this.signAndSend(this.deployments.safe.factory, data, onSigned);
  }

  async transferUsdc(to: `0x${string}`, amount: bigint, onSigned?: (tx: SignedTx) => Promise<void>): Promise<Hex> {
    return this.signAndSend(this.deployments.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }), onSigned);
  }

  /** A successful USDC transfer from → to of at least `minAmount` in the last `lookback` blocks. */
  async findUsdcTransfer(from: `0x${string}`, to: `0x${string}`, minAmount: bigint, lookback = 10_000n): Promise<Hex | undefined> {
    const latest = await this.public.getBlockNumber();
    const logs = await this.public.getLogs({
      address: this.deployments.usdc,
      event: TRANSFER_EVENT,
      args: { from, to },
      fromBlock: latest > lookback ? latest - lookback : 0n,
      toBlock: latest,
    });
    return logs.find((l) => (l.args.value ?? 0n) >= minAmount)?.transactionHash ?? undefined;
  }

  /** Owners, threshold, module registration, nonce and USDC balance of a Safe (§4.7 checks). */
  async safeState(safe: `0x${string}`) {
    const read = <T>(functionName: 'getOwners' | 'getThreshold' | 'nonce') =>
      this.public.readContract({ address: safe, abi: safeAbi, functionName }) as Promise<T>;
    const [owners, threshold, nonce, moduleEnabled, config, balance] = await Promise.all([
      read<readonly `0x${string}`[]>('getOwners'),
      read<bigint>('getThreshold'),
      read<bigint>('nonce'),
      this.public.readContract({ address: safe, abi: safeAbi, functionName: 'isModuleEnabled', args: [this.deployments.module] }),
      this.moduleConfig(safe),
      this.usdcBalance(safe),
    ]);
    return { owners: [...owners], threshold, nonce, moduleEnabled, config, balance };
  }

  async safeNonce(safe: `0x${string}`): Promise<bigint> {
    return this.public.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' });
  }

  async execSafeTx(safe: `0x${string}`, tx: SafeTx, sigs: Array<{ signer: `0x${string}`; signature: Hex }>): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: safe,
      abi: safeAbi,
      functionName: 'execTransaction',
      args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, packSignatures(sigs)],
    });
    await this.send(hash);
    // Safe does not revert on inner failure; it emits ExecutionFailure.
    const receipt = await this.public.getTransactionReceipt({ hash });
    const failed = parseEventLogs({ abi: safeAbi, logs: receipt.logs, eventName: 'ExecutionFailure' });
    if (failed.length) throw new Error(`Safe execution failed in ${hash}`);
    return hash;
  }

  async refundToUser(safe: `0x${string}`): Promise<Hex> {
    return this.send(await this.wallet.writeContract({ address: this.deployments.module, abi: psEscrowModuleAbi, functionName: 'refundToUser', args: [safe] }));
  }

  async claimByShopper(safe: `0x${string}`): Promise<Hex> {
    return this.send(await this.wallet.writeContract({ address: this.deployments.module, abi: psEscrowModuleAbi, functionName: 'claimByShopper', args: [safe] }));
  }

  async moduleConfig(safe: `0x${string}`) {
    const [token, user, shopper, t1, t2] = await this.public.readContract({
      address: this.deployments.module, abi: psEscrowModuleAbi, functionName: 'config', args: [safe],
    });
    return { token, user, shopper, t1, t2 };
  }

  /** USDC Transfer events in the receipt of `txHash`; none for a reverted transaction. */
  async usdcTransfers(txHash: Hex): Promise<Array<{ from: `0x${string}`; to: `0x${string}`; value: bigint }>> {
    const receipt = await this.public.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') return [];
    return parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: 'Transfer' })
      .filter((l) => l.address.toLowerCase() === this.deployments.usdc.toLowerCase())
      .map((l) => ({ from: l.args.from, to: l.args.to, value: l.args.value }));
  }

  /**
   * Sum of USDC Transfer events to `to` (and, when given, from `from`) in the receipt of `txHash`
   * (used to verify fee payments, §4.6).
   */
  async usdcTransferredIn(txHash: Hex, to: `0x${string}`, from?: `0x${string}`): Promise<bigint> {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    return (await this.usdcTransfers(txHash))
      .filter((t) => same(t.to, to) && (!from || same(t.from, from)))
      .reduce((s, t) => s + t.value, 0n);
  }

  /** Sum of USDC transferred out of `from` in the receipt of `txHash` (settlement check, §4.8). */
  async usdcTransferredFrom(txHash: Hex, from: `0x${string}`): Promise<bigint> {
    return (await this.usdcTransfers(txHash)).filter((t) => t.from.toLowerCase() === from.toLowerCase()).reduce((s, t) => s + t.value, 0n);
  }

  // ---- optional bond example (contracts/examples/bond) ----

  private get bond(): `0x${string}` {
    if (!this.deployments.bond) throw new Error('no bond contract in deployments');
    return this.deployments.bond;
  }

  async bondDeposit(amount: bigint): Promise<Hex> {
    await this.send(await this.wallet.writeContract({ address: this.deployments.usdc, abi: erc20Abi, functionName: 'approve', args: [this.bond, amount] }));
    return this.send(await this.wallet.writeContract({ address: this.bond, abi: psBondAbi, functionName: 'deposit', args: [amount] }));
  }

  async bondSlash(escrow: `0x${string}`, to: `0x${string}`, amount: bigint): Promise<Hex> {
    return this.send(await this.wallet.writeContract({ address: this.bond, abi: psBondAbi, functionName: 'slash', args: [escrow, to, amount] }));
  }

  async bondOf(escrow: `0x${string}`): Promise<bigint> {
    return this.public.readContract({ address: this.bond, abi: psBondAbi, functionName: 'bondOf', args: [escrow] });
  }
}
