// A word that holds a number (optimize/peephole.js holdWordNumbers, foldLoadCasts):
// the negation in the word, loads as integers, and a field or element read back
// exactly when another number is stored behind it.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels, belowOpt } from './_matrix.js'
import { foldLoadCasts, holdWordNumbers } from '../src/optimize/peephole.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { funcWat, run, oracle, jz, compile } from './util.js'
import { walk } from '../scripts/wat-probe.mjs'
import { findFunc } from './_optimizer.js'

test('wrapped words: `avail & -avail` negates in the word, exact at the int32 extreme', () => {
  // A negation of a word may exceed int32 (-INT_MIN), so the narrowing widened it to
  // i64 and wrapped the result for its bitwise consumer: `i32.wrap_i64(i64.sub(0,
  // i64.extend_i32_s x))`, which is `i32.sub(0, x)` exactly, modulo 2^32.
  const src = `export let lowbit = (avail) => avail & -avail
    export let count = (all) => { let cnt = 0, avail = all | 0; while (avail !== 0) { const b = avail & -avail; avail = avail - b; cnt++ } return cnt }`
  const m = jz(src, { optimize: 'speed' }).exports
  for (const x of [0, 1, 6, 12, 2147483647, -2147483648, -1, -6]) is(m.lowbit(x), x & -x, `lowbit(${x})`)
  for (const x of [0, 1, 255, 2147483647, -2147483648, -1]) is(m.count(x), (x => { let c = 0, a = x | 0; while (a !== 0) { a -= a & -a; c++ } return c })(x), `count(${x})`)
  if (onKernel()) return
  const w = compile(src, { optimize: 'speed', wat: true })
  // (an export's Number parameter still converts through the wide path, and an unbounded count widens; the negation itself is the word's)
  for (const f of ['lowbit', 'count']) ok(!/i64\.sub\s*\(i64\.const 0\)|i64\.extend_i32_s \(local\.get \$avail\)/.test(funcWat(w, f)), `${f}: no wide negation, the negation is the word's`)
})

// A plain array's pointer element read only for its bits loads as an integer: the
// reinterpreted float load is the i64 load, its low word the i32 load, and a float
// local read only through its bits holds them as an i64 (optimize/peephole.js).
test('load casts: a pointer element loads into an integer register, exact', () => {
  const src = `(module (memory (export "memory") 1)
    (func $f (export "f") (param $p i32) (param $j i32) (result f64)
      (local $s f64) (local $c i32)
      (local.set $c (i32.wrap_i64 (i64.reinterpret_f64 (f64.load (i32.add (local.get $p) (i32.shl (local.get $j) (i32.const 3)))))))
      (local.set $s (block (result f64) (local.set $j (i32.add (local.get $j) (i32.const 1))) (f64.load offset=64 (local.get $p))))
      (f64.add (f64.load (local.get $c))
        (f64.load offset=8 (i32.wrap_i64 (i64.and (i64.reinterpret_f64 (local.get $s)) (i64.const 4294967295)))))))`
  const tree = parseWat(src), fn = findFunc(tree, '$f')
  foldLoadCasts(fn)
  const text = JSON.stringify(fn)
  ok(!text.includes('reinterpret_f64'), 'no float load is read for its bits')
  ok(text.includes('"i32.load"') && text.includes('"i64.load"'), 'the pointer loads are integer loads')
  ok(text.includes('["local","$s","i64"]'), 'a local read only for its bits holds an i64')
  const inst = (t) => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(t))).exports
  const before = inst(parseWat(src)), after = inst(tree)
  for (const m of [before, after]) {
    const w = new BigUint64Array(m.memory.buffer), d = new Float64Array(m.memory.buffer)
    w[0] = 0x7FFC000000000100n; w[8] = 0x7FFC000000000200n; d[32] = 1.5; d[65] = 2.25
  }
  is(after.f(0, 0), before.f(0, 0), 'the same sum')
  is(after.f(0, 0), 3.75, 'of the two fields the pointers name')
  // a write two parents share (the emitter reuses nodes) is rewritten once, and a write of
  // a value on the stack (a catch's payload) keeps its local's type
  const shared = `(module (memory (export "memory") 1)
    (func $g (export "g") (param $p i32) (result i32)
      (local $s f64)
      (if (local.get $p) (then SET) (else SET))
      (i32.wrap_i64 (i64.reinterpret_f64 (local.get $s)))))`
  const t2 = parseWat(shared.replace(/SET/g, '(nop)')), g = findFunc(t2, '$g')
  const set = ['block', ['local.set', '$s', ['f64.load', ['local.get', '$p']]]]
  walk(g, n => { if (n[0] === 'then' || n[0] === 'else') n[1] = set })
  foldLoadCasts(g)
  ok(!JSON.stringify(g).includes('"i64.reinterpret_f64",["i64.reinterpret_f64"'), 'no write reinterprets twice')
  const m2 = inst(t2), w2 = new BigUint64Array(m2.memory.buffer)
  w2[1] = 0x7FFC0000000000ABn
  is(m2.g(8), 0xAB, 'the shared write loads the word')
})

