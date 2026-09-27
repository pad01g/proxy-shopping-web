import { beforeAll, describe, expect, it } from 'vitest';
import { safeAbi } from '../../src/evm/abi.js';
import type { EvmClient } from '../../src/evm/chain.js';
import { SAFE_PROXY_CREATION_CODE } from '../../src/evm/proxy-creation-code.js';
import { orderSafeAddress } from '../../src/evm/safe.js';
import { releaseSafeTx, safeTxHash, signSafeTx, splitSafeTx } from '../../src/evm/safetx.js';
import { KeySet } from '../../src/keys/derive.js';
import { LAB_MNEMONICS } from '../../src/testing/world.js';
import { newOrderId } from '../../src/util/bytes.js';
import { fundedEvm, increaseTime } from './anvil.js';
import { ENV, loadDeployments, skipReason } from './env.js';

const d = loadDeployments();
const skip = skipReason(['anvil']) ?? (d ? undefined : `no deployments file (${ENV.deploymentsFile ?? 'DEPLOYMENTS unset'}); contracts not deployed`);
if (skip) console.warn(`[evm.it] skipped: ${skip}`);

const K = {
  user: KeySet.fromMnemonic(LAB_MNEMONICS['user-1']),
  shopper: KeySet.fromMnemonic(LAB_MNEMONICS['shopper-1']),
  escrow: KeySet.fromMnemonic(LAB_MNEMONICS['escrow-1']),
  operator: KeySet.fromMnemonic(LAB_MNEMONICS['operator-1']),
};

