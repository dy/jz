// A raw Number's bits spell any pointer tag: 12.0 is 0x4028000000000000, whose
// tag field reads PTR.BIGINT. Every "is this carrier a BigInt box" test goes
// through isBigIntBox (src/ir/bigint.js), which asks for a NaN-box first. The
// kernel hit this in watr's sinkSets: a local touched twelve times in one
// statement threw "Cannot mix BigInt and other types". The runtime's
// __to_str formats a boxed BigInt's payload (it passed the box through
// unformatted: a template of a Map value the summary cannot narrow past
// Number|BigInt printed nothing).
import test from 'tst'
import { is, throws } from 'tst/assert.js'
import jz from '../index.js'
import { isBigIntBox } from '../src/ir.js'

const levels = [false, 1, 2]
// A Map that holds a BigInt somewhere gives its reads the tagged domain.
const SRC = `const m = new Map()
export let seed = () => { m.set('big', 5n); return 0 }
export let count = (k, n) => { let r = 0; for (let i = 0; i < n; i++) { m.set(k, (m.get(k) || 0) + 1); r = m.get(k) } return r }
export let plus = (k) => (m.get(k) || 0) + 1
export let unary = (k) => +m.get(k)
export let str = (k) => String(m.get(k))
export let tpl = (k) => \`v=\${m.get(k)}\` + '|' + ('' + m.get(k))
export let store = (k) => { const a = new BigInt64Array(1); const v = m.get(k); a[0] = v; return a[0] }`

test('bigint tag: a Number whose bits spell the BigInt tag stays a Number in a tagged Map', () => {
  for (const optimize of levels) {
    const ex = jz(SRC, { optimize }).exports
    ex.seed()
    for (const n of [1, 3, 5, 12, 13, 20]) is(ex.count('c' + n, n), n, `count ${n} (O${optimize || 0})`)
    is(ex.plus('c12'), 13, `12 + 1 (O${optimize || 0})`)
    is(ex.unary('c12'), 12, `+12 (O${optimize || 0})`)
    is(ex.str('c12'), '12', `String(12) (O${optimize || 0})`)
    // The runtime's ToString formats a boxed BigInt's payload (it passed the box through unformatted).
    is(ex.tpl('big'), 'v=5|5', `a template and a concat of a boxed BigInt (O${optimize || 0})`)
    is(ex.tpl('c12'), 'v=12|12', `of a Number beside it (O${optimize || 0})`)
    is(ex.store('big'), 5n, `a BigInt stores its payload (O${optimize || 0})`)
    throws(() => ex.store('c12'), TypeError, `a Number in a BigInt64Array is a TypeError (O${optimize || 0})`)
    throws(() => ex.plus('big'), TypeError, `5n + 1 mixes (O${optimize || 0})`)
  }
})

