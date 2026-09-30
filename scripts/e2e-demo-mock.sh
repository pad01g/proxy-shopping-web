#!/bin/sh
# The demo in mock mode (everything in the browser), end to end: build the GitHub Pages bundle
# (apps/demo, `vite build --mode pages` → apps/demo/dist-pages), serve it like Pages does
# (http://localhost:4173/proxy-shopping-web/) and follow the guide of all 7 scenarios, normal-btc in English and
# the separate-windows mode in Chromium (apps/demo/e2e/mock.spec.ts), failing on any request that leaves the page.
#   scripts/e2e-demo-mock.sh                    # everything
#   DEMO_SCENARIOS=normal-btc,separate scripts/e2e-demo-mock.sh
#   DEMO_URL=https://pad01g.github.io/proxy-shopping-web/ SKIP_BUILD=1 scripts/e2e-demo-mock.sh   # the live site
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "building core and the demo (pages mode)"
  docker run --rm -v "$ROOT":/src -v ps-npm:/root/.npm -w /src node:22-bookworm sh -c \
    '[ -d node_modules/@ethereumjs/vm ] || npm ci --no-audit --no-fund; npm run build -w @proxy-shopping/core >/dev/null && npm run build:pages -w @proxy-shopping/demo'
fi

URL="${DEMO_URL:-http://localhost:4173/proxy-shopping-web/}"
docker run --rm --ipc=host -v "$ROOT":/src -w /src/apps/demo -e DEMO_URL="$URL" -e DEMO_SCENARIOS="${DEMO_SCENARIOS:-}" \
  mcr.microsoft.com/playwright:v1.55.0-noble sh -c '
    case "$DEMO_URL" in http://localhost*) node e2e/serve.mjs dist-pages 4173 /proxy-shopping-web/ & sleep 1 ;; esac
    npx playwright test -c e2e/playwright.config.ts'
