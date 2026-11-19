// How big an input compiles. A chain that is a list in meaning compiles at any
// length a machine writes (src/list-form.js, the loops of src/parse.js): each
// kind of KINDS at 10,000 links compiles and answers what its generator computes
// (V8 itself cannot parse some of them nested so deep, so the answer is the
// generator's), in a time a link that holds: t(10,000) / t(2,500) at most 6,
// where linear is 4 and quadratic 16. A nesting no list flattens is a
// SyntaxError that names its construct and its line and column, at 5,000 levels
// of each form (src/parse.js readTree, src/compiler.js nestingError); a nesting
// where a walk once read each level twice compiles at 200 levels and answers as
// Node does (DEEP), its time printed.
//
// Each row runs in a process of its own, at the levels this leg owns
// (_matrix.js levels: the level off on the opt0 leg, the default on the default
// leg), and times its two sizes there once the compiler is warm: a compile of
// the small one first, then each in turn, the least of up to three of each (a
// cold first compile, JIT warm-up included, read t(2,500) high and the ratio low).
// The time is the compiling thread's CPU time. On a machine shared with other
// work the wall time of a compile moved by half from run to run, and the
// process's CPU time, which counts the collector's and the JIT's threads beside
// it, moved a row near the bound across it (&& at the level off 5.0, then 7.0;
// by the thread's 6.7 to 8.0, the growth watr's encoder makes, below).
// KNOWN holds each row that fails today, with its cause: such a row is held to
// fail as it fails, or its time is printed as a target, so the list says what is
// true and the row that starts to pass is taken out of it.
//
// What holds today (watr 5.13.7): at the level off 11 of the 22 kinds, each in 5
// runs of 5 (3.3 to 5.9), and the 8 of WATR_LOCALS once watr takes a function's
// locals in one splice; at the default level no kind: 10 are held to fail (8 end
// in an internal stack overflow, 1 in SIGABRT, 1 in "summary: no fixpoint") and 12
// are printed as targets, each past the bound (by thread CPU on 2026-11-18 at a
// load of 9 to 22: ?: in an expression 7.1, array literal 8.5, object literal
// 10.5, else-if of assignments 10.6, ?? 10.8, ?: returned 13.3, || 13.3, else-if
// of returns 13.4, && 14.0, member chain 14.0, call chain 14.5, string + 16.4).
import test from 'tst'
import { ok, throws } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
// form → [depth → source, why its time is a target]: a nesting where a walk that
// read each level twice took 2^n for n levels. At DEEP_N levels it compiles within
// DEEP_LIMIT and answers what Node answers, at false, true, 'size' and 'speed' (each
// on the leg that owns its level); the 2^n walk ends past the limit at DEEP_SMALL
// levels already. Its time is printed, not held: walks that ask a level of all the
// levels below it still take the square of the depth. By thread CPU on 2026-11-18,
// the least of three warm compiles: chained assignment at 50, 150, 200 and 600
// levels 5.2, 18, 30 and 190 ms at the level off, 10, 28, 41 and 269 at the default
// (t(200) / t(50) 4.1 to 5.7, t(600) / t(150) 9.5 to 11.6 over the four levels, at
// a load of 55); nested index reads t(200) / t(50) 22 at the level off (3.3 s), 5.8
// at the default (4.2 s), 36 at 'size' (35.7 s), 5.6 at 'speed' (5.1 s), at a load
// of 20 to 29.
const DEEP = {
  // the summary's numeric demand read a store's value once for the store and once
  // for the value the store yields (summary/index.js demand): 24 levels 3.2 s, 28 44 s.
  // What stays: markEscapeValue (analyze/body-facts.js), valTypeOf, staticValue,
  // typedStorageFact and freshInit each ask of a store the stores below it
  'chained assignment': [d => `export let f = (x) => { let ${R(d, i => `a${i}`).join(', ')}\n return (${R(d, i => `a${i}`).join(' = ')} = x + 1) * 2 + a0 + a${d - 1} }`,
    'a level\'s value and type queries walk the levels below'],
  // the element read emitted its key as an index up front and again as a value on
  // the paths that read it so, the first copy left with its locals (module/array.js):
  // 12 levels declared 26,813 locals at the level off, 14 more than wasm takes, and
  // 200 ended in "internal: Map maximum size exceeded". What stays: valTypeOf of an
  // element read asks isPresentNumber of its key, which asks valTypeOf and the
  // summary's kindOfExpr of the key (kind/val-type-of.js, summary/query.js); at
  // 'size' watr's propagation of a local's one use (optimize.js substGets,
  // localWritesOnly) scans the levels below, the most of the time there
  'nested index reads': [d => `export let f = (x) => { const a = [1, 2, 3, x - 3]\n return ${'a['.repeat(d)}0${']'.repeat(d)} }`,
    'the kind queries walk the key at each level, and at \'size\' watr\'s substGets'],
}
const DEEP_N = 200, DEEP_SMALL = 50, DEEP_LIMIT = 300000
// watr's code encoder took each (local …) off a function's body by a shift, which
// moves the rest of the body: the locals times the body (watr src/compile.js), where
// jz at the level off declares about two locals a link. Through 5.13.7 the rows of
// WATR_LOCALS are targets; the release after it, which takes the locals in one splice
// (the watr branch encode-locals-linear), holds them. t(10,000) / t(2,500) by thread
// CPU on 2026-11-18, on 5.13.7 in five runs of the gate at a load of 12 to 20 and on
// that branch once at a load of 18 to 46: && 6.7 to 8.0 and 4.6, || 6.1 to 12.8 and
// 4.2, ?? 6.1 to 6.7 and 4.6, ?: in an expression 5.1 to 7.5 and 4.4, call chain 5.6
// to 6.0 and 4.0, string + 5.4 to 6.1 and 3.9, statements, two a line 4.0 to 6.0
// and 4.1, switch of breaks 3.8 to 5.1 and 4.4.
const WATR = JSON.parse(readFileSync(new URL('../node_modules/watr/package.json', import.meta.url), 'utf8')).version.split('.').map(Number)
const watrTakesLocals = WATR[0] !== 5 ? WATR[0] > 5 : WATR[1] !== 13 ? WATR[1] > 13 : WATR[2] > 7
const WATR_LOCALS = ['&&', '||', '??', 'string +', 'statements, two a line', 'call chain', '?: in an expression', 'switch of breaks']
// `${kind} at ${level}` → what fails today, measured on 2026-11-17 on 14 cores at a
// load of 30 to 60, on 2026-11-18 by the process's CPU time at a load of 130 to
// 250, and at the level off by the thread's at a load of 18 to 46:
// 'compile', no module that answers (the row is held to fail, and the gate fails
// when it passes); 'time', a compile that answers in a time past the ratio or past
// the limit (a target the gate prints and does not hold; one that ends otherwise
// fails).
const KNOWN = new Map([
  ...(watrTakesLocals ? [] : WATR_LOCALS.map(kind => [`${kind} at off`, 'time'])),
  // after an `if` whose arm leaves, the emitter asks of each name the test refines
  // whether a later statement of the block writes it, statement by statement
  // (emit/dispatch.js emitBlockBody): a switch's run of such ifs takes the square
  // of its cases, 0.8 s of 2.7 s in isReassigned at 10,000 (5.5 to 7.2 in five runs,
  // 6.5 on watr's branch)
  ['switch of returns at off', 'time'],
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
  // answers, in a time that grows past the ratio or runs to minutes: the summary
  // and the plan on an object of 10,000 keys (2,500 keys 0.45 s, 10,000 keys 3.5 s:
  // the summary 0.09 s to 1.1 s, narrowSignatures 0.09 s to 0.7 s; by thread CPU
  // 12.8 to 14.1 at the level off); at the default level, not yet profiled, balanced trees, chunks behind a
  // flag and a string + (at 10,000 links || 13 minutes, ?: 10, && 2.3 with
  // t(10,000) / t(2,500) 21.8, ?? 2.1 with 10.0, string + past 15 and within 30)
  ['call chain at default', 'time'], ['member chain at default', 'time'],
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

// The row's child: SMALL compiled first to warm the compiler, its answer printed,
// then SRC and SMALL in turn, three times where SRC takes under 20 s and twice
// under a minute; the least of each, wall and CPU time (ms, cpu), and SRC's answer.
// The CPU time is the compiling thread's (the process's on a Node with no thread
// clock): the process's counts the collector's and the JIT's threads beside it.
// The sources ride the child's standard input. In its environment a row never
// started on Linux, which bounds one environment string at 131,072 bytes
// (execve(2), MAX_ARG_STRLEN): twelve of the kinds are longer at 10,000 links, so
// on CI's runner six rows failed and six, held to fail, passed by it. The child
// says how each compile went, a module that does not run by its error: one that
// does not start, or ends unsaid and by no signal, is the gate's own failure and
// fails its row whatever KNOWN says of it.
const RUNNER = `import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const root = pathToFileURL(process.env.JZ_ROOT).href
const { compileInternal } = await import(root + 'src/compiler.js')
const { default: jzify } = await import(root + 'jzify/index.js')
const { instantiate } = await import(root + 'interop.js')
const { opts, big, small } = JSON.parse(readFileSync(0, 'utf8'))
const clock = process.threadCpuUsage ? (c) => process.threadCpuUsage(c) : (c) => process.cpuUsage(c)
const timed = (src) => {
  const c0 = clock(), t0 = performance.now(), r = {}
  try { r.w = compileInternal(src, opts, jzify) } catch (e) { r.e = e }
  const c = clock(c0)
  r.ms = performance.now() - t0; r.cpu = (c.user + c.system) / 1000
  return r
}
const answer = (w) => { try { return instantiate(w).exports.f(3) } catch (e) { return String(e) } }
const warm = small ? timed(small) : null
if (warm && !warm.e) console.log(JSON.stringify({ small: answer(warm.w) }))
const b = timed(big)
if (b.e) console.log(JSON.stringify({ ok: false, ms: b.ms, name: b.e.name, message: String(b.e.message).split('\\n').slice(0, 2).join(' | ') }))
else {
  let ms = b.ms, cpu = b.cpu, smallCpu = NaN
  if (small && !warm.e) {
    smallCpu = timed(small).cpu
    const rounds = ms < 20000 ? 3 : ms < 60000 ? 2 : 1
    for (let i = 1; i < rounds; i++) { const b2 = timed(big); ms = Math.min(ms, b2.ms); cpu = Math.min(cpu, b2.cpu); smallCpu = Math.min(smallCpu, timed(small).cpu) }
  }
  console.log(JSON.stringify({ ok: true, ms, cpu, smallCpu, answer: answer(b.w) }))
}`
const compiled = (src, optimize, small, limit = 900000) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', RUNNER], {
    env: { ...process.env, JZ_ROOT: ROOT }, input: JSON.stringify({ opts: { optimize }, big: src, small: small ?? '' }),
    encoding: 'utf8', timeout: limit, killSignal: 'SIGKILL', maxBuffer: 1 << 26,
  })
  if (r.error && r.error.code !== 'ETIMEDOUT') throw r.error
  const said = String(r.stdout).split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const end = said.find(o => o.ok !== undefined)
  if (!end && !r.signal) throw Error(`the row's child ended at ${r.status}: ${String(r.stderr).slice(0, 300)}`)
  return { ...(end ?? { ok: false, ms: NaN, name: 'exit', message: r.signal === 'SIGKILL' ? 'stopped past the limit' : `ended by ${r.signal}` }), small: said.find(o => o.small !== undefined)?.small }
}
// A row KNOWN as 'time' is stopped at TARGET_LIMIT. Its time is printed where the
// compile ends sooner and held nowhere, and run to the 15 minutes a held row has,
// the default level's targets took minutes each here (|| 13, ?: 10, && 2.3, ?? 2.1)
// and more on CI's runner than its suite has. What such a row holds: no failure
// before the stop, and the answer at 2,500 links.
const TARGET_LIMIT = 120000
const levelName = (o) => o === false ? 'off' : o === true ? 'default' : o
const skip = () => onKernel() || onWasi()

