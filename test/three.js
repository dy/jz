/**
 * three.js gate — the math layer of three.js (node_modules/three/src/math, the
 * version package.json pins), compiled as it ships, against the same source
 * run by Node.
 *
 *  1. Every module of src/math compiles as an entry.
 *  2. test/three/api.js, the public surface of its classes, answers what Node
 *     answers: exactly, or to TOLERANCE where a group reaches a transcendental
 *     function (its name ends in `_t`; jz's sin, cos, asin, acos and atan
 *     agree with libm to about 1e-9, not to the last digit).
 *  3. test/three/kernels.js, the CPU hot paths of a frame, answers what Node
 *     answers and is timed against V8. The ratios print on every run and are
 *     a bar under JZ_THREE_PIN=1: jz no slower than V8 on each.
 *
 * A group jz gets wrong is listed in KNOWN with its cause, and the gate fails
 * when a listed group starts to agree: the entry is then removed.
 *
 * Run: npm run test:three
 */
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { readdirSync } from 'node:fs'
import { compile } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'
import { instantiate } from '../interop.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MATH = join(ROOT, 'node_modules/three/src/math')
const PIN = !!process.env.JZ_THREE_PIN
const TOLERANCE = 1e-9

// group → why jz and Node differ on it
const KNOWN = {}

const build = (entry, optimize = 2) => {
  const g = resolveModuleGraph(entry, { resolveNode: true })
  return compile(g.code, { modules: g.modules, optimize })
}
// three's deprecation notices are part of what the programs run
const quiet = (fn) => {
  const { warn, error, log } = console
  console.warn = console.error = console.log = () => {}
  try { return fn() } finally { Object.assign(console, { warn, error, log }) }
}
const agrees = (got, want, inexact) => Object.is(got, want) ||
  (inexact && typeof got === 'number' && typeof want === 'number' && Math.abs(got - want) <= TOLERANCE * Math.max(1, Math.abs(want)))

test('three: every module of src/math compiles', () => {
  const files = readdirSync(MATH, { recursive: true }).filter(f => f.endsWith('.js')).sort()
  ok(files.length >= 29, `${files.length} modules`)
  for (const f of files) {
    let msg = null
    try { build(join(MATH, f)) } catch (e) { msg = String(e.message).split('\n')[0] }
    is(msg, null, relative(ROOT, join(MATH, f)))
  }
})

test('three: the math classes answer what Node answers', async () => {
  const entry = join(ROOT, 'test/three/api.js')
  const api = await import(entry), { exports: wasm } = await instantiate(build(entry))
  for (const [name, fn] of Object.entries(api)) {
    const want = quiet(fn)
    let got
    try { got = quiet(wasm[name]) } catch (e) { got = `throws ${String(e.message).split('\n')[0]}` }
    const same = agrees(got, want, name.endsWith('_t'))
    if (name in KNOWN) ok(!same, `${name} agrees now: remove it from KNOWN (${KNOWN[name]})`)
    else ok(same, same ? name : `${name}: node ${JSON.stringify(want)}, jz ${JSON.stringify(got)}`)
  }
})

// [kernel, size, repeats]
const KERNELS = [['sceneUpdate', 10000, 20], ['transformPositions', 100000, 4], ['cull', 10000, 40], ['raycast', 20000, 10],
  ['slerp', 10000, 40], ['bounds', 100000, 4], ['normals', 30000, 4]]
// Processor time, the least of several runs: wall time on a busy machine measures the machine.
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000 }
const least = (fn, after) => { let t = Infinity; for (let i = 0; i < 9; i++) { const t0 = cpu(); fn(); t = Math.min(t, cpu() - t0); after?.() } return t }

test('three: the hot paths of a frame answer what Node answers, timed against V8', async () => {
  const entry = join(ROOT, 'test/three/kernels.js')
  const js = await import(entry), { exports: wasm, memory } = await instantiate(build(entry, 'speed'))
  let sum = 0
  console.log(`  ${'hot path'.padEnd(20)}${'V8 ms'.padStart(9)}${'jz ms'.padStart(9)}${'jz/V8'.padStart(9)}`)
  for (const [name, n, repeats] of KERNELS) {
    // sceneUpdate and slerp build their rotations with sin and cos
    const want = js[name](n, repeats), got = wasm[name](n, repeats)
    memory.reset()
    ok(agrees(got, want, true), `${name}: node ${want}, jz ${got}`)
    // a second round after the reset answers the same
    is(wasm[name](n, repeats), got, `${name} after memory.reset()`)
    memory.reset()
    const v8 = least(() => js[name](n, repeats)), jz = least(() => wasm[name](n, repeats), () => memory.reset())
    sum += Math.log(v8 / jz)
    console.log(`  ${name.padEnd(20)}${v8.toFixed(2).padStart(9)}${jz.toFixed(2).padStart(9)}${((v8 / jz).toFixed(2) + '×').padStart(9)}`)
    if (PIN) ok(jz <= v8, `${name}: jz ${jz.toFixed(2)} ms, V8 ${v8.toFixed(2)} ms`)
  }
  console.log(`  ${'geomean'.padEnd(38)}${(Math.exp(sum / KERNELS.length).toFixed(2) + '×').padStart(9)}`)
})
