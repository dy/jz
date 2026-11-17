// A population of arrays read through what the summary knows of their elements, each module
// answering what Node answers. The summary bounds the Numbers an array holds (its literal, its
// pushes, its indexed stores, a compound store's operation, an element copied from another array,
// a parameter's arguments, a counter's interval) and proves an array free of holes (a literal, a
// count filled at once, a counter from 0 whose every round stores at it); a word conversion of an
// element then truncates it with no test of its magnitude (ir/numeric.js hullWord) and a read
// skips the hole's test. Around those facts: an array filled partly, one grown by `length`, a
// sparse literal, one read before a store, one a late store gives a fraction, a large Number, -0,
// NaN, Infinity, a string, undefined or null, one a helper stores into, one whose elements another
// array's copy shifts, one a compound store sets the sign bit of, one two counters closing from
// both ends swap (a count past the length, an argument's), and the reads past the length.
// Each export hashes the elements by `& M`, `| 0`, `>>> 0`, `~`, `<< 1`, `>> 1` and as Numbers,
// and reads another array at an index one of them makes. A schedule of calls Node answers; every
// program a module of its own in a worker the test stops at a limit (test/_bounded.js), at the
// four public levels. (A Number past 2^63 under a bitwise operator is the README's divergence:
// none is stored here.)
import test from 'tst'
import { is } from 'tst/assert.js'
import { bounded } from './_bounded.js'
import { onKernel } from './_matrix.js'

const LEVELS = [false, true, 'size', 'speed']
const LIMIT = 60000
const show = v => Object.is(v, -0) ? '-0' : String(v)

const generate = (seed, count) => {
  let state = seed >>> 0 || 1
  const rnd = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296 }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
  const one = () => {
    const N = int(3, 9)
    // the integers an array starts with: small, past 2^31 by `>>> 0`, signed by `|`, past 2^32
    const value = pick(['i', `${N} - 1 - i`, `(i | 0x80000000) >>> 0`, '(i * 3 + 1) | 0x40000000', 'i * 4294967296 + 5', '-i'])
    const make = pick([
      `const A = []\nfor (let i = 0; i < ${N}; i++) A.push(${value})`,
      `const A = []\nfor (let i = 0; i < ${N}; i++) A[i] = ${value}`,
      `const A = new Array(${N})\nfor (let i = 0; i < ${N}; i++) A[i] = ${value}`,
      `const A = new Array(${N})\nfor (let i = 0; i < ${N - 1}; i++) A[i] = ${value}`,
      `const A = [${Array.from({ length: N }, (_, i) => i % 3 === 1 ? '' : String(i * 7)).join(', ')}]`,
      `const A = [${Array.from({ length: N }, (_, i) => String((i * 2654435761) % 4294967296)).join(', ')}]`,
      `const A = []\nfor (let i = 0; i < ${N}; i++) A.push(${value})\nA.length = ${N + 2}`,
      `const A = []\nconst first = A[0] | 0\nfor (let i = first; i < ${N}; i++) A[i] = ${value}`,
      `const A = []\n{ let c = 0; for (let i = 0; i < ${N}; i++) A[c++] = ${value} }`,
    ])
    // what may come late: a value of another kind, a helper's store, a shifting copy, a compound store
    const late = () => pick([
      'A[k & 3] = 2.5', 'A[k & 3] = 1e15', 'A[k & 3] = -0', 'A[k & 3] = NaN', 'A[k & 3] = Infinity', "A[k & 3] = '7'",
      'A[k & 3] = undefined', 'A[k & 3] = null', 'spoil(A, k)', 'for (let j = 0; j < A.length - 1; j++) A[j] = A[j + 1]',
      'A[k & 3] |= 0x80000000', 'A[k & 3] &= 0xff', 'A[k & 3] += 0.5', 'A.push(k)', 'A.pop()', 'A[A.length + 1] = 3',
      `swap(A, ${N})`, `swap(A, ${N + 3})`, 'swap(A, k)',
    ])
    const lates = Array.from({ length: int(0, 2) }, late)
    // (two counters closing from both ends, the count a call gives: pmndrs/math's reverse)
    const helper = 'const spoil = (X, v) => { X[1] = v }\nconst swap = (X, n) => { for (let lo = 0, hi = n - 1; lo < hi; lo++, hi--) { const t = X[lo]; X[lo] = X[hi]; X[hi] = t } }\n'
    // the reads: a word of each element, past the length too, and an index another array is read at
    const word = pick(['A[s] & 0xffff', '(A[s] | 0) % 977', '(A[s] >>> 3) % 989', '~A[s] & 7', '(A[s] << 1) % 9973', '(A[s] >> 1) % 9967'])
    const V = `const V = [${Array.from({ length: 8 }, (_, i) => String(i * 11 + 1)).join(', ')}]\n`
    const walk = `export let f = (n, k) => { let h = 0; ${lates.join('; ')}${lates.length ? '; ' : ''}for (let s = 0; s < A.length + 2; s++) h = (h * 31 + (${word}) + V[(A[s] & 0x0fffffff) % 8]) % 1000003; return h }`
    const asNumbers = `export let g = (n, k) => { let h = 0; for (let s = 0; s < A.length + 1; s++) h = (h * 7 + (A[s] * 1 === A[s] * 1 ? (A[s] * 1) % 1009 : 13)) % 1000003; return h + A.length }`
    const text = `${helper}${V}${make}\n${walk}\n${asNumbers}`
    const K = [0, 1, 2, 3, 5, -1, 1.5, NaN]
    const schedule = Array.from({ length: int(3, 6) }, () => [pick(['f', 'g']), [pick([0, 1, 3]), pick(K)]])
    return { text, names: ['f', 'g'], schedule }
  }
  return Array.from({ length: count }, one)
}