test('limits: a child that ends without saying how its compile went fails its row', () => {
  if (skip()) return
  const had = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = '--require=./no-such-module-of-the-limits-gate'
  try { throws(() => compiled('export let f = (x) => x', false), /the row's child ended at/) }
  finally { if (had === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = had }
})

for (const optimize of levels(false, true, 'size', 'speed')) for (const [form, [gen, cause]] of Object.entries(DEEP)) test(`limits: ${form} at ${DEEP_N} levels, the level ${levelName(optimize)}`, () => {
  if (skip()) return
  const row = `${form} at ${levelName(optimize)}`, src = gen(DEEP_N), want = oracle(src).f(3)
  const r = compiled(src, optimize, gen(DEEP_SMALL), DEEP_LIMIT)
  ok(r.ok && r.answer === want, `${row}: ${r.ok ? `answers ${r.answer}, Node ${want}` : `${r.name}: ${r.message}`}`)
  if (r.ok) console.log(`  ${row}: CPU ${r.cpu.toFixed(0)} ms, t(${DEEP_N}) / t(${DEEP_SMALL}) ${(r.cpu / r.smallCpu).toFixed(1)} (a target: ${cause})`)
})

for (const optimize of levels(false, true)) {
  const lv = levelName(optimize)
  // a test a row: one row's failure hides no other
  for (const [kind, gen] of Object.entries(KINDS)) test(`limits: ${kind} at ${N} links, the level ${lv}`, () => {
    if (skip()) return
    const row = `${kind} at ${lv}`, known = KNOWN.get(row)
    const [src, want] = gen(N), [small, wantSmall] = gen(SMALL)
    const big = compiled(src, optimize, known === 'compile' ? null : small, known === 'time' ? TARGET_LIMIT : undefined)
    const answers = big.ok && big.answer === want
    if (known === 'compile') { ok(!answers, `${row}: fails as KNOWN says (${big.ok ? 'answers ' + big.answer : big.name + ' ' + big.message}); a pass takes it out of KNOWN`); return }
    // the small one answers whatever becomes of the large (a target may be stopped before it has)
    const stopped = !big.ok && big.message === 'stopped past the limit'
    if (!(known === 'time' && stopped && big.small === undefined)) ok(big.small === wantSmall, `${row} at ${SMALL} links: answers ${big.small}, the generator ${wantSmall}`)
    // a target past the time limit is a target still
    if (known === 'time' && stopped) { console.log(`  ${row}: ${big.message} of ${TARGET_LIMIT / 1000} s (a target)`); return }
    ok(answers, `${row}: ${big.ok ? `answers ${big.answer}, the generator ${want}` : `${big.name}: ${big.message}`}`)
    if (!answers) return
    // a ratio past the bound is measured again, in up to two processes of their
    // own: the compiles of one process ran up to twice as long as another's at the
    // same load (statements at off, three processes in a row at a load of 13 to 17:
    // 5.9, 6.6 and 4.7), each process's own rounds alike
    let ratio = big.cpu / big.smallCpu
    for (let i = 0; i < 2 && !(ratio <= RATIO) && known !== 'time'; i++) { const again = compiled(src, optimize, small); if (again.ok) ratio = Math.min(ratio, again.cpu / again.smallCpu) }
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

  // 2 MB of comment before a function: more than macOS takes of arguments and
  // environment together (1 MB) and than Linux takes of one string, either of
  // which ended the child of a row whose source rode its environment
  test(`limits: a source of 2 MB reaches a row's child, the level ${lv}`, () => {
    if (skip()) return
    const r = compiled(`/*${'x'.repeat(2 << 20)}*/ export let f = (x) => x + 1`, optimize)
    ok(r.ok && r.answer === 4, r.ok ? `answers ${r.answer}` : `${r.name}: ${r.message}`)
  })
}
