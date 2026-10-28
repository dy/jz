// A large function's conditional arms become functions of their own (optimize/split-funcs.js):
// what V8 never runs it never compiles. The arms move with their locals by liveness and keep
// their exits; these pin the moves on hand-written modules, then the speed tier end to end.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import parseWat from 'watr/parse'
import compileWat from 'watr/compile'
import jz, { compile } from '../index.js'
import { splitFuncs, loopPasses } from '../src/optimize/split-funcs.js'
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

// a straight run of calls, the shape of a module assembler: no arm to give up
const RUN = (n) => Array.from({ length: n }, (_, i) =>
  `(local.set $acc (i32.add (local.get $acc) (call $g (i32.add (local.get $k) (i32.const ${i})))))`).join(' ')

test('split funcs: a function past the bound with no arm gives up runs of whole statements', () => {
  const wat = `(module ${G} (func $f (export "f") (param $k i32) (result i32)
    (local $acc i32)
    ${RUN(12)}
    (i32.mul (local.get $acc) (i32.const 3))))`
  const ref = plain(wat), { made, exports, mod } = split(wat, { fnMin: 40, armMin: 1 })
  ok(made >= 2, `runs moved (${made})`)
  const f = mod.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === '$f')
  ok(JSON.stringify(f).includes('["i32.const","3"]'), 'the value the function returns stays in it')
  for (const k of [0, 7, -100]) is(exports.f(k), ref.f(k), `f(${k})`)
})

test('split funcs: a run stops at a statement that takes its operand from the stack', () => {
  // the pair's values are set by two statements that take them off the stack: a run must hold the
  // call and both sets or none of them
  const wat = `(module ${G}
    (func $pair (param $v i32) (result i32 i32) (local.get $v) (i32.mul (local.get $v) (i32.const 2)))
    (func $f (export "f") (param $k i32) (result i32)
      (local $acc i32) (local $a i32) (local $b i32)
      ${RUN(4)}
      (call $pair (local.get $acc))
      (local.set $b)
      (local.set $a)
      ${RUN(4)}
      (i32.add (i32.mul (local.get $a) (i32.const 1000)) (i32.add (local.get $b) (local.get $acc)))))`
  const ref = plain(wat), { made, exports } = split(wat, { fnMin: 30, armMin: 1 })
  ok(made >= 1, `runs moved (${made})`)
  for (const k of [0, 3, -9]) is(exports.f(k), ref.f(k), `f(${k})`)
})

test('split funcs: a statement holding a loop ends a run and stays', () => {
  // a driver's unrolled rounds: each round's loop would be a piece entered once, compiled again
  // for nothing once its loop spends its budget
  const ROUND = (k) => `(block $r${k} (local.set $i (i32.const 0)) (loop $l${k}
      (br_if $r${k} (i32.ge_s (local.get $i) (local.get $k)))
      (local.set $acc (i32.add (local.get $acc) (call $g (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l${k})))`
  const wat = `(module ${G} (func $f (export "f") (param $k i32) (result i32)
    (local $acc i32) (local $i i32)
    ${RUN(6)} ${ROUND(0)} ${RUN(6)} ${ROUND(1)}
    (local.get $acc)))`
  const ref = plain(wat), { made, exports, mod } = split(wat, { fnMin: 40, armMin: 1 })
  ok(made >= 1, `the straight runs moved (${made})`)
  const pieces = mod.filter(n => Array.isArray(n) && n[0] === 'func' && /\$s\d+$/.test(n[1]))
  ok(!JSON.stringify(pieces).includes('"loop"'), 'no piece holds a loop')
  for (const k of [0, 3, 7]) is(exports.f(k), ref.f(k), `f(${k})`)
})

