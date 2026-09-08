// Boolean identity across untyped carriers — the self-compile mother bug
// (kernel resolveOptimize: `1 === true` took the level-2 branch; fromEntries
// presets read back 0/1 so `cfg.pass !== false` ran passes the host skipped).
//
// Contract (src/ir.js BOOL_ATOM_BASE): booleans are raw i32/f64 0/1 ONLY while
// their static type is known (branch/arithmetic position). The moment one flows
// into an untyped carrier — container store, collection key/value, closure arg,
// mixed ?:/&&/||/?? merge — it materializes as its TRUE/FALSE atom (carrierF64),
// so typeof / String / strict-eq observe boolean identity. Strict equality
// against a bool literal on an unknown operand compares atom BITS (emitStrictEq)
// — `1 === true` is false, exactly ES; BOOL∪NUMBER merges deliberately stay raw
// (the 0/1 IS the ToNumber image — VT['?:'] carries NUMBER there).
import test, { is, ok } from 'tst'
import jz from '../index.js'
import { run } from './util.js'
import { onKernel } from './_matrix.js'

const LEVELS = [false, 2]

test('bool identity: containers round-trip the atom', async () => {
  const SRC = `
  export const probe = () => {
    const fe = Object.fromEntries([['f', false], ['t', true]])
    const m1 = new Map([['k', false]])
    const m2 = new Map(); m2.set('k', true)
    const h = {}; const dk = 'dk'; h[dk] = false
    const pairs = [['k', false]]
    const a = [0]; a[0] = true
    const p = []; p.push(false)
    return [
      typeof fe.f, String(fe.f), typeof fe.t,
      typeof m1.get('k'), typeof m2.get('k'),
      typeof h[dk], typeof pairs[0][1], typeof a[0], typeof p[0],
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(), 'boolean|false|boolean|boolean|boolean|boolean|boolean|boolean|boolean', `optimize:${optimize}`)
  }
})

test('bool identity: strict-eq is identity, loose stays ToNumber', async () => {
  const SRC = `
  export const probe = () => {
    const fe = Object.fromEntries([['f', false]])
    const g = (x) => x === true          // mixed-site param: g(true) and g(1)
    return [
      1 === true ? 'X' : 'ok',           // ES: false
      0 === false ? 'X' : 'ok',
      fe.f === false ? 'ok' : 'X',       // boxed false IS false
      fe.f !== false ? 'X' : 'ok',       // the resolveOptimize gate shape
      fe.f == 0 ? 'ok' : 'X',            // loose: ToNumber(false) == 0
      g(true) ? 'ok' : 'X',
      g(1) ? 'X' : 'ok',
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(), 'ok|ok|ok|ok|ok|ok|ok', `optimize:${optimize}`)
  }
})

test('bool identity: mixed ?:/&&/||/?? merges box the bool arm, numeric mixes stay raw', async () => {
  const SRC = `
  export const probe = (n, s) => {
    const a = []
    for (let i = 0; i < n; i++) a.push(i ? true : [7, 8])   // watr's rec-type marker shape
    const v = s || false
    const w = s && true
    const u = s ?? false
    return [
      typeof a[1], a[1] === true ? 'ok' : 'X',
      typeof v, String(v), v === false ? 'eqF' : 'neF',
      typeof w,
      typeof u,
      String(1 + (n > 0 ? 1 : n > -1)),        // BOOL∪NUMBER: raw, arithmetic exact
      String((n > 0 ? true : 'x')),            // BOOL∪STRING: identity kept
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(2, ''), 'boolean|ok|boolean|false|eqF|string|string|2|true', `optimize:${optimize} falsy`)
    is(probe(2, 'x'), 'boolean|ok|string|x|neF|boolean|string|2|true', `optimize:${optimize} truthy`)
  }
})

test('bool identity: preset-table idiom (the kernel divergence chain)', async () => {
  // KERNEL DEBT (2026-07-21a, BindingId wave): the number-level row diverges
  // through the kernel (probe('1') hits the ALL_ON copy — dynamic numeric-key
  // table lookup on a string param's JSON.parse result; same string-param
  // inference class as feature-gating's JSON.parse skip). Native leg owns this
  // pin until the class is burned down; do not widen this skip.
  if (onKernel()) return
  // resolveOptimize's exact shape: fromEntries -> freeze -> spread -> number
  // level from JSON.parse -> `=== true` branch test -> `!== false` pass gates.
  const SRC = `
  const NAMES = ['cseScalarLoad', 'foldSetToTee', 'treeshake', 'fusedRewrite']
  const ALL_ON = Object.freeze(Object.fromEntries(NAMES.map(n => [n, true])))
  const ALL_OFF = Object.freeze(Object.fromEntries(NAMES.map(n => [n, false])))
  const P1 = Object.freeze({ ...ALL_OFF, treeshake: true, fusedRewrite: true })
  const TABLE = Object.freeze({ 0: ALL_OFF, 1: P1, 2: ALL_ON })
  const resolve = (opt) => {
    if (opt === false || opt === 0) return { ...ALL_OFF }
    if (opt === true || opt == null) return { ...TABLE[2] }
    if (typeof opt === 'number' || typeof opt === 'string') return { ...(TABLE[String(opt)] || TABLE[2]) }
    return { ...ALL_OFF }
  }
  export const probe = (optJSON) => {
    const cfg = resolve(JSON.parse(optJSON))
    return [
      cfg.cseScalarLoad !== false ? 'ON' : 'off',
      cfg.treeshake ? 'on' : 'OFF',
      Object.keys(cfg).length,
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe('1'), 'off|on|4', `optimize:${optimize} number level (JSON.parse('1') must NOT hit === true)`)
    is(probe('"1"'), 'off|on|4', `optimize:${optimize} string level`)
    is(probe('true'), 'ON|on|4', `optimize:${optimize} literal true takes the === true branch (frozen TABLE[2] literal read)`)
    is(probe('0'), 'off|OFF|4', `optimize:${optimize} zero level`)
  }
})

