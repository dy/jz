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
// optimize:2 — full standard optimization. (Earlier this MISCOMPILED the compiler into
// an infinite loop on its own code; root cause was `sourceInline` dropping a statement-
// position callee's side-effecting return expression — the parser's `seek = n => idx = n`
// stopped advancing `idx`, looping comment-skip forever. Fixed in src/compile/plan/inline.js.)
// -O2, not -O3: the compiler is integer/string/pointer work with no float/SIMD compute, so
// O3's extras (relaxedSimd, aggressive size-for-speed inline, reduceUnroll) don't help it —
// the corpus-compile ratio is identical at O1/O2/O3 (the cost is the kernel NaN-box/string/
// map tax, not the compiler's own code). Override with JZ_SELFHOST_OPT (e.g. =3, =false).
const SELF_OPT = process.env.JZ_SELFHOST_OPT ?? '2'
const wasm = compile(g.code, { modules: g.modules, memory: 8192, optimize: SELF_OPT === 'false' ? false : (isNaN(+SELF_OPT) ? SELF_OPT : +SELF_OPT) })
console.log('compiled', wasm.byteLength, 'bytes in', Date.now() - t0, 'ms')
new WebAssembly.Module(wasm)
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, wasm)
console.log('wrote', OUT)
