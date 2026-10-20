// A large function's conditional arms become functions of their own (optimize/split-funcs.js):
// what V8 never runs it never compiles. The arms move with their locals by liveness and keep
// their exits; these pin the moves on hand-written modules, then the speed tier end to end.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import parseWat from 'watr/parse'
import compileWat from 'watr/compile'
import jz, { compile } from '../index.js'
import { splitFuncs } from '../src/optimize/split-funcs.js'
import { onKernel } from './_matrix.js'
import { oracle } from './util.js'

const FORCE = { fnMin: 0, armMin: 1 }
/** The module of `wat` split with `opts`, instantiated, and the functions it made. */
const split = (wat, opts = FORCE) => {
  const mod = parseWat(wat)
  const made = splitFuncs(mod, opts)
  return { made, exports: new WebAssembly.Instance(new WebAssembly.Module(compileWat(mod))).exports, mod }
}
const plain = (wat) => new WebAssembly.Instance(new WebAssembly.Module(compileWat(parseWat(wat)))).exports

// a call of its own makes an arm movable: one more is proportionate
const G = '(func $g (param $v i32) (result i32) (i32.add (local.get $v) (i32.const 1)))'

test('split funcs: an arm takes the locals live at its entry and returns those live after it', () => {
  const wat = `(module ${G} (func $f (export "f") (param $n i32) (param $k i32) (result i32)
    (local $a i32) (local $b i32) (local $t i32)
    (local.set $a (i32.const 3))
    (if (i32.gt_s (local.get $n) (i32.const 0))
      (then
        (local.set $t (call $g (i32.mul (local.get $n) (local.get $a))))
        (local.set $b (i32.add (local.get $t) (local.get $k)))
        (if (i32.gt_s (local.get $k) (i32.const 5)) (then (local.set $a (call $g (i32.const 99))))))
      (else (local.set $b (call $g (i32.sub (local.get $k) (local.get $n))))))
    (i32.add (i32.mul (local.get $a) (i32.const 1000)) (local.get $b))))`
  const ref = plain(wat), { made, exports, mod } = split(wat)
  is(made, 3, 'the three arms moved')
  for (const [n, k] of [[0, 0], [2, 3], [2, 9], [-4, 7], [5, 5]]) is(exports.f(n, k), ref.f(n, k), `f(${n}, ${k})`)
  // $t is written before it is read on every path: the arm declares it, the function drops it
  const f = mod.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === '$f')
  ok(!f.some(n => Array.isArray(n) && n[0] === 'local' && n[1] === '$t'), 'a local only the arm used leaves the function')
})

test('split funcs: an arm with a value and an arm ending in a branch out keep both', () => {
  const wat = `(module ${G} (func $f (export "f") (param $n i32) (result i32)
    (local $x i32)
    (block $out (result i32)
      (local.set $x
        (if (result i32) (i32.lt_s (local.get $n) (i32.const 10))
          (then (call $g (i32.mul (local.get $n) (i32.const 7))))
          (else
            (local.set $x (call $g (local.get $n)))
            (br $out (i32.mul (local.get $x) (i32.const 2))))))
      (i32.add (local.get $x) (i32.const 1)))))`
  const ref = plain(wat), { made, exports } = split(wat)
  is(made, 2, 'both arms moved')
  for (const n of [0, 3, 9, 10, 25, -1]) is(exports.f(n), ref.f(n), `f(${n})`)
})

test('split funcs: an arm ending in return returns the call', () => {
  const wat = `(module ${G} (func $f (export "f") (param $n i32) (result i32)
    (local $acc i32)
    (if (i32.eqz (local.get $n)) (then (local.set $acc (call $g (i32.const 40))) (return (i32.add (local.get $acc) (i32.const 1)))))
    (i32.mul (local.get $n) (i32.const 3))))`
  const ref = plain(wat), { made, exports } = split(wat)
  is(made, 1, 'the arm moved')
  for (const n of [0, 1, 7]) is(exports.f(n), ref.f(n), `f(${n})`)
})

