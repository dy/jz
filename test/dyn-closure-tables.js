// Same-body indirect devirt for closure tables built IMPERATIVELY
// (src/compile/dyn-closure-tables.js) — the jessie-bench shape: an array whose
// values are all closures of ONE lexical body (one funcIdx), with DIFFERENT
// captured environments, populated across many `table[idx] = …` writes rather
// than a single const array literal. Proven program-wide (write-family +
// escape scan); a monomorphic table feeds the same ctx.scope.constFnArrays map
// devirtConstFnArrayCalls (the const-literal-array devirt) already reads, so
// the wat evidence looks identical: br_table over direct calls, the original
// call_indirect kept as the always-sound default arm.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { run } from './util.js'

const SPEED = { level: 'speed', watr: false }
const wat = (src, opts = SPEED) => jz.compile(src, { wat: true, optimize: opts })
const callIndirectCount = (w) => (w.match(/call_indirect/g) || []).length
const brTableCount = (w) => (w.match(/br_table/g) || []).length

test('dyn-closure-tables: direct writes of the same arrow, different captured envs, devirt to br_table', () => {
  // Each setup(i, delta) call instantiates the SAME lexical arrow (one funcIdx)
  // with a FRESH captured `delta` — the loop itself isn't used to build the
  // table (jz's for-let capture shares one cell across iterations, a separate,
  // pre-existing limitation unrelated to this pass) — a plain function call
  // gives each instantiation its own parameter binding instead.
  const src = `
    let table = []
    const setup = (i, delta) => { table[i] = (x) => x + delta }
    setup(0, 1); setup(1, 2); setup(2, 3)
    export const f = (sel, x) => table[sel](x)
  `
  const w = wat(src)
  ok(brTableCount(w) >= 1, 'monomorphic imperative table dispatches via br_table')
  ok(callIndirectCount(w) >= 1, 'the generic call_indirect stays as the default arm')
  const { f } = run(src, { optimize: SPEED })
  is(f(0, 10), 11); is(f(1, 10), 12); is(f(2, 10), 13)
})

test('dyn-closure-tables: guarded read-then-call idiom `(h = table[idx]) && h(args)` devirts too', () => {
  // subscript's actual parse.step shape: read the slot into a local, guard on
  // truthiness (empty slot → skip), THEN call — not a direct `table[idx](args)`.
  // The callee at the call site is syntactically the bare local `h`; emit.js's
  // '&&' handler tags it from the LHS assignment's source shape instead.
  const src = `
    let table = []
    const setup = (i, delta) => { table[i] = (x) => x + delta }
    setup(0, 1); setup(1, 2); setup(2, 3)
    export const f = (sel, x, h) => (h = table[sel]) && h(x)
  `
  const w = wat(src)
  ok(brTableCount(w) >= 1, 'guarded dispatch through a proven table also devirts')
  ok(callIndirectCount(w) >= 1, 'the generic call_indirect stays as the default arm')
  const { f } = run(src, { optimize: SPEED })
  is(f(0, 10), 11); is(f(1, 10), 12); is(f(2, 10), 13)
})

test('dyn-closure-tables: closure-factory wrapper (defaulted-param forwarding, subscript\'s dispatch() shape)', () => {
  // `factory`'s 2nd param defaults to a closure literal and is returned
  // unmodified; every call site of `factory` omits it, so the default always
  // fires. Every write into `table` is a CALL to `factory` (not a bare arrow) —
  // exactly subscript's `dispatch(ops, tail, fn = (a, …) => {…}) => (…, fn)`,
  // called only as `dispatch(a, b)` from `register`.
  const src = `
    const factory = (n, fn = (x) => x + n) => fn
    let table = []
    const setup = (i, n) => { table[i] = factory(n) }
    setup(0, 3); setup(1, 10)
    export const f = (sel, x) => table[sel](x)
  `
  const w = wat(src)
  ok(brTableCount(w) >= 1, 'writes forwarded through a proven closure factory devirt')
  ok(callIndirectCount(w) >= 1, 'the generic call_indirect stays as the default arm')
  const { f } = run(src, { optimize: SPEED })
  is(f(0, 5), 8); is(f(1, 5), 15)
})

