# apps/demo — the guided all-roles demo

**Try it in your browser: https://pad01g.github.io/proxy-shopping-web/ (everything simulated in the page).**

One page plays every role of proxy-shopping — user, escrow, operator and coordinator each with their own key and
their own core `Session`, plus the always-online shopper node — and a guide walks through seven scenarios
(normal BTC / USDC, dispute refund, sold out, risky shop, fraudulent escrow, T2 refund). The page is in Japanese or
English (`?lang=en`); `?role=user` / `?role=escrow,operator,coordinator` runs only those roles in a window. Test ids:
[TESTIDS.md](TESTIDS.md).

## Two modes

| | lab (`?mock=0`) | mock (`?mock=1`, default of the Pages build) |
|---|---|---|
| where it runs | the docker compose lab of `../proxy-shopping-go` through its demo server (http://localhost:8888/) | entirely inside the browser; no server besides the static files |
| relays | psrelay ×2 (websocket via the demo server) | in-browser relays |
| BTC | bitcoind signet + esplora-lite | in-browser UTXO chain with script checks |
| EVM | anvil | in-browser EVM (@ethereumjs/vm) with the lab's contracts |
| shopper-1 | the Go node | a TypeScript port of the Go shopper |
| shops, bot, faucet, rates | fakeshop, shopper-bot, labfaucet | in-browser mocks with the lab's values |
| data | `ps-demo.*`, `ps-demo-<role>` | `ps-demo-mock.*`, `ps-demo-mock-<role>`, `ps-demo-mock-world` |

The header's **モック / Mock** switch reloads the page in the other mode. Without `?mock=` the build decides:
`VITE_DEMO_MOCK=1` (set by [.env.pages](.env.pages) for `vite build --mode pages`) makes mock the default. The two
modes never share keys or records.

## Mock mode: what is real and what is simulated

Real — the same code as against the lab:
- the four role sessions and clients of `@proxy-shopping/core` (`UserClient`, `EscrowClient`, `OperatorClient`,
  `CoordinatorClient`): keys (BIP39, kept in localStorage per mode), signed trust events, NIP-59 gift wraps with NIP-44
  encryption, schema checks, quote checks, PSBTs and witness scripts (§5.1), Safe transactions and EIP-712 signatures;
- the EVM contracts: the lab's bytecode (Safe v1.4.1 `SafeL2` singleton, `SafeProxyFactory`, `MultiSendCallOnly`,
  `CompatibilityFallbackHandler`, `PSEscrowModule`, `PSSafeSetup`, `MockUSDC`, the three rate feeds, `PSBond`), vendored
  in [src/mock/world/evm/contracts.json](src/mock/world/evm/contracts.json) and deployed through the CREATE2 deployer at
  the addresses of `deployments/31337.json`. Safe owners, threshold, signatures, nonces and the module's T1/T2 are
  enforced by the contracts running in `@ethereumjs/vm` (Cancun).

Simulated (src/mock/world, running in a SharedWorker so every window of the browser shares one world):
- **relays** ([relay.ts](src/mock/world/relay.ts)): `wss://relay-1.test`, `wss://relay-2.test`; verify id and
  signature, accept the protocol's kinds only, keep the latest replaceable event (`v` tag), honour kind 5, answer
  queries newest first with `limit`;
- **BTC chain** ([btc/chain.ts](src/mock/world/btc/chain.ts), [btc/verify.ts](src/mock/world/btc/verify.ts)):
  implements core's `ChainApi` (UTXOs incl. mempool, broadcast, status, outspend, heights, tip time, fee estimates).
  Broadcast parses the transaction and checks inputs (exist, unspent), amounts, fee ≥ 1 sat/vB, dust, nLockTime
  finality and every input's witness: P2WPKH and P2WSH with BIP143 signatures (low S, strict DER), `CHECKMULTISIG`
  (NULLDUMMY), `CHECKLOCKTIMEVERIFY`, MINIMALIF, CLEANSTACK. A miner mines about 1 s after a transaction arrives
  (like the lab's faucet); the lab tab mines on demand. The faucet pays from its own wallet with real transactions;
- **EVM node** ([evm/evm.ts](src/mock/world/evm/evm.ts)): anvil's behaviour around the real EVM — automine (one block
  per transaction), the JSON-RPC subset viem uses, `anvil_setBalance`, `evm_increaseTime` + `evm_mine`. The state is
  kept as a replayable log of blocks;
