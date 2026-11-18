/**
 * Loop-invariant code motion, address and load CSE, and the length hoist:
 *   - LICM call-soundness:   loop body containing a call must NOT hoist cell reads
 *     (the call could mutate the cell via another closure that captures it).
 *   - LICM shared-IR:        watr slice pattern — a captured `idx` read appears
 *     in slice-length setup AND inside the slice copy loop. Earlier passes
 *     can share the IR subtree; mutating it inside the loop must not affect
 *     the outside reference.
 */
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { onKernel, levels, ownedLevels } from './_matrix.js'
import { solveEffects } from '../src/optimize/index.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { hoistInvariantLoop } from '../src/optimize/licm.js'
import { numberValues, SUBSCRIPT, TAG } from '../src/optimize/numbering.js'
import { run, oracle, jz, compile, funcWat } from './util.js'
import { parse, loopCount, count, walk } from '../scripts/wat-probe.mjs'
import { findFunc, preWatr, callsInLoop } from './_optimizer.js'

const hoistAddrBase = (fn) => numberValues(fn, SUBSCRIPT), hoistPtrType = (fn) => numberValues(fn, TAG)

// Count the operation on the executed path: mutually exclusive loop copies
// may each contain a hoisted instruction, but a call must not execute both.
const operationCounter = (tree, op, operation) => {
  walk(tree, n => { if (n[0] === op) { n[0] = 'call'; n.splice(1, 0, '$operationProbe') } })
  tree.splice(1, 0, ['import', '"probe"', '"operation"', ['func', '$operationProbe', ['param', 'f64', 'f64'], ['result', 'f64']]])
  let calls = 0
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(tree)), { probe: { operation: (a, b) => { calls++; return operation(a, b) } } })
  return (name, ...args) => { calls = 0; const value = exports[name](...args); return { calls, value } }
}


test('LICM array presence: module constants, defaults and shadowing stay distinct', () => {
  const src = `const values = [2, 3, 5, 7]
    export function sum(n, a = values) {
      let s = 0
      for (let i = 0; i < n; i++) s += a[i & 3]
      return s
    }
    function shadow(values, n) {
      let s = 0
      for (let i = 0; i < n; i++) s += values[i & 3]
      return s
    }
    export function nullable(n, absent) { return shadow(absent ? null : [1, 4, 9, 16], n) }
    export function local(n) {
      const values = n < 0 ? null : [11, 13, 17, 19]
      let s = 0
      for (let i = 0; i < n; i++) s += values[i & 3]
      return s
    }
    export function change(v) { values[0] = v }
    export function direct(n) {
      let s = 0
      for (let i = 0; i < n; i++) s += values[i & 3]
      return s
    }`
  for (const optimize of levels(0, 1, 2, 3)) {
    const f = jz(src, { optimize }).exports
    is(f.direct(4), 17)
    is(f.sum(4), 17, 'default reads the module array')
    is(f.nullable(0, 1), 0, 'a shadowed nullable receiver is not read before an empty loop')
    throws(() => f.nullable(1, 1))
    is(f.nullable(4, 0), 30)
    is(f.local(-1), 0)
    is(f.local(4), 60)
    f.change(23)
    is(f.direct(4), 38, 'const bindings still permit element writes')
    is(f.sum(4), 38)
  }
})

test('address CSE: exits and sibling writes end the dominating region', () => {
  for (const [pass, site] of [
    [hoistAddrBase, '(i32.add (local.get $x) (i32.shl (local.get $i) (i32.const 3)))'],
    [hoistAddrBase, '(i32.add (local.get $x) (local.get $i))'],
    [hoistPtrType, '(call $__ptr_type (local.get $x))'],
  ]) {
    for (const body of [
      `(block $out (br_if $out (local.get $skip)) (drop ${site})) ${site}`,
      `(block $out (try_table (catch_all $out) (if (local.get $skip) (then (throw $err))) (drop ${site}))) ${site}`,
      `(drop ${site}) (if (local.get $skip) (then (local.set $x (i32.const 7)))
        (else (drop ${site}) (local.set $x (i32.const 9)) (drop ${site}))) ${site}`,
    ]) {
      const ast = parseWat(`(module (tag $err)
        (func $__ptr_type (param $x i32) (result i32) (local.get $x))
        (func $f (export "f") (param $x i32) (param $i i32) (param $skip i32) (result i32) ${body}))`)
      const instantiate = () => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports.f
      const before = instantiate()
      pass(findFunc(ast, '$f'))
      const after = instantiate()
      for (const skip of [1, 1, 0, 1, 0]) is(after(13, 2, skip), before(13, 2, skip))
    }
  }
})


test('address and tag CSE: branch exits and exception handlers cannot reuse skipped initializers', () => {
  if (onKernel()) return
  for (const [pass, expr] of [
    [hoistAddrBase, '(i32.load (i32.add (local.get $base) (i32.shl (local.get $index) (i32.const 3))))'],
    [hoistAddrBase, '(i32.load8_u (i32.add (local.get $base) (local.get $index)))'],
    [hoistPtrType, '(call $__ptr_type (local.get $ptr))'],
  ]) {
    const drop = `(drop ${expr})`
    for (const body of [
      `${drop} ${expr}`,
      `(block ${drop}) ${expr}`,
      `(block $exit (br_if $exit (local.get $skip)) ${drop}) ${expr}`,
      `(block $exit (try_table (catch $error $exit)
        (if (local.get $skip) (then (throw $error))) ${drop})) ${expr}`,
      `(block $exit (loop $again (br_if $exit (local.get $skip)) ${drop})) ${expr}`,
    ]) {
      const source = `(module (memory 1) (data (i32.const 88) "%") (data (i32.const 67) "+") (tag $error)
        (func $__ptr_type (param $ptr i64) (result i32) (i32.wrap_i64 (local.get $ptr)))
        (func $f (export "f") (param $skip i32) (param $base i32) (param $index i32) (param $ptr i64) (result i32)
          ${body}))`
      const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(parseWat(source)))).exports.f
      const tree = parseWat(source), fn = findFunc(tree, '$f')
      walk(fn, n => { if (n[0] === 'i32.const') n[1] = Number(n[1]) }) // JZ's emitted IR uses numeric constants.
      pass(fn)
      const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(tree))).exports.f
      for (const skip of [0, 1, 1, 0]) {
        is(after(skip, 64, 3, 37n), before(skip, 64, 3, 37n), 'normal → bypass → bypass → normal preserves the computed value')
        is(after(skip, 0, 0, 0n), 0, 'zero-valued inputs stay zero')
      }
      if (body === `${drop} ${expr}` || body === `(block ${drop}) ${expr}`)
        ok(JSON.stringify(fn).includes('local.tee'), 'straight-line reuse remains enabled across blocks without exits')
    }
  }
})

