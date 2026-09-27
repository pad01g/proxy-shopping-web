import { existsSync, readFileSync } from 'node:fs';
import type { Deployments } from '../../src/evm/deployments.js';

/** Endpoints provided by scripts/integration.sh. */
export const ENV = {
  bitcoind: process.env.BITCOIND_RPC,
  anvil: process.env.ANVIL_RPC,
  relay: process.env.RELAY_URL,
  deploymentsFile: process.env.DEPLOYMENTS,
};

export function loadDeployments(): Deployments | undefined {
  const f = ENV.deploymentsFile;
  if (!f || !existsSync(f)) return undefined;
  return JSON.parse(readFileSync(f, 'utf8')) as Deployments;
}

export function skipReason(need: Array<keyof typeof ENV>): string | undefined {
  const missing = need.filter((k) => !ENV[k]);
  return missing.length ? `integration env missing: ${missing.join(', ')} (run scripts/integration.sh)` : undefined;
}
