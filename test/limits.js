// How big an input compiles. A chain that is a list in meaning compiles at any
// length a machine writes (src/list-form.js, the loops of src/parse.js): each
// kind of KINDS at 10,000 links compiles and answers what its generator computes
// (V8 itself cannot parse some of them nested so deep, so the answer is the
// generator's), in a time a link that holds: t(10,000) / t(2,500) at most 6,
// where linear is 4 and quadratic 16. A nesting no list flattens is a
// SyntaxError that names its construct and its line and column, at 5,000 levels
// of each form (src/parse.js readTree, src/compiler.js nestingError).
//
// Each row runs in a process of its own, at the levels this leg owns
// (_matrix.js levels: the level off on the opt0 leg, the default on the default
// leg), and times its two sizes there once the compiler is warm: a compile of
// the small one first, then each in turn, the faster of two of each (a cold
// first compile, JIT warm-up included, read t(2,500) high and the ratio low).
// The ratio is of the process's CPU time: on a machine shared by other work the
// wall time of a compile moved by half from run to run, its CPU time by a tenth.
// KNOWN holds each row that fails today, with its cause: such a row is held to
// fail as it fails, so the list says what is true and the row that starts to
// pass is taken out of it.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { levels, onKernel, onWasi } from './_matrix.js'
import { oracle } from './util.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const R = (n, f) => Array.from({ length: n }, (_, i) => f(i))
const sum = n => n * (n - 1) / 2
const N = 10000, SMALL = 2500, RATIO = 6

