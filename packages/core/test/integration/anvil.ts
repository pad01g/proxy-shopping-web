import { createPublicClient, http, numberToHex, type PublicClient } from 'viem';
import { erc20Abi } from '../../src/evm/abi.js';
import { EvmClient } from '../../src/evm/chain.js';
import type { Deployments } from '../../src/evm/deployments.js';
import type { KeySet } from '../../src/keys/derive.js';

export function anvilClient(rpc: string): PublicClient {
  return createPublicClient({ transport: http(rpc) });
}

/** Give `keys` ETH (anvil_setBalance) and mint MockUSDC, returning a ready EvmClient. */
export async function fundedEvm(rpc: string, d: Deployments, keys: KeySet, usdc = 1_000_000_000n): Promise<EvmClient> {
  const pub = anvilClient(rpc);
  await pub.request({ method: 'anvil_setBalance' as never, params: [keys.evmAddress, numberToHex(10n ** 20n)] as never });
  const evm = new EvmClient(d.chain_id, rpc, keys.evmAccount, d);
  if (usdc > 0n) {
    const hash = await evm.wallet.writeContract({ address: d.usdc, abi: erc20Abi, functionName: 'mint', args: [keys.evmAddress, usdc] });
    await evm.public.waitForTransactionReceipt({ hash });
  }
  return evm;
}

export async function increaseTime(rpc: string, seconds: number): Promise<void> {
  const pub = anvilClient(rpc);
  await pub.request({ method: 'evm_increaseTime' as never, params: [numberToHex(seconds)] as never });
  await pub.request({ method: 'evm_mine' as never, params: [] as never });
}
