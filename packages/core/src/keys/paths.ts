/** Derivation paths from spec §1. */
export const PATHS = {
  nostr: "m/44'/1237'/0'/0/0",
  libp2p: "m/7333'/0'/0'",
  orderKey: (idx: number) => `m/7333'/1'/${idx}'`,
  escrowAccount: "m/7333'/2'",
  escrowOrderKey: (idx: number) => `m/7333'/2'/${idx}`,
  btcWallet: "m/84'/1'/0'/0/0",
  evm: "m/44'/60'/0'/0/0",
} as const;

/** BIP32 version bytes for testnet extended keys (tpub / tprv). */
export const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };
/** BIP32 version bytes for mainnet extended keys (xpub / xprv). */
export const MAINNET_VERSIONS = { private: 0x0488ade4, public: 0x0488b21e };
