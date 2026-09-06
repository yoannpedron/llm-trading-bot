import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Dev proxy: the browser calls `/xtream/<encoded host[:port]>/…` and Vite
 * forwards it to `http://<host[:port]>/…`. Avoids CORS on Xtream servers and
 * hides nothing (credentials are query params on the Xtream side anyway).
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/xtream': {
        target: 'http://placeholder.invalid',
        changeOrigin: true,
        router: (req: { url?: string }) => {
          const m = req.url?.match(/^\/xtream\/([^/]+)/)
          const host = m ? decodeURIComponent(m[1]) : 'placeholder.invalid'
          return host.startsWith('http') ? host : `http://${host}`
        },
        rewrite: (p) => p.replace(/^\/xtream\/[^/]+/, ''),
      },
    },
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0])
