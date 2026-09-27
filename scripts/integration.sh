#!/bin/sh
# Integration tests for @proxy-shopping/core against real services in docker:
#   bitcoind (custom signet, challenge OP_TRUE), anvil + lab contracts, nostr-rs-relay.
# Needs only docker on the host. Usage: scripts/integration.sh [vitest args]
set -eu
. "$(dirname "$0")/services.sh"
trap services_down EXIT
services_up

GO_MOUNT=""
[ -n "$GO_DIR" ] && GO_MOUNT="-v $GO_DIR:/proxy-shopping-go:ro"
# shellcheck disable=SC2086
docker run --rm --network "$NET" -v "$ROOT":/src $GO_MOUNT -v ps-npm:/root/.npm -w /src/packages/core \
  -e BITCOIND_RPC=http://lab:lab@bitcoind:38332 \
  -e ANVIL_RPC=http://anvil:8545 \
  -e RELAY_URL=ws://relay:8080 \
  -e DEPLOYMENTS=/src/packages/core/test/.it/31337.json \
  node:22-bookworm npx vitest run --dir test/integration --no-file-parallelism "$@"