test('LICM effects: every memory writer blocks mutable helper reads', () => {
  const writers = [
    '(i32.store8 (i32.const 0) (i32.const 1))',
    '(i32.store16 (i32.const 0) (i32.const 1))',
    '(i32.store offset=0 (i32.const 0) (i32.const 1))',
    '(i64.store (i32.const 0) (i64.const 1))',
    '(i64.store8 (i32.const 0) (i64.const 1))',
    '(i64.store16 (i32.const 0) (i64.const 1))',
    '(i64.store32 (i32.const 0) (i64.const 1))',
    '(f32.store (i32.const 0) (f32.reinterpret_i32 (i32.const 1)))',
    '(f64.store (i32.const 0) (f64.reinterpret_i64 (i64.const 1)))',
    '(v128.store (i32.const 0) (v128.const i32x4 1 0 0 0))',
    '(memory.fill (i32.const 0) (i32.const 1) (i32.const 1))',
    '(memory.copy (i32.const 0) (i32.const 8) (i32.const 1))',
    '(memory.init $bytes (i32.const 0) (i32.const 0) (i32.const 1))',
    '(i32.atomic.store8 (i32.const 0) (i32.const 1))',
    '(drop (i32.atomic.rmw8.add_u (i32.const 0) (i32.const 1)))',
  ]
  for (const writer of writers) {
    const ast = parseWat(`(module (memory 1 1 shared) (data (i32.const 8) "\\01") (data $bytes "\\01")
      (func $__typed_idx (param f64) (param i32) (result f64)
        (f64.convert_i32_u (i32.load8_u (i32.const 0))))
      (func $f (export "f") (param $n i32) (result f64) (local $i i32) (local $sum f64)
        (block $exit (loop $loop
          (br_if $exit (i32.ge_u (local.get $i) (local.get $n)))
          ${writer}
          (local.set $sum (f64.add (local.get $sum) (call $__typed_idx (f64.const 0) (i32.const 0))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $loop)))
        (local.get $sum)))`)
    const run = () => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports.f
    const before = run()
    hoistInvariantLoop(findFunc(ast, '$f'))
    const after = run()
    for (const n of [0, 1, 2]) is(after(n), before(n), writer + ': n=' + n)
  }
})

test('LICM effects: an unknown store target blocks a distinct-base load', () => {
  const ast = parseWat(`(module (memory 1)
    (func $f (export "f") (param $src i32) (result i32) (local $i i32) (local $sum i32)
      (loop $loop
        (i32.store8 (i32.const 0) (i32.const 1))
        (local.set $sum (i32.add (local.get $sum) (i32.load (local.get $src))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br_if $loop (i32.lt_u (local.get $i) (i32.const 2))))
      (local.get $sum)))`)
  const fn = findFunc(ast, '$f')
  fn.distinctParams = new Set(['$src'])
  hoistInvariantLoop(fn)
  const { f } = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports
  is(f(0), 2, 'a disjoint-parameter proof says nothing about a constant store address')
})

test('LICM effects: a store through a local with multiple origins may alias either buffer', () => {
  for (const [other, read, yes, no] of [['(local.get $dst)', '$src', 2, 0], ['(i32.const 32)', '$dst', 0, 2]]) {
    const ast = parseWat(`(module (memory 1)
      (func $f (export "f") (param $src i32) (param $dst i32) (param $choose i32) (result i32)
        (local $p i32) (local $i i32) (local $sum i32)
        (loop $loop
          (if (local.get $choose)
            (then (local.set $p (local.get $src)))
            (else (local.set $p ${other})))
          (i32.store8 (local.get $p) (i32.const 1))
          (local.set $sum (i32.add (local.get $sum) (i32.load (local.get ${read}))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $loop (i32.lt_u (local.get $i) (i32.const 2))))
        (local.get $sum)))`)
    const fn = findFunc(ast, '$f')
    fn.distinctParams = new Set(['$src', '$dst'])
    hoistInvariantLoop(fn)
    const bytes = encodeWat(ast)
    const run = choose => new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.f(0, 32, choose)
    is(run(1), yes)
    is(run(0), no)
  }
})

test('LICM effects: a local observed after a zero-trip loop must retain its value', () => {
  const ast = parseWat(`(module
    (func $f (export "f") (param $n i32) (param $x f64) (result i32) (local $t i32)
      (block $exit (loop $L
        (br_if $exit (i32.eqz (local.get $n)))
        (drop (local.tee $t (i32.trunc_sat_f64_s (local.get $x))))
        (br $exit)))
      (local.get $t)))`)
  hoistInvariantLoop(findFunc(ast, '$f'))
  const { f } = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports
  is(f(0, 7), 0)
  is(f(1, 7), 7)
})

test('LICM effects: string indexing may allocate and must not run on a zero-trip loop', () => {
  const ast = parseWat(`(module
    ;; Model __char_unit's exhausted allocator for a non-ASCII UTF-16 unit.
    (func $__str_idx (param i64) (param i32) (result f64) (unreachable))
    (func $f (export "f") (param $n i32) (result f64) (local $i i32) (local $sum f64)
      (block $exit (loop $loop
        (br_if $exit (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $sum (f64.add (local.get $sum) (call $__str_idx (i64.const 0) (i32.const 0))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
      (local.get $sum)))`)
  hoistInvariantLoop(findFunc(ast, '$f'))
  const { f } = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports
  is(f(0), 0, 'the allocator is never entered')
  throws(() => f(1), 'an executed allocation still traps')
})

test('LICM effects: non-mutating allocation still changes allocator globals', () => {
  const ast = parseWat(`(module (global $__heap (mut i32) (i32.const 0))
    (func $__str_concat (param f64) (param f64) (result f64)
      (global.set $__heap (i32.add (global.get $__heap) (i32.const 1)))
      (f64.const 0))
    (func $f (export "f") (result i32) (local $i i32) (local $sum i32)
      (loop $loop
        (drop (call $__str_concat (f64.const 0) (f64.const 0)))
        (local.set $sum (i32.add (local.get $sum)
          (i32.trunc_sat_f64_s (f64.convert_i32_s (global.get $__heap)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br_if $loop (i32.lt_u (local.get $i) (i32.const 2))))
      (local.get $sum)))`)
  hoistInvariantLoop(findFunc(ast, '$f'), { effects: solveEffects(ast.filter(n => Array.isArray(n) && n[0] === 'func')) })
  const { f } = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports
  is(f(), 3, 'the global is read after each allocation')
})

