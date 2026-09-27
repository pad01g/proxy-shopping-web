// A small stand-in for the Go lab, used to drive the built web app with Playwright:
// bitcoind (via an Esplora shim), anvil, a Nostr relay, a scripted TS shopper,
// escrow/operator/coordinator from the lab keys, a faucet and a static file server.
// Env: BITCOIND_RPC, ANVIL_RPC, RELAY_URL, DEPLOYMENTS, PUBLIC_HOST (hostname the browser uses).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFundingTx, EsploraClient, EvmClient, KeySet, PoolTransport, erc20Abi } from '@proxy-shopping/core';
import { createWorld, LAB_MNEMONICS, LAB_TIMELOCK_POLICY } from '@proxy-shopping/core/testing';
import { BitcoindRpc, startEsploraShim } from '@proxy-shopping/core/testing/node';
import { numberToHex } from 'viem';

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const HOST = process.env.PUBLIC_HOST ?? 'localhost';
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const deployments = JSON.parse(await readFile(env('DEPLOYMENTS'), 'utf8'));

const rpc = new BitcoindRpc(env('BITCOIND_RPC'));
await rpc.waitReady();
const shim = await startEsploraShim(rpc, { port: 3000, host: '0.0.0.0' });
const chain = new EsploraClient('http://127.0.0.1:3000');

const faucetKeys = KeySet.fromMnemonic(LAB_MNEMONICS.faucet);
const burn = KeySet.fromMnemonic(LAB_MNEMONICS['coordinator-1']).btcWallet.address;
console.log('mining initial blocks…');
await rpc.mine(5, faucetKeys.btcWallet.address);
await rpc.mine(100, burn);
setInterval(async () => {
  const pool = await rpc.call('getrawmempool').catch(() => []);
  if (pool.length) await rpc.mine(1, burn).catch(() => undefined);
}, 700);

const anvil = env('ANVIL_RPC');
const faucetEvm = new EvmClient(deployments.chain_id, anvil, faucetKeys.evmAccount, deployments);
async function fundEvm(address, usdc = 1000_000000n) {
  await faucetEvm.public.request({ method: 'anvil_setBalance', params: [address, numberToHex(10n ** 20n)] });
  if (usdc > 0n) {
    await faucetEvm.public.request({ method: 'anvil_setBalance', params: [faucetKeys.evmAddress, numberToHex(10n ** 20n)] });
    const hash = await faucetEvm.wallet.writeContract({ address: deployments.usdc, abi: erc20Abi, functionName: 'mint', args: [address, usdc] });
    await faucetEvm.public.waitForTransactionReceipt({ hash });
  }
}

const world = await createWorld({ relays: [env('RELAY_URL')], transport: () => new PoolTransport(), chain, retryIntervalMs: 3000 });
for (const name of ['shopper-1', 'escrow-1']) {
  await fundEvm(world.keys[name].evmAddress, 0n);
  world.sessions[name].evm = new EvmClient(deployments.chain_id, anvil, world.keys[name].evmAccount, deployments);
}
world.escrow.setDeployments(deployments);
console.log('trust set up: coordinator', world.keys['coordinator-1'].nostrPublicKey);

// ---- faucet (docs/lab.md subset) ----
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
  res.end(JSON.stringify(body));
};
createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  let body = '';
  for await (const c of req) body += c;
  try {
    const p = body ? JSON.parse(body) : {};
    if (req.url === '/btc') {
      const utxos = await chain.utxos(faucetKeys.btcWallet.address);
      const tx = buildFundingTx({ wallet: faucetKeys.btcWallet, utxos, outputs: [{ address: p.address, amount: BigInt(p.sats ?? 1_000_000) }], feeRate: 2 });
      await chain.broadcast(tx.hex);
      await rpc.mine(1, burn);
      return json(res, 200, { txid: tx.txid });
    }
    if (req.url === '/evm') {
      await fundEvm(p.address, BigInt(Math.round(Number(p.usdc ?? '1000') * 1e6)));
      return json(res, 200, { ok: true });
    }
    if (req.url === '/mine') return json(res, 200, { height: (await rpc.mine(p.blocks ?? 1, burn)).length });
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}).listen(3001, '0.0.0.0');

// ---- static web app with /config.json ----
const config = {
  network: 'ps-lab',
  relays: [env('RELAY_URL')],
  coordinators: [world.keys['coordinator-1'].nostrPublicKey],
  esplora: `http://${HOST}:3000`,
  evm_rpc: process.env.PUBLIC_ANVIL_RPC ?? anvil,
  chain_id: deployments.chain_id,
  deployments_url: '/deployments/31337.json',
  rates: [{ type: 'static', rates: { 'BTC/JPY': 15000000, 'USDC/JPY': 150 } }],
  faucet_url: `http://${HOST}:3001`,
  // same names and values as proxy-shopping-go/lab/web-config.json
  timelock_policy: LAB_TIMELOCK_POLICY,
  allow_private_endpoints: true,
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json' };
createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/config.json') return json(res, 200, config);
  if (path === '/deployments/31337.json') return json(res, 200, deployments);
  const file = normalize(join(DIST, path));
  try {
    const data = await readFile(file.startsWith(DIST) && extname(file) ? file : join(DIST, 'index.html'));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/html' });
    res.end(data);
  } catch {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(await readFile(join(DIST, 'index.html')));
  }
}).listen(8080, '0.0.0.0');

console.log(`minilab ready: app http://${HOST}:8080 esplora ${shim.url} faucet :3001`);
