import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EsploraClient } from '../../src/btc/esplora.js';
import { buildFundingTx } from '../../src/btc/funding.js';
import { p2wshAddress, witnessScript } from '../../src/btc/script.js';
import {
  buildEscrowSpend, extractTx, finalizeEscrowInput, psbtFromBase64, psbtToBase64, signEscrowInput, type SpendPath,
} from '../../src/btc/spend.js';
import { escrowPubkeyFromXpub, KeySet } from '../../src/keys/derive.js';
import { LAB_MNEMONICS } from '../../src/testing/world.js';
import { newOrderId } from '../../src/util/bytes.js';
import { BitcoindRpc, startEsploraShim } from '../../src/testing/bitcoind.js';
import { ENV, skipReason } from './env.js';

const skip = skipReason(['bitcoind']);
if (skip) console.warn(`[btc.it] skipped: ${skip}`);

const user = KeySet.fromMnemonic(LAB_MNEMONICS['user-1']);
const shopper = KeySet.fromMnemonic(LAB_MNEMONICS['shopper-1']);
const escrow = KeySet.fromMnemonic(LAB_MNEMONICS['escrow-1']);
const BURN = KeySet.fromMnemonic(LAB_MNEMONICS['faucet']).btcWallet.address;

describe.skipIf(!!skip)('BTC escrow on bitcoind signet (§5)', () => {
  let rpc: BitcoindRpc;
  let chain: EsploraClient;
  let close: () => void;

  beforeAll(async () => {
    rpc = new BitcoindRpc(ENV.bitcoind!);
    await rpc.waitReady();
    const shim = await startEsploraShim(rpc);
    close = () => shim.server.close();
    chain = new EsploraClient(shim.url);
    // Coinbase to the user wallet, then 100 blocks so it matures.
    await rpc.mine(3, user.btcWallet.address);
    await rpc.mine(100, BURN);
  }, 180_000);

  afterAll(() => close?.());

  /** Fund a fresh escrow output for a new order; returns everything a spend needs. */
  async function fundOrder(tlOffsets = { t1: 3, t2: 6 }) {
    const orderId = newOrderId();
    const tip = await chain.tipHeight();
    const keys = {
      user: user.orderKey(orderId).publicKey,
      shopper: shopper.orderKey(orderId).publicKey,
      escrow: escrowPubkeyFromXpub(escrow.escrowXpub, orderId),
    };
    const t1 = tip + tlOffsets.t1;
    const t2 = tip + tlOffsets.t2;
    const script = witnessScript(keys, t1, t2);
    const lock = 89_600n;
    const funding = buildFundingTx({
      wallet: user.btcWallet,
      utxos: await chain.utxos(user.btcWallet.address),
      outputs: [{ address: p2wshAddress(script), amount: lock }, { address: escrow.btcWallet.address, amount: 1000n }],
      feeRate: 2,
    });
    expect(await chain.broadcast(funding.hex)).toBe(funding.txid);
    await rpc.mine(1, BURN);
    expect((await chain.txStatus(funding.txid)).confirmed).toBe(true);
    return { orderId, keys, script, t1, t2, outpoint: { txid: funding.txid, vout: 0, amount: lock } };
  }

  async function spend(o: Awaited<ReturnType<typeof fundOrder>>, path: SpendPath, signers: Uint8Array[], outputs: Array<{ address: string; amount: bigint }>, lockTime?: number) {
    let tx = buildEscrowSpend({ outpoint: o.outpoint, witnessScript: o.script, outputs, lockTime });
    for (const k of signers) {
      // hand the PSBT around as the parties would
      tx = psbtFromBase64(psbtToBase64(tx));
      signEscrowInput(tx, k);
    }
    finalizeEscrowInput(tx, o.keys, path);
    return extractTx(tx);
  }

  it('release: user + shopper 2-of-3 (sigs in U,S order), fee = payout_fee_reserve', async () => {
    const o = await fundOrder();
    const { hex, txid } = await spend(o, 'multisig', [user.orderKey(o.orderId).privateKey, shopper.orderKey(o.orderId).privateKey], [
      { address: shopper.btcWallet.address, amount: 88_600n },
    ]);
    expect(await chain.broadcast(hex)).toBe(txid);
    await rpc.mine(1, BURN);
    expect((await chain.txStatus(txid)).confirmed).toBe(true);
  });

  it('ruling: escrow signs first, user countersigns; three outputs', async () => {
    const o = await fundOrder();
    const { hex, txid } = await spend(o, 'multisig', [escrow.escrowOrderKey(o.orderId).privateKey, user.orderKey(o.orderId).privateKey], [
      { address: user.btcWallet.address, amount: 40_000n },
      { address: shopper.btcWallet.address, amount: 46_600n },
      { address: escrow.btcWallet.address, amount: 2_000n },
    ]);
    expect(await chain.broadcast(hex)).toBe(txid);
    await rpc.mine(1, BURN);
    expect((await chain.txStatus(txid)).confirmed).toBe(true);
  });

  it('T1: shopper alone, only once the height reaches T1', async () => {
    const o = await fundOrder({ t1: 4, t2: 8 });
    const out = [{ address: shopper.btcWallet.address, amount: 88_600n }];
    const early = await spend(o, 'shopper-after-t1', [shopper.orderKey(o.orderId).privateKey], out, o.t1);
    await expect(chain.broadcast(early.hex)).rejects.toThrow(/non-final|locktime/i);
    const tip = await chain.tipHeight();
    await rpc.mine(o.t1 - tip, BURN);
    expect(await chain.broadcast(early.hex)).toBe(early.txid);
    await rpc.mine(1, BURN);
    expect((await chain.txStatus(early.txid)).confirmed).toBe(true);
  });

  it('T2: user alone after T2; the shopper-only witness is rejected on the user branch', async () => {
    const o = await fundOrder({ t1: 2, t2: 5 });
    const tip = await chain.tipHeight();
    await rpc.mine(o.t2 - tip, BURN);
    // shopper key on the T2 branch must fail script verification
    const out = [{ address: user.btcWallet.address, amount: 88_600n }];
    const wrong = buildEscrowSpend({ outpoint: o.outpoint, witnessScript: o.script, outputs: out, lockTime: o.t2 });
    signEscrowInput(wrong, shopper.orderKey(o.orderId).privateKey);
    finalizeEscrowInput(wrong, { ...o.keys, user: o.keys.shopper }, 'user-after-t2');
    await expect(chain.broadcast(extractTx(wrong).hex)).rejects.toThrow(/script|signature/i);
    const ok = await spend(o, 'user-after-t2', [user.orderKey(o.orderId).privateKey], out, o.t2);
    expect(await chain.broadcast(ok.hex)).toBe(ok.txid);
    await rpc.mine(1, BURN);
    expect((await chain.txStatus(ok.txid)).confirmed).toBe(true);
  });
});
