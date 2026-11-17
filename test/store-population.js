// A population of indexed stores into arrays, each module answering what Node answers. A store's
// index: a counter its loop bounds by a parameter or by the array's length, a running cursor (`R[c++]`,
// `R[c] = v; c++`), an affine `i * C + D`, a parameter's number (an index, negative, fractional, NaN,
// 2^31 and past it, 2^32 - 1 and up), a literal of each kind, a string that is an index and one that
// is not. Its receiver: a module binding, an object's field, an element of an array of objects, a
// local, a parameter of a helper, and a helper's parameter one call site passes the array and another
// a Float64Array. Its array: of numbers, of strings, of both, with holes. Interleaved with push, pop,
// `length =` and element reads; each export returns a hash of the array's elements past its length,
// its named properties at those keys and its length. A schedule of calls, some with a
// `memory.reset()` between them, which Node answers with a fresh module, as the reset returns the
// module to its start (README, Memory: an array the module made as it started reads as it started).
// Node's store follows the README's array contract: an array index past 2^29 - 1024 throws the
// allocation's RangeError (`32-bit element indices`), where Node's array goes sparse. Every program
// is a module of its own, run in a worker the test stops at a limit (test/_bounded.js), at the four
// public levels.
//
// The stores compile/emit-assign.js lowers by the key's proof (storeArrayPayload `key`): an element
// index in place inside the length and one call past it, any other Number one call that stores the
// property it names (module/collection.js `__arr_set_num`), where every unproven key took the hash
// store's dispatch before; the counters and cursors a store steps (static.js storeCounterTop,
// compile/analyze-scans.js stampStoreCursors) are element indices. On the tree before these
// (e521f93b8) the three seeds differ in 120, 112 and 108 of their 240 runs: an index in [2^31,
// 2^32 - 2] stored a property where the array throws, and a key of mixed kinds read an array's
// property as undefined through a receiver an array and a typed array share (module/array.js). With
// the property arm's direct store in and module/core/reach.js as it was, seed 1's program 32 answered
// wrong at speed and a program reduced from it trapped out of bounds at the default level: the walk
// did not keep the table only __dyn_set_own had written.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { bounded } from './_bounded.js'
import { onKernel } from './_matrix.js'

// The four public levels: this file owns its sweep.
const LEVELS = [false, true, 'size', 'speed']
// One program's compile and its instance, in the worker, at most this long (a hang fails here).
const LIMIT = 60000
const show = v => Object.is(v, -0) ? '-0' : String(v)
// The README's array store for Node (module/core.js DENSE_MAX): an index an array cannot reach throws.
const PRELUDE = `const __st = (a, k, v) => {
  if (Array.isArray(a) && typeof k === 'number' && Number.isInteger(k) && k >= ${0x1ffffc00} && k <= 4294967294) throw new RangeError('Invalid array length')
  return a[k] = v
}`
const VAL = `const val = (v) => v === undefined ? -1 : typeof v === 'string' ? v.length * 1000 + v.charCodeAt(0) : v`
const SIG = `const KEYS = [-1, 1.5, NaN, 4294967295, 2 ** 32, 3e9, '2', 'x']
const sig = (X, h) => {
  for (let i = 0; i < X.length + 2; i++) h = (h * 31 + val(X[i])) % 1000003
  for (const key of KEYS) h = (h * 31 + val(X[key])) % 1000003
  return h * 100 + X.length
}`

