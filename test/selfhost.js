/**
 * Self-host gate: build dist/jz.wasm, instantiate it, and verify its
 * `default(source)` round-trips real programs through the in-wasm pipeline.
 *
 * Contract (matches scripts/selfhost-build.mjs + scripts/self.js):
 *   host:   self   = instantiate(dist/jz.wasm)
 *   wasm:   bytes  = self.default(source)   // parse → jzify → prepare → compile → watr
 *   host:   result = instantiate(bytes).exports.main()
 *
 * The whole compiler runs in wasm — the host only passes the source string in and
 * reads the wasm bytes out. dist/jz.wasm is jz, compiled by jz.
 *
 * Run: node test/selfhost.js   |   CI: npm run test:selfhost
 */
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { instantiate } from '../interop.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = join(ROOT, 'scripts/selfhost-build.mjs')
const SELF = join(ROOT, 'dist/jz.wasm')

const ensureSelf = () => {
  if (existsSync(SELF)) return
  const r = spawnSync(process.execPath, [BUILD], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 })
  if (r.status !== 0) {
    console.log(r.stdout); console.log(r.stderr)
    throw new Error(`selfhost build exit ${r.status}`)
  }
}

// One instance reused across samples — instantiation is the slow part (~4 MB
// wasm). compileSelf resets its internal ctx on each call, so samples don't
// contaminate each other.
let self
const getSelf = () => {
  if (!self) {
    ensureSelf()
    self = instantiate(readFileSync(SELF), { memory: 8192 })
  }
  return self
}

const compileViaSelf = (src) => {
  const s = getSelf()
  const out = s.exports.default(s.memory.String(src))
  const bin = s.memory.read(out)
  const bytes = bin instanceof Uint8Array ? bin : new Uint8Array(bin)
  if (bytes.length <= 8) throw new Error('self-host returned empty wasm: ' + bytes.length + ' bytes')
  return bytes
}

test('selfhost: build dist/jz.wasm', () => {
  const r = spawnSync(process.execPath, [BUILD], {
    cwd: ROOT, encoding: 'utf8', timeout: 600_000,
  })
  if (r.status !== 0) { console.log(r.stdout); console.log(r.stderr) }
  ok(r.status === 0, `build exit ${r.status}`)
  ok(r.stdout.includes('jz.wasm'), 'self-host artifact reported')
  ok(readFileSync(SELF).byteLength > 100_000, 'self-host wasm has substance')
})

// Sample programs the self-host compiler must lower correctly. Each tuple is
// [label, source, expected-main()-result]. Picked to cover the major
// emit paths (arith, calls, loops, strings, arrays, objects, closures).
const SAMPLES = [
  ['arithmetic',  'export let main = () => 3 + 4 * 5', 23],
  ['function',    'let inc = x => x + 1; export let main = () => inc(10)', 11],
  ['loop',        'export let main = () => { let s = 0; for (let i = 0; i < 10; i++) s += i; return s }', 45],
  ['string-len',  'export let main = () => "hello world".length', 11],
  ['array-reduce','export let main = () => [1,2,3,4,5].reduce((a,b)=>a+b, 0)', 15],
  ['closure',     'let mk = n => (x => x + n); let add5 = mk(5); export let main = () => add5(7)', 12],
  ['recursion',   'let fib = n => n < 2 ? n : fib(n-1) + fib(n-2); export let main = () => fib(10)', 55],
  // Math intrinsics whose emitters build WAT strings at compile time — guards the
  // class of self-host bug where the builder uses a construct the kernel lacks
  // (Math.expm1's Horner fold once used Array.reduceRight, absent from jz's runtime,
  // so the kernel interpolated `undefined` into the WAT). Tolerance-checked in-program
  // (returns 1/0) so the exact-equality assert below stays uniform.
  ['math-sqrt',   'export let main = () => (Math.abs(Math.sqrt(2) - 1.4142135623730951) < 1e-9) | 0', 1],
  ['math-exp',    'export let main = () => (Math.abs(Math.exp(0.3) - 1.3498588075760032) < 1e-6) | 0', 1],
  ['math-expm1',  'export let main = () => (Math.abs(Math.expm1(0.3) - 0.3498588075760032) < 1e-6) | 0', 1],
]

for (const [label, src, expected] of SAMPLES) {
  test(`selfhost: ${label}`, () => {
    const bin = compileViaSelf(src)
    ok(bin.byteLength > 10, 'self-host produced wasm bytes')
    const inst = instantiate(bin, { memory: 256 })
    is(inst.exports.main(), expected, `main() === ${expected}`)
  })
}