test('split funcs: a run that is most of a loop stays in it', () => {
  const wat = `(module ${G} (func $f (export "f") (param $n i32) (param $k i32) (result i32)
    (local $i i32) (local $acc i32)
    (block $done (loop $next
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (block $body ${RUN(6)})
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (local.get $acc)))`
  const ref = plain(wat), { made, exports } = split(wat, { fnMin: 40, armMin: 1 })
  is(made, 0, 'nothing moved')
  for (const n of [0, 3]) is(exports.f(n, 2), ref.f(n, 2), `f(${n})`)
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

// Each pass of a loop of a few passes that runs a loop, in a function that runs once, is a
// call (loopPasses): V8 replaces a function's code between calls only.
const NEST = (inner, rows = '(i32.const 40)', entry = '') => `(func $f (export "f") (param $n i32) (result i32)
    (local $i i32) (local $j i32) (local $acc i32) (local $row i32)
    ${entry}
    (block $done (loop $rows
      (br_if $done (i32.ge_s (local.get $i) ${rows}))
      (local.set $row (i32.mul (local.get $i) (i32.add (local.get $n) (i32.const 3))))
      (local.set $j (i32.const 0))
      (block $cols (loop $col
        (br_if $cols (i32.ge_s (local.get $j) (local.get $i)))
        (local.set $acc (i32.add (local.get $acc) (i32.xor (local.get $row) ${inner})))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $col)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $rows)))
    (i32.add (local.get $acc) (local.get $i)))`
const passes = (wat) => {
  const mod = parseWat(wat)
  const made = loopPasses(mod, { user: name => !name.startsWith('$__') })
  return { made, exports: new WebAssembly.Instance(new WebAssembly.Module(compileWat(mod))).exports, mod }
}

test('loop passes: a nest in an export gives its outer loop\'s pass, carried locals in and out', () => {
  const wat = `(module ${NEST('(local.get $j)')})`
  const ref = plain(wat), { made, exports, mod } = passes(wat)
  is(made, 1, 'the outer pass moved')
  for (const n of [0, 1, 2, 7, 30]) is(exports.f(n), ref.f(n), `f(${n})`)
  const piece = mod.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === '$f$s0')
  ok(piece && piece.some(n => Array.isArray(n) && n[0] === 'result'), 'the piece returns what the loop carries')
})

test('loop passes: a loop of passes a runtime value counts, of many passes, or entered at an unknown count keeps them', () => {
  // its passes may be short (a frame's loop over its rows): a call each would cost
  const kept = {
    'a runtime count': NEST('(local.get $j)', '(local.get $n)'),
    'many passes': NEST('(local.get $j)', '(i32.const 100000)'),
    'a count entered from a parameter': NEST('(local.get $j)', '(i32.const 40)', '(local.set $i (local.get $n))'),
  }
  for (const [label, fn] of Object.entries(kept)) {
    const wat = `(module ${fn})`, { made, exports } = passes(wat)
    is(made, 0, label)
    for (const n of [0, 3, 20]) is(exports.f(n), plain(wat).f(n), `${label}: f(${n})`)
  }
  const set = `(module ${NEST('(local.get $j)', '(i32.const 40)', '(local.set $i (i32.const 2))')})`
  is(passes(set).made, 1, 'a count set to a constant before the loop moves')
  for (const n of [0, 3, 20]) is(passes(set).exports.f(n), plain(set).f(n), `set: f(${n})`)
})

test('loop passes: a function called once from one that runs once gives its pass; one called in a loop, or the runtime\'s, keeps it', () => {
  const callee = (name) => NEST('(local.get $j)').replace('$f (export "f")', name)
  const once = `(module ${callee('$k')} (func $f (export "f") (param $n i32) (result i32) (call $k (local.get $n))))`
  const looped = `(module ${callee('$k')} (func $f (export "f") (param $n i32) (result i32) (local $s i32) (local $r i32)
    (block $b (loop $l (br_if $b (i32.ge_s (local.get $r) (i32.const 3)))
      (local.set $s (i32.add (local.get $s) (call $k (local.get $n))))
      (local.set $r (i32.add (local.get $r) (i32.const 1))) (br $l)))
    (local.get $s)))`
  const runtime = `(module ${NEST('(local.get $j)').replace('$f (export "f")', '$__walk (export "f")')})`
  const r1 = passes(once), r2 = passes(looped), r3 = passes(runtime)
  is(r1.made, 1, 'called once: moved')
  is(r2.made, 0, 'called in a loop: kept')
  is(r3.made, 0, 'the runtime\'s export: kept')
  for (const n of [0, 3, 12]) { is(r1.exports.f(n), plain(once).f(n), `once f(${n})`); is(r2.exports.f(n), plain(looped).f(n), `looped f(${n})`) }
})

test('loop passes: a pass that branches out of itself, or that compacts, stays', () => {
  const out = `(module ${NEST('(local.get $j)').replace('(local.set $j (i32.add (local.get $j) (i32.const 1)))', '(br_if $done (i32.gt_s (local.get $acc) (i32.const 1000))) (local.set $j (i32.add (local.get $j) (i32.const 1)))')})`
  const { made, exports } = passes(out)
  // the inner block is the only window holding the loop, and it branches to $done
  is(made, 0, 'a branch out keeps the pass')
  for (const n of [0, 5, 60]) is(exports.f(n), plain(out).f(n), `f(${n})`)
  const gc = `(module (func $__gc_begin (param i32) (result i32) (local.get 0)) ${NEST('(call $__gc_begin (local.get $j))')})`
  is(passes(gc).made, 0, 'a compaction keeps the pass')
})

const NEST_SRC = (rounds = 12) => `export let main = (n) => {
  const xs = new Float64Array(64)
  for (let i = 0; i < 64; i++) xs[i] = (i * 7) % 13 - 6
  let total = 0
  for (let r = 0; r < ${rounds}; r++) {
    let s = 0
    for (let i = 0; i < 64; i++) s += xs[i] * (r + n)
    total += s
  }
  return total
}
`

test('loop passes: the speed tier moves a driver\'s rounds and answers as the source does', () => {
  for (const rounds of [12, 'n']) {
    const src = NEST_SRC(rounds), native = oracle(src).main
    const main = jz(src, { optimize: { level: 'speed' } }).exports.main
    for (const n of [0, 1, 5, 40]) is(main(n), native(n), `${rounds} rounds: main(${n})`)
  }
  if (onKernel()) return
  ok(/\(func \$main\$s\d+/.test(compile(NEST_SRC(), { optimize: { level: 'speed' }, wat: true })), 'the rounds\' pass is a function')
  ok(!/\(func \$main\$s\d+/.test(compile(NEST_SRC('n'), { optimize: { level: 'speed' }, wat: true })), 'rounds a runtime value counts stay')
  for (const level of [2, 'size'])
    ok(!/\(func \$main\$s\d+/.test(compile(NEST_SRC(), { optimize: { level }, wat: true })), `${level} keeps it`)
})

// A void export crosses through its boundary wrapper (`$main$exp`, compile/boundary-wrap.js),
// which the body it calls once is inlined into: the wrapper is the function that runs once.
const VOID_SRC = `const out = new Float64Array(12)
export let main = (n) => {
  const xs = new Float64Array(64)
  for (let i = 0; i < 64; i++) xs[i] = (i * 7) % 13 - 6
  for (let r = 0; r < 12; r++) {
    let s = 0
    for (let i = 0; i < 64; i++) s += xs[i] * (r + n)
    out[r] = s
  }
}
export let read = (r) => out[r]
`

test('loop passes: a void export\'s rounds move out of its boundary wrapper', () => {
  const native = oracle(VOID_SRC), { exports } = jz(VOID_SRC, { optimize: { level: 'speed' } })
  for (const n of [0, 3, 40]) {
    is(exports.main(n), native.main(n), `main(${n}) returns undefined`)
    for (const r of [0, 5, 11]) is(exports.read(r), native.read(r), `n=${n}: read(${r})`)
  }
  if (onKernel()) return
  ok(/\(func \$main\$exp\$s\d+/.test(compile(VOID_SRC, { optimize: { level: 'speed' }, wat: true })), 'the rounds\' pass is a function')
})
