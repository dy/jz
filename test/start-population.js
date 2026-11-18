// A population of arrays the module mutates as it starts, each answering what Node answers, no
// reset. One or two module arrays of numbers, of strings or of both, of 0, 1, 2, 4 or 7 elements,
// a literal of the static data or one built at run time, held by a binding, an object's field or
// another array; one to five top-level statements over them: a mutator of every kind (push, pop,
// shift and unshift of one or two, splice at 0 and inside, a store in bounds, at the end and past
// it, length set down and up, reverse, fill, copyWithin, sort, a push loop, a drain by shift, a
// rotation), a read of the length or an element, a loop over the length (`while (q.length > k)
// s += q.shift()`, a for, a for-of, a drain by pop); then exports that read every array and
// mutate further, called in turn. Each program is a module of its own, run in a worker the test
// stops at a limit: the defect's symptom was a start that never ended. The forwarding chase's
// bound (layout.js followForwardingWat) read 0 until the module's first allocation grew the
// memory, so a forward a shift wrote into an array of the static data was not followed while
// the module started: a second shift, a push, a read of the length read the forward as the
// header (wat/assemble/stdlib-pull.js now seeds the bound with the memory's initial size). With
// the seed taken out 22, 20 and 12 runs of the three seeds differ, some never answering in 5 s
// (2026-11-16, levels 1, 2 and size; the three seeds take 191 s).
import test from 'tst'
import { is } from 'tst/assert.js'
import { bounded } from './_bounded.js'
import { levels, onKernel } from './_matrix.js'
import { sample, sampled } from './_population.js'

const LEVELS = levels(false, 1, true, 3, 'size', 'speed')
// One program's compile and its instance, in the worker, at most this long (a hang fails here).
const LIMIT = 60000
// The exports a program's instance is called with, in turn.
const CALLS = ['f', 'g', 'f', 'g', 'f']
const show = v => Object.is(v, -0) ? '-0' : String(v)

