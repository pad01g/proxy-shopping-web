# proxy-shopping-web

Browser side of proxy-shopping (spec: `../proxy-shopping-go/docs/spec.md`, lab: `docs/lab.md` there).

```
packages/core   @proxy-shopping/core — protocol library (TypeScript, ESM, browsers and Node 22)
apps/web        React + Vite single-page app for every role (Japanese UI)
apps/demo       the lab's integrated demo page: every role with its own key in one browser, a guide per scenario
scripts/        docker helpers for integration and browser tests
```

Host tools are not required; everything runs in docker.

```sh
# install, build, unit tests
docker run --rm -v "$PWD":/src -v ps-npm:/root/.npm -w /src node:22-bookworm npm ci
docker run --rm -v "$PWD":/src -v ps-npm:/root/.npm -w /src node:22-bookworm npm run build
docker run --rm -v "$PWD":/src -v "$PWD/../proxy-shopping-go":/proxy-shopping-go:ro -v ps-npm:/root/.npm -w /src node:22-bookworm npm test

# integration: bitcoind signet + anvil (lab contracts) + nostr-rs-relay
scripts/integration.sh
# the built web app in Chromium against a mini lab (TS shopper, faucet, escrow …)
scripts/e2e-web.sh

# web image (config.json is mounted at runtime)
docker build -f apps/web/Dockerfile -t proxy-shopping-web .
docker run -p 8080:80 -v $PWD/config.json:/usr/share/nginx/html/config.json:ro proxy-shopping-web
```

Mounting `../proxy-shopping-go` read-only lets the unit tests check `docs/test-vectors.json`
and `lab/keys/public.json`. Without the vectors file `npm test` fails, so CI cannot pass silently;
set `SKIP_VECTORS=1` to run the other tests without it.

## apps/demo

The integrated demo for the docker compose lab (`../proxy-shopping-go`, compose service `demo`, http://localhost:8888/;
usage in `../proxy-shopping-go/docs/lab.md`「デモ画面」). User, escrow, operator and coordinator each have their own key
(localStorage, lab only) and their own `Session` + client in the page; the shopper is the lab's Go node. A guide walks
through seven scenarios (normal BTC / USDC, dispute refund, sold out, risky shop, fraudulent escrow, T2 refund);
`?role=user` / `?role=escrow,operator,coordinator` runs only those roles in a window. The page is in Japanese or English
(header switch 日本語 / English, kept in localStorage; `?lang=en|ja` overrides it): one message catalog per language in
`apps/demo/src/i18n` (`ja.ts` defines the keys, `en.ts` must match them), core's timeline lines are rendered from their kind.
Protocol logic is core's
(`UserClient`, `EscrowClient`, `OperatorClient`, `CoordinatorClient`); the page wires them over core's `MappedTransport` (logical relay
URLs such as `wss://relay-1.test` stay protocol-visible, the connection goes to the demo server's `/relay-1`).

```sh
docker build -f apps/demo/Dockerfile -t proxy-shopping-demo .   # static files; the lab mounts its nginx.conf + demo-config.json
DEMO_SERVER=http://localhost:8888 npm run dev -w @proxy-shopping/demo   # dev server proxying to a running lab demo server
```

Scenario steps are data (`apps/demo/src/scenarios`); test ids in `apps/demo/TESTIDS.md`; the e2e that follows the guide is
`../proxy-shopping-go/e2e/src/demo` (`docker compose run --rm runner demo`).

## @proxy-shopping/core

Entry points: `@proxy-shopping/core` (portable), `/node` (+ `FileStorage`), `/browser`
(+ `IndexedDBStorage`), `/testing` (in-memory relays/chain, scripted shopper, `createWorld`),
`/testing/node` (bitcoind RPC + Esplora shim). Build output with declarations is in `dist/`.

