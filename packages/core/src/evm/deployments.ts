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