test('LICM pure calls: invariant transcendental / substr search hoist out of the loop', () => {
  // V8's wasm tier treats every call as opaque and recomputes it each iteration; jz proves math
  // + immutable-string search/compare are pure functions of their args and lifts the invariant
  // ones to the pre-header.
  const log = `export const f = (x, n) => { let a = 0.0; for (let r = 0; r < n; r = r + 1) a = a + Math.log(x + 3.0); return a }`
  is(callsInLoop(log, '$math.log'), 0, 'invariant Math.log is hoisted out of the loop')

  const idx = `export const f = (s, n) => { const h = s + "_TARGET_pad_pad"; let a = 0.0; for (let r = 0; r < n; r = r + 1) a = a + h.indexOf("TARGET"); return a | 0 }`
  is(callsInLoop(idx, '$__str_indexof'), 0, 'invariant indexOf (string receiver) is hoisted out of the loop')

  const eq = `export const f = (s, n) => { const h = s + "_pad_pad_pad"; let a = 0.0; for (let r = 0; r < n; r = r + 1) a = a + (h === "q_pad_pad_pad" ? 1 : 0); return a | 0 }`
  is(callsInLoop(eq, '$__str_eq'), 0, 'invariant === is hoisted out of the loop')
})

test('LICM pure calls: a VARYING arg keeps the call IN the loop (soundness)', () => {
  // The hoist is gated on every arg being loop-invariant. A per-iteration `from` / needle / arg
  // must NOT be lifted — else the result would be wrong. (pureGiven returns false on the variant.)
  const varFrom = `export const f = (s, n) => { const h = s + "_a_a_a_a_a_a"; let a = 0.0; for (let r = 0; r < n; r = r + 1) a = a + h.indexOf("a", r % 4); return a | 0 }`
  ok(callsInLoop(varFrom, '$__str_indexof') >= 1, 'indexOf with a per-iteration `from` stays in the loop')

  const varArg = `export const f = (x, n) => { let a = 0.0; for (let r = 0; r < n; r = r + 1) a = a + Math.log(x + r); return a }`
  ok(callsInLoop(varArg, '$math.log') >= 1, 'Math.log of a per-iteration arg stays in the loop')

  // Same answer with LICM on and off, for invariant AND varying — no miscompile from the hoist.
  for (const src of [
    `export const f = (s, n) => { const h = s + "_TT_pad_pad"; let a = 0.0; for (let r = 0; r < n; r = r + 1) { if (r > 3) a = a + h.indexOf("TT") } return a | 0 }`,
    varFrom, varArg,
  ]) {
    const on = jz(src).exports.f, off = jz(src, { optimize: { hoistInvariantLoop: false } }).exports.f
    for (const args of [['q', 0], ['q', 1], ['q', 25]]) is(on(...args), off(...args), `LICM on===off ${JSON.stringify(args)}`)
  }
})

test('LICM (watr): speed tier hoists post-inline invariants via watr licm', () => {
  if (onKernel()) return  // kernel bundles its own watr at build time — host-codegen assertion only
  // The raytrace shape: the invariant only EXISTS after watr's inlineOnce splices the helper
  // body into the loop — jz's pre-watr LICM can't see it (a user call isn't hoistable), so
  // the hoist must come from watr's own licm pass, enabled by cfg.watrLicm at speed.
  const src = `
    const g = (x, y) => Math.max(x, y) * 3.0 + 1.0
    export let f = (k, n) => { let s = 0.0; for (let i = 0; i < n; i++) s = s + g(k, 2.5) + i; return s }`
  const fn = findFunc(parse(src, 'speed'), '$f')
  ok(count(fn, n => n[0] === 'f64.max') > 0, 'the invariant remains in the function')
  is(loopCount(fn, n => n[0] === 'f64.max'), 0, 'its computation is outside every loop copy, regardless of local reuse')
  const probe = operationCounter(parse(src, 'speed'), 'f64.max', Math.max)
  for (const n of [4, 4, 0, 3.5, -Infinity, NaN, 4])
    ok(probe('f', 9, n).calls <= 1, `only the selected path computes the invariant for n=${n}`)
  // Bit-exact: licm on === off across invariant-max branches and the zero-trip loop.
  const on = jz(src, { optimize: 'speed' }).exports.f
  const off = jz(src, { optimize: { level: 'speed', watrLicm: false } }).exports.f
  for (const args of [[1.0, 4], [9.0, 4], [2.5, 3], [1.0, 0]]) is(on(...args), off(...args), `watr licm on===off ${JSON.stringify(args)}`)
})

test('LICM: an invariant subexpression leaves every loop, at any position of a larger one', () => {
  // A product in the middle and at the end of a strict sum, an integer product, and a product
  // invariant to both loops of a nest: jz's own hoist takes each out of the outermost loop (V8
  // hoists none of them itself: optimize/licm.js, the measurement above HARD_OPS). Moving one
  // product reorders no sum, so the levels at JavaScript's float results take it too.
  const get = (n, name) => Array.isArray(n) && n[0] === 'local.get' && n[1] === name
  const product = (x, y) => n => n[0] === 'f64.mul' && get(n[1], x) && get(n[2], y)
  const kernels = [
    ['a product in the middle and at the end of a sum', `export let f = (a, b, c, n) => { let s = 0; for (let i = 0; i < n; i++) s = s * 0.5 + a * b + i - b * c; return s }`,
      n => product('$a', '$b')(n) || product('$b', '$c')(n), [[1.5, 2.5, -3, 4], [-0, 3, 1e308, 2], [2, 3, 4, 0]]],
    ['an integer product', `export let f = (a, b, n) => { const p = a | 0, q = b | 0; let t = 0; for (let i = 0; i < n; i++) t = (t ^ (Math.imul(p, q) + i)) | 0; return t }`,
      n => n[0] === 'i32.mul', [[65537, 65539, 5], [-7, 3, 2], [7, 3, 0]]],
    ['a product invariant to a nest', `export let f = (a, b, m, n) => { let s = 0; for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) s = s * 0.5 + a * b + i * j; return s }`,
      product('$a', '$b'), [[1.5, 2.5, 3, 4], [1.5, 2.5, 0, 4], [-0, 1, 2, 2]]],
  ]
  for (const [what, src, pred, args] of kernels) {
    const want = oracle(src).f
    for (const optimize of ownedLevels(2, { level: 'speed', relaxedFloat: false })) {
      is(loopCount(findFunc(parse(src, preWatr(optimize)), '$f'), pred), 0, `${what}: out of every loop at ${JSON.stringify(optimize)}`)
      const f = jz(src, { optimize }).exports.f
      for (const a of args) ok(Object.is(f(...a), want(...a)), `${what} (${a}) at ${JSON.stringify(optimize)}`)
    }
  }
  // What may trap stays: an invariant division in a loop that may run no round, beside a product
  // that moves. What saves nothing stays too: a comparison of plain operands, which its branch
  // tests where it stands; an address with its identity, `x + (0 << 2)`, which folds to `x`; the
  // bits of a float, a view of its register.
  const ast = parseWat(`(module (memory 1) (func $f (export "f") (param $n i32) (param $x i32) (param $y i32) (param $z f64) (result i32)
    (local $i i32) (local $out i32)
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $out (i32.add (local.get $out) (i32.add (i32.div_s (local.get $x) (local.get $y)) (i32.mul (local.get $x) (local.get $y)))))
      (if (i32.eq (local.get $x) (i32.const 7)) (then (local.set $out (i32.add (local.get $out) (i32.const 1)))))
      (local.set $out (i32.add (local.get $out) (i32.load (i32.add (local.get $x) (i32.shl (i32.const 0) (i32.const 2))))))
      (local.set $out (i32.xor (local.get $out) (i32.wrap_i64 (i64.reinterpret_f64 (local.get $z)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (local.get $out)))`), fn = findFunc(ast, '$f')
  hoistInvariantLoop(fn, {}, true)
  is(['i32.mul', 'i32.div_s', 'i32.eq', 'i32.shl', 'i64.reinterpret_f64'].map(op => loopCount(fn, n => n[0] === op)), [0, 1, 1, 1, 1],
    'the product moves; the division, the test, the address and the bits stay')
  const f = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports.f
  is([f(0, 7, 0, 0), f(0, -2147483648, -1, 0), f(3, 7, 2, 0), f(2, 5, 1, 0)], [0, 0, 54, 20], 'a loop that runs no round divides by nothing')
})

