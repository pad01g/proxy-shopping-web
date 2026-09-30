/**
 * The demo config of mock mode: the lab's values (lib/config.ts DemoConfig), built in instead of fetched from
 * /demo-config.json. There are no physical relays or URLs: the backend (lib/backend.ts mockBackend) talks to
 * the in-browser world.
 */
import type { Deployments } from '@proxy-shopping/core/browser';
import type { ResolvedConfig } from '../lib/config';
import {
  MOCK_COORDINATOR_MNEMONIC, MOCK_LIST_ENDPOINTS, MOCK_MAX_CLOCK_SKEW, MOCK_NETWORK, MOCK_RELAYS, MOCK_SHOPPER, MOCK_TIMELOCK_POLICY,
} from './constants';
import deployments from './deployments-31337.json';

export const MOCK_DEPLOYMENTS = deployments as Deployments;

export function mockConfig(): ResolvedConfig {
  const none = 'mock:';
  return {
    network: MOCK_NETWORK,
    relays: MOCK_RELAYS,
    relay_paths: {},
    esplora: none,
    evm_rpc: none,
    faucet: none,
    deployments: 'deployments-31337.json (built in)',
    rates: [{ type: 'coingecko', base: 'https://rates.test/coingecko' }, { type: 'frankfurter', base: 'https://rates.test/frankfurter' }],
    coordinator_mnemonic: MOCK_COORDINATOR_MNEMONIC,
    shoppers: [MOCK_SHOPPER],
    list_endpoints: MOCK_LIST_ENDPOINTS,
    timelock_policy: MOCK_TIMELOCK_POLICY,
    max_clock_skew_seconds: MOCK_MAX_CLOCK_SKEW,
    allow_private_endpoints: true,
    physicalRelays: new Map(),
    urls: { esplora: none, evm: none, faucet: none, deployments: none, rates: [], ratesAdmin: none },
  };
}