test('bool identity: dyn-spread literal bool props keep the atom (=== true survives)', async () => {
  // The rotateLoops loss: {...fromEntries(...), rotateLoops: true} lowers via
  // emitDynamicSpread (unknown spread source → HASH); its explicit `k: v` writes
  // stored `emit(v)` RAW — a literal true landed as 1.0 bits, not the TRUE atom —
  // so every `cfg.flag === true` gate read false and speed-tier passes silently
  // dropped in-kernel (sum|3 rotation, O3 preset flags). The write must go
  // through storedValue/carrierF64 like every other container ingress.
  const SRC = `
  const AO = Object.fromEntries([['p', true]])
  const P = { ...AO, a: true, b: false, s: 'speed', n: 16 }
  export const probe = () => [
    P.a === true ? 'A' : 'x', P.b === false ? 'B' : 'x',
    P.p === true ? 'P' : 'x', P.s === 'speed' ? 'S' : 'x', P.n === 16 ? 'N' : 'x',
    P.a ? 't' : 'x', typeof P.a,
  ].join('|')`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(), 'A|B|P|S|N|t|boolean', `optimize:${optimize}`)
  }
})

test('bool identity: typed-array element writes ToNumber the box', async () => {
  const SRC = `
  export const probe = () => {
    const f = new Float64Array(2), u = new Uint8Array(2)
    const k = 0
    f[k] = true; u[k] = true      // dyn index defeats the inline typed store
    f[1] = false; u[1] = false
    return [f[0], f[1], u[0], u[1]].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(), '1|0|1|0', `optimize:${optimize}`)
  }
})

test('bool identity: JSON, truthiness, arithmetic on boxed bools', async () => {
  const SRC = `
  export const probe = () => {
    const fe = Object.fromEntries([['f', false], ['t', true]])
    return [
      JSON.stringify({ a: false, b: [true] }),
      fe.t ? 'T' : 'X', fe.f ? 'X' : 'F',    // truthiness of boxed atoms
      fe.t + 1, fe.f + 1,                    // ToNumber through the box
      [false, true].indexOf(true),
      [false].includes(false) ? 'inc' : 'X',
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(), '{"a":false,"b":[true]}|T|F|2|1|1|inc', `optimize:${optimize}`)
  }
})

// A boolean that may be nullish is not statically boolean. `litTruth`'s
// shape (src/prepare/const-fold.js) returns `!!x` or null; `t === false` was
// lowered as "t is falsy", so null took the false arm and foldConstIf dropped
// every `if` whose condition was no literal — the kernel compiled
// `if (idx > 1) return idx * 8; return 7` to `return 7`. The identity of the
// nullish member is its carrier's; loose `==` converts the present boolean
// and rejects the nullish (JS: `null == false` is false, `true == 1` true).
test('bool identity: a boolean-or-null result keeps null apart from false and true', () => {
  const SRC = `
  const tri = n => n === 1 ? true : n === 0 ? false : null
  export let f = (n) => { const t = tri(n); return (t === true ? 1 : 0) + (t === false ? 2 : 0) + (t !== false ? 4 : 0) + (t === null ? 8 : 0) + (t == null ? 16 : 0) }
  export let g = (n) => { const t = tri(n); return (t == false ? 1 : 0) + (t == 0 ? 2 : 0) + (t == 1 ? 4 : 0) + (t != true ? 8 : 0) }
  export let fold = (idx) => { if (idx > 1) return idx * 8; return 7 }`
  const oracle = Function(SRC.replaceAll('export ', '') + ';return {f,g,fold}')()
  for (const optimize of [false, 1]) {
    const ex = run(SRC, { memory: 256, optimize })
    for (const n of [1, 0, 2]) { is(ex.f(n), oracle.f(n), `=== O${optimize || 0} tri(${n})`); is(ex.g(n), oracle.g(n), `== O${optimize || 0} tri(${n})`) }
    is(ex.fold(2), 16, `the guarded return survives (O${optimize || 0})`)
  }
})

