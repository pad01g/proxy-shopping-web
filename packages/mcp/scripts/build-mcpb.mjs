// Build packages/mcp/dist-mcpb/proxy-shopping-<version>.mcpb: the MCP server bundled into one file (esbuild), the
// manifest with this package's version and the tools the server really lists, and the icon. Run after
// `npm run build -w @proxy-shopping/core`, from the repository root: node packages/mcp/scripts/build-mcpb.mjs
import { build } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(pkgDir, 'dist-mcpb');
const stage = join(out, 'stage');
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });
await build({
  entryPoints: [join(pkgDir, 'src/server.ts')],
  outfile: join(stage, 'server/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // ws: optional native speedups are not needed.
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
});
writeFileSync(join(stage, 'server/package.json'), JSON.stringify({ type: 'module' }));

// The tools the bundled server lists (it starts without network access; the data dir is a throwaway).
const tools = await new Promise((resolve, reject) => {
  const tmp = join(out, 'probe-data');
  const p = spawn('node', [join(stage, 'server/index.js')], { env: { ...process.env, PS_DATA_DIR: tmp }, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const timer = setTimeout(() => { p.kill(); reject(new Error('no tools/list answer')); }, 30000);
  p.stdout.on('data', (d) => {
    buf += d;
    for (const line of buf.split('\n')) {
      try {
        const m = JSON.parse(line);
        if (m.id === 2) { clearTimeout(timer); p.kill(); rmSync(tmp, { recursive: true, force: true }); resolve(m.result.tools); }
      } catch { /* partial line */ }
    }
  });
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'build-mcpb', version } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
});

const manifest = JSON.parse(readFileSync(join(pkgDir, 'mcpb/manifest.template.json'), 'utf8'));
manifest.version = version;
manifest.tools = tools.map((t) => ({ name: t.name, description: t.title ?? t.name }));
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
cpSync(join(pkgDir, 'logo.png'), join(stage, 'icon.png'));
cpSync(join(pkgDir, '../../LICENSE'), join(stage, 'LICENSE'));

const file = join(out, `proxy-shopping-${version}.mcpb`);
execFileSync('npx', ['--yes', '@anthropic-ai/mcpb@latest', 'validate', join(stage, 'manifest.json')], { stdio: 'inherit' });
execFileSync('npx', ['--yes', '@anthropic-ai/mcpb@latest', 'pack', stage, file], { stdio: 'inherit' });
console.log(`${file} (${tools.length} tools)`);