const node = (p) => {
  const m = new Function(`${p.text.replace(/export let /g, 'let ')}\nreturn { ${p.names.join(', ')} }`)()
  return p.schedule.map(([name, args]) => { try { return show(m[name](...args)) } catch { return 'throws' } })
}

// The word a level reads off memory (ir/numeric.js memoryWord, optimize/int-narrow.js
// provenForm: the 64-bit truncation's low word, the sum with 1.5·2^52 at speed, its exponent
// tested where an element may be missing): arrays filled by push, by index, by a literal, by
// `Array.from` and by `map`, of integers at the word's ends, 0 and -0, fractions; a hole,
// undefined or null among them, or stored once the reads have run as words: a NaN, a number
// past the word, -0, a fraction, the array grown and shrunk. Read directly, through a parameter,
// through a field, and a record's field of integers; under `| 0`, `>> k`, `>>> 0`, `& mask`,
// `~`, an index into another array, a typed array's store and `Math.imul`. Level 1 too, whose
// form is its own (the 64-bit truncation, no integer registers).
const generateWords = (seed, count) => {
  let state = seed >>> 0 || 1
  const rnd = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296 }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
  const one = () => {
    const N = int(3, 9)
    const value = pick(['i - 3', 'i & 1 ? -2147483648 + (i >> 1) : 2147483647 - (i >> 1)', 'i % 3 === 2 ? -2147483648 : i * 3', '-i', 'i * 0.5 - 1', '(i % 4) * 0.25 + i'])
    const at = new Function('i', `return ${value}`), lit = Array.from({ length: N }, (_, i) => show(at(i)))
    const make = pick([
      `const A = []\nfor (let i = 0; i < ${N}; i++) A.push(${value})`,
      `const A = []\nfor (let i = 0; i < ${N}; i++) A[i] = ${value}`,
      `const A = [${lit.join(', ')}]`,
      `const A = Array.from({ length: ${N} }, (_, i) => ${value})`,
      `const A = Array(${N}).fill(0).map((_, i) => ${value})`,
      `const A = [${lit.join(', ')}].map(x => x * 2)`,
      `const A = []\nfor (let i = 0; i < ${N}; i++) A[i * 2] = ${value}`,
      `const A = [${lit.map((v, i) => i % 4 === 1 ? '' : i % 4 === 3 ? pick(['undefined', 'null']) : v).join(', ')}]`,
    ])
    // what a call stores once earlier calls have read the elements as words
    const late = rnd() < 0.6 ? `if (k > 2) ${pick(['A[k & 3] = NaN', 'A[k & 3] = 2147483648', 'A[k & 3] = -2147483649', 'A[k & 3] = 1e15', 'A[k & 3] = -0',
      'A[k & 3] = 0.5', 'A[k & 3] = undefined', 'A[k & 3] = null', 'A.push(k)', 'A.pop()', `A.length = ${N + 2}`, 'A.length = 2'])}; ` : ''
    const use = pick(['x | 0', 'x >> 3', 'x >>> 0', 'x & 0xffff', '~x', 'V[(x & 0x7fffffff) % 8]', 'T[0] = x, T[0]', 'Math.imul(x, 40503)'])
    const loop = (X, past) => `let h = 0; for (let s = 0; s < ${X}.length${past}; s++) { const x = ${X}[s]; h = (Math.imul(h, 31) + (${use})) | 0 } return h`
    const f = pick([
      `export let f = (n, k) => { ${late}${loop('A', ' + 1')} }`,
      `const walk = (X) => { ${loop('X', ' + 1')} }\nexport let f = (n, k) => { ${late}return walk(A) }`,
      `const O = { a: A }\nexport let f = (n, k) => { ${late}${loop('O.a', ' + 1')} }`,
    ])
    // a record's field every write of which is an integer of the word, but where a call stores another
    const rec = rnd() < 0.4 ? `if (k > 2) R[k & 1].x = ${pick(['NaN', '2147483648', '0.5', '-0', 'undefined', 'null'])}; ` : ''
    const g = `export let g = (n, k) => { ${rec}let h = 0; for (let s = 0; s < R.length; s++) { const x = R[s].x; h = (Math.imul(h, 31) + (${use})) | 0 } return h }`
    const text = `const V = [${Array.from({ length: 8 }, (_, i) => String(i * 11 + 1)).join(', ')}], T = new Int32Array(1)\n${make}\n` +
      `const R = []\nfor (let i = 0; i < ${N}; i++) R.push({ x: ${value.includes('0.') ? 'i - 3' : value}, y: i })\n${f}\n${g}`
    const schedule = Array.from({ length: int(3, 6) }, () => [pick(['f', 'g']), [0, pick([0, 1, 3, 5])]])
    return { text, names: ['f', 'g'], schedule }
  }
  return Array.from({ length: count }, one)
}

