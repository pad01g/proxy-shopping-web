import { concat, encodeFunctionData, hashTypedData, keccak256, pad, recoverAddress, zeroAddress } from 'viem';
import { multiSendCallOnlyAbi } from './abi.js';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { EvmClient } from './chain.js';
import { crossCheckDeployments, deploymentsSchema, type Deployments } from './deployments.js';
import { orderSafeAddress, safeInitializer, safeSaltNonce } from './safe.js';
import {
  decodeMultiSend, packSignatures, recoverSafeTxSigner, releaseSafeTx, safeTxFromJson, safeTxHash, safeTxToJson,
  safeTxTransfers, signSafeTx, splitSafeTx,
} from './safetx.js';

const D: Deployments = {
  chain_id: 31337,
  usdc: '0x19D57a0C639e9C151F77D67694EfBA67C489F375',
  safe: {
    singleton: '0x10aAE49CE116F85B25fF435a7C6E021137C8ad4c',
    factory: '0x3E0E766aa2b02638F7576E7f83306F7BBd6b4cBD',
    fallback_handler: '0xfE0E960Ef951fBaB1d28408213b9347397851701',
    multisend_call_only: '0x88247D117162f4a846883EDBDD01F7171b80Ab03',
  },
  module: '0x7b43B8E730c1AE746C594D69278CCf4F3f7C8214',
  setup: '0x07eA36Bbd7d7a9225D4Cd92438939C24060729c9',
};
const accounts = [1, 2, 3].map((n) => privateKeyToAccount(`0x${n.toString(16).padStart(64, '0')}`));
const [U, S, E] = accounts;
const ORDER = '0123456789abcdef0123456789abcdef';
const params = { user: U.address, shopper: S.address, escrow: E.address, t1: 1000n, t2: 2000n, orderId: ORDER };

describe('Safe (§6.2)', () => {
  it('builds the initializer with owners in U,S,E order and setup data', () => {
    const init = safeInitializer(D, params);
    expect(init.slice(0, 10)).toBe('0xb63e800d'); // Safe.setup selector
    expect(init.toLowerCase()).toContain(U.address.slice(2).toLowerCase());
    expect(safeSaltNonce(ORDER)).toBe(BigInt(keccak256('0x0123456789abcdef0123456789abcdef')));
  });

  it('predicts a deterministic address that depends on every parameter', () => {
    const a = orderSafeAddress(D, params);
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(orderSafeAddress(D, params)).toBe(a);
    expect(orderSafeAddress(D, { ...params, t2: 2001n })).not.toBe(a);
    expect(orderSafeAddress(D, { ...params, orderId: 'f'.repeat(32) })).not.toBe(a);
  });
});

describe('SafeTx (§6.4)', () => {
  const safe = '0x000000000000000000000000000000000000dEaD' as const;

  it('hashes per EIP-712 and signs with v=27/28', async () => {
    const tx = releaseSafeTx({ usdc: D.usdc, to: S.address, amount: 36_750_000n });
    const h = safeTxHash(tx, 31337, safe);
    expect(h).toBe(hashTypedData({
      domain: { chainId: 31337, verifyingContract: safe },
      types: { SafeTx: [
        { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ] },
      primaryType: 'SafeTx',
      message: tx,
    }));
    const sig = await signSafeTx(U, tx, 31337, safe);
    expect(sig.length).toBe(2 + 130);
    expect([27, 28]).toContain(parseInt(sig.slice(-2), 16));
    expect(await recoverSafeTxSigner(tx, 31337, safe, sig)).toBe(U.address);
    expect(await recoverAddress({ hash: h, signature: sig })).toBe(U.address);
  });

  it('packs signatures by owner address ascending', async () => {
    const tx = releaseSafeTx({ usdc: D.usdc, to: S.address, amount: 1n });
    const sigs = await Promise.all(accounts.map(async (a) => ({ signer: a.address, signature: await signSafeTx(a, tx, 1, safe) })));
    const packed = packSignatures([sigs[2], sigs[0], sigs[1]]);
    const order = [...sigs].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
    expect(packed).toBe(`0x${order.map((s) => s.signature.slice(2)).join('')}`);
  });

  it('encodes a MultiSend split and decodes it back', () => {
    const tx = splitSafeTx({
      usdc: D.usdc,
      multiSend: D.safe.multisend_call_only,
      payouts: [{ to: U.address, amount: 10n }, { to: S.address, amount: 0n }, { to: E.address, amount: 2n }],
    });
    expect(tx.operation).toBe(1);
    expect(tx.to).toBe(D.safe.multisend_call_only);
    expect(decodeMultiSend(tx.data)).toHaveLength(2);
    expect(safeTxTransfers(tx, D.usdc, D.safe.multisend_call_only)).toEqual([{ to: U.address, amount: 10n }, { to: E.address, amount: 2n }]);
    expect(safeTxFromJson(safeTxToJson(tx))).toEqual(tx);
    expect(safeTxToJson(tx)).toMatchObject({ value: '0', operation: '1', nonce: '0', gasToken: zeroAddress });
  });

  it('only accepts transfers through USDC directly or through MultiSendCallOnly', () => {
    const ms = D.safe.multisend_call_only;
    const split = splitSafeTx({ usdc: D.usdc, multiSend: ms, payouts: [{ to: U.address, amount: 10n }] });
    // The same MultiSend payload delegatecalled into any other contract could do anything.
    expect(() => safeTxTransfers({ ...split, to: S.address }, D.usdc, ms)).toThrow(/MultiSendCallOnly/);
    const release = releaseSafeTx({ usdc: D.usdc, to: U.address, amount: 1n });
    expect(() => safeTxTransfers({ ...release, to: S.address }, D.usdc, ms)).toThrow(/USDC/);
    // A call header that claims more data than the payload holds.
    const bogus = encodeFunctionData({ abi: multiSendCallOnlyAbi, functionName: 'multiSend', args: [concat(['0x00', D.usdc, pad('0x0'), pad('0x64'), '0x1234'])] });
    expect(() => decodeMultiSend(bogus)).toThrow(/truncated/);
  });
});


describe('EVM infrastructure trust (items 7, 15)', () => {
  it('disables CCIP-Read on the clients', () => {
    const c = new EvmClient(31337, 'http://127.0.0.1:1', U as never, D);
    expect(c.public.ccipRead).toBe(false);
  });

  it('cross-checks deployments with the signed operator list', () => {
    const list = { chain_id: 31337, rpc: [], usdc: D.usdc.toLowerCase(), safe: { ...D.safe, module: D.module, setup: D.setup } };
    expect(crossCheckDeployments(D, list)).toEqual([]);
    expect(crossCheckDeployments({ ...D, usdc: S.address }, list).join()).toMatch(/usdc/);
    expect(crossCheckDeployments({ ...D, chain_id: 1 }, list).join()).toMatch(/chain_id/);
    expect(crossCheckDeployments({ ...D, safe: { ...D.safe, factory: S.address } }, list).join()).toMatch(/factory/);
  });

  it('validates a fetched deployments file', () => {
    expect(deploymentsSchema(D)).toEqual(D);
    expect(() => deploymentsSchema({ ...D, usdc: 'javascript:alert(1)' })).toThrow();
  });
});
