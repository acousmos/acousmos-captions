import * as esbuild from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const watch = process.argv.includes('--watch')
const outdir = 'dist'

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
}

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)))
  await Promise.all(contexts.map((c) => c.watch()))
  await copyStatic()
  console.log('[build] watching… (static assets copied once; rerun on html/css/manifest changes)')
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)))
  await copyStatic()
  if (!existsSync(`${outdir}/manifest.json`)) throw new Error('manifest.json missing from dist')
  console.log('[build] done → dist/')
}
