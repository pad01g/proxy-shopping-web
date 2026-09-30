import {
  buildEscrowSpend, buildFundingTx, extractTx, finalizeEscrowInput, KeySet, p2wshAddress, signEscrowInput, witnessScript,
} from '@proxy-shopping/core';
import { describe, expect, it } from 'vitest';
import { MockBtcChain } from './chain';

const ORDER = '0123456789abcdef0123456789abcdef';
const keys = {
  user: KeySet.fromMnemonic('news hybrid corn purchase public hedgehog clay survey able alter supreme shove'),
  shopper: KeySet.fromMnemonic('december art feature luxury renew grape champion meadow wage weird aunt unaware'),
  escrow: KeySet.fromMnemonic('blue salt fault plastic fault bargain word lady icon actual speed reflect'),
  faucet: KeySet.fromMnemonic('defense girl explain south shine scissors view soup code talk fence town'),
};

async function funded() {
  const chain = new MockBtcChain({ faucet: keys.faucet.btcWallet, autoMineMs: 0 });
  await chain.faucetSend(keys.user.btcWallet.address, 1_000_000);
  const pk = {
    user: keys.user.orderKey(ORDER).publicKey,
    shopper: keys.shopper.orderKey(ORDER).publicKey,
    escrow: keys.escrow.orderKey(ORDER).publicKey,
  };
  const h = await chain.tipHeight();
  const t1 = h + 100;
  const t2 = h + 150;
  const script = witnessScript(pk, t1, t2);
  const fund = buildFundingTx({
    wallet: keys.user.btcWallet,
    utxos: await chain.utxos(keys.user.btcWallet.address),
    outputs: [{ address: p2wshAddress(script), amount: 300_000n }],
    feeRate: 1,
  });
  await chain.broadcast(fund.hex);
  chain.mine();
  const spend = (outputs = [{ address: keys.shopper.btcWallet.address, amount: 299_000n }], lockTime?: number) =>
    buildEscrowSpend({ outpoint: { txid: fund.txid, vout: 0, amount: 300_000n }, witnessScript: script, outputs, lockTime });
  return { chain, pk, t1, t2, fund, spend };
}

describe('MockBtcChain', () => {
  it('pays from the faucet with a verified P2WPKH transaction and tracks confirmations', async () => {
    const chain = new MockBtcChain({ faucet: keys.faucet.btcWallet, autoMineMs: 0 });
    const txid = await chain.faucetSend(keys.user.btcWallet.address, 50_000);
    const utxos = await chain.utxos(keys.user.btcWallet.address);
    expect(utxos).toEqual([{ txid, vout: 0, value: 50_000, status: { confirmed: true, block_height: 201 } }]);
    expect(chain.confirmations(txid)).toBe(1);
    chain.mine(2);
    expect(chain.confirmations(txid)).toBe(3);
    expect((await chain.txStatus(txid)).confirmed).toBe(true);
  });

  it('spends the escrow 2-of-3 only with two valid signatures, once', async () => {
    const { chain, pk, fund, spend } = await funded();
    const one = spend();
    signEscrowInput(one, keys.user.orderKey(ORDER).privateKey);
    expect(() => finalizeEscrowInput(one, pk, 'multisig')).toThrow();

    // A signature by a key that is not in the script.
    const forged = spend();
    signEscrowInput(forged, keys.user.orderKey(ORDER).privateKey);
    signEscrowInput(forged, keys.faucet.orderKey(ORDER).privateKey);
    const fk = { ...pk, shopper: keys.faucet.orderKey(ORDER).publicKey };
    finalizeEscrowInput(forged, fk, 'multisig');
    await expect(chain.broadcast(extractTx(forged).hex)).rejects.toThrow(/script-verify|signature/);

    const tx = spend();
    signEscrowInput(tx, keys.user.orderKey(ORDER).privateKey);
    signEscrowInput(tx, keys.shopper.orderKey(ORDER).privateKey);
    finalizeEscrowInput(tx, pk, 'multisig');
    const txid = await chain.broadcast(extractTx(tx).hex);
    expect(await chain.outspend(fund.txid, 0)).toMatchObject({ spent: true, txid });

    const again = spend([{ address: keys.user.btcWallet.address, amount: 299_000n }]);
    signEscrowInput(again, keys.user.orderKey(ORDER).privateKey);
    signEscrowInput(again, keys.escrow.orderKey(ORDER).privateKey);
    finalizeEscrowInput(again, pk, 'multisig');
    await expect(chain.broadcast(extractTx(again).hex)).rejects.toThrow(/spent/);
  });

  it('enforces the timelocks: T2 refund is non-final before T2 and CLTV rejects a lower nLockTime', async () => {
    const { chain, pk, t1, t2, spend } = await funded();
    const refund = (lockTime: number) => {
      const tx = spend([{ address: keys.user.btcWallet.address, amount: 299_000n }], lockTime);
      signEscrowInput(tx, keys.user.orderKey(ORDER).privateKey);
      finalizeEscrowInput(tx, pk, 'user-after-t2');
      return extractTx(tx).hex;
    };
    await expect(chain.broadcast(refund(t2))).rejects.toThrow(/non-final/);
    chain.mine(t2 - (await chain.tipHeight()));
    // The chain is past T2 now, but a transaction with nLockTime T1 must not pass the T2 branch's CLTV.
    await expect(chain.broadcast(refund(t1))).rejects.toThrow(/locktime requirement/);
    // The shopper's T1 key cannot take the user's branch.
    const wrong = spend([{ address: keys.shopper.btcWallet.address, amount: 299_000n }], t2);
    signEscrowInput(wrong, keys.shopper.orderKey(ORDER).privateKey);
    wrong.updateInput(0, { finalScriptWitness: [wrong.getInput(0).partialSig![0][1], new Uint8Array(), new Uint8Array(), wrong.getInput(0).witnessScript!] }, true);
    await expect(chain.broadcast(extractTx(wrong).hex)).rejects.toThrow(/script-verify/);
    expect(await chain.broadcast(refund(t2))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lets the shopper claim alone after T1', async () => {
    const { chain, pk, t1, spend } = await funded();
    const claim = () => {
      const tx = spend(undefined, t1);
      signEscrowInput(tx, keys.shopper.orderKey(ORDER).privateKey);
      finalizeEscrowInput(tx, pk, 'shopper-after-t1');
      return extractTx(tx).hex;
    };
    await expect(chain.broadcast(claim())).rejects.toThrow(/non-final/);
    chain.mine(t1 - (await chain.tipHeight()));
    expect(await chain.broadcast(claim())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses fees below 1 sat/vB and dust outputs', async () => {
    const { chain, pk, spend } = await funded();
    const tx = spend([{ address: keys.shopper.btcWallet.address, amount: 299_990n }]);
    signEscrowInput(tx, keys.user.orderKey(ORDER).privateKey);
    signEscrowInput(tx, keys.shopper.orderKey(ORDER).privateKey);
    finalizeEscrowInput(tx, pk, 'multisig');
    await expect(chain.broadcast(extractTx(tx).hex)).rejects.toThrow(/min relay fee/);
    const dust = spend([{ address: keys.shopper.btcWallet.address, amount: 298_000n }, { address: keys.user.btcWallet.address, amount: 100n }]);
    signEscrowInput(dust, keys.user.orderKey(ORDER).privateKey);
    signEscrowInput(dust, keys.shopper.orderKey(ORDER).privateKey);
    finalizeEscrowInput(dust, pk, 'multisig');
    await expect(chain.broadcast(extractTx(dust).hex)).rejects.toThrow(/dust/);
  });
});