test('dyn-closure-tables: closure-factory wrapper, direct-return shape (no defaulted param)', () => {
  // `make`'s own return value is unconditionally a closure literal (the
  // classic `makeAdder` idiom, test/closures.js) — a simpler factory shape
  // than the defaulted-parameter forward above, proven at `make`'s own
  // emit time (no call-site arg-count analysis needed at all).
  const src = `
    const make = (n) => (x) => x + n
    let table = []
    const setup = (i, n) => { table[i] = make(n) }
    setup(0, 3); setup(1, 10)
    export const f = (sel, x) => table[sel](x)
  `
  const w = wat(src)
  ok(brTableCount(w) >= 1, 'a direct-return closure factory devirts too')
  const { f } = run(src, { optimize: SPEED })
  is(f(0, 5), 8); is(f(1, 5), 15)
})

test('dyn-closure-tables FAIL-CLOSED: two different closure bodies never devirt', () => {
  const src = `
    let table = []
    table[0] = (x) => x + 1
    table[1] = (x) => x * 2
    export const f = (sel, x) => table[sel](x)
  `
  const w = wat(src)
  is(brTableCount(w), 0, 'a bimorphic table stays a plain call_indirect — no br_table')
  const { f } = run(src, { optimize: SPEED })
  is(f(0, 5), 6); is(f(1, 5), 10)
})

test('dyn-closure-tables FAIL-CLOSED: a table passed to an unknown callee (escape/alias) never devirts', () => {
  const src = `
    let table = []
    table[0] = (x) => x + 1
    let escaped = null
    const leak = (arr) => { escaped = arr; return arr }
    leak(table)
    export const f = (sel, x) => table[sel](x)
  `
  const w = wat(src)
  is(brTableCount(w), 0, 'an escaping table is not a candidate — untouched call_indirect')
  const { f } = run(src, { optimize: SPEED })
  is(f(0, 5), 6)
})

test('dyn-closure-tables FAIL-CLOSED: a nested table (write flows through an inner index) never devirts', () => {
  // `table[i]` here holds a SUB-array, not a closure — populating it
  // (`table[i] = []`) is a plain-array write, which fails the direct-closure /
  // known-factory-call classification and poisons `table` outright (the
  // element-level `table[i][j] = closure` write never even reaches `table`'s
  // own write-family — emitElementAssign sees the receiver `table[i]`, not the
  // bare name `table`).
  const src = `
    let table = []
    const setup = (i) => { table[i] = [] }
    const fill = (i, j, delta) => { table[i][j] = (x) => x + delta }
    setup(0); fill(0, 0, 1); fill(0, 1, 2)
    export const f = (i, j, x) => table[i][j](x)
  `
  const w = wat(src)
  is(brTableCount(w), 0, 'a nested (array-of-arrays) table is not devirtualized')
  const { f } = run(src, { optimize: SPEED })
  is(f(0, 0, 10), 11); is(f(0, 1, 10), 12)
})

test('dyn-closure-tables FAIL-CLOSED: empty-slot call behaves identically with the pass on or off', () => {
  // Calling an out-of-range / never-written slot must not trap into the
  // devirt's direct-call arm — the runtime funcIdx guard falls through to the
  // untouched original call_indirect (whatever that does today) regardless.
  const src = `
    let table = []
    const setup = (i, delta) => { table[i] = (x) => x + delta }
    setup(0, 1); setup(1, 2); setup(2, 3)
    export const f = (sel, x) => table[sel](x)
  `
  const on = run(src, { optimize: SPEED })
  const off = run(src, { optimize: { ...SPEED, devirtFnArrays: false } })
  let onErr = null, offErr = null, onVal, offVal
  try { onVal = on.f(99, 10) } catch (e) { onErr = e.message }
  try { offVal = off.f(99, 10) } catch (e) { offErr = e.message }
  is(onErr, offErr, 'same error (or none) calling an out-of-range slot')
  if (!onErr) is(onVal, offVal, 'same value calling an out-of-range slot')
})
