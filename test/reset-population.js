// A population of arrays the module makes as it starts, mutated by its exports, each read after a
// reset as a fresh instance reads it (README, Memory: reset returns the module to its state after
// instantiation, and an array the module made as it started reads as it started) and each read
// after a reset round's calls as a fresh instance reads it after the same calls. An array of
// numbers, of strings or of both, of 0, 1, 2, 4 or 7 elements, held by a binding, an object's
// field or another array, left by the start as made, shifted, grown past its storage or edited;
// two or three exports, each one to four mutators from all of them (push, pop, shift and unshift
// of one or two, splice at 0 and inside, a store in bounds, at the end and past it, length set
// down and up, reverse, fill, copyWithin, sort, a push loop, a drain by shift, a rotation). A
// schedule of two or three rounds, each one to three calls, a read, `memory.reset()` and a read.
// The programs of a seed share a module and an instance: what one program's calls leave in the
// heap the next one's meet. The scratch resetprobe found every shift row differing at every
// level in 1.0.3 too: a shift moved the live header and rewrote the base's forward to it, and the
// round's record held neither (module/core/durable-log.js `__durable_arr_snap`, now the record
// of a shifted array from its base, and module/collection/durable.js durableArrSnapBaseIR, the
// shift's test of it). At 83fb473a5 seed 1 differed in 183 reads and seeds 2 to 4 gave no answer
// in 30 s at any level; with the shift's test taken out each seed differs in 117 to 168 reads,
// with the record from the live header alone in 30 to 79 and 5 of the 12 jobs give none in 30 s
// (2026-11-16, levels 1, 2 and size; the four seeds take 31 s at load 12). Each seed runs in a
// worker the test stops at a limit, so a hang is a failed assertion (test/_bounded.js).
import test from 'tst'
import { is } from 'tst/assert.js'
import { bounded } from './_bounded.js'
import { levels, onKernel } from './_matrix.js'

const LEVELS = levels(false, 1, true, 3, 'size', 'speed')
// A seed's compile and its instances, in the worker, at most this long (a hang fails here).
const LIMIT = 240000
// Elements read past the length: what a shrink leaves and a grow's holes.
const READ = 10

// ---- the generated programs (xorshift32, so a seed gives the same programs on every run)
const generate = (seed, count) => {
  let state = seed >>> 0 || 1
  const rnd = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296 }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
  const NUM = ['1', '2.5', '-3', '8', '0'], STR = [`'x'`, `'yz'`, `'w'`]
  const one = (j) => {
    const kind = pick(['num', 'str', 'mix']), size = pick([0, 1, 2, 4, 7])
    const v = () => kind === 'num' ? pick(NUM) : kind === 'str' ? pick(STR) : pick([...NUM, ...STR])
    const elems = Array.from({ length: size }, (_, i) => kind === 'num' || (kind === 'mix' && i % 2) ? String(11 + i) : `'${String.fromCharCode(112 + i)}'`)
    const lit = `[${elems.join(', ')}]`
    const holder = pick(['bind', 'bind', 'field', 'elem'])
    const decl = holder === 'bind' ? `const b = ${lit}` : holder === 'field' ? `const o = { k: 1, a: ${lit} }` : `const h = [${lit}, [5, 6]]`
    const P = holder === 'bind' ? 'b' : holder === 'field' ? 'o.a' : 'h[0]'
    // what the start does to it: a shift only last (two shifts or a shift then a read as the
    // start begins, before its first allocation, read the array wrong in 1.0.3 too)
    const start = pick(['', '', '', `${P}.shift()`, `${P}.push(${v()})`, `for (let i = 0; i < 6; i++) ${P}.push(${v()})`,
      `${P}.push(${v()}); ${P}.shift(); ${P}.shift()`, `${P}.unshift(${v()})`, `${P}.splice(0, 1)`, `${P}[1] = ${v()}`])
    const MUT = [`${P}.push(${v()})`, `${P}.push(${v()}, ${v()})`, `${P}.pop()`, `${P}.shift()`, `${P}.shift(); ${P}.shift()`,
      `${P}.unshift(${v()})`, `${P}.unshift(${v()}, ${v()})`, `${P}.splice(0, 1)`, `${P}.splice(1, 2)`, `${P}.splice(0, 0, ${v()})`,
      `${P}.splice(1, 0, ${v()}, ${v()})`, `${P}.splice(0, 1, ${v()})`, `${P}[0] = ${v()}`, `${P}[1] = ${v()}`,
      `${P}[${P}.length] = ${v()}`, `${P}[6] = ${v()}`, `${P}.length = 0`, `${P}.length = 1`, `${P}.length = 5`,
      `${P}.reverse()`, `${P}.fill(${v()})`, `${P}.fill(${v()}, 1, 3)`, `${P}.copyWithin(0, 1)`, `${P}.copyWithin(1, 0, 2)`,
      `for (let i = 0; i < 5; i++) ${P}.push(${v()})`, `while (${P}.length > 1) ${P}.shift()`, `${P}.push(${P}.shift())`,
      ...(kind === 'num' ? [`${P}.sort((x, y) => x - y)`] : kind === 'str' ? [`${P}.sort()`] : [])]
    const nm = int(2, 3), muts = []
    for (let i = 0; i < nm; i++) muts.push(Array.from({ length: int(1, 4) }, () => pick(MUT)).join('; '))
    const text = [decl, start, ...muts.map((body, i) => `export let m${i} = () => { ${body}; return 0 }`),
      `export let n = () => ${P}.length`,
      `export let at = (i) => { const v = ${P}[i]; return v === undefined ? -1 : typeof v === 'string' ? v.length * 1000 + v.charCodeAt(0) : v }`].filter(Boolean).join('\n')
    const rounds = Array.from({ length: int(2, 3) }, () => Array.from({ length: int(1, 3) }, () => `m${int(0, nm - 1)}`))
    return { j, text, rounds }
  }
  return Array.from({ length: count }, (_, j) => one(j))
}

