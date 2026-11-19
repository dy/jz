// Where an access points (src/optimize/address.js): one sum for an address whatever the
// order of its adds, the tee or the copy that carries it, and what two accesses may touch:
// on one sum their bytes, apart from that the emitter's marks, the header words a wide
// store never writes and the roots a reader proved apart. The passes that remember memory
// ask the one answer: a store forgets what it may overwrite and no more.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { addressOf, linear, keyOf, mayAlias, markCount, carry, headerStore } from '../src/optimize/address.js'
import { forwardStores } from '../src/optimize/forward-store.js'
import { numberValues, LOAD_AT, SUBSCRIPT } from '../src/optimize/numbering.js'
const reuseLoads = (fn, fx) => numberValues(fn, LOAD_AT, fx)
const hoistAddrBase = (fn) => numberValues(fn, SUBSCRIPT)
import { rewriteBy, LOADS } from '../src/optimize/rules.js'

const g = (n) => ['local.get', n], k = (v) => ['i32.const', v]
const shl = (x, s) => ['i32.shl', x, k(s)]

test('address: one sum whatever the order of the adds, the tee and the copy', () => {
  const a = addressOf(['f64.load', ['i32.add', ['i32.add', g('$p'), shl(g('$i'), 3)], k(8)]])
  const b = addressOf(['f64.load', 'offset=8', ['i32.add', shl(g('$i'), 3), g('$p')]])
  const c = addressOf(['f64.load', ['local.tee', '$t', ['i32.add', k(8), ['i32.add', ['i32.mul', g('$i'), k(8)], g('$p')]]]])
  is([a.key, a.at], [b.key, b.at], 'the add in either order, its constant in the memarg')
  is([a.key, a.at], [c.key, c.at], 'a tee and a multiply by eight')
  const copy = (n) => n[0] === 'local.get' && n[1] === '$q' ? { e: g('$p'), look: null } : undefined
  is(addressOf(['f64.load', g('$q')], copy).key, addressOf(['f64.load', g('$p')]).key, 'a copy reads as what it copies')
  is(keyOf(linear(['i32.sub', ['i32.add', g('$x'), k(12)], k(4)])), keyOf(linear(['i32.add', k(8), g('$x')])), 'a subtraction of a constant')
  ok(linear(['i32.add', g('$p'), ['i32.load', g('$q')]]) === null, 'a load is no part of a sum')
})

test('address: what two accesses may touch', () => {
  const at = (off, op = 'f64.load', base = g('$p')) => addressOf([op, `offset=${off}`, base])
  ok(!mayAlias(at(0), at(8)), 'two slots of one sum eight bytes apart')
  ok(mayAlias(at(0), at(4)), 'two slots four bytes apart share four bytes')
  ok(!mayAlias(at(0), at(8, 'i32.load')) && mayAlias(at(4, 'i32.load'), at(0)), 'a word beside a slot, a word inside it')
  ok(mayAlias(at(0), at(0, 'f64.load', g('$q'))), 'two names may be one array')
  const e1 = at(0), e2 = at(0, 'f64.store', g('$q'))
  e1.mem = 'e1'; e2.mem = 'e2'
  ok(!mayAlias(e1, e2), 'arrays of two cells')
  const box = ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', g('$x')], ['i64.const', 4294967295]]]
  const len = addressOf(['i32.load', ['i32.sub', box, k(8)]]), put = addressOf(['f64.store', ['i32.add', box, shl(g('$i'), 3)], ['f64.const', 1]])
  ok(len.header && !mayAlias(len, put), 'a length word and a payload store of a wide type')
  ok(mayAlias(len, addressOf(['i32.store', ['i32.add', box, shl(g('$i'), 2)], k(1)])), 'a word store may write it')
  const roots = new Set(['r:$a', 'r:$b']), root = (n) => n[0] === 'local.get' && n[1] !== '$i' ? 'r:' + n[1] : undefined
  ok(mayAlias(addressOf(['f64.load', g('$a')], root), addressOf(['f64.store', ['i32.add', g('$b'), g('$i')], ['f64.const', 0]], root), roots), 'a root plus a word of no scale may point anywhere')
  ok(!mayAlias(addressOf(['f64.load', g('$a')], root), addressOf(['f64.store', ['i32.add', g('$b'), shl(g('$i'), 3)], ['f64.const', 0]], root), roots), 'two buffers the plan proved apart')
  ok(headerStore(['i64.store', ['i32.sub', g('$p'), k(12)], ['i64.const', 0]]) && !headerStore(['f64.store', ['i32.add', g('$ks'), ['i32.sub', g('$top'), k(8)]], g('$v')]),
    'a store stepping back from a pointer, not a stack\'s top less a slot')
})