- **shopper-1** ([shopper.ts](src/mock/world/shopper.ts)): a port of the Go shopper's order flow with the lab's
  settings: trust / region / payment / key_proof / address checks, the shop risk score (allowlist +50, verified HTTPS +20,
  known gateway +30, threshold 70 → `risk`), cash-only region check (`region`), price from the catalog with fee and
  limits, rates from the rate sources, timelocks (BTC tip + 100 / + 150, EVM now + 3600 / + 7200), funding verified on the
  mock chain / Safe, purchase through the bot, shipping updates, cooperative refund offer after a failed purchase,
  countersigning releases and rulings that give it something, evidence for the escrow, the T1 claim, pause / resume,
  `needs_human` resolution; the "shopper (node)" tab shows it like the Go node's admin API;
- **shops, card gateway, shopper-bot** ([shops.ts](src/mock/world/shops.ts)), **rates** ([rates.ts](src/mock/world/rates.ts),
  CoinGecko / Frankfurter formats; BTC/USD 100000, USD/JPY 150, USDC/USD 1), **faucet** (BTC, ETH, USDC), mining and time warp.

The page talks to the world through [src/mock/client.ts](src/mock/client.ts) (a `NostrTransport`, a `ChainApi`, a viem
transport and a `fetch` for the rate sources); the lab-only services are behind one interface ([src/lib/backend.ts](src/lib/backend.ts)).
Nothing leaves the browser: the Pages build also carries a CSP (`connect-src 'self'`), and the e2e fails on any request
off the page's origin.

Limitations of the simulation (compared with the lab):
- no libp2p, no NAT, no second shopper or escrow node; shopper-2 does not exist;
- the BTC chain has no proof of work, reorgs, RBF/CPFP or time-based locktimes, and only segwit v0 scripts;
- the EVM node has no mempool (every transaction is mined at once), a constant base fee and no `eth_subscribe`;
- the shopper port covers what the scenarios use; rare paths of the Go node (replacing stuck EVM transactions,
  funding-use bookkeeping across restarts beyond the stored map, attachment chunks) are simpler or absent;
- without SharedWorker (e.g. some mobile browsers) the world runs in a dedicated Worker of the window and the
  separate-windows mode is switched off with a notice.

## Commands (from the repository root, in docker)

```sh
docker run --rm -v "$PWD":/src -v ps-npm:/root/.npm -w /src node:22-bookworm sh -c \
  'npm ci && npm run build -w @proxy-shopping/core && npm test -w @proxy-shopping/demo'   # mock world unit tests
docker run --rm -v "$PWD":/src -v ps-npm:/root/.npm -w /src node:22-bookworm npm run build:pages -w @proxy-shopping/demo  # → apps/demo/dist-pages
scripts/e2e-demo-mock.sh                                   # build + Playwright: 7 scenarios, English, separate windows
DEMO_SCENARIOS=normal-btc scripts/e2e-demo-mock.sh         # some of them
DEMO_URL=https://pad01g.github.io/proxy-shopping-web/ SKIP_BUILD=1 DEMO_SCENARIOS=normal-btc scripts/e2e-demo-mock.sh  # the live site
node apps/demo/scripts/vendor-contracts.mjs ../proxy-shopping-go/contracts   # refresh the vendored bytecode
```

The lab build (`npm run build`, image `apps/demo/Dockerfile`) is unchanged: `/demo-config.json` and the demo server
decide everything; the lab's e2e is `docker compose run --rm runner demo` in `../proxy-shopping-go`.
GitHub Pages: [.github/workflows/pages-demo.yaml](../../.github/workflows/pages-demo.yaml) (push to main): unit tests,
`build:pages`, the mock e2e against the built files, then deploy.