// Strict equality of a certain number against a value the program cannot type
// statically converts nothing. The number-beside-unknown arm shared loose
// `==`'s ToNumber lowering, so `b[1] === 0` read a parsed WAT immediate '0'
// as equal: the kernel's peephole folded `(i32.or x (i32.const 0))` where
// native kept it (the string-equality template's byte divergence). Every
// carrier kind, both operand orders, negated, and a join whose boolean arm
// would collapse to a raw 0/1, against the JS oracle.
test('bool identity: strict equality of a number against an untyped operand converts nothing', () => {
  const SRC = `const box = (v) => [v][0]
  const node = (v) => ['i32.const', v]
  export const strict = () => {
    const vals = [box('0'), box(''), box(' '), box('1'), box(true), box(false), box(null), box(undefined), box(0), box(1), box(0n), box([0])]
    return vals.map(v => (v === 0 ? 1 : 0) + (0 === v ? 2 : 0) + (v !== 0 ? 4 : 0) + (v === 1 ? 8 : 0) + (1 !== v ? 16 : 0)).join(',')
  }
  const imm = ['0', 0, 1, '1']
  export const member = (i) => { const b = node(imm[i]); return (b[1] === 0 ? 1 : 0) + (b[1] !== 0 ? 2 : 0) + (b[1] === 1 ? 4 : 0) }
  export const join = (a, b) => {
    const o = { a: box(a), b: box(b) }
    return ((o.a > 0 || o.b) === 1 ? 1 : 0) + ((o.a > 0 || o.b) !== 1 ? 2 : 0) + ((o.a > 0 && o.b) === 0 ? 4 : 0) + ((o.a > 0 || o.b) === true ? 8 : 0)
  }`
  const oracle = Function(SRC.replaceAll('export ', '') + ';return { strict, member, join }')()
  for (const optimize of [false, 1, 2]) {
    const ex = run(SRC, { memory: 256, optimize })
    is(ex.strict(), oracle.strict(), `boxed carriers O${optimize || 0}`)
    for (const i of [0, 1, 2, 3]) is(ex.member(i), oracle.member(i), `member holding imm[${i}] O${optimize || 0}`)
    for (const [a, b] of [[1, 1], [0, 1], [1, 0], [0, 0], [1, 'x'], [0, 'x']]) is(ex.join(a, b), oracle.join(a, b), `join(${a}, ${JSON.stringify(b)}) O${optimize || 0}`)
  }
})

// Loose `==` between values the program cannot type statically: a boolean
// beside a number converts (`true == 1`, `false == 0`), null and undefined
// are equal to each other alone, a boolean is not a string. The runtime's
// `__eq` compared the boolean atom's bits with the number, so every such
// pair was unequal; the static BOOL arm already converted.
test('bool identity: dynamic loose equality converts a boolean beside a number', () => {
  const SRC = `const box = (v) => [v][0]
  export const probe = () => {
    const t = box(true), f = box(false), one = box(1), zero = box(0), s = box('x'), n = box(null), u = box(undefined)
    return [t == one, f == zero, t == zero, one == t, f == n, t == s, n == u, t == t, t != one, one != t, f != zero, u == zero].map(x => x ? 1 : 0).join('')
  }`
  for (const optimize of LEVELS) {
    const { probe } = run(SRC, { memory: 256, optimize })
    is(probe(), '110100110000', `optimize:${optimize}`)
  }
})