test('split funcs: a chain of else-if gives up its cases and keeps its tests', () => {
  const wat = `(module ${G} (func $f (export "f") (param $n i32) (result i32)
    (local $r i32)
    (if (i32.eq (local.get $n) (i32.const 0)) (then (local.set $r (call $g (i32.const 10))))
      (else (if (i32.eq (local.get $n) (i32.const 1)) (then (local.set $r (call $g (i32.const 20))))
        (else (if (i32.eq (local.get $n) (i32.const 2)) (then (local.set $r (call $g (i32.const 30))))
          (else (local.set $r (call $g (local.get $n)))))))))
    (local.get $r)))`
  const ref = plain(wat), { made, exports, mod } = split(wat)
  is(made, 4, 'one piece per case')
  for (const p of pieces(mod)) ok(!JSON.stringify(p).includes('"if"'), `${p[1]} holds a case, not the chain`)
  for (const n of [0, 1, 2, 3, 9]) is(exports.f(n), ref.f(n), `f(${n})`)
})

test('split funcs: an arm of arithmetic stays, as does one calling only the math runtime', () => {
  const wat = `(module
    (func $math.sin (param $x f64) (result f64) (local.get $x))
    (func $f (export "f") (param $n f64) (result f64)
      (if (result f64) (f64.gt (local.get $n) (f64.const 0))
        (then (f64.mul (local.get $n) (f64.const 3)))
        (else (call $math.sin (f64.sub (local.get $n) (f64.const 1)))))))`
  const { made, exports } = split(wat)
  is(made, 0, 'nothing moved')
  is(exports.f(2), 6)
})

test('split funcs: an arm calling only in its own fallback stays, one calling on every path moves', () => {
  // a test whose rare miss calls a slow path: the common path is arithmetic, and so is a dispatch
  // whose one case calls
  const wat = `(module ${G} (func $f (export "f") (param $n i32) (param $k i32) (result i32)
    (local $x i32)
    (if (i32.gt_s (local.get $n) (i32.const 0))
      (then
        (local.set $x (i32.mul (local.get $n) (i32.const 3)))
        (if (i32.gt_s (local.get $x) (i32.const 1000)) (then (local.set $x (call $g (local.get $x)))))
        (local.set $x (i32.add (local.get $x) (i32.const 7))))
      (else
        (local.set $x (call $g (local.get $n)))
        (local.set $x (i32.sub (local.get $x) (i32.const 2)))))
    (if (i32.gt_s (local.get $k) (i32.const 0))
      (then
        (block $c1 (block $c0 (br_table $c0 $c1 (local.get $k)))
          (local.set $x (call $g (local.get $x))))
        (local.set $x (i32.xor (local.get $x) (i32.const 11)))))
    (local.get $x)))`
  const ref = plain(wat), { made, exports, mod } = split(wat)
  const f = JSON.stringify(mod.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === '$f'))
  ok(f.includes('["i32.const","7"]'), 'the arm calling only in its fallback stays')
  ok(f.includes('["i32.const","11"]'), 'the arm calling only in a dispatch case stays')
  ok(!f.includes('["i32.const","2"]'), 'the arm calling on every path moved')
  is(made, 3, 'that arm, the fallback and the case moved')
  for (const n of [0, 5, 400, -3]) for (const k of [0, 1, 2]) is(exports.f(n, k), ref.f(n, k), `f(${n}, ${k})`)
})

// a loop over cases: the arm for each is a small share of the loop
const DISPATCH = (arms) => `(module
  (func $g (param $v i32) (result i32) (i32.add (local.get $v) (i32.const 1)))
  (func $f (export "f") (param $n i32) (result i32)
    (local $i i32) (local $acc i32) (local $carry i32)
    (block $done (loop $next
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      ${arms}
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (local.get $acc)))`
const CASE = (k, body) => `(if (i32.eq (i32.rem_u (local.get $i) (i32.const 5)) (i32.const ${k})) (then ${body}))`

