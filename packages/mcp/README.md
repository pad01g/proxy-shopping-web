# proxy-shopping MCP server

An [MCP](https://modelcontextprotocol.io/) server that lets an AI agent use the proxy-shopping P2P network as tools:

- **Buy from cash-only or unsupported shops with crypto through a proxy shopper, with a 2-of-3 escrow.** You pay BTC
  into a per-order escrow (you, the shopper, an escrow); the shopper buys and ships; you release the payment when the
  items arrive. If something goes wrong the escrow rules a split, and after the T2 timelock you can take everything
  back alone.
- **Earn as a proxy shopper.** A precise plan for running the always-online shopper node, and the registry entry
  for getting listed.

It runs next to the agent (stdio) as one participant with its own key. Protocol logic is `@proxy-shopping/core`, the
same code the web app runs. The session stays up while the server runs, so quotes, shipping updates and rulings keep
arriving and are stored in the data directory. Registry name: `io.github.pad01g/proxy-shopping`.

**The public network `ps-main` is new.** There may be no trusted shoppers yet (`network_info` says how many shopper ×
escrow combinations are trusted). Payments there are BTC on **signet**, a test network whose coins have no market
value. USDC is not available on ps-main yet.

## Run

Claude Code:

```sh
claude mcp add proxy-shopping -- docker run -i --rm -v proxy-shopping-mcp:/data ghcr.io/pad01g/proxy-shopping-mcp:0.1.1
```

Other clients (`mcp.json`):

```json
{
  "mcpServers": {
    "proxy-shopping": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "proxy-shopping-mcp:/data", "ghcr.io/pad01g/proxy-shopping-mcp:0.1.1"]
    }
  }
}
```

The volume at `/data` holds the key and the orders. **Keep it**: without it you lose the key that controls the
escrow of every open order (back it up with `export_backup`). One data dir = one identity; use a separate volume per
agent or per person.

The local docker compose lab (proxy-shopping-go, demo server on `http://localhost:8888`):

```sh
claude mcp add proxy-shopping-lab -- docker run -i --rm --add-host=host.docker.internal:host-gateway \
  -v proxy-shopping-mcp-lab:/data -e PS_NETWORK=lab -e PS_LAB_URL=http://host.docker.internal:8888 \
  ghcr.io/pad01g/proxy-shopping-mcp:0.1.1
```

Without Docker (Node 22, from the repository root): `npm ci && npm run build -w @proxy-shopping/core -w @proxy-shopping/mcp`,
then `node packages/mcp/dist/server.js` (bin `proxy-shopping-mcp`).

| Variable | Default | Meaning |
|---|---|---|
| `PS_NETWORK` | `ps-main` | `ps-main`: public Nostr relays (relay.damus.io, nos.lol, relay.primal.net), BTC signet via mempool.space, coordinators and signed trust events from the [registry](https://github.com/pad01g/proxy-shopping-registry). `lab`: the compose lab through its demo server |
| `PS_DATA_DIR` | `~/.proxy-shopping-mcp` (image: `/data`) | the mnemonic (`mnemonic`, mode 0600, created on first run) and the state per network (`state-<network>.json`) |
| `PS_LAB_URL` | `http://localhost:8888` | lab only: the demo server (relays at `/relay-1` `/relay-2`, `/esplora`, `/evm`, `/faucet`, `/rates`, `/deployments/31337.json`) |
| `PS_CONFIG_URL` / `PS_CONFIG_FILE` | unset | a web-app `config.json` (format of `proxy-shopping-go/lab/web-config.json`: `relays`, `coordinators`, `esplora`, `evm_rpc`, `deployments_url`, `rates`, `timelock_policy`, …) that overrides the preset |
| `PS_COORDINATORS` | unset | comma-separated coordinator pubkeys that replace the preset's trust roots |

## Tools

| Tool | What it does |
|---|---|
| `network_info` | network, relays, coordinators, chains, how many shopper × escrow combinations are trusted, an honest status |
| `wallet` | identity pubkey, BTC signet address and balance (EVM/USDC where the network has it) |
| `lab_faucet` | lab only: test BTC / USDC to this wallet, mine blocks |
| `find_offers` | trusted shopper × escrow combinations for a shop URL, region and payment, with fees, cash regions and provenance (coordinator → operator list) |
| `request_quote` | order from one combination and wait for the quote; returns its validation: rate deviation from our own sources, the recomputed escrow address, the timelocks |
| `get_order` / `list_orders` | status, timeline and next steps; `get_order` can wait for a status |
| `accept_quote` | accept a valid quote (a strong rate deviation needs `acknowledge_rate_deviation`) |
| `fund_order` | **moves money**: pay the lock and the escrow upfront fee (`confirm: true`) |
| `confirm_receipt` | **moves money**: items received, sign the payout to the shopper (`confirm: true`) |
| `open_dispute` | ask the escrow to decide; hands it the evidence and the key to your address (`confirm: true`) |
| `review_ruling` / `countersign_ruling` | check the escrow's split, then co-sign it (**moves money**, `confirm: true`) |
| `accept_refund_offer` | **moves money**: co-sign the shopper's cooperative refund (`confirm: true`) |
| `refund_after_timelock` | **moves money**: after T2, take the funds back alone (`confirm: true`) |
| `cancel_order` | cancel before funding |
| `report` | report the shopper or escrow to the operator that listed them |
| `export_backup` | show the 12-word mnemonic (`confirm: true`) |
| `become_shopper` | the plan for earning as a proxy shopper: requirements, fees, node config and compose file for ps-main, how to get listed |
| `registry_entry` | the exact file for a pull request to the [registry](https://github.com/pad01g/proxy-shopping-registry), in its format: `shoppers/<name>.json` `{pk, contact, description, regions (cash regions), payments, escrows}`, `escrows/<name>.json` `{pk, contact, description, sla_days}`, `operators/<name>.json` `{pk, contact, description, regions}`, `coordinators/<name>.json` `{pk, contact, description, url?, bundle?}` |

A purchase: `network_info` → `wallet` (fund it) → `find_offers` → `request_quote` → `accept_quote` → `fund_order`
→ (`get_order` until `delivered`) → `confirm_receipt`.

Every tool answers with a short text plus the same data as structured JSON.

## Safety

- Tools that move money or disclose secrets do nothing without `confirm: true`; without it they show what would
  happen (amounts, recipients, fees). An agent should show that to its human and ask before confirming.
- A quote that fails validation (combination not trusted, escrow address that does not match our own computation,
  timelocks outside the policy, amounts that do not add up) cannot be accepted. A rate more than 10 % away from our
  own sources needs an explicit acknowledgement.
- Payouts are signed only for the template the protocol allows (release to the shopper, a refund to you, a ruling that
  matches its split); `completed` / `settled` / `refunded` are reported only once the chain shows the payment.
- The mnemonic never leaves the data dir except through `export_backup`. The delivery address is encrypted for the
  shopper; the escrow can read it only when you open a dispute.
- Trust comes only from the coordinators you configure (`network_info` lists them and where they came from). Orders are
  only as good as the shoppers and escrows that operators list.

## Test

```sh
# from the repository root, in Docker (no host Node needed)
docker run --rm -v "$PWD":/src -v ps-npm:/root/.npm -w /src node:22-bookworm \
  sh -c "npm ci && npm run build -w @proxy-shopping/core && npm test -w @proxy-shopping/mcp"

# end to end against the running compose lab: a BTC order through MCP tool calls over stdio
docker run --rm --add-host=host.docker.internal:host-gateway -v "$PWD":/src -v ps-npm:/root/.npm -w /src/packages/mcp \
  -e PS_LAB_URL=http://host.docker.internal:8888 node:22-bookworm npm run test:lab
```

The unit tests drive every tool through an MCP client against core's in-memory world (relays, chain, a scripted
shopper and an escrow), and run the registry's own validator (`proxy-shopping-registry/scripts/registry.ts validate`) on
the files `registry_entry` writes; they expect `../proxy-shopping-registry` next to this repository (or `PS_REGISTRY_DIR`,
or mounted at `/proxy-shopping-registry`; `SKIP_REGISTRY=1` skips it). Add `-v "$PWD/../proxy-shopping-registry":/proxy-shopping-registry:ro` to the Docker command above.
