#!/usr/bin/env node
/**
 * Build the portable standalone artifacts under dist/ (gitignored; produced on
 * demand and for publish):
 *
 *   dist/jz.js   — minified single-file ESM bundle of the JS compiler (index.js
 *                  + its src/ graph + the subscript parser + watr backend). Drop
 *                  it anywhere with a JS runtime: `import jz from './jz.js'`.
 *   dist/interop.js — minified jz/interop bridge (host runtime: instantiate +
 *                  value marshalling, no compiler). ~15 kB / ~6 kB gzipped.
 *   dist/sprae.js — minified bundle of sprae (the landing binds its live bench
 *                  figures with sprae `:text` directives). Resolved from the npm
 *                  package or a sibling dy/sprae checkout.
 *   dist/jz.wasm — the jz compiler compiled to wasm by jz (full self-host). Its
 *                  default export is `compileSelf(source) → wasm bytes`: the whole
 *                  pipeline (parse → jzify → prepare → compile → watr-encode) runs
 *                  in wasm, no host help. Built from scripts/self.js — same artifact
 *                  the selfhost gate builds (scripts/selfhost-build.mjs).
 *
 * Run: npm run build
 */
import { build } from 'esbuild'
import { writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'dist')
mkdirSync(OUT, { recursive: true })
const kb = (p) => (statSync(p).size / 1024).toFixed(1) + ' kB'

// ── dist/jz.js — minified ESM bundle of the JS compiler ──────────────────────
const jsOut = resolve(OUT, 'jz.js')
await build({
  entryPoints: [resolve(ROOT, 'index.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  legalComments: 'none',
  outfile: jsOut,
})
console.log('wrote dist/jz.js  ', kb(jsOut))

// ── dist/interop.js — minified jz/interop bridge (host runtime, no compiler) ──
const interopOut = resolve(OUT, 'interop.js')
await build({
  entryPoints: [resolve(ROOT, 'interop.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  legalComments: 'none',
  outfile: interopOut,
})
console.log('wrote dist/interop.js', kb(interopOut))

// ── dist/sprae.js — the landing's live metric figures are bound with sprae (a `:text` directive
// over bench/results.json). The landing statically imports ./dist/sprae.js, so the build must emit
// it. Resolve from the npm package if installed, else a sibling `dy/sprae` checkout. ─────────────
let spraeEntry = null
try { spraeEntry = fileURLToPath(import.meta.resolve('sprae')) } catch {}
if (!spraeEntry) { const sib = resolve(ROOT, '../sprae/sprae.js'); if (existsSync(sib)) spraeEntry = sib }
if (spraeEntry) {
  const spraeOut = resolve(OUT, 'sprae.js')
  await build({ entryPoints: [spraeEntry], bundle: true, minify: true, format: 'esm', platform: 'neutral', target: 'es2022', legalComments: 'none', outfile: spraeOut })
  console.log('wrote dist/sprae.js ', kb(spraeOut))
} else {
  console.warn('⚠ sprae not found — `npm i sprae` or clone dy/sprae as a sibling; dist/sprae.js NOT built (landing metric bindings will fail)')
}

// ── dist/jz.wasm — the jz compiler, compiled to wasm by jz (full self-host) ───
const wasmOut = resolve(OUT, 'jz.wasm')
const g = resolveModuleGraph(resolve(ROOT, 'scripts/self.js'), { resolveNode: true })
const wasm = compile(g.code, { modules: g.modules, memory: 8192, optimize: false })
new WebAssembly.Module(wasm)  // validate before writing
writeFileSync(wasmOut, wasm)
console.log('wrote dist/jz.wasm', kb(wasmOut))
