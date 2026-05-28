#!/usr/bin/env node
/** Build and validate the jz self-host compiler kernel (jz.wasm). */
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { compile } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, 'dist')
const OUT = resolve(OUT_DIR, 'jz-kernel.wasm')

// Build from kernel.js: its default export is `compileParsed`, the self-contained
// in-wasm pipeline (reset → jzify → prepare → compile). The host hands it a parsed
// AST and runs only the parser and watr backend — the two pieces jz can't yet run
// on itself. (Building from index.js exports bare `compile`, which needs a prepared
// AST + a ctx that only the host-side `prepare` populates — unusable for self-host.)
const g = resolveModuleGraph(resolve(ROOT, 'src/compile/kernel.js'), { resolveNode: true })
console.log('resolving kernel graph…', Object.keys(g.modules).length, 'modules')
const t0 = Date.now()
const wasm = compile(g.code, {
  jzify: true,
  modules: g.modules,
  memory: 8192,
  optimize: false,
})
console.log('compiled', wasm.byteLength, 'bytes in', Date.now() - t0, 'ms')
new WebAssembly.Module(wasm)
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, wasm)
console.log('wrote', OUT)