// ---- the generated programs (xorshift32, so a seed gives the same programs on every run)
const generate = (seed, count) => {
  let state = seed >>> 0 || 1
  const rnd = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296 }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
  // A statement: text and stores, rendered for jz (`R[K] = V`) or for Node (`__st(R, K, V)`, the
  // same order: the receiver, the key, the value).
  const st = (R, K, V) => ({ R, K, V })
  const render = (parts, node) => parts.map(p => typeof p === 'string' ? p : node ? `__st(${p.R}, ${p.K}, ${p.V})` : `${p.R}[${p.K}] = ${p.V}`).join('')
  const one = () => {
    const kind = pick(['num', 'str', 'mix', 'holes']), size = pick([0, 1, 3, 5])
    const elems = Array.from({ length: size }, (_, i) => kind === 'holes' ? (i % 2 ? '' : String(11 + i))
      : kind === 'num' || (kind === 'mix' && i % 2) ? String(11 + i) : `'${String.fromCharCode(112 + i)}'`)
    const lit = `[${elems.join(', ')}]`
    const holder = pick(['bind', 'bind', 'field', 'elem'])
    const decl = holder === 'bind' ? `const A = ${lit}` : holder === 'field' ? `const O = { t: 1, a: ${lit} }` : `const W = [{ v: [0] }, { v: ${lit} }]`
    const P = holder === 'bind' ? 'A' : holder === 'field' ? 'O.a' : 'W[1].v'
    // a value in a loop (its counter `i` in scope) and out of one
    const LV = () => kind === 'num' || kind === 'holes' ? pick(['i', 'i + 0.5', 'n', '7']) : kind === 'str' ? pick([`'s'`, `'tu'`]) : pick(['i', `'s'`, '7'])
    const PV = () => kind === 'num' || kind === 'holes' ? pick(['k', 'n', '7', '2.5']) : kind === 'str' ? pick([`'s'`, `'tu'`]) : pick(['k', `'s'`, '7'])
    const KEY = () => pick(['-1', '1.5', 'NaN', '2 ** 31', '3e9', '4294967294', '4294967295', '2 ** 32', `'2'`, `'x'`, '0', '-0', '4'])
    const stores = (R) => [
      [`for (let i = 0; i < n; i++) `, st(R, 'i', LV())],
      [`for (let i = 0; i < ${R}.length; i++) `, st(R, 'i', LV())],
      [`{ let c = 0; for (let i = 0; i < n; i++) `, st(R, 'c++', LV()), ` }`],
      [`{ let c = ${int(0, 2)}; for (let i = 0; i < n; i++) { `, st(R, 'c', LV()), `; c++ } }`],
      [`for (let i = 0; i < n; i++) `, st(R, `i * ${int(2, 3)} + ${int(0, 1)}`, LV())],
      [st(R, 'k', PV())],
      [st(R, '+k', PV())],
      [st(R, 'k * 2 - 1', PV())],
      [st(R, KEY(), PV())],
      [st(R, 'n + k', PV())],
    ]
    const muts = (R) => [`${R}.push(${PV()})`, `${R}.pop()`, `${R}.length = ${int(0, 4)}`, `t = (t * 7 + val(${R}[k])) % 1000003`]
    // the helpers: a parameter one call site passes, and one two call sites pass an array and a Float64Array
    const helper = rnd() < 0.5 ? [`const put = (out, n, k) => { `, ...pick(stores('out')), `; `, ...pick(stores('out')), ` }`] : null
    const poly = rnd() < 0.3 ? [`const T = new Float64Array(4)\nconst put2 = (out, n, k) => { `, ...pick(stores('out')), ` }`] : null
    const statement = () => {
      const r = rnd()
      if (helper && r < 0.2) return [`put(${P}, n, k)`]
      if (poly && r < 0.35) return [pick([`put2(${P}, n, k)`, `put2(T, n, k)`])]
      return rnd() < 0.7 ? pick(stores(P)) : [pick(muts(P))]
    }
    const body = (m) => { const out = []; for (let i = 0; i < m; i++) out.push(...statement(), '; '); return out }
    const exportOf = (name, m) => [`export let ${name} = (n, k) => { let t = 0; `, ...body(m), `return sig(${P}, t)${poly ? ' + sig(T, 0)' : ''} }`]
    // a local array the call makes and stores into
    const local = rnd() < 0.4 ? [`export let l = (n, k) => { const L = ${lit}; let t = 0; `, ...pick(stores('L')), `; `, ...pick([...stores('L'), [pick(muts('L'))]]), `; return sig(L, t) }`] : null
    const parts = [`${VAL}\n${SIG}\n${decl}\n`, ...(helper ?? []), helper ? '\n' : '', ...(poly ?? []), poly ? '\n' : '',
      ...exportOf('f', int(1, 3)), '\n', ...exportOf('g', int(1, 3)), '\n', ...(local ?? [])]
    const names = ['f', 'g', ...(local ? ['l'] : [])]
    const N = [0, 1, 3, 4, 2.5, -2, NaN], K = [0, 2, 5, -1, 1.5, NaN, 3e9, 4294967295, 2 ** 32, 2 ** 31]
    const schedule = Array.from({ length: int(4, 7) }, () => rnd() < 0.15 ? ['@reset', []] : [pick(names), [pick(N), pick(K)]])
    return { text: render(parts, false), node: render(parts, true), names, schedule }
  }
  return Array.from({ length: count }, one)
}

