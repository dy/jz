#!/usr/bin/env node
/**
 * Build the portable standalone artifacts under dist/ (gitignored; produced on
 * demand and for publish):
 *
 *   dist/jz.js   — minified single-file ESM bundle of the JS compiler (index.js
 *                  + its src/ graph + the subscript parser + watr backend). Drop
 *                  it anywhere with a JS runtime: `import jz from './jz.js'`.
 *   dist/jz.wasm — the jz compiler compiled to wasm by jz (full self-host). Its
 *                  default export is `compileSelf(source) → wasm bytes`: the whole
 *                  pipeline (parse → jzify → prepare → compile → watr-encode) runs
 *                  in wasm, no host help. Built from scripts/self.js — same artifact
 *                  the selfhost gate builds (scripts/selfhost-build.mjs).
 *
 * Run: npm run build
 */
import { build } from 'esbuild'
import { writeFileSync, mkdirSync, statSync } from 'node:fs'
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

// ── dist/jz.wasm — the jz compiler, compiled to wasm by jz (full self-host) ───
const wasmOut = resolve(OUT, 'jz.wasm')
const g = resolveModuleGraph(resolve(ROOT, 'scripts/self.js'), { resolveNode: true })
const wasm = compile(g.code, { modules: g.modules, memory: 8192, optimize: false })
new WebAssembly.Module(wasm)  // validate before writing
writeFileSync(wasmOut, wasm)
console.log('wrote dist/jz.wasm', kb(wasmOut))