test('LSR (watr): speed tier advances record and summed-index addresses as pointers', () => {
  if (onKernel()) return  // kernel bundles its own watr at build time: host-codegen assertion only
  // An address affine in the loop counter (a record at rows[i], `src[row + x + 1]`) becomes a
  // pointer set before the loop and advanced with the counter: watr's lsr, enabled by
  // cfg.watrLsr at speed.
  const rec = `export let f = (n) => {
    const rows = []
    for (let i = 0; i < n; i++) rows.push({ a: i, b: i * 2, c: (i * 3) | 0 })
    let s = 0
    for (let k = 0; k < 4; k++) for (let i = 0; i < rows.length; i++) s = (s + rows[i].a + rows[i].c) | 0
    return s
  }`
  const rows = `export let f = (w, h) => {
    const src = new Int32Array(w * h), dst = new Int32Array(w * h)
    for (let i = 0; i < w * h; i++) src[i] = (i * 2654435761) >> 7
    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let x = 0; x < w - 2; x++) dst[row + x] = (src[row + x] ^ src[row + x + 1] ^ src[row + x + 2]) | 0
    }
    let s = 0
    for (let i = 0; i < w * h; i++) s = (s * 31 + dst[i]) | 0
    return s
  }`
  // the body is the export's own function, or inlined into its boundary wrapper, the passes of
  // its few-pass loop in functions of their own (split-funcs.js loopPasses)
  const body = tree => {
    const out = ['func']
    const w = n => { if (!Array.isArray(n)) return; if (n[0] === 'func' && /^\$f(\$exp)?(\$s\d+)?$/.test(n[1])) { out.push(n); return } for (const c of n) w(c) }
    w(tree)
    return out
  }
  const pointers = fn => count(fn, n => n[0] === 'local' && /^\$__lsr\d/.test(n[1]))
  const recFn = body(parse(rec, 'speed'))
  ok(pointers(recFn) > 0, 'the record loop reads through a pointer')
  is(loopCount(recFn, n => n[0] === 'i32.mul' && n[2]?.[0] === 'i32.const' && +n[2][1] === 24), 0, 'no record-stride multiply in a loop')
  ok(pointers(body(parse(rows, 'speed'))) > 0, 'the row stencil reads through pointers')
  is(pointers(body(parse(rec, { level: 'speed', watrLsr: false }))), 0, 'watrLsr: false keeps the indices')
  for (const [src, calls] of [[rec, [[100], [1], [0], [37]]], [rows, [[37, 9], [5, 3], [128, 64], [3, 1]]]]) {
    const on = jz(src, { optimize: 'speed' }).exports.f
    const off = jz(src, { optimize: { level: 'speed', watrLsr: false } }).exports.f
    for (const args of calls) is(on(...args), off(...args), `lsr on===off ${JSON.stringify(args)}`)
  }
})

test('LICM: checked-access length HEADER decode hoists once per function (neverGrown/TYPED pointer)', () => {
  // sdf's edt1d (bench/sdf/sdf.js): a data-dependent hull cursor `k` indexes typed-array
  // params `v`/`z` inside a while-pop nested in a for-loop — an UNPROVEN index (k isn't a
  // canonical monotone `i<arr.length` counter), so every read takes the checked-access
  // branchless form, whose length guard decodes the header fresh EVERY site:
  // `i32.shr_u(i32.load(i32.sub(ptr, 8)), shift)`. `v`/`z` are TYPED-array params (fixed-size
  // allocations — module/typedarray.js's typedBase: "no grow op, so it can never relocate")
  // never reassigned in the body, so the DECODED LENGTH is loop-invariant — but was re-fetched
  // from memory at every guard site regardless (ledger 'SDF GAP DISSECTED WITH SHARES
  // 2026-07-25'). hoistInvariantLoop now admits this load (compile/index.js stamps
  // `fn.stableHeaderNames` from VAL.TYPED / ARRAY-neverGrown reps; optimize/index.js's
  // pureGiven recognizes `i32.load(i32.sub(local.get $X, i32.const 8))` for $X in that set as
  // invariant with NO alias-analysis needed — the header word can never change once the
  // receiver is allocated) — cascading bottom-up through the nested while and the outer for
  // collapses every site to ONE decode, shared by both loops.
  const src = `
    const scan = (v, z, n) => {
      let k = 0
      let s = 0.0
      for (let q = 1; q < n; q++) {
        while (k > 0 && z[k] > 1.5) { k = k - 1 }
        s = s + v[k]
        k = k + 1
      }
      return s
    }
    export const f = (n) => {
      const v = new Int32Array(n)
      const z = new Float64Array(n)
      for (let i = 0; i < n; i++) { v[i] = i + 1; z[i] = i % 2 === 0 ? 0.0 : 3.0 }
      return scan(v, z, n)
    }`
  const isHeaderDecode = (n) => Array.isArray(n) && n[0] === 'i32.load' && Array.isArray(n[1]) && n[1][0] === 'i32.sub' &&
    Array.isArray(n[1][1]) && n[1][1][0] === 'local.get' &&
    Array.isArray(n[1][2]) && n[1][2][0] === 'i32.const' && Number(n[1][2][1]) === 8

  // pre-watr: `f` releases what it made as it returns, so its call of `scan` is one watr inlines
  // (a specialized copy of a loop computes its own values ahead of itself,
  // beside the loop as written: the count is the hoist's, with the copies off)
  const fnOn = findFunc(parse(src, preWatr({ level: 'speed', specializeLoops: false, versionIntegralLoops: false })), '$scan')
  is(loopCount(findFunc(parse(src, preWatr('speed')), '$scan'), isHeaderDecode), 0, 'no decode inside a loop, specialized or not')
  ok(fnOn, 'the JZ pass is inspected before backend inlining')
  is(loopCount(fnOn, isHeaderDecode), 0, 'length header decode fully hoisted out of both loops')
  ok(count(fnOn, isHeaderDecode) <= 2, 'at most one decode per array (v, z) survives, at function scope')

  const fnOff = findFunc(parse(src, preWatr({ level: 'speed', hoistInvariantLoop: false })), '$scan')
  ok(fnOff, 'the control retains the same function')
  ok(loopCount(fnOff, isHeaderDecode) >= 1, 'sanity: without hoistInvariantLoop the decode DOES recur in-loop')

  // Bit-exact vs a plain-JS reference across the hull cursor's edge cases (n=0/1, cursor
  // oscillation, cursor growth) — the hoist must not change which value each guard reads.
  const ref = (n) => {
    const v = new Int32Array(n), z = new Float64Array(n)
    for (let i = 0; i < n; i++) { v[i] = i + 1; z[i] = i % 2 === 0 ? 0.0 : 3.0 }
    let k = 0, s = 0.0
    for (let q = 1; q < n; q++) {
      while (k > 0 && z[k] > 1.5) k--
      s += v[k]
      k++
    }
    return s
  }
  const on = jz(src, { optimize: 'speed' }).exports.f
  const off = jz(src, { optimize: { level: 'speed', hoistInvariantLoop: false } }).exports.f
  for (const n of [0, 1, 2, 3, 5, 8, 17, 30, 64, 100]) {
    const r = ref(n)
    is(on(n), r, `n=${n}: hoisted result matches reference`)
    is(off(n), r, `n=${n}: un-hoisted result matches reference (LICM changes nothing semantic)`)
  }
})

