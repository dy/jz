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
const OWN = /\b(b|o|h|m\d|n|at)\b/g
const reads = (j) => [[`n_${j}`, []], ...Array.from({ length: READ }, (_, i) => [`at_${j}`, [i]])]

// A seed's programs as one module on one instance: each round, every program's calls, every
// program read, the reset, every program read. The oracle: a fresh instance read, and for each
// round a fresh instance after that round's calls, read.
const population = (seed, progs) => {
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
  // one assertion a seed: what it ran, and the first of what differed
  is(bad.length, 0, `seed ${seed}: ${progs.length} programs, ${checks} reads at ${LEVELS.length} levels, ${bad.length} differing from a fresh instance's${bad.length ? '; the first:\n' + bad.slice(0, 3).join('\n') : ''}`)
}

for (const seed of [1, 2, 3, 4])
  test(`reset population: seed ${seed}, 100 arrays made at start on one instance, read after each reset as a fresh instance reads them`, () => population(seed, generate(seed, 100)))
