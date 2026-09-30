// A tiny static server for the e2e: the production build (dist) below a base path, like GitHub Pages serves it
// (https://pad01g.github.io/proxy-shopping-web/). No rewrites: unknown paths are 404.
//   node e2e/serve.mjs [dist] [port] [base]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? 4173);
const base = process.argv[4] ?? '/proxy-shopping-web/';
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain', '.map': 'application/json',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let path = decodeURIComponent(url.pathname);
  if (!path.startsWith(base)) {
    res.writeHead(path === base.slice(0, -1) ? 301 : 404, path === base.slice(0, -1) ? { location: base } : {});
    return res.end();
  }
  path = path.slice(base.length) || 'index.html';
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const st = await stat(file);
    const f = st.isDirectory() ? join(file, 'index.html') : file;
    const body = await readFile(f);
    res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, '0.0.0.0', () => console.log(`serving ${root} at http://localhost:${port}${base}`));
