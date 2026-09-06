import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import http from 'node:http'
import https from 'node:https'

/**
 * Dev proxy: the browser calls `/xtream/<host[:port]>/…` and the dev server forwards it to
 * `http://<host[:port]>/…`, streaming the body both ways (lists are 50-90 MB, videos are GB).
 * Avoids CORS on Xtream servers. In production, serve dist/ behind an equivalent reverse proxy.
 */
function xtreamProxy(): Plugin {
  return {
    name: 'xtream-proxy',
    configureServer(server) { server.middlewares.use(handler) },
    configurePreviewServer(server) { server.middlewares.use(handler) },
  }
}
function handler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) {
  {
      {
        const m = /^\/xtream\/([^/]+)(\/.*)?$/.exec(req.url ?? '')
        if (!m) return next()
        const host = decodeURIComponent(m[1])
        const secure = host.startsWith('https:')
        const target = new URL((host.startsWith('http') ? host : 'http://' + host).replace(/\/+$/, '') + (m[2] ?? '/'))
        const headers: Record<string, string> = {}
        for (const k of ['range', 'accept', 'accept-encoding', 'user-agent', 'if-range', 'if-none-match']) { const v = req.headers[k]; if (typeof v === 'string') headers[k] = v }
        headers.host = target.host
        const up = (secure ? https : http).request(target, { method: req.method, headers }, (r) => {
          const out: Record<string, string | string[] | undefined> = {}
          for (const [k, v] of Object.entries(r.headers)) if (!['connection', 'transfer-encoding', 'keep-alive'].includes(k)) out[k] = v
          // follow the Xtream 302 to the content server transparently so the browser keeps one origin
          if (r.statusCode === 302 && r.headers.location && /\/(movie|series|live)\//.test(target.pathname)) {
            r.resume()
            const loc = r.headers.location
            const up2 = (loc.startsWith('https') ? https : http).request(loc, { method: req.method, headers: { ...headers, host: new URL(loc).host } }, (r2) => {
              const o2: Record<string, string | string[] | undefined> = {}
              for (const [k, v] of Object.entries(r2.headers)) if (!['connection', 'transfer-encoding', 'keep-alive'].includes(k)) o2[k] = v
              res.writeHead(r2.statusCode ?? 502, o2); r2.pipe(res)
            })
            up2.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e)) })
            res.on('close', () => { if (!res.writableFinished) up2.destroy() }); up2.end(); return
          }
          res.writeHead(r.statusCode ?? 502, out); r.pipe(res)
        })
        up.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e)) })
        res.on('close', () => { if (!res.writableFinished) up.destroy() })
        req.pipe(up)
      }
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), xtreamProxy()],
  worker: { format: 'es' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
} as Parameters<typeof defineConfig>[0])