// D6 and D8: a store on the sum a slot is remembered at forgets it where their bytes meet,
// of any width; elsewhere it leaves it.
test('address: forwardStores forgets a slot a store of any width overlaps, and no other', () => {
  const fn = (...body) => ['func', '$f', ['param', '$p', 'i32'], ['local', '$r', 'f64'], ...body]
  const run = (...mid) => {
    const f = fn(['f64.store', g('$p'), ['f64.const', 1.5]], ...mid, ['local.set', '$r', ['f64.load', g('$p')]])
    forwardStores(f)
    return f[f.length - 1][2]
  }
  is(run(['f64.store', 'offset=8', g('$p'), ['f64.const', 2]]), ['f64.const', 1.5], 'a slot eight bytes on')
  is(run(['i32.store', 'offset=8', g('$p'), k(7)]), ['f64.const', 1.5], 'a word past the slot')
  is(run(['f64.store', 'offset=4', g('$p'), ['f64.const', 2]])[0], 'f64.load', 'a slot four bytes on shares four')
  is(run(['i32.store', 'offset=4', g('$p'), k(7)])[0], 'f64.load', 'a word inside the slot')
  is(run(['i32.store8', 'offset=7', g('$p'), k(7)])[0], 'f64.load', 'its last byte')
  is(run(['f64.store', g('$q'), ['f64.const', 2]])[0], 'f64.load', 'a store through another name')
})

// A store forgot what it may overwrite by a walk of every slot the list held: the
// stores of one straight list took their square (an array of 10,000 literals: 3.6
// s of a compile). It finds them by the sum and the offset, and by the kind of
// access elsewhere: t(4n) / t(n) at most 8, where linear is 4 and quadratic 16.
test('address: forwardStores takes a time in a run of stores', () => {
  const fn = (n) => ['func', '$f', ['param', '$p', 'i32'], ['param', '$q', 'i32'], ['local', '$r', 'f64'],
    ...Array.from({ length: n }, (_, i) => ['f64.store', `offset=${8 * i}`, g('$p'), ['f64.const', i]]),
    ['local.set', '$r', ['f64.load', 'offset=8', g('$p')]]]
  const clock = process.threadCpuUsage ?? process.cpuUsage
  const time = (n) => { const f = fn(n), c0 = clock(); forwardStores(f); const c = clock(c0); return [(c.user + c.system) / 1000, f] }
  time(1000)
  let ratio = Infinity
  for (let i = 0; i < 3 && !(ratio <= 8); i++) ratio = Math.min(ratio, time(8000)[0] / time(2000)[0])
  ok(ratio <= 8, `t(8,000) / t(2,000) = ${ratio.toFixed(1)}`)
  const [, f] = time(50)
  is(f[f.length - 1][2], ['f64.const', 1], 'the slot reads what its store left, past the stores of the other slots')
})

