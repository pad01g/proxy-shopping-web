import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The demo talks to the lab through its own server (same origin): /relay-1, /esplora, /evm, /faucet, /node/…
// For `npm run dev`, point DEMO_SERVER at a running demo server (e.g. http://localhost:8888) to proxy those paths.
const server = process.env.DEMO_SERVER;
const proxied = ['/demo-config.json', '/relay-1', '/relay-2', '/esplora', '/evm', '/faucet', '/rates', '/deployments', '/node'];

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build: { target: 'es2022', sourcemap: mode !== 'production', chunkSizeWarningLimit: 2000 },
  server: {
    host: true,
    port: 5174,
    proxy: server ? Object.fromEntries(proxied.map((p) => [p, { target: server, ws: true, changeOrigin: true }])) : undefined,
  },
}));
