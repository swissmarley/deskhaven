import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { devPorts } from './config/dev-ports';

const ports = devPorts(process.env);

export default defineConfig({
  plugins: [react()],
  server: {
    port: ports.web,
    // The server only accepts this exact port as an origin: fail instead of drifting to another one.
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${ports.api}`, changeOrigin: false },
      '/ws': { target: `ws://127.0.0.1:${ports.api}`, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