test('LICM: call inside loop must not hoist cell reads (mutated via closure)', () => {
  const { main } = run(`
    export const main = () => {
      let i = 0
      const inc = () => { i = i + 1; return 0 }
      let s = 0
      for (let j = 0; j < 10; j++) {
        s = s + i + i
        inc()
      }
      return s | 0
    }
  `)
  // j=0: s=0+0+0=0, then i=1
  // j=1: s=0+1+1=2, then i=2
  // ... s = 2*(0+1+...+9) = 90
  is(main(), 90)
})

test('LICM: shared IR subtree (slice + slice-loop pattern) must not corrupt outside read', () => {
  // Mirrors watr/compile.js shape: idx is captured (mutated elsewhere),
  // used both in slice-length calc AND inside the slice copy loop body.
  // Earlier passes share the IR for `cell_idx` reads — LICM must not
  // mutate the shared subtree.
  const { main } = run(`
    export const main = (a) => {
      let idx = 1
      const set = (v) => { idx = v; return 0 }
      const sub = a.slice(idx)
      let sum = 0
      for (let j = 0; j < sub.length; j++) sum = sum + sub[j]
      set(2)
      return sum | 0
    }
  `)
  // a = [10, 20, 30, 40] → slice(1) = [20,30,40], sum=90
  is(main([10, 20, 30, 40]), 90)
})

test('LICM: actually fires for invariant cell read in non-call loop', () => {
  // Sanity: when conditions are right (no calls, no shared IR, no writes),
  // LICM should hoist the cell load and emit a $__li snap local.
  // `inc` must *escape* (stored by `keep`) so it stays a real closure that
  // mutates the captured `i` via a heap cell — otherwise inlineLocalLambdas
  // would splice it away and `i` would just be a plain wasm local.
  // Inspect jz output without watr — `coalesceLocals` would rename `$__li<N>`.
  const wat = compile(`
    let sink
    const keep = (f) => (sink = f, f)
    export const main = () => {
      let i = 0
      const inc = keep(() => i = i + 1)
      let s = 0
      for (let j = 0; j < 10; j++) s = s + i + i
      inc()
      return s | 0
    }
  `, { wat: true, optimize: { watr: false, coalesceLocals: false } })
  ok(/\$__li\d+/.test(wat), 'expected hoisted snap local')
})

test('LICM: does not fire when loop contains calls', () => {
  const wat = compile(`
    export const main = () => {
      let i = 0
      const inc = () => { i = i + 1; return 0 }
      let s = 0
      for (let j = 0; j < 10; j++) { s = s + i + i; inc() }
      return s | 0
    }
  `, { wat: true })
  ok(!/\$__li\d+/.test(wat), 'must not hoist when loop contains a call')
})

test('LICM: self-referential tee induction in loop condition is not hoisted (rfft stage-loop regression)', () => {
  // `while ((nn = nn >>> 1))` — the loop's induction update is a self-referential
  // tee in the condition (nn = f(nn)). hoistInvariantLoop treated the operand's
  // `nn` read as the in-subtree teed value (it is actually the loop-carried previous
  // value, read before the tee writes) and hoisted the whole update to the pre-header,
  // freezing nn nonzero → a non-terminating loop and out-of-bounds stores. This is the
  // rfft split-radix stage loop (examples/rfft/rfft.js transform()). The `count > 1000`
  // guard bounds a regression to a wrong value instead of a hang.
  const src = `
    export const main = (n) => {
      let nn = n >>> 0, count = 0, acc = 0
      while ((nn = nn >>> 1)) { count++; acc += nn; if (count > 1000) break }
      return (count * 1000000 + acc) | 0
    }
  `
  const { main } = run(src)
  is(main(2048), 11 * 1000000 + 2047)  // 2^11: nn walks 1024…1 (11 iters), Σ = 2047
  is(main(64), 6 * 1000000 + 63)       // 2^6: nn walks 32…1 (6 iters), Σ = 63
  is(main(1), 0)                        // 1 >>> 1 = 0 → zero iterations
})