// A program's own names, numbered.
const OWN = /\b(b|o|h|m\d|n|at|t|code|K)\b/g
const reads = (j) => [[`n_${j}`, []], ...Array.from({ length: READ }, (_, i) => [`at_${j}`, [i]])]

// A seed's programs as one module on one instance: each round, every program's calls, every
// program read, the reset, every program read. The oracle: a fresh instance read, and for each
// round a fresh instance after that round's calls, read.
const population = (label, progs) => {
  if (onKernel()) return
  const src = progs.map(p => p.text.replace(OWN, `$1_${p.j}`)).join('\n')
  const R = Math.max(...progs.map(p => p.rounds.length))
  const calls = (r) => progs.flatMap(p => (p.rounds[r] ?? []).map(m => [`${m}_${p.j}`, []]))
  const readAll = () => progs.flatMap(p => reads(p.j))
  const main = [], fresh = [readAll()]
  for (let r = 0; r < R; r++) {
    main.push(...calls(r), ...readAll(), ['@reset', []], ...readAll())
    fresh.push([...calls(r), ...readAll()])
  }
  const per = READ + 1
  // a program's reads out of a run's answers: the run's answers from `at`, program by program
  const slice = (answers, at, j) => answers.slice(at + j * per, at + (j + 1) * per).join(' ')
  let checks = 0
  const bad = []
  for (const optimize of LEVELS) {
    const out = bounded({ src, optimize, runs: [main, ...fresh] }, LIMIT)
    if (out.hung) {
      bad.push(`no answer in ${LIMIT / 1000} s at ${JSON.stringify(optimize)}, run ${out.hung[0]} at its call ${out.hung[1]}`)
      continue
    }
    const [got, start, ...after] = out.results
    let at = 0
    for (let r = 0; r < R; r++) {
      at += calls(r).length
      const want = after[r], base = calls(r).length
      for (const p of progs) {
        if (r >= p.rounds.length) continue
        const where = (what, a, b) => `program ${p.j} at ${JSON.stringify(optimize)}, round ${r + 1} ${what}: [${a}] for [${b}]\n${p.text}\n  rounds ${p.rounds.map(c => c.join(' ')).join(' | ')}`
        const a = slice(got, at, p.j), w = slice(want, base, p.j)
        const z = slice(got, at + progs.length * per + 1, p.j), s = slice(start, 0, p.j)
        checks += 2
        if (a !== w) bad.push(where('after its calls', a, w))
        if (z !== s) bad.push(where('after the reset', z, s))
      }
      at += 2 * progs.length * per + 1
    }
  }
  // one assertion a module: what it ran, and the first of what differed
  is(bad.length, 0, `${label}: ${progs.length} programs, ${checks} reads at ${LEVELS.length} levels, ${bad.length} differing from a fresh instance's${bad.length ? '; the first:\n' + bad.slice(0, 3).join('\n') : ''}`)
}

