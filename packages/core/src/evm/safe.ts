import {
  concat, encodeAbiParameters, encodeFunctionData, getCreate2Address, keccak256, pad, zeroAddress, type Hex,
} from 'viem';
import { orderIdBytes, toHex } from '../util/bytes.js';
import { psSafeSetupAbi, safeAbi } from './abi.js';
import type { Deployments } from './deployments.js';
import { SAFE_PROXY_CREATION_CODE } from './proxy-creation-code.js';


export interface SafeParams {
  user: `0x${string}`;
  shopper: `0x${string}`;
  escrow: `0x${string}`;
  t1: bigint | number;
  t2: bigint | number;
  orderId: string;
}

/** Spec §6.2: Safe.setup(owners=[U,S,E], 2, PSSafeSetup, setup(module, usdc, U, S, t1, t2), fallbackHandler, 0, 0, 0). */
export function safeInitializer(d: Pick<Deployments, 'usdc' | 'module' | 'setup' | 'safe'>, p: SafeParams): Hex {
  const setupData = encodeFunctionData({
    abi: psSafeSetupAbi,
    functionName: 'setup',
    args: [d.module, d.usdc, p.user, p.shopper, BigInt(p.t1), BigInt(p.t2)],
  });
  return encodeFunctionData({
    abi: safeAbi,
    functionName: 'setup',
    args: [[p.user, p.shopper, p.escrow], 2n, d.setup, setupData, d.safe.fallback_handler, zeroAddress, 0n, zeroAddress],
  });
}

/** saltNonce = uint256(keccak256(order_id bytes)). */
export function safeSaltNonce(orderId: string): bigint {
  return BigInt(keccak256(`0x${toHex(orderIdBytes(orderId))}`));
}

/** CREATE2 address of SafeProxyFactory.createProxyWithNonce(singleton, initializer, saltNonce). */
export function predictSafeAddress(p: {
  factory: `0x${string}`;
  singleton: `0x${string}`;
  initializer: Hex;
  saltNonce: bigint;
  proxyCreationCode?: Hex;
}): `0x${string}` {
  const salt = keccak256(concat([keccak256(p.initializer), encodeAbiParameters([{ type: 'uint256' }], [p.saltNonce])]));
  const initCode = concat([p.proxyCreationCode ?? SAFE_PROXY_CREATION_CODE, pad(p.singleton, { size: 32 })]);
  return getCreate2Address({ from: p.factory, salt, bytecodeHash: keccak256(initCode) });
}

export function orderSafeAddress(d: Deployments, p: SafeParams, proxyCreationCode?: Hex): `0x${string}` {
  return predictSafeAddress({
    factory: d.safe.factory,
    singleton: d.safe.singleton,
    initializer: safeInitializer(d, p),
    saltNonce: safeSaltNonce(p.orderId),
    proxyCreationCode,
  });
}