// kind → n → [source, f(3)]
const KINDS = {
  'else-if of returns': n => [`export let f = (x) => { ${R(n, i => `if (x === ${i}) return ${i * 3}`).join('\n else ')}\n return -1 }`, 9],
  'else-if of assignments': n => [`export let f = (x) => { let r = 0\n ${R(n, i => `if (x === ${i}) r = ${i * 3}`).join('\n else ')}\n else r = -1\n return r + 1 }`, 10],
  'switch of returns': n => [`export let f = (x) => { switch (x) { ${R(n, i => `case ${i}: return ${i * 3};`).join(' ')} } return -1 }`, 9],
  'switch of breaks': n => [`export let f = (x) => { let r = 0; switch (x) { ${R(n, i => `case ${i}: r = ${i * 3}; break;`).join(' ')} default: r = -1 } return r + 1 }`, 10],
  'sum': n => [`export let f = (x) => ${R(n, i => `x * ${i}`).join(' + ')}`, 3 * sum(n)],
  'difference': n => [`export let f = (x) => { return ${R(n, i => `x * ${i}`).join(' - ')} }`, -3 * sum(n)],
  'string +': n => [`export let f = (x) => ('' + ${R(n, i => `'k${i % 10}' + x`).join(' + ')}).length`, 3 * n],
  '&&': n => [`export let f = (x) => ${R(n, i => `(x + ${i})`).join(' && ')}`, 3 + n - 1],
  '||': n => [`export let f = (x) => ${R(n - 1, i => `(x === ${i + 100000} && ${i})`).join(' || ')} || x + 7`, 10],
  '??': n => [`export let f = (x) => { let a = x > 100 ? 1 : null\n return ${R(n, () => 'a').join(' ?? ')} ?? x }`, 3],
  '?: returned': n => [`export let f = (x) => ${R(n, i => `x === ${i} ? ${i * 3} :`).join(' ')} -1`, 9],
  '?: in an expression': n => [`export let f = (x) => { const v = 1 + (${R(n, i => `x === ${i} ? ${i * 3} :`).join(' ')} -1)\n return v * 2 }`, 20],
  'call chain': n => [`export let f = (x) => { const o = { s: 0, add(v) { this.s += v; return this } }\n return o${R(n, i => `.add(${i % 7})`).join('')}.s + x }`, R(n, i => i % 7).reduce((a, b) => a + b, 0) + 3],
  'member chain': n => [`export let f = (x) => { const o = { v: x }; o.a = o\n return o${'.a'.repeat(n)}.v }`, 3],
  'comma': n => [`export let f = (x) => { let s = 0\n return (${R(n, i => `s += ${i}`).join(', ')}, s + x) }`, sum(n) + 3],
  'statements': n => [`export let f = (x) => { let s = 0\n${R(n, i => `s += x * ${i}`).join('\n')}\nreturn s }`, 3 * sum(n)],
  'statements on one line': n => [`export let f = (x) => { let s = 0; ${R(n, i => `s += x * ${i}`).join('; ')}; return s }`, 3 * sum(n)],
  'statements, two a line': n => [`export let f = (x) => { let s = 0, t = 0\n${R(n >> 1, i => `s += x * ${i}; t += 1`).join('\n')}\nreturn s + t }`, 3 * sum(n >> 1) + (n >> 1)],
  'string appends': n => [`export let f = (x) => { let s = ''\n${R(n, i => `s += 'k${i % 10}' + x`).join('\n')}\n return s.length }`, 3 * n],
  'const declarations': n => [`export let f = (x) => { const a0 = x\n${R(n - 1, i => `const a${i + 1} = a${i} + 1`).join('\n')}\n return a${n - 1} }`, 3 + n - 1],
  'array literal': n => [`export let f = (x) => [${R(n, i => i).join(', ')}].length + x`, n + 3],
  'object literal': n => [`export let f = (x) => { const o = { ${R(n, i => `k${i}: ${i}`).join(', ')} }; return o.k${n - 1} + x }`, n + 2],
}
// form → depth → source
const NESTS = {
  'call': d => `const g = (x) => x + 1\nexport let f = (x) => ${'g('.repeat(d)}x${')'.repeat(d)}`,
  'array literal': d => `export let f = (x) => ${'['.repeat(d)}x${']'.repeat(d)}.length`,
  'negation': d => `export let f = (x) => ${'-('.repeat(d)}x${')'.repeat(d)}`,
  'parentheses': d => `export let f = (x) => ${'('.repeat(d)}x + 1${')'.repeat(d)}`,
  'block': d => `export let f = (x) => { ${'if (x > 0) { x--; '.repeat(d)}${'}'.repeat(d)} return x }`,
  'arrow': d => `export let f = (x) => { const h = ${'(y) => '.repeat(d)}x; return x }`,
  'object literal': d => `export let f = (x) => { const o = ${'{ a: 1, b: '.repeat(d)}x${' }'.repeat(d)}; return o.a + x }`,
  'not': d => `export let f = (x) => ${'!'.repeat(d)}x`,
}
// form → depth → source: a nesting each walk takes a level at a time, where a walk
// that read each level twice took 2^n for n levels. At DEEP_N levels it compiles
// and answers what Node answers, at false, true, 'size' and 'speed' (each on the
// leg that owns its level), CPU t(DEEP_N) / t(DEEP_SMALL) at most RATIO.
const DEEP = {
  // the summary's numeric demand read a store's value once for the store and once
  // for the value the store yields (summary/index.js demand): 24 levels 3.2 s, 28 44 s
  'chained assignment': d => `export let f = (x) => { let ${R(d, i => `a${i}`).join(', ')}\n return (${R(d, i => `a${i}`).join(' = ')} = x + 1) * 2 + a0 + a${d - 1} }`,
}
const DEEP_N = 200, DEEP_SMALL = 50, DEEP_LIMIT = 120000
// `${kind} at ${level}` → what fails today, measured on 2026-11-17 on 14 cores at a
// load of 30 to 60, and again on 2026-11-18 by CPU time at a load of 130 to 250:
// 'compile', no module that answers (the row is held to fail, and the gate fails
// when it passes); 'time', a compile that answers in a time past the ratio or past
// the limit (a target the gate prints and does not hold; one that ends otherwise
// fails).
const KNOWN = new Map([
  // the summary takes a round a string append and stops at its cap of rounds
  // (summary/index.js): 2,500 appends compile, 10,000 end in "summary: no fixpoint"
  ['string appends at off', 'compile'], ['string appends at default', 'compile'],
  // watr's deadset scans a run of if statements by a pair of calls that call the
  // continuation at the same depth (watr optimize.js S and evalK): a switch of
  // 1,000 cases compiles, of 2,500 the stack ends (of 10,000 breaks the process
  // aborted, SIGABRT)
  ['switch of returns at default', 'compile'], ['switch of breaks at default', 'compile'],
  // watr forwards a local's one use into the next statement, re-nesting what the
  // list form laid flat (watr optimize.js substGets, tallyLocals): a sum of 1,000
  // links compiles, of 2,500 the stack ends; a run of 5,000 writes of one name too
  ['sum at default', 'compile'], ['difference at default', 'compile'],
  ['comma at default', 'compile'], ['statements at default', 'compile'], ['statements on one line at default', 'compile'], ['statements, two a line at default', 'compile'],
  ['const declarations at default', 'compile'],
  // answers, in a time that grows past the ratio or runs to minutes: watr's encoder
  // and the emitter on a call a link; the summary and the plan on an object of
  // 10,000 keys (2,500 keys 0.45 s, 10,000 keys 3.5 s: the summary 0.09 s to 1.1 s,
  // narrowSignatures 0.09 s to 0.7 s); at the default level, not yet profiled,
  // balanced trees, chunks behind a flag and a string + (at 10,000 links ||
  // 13 minutes, ?: 10, && 2.3 with t(10,000) / t(2,500) 21.8, ?? 2.1 with 10.0,
  // string + past 15 and within 30)
  ['call chain at off', 'time'], ['call chain at default', 'time'], ['member chain at default', 'time'],
  ['string + at default', 'time'],
  ['object literal at off', 'time'], ['object literal at default', 'time'],
  ['|| at default', 'time'], ['&& at default', 'time'], ['?? at default', 'time'], ['?: in an expression at default', 'time'],
  // watr's CSE copies what is live into each arm of a run of ifs (optimize.js
  // processScope): a guard list of 2,500 returns spent 1.3 s in watOptimize, of
  // 10,000 20.6 s, where jz's own stages grew 1.2 s to 2.7 s
  ['else-if of returns at default', 'time'], ['else-if of assignments at default', 'time'], ['?: returned at default', 'time'],
  // the store forwarding forgets at each store every slot the store may reach, by a
  // walk of all it holds (optimize/forward-store.js overwrite): the stores of one
  // straight list take their square. An array of 10,000 literals spends 3.6 s in
  // optimizeFuncs, of 2,500 0.48 s (CPU t(10,000) / t(2,500) 6.9 here, 7.6 on
  // 36330cd22, which the gate's cold wall times read as 4.6)
  ['array literal at default', 'time'],
])