for (const seed of [1, 2, 3, 4])
  test(`reset population: seed ${seed}, 100 arrays made at start on one instance, read after each reset as a fresh instance reads them`, () => population(`seed ${seed}`, generate(seed, 100)))

// The stores a store through a literal of the running call leaves unsaved must not reach: the
// census's freshObjects holds a binding whose every value is an object or array literal the call
// made (compile/analyze/frame-effects.js), and its element stores keep no snapshot
// (module/collection/durable.js madeByCall). A binding that also takes a parameter, a module
// binding or a callee's result is not in it, nor is an array a closure or a generator keeps past
// the call that made it. The last two: a literal a call of the start made and a module binding
// keeps is durable, and later stores reach it through the binding, never the call's local, while
// the start's own store needs no record (the start is no round). Each a module of its own.
const READS = (P) => `export let n = () => ${P}.length
export let at = (i) => { const v = ${P}[i]; return v === undefined ? -1 : v }`
const FIXED = [
  // (reassigned under a test the compiler cannot decide: a reassignment in line is a binding of its own)
  ['a local reassigned from a parameter', `const G = [1, 2, 3]
const g = (p, k) => { let b = [5]; if (k !== 0) b = p; b[0] = 9; b.push(4) }
export let m0 = (k) => { g(G, k); return 0 }
${READS('G')}`],
  ['a local reassigned from a module binding', `const G = [1, 2, 3]
export let m0 = (k) => { let b = [7]; if (k !== 0) b = G; b[1] = 9; b.push(4); return 0 }
${READS('G')}`],
  ["a callee's result", `const G = [1, 2, 3]
const pick = () => G
export let m0 = () => { const b = pick(); b[2] = 9; b.push(4); return 0 }
${READS('G')}`],
  ['an array a closure made at start keeps', `const mk = () => { const b = [1, 2]; return (k) => { if (k) { b[0] = 9; b.push(3) } return b } }
const c = mk()
const B = c(0)
export let m0 = () => { c(1); return 0 }
${READS('B')}`],
  ['an array a closure made in a round keeps', `const mk = () => { const b = [1, 2]; return (k) => { if (k) b[0] = 9; return b } }
let c = null, B = [0]
export let m0 = () => { c = mk(); B = c(1); return 0 }
${READS('B')}`],
  // (one round: the generator's step is a number of its frame, which a reset keeps)
  ['a generator begun at start, its array across a yield', `function* gen() { const b = [1, 2, 3]; yield b; b[0] = 9; b.push(7); yield b }
const it = gen()
const B = it.next().value
export let m0 = () => { it.next(); return 0 }
${READS('B')}`, [['m0']]],
  ["a generator begun at start, a binding of one step", `function* gen() { let k = 0; while (true) { const b = [k, 2]; b[1] = 5; G.push(b[1]); k++; yield k } }
const G = [1]
const it = gen()
it.next()
export let m0 = () => { it.next(); return 0 }
${READS('G')}`],
  ['a literal a call of the start made, kept by a module binding, stored into again', `let KEEP = [0]
const mk = () => { const b = [1, 2]; KEEP = b; b[0] = 9; return b }
mk()
export let m0 = () => { mk(); return 0 }
export let m1 = () => { KEEP[1] = 7; KEEP.push(5); return 0 }
${READS('KEEP')}`, [['m0'], ['m1'], ['m0', 'm1']]],
  ['a literal a call of a round made, kept by a module binding', `let G2 = [0]
export let m0 = () => { const b = [1, 2]; G2 = b; b[0] = 9; b.push(3); return 0 }
export let m1 = () => { G2[0] = 4; return 0 }
${READS('G2')}`, [['m0'], ['m1'], ['m0', 'm1']]],
]
for (const [name, text, rounds = [['m0'], ['m0', 'm0']]] of FIXED)
  test(`reset population: ${name}`, () => population(name, [{ j: 0, text, rounds }]))

