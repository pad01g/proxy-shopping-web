# proxy-shopping-web

Browser side of proxy-shopping (spec: `../proxy-shopping-go/docs/spec.md`, lab: `docs/lab.md` there).

```
packages/core   @proxy-shopping/core — protocol library (TypeScript, ESM, browsers and Node 22)
apps/web        React + Vite single-page app for every role (Japanese UI)
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
and `lab/keys/public.json`; without it those tests are skipped.

## @proxy-shopping/core

Entry points: `@proxy-shopping/core` (portable), `/node` (+ `FileStorage`), `/browser`
(+ `IndexedDBStorage`), `/testing` (in-memory relays/chain, scripted shopper, `createWorld`),
`/testing/node` (bitcoind RPC + Esplora shim). Build output with declarations is in `dist/`.

| area | main exports |
|---|---|
| keys | `KeySet.fromMnemonic` (nostr, order keys, escrow tpub, P2WPKH wallet, EVM), `orderIndex`, `escrowPubkeyFromXpub`, `generateMnemonic`, `LocalSigner`, `Nip07Signer` |
| nostr | `signInner`, `giftWrap`, `unwrap`, `isValidInner`, `Messenger` (k relays, ack, retry, dedupe, persisted), `PoolTransport`, message body types, `MSG` |
| trust | `effectiveCombinations`, `matchingEntries`, `covers`, `latestByAddress`, parsers and `*Template` builders for 30500–30503/10050, `TrustDirectory` |
| fx | `FrankfurterSource`, `CoingeckoSource`, `ChainlinkSource`, `StaticSource`, `computePair`, `getRate`, `checkQuoteRate` |
| btc | `witnessScript`, `p2wshAddress`, `EsploraClient`, `buildFundingTx`, `buildEscrowSpend`, `signEscrowInput`, `finalizeEscrowInput` (multisig / T1 / T2), PSBT base64 helpers |
| evm | `safeInitializer`, `predictSafeAddress`, `orderSafeAddress`, `releaseSafeTx`, `splitSafeTx`, `encodeMultiSend`, `safeTxHash`, `signSafeTx`, `packSignatures`, `EvmClient` (deploy, fund, exec, module, bond) |
| delivery | `encryptAddress`, `decryptAddress`, `sealDelivery`, `unwrapDeliveryKey` |
| flows | `Session`, `UserClient`, `EscrowClient`, `OperatorClient`, `CoordinatorClient`, `ShopperProfile`, `checkQuote` |

## Notes

- The mnemonic is stored unencrypted in the origin's IndexedDB (lab grade).
- The browser talks to Esplora, the EVM RPC, rate sources and the faucet directly, so those
  endpoints must send CORS headers.
- UI test ids: `apps/web/TESTIDS.md`.