// A word local every write of which truncates a number that is a word exactly
// (emit's mark `wordOf`) and every read of which converts back holds the number
// (optimize/peephole.js holdWordNumbers): no truncation a write, no conversion a read.
test('word numbers: a word local only float code reads holds its number', () => {
  const src = `(module (memory (export "memory") 1)
    (func $f (export "f") (param $p i32) (result f64)
      (local $y i32) (local $z i32) (local $k i32) (local $u i32) (local $s i32) (local $t i32) (local $e i32)
      (local.set $y (i32.trunc_sat_f64_s (f64.load (local.get $p))))
      (local.set $k (i32.trunc_sat_f64_s (f64.load offset=16 (local.get $p))))
      (local.set $u (i32.trunc_sat_f64_s (f64.load offset=24 (local.get $p))))
      (local.set $s (i32.trunc_sat_f64_s (f64.load offset=32 (local.get $p))))
      (f64.add
        (f64.add (f64.mul (f64.convert_i32_s (local.get $y)) (f64.const 0.25))
          (f64.mul (f64.convert_i32_s (local.get $u)) (f64.convert_i32_s (local.get $s))))
        (f64.add
          (f64.add (f64.convert_i32_s (local.tee $z (i32.trunc_sat_f64_s (f64.load offset=8 (local.get $p)))))
            (f64.add (f64.convert_i32_s (local.get $z)) (f64.convert_i32_s (i32.and (local.get $k) (i32.const 3)))))
          (f64.add (f64.convert_i32_s (local.get $e))
            (f64.add (f64.convert_i32_s (i32.shr_s (local.tee $t (i32.trunc_sat_f64_s (f64.load offset=40 (local.get $p)))) (i32.const 1)))
              (f64.convert_i32_s (local.get $t))))))))`
  // (emit's mark, on every truncation but `$u`'s: its number may be a fraction; `$s`'s names another operand)
  const marked = () => {
    const tree = parseWat(src), fn = findFunc(tree, '$f')
    walk(fn, n => {
      if ((n[0] !== 'local.set' && n[0] !== 'local.tee') || n[2]?.[0] !== 'i32.trunc_sat_f64_s' || n[1] === '$u') return
      n[2].wordOf = n[1] === '$s' ? ['f64.load', ['local.get', '$p']] : n[2][1]
    })
    return [tree, fn]
  }
  const [tree, fn] = marked()
  holdWordNumbers(fn)
  const text = JSON.stringify(fn)
  ok(text.includes('["local","$y","f64"]') && text.includes('["local","$z","f64"]'), 'the locals only float code reads hold numbers')
  ok(text.includes('["local.set","$y",["f64.load"') && text.includes('["local.tee","$z",["f64.load"'), 'each write is the load')
  ok(!text.includes('["f64.convert_i32_s",["local.get","$y"]') && !text.includes('["f64.convert_i32_s",["local.get","$z"]') && !text.includes('["f64.convert_i32_s",["local.tee","$z"'), 'each read is the local')
  ok(text.includes('["local","$k","i32"]'), 'a local an integer reads keeps its word')
  ok(text.includes('["local","$t","i32"]'), 'a local whose write an integer reads in place keeps its word')
  ok(text.includes('["local","$u","i32"]'), 'a local written by an unmarked truncation keeps its word')
  ok(text.includes('["local","$s","i32"]'), 'a mark that names another operand holds nothing')
  ok(text.includes('["local","$e","i32"]'), 'a local nothing writes keeps its type')
  const inst = (t) => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(t))).exports
  const before = inst(parseWat(src)), after = inst(tree)
  // a write of a value on the stack is out of the walk's view: no local is retyped beside one
  const [flatTree, flat] = marked()
  flat.splice(flat.findIndex(n => Array.isArray(n) && n[0] === 'local.set'), 0, ['i32.const', 5], ['local.set', '$y'])
  holdWordNumbers(flat)
  ok(!/\["local","\$[a-z]","f64"\]/.test(JSON.stringify(flat)), 'a flat write retypes none')
  const flatAfter = inst(flatTree)
  for (const [y, z, k, u, s, t] of [[7, -3, 6, 2.75, 5, 9], [0, 0, 0, -0.5, -1, -7], [-2147483648, 2147483647, -1, 1e10, 3, 2147483647], [1, 1, 1, NaN, 2, -2147483648]]) {
    for (const m of [before, after, flatAfter]) new Float64Array(m.memory.buffer).set([y, z, k, u, s, t])
    is(after.f(0), before.f(0), `the same sum of ${[y, z, k, u, s, t]}`)
    is(flatAfter.f(0), before.f(0), `and beside a flat write, of ${[y, z, k, u, s, t]}`)
  }
})

