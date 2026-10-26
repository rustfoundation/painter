import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.RENDER_API_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});