// Node's answers: the module as a function body, a reset a fresh one.
const node = (p) => {
  const make = () => new Function(`${PRELUDE}\n${p.node.replace(/export let /g, 'let ')}\nreturn { ${p.names.join(', ')} }`)()
  let m = make()
  return p.schedule.map(([name, args]) => {
    if (name === '@reset') { m = make(); return 'reset' }
    try { return show(m[name](...args)) } catch { return 'throws' }
  })
}

const population = (seed, progs) => {
  if (onKernel()) return
  const bad = []
  let checks = 0
  for (const p of progs) p.want = node(p)
  for (const optimize of LEVELS) for (const [j, p] of progs.entries()) {
    const out = bounded({ src: p.text, optimize, runs: [p.schedule] }, LIMIT)
    checks++
    const got = out.hung ? null : out.results[0].map(r => r.startsWith('throws') ? 'throws' : r)
    const calls = p.schedule.map(([n, a]) => `${n}(${a.join(', ')})`).join(' ')
    if (!got) bad.push(`program ${j} at ${JSON.stringify(optimize)}: no answer in ${LIMIT / 1000} s\n${p.text}\n  ${calls}`)
    else if (got.join(' ') !== p.want.join(' ')) bad.push(`program ${j} at ${JSON.stringify(optimize)}: ${got.join(' ')} for Node's ${p.want.join(' ')}\n${p.text}\n  ${calls}`)
  }
  is(bad.length, 0, `seed ${seed}: ${progs.length} programs, ${checks} runs at ${LEVELS.length} levels, ${bad.length} differing from Node's${bad.length ? '; the first:\n' + bad.slice(0, 3).join('\n') : ''}`)
}

for (const seed of [1, 2, 3])
  test(`store population: seed ${seed}, 60 modules storing into arrays under every kind of index, against Node`, () => population(seed, generate(seed, 60)))

