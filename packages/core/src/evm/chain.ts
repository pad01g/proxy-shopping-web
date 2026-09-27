import {
  createPublicClient, createWalletClient, defineChain, http, parseAbiItem, parseEventLogs,
  type Chain, type Hex, type PrivateKeyAccount, type PublicClient, type Transport, type WalletClient,
} from 'viem';
import { erc20Abi, psBondAbi, psEscrowModuleAbi, safeAbi, safeProxyFactoryAbi } from './abi.js';
import type { Deployments } from './deployments.js';
import { safeInitializer, safeSaltNonce, type SafeParams } from './safe.js';
import { packSignatures, type SafeTx } from './safetx.js';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

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
   * createProxyWithNonce(singleton, initializer, saltNonce); returns the tx hash once mined.
   * `onSent` receives the hash before we wait, so callers can persist it (a retry must not resend).
   */
  async deploySafe(p: SafeParams, onSent?: (hash: Hex) => Promise<void>): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.deployments.safe.factory,
      abi: safeProxyFactoryAbi,
      functionName: 'createProxyWithNonce',
      args: [this.deployments.safe.singleton, safeInitializer(this.deployments, p), safeSaltNonce(p.orderId)],
    });
    await onSent?.(hash);
    return this.send(hash);
  }

  async transferUsdc(to: `0x${string}`, amount: bigint, onSent?: (hash: Hex) => Promise<void>): Promise<Hex> {
    const hash = await this.wallet.writeContract({ address: this.deployments.usdc, abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
    await onSent?.(hash);
    return this.send(hash);
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

  /**
   * Sum of USDC Transfer events to `to` (and, when given, from `from`) in the receipt of `txHash`
   * (used to verify fee payments, §4.6).
   */
  async usdcTransferredIn(txHash: Hex, to: `0x${string}`, from?: `0x${string}`): Promise<bigint> {
    const receipt = await this.public.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') return 0n;
    const logs = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: 'Transfer' });
    return logs
      .filter((l) => l.address.toLowerCase() === this.deployments.usdc.toLowerCase() && l.args.to.toLowerCase() === to.toLowerCase())
      .filter((l) => !from || l.args.from.toLowerCase() === from.toLowerCase())
      .reduce((s, l) => s + l.args.value, 0n);
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
