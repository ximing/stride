import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiPort = process.env.STRIDE_API_PORT || '1421'

export default defineConfig({
  plugins: [react()],
  // esbuild prebundling rewrites import.meta.url, so the vane worker 404s and vault open never finishes.
  optimizeDeps: {
    exclude: ['@vane-rs/web'],
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
  clearScreen: false,
})
