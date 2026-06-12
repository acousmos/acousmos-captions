import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'))
mkdirSync('release', { recursive: true })
const out = `release/acousmos-captions-${manifest.version}.zip`
execFileSync('zip', ['-r', '-X', `../${out}`, '.'], { cwd: 'dist', stdio: 'inherit' })
console.log(`[zip] ${out}`)
