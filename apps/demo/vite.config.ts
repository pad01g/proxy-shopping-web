import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// The demo talks to the lab through its own server (same origin): /relay-1, /esplora, /evm, /faucet, /node/…
// For `npm run dev`, point DEMO_SERVER at a running demo server (e.g. http://localhost:8888) to proxy those paths.
// Mock mode (?mock=1, or VITE_DEMO_MOCK=1 as in .env.pages) needs no server at all: see src/mock.
const server = process.env.DEMO_SERVER;
const proxied = ['/demo-config.json', '/relay-1', '/relay-2', '/esplora', '/evm', '/faucet', '/rates', '/deployments', '/node'];

/**
 * GitHub Pages cannot send headers, so the pages build carries its Content-Security-Policy in the page: scripts,
 * workers and connections only to its own origin (in mock mode nothing else is needed).
 */
const pagesCsp = (): Plugin => ({
  name: 'pages-csp',
  transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'" />`),
});

export default defineConfig(({ mode }) => ({
  plugins: mode === 'pages' ? [react(), pagesCsp()] : [react()],
  // `--mode pages` (GitHub Pages) uses relative URLs, so the static files work below any path without rewrites.
  base: process.env.DEMO_BASE ?? (mode === 'pages' ? './' : '/'),
  build: { target: 'es2022', sourcemap: mode !== 'production' && mode !== 'pages', chunkSizeWarningLimit: 4000 },
  // The mock world runs in a module (Shared)Worker.
  worker: { format: 'es' },
  server: {
    host: true,
    port: 5174,
    proxy: server ? Object.fromEntries(proxied.map((p) => [p, { target: server, ws: true, changeOrigin: true }])) : undefined,
  },
}));
