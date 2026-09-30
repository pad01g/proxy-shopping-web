# Installing the proxy-shopping MCP server (for AI agents)

The server runs locally over **stdio** in Docker. It needs **no API key and no environment variables** to start.

1. Check that Docker is available: `docker version`. (Without Docker, see "Without Docker" below.)
2. Add this to the MCP settings (Cline: `cline_mcp_settings.json`; other clients: their `mcpServers` config):

   ```json
   {
     "mcpServers": {
       "proxy-shopping": {
         "command": "docker",
         "args": ["run", "-i", "--rm", "-v", "proxy-shopping-mcp:/data", "ghcr.io/pad01g/proxy-shopping-mcp:0.1.2"],
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```

   Do **not** put money-moving tools (`fund_order`, `confirm_receipt`, `countersign_ruling`, `accept_refund_offer`,
   `refund_after_timelock`) or `export_backup` in `autoApprove`.
3. Restart / reload the MCP servers and call `network_info`. It should answer with the network `ps-main`, its relays
   and how many shopper × escrow combinations are trusted (the public network is new and may have none yet).
4. Call `wallet` to see this agent's identity and BTC signet address. A new key is created on first run and kept in the
   Docker volume `proxy-shopping-mcp` — tell the user to keep that volume (it controls the escrow of open orders);
   `export_backup {confirm: true}` shows the recovery words only when the user asks for them.

Tell the user: payments on `ps-main` are BTC **signet** (test coins with no market value); tools that move money do
nothing without `confirm: true`, and you should ask them before confirming.

## Without Docker

Node 22 or later, from a clone of https://github.com/pad01g/proxy-shopping-web:

```sh
npm ci && npm run build -w @proxy-shopping/core && npm run build -w @proxy-shopping/mcp
```

then use `"command": "node", "args": ["<absolute path to the clone>/packages/mcp/dist/server.js"]`. The key and orders
are kept in `~/.proxy-shopping-mcp` (override with `PS_DATA_DIR`).

## Optional settings

- `PS_NETWORK=lab` with `PS_LAB_URL=http://host.docker.internal:8888` (and Docker arg
  `--add-host=host.docker.internal:host-gateway`): practise against the local docker compose lab of
  https://github.com/pad01g/proxy-shopping-go, which has shoppers, fake shops and a faucet (`lab_faucet`).
- `PS_CONFIG_URL` / `PS_CONFIG_FILE`: a web-app `config.json` that overrides the network preset.

## Earning instead of buying

`become_shopper` returns the plan for running a proxy shopper node (buying at local shops for remote users for a fee),
and `registry_entry` the file for getting listed. Neither starts anything.
