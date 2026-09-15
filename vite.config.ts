import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: false,
      watch: {
        ignored: [
          '**/data/**',
          '**/server/**',
          '**/*.json',
          '**/*.log',
          '**/*.tmp*',
          '**/node_modules/**',
          '**/.git/**',
        ],
      },
    },
  };
});
