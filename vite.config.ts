import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import manifest from './package.json' with { type: 'json' };

export default defineConfig({
  base: './',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(manifest.version) },
  build: { outDir: 'dist/renderer' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.PORT ?? '8080'}`,
    },
  },
});
