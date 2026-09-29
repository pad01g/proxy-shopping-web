# AGENTS.md

## Using proxy-shopping as an agent

proxy-shopping is a P2P network for **buying with crypto at shops that accept only cash or other payments you
cannot use**, and for **earning as a proxy shopper**. Money waits in a per-order 2-of-3 escrow with timelocks.
Overview: https://pad01g.github.io/proxy-shopping-docs/llms.txt

- **MCP server** (this repo, `packages/mcp`, registry name `io.github.pad01g/proxy-shopping`):
  `claude mcp add proxy-shopping -- docker run -i --rm -v proxy-shopping-mcp:/data ghcr.io/pad01g/proxy-shopping-mcp:0.1.0`.
  Tools: `network_info`, `wallet`, `find_offers`, `request_quote`, `accept_quote`, `fund_order`, `confirm_receipt`,
  `open_dispute`, `countersign_ruling`, `refund_after_timelock`, `become_shopper`, `registry_entry`, …
  Anything that moves money needs `confirm: true`.
- **Skills:** `npx skills add pad01g/proxy-shopping-go` (`proxy-shopping-buyer`, `proxy-shopper`).
- **Library:** `@proxy-shopping/core` (`packages/core`) is the same protocol code the web app and MCP server use.

The public network `ps-main` is new and runs on BTC signet (test coins). Tell your human; never confirm payments
on their behalf without asking.

## Developing

- The protocol spec lives in `../proxy-shopping-go/docs/spec.md`; the Go node implements it too. Cross-language
  vectors: `../proxy-shopping-go/docs/test-vectors.json` (the vector test fails if the file is missing; set
  `SKIP_VECTORS=1` only when you really cannot mount it).
- Workspaces: `packages/core` (protocol), `packages/mcp` (MCP server), `apps/web` (public app), `apps/demo` (guided
  all-roles demo). Run in Docker (no host Node assumed):
  `docker run --rm -v "$PWD":/src -v ps-npm:/root/.npm -v "$PWD/../proxy-shopping-go":/proxy-shopping-go:ro -w /src node:22-bookworm sh -c "npm ci && npm run typecheck && npm test && npm run build"`;
  integration and UI e2e: `scripts/integration.sh`, `scripts/e2e-web.sh`; the full lab e2e runs from proxy-shopping-go.
- UI tests rely on `data-testid`s (`apps/web/TESTIDS.md`, `apps/demo/TESTIDS.md`); keep them stable.
- Never auto-sign money movements; validate every received body (`nostr/schema.ts`); settle only on chain evidence.
