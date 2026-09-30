/**
 * Values of the mock world that the page needs too (kept apart from the world's code so the page bundle does
 * not pull in the EVM). They are the lab's (proxy-shopping-go/lab/demo/demo-config.json, docs/lab.md).
 */
export const MOCK_NETWORK = 'ps-lab';
export const MOCK_RELAYS = ['wss://relay-1.test', 'wss://relay-2.test'];
/** lab/keys/coordinator-demo.mnemonic: the demo's coordinator; the mock shopper node trusts its pubkey. */
export const MOCK_COORDINATOR_MNEMONIC = 'message occur banana believe spring shadow deer manage ginger mistake mad process';
/** lab/keys/shopper-1.mnemonic: the mock shopper node's key. */
export const MOCK_SHOPPER_MNEMONIC = 'december art feature luxury renew grape champion meadow wage weird aunt unaware';
export const MOCK_SHOPPER = {
  name: 'shopper-1',
  pubkey: '58faf8c359a8c0c9e27e4c610a93406536f07b4585d6351a9ea3ee8fc3891ae4',
  node: 'mock:shopper-1',
  evm_address: '0xf9835d3ce8F450cA201F8Dcb30263475Fb25A445',
};
export const MOCK_TIMELOCK_POLICY = {
  btc_min_t1_blocks: 50, evm_min_t1_seconds: 1800, btc_min_gap_blocks: 20, evm_min_gap_seconds: 1800, btc_max_t2_blocks: 1000, evm_max_t2_seconds: 86400,
};
export const MOCK_MAX_CLOCK_SKEW = 315_360_000;
/** Endpoints the operator list recommends (protocol-visible; nothing connects to them in mock mode). */
export const MOCK_LIST_ENDPOINTS = { esplora: 'https://esplora.test', evm_rpc: 'https://evm.test' };
