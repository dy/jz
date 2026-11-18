// A value an earlier site already made, with nothing between that ends it, reads the earlier
// site's local (src/optimize/numbering.js): a load with no store between that may reach its
// bytes (the use `reuseLoads`), a box's tag, a typed subscript's address; a byte or half of a
// word read alone is the narrow load of it (narrowByteLoads); a local read where it holds a
// constant is the constant (`propagateConstants`). Every value is a differential against the
// host; the WAT shows the loads.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { agree, wat } from './util.js'
import { belowOpt, ownedLevels } from './_matrix.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { numberValues, narrowByteLoads, LOAD_AT, TAG, OFFSET, SUBSCRIPT, CONSTANT } from '../src/optimize/numbering.js'
const reuseLoads = (fn, fx) => numberValues(fn, LOAD_AT, fx)

const count = (text, re) => (text.match(re) || []).length
// the balanced form that opens at `at`
const form = (text, at) => { let d = 0; for (let i = at; i < text.length; i++) { if (text[i] === '(') d++; else if (text[i] === ')' && --d === 0) return text.slice(at, i + 1) } return text.slice(at) }
const shapes = (src, check) => { if (!belowOpt(2)) check(wat(src)) }
const exportsOf = ir => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir)), { m: { m: new WebAssembly.Memory({ initial: 1 }) } }).exports

// A radix pass: the digit of an element and the element itself, read in one step.
const SCATTER = `const scatter = (a, b, count, shift) => {
  for (let i = 0; i < 4096; i++) {
    const d = (a[i] >>> shift) & 0xff
    b[count[d]] = a[i]
    count[d]++
  }
}
const histogram = (a, count) => { for (let i = 0; i < 4096; i++) count[(a[i] >>> 8) & 0xff]++ }
export let main = (k) => {
  const a = new Uint32Array(4096), b = new Uint32Array(4096), c = new Int32Array(256)
  for (let i = 0; i < 4096; i++) a[i] = (i * 2654435761 + k) >>> 0
  histogram(a, c)
  let sum = 0
  for (let i = 0; i < 256; i++) { const n = c[i]; c[i] = sum; sum += n }
  scatter(a, b, c, 8)
  return (b[5] + b[4095] + c[3]) >>> 0
}`