// ---- cursors the plan copies (plan/counted-loops.js's closed form, plan/integral-loops.js's copy),
// each copy landing the cursor where its loop as written leaves it (plan/common.js landing), which
// the store-cursor proof reads as that loop's writes where that loop stands in the body: a cursor in
// one loop, in two, in a loop inside a loop, stepped after its store, by a word step written
// `(c + 1) | 0`, or in the store's key, from a literal or a parameter's number; one a copied loop
// moves first by a fraction, down or by a stride, one stepped past a store a `try` holds, one the
// array's own methods meet between two loops. Their own stream of programs, so the population above
// is the one its counts were taken on. At the four levels and under coldTrap at 2 and 3 (the loop as
// written a throw in its place, its landings standing alone): there a run that throws is the copy's
// guard failing, and every run that answers answers as Node, at least one in five.
const TRAPS = [{ level: 2, coldTrap: true }, { level: 3, coldTrap: true }]
const generateLandings = (seed, count) => {
  let state = (seed * 2654435761) >>> 0 || 1
  const rnd = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296 }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
  const st = (R, K, V) => ({ R, K, V })
  const render = (parts, node) => parts.map(p => typeof p === 'string' ? p : node ? `__st(${p.R}, ${p.K}, ${p.V})` : `${p.R}[${p.K}] = ${p.V}`).join('')
  const one = () => {
    const local = rnd() < 0.5, R = local ? 'L' : 'A'
    const lit = pick(['[]', '[11, 12, 13]', '[11, , 13]', `['p', 12]`])
    const V = () => pick(['i', 'i + 0.5', 'n', '-i', `'s'`])
    // a loop stepping the cursor by its stores, its counter `i`
    const loop = () => pick([
      [`for (let i = 0; i < n; i++) { `, st(R, 'c', V()), `; c++ } `],
      [`for (let i = 0; i < n; i++) { `, st(R, 'c', V()), `; c = (c + 1) | 0 } `],
      [`for (let i = 0; i < n; i++) `, st(R, 'c++', V()), `; `],
    ])
    const shape = () => pick([
      () => loop(),
      () => [...loop(), ...loop()],
      () => [`for (let j = 0; j < ${int(1, 3)}; j++) `, ...loop()],
      // (a stride of 2^33, past every index, whose word steps take the cursor back below 2^31: a stride
      // landing it between 2^20 and the README's 2^29 - 1024 would ask a dense array of that many elements)
      () => [`for (let i = 0; i < n; i++) c ${pick(['+= 0.5', '-= 1', '+= 2 ** 33'])}; `, ...loop()],
      () => [`for (let i = 0; i < n; i++) { try { `, st(R, 'c', V()), ` } catch (e) {} c++ } `],
      () => [...loop(), `${R}.${pick(['push(7)', 'pop()', 'length = 2'])}; `, ...loop()],
    ])()
    const exportOf = (name) => [`export let ${name} = (n, k) => { `, local ? `const L = ${lit}; ` : '', `let c = ${pick(['0', '0', '2', 'k'])}; `, ...shape(), `return c * 7 + sig(${R}, 0) }`]
    const parts = [`${VAL}\n${SIG}\n`, local ? '' : `const A = ${lit}\n`, ...exportOf('f'), '\n', ...exportOf('g')]
    const N = [0, 1, 3, 4, 9, 2.5, -2, NaN], K = [0, 2, -1, 1.5, NaN, 3e9, 4294967295, 2 ** 32]
    const schedule = Array.from({ length: int(4, 6) }, () => rnd() < 0.15 ? ['@reset', []] : [pick(['f', 'g']), [pick(N), pick(K)]])
    return { text: render(parts, false), node: render(parts, true), names: ['f', 'g'], schedule }
  }
  return Array.from({ length: count }, one)
}

const landingPopulation = (seed, progs) => {
  if (onKernel()) return
  const bad = []
  let checks = 0, trapped = 0, trapAnswers = 0
  for (const p of progs) p.want = node(p)
  for (const optimize of [...LEVELS, ...TRAPS]) for (const [j, p] of progs.entries()) {
    const out = bounded({ src: p.text, optimize, runs: [p.schedule] }, LIMIT)
    checks++
    const got = out.hung ? null : out.results[0].map(r => r.startsWith('throws') ? 'throws' : r)
    const calls = p.schedule.map(([n, a]) => `${n}(${a.join(', ')})`).join(' ')
    if (!got) { bad.push(`program ${j} at ${JSON.stringify(optimize)}: no answer in ${LIMIT / 1000} s\n${p.text}\n  ${calls}`); continue }
    // (under coldTrap a throw is the copy's guard failing: past it the module runs no further copy)
    const upTo = optimize.coldTrap ? (got.indexOf('throws') < 0 ? got.length : got.indexOf('throws')) : got.length
    if (optimize.coldTrap) { trapped += p.schedule.length; trapAnswers += got.slice(0, upTo).filter(r => r !== 'reset').length }
    if (got.slice(0, upTo).join(' ') !== p.want.slice(0, upTo).join(' ')) bad.push(`program ${j} at ${JSON.stringify(optimize)}: ${got.join(' ')} for Node's ${p.want.join(' ')}\n${p.text}\n  ${calls}`)
  }
  is(bad.length, 0, `seed ${seed}: ${progs.length} programs, ${checks} runs at ${LEVELS.length + TRAPS.length} levels, ${bad.length} differing from Node's${bad.length ? '; the first:\n' + bad.slice(0, 3).join('\n') : ''}`)
  ok(trapAnswers * 5 >= trapped, `seed ${seed}: under coldTrap ${trapAnswers} of ${trapped} calls answered before a guard failed`)
}

for (const seed of [1, 2, 3])
  test(`store population: seed ${seed}, 40 modules whose cursors the plan copies and lands, against Node, coldTrap's among them`, () => landingPopulation(seed, generateLandings(seed, 40)))