test('word numbers: fields of integers read by float code load as numbers', () => {
  // `y` and `z` hold words by the census of their writes; the kernel reads them only into
  // float sums, twice each, so the plan holds each in a local of its own
  const source = `const mk = (n) => { const rows = []; for (let i = 0; i < n; i++) rows.push({ x: i * 0.5, y: i + 1, z: (i & 7) - 3 }); return rows }
  const k = (rows, xs, ys, zs) => { for (let i = 0; i < rows.length; i++) { const p = rows[i]; xs[i] = p.x + p.y * 0.25; ys[i] = p.y - p.z * 0.5; zs[i] = p.z + p.x * 0.125 } }
  export let f = (n) => { const rows = mk(n), a = new Float64Array(n), b = new Float64Array(n), c = new Float64Array(n); k(rows, a, b, c); k(rows, c, b, b); return [a, b, c] }`
  const expected = oracle(source)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const actual = run(source, { optimize })
    for (const n of [0, 1, 5, 33]) is(actual.f(n), expected.f(n), `n=${n}, ${optimize}`)
  }
  if (belowOpt(2) || onKernel()) return
  const body = funcWat(compile(source, { wat: true }), 'k')
  ok(body.includes('f64.load'), 'the kernel reads its fields')
  ok(!body.includes('i32.trunc_sat_f64_s') && !body.includes('f64.convert_i32_s'), 'no field is truncated to a word and converted back')
})

test('word numbers: a fraction, a -0 or a NaN stored behind the local is read back', () => {
  // the mark is the census's: one store of another number anywhere and the field, the element, is no word
  const SRC = [
    ['const rows = []; for (let i = 0; i < n; i++) rows.push({ w: W[i % W.length], u: i })', 'rows[i].w', v => `rows[n >> 1].w = ${v}`],
    ['const t = []; for (let i = 0; i < n; i++) t.push(W[i % W.length])', 't[i]', v => `t[n >> 1] = ${v}`],
  ]
  const HOLD = [r => `const v = ${r}`, r => `if (i & 1) v = ${r}`, r => `s += (v = ${r}) * 0.25`]
  const USE = ['s += v * 0.5', 's += 1 / v === -Infinity ? 100 : v / 3', 's += v * 0.5 + (v & 3)']
  for (const [setup, read, poke] of SRC) for (const hold of HOLD) for (const use of USE) for (const stored of [null, '0.5', '-0', 'NaN', '4294967296']) {
    const source = `const W = [3, -1, 4, 0, -2147483648, 2147483647, 7, -8, 1]
    export let f = (n, poke) => {
      ${setup}
      ${stored ? `if (poke) ${poke(stored)}` : ''}
      let s = 0, v = 0
      for (let i = 0; i < n; i++) { ${hold(read)}; ${use} }
      return [s, v]
    }`
    const expected = oracle(source)
    for (const optimize of levels(0, 2, 'size')) {
      const actual = run(source, { optimize })
      for (const [n, p] of [[1, 0], [2, 1], [9, 0], [9, 1]]) is(actual.f(n, p), expected.f(n, p), `${read}; ${hold(read)}; ${use}; stored ${stored}; n=${n}, poke=${p}, ${optimize}`)
    }
  }
})