| area | main exports |
|---|---|
| keys | `KeySet.fromMnemonic` (nostr, order keys, escrow tpub, P2WPKH wallet, EVM), `orderIndex`, `escrowPubkeyFromXpub`, `generateMnemonic`, `LocalSigner`, `Nip07Signer` |
| nostr | `signInner`, `giftWrap`, `unwrap`, `isValidInner`, `Messenger` (k relays, ack, retry, dedupe, persisted), `PoolTransport`, `MappedTransport`, message body types, `MSG` |
| trust | `effectiveCombinations`, `matchingEntries`, `covers`, `latestByAddress`, parsers and `*Template` builders for 30500–30503/10050, `TrustDirectory` |
| fx | `FrankfurterSource`, `CoingeckoSource`, `ChainlinkSource`, `StaticSource`, `computePair`, `getRate`, `checkQuoteRate` |
| btc | `witnessScript`, `p2wshAddress`, `EsploraClient`, `buildFundingTx`, `buildEscrowSpend`, `signEscrowInput`, `finalizeEscrowInput` (multisig / T1 / T2), PSBT base64 helpers |
| evm | `safeInitializer`, `predictSafeAddress`, `orderSafeAddress`, `releaseSafeTx`, `splitSafeTx`, `encodeMultiSend`, `safeTxHash`, `signSafeTx`, `packSignatures`, `EvmClient` (deploy, fund, exec, module, bond) |
| delivery | `encryptAddress`, `decryptAddress`, `sealDelivery`, `unwrapDeliveryKey` |
| flows | `Session`, `UserClient`, `EscrowClient`, `OperatorClient`, `CoordinatorClient`, `ShopperProfile`, `checkQuote`, `checkTimelock`, `btcPayoutProblems` / `safePayoutProblems` (§4.10 templates), `escrowSpent` |
| checks | `parseBody` / `BODY_SCHEMAS` (every message body is schema-checked at the Messenger boundary), `signKeyProof*` / `verifyRequestKeyProof` (§4.4.1), `endpointProblem`, `encryptWithPassphrase` |

## Notes

- The mnemonic is stored in the origin's IndexedDB encrypted with a passphrase (PBKDF2-SHA256, 600k iterations,
  AES-GCM via WebCrypto); plaintext only if the user explicitly opts out at onboarding. WebCrypto needs a secure
  context (https or localhost) — `scripts/e2e-web.sh` forwards localhost:8080 in the browser container for that.
- Funds never move without a click and an in-page confirmation (fund, resume funding, release, countersign, refunds).
  The shopper's cooperative refund is shown for review, never auto-signed. Terminal states (`completed`, `settled`,
  `refunded`) wait for the chain, also after our own broadcast (BTC `/tx/{txid}/outspend/{vout}`; USDC: Safe balance
  below lock_amount and a receipt with a Transfer out of the Safe — anyone can send dust to a Safe, §4.8).
- Funding persists every transaction before it is sent (BTC txid + raw tx; EVM: signed locally, hash + raw tx
  stored, then sent), so an interrupted funding is resumed with the same transactions, never paid twice.
- The escrow opens a case only when a notice / dispute names a request whose request + quote recompute to the funded
  output (P2WSH, or the Safe with its owners / module configuration) on chain (§4.7); its ruling fee is exactly
  `dispute_fee_bps` of what is split, and it owes rulings only for upfront fees ≥ its own published minimum.
- `config.json` fields beyond the endpoints: `timelock_policy` (§4.5.1; names as in `proxy-shopping-go/lab/web-config.json`,
  spec defaults when absent), `max_clock_skew_seconds` (§4.5.1: largest accepted difference between the chain's clock —
  BTC tip header time, EVM latest block time — and ours, default 7200; the lab sets 315360000 because anvil's time is
  warped), `allow_private_endpoints` (lab only: http/ws and private hosts), `max_fee_rate` (sat/vB, default 50).
  Endpoints must otherwise be https / wss; relays from peers' kind 10050 are limited to 8 public wss relays.
- Messaging (§4.10): 120 messages / min per sender after EOSE, 60 / min for all non-counterparty senders together,
  higher per-sender limits for the stored backlog (older pages are read when the first 1000 wraps are full);
  messages no attached role accepts are neither stored nor acked. Sends go to k (2) inbox relays, the next ones
  only when one fails; resends 1, 2, 4, 8, … get a fresh wrap. A signed inner is at most 28000 bytes (§4.9);
  dispute evidence is split over several messages.
- The Safe address is predicted with the factory's `proxyCreationCode` only if its keccak256 is a known Safe v1.4.1
  build (the lab's and the canonical one, `KNOWN_PROXY_CREATION_CODE_HASHES`).
- Only one tab runs the protocol at a time (Web Locks, BroadcastChannel fallback).
- `apps/web/nginx.conf` sets CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`;
  HSTS belongs to the TLS terminator. Production builds have no source maps.
- The browser talks to Esplora, the EVM RPC, rate sources and the faucet directly, so those
  endpoints must send CORS headers.
- UI test ids: `apps/web/TESTIDS.md`.
