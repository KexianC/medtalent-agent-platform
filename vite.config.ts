import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
  root: process.cwd(),
  resolve: { tsconfigPaths: true },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: env.API_PROXY_TARGET || `http://127.0.0.1:${env.PORT || 8788}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    sourcemap: false,
  },
  plugins: [
    react({
      babel: mode === 'development' ? {
        plugins: [
          'react-dev-locator',
        ],
      } : undefined,
    }),
  ],
  };
})