test('split funcs: inside a loop an arm with a call moves when it is one case of several', () => {
  const wat = DISPATCH([
    CASE(0, '(local.set $acc (i32.add (local.get $acc) (local.get $carry))) (local.set $carry (call $g (local.get $i)))'),
    CASE(1, '(local.set $acc (i32.add (local.get $acc) (i32.const 2)))'),
    CASE(2, '(local.set $acc (i32.sub (local.get $acc) (i32.const 1)))'),
    CASE(3, '(local.set $acc (i32.mul (local.get $acc) (i32.const 3)))'),
    CASE(4, '(local.set $acc (i32.xor (local.get $acc) (local.get $i)))'),
  ].join(' '))
  const ref = plain(wat), { made, exports } = split(wat)
  is(made, 1, 'only the arm with a call moved')
  for (const n of [0, 1, 2, 5, 10, 23]) is(exports.f(n), ref.f(n), `f(${n})`)
})

test('split funcs: the main path of a loop stays, call or not', () => {
  const wat = DISPATCH(CASE(0, '(local.set $acc (i32.add (local.get $acc) (local.get $carry))) (local.set $carry (call $g (local.get $i)))'))
  const ref = plain(wat), { made, exports } = split(wat)
  is(made, 0, 'nothing moved')
  for (const n of [0, 6, 11]) is(exports.f(n), ref.f(n), `f(${n})`)
})

test('split funcs: an arithmetic arm inside a loop stays, as does an arm branching out mid-way', () => {
  const wat = `(module (func $f (export "f") (param $n i32) (result i32)
    (local $i i32) (local $acc i32)
    (block $exit (result i32)
      (block $done (loop $next
        (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
        (if (i32.and (local.get $i) (i32.const 1))
          (then (local.set $acc (i32.add (local.get $acc) (i32.mul (local.get $i) (local.get $i))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
      (if (i32.gt_s (local.get $acc) (i32.const 100))
        (then (drop (br_if $exit (i32.const -1) (i32.gt_s (local.get $acc) (i32.const 1000)))) (local.set $acc (i32.const 100))))
      (local.get $acc))))`
  const ref = plain(wat), { made, exports } = split(wat)
  is(made, 0, 'nothing moved')
  for (const n of [5, 20, 30]) is(exports.f(n), ref.f(n), `f(${n})`)
})

// a handler reading a local the arm writes, then a call that throws to it
const HANDLED = (tag, payload, catchClause, handler) => `(module
  (tag $e ${tag})
  (func $boom (param $v i32) (if (local.get $v) (then (throw $e ${payload}))))
  (func $f (export "f") (param $n i32) (result i32)
    (local $x i32) (local $y i32)
    (block $caught ${tag ? '(result f64)' : ''}
      (try_table ${catchClause}
        (if (local.get $n) (then
          (local.set $x (i32.const 7))
          (call $boom (i32.sub (local.get $n) (i32.const 1)))
          (local.set $x (i32.const 9))))
        (if (i32.gt_s (local.get $n) (i32.const 5)) (then
          (local.set $y (i32.mul (local.get $n) (i32.const 3)))
          (call $boom (i32.const 0)))))
      (return (i32.add (local.get $x) (local.get $y))))
    ${handler}))`
const pieces = (mod) => mod.filter(n => Array.isArray(n) && n[0] === 'func' && String(n[1]).startsWith('$f$s'))

test('split funcs: an arm writing what a handler around it reads hands it over through the throw', () => {
  // the handler reads $x as the throw left it: the function catches the tag, returns $x with
  // the payload, and the call throws again once $x is set
  for (const wat of [
    HANDLED('', '', '(catch $e $caught)', '(i32.add (local.get $x) (i32.const 100))'),
    HANDLED('(param f64)', '(f64.const 2.5)', '(catch $e $caught)', '(i32.trunc_f64_s (f64.mul (f64.const 10))) (i32.add (local.get $x))'),
  ]) {
    const ref = plain(wat), { exports, mod } = split(wat)
    is(pieces(mod).length, 2, 'both arms moved')
    ok(JSON.stringify(pieces(mod)).includes('try_table'), 'the arm writing $x catches the tag')
    for (const n of [0, 1, 2, 6]) is(exports.f(n), ref.f(n), `f(${n})`)
  }
})

test('split funcs: under a handler that takes any exception the arm writing its local stays', () => {
  const wat = HANDLED('', '', '(catch_all $caught)', '(i32.add (local.get $x) (i32.const 100))')
  const ref = plain(wat), { exports, mod } = split(wat)
  is(pieces(mod).length, 1, 'only the arm writing what no handler reads moved')
  ok(JSON.stringify(pieces(mod)).includes('$y') && !JSON.stringify(pieces(mod)).includes('$x'), 'the moved arm is the second')
  for (const n of [0, 1, 2, 6]) is(exports.f(n), ref.f(n), `f(${n})`)
})

