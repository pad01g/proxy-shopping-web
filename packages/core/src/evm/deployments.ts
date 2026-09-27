import type { OperatorListContent } from '../trust/types.js';
import { evmAddress, int, obj, opt, str, type Check } from '../util/validate.js';

/** Shape of contracts/deployments/<chain_id>.json. */
export interface Deployments {
  chain_id: number;
  usdc: `0x${string}`;
  safe: {
    singleton: `0x${string}`;
    factory: `0x${string}`;
    fallback_handler: `0x${string}`;
    multisend_call_only: `0x${string}`;
  };
  module: `0x${string}`;
  setup: `0x${string}`;
  feeds?: Record<string, `0x${string}`>;
  bond?: `0x${string}`;
}

export const USDC_DECIMALS = 6;

const feeds: Check<Record<string, `0x${string}`>> = (v, path = 'feeds') => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${path}: expected an object`);
  return Object.fromEntries(Object.entries(v).slice(0, 32).map(([k, a]) => [str(20)(k, path), evmAddress(a, `${path}.${k}`)]));
};

/** Validate a deployments file fetched at runtime (it comes from a URL the user can change). */
export const deploymentsSchema: Check<Deployments> = obj({
  chain_id: int(1),
  usdc: evmAddress,
  safe: obj({ singleton: evmAddress, factory: evmAddress, fallback_handler: evmAddress, multisend_call_only: evmAddress }),
  module: evmAddress,
  setup: evmAddress,
  feeds: opt(feeds),
  bond: opt(evmAddress),
});

/**
 * Compare locally configured deployments with the `chain.evm` of the order's operator list, which
 * is signed (§2.3). Returns the mismatches; a mismatch means the deployments_url or RPC is not what the operator vouches for.
 */
export function crossCheckDeployments(d: Deployments, listEvm: NonNullable<NonNullable<OperatorListContent['chain']>['evm']>): string[] {
  const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const problems: string[] = [];
  if (listEvm.chain_id !== d.chain_id) problems.push(`chain_id ${d.chain_id} differs from the operator list (${listEvm.chain_id})`);
  const pairs: Array<[string, string | undefined, string | undefined]> = [
    ['usdc', d.usdc, listEvm.usdc],
    ['safe.singleton', d.safe.singleton, listEvm.safe?.singleton],
    ['safe.factory', d.safe.factory, listEvm.safe?.factory],
    ['safe.fallback_handler', d.safe.fallback_handler, listEvm.safe?.fallback_handler],
    ['safe.multisend_call_only', d.safe.multisend_call_only, listEvm.safe?.multisend_call_only],
  ];
  // module / setup are optional in the list; compare when present.
  if (listEvm.safe?.module) pairs.push(['module', d.module, listEvm.safe.module]);
  if (listEvm.safe?.setup) pairs.push(['setup', d.setup, listEvm.safe.setup]);
  for (const [name, ours, theirs] of pairs) if (!same(ours, theirs)) problems.push(`${name} ${ours} differs from the operator list (${theirs ?? 'missing'})`);
  return problems;
}
