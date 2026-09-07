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