// ---- the generated programs (xorshift32, so a seed gives the same programs on every run)
const generate = (seed, count) => {
  let state = seed >>> 0 || 1
  const rnd = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296 }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
  const NUM = ['1', '2.5', '-3', '8', '0'], STR = [`'x'`, `'yz'`, `'w'`]
  const one = () => {
    const arrays = Array.from({ length: int(1, 2) }, (_, k) => {
      const kind = pick(['num', 'str', 'mix']), size = pick([0, 1, 2, 4, 7])
      const v = () => kind === 'num' ? pick(NUM) : kind === 'str' ? pick(STR) : pick([...NUM, ...STR])
      const elems = Array.from({ length: size }, (_, i) => kind === 'num' || (kind === 'mix' && i % 2) ? String(11 + i + 10 * k) : `'${String.fromCharCode(112 + i)}'`)
      const lit = `[${elems.join(', ')}]${rnd() < 0.3 ? '.slice()' : ''}`
      const holder = pick(['bind', 'bind', 'field', 'elem'])
      const name = 'ab'[k]
      const decl = holder === 'bind' ? `const ${name} = ${lit}` : holder === 'field' ? `const o${name} = { k: 1, a: ${lit} }` : `const h${name} = [${lit}, [5, 6]]`
      const P = holder === 'bind' ? name : holder === 'field' ? `o${name}.a` : `h${name}[0]`
      const MUT = [`${P}.push(${v()})`, `${P}.push(${v()}, ${v()})`, `${P}.pop()`, `${P}.shift()`, `${P}.shift(); ${P}.shift()`,
        `${P}.unshift(${v()})`, `${P}.unshift(${v()}, ${v()})`, `${P}.splice(0, 1)`, `${P}.splice(1, 2)`, `${P}.splice(0, 0, ${v()})`,
        `${P}.splice(1, 0, ${v()}, ${v()})`, `${P}.splice(0, 1, ${v()})`, `${P}[0] = ${v()}`, `${P}[1] = ${v()}`,
        `${P}[${P}.length] = ${v()}`, `${P}[6] = ${v()}`, `${P}.length = 0`, `${P}.length = 1`, `${P}.length = 5`,
        `${P}.reverse()`, `${P}.fill(${v()})`, `${P}.fill(${v()}, 1, 3)`, `${P}.copyWithin(0, 1)`, `${P}.copyWithin(1, 0, 2)`,
        `for (let i = 0; i < 5; i++) ${P}.push(${v()})`, `while (${P}.length > 1) ${P}.shift()`, `${P}.push(${P}.shift())`,
        ...(kind === 'num' ? [`${P}.sort((x, y) => x - y)`] : kind === 'str' ? [`${P}.sort()`] : [])]
      const READ = [`s += ${P}.length`, `s += val(${P}[0])`, `s += val(${P}[${P}.length - 1])`, `while (${P}.length > ${int(0, 2)}) s += val(${P}.shift())`,
        `for (let i = 0; i < ${P}.length; i++) s += val(${P}[i])`, `for (const x of ${P}) s += val(x)`, `while (${P}.length > ${int(0, 2)}) s += val(${P}.pop())`,
        `if (${P}.length) s += val(${P}.shift())`]
      return { decl, P, MUT, READ }
    })
    const top = Array.from({ length: int(1, 5) }, () => { const a = pick(arrays); return rnd() < 0.6 ? pick(a.MUT) : pick(a.READ) })
    const sig = arrays.map(a => `for (let i = 0; i < ${a.P}.length; i++) h = (h * 31 + val(${a.P}[i])) % 1000003; h = h * 100 + ${a.P}.length`).join('; ')
    const g = Array.from({ length: int(1, 3) }, () => { const a = pick(arrays); return pick([...a.MUT, ...a.MUT, ...a.READ]) }).join('; ')
    return [`const val = (v) => v === undefined ? -1 : typeof v === 'string' ? v.length * 1000 + v.charCodeAt(0) : v`,
      ...arrays.map(a => a.decl), 'let s = 0', ...top,
      `export let f = () => { let h = s; ${sig}; return h }`,
      `export let g = () => { ${g}; return s }`].join('\n')
  }
  return Array.from({ length: count }, one)
}

// Node's answers: the module as a function body, its exports called as the instance's are.
const node = (text) => {
  try {
    const m = new Function(`${text.replace(/export /g, '')}\nreturn { f, g }`)()
    return CALLS.map(c => show(m[c]()))
  } catch { return null }
}

const population = (seed, progs) => {
  if (onKernel()) return
  const kept = sample(progs.map((text, j) => ({ j, text })), `seed ${seed}`)
  const live = kept.map(p => ({ ...p, want: node(p.text) })).filter(p => p.want)
  const bad = []
  let checks = 0
  for (const optimize of LEVELS) for (const p of live) {
    const out = bounded({ src: p.text, optimize, runs: [CALLS.map(c => [c, []])] }, LIMIT)
    const got = out.hung ? null : out.results[0]
    checks++
    if (!got) bad.push(`program ${p.j} at ${JSON.stringify(optimize)}: no answer in ${LIMIT / 1000} s\n${p.text}`)
    else if (got.join(' ') !== p.want.join(' ')) bad.push(`program ${p.j} at ${JSON.stringify(optimize)}: ${got.join(' ')} for Node's ${p.want.join(' ')}\n${p.text}`)
  }
  is(bad.length, 0, `seed ${seed}: ${live.length} programs of ${kept.length}${kept.length < progs.length ? ` (a sample of ${progs.length})` : ''} (${kept.length - live.length} Node throws on), ${checks} runs at ${LEVELS.length} levels, ${bad.length} differing from Node's${bad.length ? '; the first:\n' + bad.slice(0, 3).join('\n') : ''}`)
}

for (const seed of [1, 2, 3])
  test(sampled(`start population: seed ${seed}, 100 modules that mutate their arrays as they start, against Node`), () => population(seed, generate(seed, 100)))