// The row's child: SMALL compiled first to warm the compiler, then SRC and SMALL in
// turn, twice where SRC takes under a minute; the faster of each, wall and CPU time
// (ms, cpu), and SRC's answer.
const RUNNER = `import { pathToFileURL } from 'node:url'
const root = pathToFileURL(process.env.JZ_ROOT).href
const { compileInternal } = await import(root + 'src/compiler.js')
const { default: jzify } = await import(root + 'jzify/index.js')
const { instantiate } = await import(root + 'interop.js')
const opts = JSON.parse(process.env.OPTS), big = process.env.SRC, small = process.env.SMALL
const timed = (src) => {
  const c0 = process.cpuUsage(), t0 = performance.now(), r = {}
  try { r.w = compileInternal(src, opts, jzify) } catch (e) { r.e = e }
  const c = process.cpuUsage(c0)
  r.ms = performance.now() - t0; r.cpu = (c.user + c.system) / 1000
  return r
}
const warm = small ? timed(small) : null
const b = timed(big)
if (b.e) console.log(JSON.stringify({ ok: false, ms: b.ms, name: b.e.name, message: String(b.e.message).split('\\n').slice(0, 2).join(' | ') }))
else {
  let ms = b.ms, cpu = b.cpu, smallCpu = NaN
  if (small && !warm.e) {
    smallCpu = timed(small).cpu
    if (ms < 60000) { const b2 = timed(big); ms = Math.min(ms, b2.ms); cpu = Math.min(cpu, b2.cpu); smallCpu = Math.min(smallCpu, timed(small).cpu) }
  }
  console.log(JSON.stringify({ ok: true, ms, cpu, smallCpu, answer: instantiate(b.w).exports.f(3) }))
}`
const compiled = (src, optimize, small, limit = 900000) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', RUNNER], {
    env: { ...process.env, JZ_ROOT: ROOT, SRC: src, SMALL: small ?? '', OPTS: JSON.stringify({ optimize }) },
    encoding: 'utf8', timeout: limit, killSignal: 'SIGKILL', maxBuffer: 1 << 26,
  })
  try { return JSON.parse(r.stdout.trim().split('\n').pop()) }
  catch { return { ok: false, ms: NaN, name: 'exit', message: r.signal === 'SIGKILL' ? 'stopped past the limit' : r.signal ? `ended by ${r.signal}` : `exit ${r.status}: ${String(r.stderr).slice(0, 200)}` } }
}
const levelName = (o) => o === false ? 'off' : o === true ? 'default' : o
const skip = () => onKernel() || onWasi()