test('numbering: an element read twice with only loads between loads once', () => {
  for (const k of [0, 1, 77]) agree(SCATTER, 'main', [k])
  shapes(SCATTER, text => {
    const loop = form(text, text.lastIndexOf('(loop '))
    // the element once; the count, and again after the store into \`b\`, which may reach it
    is(count(loop, /\(i32\.load(?![0-9])/g), 3, 'the scatter step loads its element once')
    ok(/i32\.load8_u offset=1/.test(text), 'the histogram reads the digit as one byte')
  })
})

test('numbering: a store, a call, a write of the address or a join keeps the second load', () => {
  const ir = parseWat(`(module (import "m" "m" (memory 1))
    (func $id (param i32) (result i32) (local.get 0))
    (func $f (export "f") (param $p i32) (param $c i32) (result i32) (local $q i32)
      (i32.store (i32.const 0) (i32.const 5))
      (i32.store (i32.const 4) (i32.const 6))
      (local.set $q (i32.add
        (i32.load (local.get $p))
        (if (result i32) (local.get $c) (then (i32.load (local.get $p))) (else (i32.const 0)))))
      (i32.store (local.get $p) (i32.const 9))
      (local.set $q (i32.add (local.get $q) (i32.load (local.get $p))))
      (drop (call $id (i32.const 0)))
      (local.set $q (i32.add (local.get $q) (i32.load (local.get $p))))
      (local.set $p (i32.const 4))
      (i32.add (local.get $q) (i32.add (i32.load (local.get $p)) (i32.load (local.get $p))))))`)
  const fn = ir.find(n => n[0] === 'func' && n[1] === '$f')
  const before = exportsOf(ir).f
  ok(reuseLoads(fn), 'the last pair shares its load')
  const text = JSON.stringify(fn)
  is(count(text, /"i32\.load"/g), 5, 'only the store-free pair after the write of $p shares a load')
  const after = exportsOf(ir).f
  for (const p of [0, 4]) for (const c of [0, 1]) is(after(p, c), before(p, c), `p=${p} c=${c}`)
})

test('numbering: a part of a word narrows to its load, the word kept whole where read whole', () => {
  const ir = parseWat(`(module (import "m" "m" (memory 1))
    (func $f (export "f") (param $p i32) (result i32) (local $w i32) (local $v i32)
      (i32.store (local.get $p) (i32.const 0x89abcdef))
      (i32.add (i32.add (i32.add
        (i32.and (i32.shr_u (i32.load (local.get $p)) (i32.const 8)) (i32.const 255))
        (i32.shr_s (i32.load (local.get $p)) (i32.const 16)))
        (i32.add (i32.and (local.tee $w (i32.load (local.get $p))) (i32.const 65535)) (i32.and (local.get $w) (i32.const 65535))))
        (i32.add (i32.and (local.tee $v (i32.load (local.get $p))) (i32.const 255)) (local.get $v)))))`)
  const fn = ir.find(n => n[0] === 'func' && n[1] === '$f')
  const before = exportsOf(ir).f
  ok(narrowByteLoads(fn), 'the parts narrow')
  const text = JSON.stringify(fn)
  ok(text.includes('"i32.load8_u","offset=1"') && text.includes('"i32.load16_s","offset=2"'), 'byte 1 and the signed top half read alone')
  is(count(text, /"i32\.load16_u"/g), 1, 'a local every read of which takes its low half holds the half')
  is(count(text, /"i32\.load"/g), 1, 'a local read whole keeps the word')
  const after = exportsOf(ir).f
  for (const p of [0, 8, 100]) is(after(p), before(p), `p=${p}`)
})

const g = (n) => ['local.get', n]
const tag = (x) => ['call', '$__ptr_type', ['i64.reinterpret_f64', g(x)]]
const fnOf = (...body) => ['func', '$f', ['param', '$x', 'f64'], ['local', '$y', 'f64'], ['local', '$t', 'i32'], ...body]
const tags = (f) => { numberValues(f, TAG); const out = []; const walk = (n) => { if (!Array.isArray(n)) return; if (n[0] === 'local.tee' || n[0] === 'local.get' && String(n[1]).startsWith('$__pt')) out.push(n[0]); for (let i = 1; i < n.length; i++) walk(n[i]) }; walk(f); return out.filter(o => o === 'local.tee' || o === 'local.get').join(' ') }

test('numbering: what holds past a join is what holds on each way into it', () => {
  const set = (v) => ['local.set', '$t', v]
  is(tags(fnOf(set(tag('$x')), ['block', ['if', g('$t'), ['then', ['return']]], set(tag('$x'))], set(tag('$x')))), 'local.tee local.get local.get',
    'a block whose only way out leaves the function ends nothing')
  is(tags(fnOf(['block', '$b', ['br_if', '$b', g('$t')], set(tag('$x'))], set(tag('$x')))), '',
    'a branch to a block\'s end may come from before the first site')
  is(tags(fnOf(set(tag('$x')), ['if', g('$t'), ['then', ['unreachable']], ['else', set(tag('$x'))]], set(tag('$x')))), 'local.tee local.get local.get',
    'an arm that never completes adds nothing to the join')
  is(tags(fnOf(['local.set', '$y', g('$x')], set(tag('$x')), set(tag('$y')))), '', 'a copy\'s tag is its own (a tag shared through a copy cost three.js\'s animation case a tenth)')
  is(tags(fnOf(['local.set', '$y', g('$x')], ['local.set', '$x', ['f64.const', 0]], set(tag('$x')), set(tag('$y')))), '', 'a copy of a box written since is the old box')
  // (a try_table's catch clause branches to its label's end: an arm whose block ends so completes)
  const caught = ['block', '$b', ['try_table', ['catch', '$__jz_err', '$b'], ['local.set', '$x', ['f64.const', 0]], ['call', '$g']], ['throw', '$__jz_err', g('$x')]]
  is(tags(fnOf(set(tag('$x')), ['if', g('$t'), ['then', caught], ['else', set(tag('$x'))]], set(tag('$x')))), 'local.tee local.get',
    'an arm whose last block a catch clause ends completes, past a write of the box')
})

// A finalizer after a body that may throw is emitted twice (src/compile/emit/statements.js
// 'finally'): the normal way out's copy inside the block the catch clause branches to the end
// of, the handler's after it. What the first copy made the handler's way never ran.
test('numbering: a catch clause branches to its block\'s end: the finalizer\'s handler copy holds nothing of the normal copy', () => {
  // `clause`: the catch clause of the try_table, its last operand the block it leaves to
  const fin = (site, clause = ['catch', '$__jz_err', '$catch']) => ['func', '$f', ['param', '$x', 'f64'], ['param', '$p', 'i32'], ['param', '$i', 'i32'], ['local', '$s', 'f64'], ['local', '$e', 'f64'],
    ['block', '$done',
      ['block', '$catch', ['result', 'f64'],
        ['try_table', clause, ['call', '$g']],
        ['local.set', '$s', site()],
        ['br', '$done']],
      ['local.set', '$e'],
      ['local.set', '$s', site()],
      ['throw', '$__jz_err', g('$e')]]]
  const num = (n) => ['f64.convert_i32_s', n]
  const sites = {
    TAG: [TAG, () => num(tag('$x'))],
    OFFSET: [OFFSET, () => num(['call', '$__ptr_offset', ['i64.reinterpret_f64', g('$x')]])],
    SUBSCRIPT: [SUBSCRIPT, () => ['f64.load', ['i32.add', g('$p'), ['i32.shl', g('$i'), ['i32.const', 3]]]]],
    LOAD_AT: [LOAD_AT, () => ['f64.load', g('$p')]],
  }
  for (const [name, [kind, site]] of Object.entries(sites)) {
    ok(!numberValues(fin(site), kind), `${name}: no local holds a value across the catch block's end`)
    ok(!numberValues(fin(site, ['catch_all', '$catch']), kind), `${name}: the same past a catch_all`)
  }
})

test('numbering: a subscript nested deeper than the one sum follows is no site', () => {
  let idx = g('$i')
  for (let d = 0; d < 30; d++) idx = ['i32.add', idx, ['i32.const', 1]]
  const deep = () => ['f64.load', ['i32.add', g('$p'), ['i32.shl', idx, ['i32.const', 3]]]]
  const f = ['func', '$f', ['param', '$p', 'i32'], ['param', '$i', 'i32'], ['result', 'f64'], ['f64.add', deep(), deep()]]
  ok(!numberValues(f, SUBSCRIPT), 'held by no local, and the walk goes on')
})

// The same from source, at the levels that number, a module to a program: an element, fields,
// an array that grows, a field of an object that escaped, read in a finalizer after a body that
// throws on some calls. (A tag there guards a fast path whose other arm is the generic one,
// which answers right from any tag: the IR test above holds it.)
test('numbering: a finalizer after a throw reads what its own way made', () => {
  const programs = {
    'a field of an object that escaped': `let sum = 0
      let keep = []
      let mk = (a) => { let o = { x: a }; keep.push(o); return o }
      let f = (o, t) => { try { if (t) throw 1 } finally { sum += o.x }; return 0 }
      export let main = () => { sum = 0
        f(mk(1.5), 0)
        try { f(mk(8.5), 1) } catch (e) { sum += 0.25 }
        return sum }`,
    'typed elements': `let sum = 0
      let f = (a, i, t) => { try { if (t) throw 1 } finally { sum += a[i] + a[i + 1] } }
      export let main = () => { sum = 0
        let a = new Float64Array([1, 2, 4, 8])
        f(a, 0, 0)
        try { f(a, 2, 1) } catch (e) { sum += 100 }
        return sum }`,
    'fields of objects of two layouts': `let sum = 0
      let f = (o, t) => { try { if (t) throw 1 } finally { sum += o.x + o.y } }
      export let main = () => { sum = 0
        f({ x: 1, y: 2 }, 0); f({ y: 4, x: 8 }, 0)
        try { f({ x: 16, y: 32 }, 1) } catch (e) { sum += 1000 }
        try { f({ y: 64, x: 128 }, 1) } catch (e) { sum += 10000 }
        return sum }`,
    'an array that grows': `let sum = 0
      let f = (a, t) => { try { a.push(1); if (t) throw 1 } finally { sum += a[0] + a[a.length - 1] } }
      export let main = () => { sum = 0
        let a = [5], b = [7, 9]
        f(a, 0)
        try { f(b, 1) } catch (e) { sum += 100 }
        return sum }`,
  }
  for (const [name, src] of Object.entries(programs)) for (const optimize of ownedLevels(2, 'size', 'speed'))
    agree(src, 'main', [], { optimize }, `${name}, at ${optimize}`)
})

// three.js's compose writes 0 and 1 into fixed slots of a matrix and the multiply after it reads them
// back (bench/threescene's loop): each read of a slot is the temporary that held the constant stored
// there. At the speed tier no float local of the function that holds only constants is read.
const COMPOSE = `class Mat {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }
  compose(x, y, s) {
    const te = this.elements
    te[0] = s; te[1] = 0; te[2] = 0; te[3] = 0; te[4] = 0; te[5] = s; te[6] = 0; te[7] = 0
    te[8] = 0; te[9] = 0; te[10] = s; te[11] = 0; te[12] = x; te[13] = y; te[14] = 0; te[15] = 1
    return this
  }
  multiply(a, b) {
    const ae = a.elements, be = b.elements, te = this.elements
    const a11 = ae[0], a12 = ae[4], a13 = ae[8], a14 = ae[12], a21 = ae[1], a22 = ae[5], a23 = ae[9], a24 = ae[13]
    const b11 = be[0], b12 = be[4], b13 = be[8], b14 = be[12], b21 = be[1], b22 = be[5], b23 = be[9], b24 = be[13]
    const b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14], b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15]
    te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41
    te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42
    te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41
    te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44
    return this
  }
}
const local = [], world = []
for (let i = 0; i < 8; i++) { local.push(new Mat()); world.push(new Mat()) }
export let f = (x, n) => {
  let s = 0
  for (let i = 0; i < n; i++) {
    const k = i & 7
    local[k].compose(x + i, x - i, 1.5)
    world[k].multiply(world[(k + 7) & 7], local[k])
    s += world[k].elements[13]
  }
  return s
}`

test('numbering: a matrix composed with constants and multiplied reads the constants', () => {
  for (const args of [[0.5, 0], [0.5, 9], [-0, 17], [NaN, 3]]) agree(COMPOSE, 'f', args, { optimize: 'speed' })
  if (belowOpt(2)) return
  const tree = parseWat(wat(COMPOSE, { optimize: 'speed' }))
  const pooled = new Set(tree.filter(n => Array.isArray(n) && n[0] === 'global' && !n.some(c => Array.isArray(c) && c[0] === 'mut')).map(g => g[1]))
  const constant = (v) => Array.isArray(v) && (v[0] === 'f64.const' || v[0] === 'global.get' && pooled.has(v[1]))
  const f = tree.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === '$f')
  const types = new Map(f.filter(n => Array.isArray(n) && n[0] === 'local').map(n => [n[1], n[2]]))
  const writes = new Map(), reads = new Map()
  const walk = (n) => {
    if (!Array.isArray(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') writes.set(n[1], [...writes.get(n[1]) ?? [], n[2]])
    if (n[0] === 'local.get') reads.set(n[1], (reads.get(n[1]) ?? 0) + 1)
    n.forEach(walk)
  }
  walk(f)
  const held = [...writes].filter(([k, vs]) => types.get(k) === 'f64' && vs.every(constant) && reads.get(k))
  is(held.map(([k]) => k).join(' '), '', 'no float local of constants is read')
})

// A local where it holds a constant reads as the constant: compose's 0 stored through a tee and read
// by the products after it, a local written twice, a copy of a constant, one constant on both ways
// into a join, a constant through a loop that never writes the local and out of one whose end holds
// it. What reads as no constant: a constant on one way into a join, 0 against -0 and two NaN
// payloads at a join, a tee whose store is conditional, a read in a round before the round's write,
// a branch to a block's end, a catch clause's block, a read inside a node two parents hold (the
// first parent's constant would be the second's). Each case: the reads of $z left, and its answers
// before and after.
test('numbering: a read of a local where it holds a constant is the constant', () => {
  const sum = (x) => `(local.set $s (f64.add (local.get $s) ${x}))`
  const loop = (body) => `(local.set $i (i32.const 3)) (loop $l ${body} (br_if $l (local.tee $i (i32.sub (local.get $i) (i32.const 1)))))`
  const cases = {
    compose: [0, `(f64.store offset=24 (local.get $p) (local.tee $z (f64.const 0)))
      (f64.add (f64.mul (local.get $y) (local.get $z)) (f64.mul (f64.load offset=24 (local.get $p)) (local.get $z)))`],
    twice: [0, `(local.set $z (f64.const 2)) ${sum('(f64.mul (local.get $y) (local.get $z))')}
      (local.set $z (f64.const 3)) (f64.add (local.get $s) (f64.mul (local.get $y) (local.get $z)))`],
    copy: [0, `(local.set $s (f64.const 0.5)) (local.set $z (local.get $s)) (f64.mul (local.get $y) (local.get $z))`],
    bothArms: [0, `(if (local.get $c) (then (local.set $z (f64.const 4))) (else (local.set $z (f64.const 4)))) (f64.mul (local.get $y) (local.get $z))`],
    loopKept: [0, `(local.set $z (f64.const 0.25)) ${loop(sum('(f64.mul (local.get $y) (local.get $z))'))} (f64.add (local.get $s) (local.get $z))`],
    onePath: [1, `(local.set $z (local.get $y)) (if (local.get $c) (then (local.set $z (f64.const 4)))) (f64.mul (local.get $y) (local.get $z))`],
    signedZero: [1, `(if (local.get $c) (then (local.set $z (f64.const 0))) (else (local.set $z (f64.const -0)))) (f64.div (f64.const 1) (local.get $z))`],
    payloads: [1, `(if (local.get $c) (then (local.set $z (f64.const nan:0x4))) (else (local.set $z (f64.const nan:0x5))))
      (f64.convert_i64_u (i64.and (i64.reinterpret_f64 (local.get $z)) (i64.const 255)))`],
    teeUnderIf: [1, `(local.set $z (local.get $y)) (if (local.get $c) (then (f64.store (local.get $p) (local.tee $z (f64.const 0))))) (f64.add (local.get $z) (f64.const 1))`],
    // (the read in the loop stays; the one after it reads the round's last write)
    beforeWrite: [1, `(local.set $z (f64.const 5)) ${loop(`${sum('(f64.mul (local.get $y) (local.get $z))')} (local.set $z (f64.const 0))`)} (f64.add (local.get $s) (local.get $z))`],
    branch: [1, `(block $b (local.set $z (f64.const 0)) (br_if $b (local.get $c)) (local.set $z (f64.const 1))) (f64.add (local.get $y) (local.get $z))`],
    caught: [1, `(local.set $z (f64.const 1)) (block $k (try_table (catch_all $k) (local.set $z (f64.const 2)) (call $g (local.get $c)) (local.set $z (f64.const 3))))
      (f64.add (local.get $y) (local.get $z))`],
    shared: [2, `(local.set $z (f64.const 0)) (local.set $s (f64.nop)) (local.set $z (f64.const 1)) (f64.add (local.get $s) (f64.nop))`],
  }
  const reads = (n) => !Array.isArray(n) ? 0 : (n[0] === 'local.get' && n[1] === '$z' ? 1 : 0) + n.reduce((s, c) => s + reads(c), 0)
  // (the emitter's constants are numbers, -0 among them; `(f64.nop)` marks where one node goes twice)
  const node = () => ['f64.mul', ['local.get', '$y'], ['local.get', '$z']]
  const fix = (n, shared) => { for (let i = 0; i < n.length; i++) if (Array.isArray(n[i])) n[i][0] === 'f64.nop' ? n[i] = shared : fix(n[i], shared)
    if (n[0] === 'f64.const' && /^-?[\d.]+$/.test(n[1])) n[1] = Number(n[1]) }
  const run = (f) => [0, 1].flatMap(c => [1.5, -0, NaN, Infinity].map(y => { const r = f(0, c, y); return Object.is(r, -0) ? '-0' : String(r) })).join(' ')
  for (const [name, [left, body]] of Object.entries(cases)) {
    const ir = parseWat(`(module (import "m" "m" (memory 1)) (tag $e)
      (func $g (param i32) (if (local.get 0) (then (throw $e))))
      (func $f (export "f") (param $p i32) (param $c i32) (param $y f64) (result f64) (local $z f64) (local $s f64) (local $i i32) ${body}))`)
    const fn = ir.find(n => n[0] === 'func' && n[1] === '$f')
    fix(fn, node())
    const before = run(exportsOf(ir).f)
    numberValues(fn, CONSTANT)
    is(reads(fn), left, `${name}: the reads of $z left`)
    is(run(exportsOf(ir).f), before, `${name}: the same answers`)
  }
})
