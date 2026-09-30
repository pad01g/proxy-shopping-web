#!/usr/bin/env node
// Copy what the mock mode's in-browser EVM needs from proxy-shopping-go/contracts into the demo:
// the creation bytecode of every contract the lab deploys (contracts/script/Deploy.s.sol) and the lab's
// deployments file. The page then deploys the same bytecode at the same CREATE2 addresses as the lab's anvil.
//   node apps/demo/scripts/vendor-contracts.mjs [path/to/proxy-shopping-go/contracts]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const contracts = resolve(process.argv[2] ?? join(here, '../../../../proxy-shopping-go/contracts'));
const out = join(here, '../src/mock/world/evm/contracts.json');
const outDeployments = join(here, '../src/mock/deployments-31337.json');

// Deploy.s.sol's order and constructor arguments (the page encodes the arguments).
const NAMES = ['MockUSDC', 'SafeL2', 'SafeProxyFactory', 'CompatibilityFallbackHandler', 'MultiSendCallOnly', 'PSEscrowModule', 'PSSafeSetup', 'MockAggregatorV3', 'PSBond'];

const bytecode = {};
for (const name of NAMES) {
  const j = JSON.parse(readFileSync(join(contracts, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
  const code = j.bytecode?.object;
  if (!/^0x[0-9a-f]+$/i.test(code ?? '')) throw new Error(`${name}: no creation bytecode`);
  bytecode[name] = code.toLowerCase();
}
const deployments = JSON.parse(readFileSync(join(contracts, 'deployments', '31337.json'), 'utf8'));
writeFileSync(out, JSON.stringify({ source: 'proxy-shopping-go/contracts/out (creation bytecode)', bytecode }, null, 1) + '\n');
writeFileSync(outDeployments, JSON.stringify(deployments, null, 2) + '\n');
console.log(`wrote ${out} and ${outDeployments}`);