test('param-distinctness LICM: invariant load from a proven-distinct param hoists across a store', () => {
  // proc reads src[0]/src[1] (invariant) and writes dst[i]. Large (non-scalarizable) arrays + 3 call
  // sites keep proc a standalone function to inspect.
  const SRC = `
    const proc = (src, dst, n) => { for (let i = 0; i < n; i++) dst[i] = src[0] + src[1] * i + src[2] - src[3] }
    export const main = () => {
      const src = new Float64Array(256), dst = new Float64Array(256)
      for (let k = 0; k < 256; k++) src[k] = k + 0.5
      proc(src, dst, 256); proc(src, dst, 256); proc(src, dst, 256)
      return (dst[255] * 1000) | 0
    }
  `
  const wat = compile(SRC, { wat: true, optimize: { level: 'speed' } })
  let fn = funcWat(wat, 'proc')
  // fast arm only: the versioned checked twin keeps in-loop checked loads by design
  if (fn.includes('(else')) fn = fn.slice(0, fn.indexOf('(else'))
  const li = fn.indexOf('(loop')   // the dst-store loop
  is(/f64\.load/.test(fn.slice(li)), false, 'invariant src loads hoisted OUT of the loop (alias-distinct from dst)')
  ok(/f64\.load/.test(fn.slice(0, li)), 'the src loads moved to the pre-header')
  const ref = (() => { const src = [], dst = []; for (let k = 0; k < 256; k++) src[k] = k + 0.5
    const p = (s, d, n) => { for (let i = 0; i < n; i++) d[i] = s[0] + s[1] * i + s[2] - s[3] }
    p(src, dst, 256); p(src, dst, 256); p(src, dst, 256); return (dst[255] * 1000) | 0 })()
  is(jz(SRC, { optimize: { level: 'speed' } }).exports.main(), ref, 'distinct-param result bit-exact vs JS')
})

test('param-distinctness LICM: SOUND — same array passed for two params is NOT hoisted (aliasing)', () => {
  // f reads a[0] and writes b[i]. If the caller passes the SAME array for a and b, the store
  // clobbers a[0] mid-loop, so the load must NOT be hoisted. analyzeParamDistinctness must refuse
  // to mark a,b distinct here (the same arg appears twice), so the load stays in the loop. A wrong
  // hoist would compute n*a[0]_initial instead of the clobbered running value — this pins it.
  const SRC = `
    const f = (a, b, n) => { let s = 0.0; for (let i = 0; i < n; i++) { s = s + a[0]; b[i] = 7.0 } return s }
    export const main = () => { const arr = new Float64Array(8); arr[0] = 3.0; return (f(arr, arr, 8) + f(arr, arr, 8)) | 0 }
  `
  const ref = (() => { const arr = []; arr[0] = 3.0; const f = (a, b, n) => { let s = 0.0; for (let i = 0; i < n; i++) { s = s + a[0]; b[i] = 7.0 } return s }; return (f(arr, arr, 8) + f(arr, arr, 8)) | 0 })()
  is(jz(SRC).exports.main(), ref, 'aliasing result correct at default tier (a[0] clobbered by b[0])')
  is(jz(SRC, { optimize: { level: 'speed' } }).exports.main(), ref, 'aliasing result correct at speed tier (load NOT wrongly hoisted)')
})

test('param-distinctness: a function returning what it allocates hands each call a buffer of its own', () => {
  // src and dst come from calls of a maker, each allocating; the src loads of proc hoist across the
  // dst store as they do for two `new` locals.
  const SRC = (mk) => `
    ${mk}
    const proc = (src, dst, n) => { for (let i = 0; i < n; i++) dst[i] = src[0] + src[1] * i + src[2] - src[3] }
    export const main = () => {
      const src = mk(256), dst = mk(256)
      for (let k = 0; k < 256; k++) src[k] = k + 0.5
      proc(src, dst, 256); proc(src, dst, 256); proc(src, dst, 256)
      return (dst[255] * 1000) | 0
    }`
  const hoisted = (src) => {
    const wat = compile(src, { wat: true, optimize: 'speed' })
    let fn = funcWat(wat, 'proc')
    if (fn.includes('(else')) fn = fn.slice(0, fn.indexOf('(else'))
    return !/f64\.load/.test(fn.slice(fn.indexOf('(loop')))
  }
  for (const [mk, fresh] of [
    ['const mk = (n) => { const a = new Float64Array(n); return a }', true],
    ['const mk = (n) => new Float64Array(n)', true],
    ['const make = (n) => new Float64Array(n)\n    const mk = (n) => { const a = make(n); return a }', true],
    ['let cache = null\n    const mk = (n) => { if (!cache) cache = new Float64Array(n); return cache }', false],
    ['const all = new Float64Array(256)\n    const mk = (n) => all', false],
  ]) {
    const src = SRC(mk)
    is(jz(src, { optimize: 'speed' }).exports.main(), oracle(src).main(), `${mk.split('\n').pop()}: JS's answer`)
    if (!onKernel()) is(hoisted(src), fresh, `${mk.split('\n').pop()}: src loads ${fresh ? 'leave' : 'stay in'} the loop`)
  }
})

test('address CSE: a constant index leaves its address to the accesses', () => {
  // an unrolled stage's index, a local written once with a constant, is no base worth a local:
  // the accesses take the constant once watr folds it, and the first stays where it is used
  const load = (off) => `(f64.load${off ? ` offset=${off}` : ''} (i32.add (local.get $c) (i32.shl (local.get $k) (i32.const 3))))`
  const src = (k) => `(module (memory (export "m") 1)
    (func $f (export "f") (param $c i32) (param $j i32) (result f64) (local $k i32)
      (local.set $k ${k})
      (f64.add (f64.add ${load(0)} ${load(8)}) ${load(16)})))`
  const exec = (tree) => {
    const m = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(tree)))
    const mem = new Float64Array(m.exports.m.buffer, 0, 64)
    for (let i = 0; i < 64; i++) mem[i] = i * 0.5 + 1
    return m.exports.f(64, 3)
  }
  const bases = (k) => {
    const tree = parseWat(src(k)), fn = findFunc(tree, '$f')
    walk(fn, n => { if (n[0] === 'i32.const') n[1] = Number(n[1]) })
    const before = exec(tree)
    hoistAddrBase(fn)
    is(exec(tree), before, `${k}: the same sum`)
    return fn.filter(n => Array.isArray(n) && n[0] === 'local' && /^\$__ab/.test(n[1])).length
  }
  is(bases('(i32.const 5)'), 0, 'a constant index hoists no base')
  is(bases('(local.get $j)'), 1, 'an index the function computes still shares its base')
})

