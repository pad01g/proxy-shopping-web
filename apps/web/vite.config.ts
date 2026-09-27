import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // No source maps in production builds (they would publish the full source next to the app).
  build: { target: 'es2022', sourcemap: mode !== 'production', chunkSizeWarningLimit: 2000 },
  server: { host: true, port: 5173 },
}));
