import {
  concat, decodeFunctionData, encodeFunctionData, encodePacked, hashTypedData, hexToBytes, recoverAddress, size, zeroAddress,
  type Hex, type LocalAccount,
} from 'viem';
import type { SafeTxJson } from '../nostr/messages.js';
import { erc20Abi, multiSendCallOnlyAbi } from './abi.js';

export interface SafeTx {
  to: `0x${string}`;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: `0x${string}`;
  refundReceiver: `0x${string}`;
  nonce: bigint;
}

export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

function baseTx(to: `0x${string}`, data: Hex, operation: 0 | 1, nonce: bigint): SafeTx {
  return {
    to, value: 0n, data, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: zeroAddress, refundReceiver: zeroAddress, nonce,
  };
}

/** §6.4 release: USDC transfer(S, amount). */
export function releaseSafeTx(p: { usdc: `0x${string}`; to: `0x${string}`; amount: bigint; nonce?: bigint }): SafeTx {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [p.to, p.amount] });
  return baseTx(p.usdc, data, 0, p.nonce ?? 0n);
}

export interface MultiSendCall {
  to: `0x${string}`;
  data: Hex;
  value?: bigint;
}

/** Packed MultiSendCallOnly payload: uint8(0) ++ to ++ uint256(value) ++ uint256(len) ++ data per call. */
export function encodeMultiSend(calls: MultiSendCall[]): Hex {
  const packed = calls.map((c) =>
    encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, c.to, c.value ?? 0n, BigInt(size(c.data)), c.data]),
  );
  return encodeFunctionData({ abi: multiSendCallOnlyAbi, functionName: 'multiSend', args: [packed.length ? concat(packed) : '0x'] });
}

/** Decode a MultiSend payload back into calls (to verify a counterparty's proposal). */
export function decodeMultiSend(data: Hex): MultiSendCall[] {
  const { args } = decodeFunctionData({ abi: multiSendCallOnlyAbi, data });
  const bytes = hexToBytes(args[0]);
  const calls: MultiSendCall[] = [];
  let i = 0;
  const hex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
  while (i < bytes.length) {
    if (bytes[i] !== 0) throw new Error('multisend: only CALL operations allowed');
    const to = hex(bytes.slice(i + 1, i + 21)) as `0x${string}`;
    const value = BigInt(hex(bytes.slice(i + 21, i + 53)));
    if (i + 85 > bytes.length) throw new Error('multisend: truncated call header');
    const len = Number(BigInt(hex(bytes.slice(i + 53, i + 85))));
    if (i + 85 + len > bytes.length) throw new Error('multisend: truncated call data');
    const data = hex(bytes.slice(i + 85, i + 85 + len));
    calls.push({ to, value, data });
    i += 85 + len;
  }
  return calls;
}

/** §6.4 ruling: delegatecall MultiSendCallOnly with USDC transfers (zero amounts skipped). */
export function splitSafeTx(p: {
  usdc: `0x${string}`;
  multiSend: `0x${string}`;
  payouts: Array<{ to: `0x${string}`; amount: bigint }>;
  nonce?: bigint;
}): SafeTx {
  const calls = p.payouts
    .filter((x) => x.amount > 0n)
    .map((x) => ({ to: p.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [x.to, x.amount] }) }));
  return baseTx(p.multiSend, encodeMultiSend(calls), 1, p.nonce ?? 0n);
}

/**
 * USDC transfers in a SafeTx as (to, amount) pairs. Only the two §4.10 shapes are accepted:
 * operation 0 calling `usdc.transfer`, or operation 1 (delegatecall) to MultiSendCallOnly with
 * nothing but `usdc.transfer` calls. Anything else throws.
 */
export function safeTxTransfers(tx: SafeTx, usdc: `0x${string}`, multiSend: `0x${string}`): Array<{ to: `0x${string}`; amount: bigint }> {
  if (tx.operation === 1 && tx.to.toLowerCase() !== multiSend.toLowerCase()) throw new Error('delegatecall to a contract other than MultiSendCallOnly');
  if (tx.operation === 0 && tx.to.toLowerCase() !== usdc.toLowerCase()) throw new Error('call to a contract other than USDC');
  const calls = tx.operation === 1 ? decodeMultiSend(tx.data) : [{ to: tx.to, data: tx.data, value: tx.value }];
  return calls.map((c) => {
    if (c.to.toLowerCase() !== usdc.toLowerCase() || (c.value ?? 0n) !== 0n) throw new Error('unexpected call target');
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: c.data });
    if (functionName !== 'transfer') throw new Error(`unexpected call ${functionName}`);
    const [to, amount] = args as readonly [`0x${string}`, bigint];
    return { to, amount };
  });
}

export function safeTxHash(tx: SafeTx, chainId: number, safe: `0x${string}`): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: tx,
  });
}

/** 65-byte EIP-712 signature (v = 27/28). */
export function signSafeTx(account: LocalAccount, tx: SafeTx, chainId: number, safe: `0x${string}`): Promise<Hex> {
  if (!account.signTypedData) throw new Error('account cannot sign typed data');
  return account.signTypedData({
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: tx,
  });
}

export async function recoverSafeTxSigner(tx: SafeTx, chainId: number, safe: `0x${string}`, signature: Hex): Promise<`0x${string}`> {
  return recoverAddress({ hash: safeTxHash(tx, chainId, safe), signature });
}

/** Concatenate signatures ordered by signer address ascending (§6.4). */
export function packSignatures(sigs: Array<{ signer: `0x${string}`; signature: Hex }>): Hex {
  const sorted = [...sigs].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  return concat(sorted.map((s) => s.signature));
}

export function safeTxToJson(tx: SafeTx): SafeTxJson {
  return {
    to: tx.to,
    value: tx.value.toString(),
    data: tx.data,
    operation: String(tx.operation),
    safeTxGas: tx.safeTxGas.toString(),
    baseGas: tx.baseGas.toString(),
    gasPrice: tx.gasPrice.toString(),
    gasToken: tx.gasToken,
    refundReceiver: tx.refundReceiver,
    nonce: tx.nonce.toString(),
  };
}

export function safeTxFromJson(j: SafeTxJson): SafeTx {
  const op = Number(j.operation);
  if (op !== 0 && op !== 1) throw new Error('bad operation');
  return {
    to: j.to as `0x${string}`,
    value: BigInt(j.value),
    data: j.data as Hex,
    operation: op,
    safeTxGas: BigInt(j.safeTxGas),
    baseGas: BigInt(j.baseGas),
    gasPrice: BigInt(j.gasPrice),
    gasToken: j.gasToken as `0x${string}`,
    refundReceiver: j.refundReceiver as `0x${string}`,
    nonce: BigInt(j.nonce),
  };
}