const population = (seed, progs, levels = LEVELS) => {
  if (onKernel()) return
  const bad = []
  let checks = 0
  for (const p of progs) p.want = node(p)
  for (const optimize of levels) for (const [j, p] of progs.entries()) {
    const out = bounded({ src: p.text, optimize, runs: [p.schedule] }, LIMIT)
    checks++
    const got = out.hung ? null : out.results[0].map(r => r.startsWith('throws') ? 'throws' : r)
    const calls = p.schedule.map(([n, a]) => `${n}(${a.join(', ')})`).join(' ')
    if (!got) bad.push(`program ${j} at ${JSON.stringify(optimize)}: no answer in ${LIMIT / 1000} s\n${p.text}\n  ${calls}`)
    else if (got.join(' ') !== p.want.join(' ')) bad.push(`program ${j} at ${JSON.stringify(optimize)}: ${got.join(' ')} for Node's ${p.want.join(' ')}\n${p.text}\n  ${calls}`)
  }
  is(bad.length, 0, `seed ${seed}: ${progs.length} programs, ${checks} runs at ${levels.length} levels, ${bad.length} differing from Node's${bad.length ? '; the first:\n' + bad.slice(0, 3).join('\n') : ''}`)
}

for (const seed of [1, 2, 3])
  test(`element population: seed ${seed}, 60 modules reading arrays through what their stores make of the elements, against Node`, () => population(seed, generate(seed, 60)))
for (const seed of [4, 5])
  test(`element population: seed ${seed}, 30 modules reading words off memory by each level's form, against Node`, () => population(seed, generateWords(seed, 30), [false, 1, true, 'size', 'speed']))
