import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :4000; the proxy keeps cookies same-origin so no CORS or SameSite workarounds are needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:4000', changeOrigin: false } },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 900 },
});
