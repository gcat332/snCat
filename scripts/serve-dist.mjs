// Minimal static file server for the built extension, used by the smoke test.
// Module scripts can't load over file:// (CORS), so we serve dist/ over http.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

const DIST = 'dist'
const PORT = Number(process.env.SMOKE_PORT ?? 5299)
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (p.endsWith('/')) p += 'index.html'
    const body = await readFile(join(DIST, p))
    res.setHeader('content-type', TYPES[extname(p)] ?? 'application/octet-stream')
    res.end(body)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}).listen(PORT, () => console.log(`serve-dist: http://localhost:${PORT}`))