describe.skipIf(!!skip)('USDC escrow on anvil (§6)', () => {
  let user: EvmClient;
  let shopper: EvmClient;
  let escrow: EvmClient;
  let operator: EvmClient;

  beforeAll(async () => {
    user = await fundedEvm(ENV.anvil!, d!, K.user);
    shopper = await fundedEvm(ENV.anvil!, d!, K.shopper, 0n);
    escrow = await fundedEvm(ENV.anvil!, d!, K.escrow);
    operator = await fundedEvm(ENV.anvil!, d!, K.operator, 0n);
  }, 60_000);

  /** Deploy and fund a Safe for a new order, as UserClient.fund does. */
  async function fundedSafe(t: { t1: number; t2: number }, lock = 36_750_000n) {
    const orderId = newOrderId();
    const params = { user: K.user.evmAddress, shopper: K.shopper.evmAddress, escrow: K.escrow.evmAddress, t1: BigInt(t.t1), t2: BigInt(t.t2), orderId };
    const predicted = orderSafeAddress(d!, params, await user.proxyCreationCode());
    await user.deploySafe(params);
    expect(await user.isDeployed(predicted)).toBe(true);
    await user.transferUsdc(predicted, lock);
    return { orderId, safe: predicted, lock };
  }

  it('factory proxyCreationCode equals the embedded constant', async () => {
    expect(await user.proxyCreationCode()).toBe(SAFE_PROXY_CREATION_CODE);
  });

  it('deploys the Safe at the offline-predicted address with owners, threshold and module', async () => {
    const now = Number(await user.blockTimestamp());
    const { safe } = await fundedSafe({ t1: now + 3600, t2: now + 7200 });
    const owners = await user.public.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' });
    expect(owners).toEqual([K.user.evmAddress, K.shopper.evmAddress, K.escrow.evmAddress]);
    expect(await user.public.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' })).toBe(2n);
    expect(await user.public.readContract({ address: safe, abi: safeAbi, functionName: 'isModuleEnabled', args: [d!.module] })).toBe(true);
    expect(await user.moduleConfig(safe)).toMatchObject({ token: d!.usdc, user: K.user.evmAddress, shopper: K.shopper.evmAddress });
  });

  it('release: our EIP-712 hash equals getTransactionHash; shopper executes with sorted sigs', async () => {
    const now = Number(await user.blockTimestamp());
    const { safe, lock } = await fundedSafe({ t1: now + 3600, t2: now + 7200 });
    const tx = releaseSafeTx({ usdc: d!.usdc, to: K.shopper.evmAddress, amount: lock });
    const onChain = await user.public.readContract({
      address: safe, abi: safeAbi, functionName: 'getTransactionHash',
      args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce],
    });
    expect(safeTxHash(tx, d!.chain_id, safe)).toBe(onChain);
    const before = await shopper.usdcBalance();
    const userSig = await signSafeTx(K.user.evmAccount, tx, d!.chain_id, safe);
    const shopperSig = await signSafeTx(K.shopper.evmAccount, tx, d!.chain_id, safe);
    await shopper.execSafeTx(safe, tx, [{ signer: K.user.evmAddress, signature: userSig }, { signer: K.shopper.evmAddress, signature: shopperSig }]);
    expect((await shopper.usdcBalance()) - before).toBe(lock);
    expect(await shopper.usdcBalance(safe)).toBe(0n);
  });

  it('ruling: MultiSendCallOnly delegatecall split signed by escrow + user', async () => {
    const now = Number(await user.blockTimestamp());
    const { safe } = await fundedSafe({ t1: now + 3600, t2: now + 7200 }, 30_000_000n);
    const tx = splitSafeTx({
      usdc: d!.usdc,
      multiSend: d!.safe.multisend_call_only,
      payouts: [
        { to: K.user.evmAddress, amount: 10_000_000n },
        { to: K.shopper.evmAddress, amount: 19_400_000n },
        { to: K.escrow.evmAddress, amount: 600_000n },
      ],
    });
    const balances = async () => Promise.all([K.user, K.shopper, K.escrow].map((k) => user.usdcBalance(k.evmAddress)));
    const before = await balances();
    await user.execSafeTx(safe, tx, [
      { signer: K.escrow.evmAddress, signature: await signSafeTx(K.escrow.evmAccount, tx, d!.chain_id, safe) },
      { signer: K.user.evmAddress, signature: await signSafeTx(K.user.evmAccount, tx, d!.chain_id, safe) },
    ]);
    const after = await balances();
    expect(after.map((b, i) => b - before[i])).toEqual([10_000_000n, 19_400_000n, 600_000n]);
  });

  it('rejects a single signature', async () => {
    const now = Number(await user.blockTimestamp());
    const { safe, lock } = await fundedSafe({ t1: now + 3600, t2: now + 7200 });
    const tx = releaseSafeTx({ usdc: d!.usdc, to: K.shopper.evmAddress, amount: lock });
    const sig = await signSafeTx(K.user.evmAccount, tx, d!.chain_id, safe);
    await expect(shopper.execSafeTx(safe, tx, [{ signer: K.user.evmAddress, signature: sig }])).rejects.toThrow();
  });

  it('timelocks: claimByShopper after T1, refundToUser after T2', async () => {
    const now = Number(await user.blockTimestamp());
    const a = await fundedSafe({ t1: now + 100, t2: now + 200 });
    const b = await fundedSafe({ t1: now + 100, t2: now + 200 });
    await expect(shopper.claimByShopper(a.safe)).rejects.toThrow();
    await expect(user.refundToUser(b.safe)).rejects.toThrow();
    await increaseTime(ENV.anvil!, 150);
    const s0 = await shopper.usdcBalance();
    await shopper.claimByShopper(a.safe);
    expect((await shopper.usdcBalance()) - s0).toBe(a.lock);
    await expect(user.refundToUser(b.safe)).rejects.toThrow(); // still before T2
    await expect(escrow.refundToUser(b.safe)).rejects.toThrow(); // wrong caller
    await increaseTime(ENV.anvil!, 100);
    const u0 = await user.usdcBalance();
    await user.refundToUser(b.safe);
    expect((await user.usdcBalance()) - u0).toBe(b.lock);
  });

  it.skipIf(!d?.bond)('bond example: escrow deposits, operator slashes to the user', async () => {
    await escrow.bondDeposit(5_000_000n);
    expect(await escrow.bondOf(K.escrow.evmAddress)).toBeGreaterThanOrEqual(5_000_000n);
    const u0 = await user.usdcBalance();
    await operator.bondSlash(K.escrow.evmAddress, K.user.evmAddress, 2_000_000n);
    expect((await user.usdcBalance()) - u0).toBe(2_000_000n);
    await expect(user.bondSlash(K.escrow.evmAddress, K.user.evmAddress, 1n)).rejects.toThrow();
  });
});
