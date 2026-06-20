#!/usr/bin/env node
// Self-host compile-throughput benchmark: jz.wasm vs jz.js compiling the bench corpus.
//
// The apples-to-apples question behind self-hosting: when the SAME compiler source
// (scripts/self.js — parse → jzify → prepare → compile → watr-encode) runs as wasm
// (dist/jz.wasm, jz compiled by jz) vs as plain JS in V8, which compiles real programs
// faster? Both rows run in the same node/V8; the only variable is wasm vs JS-source.
//
// Workload = the bench corpus (mat4, fft, mandelbrot, crc32, …) — the same programs
// the cross-engine bench compiles — each inlining benchlib so it's a standalone module
// (matches bench.mjs's benchSource()). Output bytes are checksummed and the wasm/JS
// results compared, so the timing run doubles as a determinism + parity gate.
//
// Methodology note: the self-host kernel bump-allocates per compile and its cross-
// compile caches assume an immortal arena (see DESIGN / _clear), so we cannot reset and
// reuse one instance across the corpus. We instantiate a FRESH wasm instance per program
// (instantiation excluded from the timed region) and take the min of N warm runs — the
// steady-state per-compile cost, the fair comparison to the JS compiler's warmed path.
//
// Run: node scripts/bench-selfhost.mjs            (level 0, the default)
//      JZ_LEVEL=2 node scripts/bench-selfhost.mjs (once the level-2 self-host path is sound)

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { instantiate } from '../interop.js'
import compileSelf from './self.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BENCH = join(ROOT, 'bench')
const LIB = join(BENCH, '_lib', 'benchlib.js')
const WASM = join(ROOT, 'dist', 'jz.wasm')
const LEVEL = process.env.JZ_LEVEL ?? '0'
const RUNS = Math.max(8, Number(process.env.JZ_BENCH_RUNS) || 18)
const WARM = 8

// Corpus = every bench case with a real .js source. Skip self-referential / graph cases.
const CASES = ['alpha','blur','bytebeat','dotprod','fft','lorenz','nbody','particle','synth',
  'biquad','mat4','poly','bitwise','tokenizer','callback','aos','mandelbrot','json','sort',
  'crc32','matmul','heat']

// Inline benchlib (export let → const) and strip its import — the standalone module the
// compiler sees, same transform bench.mjs uses for the native/wasi self-timing path.
const benchlib = readFileSync(LIB, 'utf8').replace(/\bexport let\b/g, 'const')
const sourceFor = (name) => {
  let src = readFileSync(join(BENCH, name, `${name}.js`), 'utf8')
  if (src.includes('../_lib/benchlib.js'))
    src = benchlib + '\n' + src.replace(/import\s+\{[^}]+\}\s+from\s+['"]\.\.\/_lib\/benchlib\.js['"]\s*\n?/g, '')
  return src
}

const ensureWasm = () => {
  if (existsSync(WASM)) return
  console.log('dist/jz.wasm missing — building self-host…')
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'selfhost-build.mjs')], { cwd: ROOT, stdio: 'inherit', timeout: 600_000 })
  if (r.status !== 0) throw new Error(`selfhost build failed (exit ${r.status})`)
}

const fnv = (bytes) => { let h = 0x811c9dc5 | 0; for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193); return h >>> 0 }

const timeMin = (fn) => {
  for (let i = 0; i < WARM; i++) fn()
  let best = Infinity
  for (let r = 0; r < RUNS; r++) { const t = performance.now(); fn(); best = Math.min(best, performance.now() - t) }
  return best
}

ensureWasm()
const wasmBytes = readFileSync(WASM)

console.log(`self-host compile throughput — corpus × ${CASES.length}, optimize level ${LEVEL}\n`)
console.log('case          js(ms)  wasm(ms)  ratio   parity')
console.log('─'.repeat(52))

let sumJs = 0, sumWasm = 0, ratios = [], okN = 0, skipped = []
for (const name of CASES) {
  const src = sourceFor(name)
  // JS compiler reference + checksum
  let jsBytes
  try { jsBytes = compileSelf(src, false, LEVEL) } catch (e) { skipped.push(`${name}(js:${e.message.slice(0,18)})`); continue }
  // WASM compiler — fresh instance, exclude instantiation from timing
  const self = instantiate(wasmBytes, { memory: 8192 })
  const compileWasm = () => self.memory.read(self.exports.default(self.memory.String(src), 0, self.memory.String(LEVEL)))
  let wasmBytesOut
  try { wasmBytesOut = compileWasm() } catch (e) { self && skipped.push(`${name}(wasm:${e.message.slice(0,18)})`); continue }
  const parity = fnv(jsBytes) === fnv(wasmBytesOut instanceof Uint8Array ? wasmBytesOut : new Uint8Array(wasmBytesOut)) ? 'ok' : 'DIFF'

  const js = timeMin(() => compileSelf(src, false, LEVEL))
  const wasm = timeMin(compileWasm)
  sumJs += js; sumWasm += wasm; ratios.push(wasm / js); okN++
  const flag = wasm < js ? '' : ' ⚠'
  console.log(`${name.padEnd(12)} ${js.toFixed(2).padStart(6)} ${wasm.toFixed(2).padStart(9)}  ${(wasm/js).toFixed(2)}×${flag}  ${parity}`)
}

const geo = ratios.length ? Math.exp(ratios.reduce((a, b) => a + Math.log(b), 0) / ratios.length) : NaN
console.log('─'.repeat(52))
console.log(`TOTAL (${okN}/${CASES.length})  js ${sumJs.toFixed(1)}ms   wasm ${sumWasm.toFixed(1)}ms`)
console.log(`geomean ratio: ${geo.toFixed(2)}× — wasm is ${geo < 1 ? (1/geo).toFixed(2)+'× FASTER' : geo.toFixed(2)+'× slower'} than jz.js`)
if (skipped.length) console.log(`skipped: ${skipped.join(', ')}`)