// The same generator pointed at a Map, a Set and an object made at start: keys and values of
// the static data, strings the call makes (short enough to be held inline, or on the heap) and
// arrays it makes; a set of a new and of a present key, a fused update (`set(k, get(k))`, `if
// (!has(k)) set(k, v)`), a delete of a present and of a missing key, a clear, a growth past the
// table; an object's field given a string, an array, a boolean or a new key (a field that
// holds a number keeps it, README). A delete, a clear and a store of a number or of a string
// that names no memory of the round outlived the reset in 1.0.3 too (246 of 360 programs and
// levels of a Map differed): a Map's or a Set's table is now saved whole at its round's first
// write (module/core/durable-log.js `__durable_tbl_snap`), and an object's field record taken
// for any value that is no number. A Map's, a Set's and an object's reads walk them in order.
// Before (e521f93b8) the Maps' seeds differed in 398 and 388 reads, the Sets' in 349 and 187, the
// objects' in 363 and 312; with the table's save taken out the Maps and a Set never answer in
// 30 s and the other Set differs in 366; with the field record back to pointers alone the
// objects differ in 351 and 294 (2026-11-16, levels 1, 2 and size). A dictionary (an object
// whose keys a program computes, its storage a table of its own, module/collection/upsert.js)
// is saved whole as the tables are, its numbers too: at 152b40849, whose dictionaries kept the
// entries' own logs, the dictionaries' seeds differed in 312 and 354 reads and the objects' in
// 3 and 6 (a key the start added, written in a round); with the dictionary's save taken out
// the dictionaries differ in 168 and 193 and some never answer, the objects in 48 and 99.
const generateTables = (seed, count, target) => {
  let state = (seed * 7919 + target.length) >>> 0 || 1
  const rnd = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296 }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
  const one = (j) => {
    const size = pick([0, 1, 2, 4, 7]), holder = pick(['bind', 'bind', 'field'])
    const keys = Array.from({ length: size }, (_, i) => i % 3 === 2 ? String(i) : `'${String.fromCharCode(112 + i)}'`)
    const vals = Array.from({ length: size }, (_, i) => i % 2 ? String(11 + i) : `'${String.fromCharCode(97 + i)}${i}'`)
    // a value: a number or a string of the static data, a string or an array the call makes
    const v = () => pick(['8', '-3', `'x'`, `'yz'`, `'w' + (t++)`, `'a string made in the call, long enough for the heap ' + (t++)`, '[t++, 1]', 'true'])
    // (a field the object has from its literal holds a string: one given a number keeps it)
    const vo = () => pick([`'x'`, `'yz'`, `'w' + (t++)`, `'a string made in the call, long enough for the heap ' + (t++)`, '[t++, 1]', 'true'])
    const k = () => pick([`'p'`, `'q'`, `'r'`, `'s'`, `'kz'`, '3', '4'])
    const made = target === 'map' ? `new Map([${keys.map((key, i) => `[${key}, ${vals[i]}]`).join(', ')}])`
      : target === 'set' ? `new Set([${vals.join(', ')}])`
      : target === 'dict' ? '{}'
      : `{ ${keys.map((key, i) => `${/^\d/.test(key) ? `[${key}]` : key.slice(1, -1)}: ${i % 2 ? `'${String.fromCharCode(97 + i)}'` : vals[i]}`).join(', ')} }`
    const decl = holder === 'bind' ? `const b = ${made}` : `const o = { k: 1, a: ${made} }`
    const P = holder === 'bind' ? 'b' : 'o.a'
    const MUT = target === 'map' ? [`${P}.set(${k()}, ${v()})`, `${P}.set('p', ${v()})`, `${P}.delete(${k()})`, `${P}.delete('p')`, `${P}.clear()`,
        `for (let i = 0; i < 9; i++) ${P}.set(i * 7, ${v()})`, `${P}.set(${P}.size, ${v()})`, `${P}.delete('q'); ${P}.set('q', ${v()})`,
        `${P}.set('p', ${P}.get('q'))`, `if (!${P}.has(${k()})) ${P}.set(${k()}, ${v()})`]
      : target === 'set' ? [`${P}.add(${v()})`, `${P}.add('a0')`, `${P}.delete(${v()})`, `${P}.delete(11 + 1)`, `${P}.delete('a0')`, `${P}.clear()`,
        `for (let i = 0; i < 9; i++) ${P}.add(i * 7)`, `${P}.add(${P}.size)`, `if (!${P}.has('c2')) ${P}.add('c2')`]
      : target === 'dict' ? [`${P}[K[${int(0, 6)}]] = ${v()}`, `${P}[K[${int(0, 6)}]] = ${v()}`, `delete ${P}[K[${int(0, 6)}]]`,
        `${P}[K[${int(0, 6)}]] = ${P}[K[${int(0, 6)}]]`, `for (let i = 0; i < 9; i++) ${P}['g' + i] = ${v()}`, `for (const key of Object.keys(${P})) delete ${P}[key]`]
      : [`${P}.p = ${vo()}`, `${P}.q = ${vo()}`, `${P}.zz = ${vo()}`, `${P}[3] = ${vo()}`, `${P}.p = ${P}.q`]
    const read = target === 'map' ? `let c = 0; for (const [k, v] of ${P}) { if (c++ === i) return code(k) * 1000 + code(v) } return -1`
      : target === 'set' ? `let c = 0; for (const v of ${P}) { if (c++ === i) return code(v) } return -1`
      : `const ks = Object.keys(${P}); return i < ks.length ? code(ks[i]) * 1000 + code(${P}[ks[i]]) : -1`
    const nm = int(2, 3), muts = []
    for (let i = 0; i < nm; i++) muts.push(Array.from({ length: int(1, 4) }, () => pick(MUT)).join('; '))
    // a dictionary's keys, the start's values at them (strings it makes, numbers, arrays), and a mutation
    const fill = target !== 'dict' ? '' : `const K = ['p', 'q', 'r', 's', 'kz', 'k5', 'k6']
for (let i = 0; i < ${size}; i++) ${P}[K[i]] = i % 3 === 0 ? 's' + i : i % 3 === 1 ? 11 + i : [i, 'a' + i]`
    const start = rnd() >= 0.3 ? '' : pick(MUT)
    const text = ['let t = 0', decl, fill, start,
      ...muts.map((body, i) => `export let m${i} = () => { ${body}; return 0 }`),
      `export let n = () => ${target === 'obj' || target === 'dict' ? `Object.keys(${P}).length` : `${P}.size`}`,
      `const code = (v) => typeof v === 'string' ? 100 + v.length * 7 + v.charCodeAt(0) : typeof v === 'number' ? v : Array.isArray(v) ? 500 + v.length : v === true ? 700 : -2`,
      `export let at = (i) => { ${read} }`].filter(Boolean).join('\n')
    const rounds = Array.from({ length: int(2, 3) }, () => Array.from({ length: int(1, 3) }, () => `m${int(0, nm - 1)}`))
    return { j, text, rounds }
  }
  return Array.from({ length: count }, (_, j) => one(j))
}
for (const target of ['map', 'set', 'obj', 'dict']) for (const seed of [1, 2])
  test(`reset population: seed ${seed}, 60 ${{ obj: 'objects', dict: 'dictionaries', map: 'Maps', set: 'Sets' }[target]} made at start, read after each reset as a fresh instance reads them`,
    () => population(`${target} seed ${seed}`, generateTables(seed, 60, target)))
// (a string the call makes short enough to be held inline names no memory: the entries' own
// value log let it stay past the reset)
test('reset population: a short string a call makes, stored into a Map made at start', () => population('inline string', [{ j: 0, rounds: [['m0'], ['m0', 'm0']], text: `let t = 0
const b = new Map([['p', 'start'], ['q', 7]])
export let m0 = () => { b.set('p', 'w' + (t++)); b.set('q', 'v' + t); return 0 }
export let n = () => b.size
export let at = (i) => { let c = 0; for (const [k, v] of b) { if (c++ === i) return typeof v === 'string' ? v.length * 1000 + v.charCodeAt(v.length - 1) : v } return -1 }` }]))
