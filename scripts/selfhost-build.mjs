#!/usr/bin/env node
/** Build and validate the jz self-host compiler (dist/jz.wasm). */
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { compile } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, 'dist')
const OUT = resolve(OUT_DIR, 'jz.wasm')

// Build from scripts/self.js: its default export is `compileSelf`, the whole jz
// pipeline (parse → jzify → prepare → compile → watr-encode) as one source→bytes
// function. The resulting wasm's `default(source)` is jz, compiled by jz — no host
// help needed (the wasm parses and encodes too).
const g = resolveModuleGraph(resolve(ROOT, 'scripts/self.js'), { resolveNode: true })
console.log('resolving self-host graph…', Object.keys(g.modules).length, 'modules')
const t0 = Date.now()
const wasm = compile(g.code, { modules: g.modules, memory: 8192, optimize: false })
console.log('compiled', wasm.byteLength, 'bytes in', Date.now() - t0, 'ms')
new WebAssembly.Module(wasm)
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, wasm)
console.log('wrote', OUT)
