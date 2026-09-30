import { EvmClient, KeySet, releaseSafeTx, signSafeTx, orderSafeAddress, type SafeParams } from '@proxy-shopping/core';
import { custom } from 'viem';
import { describe, expect, it } from 'vitest';
import { MockEvm, type EvmOp } from './evm';
import { EvmFaucet } from './faucet';
import { LAB_DEPLOYMENTS } from './genesis';

const MNEMONIC = {
  user: 'news hybrid corn purchase public hedgehog clay survey able alter supreme shove',
  shopper: 'december art feature luxury renew grape champion meadow wage weird aunt unaware',
  escrow: 'blue salt fault plastic fault bargain word lady icon actual speed reflect',
};
const ORDER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function client(evm: MockEvm, keys: KeySet) {
  return new EvmClient(31337, custom({ request: (a) => evm.request(a as { method: string; params?: unknown[] }) }), keys.evmAccount, LAB_DEPLOYMENTS, { pollingInterval: 20 });
}

async function world(log?: EvmOp[]) {
  let saved: EvmOp[] = [];
  let clock = 1_900_000_000;
  const evm = await MockEvm.create({ chainId: 31337, now: () => clock, log, onLog: (l) => (saved = [...l]) });
  return { evm, saved: () => saved, tick: (s: number) => (clock += s) };
}

describe('MockEvm', () => {
  it('deploys the lab contracts at the addresses of deployments/31337.json', async () => {
    const { evm } = await world();
    expect(evm.genesis.deployed.module).toBe(LAB_DEPLOYMENTS.module.toLowerCase());
    expect(evm.genesis.deployed['safe.singleton']).toBe(LAB_DEPLOYMENTS.safe.singleton.toLowerCase());
    const code = (await evm.request({ method: 'eth_getCode', params: [LAB_DEPLOYMENTS.safe.factory, 'latest'] })) as string;
    expect(code.length).toBeGreaterThan(100);
  });

  it('runs a Safe order for real: deploy, fund, 2-of-3 release, module timelocks; the log replays to the same state', async () => {
    const { evm, saved, tick } = await world();
    const faucet = new EvmFaucet(evm, LAB_DEPLOYMENTS);
    const [u, s, e] = [KeySet.fromMnemonic(MNEMONIC.user), KeySet.fromMnemonic(MNEMONIC.shopper), KeySet.fromMnemonic(MNEMONIC.escrow)];
    await faucet.fund(u.evmAddress, { eth: 10n ** 18n, usdc: 1000_000000n });
    await faucet.fund(s.evmAddress, { eth: 10n ** 18n, usdc: 0n });
    const user = client(evm, u);
    const shopper = client(evm, s);
    expect(await user.usdcBalance()).toBe(1000_000000n);

    const now = BigInt(evm.latestTime());
    const p: SafeParams = { user: u.evmAddress, shopper: s.evmAddress, escrow: e.evmAddress, t1: now + 3600n, t2: now + 7200n, orderId: ORDER };
    const safe = orderSafeAddress(LAB_DEPLOYMENTS, p, await user.proxyCreationCode());
    await user.deploySafe(p);
    await user.transferUsdc(safe, 40_000000n);
    const st = await user.safeState(safe);
    expect(st.threshold).toBe(2n);
    expect(st.owners.map((o) => o.toLowerCase())).toEqual([u.evmAddress, s.evmAddress, e.evmAddress].map((a) => a.toLowerCase()));
    expect(st.moduleEnabled).toBe(true);
    expect(st.balance).toBe(40_000000n);

    // The module refuses the user before T2 (a real revert of PSEscrowModule.refundToUser).
    await expect(user.refundToUser(safe)).rejects.toThrow();

    // One signature is not enough; two owners' signatures move the money.
    const tx = releaseSafeTx({ usdc: LAB_DEPLOYMENTS.usdc, to: s.evmAddress, amount: 40_000000n, nonce: await user.safeNonce(safe) });
    const sigU = await signSafeTx(u.evmAccount, tx, 31337, safe);
    await expect(shopper.execSafeTx(safe, tx, [{ signer: u.evmAddress, signature: sigU }])).rejects.toThrow();
    const sigS = await signSafeTx(s.evmAccount, tx, 31337, safe);
    const hash = await shopper.execSafeTx(safe, tx, [{ signer: u.evmAddress, signature: sigU }, { signer: s.evmAddress, signature: sigS }]);
    expect(await shopper.usdcBalance()).toBe(40_000000n);
    expect(await shopper.usdcTransferredFrom(hash, safe)).toBe(40_000000n);
    expect(await user.findUsdcTransfer(u.evmAddress, safe, 40_000000n)).toMatch(/^0x[0-9a-f]{64}$/);

    // Time warp: after T2 the module lets the user sweep (nothing left here, but the call succeeds).
    tick(10);
    await evm.increaseTime(7300);
    expect(await user.receiptOk(await user.refundToUser(safe))).toBe(true);

    // Replay the log: same balances.
    const again = await MockEvm.create({ chainId: 31337, log: saved(), now: () => 1_900_000_000 });
    const shopper2 = client(again, s);
    expect(await shopper2.usdcBalance()).toBe(40_000000n);
    expect(again.latestTime()).toBe(evm.latestTime());
  }, 60_000);
});