test('split funcs: a br_table case body moves and keeps its exit', () => {
  const wat = `(module ${G} (func $f (export "f") (param $k i32) (param $v i32) (result i32)
    (local $r i32)
    (block $end (result i32)
      (block $c2 (block $c1 (block $c0
        (br_table $c0 $c1 $c2 (local.get $k)))
        (local.set $r (call $g (i32.mul (local.get $v) (i32.const 3))))
        (br $end (i32.add (local.get $r) (i32.const 1))))
        (local.set $r (call $g (i32.sub (local.get $v) (i32.const 4))))
        (br $end (local.get $r)))
      (i32.const -1))))`
  const ref = plain(wat), { made, exports } = split(wat)
  is(made, 2, `the case bodies moved`)
  for (const k of [0, 1, 2, 9]) for (const v of [0, 5, -3]) is(exports.f(k, v), ref.f(k, v), `f(${k}, ${v})`)
})

test('split funcs: thresholds leave small functions and small arms whole', () => {
  const wat = `(module (func $f (export "f") (param $n i32) (result i32)
    (if (result i32) (local.get $n) (then (i32.const 1)) (else (i32.const 2)))))`
  is(split(wat, { fnMin: 1000, armMin: 1 }).made, 0, 'function under the bound')
  is(split(wat, { fnMin: 0, armMin: 1000 }).made, 0, 'arms under the bound')
})

// A dispatch over the kinds a value may hold, early returns, a loop over dynamic values, a
// handler: the shapes the speed tier grows, each arm a piece under forced bounds.
const SRC = `
const kind = (v) => {
  if (typeof v === 'string') return v.length > 3 ? 'long:' + v.slice(0, 3) : 'short:' + v
  if (Array.isArray(v)) {
    let s = 0
    for (const x of v) { if (typeof x === 'number') s += x; else if (typeof x === 'string') s += x.length; else s -= 1 }
    return 'arr:' + s
  }
  if (v && typeof v === 'object') { const ks = Object.keys(v); return 'obj:' + ks.join('|') + ':' + ks.length }
  if (typeof v === 'number') { if (v !== v) return 'nan'; return v > 0 ? 'pos:' + (v * 2) : 'neg:' + (-v) }
  return 'other'
}
export let run = (n) => {
  const vals = ['ab', 'abcdef', [1, 'xyz', 3, null], { a: 1, b: 2 }, 5, -7, NaN, null, [], 'q']
  let out = '', count = 0
  for (let i = 0; i < n; i++) {
    const v = vals[i % vals.length]
    let k
    try { k = kind(v); if (k === 'other' && i > 50) throw new Error('late ' + i) }
    catch (e) { k = 'caught:' + e.message }
    if (k.length > 6) { out += k[0]; count += k.length }
    else { out += '.'; count -= 1; if (count < -5) break }
  }
  return out + ':' + count
}
`

test('split funcs: the speed tier answers as the source does, whole and split to its arms', () => {
  const native = oracle(SRC).run
  const opts = [{ level: 'speed' }, { level: 'speed', splitFn: 0, splitArm: 8 }, { level: 'speed', splitFn: 0, splitArm: 1 }]
  for (const optimize of opts) {
    const run = jz(SRC, { optimize }).exports.run
    for (const n of [0, 1, 9, 10, 23, 60, 200]) is(run(n), native(n), `${JSON.stringify(optimize)}: run(${n})`)
  }
  if (onKernel()) return
  const wat = compile(SRC, { optimize: { level: 'speed', splitFn: 0, splitArm: 8 }, wat: true })
  ok(/\(func \$[^\s()]*\$s\d+/.test(wat), 'forced bounds make pieces')
})

test('split funcs: the default and size tiers keep their functions whole', () => {
  if (onKernel()) return
  for (const level of [2, 'size'])
    ok(!/\(func \$[^\s()]*\$s\d+/.test(compile(SRC, { optimize: { level, splitFn: 0, splitArm: 1 }, wat: true })), `${level}`)
})
