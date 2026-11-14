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
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'clsx',
        'tailwind-merge',
        'lucide-react',
        'lightweight-charts',
        'recharts',
        'date-fns',
      ],
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
