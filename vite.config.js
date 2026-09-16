import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client lives in ./client. In dev, API calls to /api are proxied to the
// Express backend on port 3001. In production, the backend serves client/dist.
export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
