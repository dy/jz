// A raw Number's bits spell any pointer tag: 12.0 is 0x4028000000000000, whose
// tag field reads PTR.BIGINT. Every "is this carrier a BigInt box" test goes
// through isBigIntBox (src/ir/bigint.js), which asks for a NaN-box first. The
// kernel hit this in watr's sinkSets: a local touched twelve times in one
// statement threw "Cannot mix BigInt and other types". Open beside it:
// String() of a Map value the summary cannot narrow past Number|BigInt
// reaches __to_str, which passes a BigInt box through unformatted.
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
export let store = (k) => { const a = new BigInt64Array(1); const v = m.get(k); a[0] = v; return a[0] }`

test('bigint tag: a Number whose bits spell the BigInt tag stays a Number in a tagged Map', () => {
  for (const optimize of levels) {
    const ex = jz(SRC, { optimize }).exports
    ex.seed()
    for (const n of [1, 3, 5, 12, 13, 20]) is(ex.count('c' + n, n), n, `count ${n} (O${optimize || 0})`)
    is(ex.plus('c12'), 13, `12 + 1 (O${optimize || 0})`)
    is(ex.unary('c12'), 12, `+12 (O${optimize || 0})`)
    is(ex.str('c12'), '12', `String(12) (O${optimize || 0})`)
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
