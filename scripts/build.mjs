import * as esbuild from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, watch as fsWatch } from 'node:fs'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const watch = process.argv.includes('--watch')
const outdir = 'dist'
const RELOAD_PORT = 35729

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  target: 'chrome120',
  logLevel: 'info',
  define: { __DEV__: watch ? 'true' : 'false' },
}

const builds = [
  // MV3 module service worker
  { ...common, entryPoints: ['src/bg/index.ts'], outfile: `${outdir}/bg.js`, format: 'esm' },
  // Content script must be a classic script
  { ...common, entryPoints: ['src/content/index.ts'], outfile: `${outdir}/content.js`, format: 'iife' },
  { ...common, entryPoints: ['src/popup/popup.ts'], outfile: `${outdir}/popup.js`, format: 'iife' },
  { ...common, entryPoints: ['src/options/options.ts'], outfile: `${outdir}/options.js`, format: 'iife' },
]

async function copyStatic() {
  await cp('public', outdir, { recursive: true })
  await cp('src/content/styles.css', `${outdir}/content.css`)
  await cp('src/popup/popup.html', `${outdir}/popup.html`)
  await cp('src/popup/popup.css', `${outdir}/popup.css`)
  await cp('src/options/options.html', `${outdir}/options.html`)
  await cp('src/options/options.css', `${outdir}/options.css`)
  if (watch) await addDevHostPermission()
}

/** In watch builds, let the dev service worker reach the reload signal. */
async function addDevHostPermission() {
  const path = `${outdir}/manifest.json`
  const m = JSON.parse(await readFile(path, 'utf8'))
  const host = `http://127.0.0.1:${RELOAD_PORT}/*`
  m.host_permissions = [...new Set([...(m.host_permissions ?? []), host])]
  await writeFile(path, JSON.stringify(m, null, 2))
}

/**
 * Minimal WebSocket server (no deps): the dev service worker holds a connection
 * (which also keeps it alive), and we push "reload" on every rebuild so it can
 * call chrome.runtime.reload() — no manual chrome://extensions reload.
 */
function startReloadServer(port) {
  const sockets = new Set()
  const server = createServer()
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    if (!key) return socket.destroy()
    const accept = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
    socket.on('data', () => {}) // ignore client frames
  })
  server.on('error', (e) => console.warn('[reload] server error:', e.message))
  server.listen(port, '127.0.0.1', () => console.log(`[reload] ws://127.0.0.1:${port}`))
  let timer
  return () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const payload = Buffer.from('reload')
      const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]) // FIN + text
      for (const s of sockets) {
        try {
          s.write(frame)
        } catch {
          sockets.delete(s)
        }
      }
      if (sockets.size > 0) console.log(`[reload] notified ${sockets.size} client(s)`)
    }, 150)
  }
}

if (watch) {
  const notifyReload = startReloadServer(RELOAD_PORT)
  // Recopy + reload when JS finishes rebuilding.
  const onEnd = {
    name: 'dev-reload',
    setup(b) {
      b.onEnd(() => notifyReload())
    },
  }
  const contexts = await Promise.all(builds.map((b) => esbuild.context({ ...b, plugins: [onEnd] })))
  await Promise.all(contexts.map((c) => c.watch()))
  await copyStatic()
  // esbuild only watches JS/TS; watch the static assets too.
  let copyTimer
  const recopy = () => {
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => void copyStatic().then(notifyReload), 150)
  }
  for (const dir of ['public', 'src']) fsWatch(dir, { recursive: true }, (_e, file) => {
    if (file && /\.(css|html|json|png|svg)$/.test(file)) recopy()
  })
  console.log('[build] watching src + assets; the extension hot-reloads on change')
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)))
  await copyStatic()
  if (!existsSync(`${outdir}/manifest.json`)) throw new Error('manifest.json missing from dist')
  console.log('[build] done → dist/')
}
