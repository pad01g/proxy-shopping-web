/**
 * The lab's contracts in the mock EVM, placed like proxy-shopping-go/contracts/script/Deploy.s.sol does: every
 * contract through the CREATE2 deployer (0x4e59…956c) with salt 0, so the addresses are the lab's
 * (deployments/31337.json) as long as the bytecode is the same. The bytecode is vendored in contracts.json
 * (apps/demo/scripts/vendor-contracts.mjs); genesis checks each address against the deployments file.
 */
import type { Block } from '@ethereumjs/block';
import { Account, createAddressFromString, hexToBytes, type PrefixedHexString } from '@ethereumjs/util';
import type { VM } from '@ethereumjs/vm';
import { encodeAbiParameters, type Hex } from 'viem';
import type { Deployments } from '@proxy-shopping/core/browser';
import artifacts from './contracts.json';
import deployments from '../../deployments-31337.json';

/** The deterministic deployment proxy (github.com/Arachnid/deterministic-deployment-proxy), as on anvil. */
export const CREATE2_FACTORY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
const CREATE2_FACTORY_CODE = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';

/** Deploy.s.sol: the lab's operator-1 receives the bond (m/44'/60'/0'/0/0 of its mnemonic). */
const BOND_OPERATOR = '0xFDD9c12c4854FFeeB2C8AC9aEacEA1ce518afA14';
const BOND_WITHDRAW_DELAY = 7n * 24n * 3600n;
const BOND_WITHDRAW_WINDOW = 2n * 24n * 3600n;

/** The faucet's account: anvil's account 0 (the lab's deployer and faucet use it too). */
export const FAUCET_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const FAUCET_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
/** ETH the faucet account starts with (anvil gives 10000 ETH). */
export const GENESIS_BALANCE = 10_000n * 10n ** 18n;

export const LAB_DEPLOYMENTS = deployments as Deployments;

type Name = keyof typeof artifacts.bytecode;

function initCode(name: Name, args?: Hex): Uint8Array {
  const code = artifacts.bytecode[name] as Hex;
  return hexToBytes((args ? code + args.slice(2) : code) as PrefixedHexString);
}

const feed = (description: string, answer: bigint) =>
  initCode('MockAggregatorV3', encodeAbiParameters([{ type: 'string' }, { type: 'int256' }], [description, answer]));

export interface GenesisResult {
  deployments: Deployments;
  /** Contract → address as deployed here. */
  deployed: Record<string, string>;
}

/** Deploy everything at `block`'s time; throws when an address differs from the lab's deployments file. */
export async function deployGenesis(vm: VM, block: Block): Promise<GenesisResult> {
  const sm = vm.stateManager;
  const factory = createAddressFromString(CREATE2_FACTORY);
  await sm.putAccount(factory, new Account());
  await sm.putCode(factory, hexToBytes(CREATE2_FACTORY_CODE));
  const faucet = createAddressFromString(FAUCET_ADDRESS);
  await sm.putAccount(faucet, new Account(0n, GENESIS_BALANCE));

  const d = LAB_DEPLOYMENTS;
  const plan: Array<[string, Uint8Array, string]> = [
    ['usdc', initCode('MockUSDC'), d.usdc],
    ['safe.singleton', initCode('SafeL2'), d.safe.singleton],
    ['safe.factory', initCode('SafeProxyFactory'), d.safe.factory],
    ['safe.fallback_handler', initCode('CompatibilityFallbackHandler'), d.safe.fallback_handler],
    ['safe.multisend_call_only', initCode('MultiSendCallOnly'), d.safe.multisend_call_only],
    ['module', initCode('PSEscrowModule'), d.module],
    ['setup', initCode('PSSafeSetup'), d.setup],
    ['feeds.BTC/USD', feed('BTC / USD', 100_000n * 10n ** 8n), d.feeds?.['BTC/USD'] ?? ''],
    ['feeds.JPY/USD', feed('JPY / USD', 666_667n), d.feeds?.['JPY/USD'] ?? ''],
    ['feeds.USDC/USD', feed('USDC / USD', 10n ** 8n), d.feeds?.['USDC/USD'] ?? ''],
  ];
  const bondArgs = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint64' }, { type: 'uint64' }],
    [d.usdc, BOND_OPERATOR, BOND_WITHDRAW_DELAY, BOND_WITHDRAW_WINDOW],
  );
  plan.push(['bond', initCode('PSBond', bondArgs), d.bond ?? '']);

  const deployed: Record<string, string> = {};
  for (const [name, code, expected] of plan) {
    // What the CREATE2 deployer does for the calldata salt ‖ initCode: CREATE2 from its own address.
    const r = await vm.evm.runCall({
      caller: factory,
      origin: faucet,
      salt: new Uint8Array(32),
      data: code,
      gasLimit: 30_000_000n,
      block,
    });
    if (r.execResult.exceptionError || !r.createdAddress) throw new Error(`mock evm: deploying ${name} failed: ${r.execResult.exceptionError?.error}`);
    const addr = r.createdAddress.toString().toLowerCase();
    if (expected && addr !== expected.toLowerCase()) {
      throw new Error(`mock evm: ${name} deployed at ${addr}, the lab's deployments say ${expected} (vendored bytecode differs)`);
    }
    deployed[name] = addr;
  }
  return { deployments: d, deployed };
}
