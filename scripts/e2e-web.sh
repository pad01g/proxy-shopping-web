#!/bin/sh
# Drive the built web app in Chromium (Playwright) against a mini lab:
# bitcoind + anvil + relay (services.sh) and apps/web/e2e/minilab.mjs (shopper/escrow/operator/faucet/static server).
set -eu
. "$(dirname "$0")/services.sh"
trap services_down EXIT
services_up

echo "building core and web"
docker run --rm -v "$ROOT":/src -v ps-npm:/root/.npm -w /src node:22-bookworm sh -c \
  'npm run build -w @proxy-shopping/core >/dev/null && npm run build -w @proxy-shopping/web >/dev/null'

docker run -d --name "$P-lab" --network "$NET" --network-alias lab -v "$ROOT":/src -w /src/apps/web \
  -e BITCOIND_RPC=http://lab:lab@bitcoind:38332 -e ANVIL_RPC=http://anvil:8545 -e RELAY_URL=ws://relay:8080 \
  -e DEPLOYMENTS=/src/packages/core/test/.it/31337.json -e PUBLIC_HOST=lab \
  node:22-bookworm node e2e/minilab.mjs >/dev/null
i=0
until docker logs "$P-lab" 2>&1 | grep -q "minilab ready"; do
  i=$((i + 1))
  if [ "$i" -ge 300 ] || [ "$(docker inspect -f '{{.State.Running}}' "$P-lab")" != "true" ]; then
    docker logs "$P-lab" 2>&1 | tail -40
    exit 1
  fi
  sleep 1
done
docker logs "$P-lab" 2>&1 | tail -3

docker run --rm --network "$NET" -v "$ROOT":/src -w /src/apps/web -e APP_URL=http://lab:8080 \
  mcr.microsoft.com/playwright:v1.55.0-noble npx playwright test -c e2e/playwright.config.ts "$@" || {
    echo "--- minilab log ---"; docker logs "$P-lab" 2>&1 | tail -40; exit 1; }