test('for-bound snapshot: read-only builtin calls do not block the .length hoist', () => {
  // `callFree` used to disqualify ANY call in the loop body — a charCodeAt /
  // Math.imul body re-decoded the NaN-boxed string length every iteration (≈3×
  // slower on byte loops).
  const src = `export const main = (s) => {
    let h = 0x811c9dc5 | 0
    for (let i = 0; i < s.length; i++) {
      h = h ^ s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
  }`
  const wat = compile(src, { wat: true, optimize: { jsstring: false } })
  const fn = funcWat(wat, 'main')
  const loop = fn.slice(fn.indexOf('loop'))
  ok(loop.length > 0, 'main has a loop')
  ok(!loop.includes('16383'), 'length decode (SSO mask 16383) must be hoisted out of the loop')
  // behavior unchanged vs JS
  const js = (s) => { let h = 0x811c9dc5 | 0; for (let i = 0; i < s.length; i++) { h = h ^ s.charCodeAt(i); h = Math.imul(h, 0x01000193) } return h >>> 0 }
  const { main } = run(src, { optimize: { jsstring: false } })
  is(main('hello world'), js('hello world'))
})

test('for-bound snapshot: aliases, helper arguments and captured bindings remain live', () => {
  const sources = [
    `function change(tag,a,i,n){if(i===0)a.length=n}
     export function f(n){const a=[1,2];let count=0;
       for(let i=0;i<a.length;i++){change('x',a,i,n);count++}return count}`,
    `export function f(n){const a=[1,2],b=a;let count=0;
       for(let i=0;i<a.length;i++){if(i===0)b.length=n;count++}return count}`,
    `export function f(n){const a=[1,2];const change=()=>{a.length=n};let count=0;
       for(let i=0;i<a.length;i++){if(i===0)change();count++}return count}`,
    `export function f(n){let a=new Uint8Array(2);const change=()=>{a=new Uint8Array(n)};let count=0;
       for(let i=0;i<a.length;i++){if(i===0)change();count++}return count}`,
    `export function f(n){let a=new Uint8Array(2);let count=0;
       for(let i=0;i<a.length;i++,a=new Uint8Array(n)){count++}return count}`,
    `export function f(n){const a=[];let count=0;
       for(let i=0;i<a.length;i++){a.length=n;count++}return count}`,
  ]
  for (const src of sources) {
    const js = new Function(src.replace('export ', '') + ';return f')()
    for (const optimize of levels(0, 1, 2, 3, 'size')) {
      const { f } = jz(src, { optimize }).exports
      for (const n of [0, 0, 4, 1, 2]) is(f(n), js(n), `${optimize}: ${src}`)
    }
  }
})

test('for-bound snapshot: a mutating call in the body still re-reads the bound', () => {
  // push() grows the array mid-loop — JS re-reads the bound every iteration,
  // so the mutable length must remain live (2 elems + 1 pushed → 3 iters).
  const src = `export const main = () => {
    let a = [1, 2]
    let n = 0
    for (let i = 0; i < a.length; i++) {
      if (i === 0) a.push(9)
      n++
    }
    return n
  }`
  is(run(src).main(), 3)
})

test('LICM: nested-loop invariant arithmetic is hoisted (V8 wasm under-hoists it)', () => {
  // A subexpression invariant w.r.t. an INNER loop (`(a-b)*K` recomputed every `j`)
  // is hoisted out of it — the per-pixel cost in nested rasterizers/convolutions
  // (penrose, waves).
  const wat = compile(
    `export let f = (a, b, n, m) => { let s = 0; for (let i=0;i<n;i++) for (let j=0;j<m;j++) s = s + (a-b)*3.5 + j; return s }`,
    { wat: true, optimize: 'speed' })
  ok(/local \$__li/.test(wat), 'expected a hoisted snap local')
  const innermost = []
  walk(parseWat(wat), n => { if (n[0] === 'loop' && count(n, x => x[0] === 'loop') === 1) innermost.push(n) })
  ok(innermost.length > 0 && innermost.every(n => count(n, x => x[0] === 'f64.mul') === 0), '(a-b)*3.5 is outside every inner-loop copy')
  const probe = operationCounter(parseWat(wat), 'f64.mul', (a, b) => a * b)
  for (const [n, m] of [[4, 5], [4, 5], [0, 3], [2, 0], [3, 2.5], [2, -Infinity], [4, 5]])
    ok(probe('f', 2, 0.5, n, m).calls <= Math.max(1, n), `at most one invariant computation per outer iteration (${n}, ${m})`)
  // Bit-exact: hoisting must not change the result.
  const { f } = run(`export let f = (a, b, n, m) => { let s = 0; for (let i=0;i<n;i++) for (let j=0;j<m;j++) s = s + (a-b)*3.5 + j; return s }`)
  const js = (a, b, n, mm) => { let s = 0; for (let i=0;i<n;i++) for (let j=0;j<mm;j++) s = s + (a-b)*3.5 + j; return s }
  is(f(2, 0.5, 4, 5), js(2, 0.5, 4, 5))
  is(f(-1.5, 2.5, 7, 3), js(-1.5, 2.5, 7, 3))
})

test('fixed global typed cells cache across loops but reachable mutation fails closed', () => {
  const stable = `
    let cfg=new Float64Array(2),out=new Float64Array(64);cfg[0]=3;cfg[1]=4
    export let f=n=>{let s=0;for(let i=0;i<n;i++){s+=cfg[0]*cfg[1];out[i&63]=s}return s}`
  const stableTree = parse(stable, { level: 'speed' })
  is(loopCount(findFunc(stableTree, '$f'), n => n[0] === 'f64.load'), 0,
    'constant cfg cells load once at entry, past unrelated output stores')
  is(run(stable, { optimize: 'speed' }).f(7), 84, 'cached cells exact')

  const mutating = `
    let cfg=new Float64Array(1);cfg[0]=2
    const bump=()=>{cfg[0]=cfg[0]+1}
    export let f=n=>{let s=0;for(let i=0;i<n;i++){s+=cfg[0];bump()}return s}`
  // the write stays behind a call: source inlining would splice `bump` into the
  // loop, whose cell then lives in a local for the loop (plan/loop-fields.js)
  const mutTree = parse(mutating, { level: 'speed', sourceInline: false })
  ok(loopCount(findFunc(mutTree, '$f'), n => n[0] === 'f64.load') >= 1,
    'a reachable element write keeps the load in the loop')
  is(run(mutating, { optimize: { level: 'speed', sourceInline: false } }).f(4), 14, 'mutating fallback exact')
  is(loopCount(findFunc(parse(mutating, { level: 'speed' }), '$f'), n => n[0] === 'f64.load'), 0,
    'the spliced write carries the cell in a local')
  is(run(mutating, { optimize: 'speed' }).f(4), 14, 'the carried cell exact')

  // Replacing a first-load local.tee must not leave cache initializers reading
  // the wasm local's default zero before the typed-array base is decoded.
  const nestedBase = jz(`
    let cfg=new Float64Array(2);cfg[1]=3.25
    export let f=n=>{let s=0,i=0;while(i<n){s+=cfg[1];i++}return s}
  `, { optimize: 'speed' }).exports
  is(nestedBase.f(4), 13, 'nested first-load base initializes before its cached cell')

  const reassigned = jz(`
    let cfg=new Float64Array(1);cfg[0]=2
    let swap=()=>{cfg=new Float64Array(1);cfg[0]=7}
    export let f=n=>{let s=cfg[0];swap();let i=0;while(i<n){s+=cfg[0];i++}return s}
  `, { optimize: 'speed' }).exports
  is(reassigned.f(2), 16, 'reachable global pointer reassignment prevents stale caching')
})

