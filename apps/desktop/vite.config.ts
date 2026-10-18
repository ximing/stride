import http from 'node:http'
import https from 'node:https'
import react from '@vitejs/plugin-react'
import { defineConfig, type Connect, type Plugin } from 'vite'

function llmProxyPlugin(): Plugin {
  const attach = (middlewares: Connect.Server) => {
    middlewares.use('/llm-proxy', (req, res) => {
      const raw = String(req.url || '/')
      const q = raw.indexOf('?')
      const pathOnly = q === -1 ? raw : raw.slice(0, q)
      const search = q === -1 ? '' : raw.slice(q)
      const match = /^\/(https?)\/([^/]+)(\/.*)?$/.exec(pathOnly)
      if (!match) {
        res.statusCode = 400
        res.end('bad llm proxy path')
        return
      }
      const lib = match[1] === 'https' ? https : http
      const headers = { ...req.headers }
      delete headers.host
      delete headers.connection
      const host = match[2] ?? ''
      const colon = host.lastIndexOf(':')
      // One colon is host:port. More than one is an IPv6 literal and stays whole.
      const portText = colon !== -1 && host.indexOf(':') === colon ? host.slice(colon + 1) : ''
      const port = /^\d+$/.test(portText) ? Number(portText) : undefined
      const proxyReq = lib.request({
        protocol: `${match[1]}:`,
        hostname: port === undefined ? host : host.slice(0, colon),
        ...(port === undefined ? {} : { port }),
        path: `${match[3] || '/'}${search}`,
        method: req.method,
        headers,
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
        proxyRes.pipe(res)
      })
      proxyReq.on('error', () => {
        if (!res.headersSent) res.statusCode = 502
        res.end('llm proxy failed')
      })
      req.pipe(proxyReq)
    })
  }
  return {
    name: 'stride-llm-proxy',
    configureServer(server) { attach(server.middlewares) },
    configurePreviewServer(server) { attach(server.middlewares) },
  }
}

export default defineConfig({
  plugins: [react(), llmProxyPlugin()],
  // esbuild prebundling rewrites import.meta.url, so the vane worker 404s and vault open never finishes.
  optimizeDeps: {
    exclude: ['@vane-rs/web'],
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
})