for (const optimize of levels(false, true, 'size', 'speed')) for (const [form, gen] of Object.entries(DEEP)) test(`limits: ${form} at ${DEEP_N} levels, the level ${levelName(optimize)}`, () => {
  if (skip()) return
  const row = `${form} at ${levelName(optimize)}`, src = gen(DEEP_N), want = oracle(src).f(3)
  const r = compiled(src, optimize, gen(DEEP_SMALL), DEEP_LIMIT)
  ok(r.ok && r.answer === want, `${row}: ${r.ok ? `answers ${r.answer}, Node ${want}` : `${r.name}: ${r.message}`}`)
  if (!r.ok) return
  const ratio = r.cpu / r.smallCpu
  console.log(`  ${row}: CPU ${r.cpu.toFixed(0)} ms, t(${DEEP_N}) / t(${DEEP_SMALL}) ${ratio.toFixed(1)}`)
  ok(ratio <= RATIO, `${row}: CPU t(${DEEP_N}) / t(${DEEP_SMALL}) = ${ratio.toFixed(1)}, at most ${RATIO}`)
})

for (const optimize of levels(false, true)) {
  const lv = levelName(optimize)
  // a test a row: one row's failure hides no other
  for (const [kind, gen] of Object.entries(KINDS)) test(`limits: ${kind} at ${N} links, the level ${lv}`, () => {
    if (skip()) return
    const row = `${kind} at ${lv}`, known = KNOWN.get(row)
    const [src, want] = gen(N), big = compiled(src, optimize, known === 'compile' ? null : gen(SMALL)[0])
    const answers = big.ok && big.answer === want
    if (known === 'compile') { ok(!answers, `${row}: fails as KNOWN says (${big.ok ? 'answers ' + big.answer : big.name + ' ' + big.message}); a pass takes it out of KNOWN`); return }
    // a target past the time limit is a target still
    if (known === 'time' && !big.ok && big.message === 'stopped past the limit') { console.log(`  ${row}: ${big.message} (a target)`); return }
    ok(answers, `${row}: ${big.ok ? `answers ${big.answer}, the generator ${want}` : `${big.name}: ${big.message}`}`)
    if (!answers) return
    // a ratio past the bound is measured once more, in a process of its own
    let ratio = big.cpu / big.smallCpu
    if (!(ratio <= RATIO) && known !== 'time') { const again = compiled(src, optimize, gen(SMALL)[0]); if (again.ok) ratio = Math.min(ratio, again.cpu / again.smallCpu) }
    console.log(`  ${row}: ${(big.ms / N).toFixed(2)} ms a link (CPU ${(big.cpu / N).toFixed(2)}), CPU t(${N}) / t(${SMALL}) ${ratio.toFixed(1)}${known ? ' (a target)' : ''}`)
    if (known !== 'time') ok(ratio <= RATIO, `${row}: CPU t(${N}) / t(${SMALL}) = ${ratio.toFixed(1)}, at most ${RATIO}`)
  })

  test(`limits: each nesting form at 5,000 levels is named, the level ${lv}`, () => {
    if (skip()) return
    for (const [form, gen] of Object.entries(NESTS)) {
      const r = compiled(gen(5000), optimize)
      ok(!r.ok && r.name === 'SyntaxError' && /nesting too deep to (parse|compile)/.test(r.message) && /at line \d+:\d+/.test(r.message), `${form}: ${r.ok ? 'compiles' : r.name + ': ' + r.message}`)
      const shallow = compiled(gen(200), optimize)
      ok(shallow.ok, `${form} at 200 levels compiles: ${shallow.ok || shallow.message}`)
    }
  })
}
