/**
 * Ecosystem PERFORMANCE gate — jessie.wasm vs jessie.js, watr.wasm vs watr.js.
 *
 * Goal (stated 2026-07-02): jz-compiled ecosystem libraries must BEAT their JS
 * originals on V8 — jessie.wasm parses faster than jessie.js, watr.wasm
 * assembles faster than watr.js. Same proof discipline as selfhost-perf.js:
 * parity/correctness pins are ALWAYS on (the wasm build must work and agree
 * with JS); the ratio caps become HARD once parity is earned — until then they
 * activate under JZ_ECO_PIN=1 and every run PRINTS the current ratios so the
 * gap is always visible.
 *
 * Run: node test/ecosystem-perf.js   |   pin: JZ_ECO_PIN=1 node test/ecosystem-perf.js
 */
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { compile } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'
import { instantiate } from '../interop.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CI = !!process.env.CI
const PIN = !!process.env.JZ_ECO_PIN
// Beat-the-JS target with jitter headroom; hard once JZ_ECO_PIN graduates to default.
const CAP = CI ? 1.10 : 1.00

const WARMUP = 3, RUNS = 7
const timeMin = (fn) => {
  for (let i = 0; i < WARMUP; i++) fn()
  let best = Infinity
  for (let r = 0; r < RUNS; r++) { const t = performance.now(); fn(); best = Math.min(best, performance.now() - t) }
  return best
}

// Build a wasm module from a driver entry that imports the library graph.
const buildWasm = (driverName, driverSrc) => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-eco-'))
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'))  // bare-specifier resolution
  const entry = join(dir, driverName)
  writeFileSync(entry, driverSrc)
  const g = resolveModuleGraph(entry, { resolveNode: true })
  return compile(g.code, { modules: g.modules, memory: 8192, optimize: 2 })
}

// Parse workload: a real bench-case source, representative token mix.
const JS_FIXTURE = readFileSync(join(ROOT, 'bench/mat4/mat4.js'), 'utf8')
  + '\n' + readFileSync(join(ROOT, 'bench/_lib/benchlib.js'), 'utf8')

test('eco-pin: jessie.wasm parses, agrees with jessie.js, ratio reported', async () => {
  const driver = `import { parse } from 'subscript/feature/jessie'
const size = (n) => { if (!Array.isArray(n)) return 1; let s = 1; for (let i = 0; i < n.length; i++) s += size(n[i]); return s }
export let main = (src) => size(parse(src))`
  const wasm = buildWasm('jessie-driver.js', driver)
  ok(wasm.byteLength > 10000, 'jessie graph compiled to wasm')
  const inst = instantiate(wasm, { memory: 8192 })

  const { parse } = await import('subscript/feature/jessie')
  const size = (n) => { if (!Array.isArray(n)) return 1; let s = 1; for (let i = 0; i < n.length; i++) s += size(n[i]); return s }
  const want = size(parse(JS_FIXTURE))
  is(inst.exports.main(inst.memory.String(JS_FIXTURE)), want, 'wasm AST node count === js')

  const js = timeMin(() => size(parse(JS_FIXTURE)))
  const sp = inst.memory.String(JS_FIXTURE)
  const wa = timeMin(() => inst.exports.main(sp))
  const ratio = wa / js
  console.log(`  jessie.wasm/jessie.js parse ratio ${ratio.toFixed(3)}× (target ≤ ${CAP}×${PIN ? ', PINNED' : ', report-only'})`)
  if (PIN) ok(ratio <= CAP, `jessie.wasm ${ratio.toFixed(3)}× > ${CAP}× — the beat-the-JS goal regressed`)
})

test('eco-pin: watr.wasm assembles, agrees with watr.js, ratio reported', async () => {
  // Fixture: a mid-size WAT — jz's own emission for a bench case.
  const watFixture = compile(JS_FIXTURE.replace(/import[^\n]*\n/, ''), { wat: true, optimize: false })
  const driver = `import compile from 'watr/compile'
export let main = (src) => compile(src).length`
  const wasm = buildWasm('watr-driver.js', driver)
  ok(wasm.byteLength > 10000, 'watr graph compiled to wasm')
  const inst = instantiate(wasm, { memory: 8192 })

  const { default: watrCompile } = await import('watr/compile')
  const want = watrCompile(watFixture).length
  is(inst.exports.main(inst.memory.String(watFixture)), want, 'wasm byte count === js')

  const js = timeMin(() => watrCompile(watFixture).length)
  const sp = inst.memory.String(watFixture)
  const wa = timeMin(() => inst.exports.main(sp))
  const ratio = wa / js
  console.log(`  watr.wasm/watr.js assemble ratio ${ratio.toFixed(3)}× (target ≤ ${CAP}×${PIN ? ', PINNED' : ', report-only'})`)
  if (PIN) ok(ratio <= CAP, `watr.wasm ${ratio.toFixed(3)}× > ${CAP}× — the beat-the-JS goal regressed`)
})
