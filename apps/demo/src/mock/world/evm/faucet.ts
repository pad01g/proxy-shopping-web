/**
 * The lab faucet's EVM side (proxy-shopping-go/node/cmd/labfaucet): ETH through anvil_setBalance (added to the
 * current balance), USDC through MockUSDC.mint in a transaction signed by the faucet account.
 */
import type { Deployments } from '@proxy-shopping/core/browser';
import { createWalletClient, custom, defineChain, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { MockEvm } from './evm';
import { FAUCET_PRIVATE_KEY } from './genesis';

const mintAbi = parseAbi(['function mint(address to, uint256 value)']);

export class EvmFaucet {
  private readonly wallet;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly evm: MockEvm,
    private readonly d: Deployments,
  ) {
    const chain = defineChain({
      id: evm.chainId, name: `chain-${evm.chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['http://in-process.invalid'] } },
    });
    this.wallet = createWalletClient({
      chain,
      account: privateKeyToAccount(FAUCET_PRIVATE_KEY),
      transport: custom({ request: (a) => evm.request(a as { method: string; params?: unknown[] }) }),
      pollingInterval: 50,
    });
  }

  /** Add `eth` wei and mint `usdc` base units to `address`. */
  fund(address: string, amounts: { eth: bigint; usdc: bigint }): Promise<{ usdcTx?: Hex }> {
    const run = this.queue.then(async () => {
      if (amounts.eth > 0n) await this.evm.addBalance(address, amounts.eth);
      if (amounts.usdc <= 0n) return {};
      const usdcTx = await this.wallet.writeContract({ address: this.d.usdc, abi: mintAbi, functionName: 'mint', args: [address as Hex, amounts.usdc] });
      return { usdcTx };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