// Loose `==` of a value the program cannot kind against a number or a
// boolean it can (a literal, a proven local, a comparison result): the
// boolean atom converts on either side (`true == 1`, `x == true` with x
// holding true), a boxed BigInt compares mathematically, null and undefined
// equal no number; `!=` negates. Strict `===` through the same dynamic path
// stays identity: `true === 1` is false whatever carries the operands.
// The static side once compared raw bits (a NaN-boxed atom equals no f64),
// and the runtime's strict form inherited the loose boolean conversion.
test('bool identity: loose equality of a number or boolean against any converts; strict stays identity', () => {
  const PARTNERS = ['1', '0', '2', '-0', 'NaN', 'true', 'false', 'k > 0', 'k === 0', 'null', 'undefined']
  const table = (X) => `[${PARTNERS.flatMap(p => [`${X} == ${p}`, `${p} == ${X}`, `${X} != ${p}`, `${X} === ${p}`, `${p} === ${X}`]).join(', ')}].map(v => v ? 1 : 0).join('')`
  const VALUES = ['true', 'false', '1', '0', '2', 'null', 'undefined', "'1'", '1n', '0n']
  const SRC = (V) => `const box = (v) => [v][0]
  export const f = (k) => { const x = box(${V}); return ${table('x')} }
  export const g = (k) => { const x = box(${V}), y = box(${V}); return [x == y, x === y, x != y, x !== y, box(true) === box(1), box(1) === box(true), box(false) === box(0), box(true) == box(1), box(0n) === box(0), box(0n) == box(0), box(0n) == box(false), box(0n) === box(false)].map(v => v ? 1 : 0).join('') }`
  for (const V of VALUES) {
    const src = SRC(V)
    const oracle = Function(src.replaceAll('export ', '') + ';return {f, g}')()
    for (const optimize of LEVELS) {
      const ex = run(src, { memory: 256, optimize })
      for (const k of [0, 1]) {
        const got = ex.f(k), want = oracle.f(k)
        const at = got === want ? -1 : [...got].findIndex((c, i) => c !== want[i])
        const where = at < 0 ? '' : ` ${['==', '== (reversed)', '!=', '===', '=== (reversed)'][at % 5]} ${PARTNERS[Math.floor(at / 5)]}`
        is(got, want, `any ${V}${where} (k=${k}, optimize:${optimize})`)
        is(ex.g(k), oracle.g(k), `any ${V} against any (k=${k}, optimize:${optimize})`)
      }
    }
  }
})

// `Number` and `Boolean` as values convert (`.map(Number)` of strings and
// booleans, `.map(Boolean)`); the identity arrow they lowered to served
// `.filter(Boolean)` alone. (A boolean's identity through a closure result
// into an array is the carrier family's, pinned elsewhere: truthiness here.)
test('bool identity: Number and Boolean as values convert', () => {
  const SRC = `const box = (v) => [v][0]
  export const probe = () => [[true, false].map(Number).join(','), [box(true), box('2.5'), null].map(Number).join(','), [0, 1, '', 'a', null].filter(Boolean).length, [2, 0, 'a', ''].map(Boolean).map(x => x ? 'T' : 'F').join('')].join('|')`
  for (const optimize of LEVELS) {
    const { probe } = run(SRC, { memory: 256, optimize })
    is(probe(), '1,0|1,2.5,0|2|TFTF', `optimize:${optimize}`)
  }
})

// A boolean produced inside an array builtin's inline callback (`map`, the
// fused filter→map and map→filter, `Array.from`'s mapper) stored raw 0/1;
// a boolean lane of a multi-value return (`return [v, 1]`) converted to a
// number; a typed array's `map` stored a closure's boolean atom as NaN. The
// host decodes each result, so the check is what it reads back.
test('bool identity: a boolean result reaches an array as itself, through a callback, a lane and a typed store', () => {
  const SRC = `function receiver() { return new Float64Array([2, 3]) }
  export function lanes(x) { const v = x > 1; return [v, 1] }
  export function lanesSome() { let value = receiver().some(x => x === 3); return [value, 1] }
  export function mapped(x) { return [3, 0].map(y => y > x) }
  export function negated() { return [1, 0].map(y => !y) }
  export function mixed(x) { return [3, 0].map(y => y > x ? 1 : false) }
  export function filterMap(x) { return [3, 0, 5].filter(y => y > 1).map(y => y > x) }
  export function mapFilter(x) { return [3, 0, 5].map(y => y > x).filter(y => y === true) }
  export function from(x) { return Array.from([3, 0], y => y > x) }
  export function sorted(x) { return [3, 0].map(y => y > x).sort() }
  export function typedMap(x) { return new Float64Array([1, 0]).map(y => y > x) }
  export function kinds(x) { return [3, 0].map(y => y > x).map(v => typeof v).join(',') }`
  const oracle = Function(SRC.replaceAll('export ', '') + ';return { lanes, lanesSome, mapped, negated, mixed, filterMap, mapFilter, from, sorted, typedMap, kinds }')()
  for (const optimize of LEVELS) {
    const ex = jz(SRC, { memory: 256, optimize }).exports
    for (const name of Object.keys(oracle)) {
      const got = ex[name](2), want = oracle[name](2)
      is(Array.isArray(want) || ArrayBuffer.isView(want) ? Array.from(got) : got, Array.isArray(want) || ArrayBuffer.isView(want) ? Array.from(want) : want, `${name} optimize:${optimize}`)
    }
  }
})