// cseScalarLoad: sibling if-arms are EXCLUSIVE paths — a CSE anchor minted in
// the then-arm must not serve loads in the else-arm (the $__cs local is unset
// on that path; the 2026-07-18 re-audit's class). Float fields keep the union
// carrier off so the reads stay f64 slot loads the pass targets; the record
// stream starts on the ELSE arm so wasm zero-init cannot mask the leak.
test('cseScalarLoad: no cross-arm anchor reuse (values exact at O2+)', () => {
  const src = `
export let main = () => {
  const rows = []
  let s = 0x1234abcd | 0
  for (let i = 0; i < 64; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    const k = s & 1
    if (k === 0) rows.push({ k: k, x: ((s >>> 3) & 255) + 0.5, y: ((s >>> 13) & 255) + 0.5 })
    else rows.push({ k: 1, n: ((s >>> 3) & 255) + 0.5, s: ((s >>> 13) & 255) + 0.5 })
  }
  let h = 0
  for (let i = 0; i < rows.length; i++) {
    const o = rows[i]
    const k = o.k
    if (k === 0) h = (h + o.x + o.y) | 0
    else h = (h + Math.imul(o.n, o.s)) | 0
  }
  return h
}`
  const truth = oracle(src).main()
  for (const optimize of levels(false, 2, 'speed'))
    is(run(src, { optimize }).main(), truth, `JS-exact (optimize:${optimize})`)
})

test('cse-load: element read must not CSE across a control boundary', () => {
  // Pre-existing latent hole exposed by the pair+tail unroll shape: reads()
  // walked INTO a while nested in a block statement, so the loop body's a[i]
  // (loop-VARYING) shared a CSE key with a textual twin after the loop and the
  // "common" load hoisted above the while — reading a[0] forever. reads() now
  // stops and flushes at control boundaries; each nested sequence gets its own
  // table via descend().
  const src = `
export let main = () => {
  const a = new Int32Array(8)
  for (let k = 0; k < 8; k++) a[k] = (k + 1) * 10
  let s = 0
  {
    let i = 0
    while (i < 6) { s = (s + a[i]) | 0; i = (i + 2) | 0 }
    if (i < 8) { s = (s + a[i]) | 0 }
  }
  return s
}`
  // JS: a[0]+a[2]+a[4] + a[6] = 10+30+50+70 = 160 (broken CSE read a[0] in the tail → 100)
  for (const optimize of levels(0, 2, 'speed'))
    is(run(src, { optimize }).main(), 160, `O${optimize}: no cross-loop CSE of a[i]`)
})

test('a field a loop only reads is read once, before it', () => {
  // `c.xs[i]` through a spliced `at(chain, i)`: nothing in the loop writes an
  // `xs` or a `ys`, so each field is read before the loop and the arrays'
  // forwarding and length words hoist with it.
  if (onKernel()) return
  const src = `const chain = { xs: [], ys: [] }
for (let i = 0; i < 6; i++) { chain.xs.push(i); chain.ys.push(i * 2) }
const at = (c, i) => c.xs[i] + c.ys[i]
export let f = (n) => { let s = 0; for (let k = 0; k < n; k++) for (let i = 0; i < 6; i++) s += at(chain, i); return s }
export let g = (n) => { let s = 0; for (let k = 0; k < n; k++) { s += chain.xs[k % 6]; chain.xs = chain.ys } return s }`
  const header = n => n[0] === 'i32.load' && Array.isArray(n[n.length - 1]) && n[n.length - 1][0] === 'i32.sub'
  is(loopCount(findFunc(parse(src, { level: 'speed' }), '$f'), header), 0, 'no header word is read in the loop')
  // a loop that stores the field reads it each time
  for (const level of ownedLevels(0, 2, 'speed')) {
    const e = jz(src, { optimize: { level } }).exports
    is(e.f(3), 135, `O${level}`)
    is(e.g(3), 0 + 2 + 4, `the stored field O${level}`)
  }
})

test('an element a loop only reads is read once, before it', () => {
  // A matrix applied to every point of a buffer as three.js applies one
  // (`const e = this.elements`, then `e[3]`, `e[7]`, … per point), its cells
  // filled by a `fromArray` that may read past its source's end: each read
  // tests for a missing cell.
  if (onKernel()) return
  const src = `class M {
  constructor() { this.elements = [1, 0.1, 0, 0, 0, 1, 0.2, 0, 0, 0, 1, 0, 0.5, 0.25, 0, 1] }
  fromArray(a, o) { for (let i = 0; i < 16; i++) this.elements[i] = a[i + o]; return this }
  apply(a, i) {
    const e = this.elements, x = a[i], y = a[i + 1], z = a[i + 2]
    const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15])
    a[i] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w
    a[i + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w
    a[i + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w
  }
}
const m = new M(), other = [0, 0], a = new Float32Array(30)
for (let i = 0; i < a.length; i++) a[i] = i / 7
export let load = (o) => { m.fromArray(a, o); return m.elements[15] }
export let f = () => { for (let i = 0; i < a.length; i += 3) m.apply(a, i); return a[3] + a[28] }
export let g = () => { for (let i = 0; i < a.length; i += 3) { m.apply(a, i); m.elements[12] = a[i] * 0.5 } return a[3] + a[28] + m.elements[12] }
export let h = () => { for (let i = 0; i < a.length; i += 3) { m.apply(a, i); other[1] = a[i + 1] } return a[3] + a[28] + other[1] }`
  const loads = (name) => loopCount(findFunc(parse(src, { level: 'speed' }), name), n => n[0] === 'f64.load')
  is(loads('$f'), 0, 'no element of the matrix is read in the loop')
  is(loads('$h'), 0, 'nor where the loop stores into an array of another cell')
  ok(loads('$g') > 0, 'a loop storing into the matrix reads it each pass')
  for (const level of ownedLevels(0, 2, 'speed')) {
    const e = jz(src, { optimize: { level } }).exports, want = oracle(src)
    for (const k of ['f', 'g', 'h', 'f']) is(e[k](), want[k](), `${k} O${level}`)
    // a matrix a read past the source's end left missing cells in: NaN through the loop
    is(e.load(20), want.load(20), `load past the end O${level}`)
    for (const k of ['f', 'h']) is(e[k](), want[k](), `${k} after it O${level}`)
  }
})
