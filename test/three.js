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
 *     answers and is timed against V8, each kernel in a Node process of its
 *     own. The ratios print on every run; a kernel jz leads by LEAD is pinned
 *     there (PINNED), and JZ_THREE_PIN=1 asks every kernel for jz no slower than V8.
 *  4. The three.js bench cases (bench/three*), built as the bench builds them,
 *     answer what Node answers, call after call.
 *
 * A group jz gets wrong is listed in KNOWN with its cause, and the gate fails
 * when a listed group starts to agree: the entry is then removed.
 *
 * Run: npm run test:three
 */
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative } from 'node:path'
import { readdirSync } from 'node:fs'
import { compile } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'
import { instantiate } from '../interop.js'
import { compileJzAt } from '../bench/_lib/compile.js'

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
// A kernel jz leads by at least LEAD (V8 ms / jz ms) is pinned: a run that
// measures it below LEAD fails. The others print until they clear it, then
// join PINNED. V8 times each kernel in a process of its own, where its inline
// caches see that kernel's shapes alone: in this process they have seen every
// shape the API test above passes, and V8 ran transformPositions in 15.7 ms and
// normals in 25.7 that it runs in 3.6 and 2.7 alone (Apple M4 Max, loaded).
// jz compiles the seven as one module, their kinds joined, and runs them in
// this process: wasm keeps no feedback.
const LEAD = 1.2
const PINNED = new Set(['transformPositions', 'cull', 'raycast', 'slerp', 'bounds', 'normals'])
// Processor time, the least of several runs: wall time on a busy machine measures the machine.
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000 }
const least = (fn, after) => { let t = Infinity; for (let i = 0; i < 9; i++) { const t0 = cpu(); fn(); t = Math.min(t, cpu() - t0); after?.() } return t }
// V8's time for one kernel in a fresh process: two calls to warm it, then the
// least of nine; the better of two processes, as V8 settles a kernel's code
// differently from one process to the next (normals read 2.7 ms in one, 6.1 in another).
const V8_ALONE = `const [entry, name, n, repeats] = process.argv.slice(1)
const k = (await import(entry))[name]
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000 }
k(+n, +repeats); k(+n, +repeats)
let t = Infinity
for (let i = 0; i < 9; i++) { const t0 = cpu(); k(+n, +repeats); t = Math.min(t, cpu() - t0) }
console.log(t)`
const v8Alone = (entry, name, n, repeats) => {
  let best = Infinity
  for (let p = 0; p < 2; p++) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', V8_ALONE, pathToFileURL(entry).href, name, String(n), String(repeats)], { encoding: 'utf8' })
    const t = +r.stdout.trim().split('\n').pop()
    if (r.status !== 0 || !(t > 0)) throw Error(`${name} in a process of its own: ${r.stderr || r.stdout}`)
    best = Math.min(best, t)
  }
  return best
}

test('three: the hot paths of a frame answer what Node answers, timed against V8', async () => {
  const entry = join(ROOT, 'test/three/kernels.js')
  const js = await import(entry), { exports: wasm, memory } = await instantiate(build(entry, 'speed'))
  let sum = 0
  console.log(`  ${'hot path'.padEnd(20)}${'V8 ms'.padStart(9)}${'jz ms'.padStart(9)}${'V8/jz'.padStart(9)}`)
  for (const [name, n, repeats] of KERNELS) {
    // sceneUpdate and slerp build their rotations with sin and cos
    const want = js[name](n, repeats), got = wasm[name](n, repeats)
    memory.reset()
    ok(agrees(got, want, true), `${name}: node ${want}, jz ${got}`)
    // a second round after the reset answers the same
    is(wasm[name](n, repeats), got, `${name} after memory.reset()`)
    memory.reset()
    const v8 = v8Alone(entry, name, n, repeats), jz = least(() => wasm[name](n, repeats), () => memory.reset())
    sum += Math.log(v8 / jz)
    console.log(`  ${name.padEnd(20)}${v8.toFixed(2).padStart(9)}${jz.toFixed(2).padStart(9)}${((v8 / jz).toFixed(2) + '×').padStart(9)}${PINNED.has(name) ? '' : '  (diagnostic)'}`)
    if (PINNED.has(name)) ok(v8 / jz >= LEAD, `${name}: V8/jz ${(v8 / jz).toFixed(2)}× (jz ${jz.toFixed(2)} ms, V8 ${v8.toFixed(2)} ms), pinned at ${LEAD}×`)
    if (PIN) ok(jz <= v8, `${name}: jz ${jz.toFixed(2)} ms, V8 ${v8.toFixed(2)} ms`)
  }
  console.log(`  ${'geomean'.padEnd(38)}${(Math.exp(sum / KERNELS.length).toFixed(2) + '×').padStart(9)}`)
})

// The bench cases' checksums (bench/bench.mjs REFERENCE_CHECKSUMS): node, deno, bun, jsc and jz agree.
const BENCH = { threescene: 2202287547, threeanim: 1484561098, threecull: 1233517740, threegeom: 2972009138 }
for (const [id, checksum] of Object.entries(BENCH)) test(`three: the ${id} bench case agrees with Node across repeated calls`, async () => {
  const entry = join(ROOT, 'bench', id, `${id}.js`)
  let wa, js
  const { exports: wasm } = instantiate(compileJzAt({ id, js: entry }, { level: 'speed' }), { imports: {
    env: { logResult: (us, sum, samples, stages, runs) => { wa = [sum >>> 0, samples, stages, runs] } },
    performance: { now: () => performance.now() },
  } })
  const node = await import(entry)
  const runJS = () => {
    const log = console.log
    console.log = line => { js = /checksum=(\d+) samples=(\d+) stages=(\d+) runs=(\d+)$/.exec(line)?.slice(1).map(Number) }
    try { node.main() } finally { console.log = log }
  }
  // the case's state carries from call to call: both sides run the same rounds
  for (let round = 0; round < 2; round++) {
    wa = js = null
    runJS(); wasm.main()
    if (!round) is(js?.[0], checksum, `${id}: the fixed workload's checksum`)
    is(wa, js, `${id} round ${round}: checksum and workload agree`)
  }
})