// The predicate itself: the NaN test precedes the tag test.
test('bigint tag: isBigIntBox asks for a NaN-box before reading the tag', () => {
  const ir = isBigIntBox(['local.get', '$v'], 'v')
  is(ir[0], 'i32.and')
  is(ir[1][0], 'f64.ne', 'a raw Number never reaches the tag test')
  is(JSON.stringify(ir[2]), JSON.stringify(['i32.eq', ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', '$v']]], ['i32.const', 5]]))
})

// watr's f64 encoder: `value` is a reassigned parameter whose kinds include
// a boolean, so the plan never materializes it and its reads are raw; the
// ternary that initializes it joins a raw literal with a boxed call result.
// The join takes the binding's raw carrier (the call arm unboxes), else the
// `|=` and the BigInt64Array store see a box pointer: the kernel encoded
// `f64.const nan:0x7ff8000200000000` as its own heap address.
test('bigint tag: a join written to a raw binding unboxes its call arm', () => {
  const SRC = `const _buf = new ArrayBuffer(8), _u8 = new Uint8Array(_buf), _i64 = new BigInt64Array(_buf)
  const F64_NAN = 0x7ff0000000000000n, F64_QUIET = 0x8000000000000n
  export function i64(n, out) { return [] }
  i64.parse = (n) => { let bi = BigInt(n); _i64[0] = bi; return _i64[0] }
  const hex = () => { let s = ''; for (let i = 7; i >= 0; i--) s += (_u8[i] < 16 ? '0' : '') + _u8[i].toString(16); return s }
  export function f64(input, out, value, idx) {
    if (typeof input === 'string' && (idx = input.indexOf('nan')) >= 0) {
      if (input[idx + 3] === ':') { const tail = input.slice(idx + 4); value = (tail === 'canonical' || tail === 'arithmetic') ? F64_QUIET : i64.parse(tail) }
      else value = F64_QUIET
      value |= F64_NAN
      if (input[0] === '-') value |= 0x8000000000000000n
      _i64[0] = value
    } else { value = typeof input === 'string' ? parseFloat(input) : input; new Float64Array(_buf)[0] = value }
    return hex()
  }`
  const oracle = Function(SRC.replaceAll('export ', '') + ';return {f64}')()
  for (const optimize of levels) {
    const { f64 } = jz(SRC, { optimize }).exports
    for (const input of ['nan:0x7FF8000200000000', '-nan:0x1234', 'nan:canonical', 'nan', 1.5, '2.5'])
      is(f64(input), oracle.f64(input), `${input} (O${optimize || 0})`)
  }
})

// A tagged local beside an operand with no evidence: `at` copies the
// `length` of an untyped parameter (a builder from a closure table), and the
// program holds a BigInt elsewhere, so the plan tags `at`. The subtraction
// took the i64 path unconditionally and read the Number's bits as a carrier
// (the self-compiled encoder's item length came out subnormal). The tagged
// side's flag decides both arms; the partner unboxes or coerces beside it.
test('bigint tag: a tagged carrier beside an unresolved operand dispatches on the tag', () => {
  const SRC = `const makeBuf = (cap) => {
    const b = { buf: new Uint8Array(cap), length: 0 }
    b.push = (...xs) => { for (let i = 0; i < xs.length; i++) b.buf[b.length++] = xs[i]; return b.length }
    return b
  }
  const table = new Map()
  table.set(0, (node, ctx) => [node, ctx])
  table.set(1, (node, ctx, out) => {
    const at = out.length
    out.push(node, node + 1)
    return [out.length - at, at + out.length, at * out.length, out.length / at, at + '' + out.length]
  })
  export let f = (i) => {
    const out = makeBuf(64)
    out.push(9, 9, 9)
    const big = BigInt(i) & 0x7Fn
    const a = table.get(0)(i, {})
    const r = table.get(1)(i, {}, out)
    return r.join('|') + '|' + Number(big) + a.length
  }`
  const oracle = Function(SRC.replaceAll('export let ', 'var ') + ';return {f}')()
  for (const optimize of levels) {
    const { f } = jz(SRC, { optimize }).exports
    for (const i of [0, 1, 2, 3]) is(f(i), oracle.f(i), `f(${i}) (O${optimize || 0})`)
  }
})

test('bigint tag: an array element is a tagged slot, whatever wrote it and whoever reads it', () => {
  // A literal, an index write, push/unshift, a compound update and a mapped
  // result all store one carrier; a bare read, an update's own value, an
  // inline callback parameter and a host-bound mixed result read it back.
  const HI = 4611686018427387903n
  const SRCS = [
    `export let f = (i) => { let a = [${HI}n]; a[0]++; return a[0] }`,
    `export let f = (i) => { let a = [${HI}n]; ++a[0]; return a[0] }`,
    `export let f = (i) => { let a = [${HI}n]; a[0]--; return a[0] }`,
    `export let f = (i) => { let a = [${HI}n]; return a[0]++ }`,
    `export let f = (i) => { let a = [${HI}n]; return a[0]++ + 0n }`,
    `export let f = (i) => { let a = [${HI}n]; a[0] += 1n; return a[0] }`,
    `export let f = (i) => { let a = [${HI}n]; a[0] = a[0] + 1n; return a[0] }`,
    `export let f = (i) => { let a = [${HI}n]; a.unshift(2n); return a[0] + a[1] }`,
    `export let f = (i) => { let a = []; a.push(${HI}n); a[0]++; return a[0] }`,
    `export let f = (i) => { let a = [1n]; a.push(${HI}n); return a[1] }`,
    `export let f = (i) => { let a = [${HI}n, 2n]; return a[i] }`,
    `export let f = (i) => { let a = [${HI}n, 2n]; a[i]++; return a[i] }`,
    `export let f = (i) => { let a = [${HI}n, 2n]; return a[i]++ }`,
    `export let f = (i) => { let a = [${HI}n, 2n]; return a.map(x => x + 1n)[i] }`,
    `export let f = (i) => { let a = [${HI}n, 2n]; let s = 0n; for (const x of a) s += x; return s }`,
    `export let f = (i) => { let a = [${HI}n, 2n]; let n = a[i]; n >>= 7n; return n }`,
  ]
  for (const src of SRCS) {
    const oracle = Function(src.replace('export let ', 'var ') + ';return f')()
    for (const optimize of levels) {
      const { f } = jz(src, { optimize }).exports
      for (const i of [0, 1]) is(f(i), oracle(i), `${src.slice(22, 70)} f(${i}) (O${optimize || 0})`)
    }
  }
})

test('bigint tag: a closure result crosses its ABI tagged; a caller chosen at runtime reads it as a box', () => {
  // `parse` is one of two closures; the result is read under a typeof
  // guard, through a mixed parameter, and past an unsigned shift on the
  // Number path (watr's memory64 limits).
  const HI = 4611686018427387903n
  const SRCS = [
    `export let f = (k) => { const p = k ? v => BigInt(v) : v => +v; const v = p('300'); return typeof v === 'bigint' ? Number(v) + 1000 : v }`,
    `export let f = (k) => { const p = k ? v => BigInt(v) : v => +v; const v = p('300'); return typeof v }`,
    `export let f = (k) => { const p = k ? v => +v : v => v * 2; const r = p('300'); return typeof r + r }`,
    `const uleb = (n) => { if (typeof n === 'bigint') { let s = 0; while (true) { const byte = Number(n & 0x7Fn); n >>= 7n; s = s * 1000 + byte; if (n === 0n) return s } } let byte = n & 0x7f; n >>>= 7; return byte * 1000 + n }
     export let f = (k) => { const p = k ? v => BigInt(v) : v => +v; return uleb(p('300')) }`,
    `export let f = (k) => { const p = v => k ? BigInt(v) + ${HI}n : v; const v = p(1); return typeof v === 'bigint' ? v - ${HI}n : v }`,
  ]
  for (const src of SRCS) {
    const oracle = Function(src.replace('export let ', 'var ') + ';return f')()
    for (const optimize of levels) {
      const { f } = jz(src, { optimize }).exports
      for (const k of [0, 1]) is(f(k), oracle(k), `${src.slice(src.indexOf('export') + 18, src.indexOf('export') + 70)} f(${k}) (O${optimize || 0})`)
    }
  }
})

test('bigint tag: a parameter of every kind materializes; the joins it feeds keep every arm\'s identity', () => {
  // The join `typeof v === 'bigint' ? v : BigInt(v)` has no kind of its
  // own, so the edge into its RAW binding was dropped and the reads took
  // the box's pointer bits (watr's slebSize answered 10 for 300n). A
  // boolean arm beside a boxed one carries its atom, whatever the join's
  // consumer; a join whose binding never materializes keeps the raw carrier.
  const SRCS = [
    `const size = (v) => { let x = typeof v === 'bigint' ? v : typeof v === 'string' ? BigInt(v) : BigInt(Math.trunc(Number(v) || 0)); let n = 1; while (true) { const b = x & 0x7fn; x >>= 7n; if ((x === 0n && (b & 0x40n) === 0n) || (x === -1n && (b & 0x40n) !== 0n)) return n; n++ } }
     const parse = (s) => { const w = s.split(' '); return [w[0], w[1].endsWith('n') ? BigInt(w[1].slice(0, -1)) : w[1].startsWith('#') ? Number(w[1].slice(1)) : w[1]] }
     export let f = (k) => size(parse(k ? 'i64.const 300n' : 'i32.const #1000')[1]) * 10 + size(k === 1 ? '-5' : k + 100)`,
    `export let f = (k) => { let x = k ? 3n : true; return typeof x + ':' + String(x) }`,
    `export let f = (k) => { let x = k ? 7n : k === 0; return x === true ? 1 : x === 7n ? 2 : 0 }`,
    `export let f = (k) => { const a = [3n, null, true]; const y = a[k] ?? (k === 1); return typeof y + ':' + String(y) }`,
    `export let f = (k) => { const ok = k > 0; let x = ok && 5n; return typeof x }`,
    `export let f = (k) => { const ok = k > 0; let x = ok || 5n; return typeof x === 'bigint' ? Number(x) : x ? 'T' : 'F' }`,
    `export let f = (k) => (k ? 3n : true)`,
    `export let f = (k) => { let x = k ? BigInt(3) : k === 0; x = k ? x + 1n : x; return k ? Number(x - 3n) : String(x) }`,
  ]
  for (const src of SRCS) {
    const oracle = Function(src.replace('export let ', 'var ') + ';return f')()
    for (const optimize of levels) {
      const { f } = jz(src, { optimize }).exports
      for (const k of [0, 1, 2]) is(f(k), oracle(k), `${src.slice(src.indexOf('export') + 18, src.indexOf('export') + 70)} f(${k}) (O${optimize || 0})`)
    }
  }
})


// `typeof x === 'bigint'` on an operand the plan could not resolve read a
// finite, nonzero, subnormal magnitude as a raw BigInt carrier: a genuine
// 5e-324 was both a bigint and a number, and the kernel, reading its own
// AST's literal that way, spelled `5e-324` by its bits (`f64.reinterpret_i64
// (i64.const 1)`) where native wrote `f64.const 5e-324`. A BigInt on such an
// operand is a box; the tag decides, as $__typeof does. Without bigint
// syntax the compare folds, its operand still evaluated once.
test('bigint tag: typeof reads a subnormal Number as a number; a boxed BigInt by its tag', () => {
  const SRC = `const box = (v) => [v][0]
  export let sub = () => { const n = box(5e-324); return (typeof n === 'bigint' ? 1 : 0) + (typeof n === 'number' ? 2 : 0) + (typeof n !== 'bigint' ? 4 : 0) }
  export let big = () => { const b = box(3n); return (typeof b === 'bigint' ? 1 : 0) + (typeof b === 'number' ? 2 : 0) }
  export let join = (c) => { const j = c ? 5e-324 : 'x'; return (typeof j === 'bigint' ? 1 : 0) + (typeof j === 'number' ? 2 : 0) }
  export let arr = (i) => { const a = [1n, 5e-324, 'x', null]; return (typeof a[i] === 'bigint' ? 1 : 0) + (typeof a[i] !== 'bigint' ? 2 : 0) }
  export let spell = () => box(5e-324) * 2 === 1e-323 ? 1 : 0`
  const NOBIG = `const box = (v) => [v][0]
  export let sub = () => { const n = box(5e-324); return (typeof n === 'bigint' ? 1 : 0) + (typeof n !== 'bigint' ? 2 : 0) }
  export let once = () => { let k = 0; const f = () => { k++; return 5e-324 }; return (typeof f() === 'bigint' ? 10 : 0) + (typeof f() !== 'bigint' ? 20 : 0) + k }`
  const oracle = Function(SRC.replaceAll('export let ', 'var ') + ';return { sub, big, join, arr, spell }')()
  const oracle2 = Function(NOBIG.replaceAll('export let ', 'var ') + ';return { sub, once }')()
  for (const optimize of levels) {
    const ex = jz(SRC, { optimize }).exports
    for (const [fn, args] of [['sub', []], ['big', []], ['join', [1]], ['join', [0]], ['arr', [0]], ['arr', [1]], ['arr', [2]], ['arr', [3]], ['spell', []]])
      is(ex[fn](...args), oracle[fn](...args), `${fn}(${args.join(', ')}) (O${optimize || 0})`)
    const ex2 = jz(NOBIG, { optimize }).exports
    for (const fn of ['sub', 'once']) is(ex2[fn](), oracle2[fn](), `no bigint syntax: ${fn}() (O${optimize || 0})`)
  }
})

// IsLooselyEqual (ES2024 7.2.14) with a BigInt on one side, through every
// carrier a BigInt takes: a Number compares mathematically (NaN and the
// infinities equal nothing, a payload past 2^53 is exact), a string through
// StringToBigInt (whitespace, a sign, a radix prefix; no parse is no
// equality), a boolean as 0 or 1, null and undefined equal nothing; `!=`
// negates and `===` stays identity. The partner is a literal, or a value
// the program cannot kind (the last shape): there `===` keeps the raw-
// carrier contract (identical bits are equal, so a Number 0 beside 0n) and
// only the loose rows are pinned. The host is the oracle.
const EQ_PARTNERS = ['300', '301', '300.5', '0', '-0', '1', '-5', 'NaN', 'Infinity', '-Infinity', '9007199254740992', '9007199254740993', '1e300',
  "'300'", "' 300 '", "'+300'", "'0x12c'", "'0b1'", "'300.0'", "'3e2'", "'abc'", "''", "' '", "'-5'", "'-0x5'", "'1n'", "'9007199254740993'",
  'true', 'false', 'null', 'undefined', '300n', '301n', '1n', '0n', '-5n', '9007199254740993n']
const EQ_VALUES = ['300n', '1n', '0n', '-5n', '9007199254740993n']
const EQ_OPS = [(X, P) => `${X} == ${P}`, (X, P) => `${P} == ${X}`, (X, P) => `${X} != ${P}`, (X, P) => `${X} === ${P}`]
const eqTable = (X, wrap = p => p, ops = EQ_OPS) =>
  `[${EQ_PARTNERS.flatMap(p => ops.map(op => op(X, wrap(p)))).join(', ')}].map(v => v ? 1 : 0).join('')`
const EQ_SHAPES = {
  literal: (V) => `export let f = (k) => ${eqTable(V)}`,
  local: (V) => `export let f = (k) => { const b = ${V}; return ${eqTable('b')} }`,
  param: (V) => `const h = (v, k) => ${eqTable('v')}; export let f = (k) => h(${V}, k)`,
  mixedParam: (V) => `const h = (v, k) => ${eqTable('v')}; export let f = (k) => h(k ? ${V} : 'z', k)`,
  element: (V) => `export let f = (k) => { const a = [${V}, 'x', 7]; return ${eqTable('a[k - 1]')} }`,
  bigintElement: (V) => `export let f = (k) => { const a = [${V}, 1n]; return ${eqTable('a[k - 1]')} }`,
  mapValue: (V) => `const m = new Map(); export let f = (k) => { m.set('k', ${V}); return ${eqTable("m.get('k')")} }`,
  closureResult: (V) => `const mk = (k) => () => k ? ${V} : 'z'; export let f = (k) => { const g = mk(k); return ${eqTable('g()')} }`,
  hostValue: (V) => `export let f = (x, k) => { const y = typeof x === 'bigint' ? x : 0n; return ${eqTable('x')} }`,
  anyPartner: (V) => `const box = (v) => [v][0]; export let f = (k) => { const b = ${V}; return ${eqTable('b', p => `box(${p})`, EQ_OPS.slice(0, 3))} }`,
}
// ToString (ES2024 7.1.17) of a BigInt through every carrier: its decimal
// digits, whatever box it rides in. String(), a template, concatenation on
// either side, a join, .toString() and a radix. The runtime's __to_str
// formats the box; nothing unboxes ahead of it.
const strTable = (X) => `[String(${X}), \`\${${X}}\`, ${X} + '', '' + ${X}, [${X}].join('/'), ${X}.toString(), ${X}.toString(16)].join('|')`
const STR_SHAPES = {
  literal: (V) => `export let f = (k) => ${strTable(V)}`,
  local: (V) => `export let f = (k) => { const b = ${V}; return ${strTable('b')} }`,
  param: (V) => `const h = (v, k) => ${strTable('v')}; export let f = (k) => h(${V}, k)`,
  mixedParam: (V) => `const h = (v, k) => ${strTable('v')}; export let f = (k) => h(k ? ${V} : 'z', k)`,
  tagged: (V) => `export let f = (k) => { const v = k ? ${V} : k; return ${strTable('v')} }`,
  element: (V) => `export let f = (k) => { const a = [${V}, 'x', 7]; return ${strTable('a[k - 1]')} }`,
  bigintElement: (V) => `export let f = (k) => { const a = [${V}, 1n]; return ${strTable('a[k - 1]')} }`,
  mapValue: (V) => `const m = new Map(); export let f = (k) => { m.set('k', ${V}); return ${strTable("m.get('k')")} }`,
  closureResult: (V) => `const mk = (k) => () => k ? ${V} : 'z'; export let f = (k) => { const g = mk(k); return ${strTable('g()')} }`,
  hostValue: (V) => `export let f = (x, k) => { const y = typeof x === 'bigint' ? x : 0n; return ${strTable('x')} }`,
}
test('bigint tag: ToString across every carrier formats the digits', () => {
  for (const [shape, src] of Object.entries(STR_SHAPES)) for (const V of ['300n', '-5n', '0n', '9007199254740993n']) {
    const source = src(V)
    const oracle = Function(source.replace('export let ', 'var ') + ';return f')()
    const args = shape === 'hostValue' ? [Function(`return ${V}`)(), 1] : [1]
    for (const optimize of levels) is(jz(source, { optimize }).exports.f(...args), oracle(...args), `${shape} ${V} (O${optimize || 0})`)
  }
})

test('bigint tag: loose equality across domains, through every carrier', () => {
  for (const [shape, src] of Object.entries(EQ_SHAPES)) for (const V of EQ_VALUES) {
    const source = src(V)
    const oracle = Function(source.replace('export let ', 'var ') + ';return f')()
    const args = shape === 'hostValue' ? [Function(`return ${V}`)(), 1] : [1]
    const want = oracle(...args)
    for (const optimize of levels) {
      const { f } = jz(source, { optimize }).exports
      const got = f(...args)
      const at = got === want ? -1 : [...got].findIndex((c, i) => c !== want[i])
      const ops = shape === 'anyPartner' ? 3 : 4
      const where = at < 0 ? '' : ` ${['==', '== (reversed)', '!=', '==='][at % ops]} ${EQ_PARTNERS[Math.floor(at / ops)]}`
      is(got, want, `${shape} ${V}${where} (O${optimize || 0})`)
    }
  }
})