// D5: a load through a copy of a local reads what a load through the local read.
test('address: reuseLoads reads a load through a copy, and past a store of other bytes', () => {
  const fn = (...body) => ['func', '$f', ['param', '$a', 'i32'], ['local', '$a2', 'i32'], ['result', 'f64'], ...body]
  const f = fn(['local.set', '$a2', g('$a')], ['f64.add', ['f64.load', g('$a')], ['f64.load', g('$a2')]])
  ok(reuseLoads(f), 'the second load reads the first')
  is(f[f.length - 1][2], ['local.get', '$__rl0'], 'through the copy')
  const h = fn(['f64.add', ['f64.load', g('$a')], ['block', ['result', 'f64'], ['i32.store', 'offset=8', g('$a'), k(0)], ['f64.load', g('$a')]]])
  ok(reuseLoads(h), 'a word stored past the slot leaves it')
  const w = fn(['f64.add', ['f64.load', g('$a')], ['block', ['result', 'f64'], ['i32.store', 'offset=4', g('$a'), k(0)], ['f64.load', g('$a')]]])
  ok(!reuseLoads(w), 'a word stored inside the slot ends it')
  const r = fn(['local.set', '$a2', g('$a')], ['local.set', '$a', ['i32.const', 64]], ['f64.add', ['f64.load', g('$a')], ['f64.load', g('$a2')]])
  ok(!reuseLoads(r), 'a copy of a local written since is the old value')
})

test('address: a rebuilt access keeps its region', () => {
  const load = ['f64.load', g('$p')]
  load.mem = 'e3'
  const out = rewriteBy(LOADS, ['i64.reinterpret_f64', load])
  is(out[0], 'i64.load', 'the bits of a load are the other load')
  is(out.mem, 'e3', 'the mark goes with it')
  const f = ['func', '$f', ['drop', load], ['drop', ['i32.load', g('$q')]]]
  is(markCount(f), { accesses: 2, marked: 1 }, 'the accesses and the marked ones')
  is(carry(load, ['f64.load', 'offset=8', g('$p')]).mem, 'e3', 'carry')
})

// `pts[(o + i) * 2]` and `pts[(o + i) * 2 + 1]`, the second's field in the memarg: one sum, which
// a loop stepping `i` gathers lane by lane (test/simd.js, the strided record fields)
test('address: two fields of a record at one sum, held by no local where its loop steps it', () => {
  const oi = () => ['i32.add', g('$o'), g('$i')]
  const x = () => ['f64.load', ['i32.add', g('$p'), shl(oi(), 4)]]
  const y = () => ['f64.load', 'offset=8', ['i32.add', g('$p'), shl(shl(oi(), 1), 3)]]
  const u = () => ['f64.load', ['i32.add', g('$u'), shl(g('$i'), 3)]]
  is(keyOf(linear(x()[1])), keyOf(linear(y()[2])), 'one sum')
  const fn = (...body) => ['func', '$f', ['param', '$p', 'i32'], ['param', '$u', 'i32'], ['param', '$o', 'i32'], ['local', '$i', 'i32'], ['local', '$s', 'f64'], ...body]
  const loop = (...body) => ['block', '$out', ['loop', '$l', ['br_if', '$out', ['i32.eqz', ['i32.lt_s', g('$i'), k(9)]]],
    ...body, ['local.set', '$i', ['i32.add', g('$i'), k(1)]], ['br', '$l']]]
  const held = (f) => JSON.stringify(f).includes('__ab')
  const straight = fn(['local.set', '$s', ['f64.add', x(), y()]])
  hoistAddrBase(straight)
  ok(held(straight), 'held where no loop steps it')
  const fields = fn(loop(['local.set', '$s', ['f64.add', x(), y()]]))
  hoistAddrBase(fields)
  ok(!held(fields), 'a loop stepping it sixteen bytes a round, past its eight: none')
  const elems = fn(loop(['local.set', '$s', ['f64.add', u(), ['f64.mul', u(), u()]]]))
  hoistAddrBase(elems)
  ok(held(elems), 'an element the round steps by its own bytes is held')
})
