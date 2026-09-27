import {
  createPublicClient, createWalletClient, defineChain, http, parseEventLogs,
  type Chain, type Hex, type PrivateKeyAccount, type PublicClient, type Transport, type WalletClient,
} from 'viem';
import { erc20Abi, psBondAbi, psEscrowModuleAbi, safeAbi, safeProxyFactoryAbi } from './abi.js';
import type { Deployments } from './deployments.js';
import { safeInitializer, safeSaltNonce, type SafeParams } from './safe.js';
import { packSignatures, type SafeTx } from './safetx.js';

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
    this.public = createPublicClient({ chain, transport: http(rpc) });
    this.wallet = createWalletClient({ chain, transport: http(rpc), account });
  }

  get address(): `0x${string}` {
    return this.account.address;
  }

  private async send(hash: Hex): Promise<Hex> {
    const receipt = await this.public.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
    return hash;
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

  /** createProxyWithNonce(singleton, initializer, saltNonce); returns the tx hash. */
  async deploySafe(p: SafeParams): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.deployments.safe.factory,
      abi: safeProxyFactoryAbi,
      functionName: 'createProxyWithNonce',
      args: [this.deployments.safe.singleton, safeInitializer(this.deployments, p), safeSaltNonce(p.orderId)],
    });
    return this.send(hash);
  }

  async transferUsdc(to: `0x${string}`, amount: bigint): Promise<Hex> {
    const hash = await this.wallet.writeContract({ address: this.deployments.usdc, abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
    return this.send(hash);
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

  /** Sum of USDC Transfer events to `to` in the receipt of `txHash` (used to verify fee payments). */
  async usdcTransferredIn(txHash: Hex, to: `0x${string}`): Promise<bigint> {
    const receipt = await this.public.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') return 0n;
    const logs = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: 'Transfer' });
    return logs
      .filter((l) => l.address.toLowerCase() === this.deployments.usdc.toLowerCase() && l.args.to.toLowerCase() === to.toLowerCase())
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
