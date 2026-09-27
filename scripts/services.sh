# Shared by integration.sh and e2e-web.sh: start/stop bitcoind, anvil (+ lab contracts) and a Nostr relay.
# shellcheck shell=sh
ROOT=$(cd "$(dirname "$0")/.." && pwd)
GO_DIR=${GO_DIR:-$(cd "$ROOT/../proxy-shopping-go" 2>/dev/null && pwd || echo "")}
NET=ps-web-it
P=ps-web-it
OUT="$ROOT/packages/core/test/.it"

services_down() {
  docker rm -f "$P-bitcoind" "$P-anvil" "$P-relay" "$P-lab" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

services_up() {
  services_down
  mkdir -p "$OUT"
  rm -f "$OUT/31337.json"
  docker network create "$NET" >/dev/null
  docker run -d --name "$P-bitcoind" --network "$NET" --network-alias bitcoind bitcoin/bitcoin:29.0 \
    -signet -signetchallenge=51 -server -txindex=1 -rpcuser=lab -rpcpassword=lab \
    -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 -fallbackfee=0.0002 -printtoconsole=0 >/dev/null
  docker run -d --name "$P-anvil" --network "$NET" --network-alias anvil --entrypoint anvil \
    ghcr.io/foundry-rs/foundry:stable --host 0.0.0.0 --chain-id 31337 >/dev/null
  docker run -d --name "$P-relay" --network "$NET" --network-alias relay scsibug/nostr-rs-relay:latest >/dev/null
  if [ -n "$GO_DIR" ] && [ -x "$GO_DIR/contracts/deploy.sh" ]; then
    echo "deploying contracts from $GO_DIR/contracts (on a copy)"
    docker run --rm --network "$NET" --user root -v "$GO_DIR/contracts":/ro:ro -v "$OUT":/out \
      --entrypoint sh ghcr.io/foundry-rs/foundry:stable -c \
      'cp -r /ro /work && cd /work && RPC_URL=http://anvil:8545 OUT=/out/31337.json ./deploy.sh >/out/deploy.log 2>&1 || { tail -30 /out/deploy.log; exit 1; }'
  else
    echo "contracts not found; EVM tests will be skipped"
  fi
}
