/**
 * Self-host gate: build dist/jz-kernel.wasm, instantiate it, and verify
 * `kernel.exports.default(ast)` (= compileParsed) round-trips a real program
 * through the in-wasm pipeline.
 *
 * Contract (must match scripts/selfhost-build.mjs):
 *   host:   ast    = parse(source)                              // subscript/jessie
 *   host:   ast    = normalizeBigints(ast)                       // marshal-safe BigInts
 *   kernel: ir     = kernel.exports.default(ast)                 // reset→jzify→prepare→compile
 *   host:   wasm   = watrCompile(ir)
 *   host:   result = instantiate(wasm).exports.main()
 *
 * The kernel.js entry is what selfhost-build builds — its default export is
 * `compileParsed`, the self-contained in-wasm pipeline. Building from
 * compile/index.js exports the bare `compile()` which expects a prepared ctx
 * the host owns, so it cannot self-host.
 *
 * Run: node test/selfhost.js   |   CI: npm run test:selfhost
 */
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { parse } from 'subscript/feature/jessie'
import watrCompile from 'watr/compile'
import { instantiate } from '../interop.js'
import { normalizeBigints } from '../src/marshal.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = join(ROOT, 'scripts/selfhost-build.mjs')
const KERNEL = join(ROOT, 'dist/jz-kernel.wasm')

const ensureKernel = () => {
  if (existsSync(KERNEL)) return
  const r = spawnSync(process.execPath, [BUILD], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 })
  if (r.status !== 0) {
    console.log(r.stdout); console.log(r.stderr)
    throw new Error(`selfhost build exit ${r.status}`)
  }
}

// One kernel instance reused across samples — instantiation is the slow part
// (3.5 MB wasm). Per-sample isolation is unnecessary: the kernel resets its
// internal ctx on each compileParsed call.
let kernel
const getKernel = () => {
  if (!kernel) {
    ensureKernel()
    kernel = instantiate(readFileSync(KERNEL), { memory: 8192 })
  }
  return kernel
}

const compileViaKernel = (src) => {
  const ast = normalizeBigints(parse(src))
  const ir = getKernel().exports.default(ast)
  if (!Array.isArray(ir) || ir[0] !== 'module' || ir.length < 2)
    throw new Error('kernel returned non-module IR: ' + JSON.stringify(ir)?.slice(0, 120))
  return watrCompile(ir)
}

test('selfhost: build jz-kernel.wasm', () => {
  const r = spawnSync(process.execPath, [BUILD], {
    cwd: ROOT, encoding: 'utf8', timeout: 600_000,
  })
  if (r.status !== 0) { console.log(r.stdout); console.log(r.stderr) }
  ok(r.status === 0, `build exit ${r.status}`)
  ok(r.stdout.includes('jz-kernel.wasm'), 'kernel artifact reported')
  ok(readFileSync(KERNEL).byteLength > 100_000, 'kernel wasm has substance')
})

// Sample programs the kernel must lower correctly. Each tuple is
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
    const bin = compileViaKernel(src)
    ok(bin.byteLength > 10, 'kernel produced wasm bytes')
    const inst = instantiate(bin, { memory: 256 })
    is(inst.exports.main(), expected, `main() === ${expected}`)
  })
}
