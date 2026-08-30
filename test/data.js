// Comprehensive data type tests: arrays, objects, strings
// Adapted from old arch tests + new NaN-boxing architecture
import test from 'tst'
import { is, ok, almost, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onWasi, onKernel, adaptI64 } from './_matrix.js'
import { BIGINT_TYPED_STORE_CALLS, BIGINT_TYPED_STORE_CATCH_SOURCE, BIGINT_TYPED_STORE_ERROR_SOURCE, BIGINT_TYPED_STORE_PAYLOAD, BIGINT_TYPED_STORE_SOURCE, BIGINT_TYPED_STORE_THROW_CALLS } from './_bigint-typed-store-corpus.js'

function run(code, opts) {
  const { module, instance } = jz(code, opts)
  return adaptI64(module, instance.exports)
}

// ============================================
// ARRAYS
// ============================================

// --- BigInt return boundary ---

test('bigint: a returned bigint crosses to JS as a real, lossless BigInt', () => {
  // Internally bigint rides an i64 reinterpreted into the f64 carrier; the export thunk exposes
  // the raw i64, so the host receives a genuine JS BigInt (was a lossy Number; raw bits before that).
  is(run('export let f = () => 100n').f(), 100n)
  is(run('export let f = () => 10n - 3n').f(), 7n)
  is(run('export let f = () => 0n - 5n').f(), -5n)             // signed
  is(run('export let f = () => { return 7n * 6n }').f(), 42n)
  // |value| ≥ 2^52 (past the f64-mantissa-as-subnormal carrier's "distinguishable from a
  // number by magnitude alone" range) is now lossless on EVERY leg, native and kernel alike
  // (audit P0-2: bigint LITERALS are tagged `['bigint', decimalStr]` at parse time — see
  // parse.js — so the kernel's own literal-kind classification never depends on the
  // magnitude heuristic in the first place; only a genuinely RUNTIME-COMPUTED bigint whose
  // static kind isn't provable still rides the ambiguous carrier, a documented, unrelated
  // limit — see statements.js 'typeof recognizes BigInt values' family).
  is(run('export let f = () => 9007199254740993n').f(), 9007199254740993n)  // lossless past 2^53
})

test('RepresentationPlan: direct call edges preserve raw-only helpers and normalize tagged params', () => {
  const src = `
    function raw(x) { return x + 1n }
    function tag(x) { return typeof x }
    function maybe(x) { if (x == null) return 0n; return x + 1n }
    export let rawCall = () => raw(4n)
    export let bigintTag = () => tag(4n)
    export let numberTag = () => tag(4)
    export let nullable = c => maybe(c ? 4n : null)
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    is(e.rawCall(), 5n, `O${optimize || 0}: raw-only edge stays raw`)
    is(e.bigintTag(), 'bigint', `O${optimize || 0}: BigInt entering a tagged param is boxed once`)
    is(e.numberTag(), 'number', `O${optimize || 0}: Number entering the same param is unchanged`)
    is(e.nullable(1), 5n, `O${optimize || 0}: nullable BigInt edge unboxes in the callee`)
    is(e.nullable(0), 0n, `O${optimize || 0}: nullish sentinel is not unboxed as a pointer`)
  }
})

test('RepresentationPlan: plain local writes normalize a Number-or-BigInt binding', () => {
  const src = `
    export let classify = c => {
      let value = 0
      if (c) value = 4n
      return typeof value
    }
    export let use = c => {
      let value = 0
      if (c) value = 4n
      if (typeof value === 'bigint') return value + 1n === 5n
      return value + 1 === 1
    }
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    is(e.classify(0), 'number', `O${optimize || 0}: Number write keeps its native carrier`)
    is(e.classify(1), 'bigint', `O${optimize || 0}: BigInt write enters the tagged local carrier`)
    is(e.use(0), true, `O${optimize || 0}: Number consumer remains correct`)
    is(e.use(1), true, `O${optimize || 0}: guarded BigInt consumer reads the boxed payload`)
  }
})

test('RepresentationPlan: covered reassigned params use tagged typeof without magnitude guesses', () => {
  const src = `
    function kind(value, replace) {
      if (replace) value = 4n
      return typeof value
    }
    function isBigInt(value, replace) {
      if (replace) value = 4n
      return typeof value === 'bigint'
    }
    export let numberKind = () => kind(2, 0)
    export let assignedKind = () => kind(2, 1)
    export let literalKind = () => kind(5n, 0)
    export let numberCheck = () => isBigInt(2, 0)
    export let assignedCheck = () => isBigInt(2, 1)
    export let literalCheck = () => isBigInt(5n, 0)
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    is(e.numberKind(), 'number', `O${optimize || 0}: Number is not inferred BigInt from another write`)
    is(e.assignedKind(), 'bigint', `O${optimize || 0}: reassigned BigInt is tagged`)
    is(e.literalKind(), 'bigint', `O${optimize || 0}: direct BigInt entry is tagged`)
    is(e.numberCheck(), false, `O${optimize || 0}: comparison rejects Number`)
    is(e.assignedCheck(), true, `O${optimize || 0}: comparison accepts assigned BigInt`)
    is(e.literalCheck(), true, `O${optimize || 0}: comparison accepts entry BigInt`)
  }
})

test('RepresentationPlan: body-write-only BigInt acquisition still materializes the tagged param', () => {
  // The provenance corner the covered-reassigned-params pin above misses: its
  // source ALSO passes 5n at a call site, which alone trips the call-arg
  // provenance. Here BigInt enters ONLY via the body write — paramsByFunc
  // needs the body-write acquisition rule (solveBigintProvenance's ASSIGN_OPS
  // arm), or the tagged carrier never materializes and `typeof` folds to the
  // write's kind for Number entries (numberKind() read 'bigint' — silently
  // wrong, found by direct probe 2026-08-20).
  const src = `
    function kind(value, replace) {
      if (replace) value = 4n
      return typeof value
    }
    export let numberKind = () => kind(2, 0)
    export let assignedKind = () => kind(2, 1)
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    is(e.numberKind(), 'number', `O${optimize || 0}: Number entry keeps its own kind`)
    is(e.assignedKind(), 'bigint', `O${optimize || 0}: body-written BigInt reads through the tag`)
  }
  // Position variants of the same acquisition: a catch-arm write (conditional
  // by throw-reachability) and a nullish-assign write — both must keep the
  // untaken path's Number identity.
  const pos = jz(`
    function catchKind(value, go) {
      try { if (go) { JSON.parse('{bad') } } catch (er) { value = 4n }
      return typeof value
    }
    function nullishKind(value, go) { if (go) value = null; value ??= 4n; return typeof value }
    export let catchNumber = () => catchKind(2, 0)
    export let catchThrown = () => catchKind(2, 1)
    export let nullishNumber = () => nullishKind(2, 0)
    export let nullishTaken = () => nullishKind(2, 1)
  `).exports
  is(pos.catchNumber(), 'number', 'no-throw path keeps Number')
  is(pos.catchThrown(), 'bigint', 'catch-arm BigInt write reads through the tag')
  is(pos.nullishNumber(), 'number', 'non-nullish entry keeps Number')
  is(pos.nullishTaken(), 'bigint', 'taken nullish-assign writes through the tagged binding edge')
})

test('RepresentationPlan: conditional assignments normalize only the taken BigInt write', () => {
  const src = `
    let hits = 0
    function big() { hits = hits + 1; return 4n }
    function n(v) { hits = 0; v ??= big(); return (typeof v === 'bigint' ? 10 : 0) + hits }
    function o(v) { hits = 0; v ||= big(); return (typeof v === 'bigint' ? 10 : 0) + hits }
    function a(v) { hits = 0; v &&= big(); return (typeof v === 'bigint' ? 10 : 0) + hits }
    export let nullishTake = () => n(null)
    export let nullishKeep = () => n(2)
    export let orTake = () => o(0)
    export let orKeep = () => o(2)
    export let andTake = () => a(2)
    export let andKeep = () => a(0)
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    is(e.nullishTake(), 11, `O${optimize || 0}: ??= taken arm boxes BigInt and evaluates RHS once`)
    is(e.nullishKeep(), 0, `O${optimize || 0}: ??= untaken arm keeps Number and skips RHS`)
    is(e.orTake(), 11, `O${optimize || 0}: ||= taken arm boxes BigInt and evaluates RHS once`)
    is(e.orKeep(), 0, `O${optimize || 0}: ||= untaken arm keeps Number and skips RHS`)
    is(e.andTake(), 11, `O${optimize || 0}: &&= taken arm boxes BigInt and evaluates RHS once`)
    is(e.andKeep(), 0, `O${optimize || 0}: &&= untaken arm keeps Number and skips RHS`)
  }
})

test('RepresentationPlan: covered return edges materialize dynamic call results', () => {
  const src = `
    function choose(flag) {
      if (flag) return 4n
      return 2
    }
    export let numberKind = () => typeof choose(0)
    export let bigintKind = () => typeof choose(1)
    export let numberCheck = () => typeof choose(0) === 'bigint'
    export let bigintCheck = () => typeof choose(1) === 'bigint'
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    is(e.numberKind(), 'number', `O${optimize || 0}: Number result stays a Number`)
    is(e.bigintKind(), 'bigint', `O${optimize || 0}: BigInt result crosses tagged`)
    is(e.numberCheck(), false, `O${optimize || 0}: comparison rejects Number result`)
    is(e.bigintCheck(), true, `O${optimize || 0}: comparison accepts BigInt result`)
  }
})

test('RepresentationPlan: ternary arms normalize before entering a tagged local', () => {
  const src = `
    export let kind = flag => {
      let value = flag ? 4n : 2
      return typeof value
    }
    export let check = flag => {
      let value = flag ? 4n : 2
      return typeof value === 'bigint'
    }
    export let staticKind = () => {
      let value = true ? 4n : 2
      return typeof value
    }
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    is(e.kind(0), 'number', `O${optimize || 0}: Number ternary arm stays Number`)
    is(e.kind(1), 'bigint', `O${optimize || 0}: BigInt ternary arm is boxed before merge`)
    is(e.check(0), false, `O${optimize || 0}: tag comparison rejects Number arm`)
    is(e.check(1), true, `O${optimize || 0}: tag comparison accepts BigInt arm`)
    is(e.staticKind(), 'bigint', `O${optimize || 0}: folded condition preserves selected edge action`)
  }
})

test('RepresentationPlan: host ingress distinguishes JS BigInt from Number bits', () => {
  const src = `
    export let kind = value => typeof value
    export let check = value => typeof value === 'bigint'
    export let payload = value => typeof value === 'bigint'
      ? value + 1n === 6n
      : value + 1 === 3
    export let payloadNeg = value => typeof value === 'bigint'
      ? value + 1n === -5n
      : value + 1 === -5
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    is(e.kind(2), 'number', `O${optimize || 0}: host Number remains Number`)
    is(e.kind(5n), 'bigint', `O${optimize || 0}: host BigInt is boxed at ingress`)
    is(e.kind(Number.MIN_VALUE), 'number', `O${optimize || 0}: subnormal Number is never magnitude-classified`)
    is(e.check(2), false, `O${optimize || 0}: tag check rejects host Number`)
    is(e.check(5n), true, `O${optimize || 0}: tag check accepts host BigInt`)
    is(e.payload(2), true, `O${optimize || 0}: Number payload remains usable`)
    is(e.payload(5n), true, `O${optimize || 0}: boxed BigInt payload unboxes in wasm`)
    // NEGATIVE host BigInt (interop.js isBox fix): a raw negative BigInt's
    // 64-bit two's-complement sign-extension used to collide with isBox's
    // sign-blind mask, so i64Arg/wrapVal skipped mem.BigInt's box allocation
    // and the unboxed bits reached wasm looking like neither a box nor a
    // string — $__typeof (module/core.js) read them as "number" (its own
    // sign-inclusive NaN mask correctly rejects them as a box, so they fell
    // to the generic-number arm), the exact inverse of the intended tag.
    is(e.kind(-5n), 'bigint', `O${optimize || 0}: NEGATIVE host BigInt is boxed at ingress (was: misread as number)`)
    is(e.check(-5n), true, `O${optimize || 0}: tag check accepts NEGATIVE host BigInt (was: false)`)
    // payloadNeg's target (-5n) is only reachable via the correct BigInt
    // branch computing -6n+1n=-5n — a misclassified-as-number -6n would fall
    // to the Number arm instead and compare its (garbage, unboxed-bits-as-
    // float) carrier against -5, discriminating fixed from broken rather
    // than coincidentally agreeing the way `payload`'s 6n target would.
    is(e.payloadNeg(-6n), true, `O${optimize || 0}: negative BigInt payload unboxes and computes in wasm`)
    is(e.payloadNeg(-4n), false, `O${optimize || 0}: wrong negative magnitude correctly rejected (not a vacuous true)`)
  }
})

test('RepresentationPlan: ordinary array storage preserves a dynamic BigInt member', () => {
  const src = `
    export let kind = flag => {
      let values = [flag ? 5n : 2]
      return typeof values[0]
    }
    export let check = flag => {
      let values = [flag ? 5n : 2]
      return typeof values[0] === 'bigint'
    }
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    is(e.kind(0), 'number', `O${optimize || 0}: Number array element`)
    is(e.kind(1), 'bigint', `O${optimize || 0}: BigInt array element is stored tagged`)
    is(e.check(0), false, `O${optimize || 0}: array read rejects Number`)
    is(e.check(1), true, `O${optimize || 0}: array read accepts BigInt`)
  }
})

// --- audit P0-2 pins: literal-kind tagging, native-vs-kernel differential ---
// Every case below must agree byte-for-byte across BOTH legs (this file runs
// under `node test/data.js` AND `JZ_TEST_TARGET=jz.wasm node test/data.js` —
// no onKernel() branch needed once the literal's KIND rides the AST instead
// of the subnormal-magnitude carrier bits). MIN_NORMAL is the audit's own
// authoritative boundary (Number.MIN_VALUE * 2^52, i.e. 2^-1022 — the
// smallest normal f64 / DBL_MIN, ECMA-262 Number.MIN_VALUE is the SUBNORMAL
// floor 2^-1074 instead, hence the separate name here).
const MIN_NORMAL = 2.2250738585072014e-308

test('P0-2: subnormal NUMBER literals keep typeof "number" and their exact value on export (audit repro)', () => {
  // The audit's own repro: kernel-compiled `() => 5e-324` used to export `1n` (the literal's
  // OWN AST node misread as bigint via the magnitude heuristic, corrupting its export-boundary
  // kind — see kind.js valTypeOf, emit.js emitNeg). 1e-320 used to export `2024n`.
  // NEGATIVE subnormal literals used to be kernel-curated: the unary-minus FOLD of a subnormal
  // literal runs inside the compiler, and self-compiled the compiler's own `-x` on carrier-band
  // bits took the boxed BigInt path (-5e-324 folded to -1) — the compiler's OWN internal
  // ToNumber coercion (module/number.js `__to_num`) hit the exact same unconditional
  // subnormal-as-BigInt-carrier heuristic the compiled OUTPUT program did (audit-#11 P0-1).
  // Closed by gating that heuristic on `ctx.features.bigint`: the compiler's own source is
  // itself bigint-free (bignum.js's rational limbs are plain numbers, never a real BigInt —
  // see its own doc comment), so the gate is OFF for the compiler's self-compiled compilation
  // too, same as any other bigint-free program. No more onKernel() split needed.
  const cases = [5e-324, -5e-324, 1e-320, MIN_NORMAL, MIN_NORMAL - Number.MIN_VALUE, MIN_NORMAL + Number.MIN_VALUE]
  for (const v of cases) {
    const f = run(`export let f = () => ${v}`).f
    const r = f()
    is(typeof r, 'number', `${v}: typeof`)
    is(r, v, `${v}: exact value`)
  }
})

test('P0-2: bigint literals near the 2^52 mantissa boundary stay bigint, exact', () => {
  // 2^52-1 / 2^52+1 straddle the point where the i64 carrier's f64 exponent field would turn
  // nonzero if it were EVER read as a plain float — both are still comfortably inside the
  // dynamic-typeof heuristic's subnormal range, but the audit pins the LITERAL path
  // specifically: the tag makes this exact regardless of magnitude, not just below 2^52.
  // 2^52-1 used to be kernel-curated (its carrier bits are the MAX-SUBNORMAL band, and
  // in-kernel the compiler's own handling of that literal value ToNumbered the carrier
  // mid-pipeline, exporting 4841369599423283198n = the bits of the f64 it became) — same
  // root and same fix as the negative-subnormal-literal case above (audit-#11 P0-1,
  // ctx.features.bigint-gated __to_num). No more onKernel() split needed.
  is(run('export let f = () => 4503599627370495n').f(), 4503599627370495n)   // 2^52 - 1
  is(run('export let f = () => 4503599627370497n').f(), 4503599627370497n)   // 2^52 + 1
})

test('P0-2: bigint literals at the 64-bit signed/unsigned boundaries', () => {
  is(run('export let f = () => 9223372036854775807n').f(), 9223372036854775807n)     // 2^63 - 1 (i64 max)
  is(run('export let f = () => -9223372036854775808n').f(), -9223372036854775808n)   // -2^63 (i64 min)
  // 2^64 - 1: every bit set. The export boundary reinterprets the raw i64 SIGNED (matches
  // wasm's native i64 signedness, same reinterpretation BigInt.asUintN(64,·) undoes on the
  // way in) — "representable" here means round-trips to the SAME value on every leg, not
  // that it equals the unsigned literal magnitude; that reinterpretation is the carrier's own
  // documented signedness, not something this audit item changes.
  is(run('export let f = () => 18446744073709551615n').f(), -1n)
})

test('audit-#11 P0-1: tagged dynamic BigInt retires the subnormal carrier guess', () => {
  is(run('let big = 1n; export function f() { let o = {}; o.a = 5e-324; o.b = 1; return +o.a }').f(), 5e-324)
  is(run('let big = 1n; export function f() { const a = []; a.push(5e-324); a.push("s"); return +a[0] }').f(), 5e-324)
  for (const optimize of [false, 2, 3]) {
    const { f } = jz(`export let f = flag => { let v = flag ? 1n : 5e-324; return Number(v) }`, { optimize }).exports
    is(f(0), 5e-324, `O${optimize || 0}: dynamic subnormal stays Number`)
    is(f(1), 1, `O${optimize || 0}: tagged BigInt converts by payload`)
  }
})

test('bigint: internal calls keep the i64 carrier (only the JS boundary surfaces it)', () => {
  // g returns bigint; f does bigint math on g()'s result, then returns. Internal calls use the
  // f64 carrier, so g()'s value reaches f exactly; only f's `$exp` export result is i64.
  is(run('export let g = () => 5n; export let f = () => g() * 2n + 1n').f(), 11n)
})

// --- Literals & indexing ---

test('array: empty', () => {
  is(run('export let f = () => { let a = []; return a.length }').f(), 0)
})

test('array: single element', () => {
  is(run('export let f = () => { let a = [42]; return a[0] }').f(), 42)
})

test('array: 3 elements', () => {
  const { f } = run('export let f = (i) => { let a = [10, 20, 30]; return a[i] }')
  is(f(0), 10); is(f(1), 20); is(f(2), 30)
})

test('array: float elements', () => {
  const { f } = run('export let f = () => { let a = [1.5, 2.7, 3.14]; return a[2] }')
  almost(f(), 3.14)
})

test('array: negative values', () => {
  is(run('export let f = () => { let a = [-1, -2, -3]; return a[0] + a[1] + a[2] }').f(), -6)
})

// --- .length ---

test('array: .length 0', () => {
  is(run('export let f = () => [].length').f(), 0)
})

test('array: .length 1', () => {
  is(run('export let f = () => { let a = [99]; return a.length }').f(), 1)
})

test('array: .length 5', () => {
  is(run('export let f = () => { let a = [1,2,3,4,5]; return a.length }').f(), 5)
})

test('array: .length 20 (large)', () => {
  is(run(`export let f = () => {
    let a = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19]
    return a.length
  }`).f(), 20)
})

// --- Write ---

test('array: write single', () => {
  is(run('export let f = () => { let a = [0,0,0]; a[1] = 42; return a[1] }').f(), 42)
})

test('array: write computed index', () => {
  const { f } = run('export let f = (i, v) => { let a = [0,0,0]; a[i] = v; return a[i] }')
  is(f(0, 10), 10); is(f(2, 30), 30)
})

test('array: write preserves other elements', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    a[1] = 99
    return a[0] + a[2]
  }`)
  is(f(), 4)  // 1 + 3, a[1] changed but 0 and 2 untouched
})

test('array: growth preserves direct alias reads', () => {
  const { f } = run(`export let f = () => {
    let a = [7]
    let b = a
    a.push(1, 2, 3, 4)
    return [b.length, b[0], b[4]]
  }`)
  is(f()[0], 5)
  is(f()[1], 7)
  is(f()[2], 4)
})

test('array: dynamic string key write/read', () => {
  const { f } = run(`export let f = () => {
    let a = []
    let k = 'name'
    a[k] = 7
    return a[k]
  }`)
  is(f(), 7)
})

test('array: static write visible via dynamic key', () => {
  const { f } = run(`export let f = () => {
    let a = []
    let k = 'name'
    a.name = 7
    return [a.name, a[k]]
  }`)
  is(f()[0], 7)
  is(f()[1], 7)
})

test('array: dynamic write visible via static key', () => {
  const { f } = run(`export let f = () => {
    let a = []
    let k = 'name'
    a.name = 1
    a[k] = 8
    return a.name
  }`)
  is(f(), 8)
})

test('array: nested property writes on array-valued props', () => {
  const { f } = run(`export let f = () => {
    let ctx = []
    ctx.meta = []
    ctx.meta.name = 9
    return ctx.meta.name
  }`)
  is(f(), 9)
})

test('array: mixed numeric and string keys stay coherent', () => {
  const { f } = run(`export let f = () => {
    let a = []
    a[0] = []
    a[0].name = 6
    a.name = a[0]
    return a.name.name
  }`)
  is(f(), 6)
})

test('array: growth inside helper preserves caller view', () => {
  const { f } = run(`
    let grow = (a) => a.push(1, 2, 3, 4)
    export let f = () => {
      let a = [7]
      grow(a)
      return [a.length, a[0], a[4]]
    }
  `)
  is(f()[0], 5)
  is(f()[1], 7)
  is(f()[2], 4)
})

test('array: growth inside helper preserves nested aliases', () => {
  const { f } = run(`
    let grow = (a) => a.push(1, 2, 3, 4)
    export let f = () => {
      let a = [7]
      let box = [a]
      grow(a)
      return [box[0].length, box[0][0], box[0][4]]
    }
  `)
  is(f()[0], 5)
  is(f()[1], 7)
  is(f()[2], 4)
})

// --- Loops ---

test('array: sum via loop', () => {
  is(run(`export let f = () => {
    let a = [1, 2, 3, 4, 5]
    let s = 0
    for (let i = 0; i < a.length; i++) s += a[i]
    return s
  }`).f(), 15)
})

test('array: fill via loop', () => {
  const { f } = run(`export let f = (n) => {
    let a = [0, 0, 0, 0, 0]
    for (let i = 0; i < 5; i++) a[i] = i * i
    return a[n]
  }`)
  is(f(0), 0); is(f(2), 4); is(f(4), 16)
})

test('array: dot product', () => {
  is(run(`
    let dot = (a, b) => {
      let s = 0
      for (let i = 0; i < a.length; i++) s += a[i] * b[i]
      return s
    }
    export let f = () => dot([1,2,3], [4,5,6])
  `).f(), 32)
})

// --- Pass & return ---

test('array: pass as param', () => {
  is(run(`
    let sum3 = (a) => a[0] + a[1] + a[2]
    export let f = () => sum3([10, 20, 30])
  `).f(), 60)
})

test('array: return pointer', () => {
  const { make, get } = run(`
    export let make = () => { let a = [5, 10, 15]; return a }
    export let get = (a, i) => a[i]
  `)
  const ptr = make()
  ok(isNaN(ptr))
  is(get(ptr, 0), 5)
  is(get(ptr, 2), 15)
})

// --- Multi-value vs pointer ---

test('array: literal return ≤8 = multi-value', () => {
  const r = run('export let f = (a, b) => [a + 1, b + 2]').f(10, 20)
  ok(Array.isArray(r))
  is(r[0], 11); is(r[1], 22)
})

test('array: multi-value return of boxed STRINGS survives the JS boundary', () => {
  // Regression: a multi-value `(f64,f64)` return of SSO-string NaN-boxes was canonicalized by
  // V8 at the JS↔wasm boundary (every lane → bare NaN → null). Lanes now cross as i64, and
  // interop.wrap() decodes the tuple. JS-host-only — WASI reads raw int64 and never canonicalizes.
  if (onWasi()) return
  is(JSON.stringify(jz("export let f = () => ['a', 'b']").exports.f()), '["a","b"]')
  is(JSON.stringify(jz("export let f = () => ['x', 'y', 'z']").exports.f()), '["x","y","z"]')
  is(JSON.stringify(jz("export let f = () => [1, 'a']").exports.f()), '[1,"a"]')           // mixed number + box
  is(JSON.stringify(jz('export let f = (a, b) => [a + 1, b + 2]').exports.f(10, 20)), '[11,22]')  // numeric tuple unchanged
  // The wrapper's lane temporaries must not collide with a same-named param (jz doesn't reserve `__`).
  is(JSON.stringify(jz('export let f = (__mlane0) => [__mlane0, 1]').exports.f(7)), '[7,1]')
})

test('array: string spread [...s] decodes its char elements (was null)', () => {
  // Regression: `[...s]` stored UNDEF into every slot when the string module wasn't loaded
  // (emitSpreadCopy fell to __typed_idx → __len=0 for a STRING → OOB). Now it dispatches
  // STRING→__str_idx. Codegen fix; the host-side decode is JS-only.
  if (onWasi()) return
  is(JSON.stringify(jz('export let f = (s) => [...s]').exports.f('hi')), '["h","i"]')
  is(JSON.stringify(jz('export let f = (s) => [...s]').exports.f('abcdefgh')), '["a","b","c","d","e","f","g","h"]')  // heap source
  is(JSON.stringify(jz('export let f = (s) => [9, ...s, 1]').exports.f('hi')), '[9,"h","i",1]')                       // mixed
})

test('interop: string arg to a fully-untyped param marshals (SSO) instead of NaN', () => {
  // Regression: a no-type-evidence param rides the i64 carrier; for a memoryless module the
  // host marshaled a string via f64ToI64 → NaN. interop now SSO-encodes ≤6 ASCII host-side.
  if (onWasi()) return
  is(jz('export let f = (a) => a').exports.f('hi'), 'hi')
  is(jz('export let f = (a) => a').exports.f(42), 42)        // number unaffected
  is(jz('export let f = (a) => a').exports.f(null), null)
})

test('array: >8 elements = pointer', () => {
  const { f, g } = run(`
    export let f = () => { let a = [1,2,3,4,5,6,7,8,9]; return a }
    export let g = (a) => a[8]
  `)
  ok(isNaN(f()))
  is(g(f()), 9)
})

// ============================================
// OBJECTS
// ============================================

// --- Literals & read ---

test('object: two properties', () => {
  const { f } = run('export let f = () => { let o = {x: 10, y: 20}; return o.x + o.y }')
  is(f(), 30)
})

test('object: three properties', () => {
  is(run('export let f = () => { let o = {r: 1, g: 2, b: 3}; return o.r + o.g + o.b }').f(), 6)
})

test('object: float values', () => {
  almost(run('export let f = () => { let o = {pi: 3.14, e: 2.71}; return o.pi }').f(), 3.14)
})

test('object: computed values', () => {
  is(run('export let f = (a, b) => { let o = {sum: a + b, diff: a - b}; return o.sum * o.diff }').f(5, 3), 16)
})

test('object: flat-object facts stay scoped per function', () => {
  const { f } = run(`
    let score = () => {
      const pair = {left: 2, right: 5}
      return pair.left + pair.right
    }
    export let f = () => score()
  `)
  is(f(), 7)
})

// --- Write ---

test('object: write property', () => {
  is(run('export let f = () => { let o = {x: 0, y: 0}; o.x = 42; return o.x }').f(), 42)
})

test('object: write preserves other props', () => {
  is(run(`export let f = () => {
    let o = {a: 1, b: 2, c: 3}
    o.b = 99
    return o.a + o.c
  }`).f(), 4)
})

test('object: reassigned literal can use narrower field set', () => {
  is(run(`export let f = () => {
    let o = {}
    o.a = 1
    o.b = 2
    o.c = 3
    o = {a: 4, b: 5}
    return o.a + o.b
  }`).f(), 9)
})

// --- Pass & return ---

test('object: pass to function', () => {
  is(run(`
    let mag2 = (v) => v.x * v.x + v.y * v.y
    export let f = () => mag2({x: 3, y: 4})
  `).f(), 25)
})

test('object: return as pointer', () => {
  const { make, getX, getY } = run(`
    export let make = (a, b) => { let o = {x: a, y: b}; return o }
    export let getX = (o) => o.x
    export let getY = (o) => o.y
  `)
  const ptr = make(7, 11)
  ok(isNaN(ptr))
  is(getX(ptr), 7)
  is(getY(ptr), 11)
})

test('object: multiple instances same schema', () => {
  const { f } = run(`
    let dist = (a, b) => {
      let dx = a.x - b.x
      let dy = a.y - b.y
      return dx * dx + dy * dy
    }
    export let f = () => dist({x: 0, y: 0}, {x: 3, y: 4})
  `)
  is(f(), 25)
})

test('object: param schema via default value', () => {
  is(run(`
    let getX = (v={x:0,y:0}) => v.x
    export let f = () => getX({x: 42, y: 0})
  `).f(), 42)
})

test('object: param schema default resolves ambiguity', () => {
  // {x,y} has x at offset 0; {z,x} has x at offset 1.
  // Default value declares v's schema as [x,y], so v.x = offset 0.
  is(run(`
    let getX = (v={x:0,y:0}) => v.x
    export let f = () => {
      let unrelated = {z: 0, x: 0}
      return getX({x: 7, y: 0}) + unrelated.z
    }
  `).f(), 7)
})

// ============================================
// STRINGS
// ============================================

// --- SSO (short string, ≤4 ASCII chars) ---

test('string: SSO creation', () => {
  const ptr = run('export let f = () => { let s = "hi"; return s }').f()
  ok(isNaN(ptr))  // NaN-boxed
})

test('string: SSO .length', () => {
  is(run('export let f = () => { let s = "abc"; return s.length }').f(), 3)
})

test('string: SSO empty', () => {
  is(run('export let f = () => { let s = ""; return s.length }').f(), 0)
})

test('string: SSO max (4 chars)', () => {
  is(run('export let f = () => { let s = "abcd"; return s.length }').f(), 4)
})

test('string: SSO single char', () => {
  is(run('export let f = () => { let s = "x"; return s.length }').f(), 1)
})

// --- Heap strings (>4 chars) ---

test('string: heap creation', () => {
  const ptr = run('export let f = () => { let s = "hello world"; return s }').f()
  ok(isNaN(ptr))
})

test('string: heap .length', () => {
  is(run('export let f = () => { let s = "hello world!"; return s.length }').f(), 12)
})

test('string: heap .length 5 (boundary)', () => {
  is(run('export let f = () => { let s = "hello"; return s.length }').f(), 5)
})

test('string: heap .length long', () => {
  is(run('export let f = () => { let s = "the quick brown fox jumps"; return s.length }').f(), 25)
})

// --- String as parameter ---

test('string: pass SSO to function', () => {
  is(run(`
    let len = (s) => s.length
    export let f = () => len("abc")
  `).f(), 3)
})

test('string: pass heap to function', () => {
  is(run(`
    let len = (s) => s.length
    export let f = () => len("hello world")
  `).f(), 11)
})

// ============================================
// MIXED
// ============================================

test('mixed: array of computed values', () => {
  const { f } = run(`export let f = (x) => {
    let a = [x, x * 2, x * 3]
    return a[0] + a[1] + a[2]
  }`)
  is(f(10), 60)
})

test('mixed: object with array access pattern', () => {
  const { f } = run(`export let f = () => {
    let data = [100, 200, 300]
    let cfg = {idx: 1, scale: 0.5}
    return data[cfg.idx]
  }`)
  is(f(), 200)
})

test('mixed: nested function calls', () => {
  is(run(`
    let add = (a, b) => a + b
    let scale = (v, s) => {
      let r = {x: v.x * s, y: v.y * s}
      return r
    }
    export let f = () => {
      let v = scale({x: 3, y: 4}, 2)
      return v.x + v.y
    }
  `).f(), 14)
})

// ============================================
// String indexing (returns single-char string)
// ============================================

test('string: SSO [i] returns char string', () => {
  const { f } = jz('export let f = (i) => { let s = "hi"; return s[i] }').exports
  is(f(0), 'h')
  is(f(1), 'i')
})

test('string: heap [i] returns char string', () => {
  const { f } = jz('export let f = (i) => { let s = "hello world"; return s[i] }').exports
  is(f(0), 'h')
  is(f(6), 'w')
})

test('string: literal [i]', () => {
  is(jz('export let f = () => "abc"[1]').exports.f(), 'b')
})

// ============================================
// Array mutation: push, pop, alias
// ============================================

test('array: push basic', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    a.push(4)
    return a[3]
  }`)
  is(f(), 4)
})

test('array: push updates length', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    a.push(3)
    a.push(4)
    return a.length
  }`)
  is(f(), 4)
})

test('array: pop returns last', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20, 30]
    return a.pop()
  }`)
  is(f(), 30)
})

test('array: pop decrements length', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20, 30]
    a.pop()
    return a.length
  }`)
  is(f(), 2)
})

test('array: push then pop', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    a.push(99)
    return a.pop()
  }`)
  is(f(), 99)
})

test('array: alias sees length change', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    let b = a
    a.push(4)
    return b.length
  }`)
  is(f(), 4)  // b sees a's push because length is in memory
})

test('array: alias sees element write', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    let b = a
    a[0] = 99
    return b[0]
  }`)
  is(f(), 99)  // b sees a's write (same memory)
})

// ============================================
// Set/Map alias (mutate in place)
// ============================================

test('Set: add returns same pointer (alias-safe)', () => {
  // `jz(...).exports` (not the module's `run()`, which decodes through the legacy
  // adaptI64 f64 NaN-box shim — a genuine JS boolean would reinterpret to NaN there):
  // `.has()`'s return crosses the real interop boundary as a proper JS boolean.
  const { f } = jz(`export let f = () => {
    let s = new Set()
    let s2 = s
    s.add(42)
    return s2.has(42)
  }`).exports
  is(f(), true)  // s2 sees the add
})

test('Map: set returns same pointer (alias-safe)', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    let m2 = m
    m.set(1, 100)
    return m2.get(1)
  }`)
  is(f(), 100)  // m2 sees the set
})

test('Map/Set: receiver laundered through an identity call keeps its pointer identity (O0 regression)', () => {
  // .work/archive/todo.md "O0 unproven-receiver Map/Set total miss": at optimize:false, a Map/Set
  // handle returned from `mk()` — where `mk` itself just forwards `new Map()` through a
  // generic identity function `pick(v) => v` — total-missed every .has()/.get() at the O0
  // call site. Root cause: narrowSignatures' E-phase numeric-result narrowing
  // (narrowI32Results) classifies a call tail purely by the callee's WASM-level i32/f64
  // result type, with no notion of ptrKind; once `pick`'s own-param passthrough narrows to
  // i32 for genuinely being a pointer, `mk`'s `return pick(x)` tail reads that i32 as an
  // ordinary number on the SAME fixpoint sweep and (finding valResult unset) wrongly
  // commits `valResult = VAL.NUMBER` before narrowPointerResults' call-passthrough case
  // ever gets a chance to prove otherwise. The caller then reboxed `m` via a numeric
  // f64.convert_i32_s widen instead of NaN-tag-fusing it back into a pointer — an ordinary
  // finite double no longer recognized as a Map/Set by __ptr_type, so every .has()/.get()
  // silently missed. O2/O3 never hit this: inlining collapses mk/pick away entirely, so the
  // receiver is directly provable as `new Map()`/`new Set()` at the call site.
  const src = `
    export let mapProbe = () => { let m = mk(); m.set(5, 7); return m.has(5) ? m.get(5) : -1 }
    export let setProbe = () => { let s = mk2(); s.add('x'); return s.has('x') ? 1 : 0 }
    export let chained = () => { let m = mk3(); m.set(1, 2); return m.has(1) ? 1 : 0 }
    let mk = () => { let x = new Map(); return pick(x) }
    let mk2 = () => { let x = new Set(); return pick(x) }
    let mk3 = () => mk()
    let pick = (v) => v
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    is(e.mapProbe(), 7, `O${optimize || 0}: Map receiver laundered through pick() keeps identity`)
    is(e.setProbe(), 1, `O${optimize || 0}: Set receiver laundered through pick() keeps identity`)
    is(e.chained(), 1, `O${optimize || 0}: two-hop call chain (mk3 -> mk -> pick) keeps identity`)
  }
})

test('self-compile compact collections: entry hash replaces the redundant probe lane', () => {
  // `_compactCollections` is an artifact-build option, not a user-facing output
  // mode. The kernel target cannot forward it through the wasm ABI; that leg is
  // covered by kernel-oracle/self-compile after building the compact artifact.
  if (onKernel()) return
  const src = `export let f = () => {
    let m = new Map(), s = new Set(), o = {}
    for (let i = 0; i < 40; i++) { m.set('k' + i, i); s.add(i); o['p' + i] = i }
    for (let i = 0; i < 20; i++) { m.delete('k' + (i * 2)); s.delete(i * 2); delete o['p' + (i * 2)] }
    let n = 0
    for (let i = 0; i < 40; i++) n += (m.get('k' + i) || 0) + (s.has(i) ? 1 : 0) + (o['p' + i] || 0)
    return n + m.size + s.size
  }`
  const fast = String(compile(src, { wat: true, optimize: false }))
  const compact = String(compile(src, { wat: true, optimize: false, _compactCollections: true }))
  const fn = (wat, name) => wat.slice(wat.indexOf(`(func $${name}`), wat.indexOf(`(func $${name}`) + 5000)
  ok(fn(fast, '__map_get').includes('(i32.load (local.get $ls))'), 'normal output probes its cache-dense side lane')
  ok(fn(compact, '__map_get').includes('(i32.load (local.get $slot))'), 'compact artifact probes the hash already stored in each entry')
  ok(!fn(compact, '__map_get').includes('(i32.load (local.get $ls))'), 'compact probe has no side-lane load')

  // Two consecutive empty allocations expose the exact block stride: 16-byte
  // header + 8 initial slots. Compact removes exactly 8*4 lane bytes.
  const allocSrc = 'export let map=()=>new Map(); export let set=()=>new Set()'
  const blockDelta = (compactCollections, name) => {
    const raw = jz(allocSrc, { optimize: false, _compactCollections: compactCollections }).instance.exports[name]
    const off = x => Number(x & 0xFFFFFFFFn)
    const a = off(raw()), b = off(raw())
    return b - a
  }
  is(blockDelta(false, 'map'), 240) // 16 + 8*(24+4)
  is(blockDelta(true, 'map'), 208)  // 16 + 8*24
  is(blockDelta(false, 'set'), 176) // 16 + 8*(16+4)
  is(blockDelta(true, 'set'), 144)  // 16 + 8*16
  is(run(src, { optimize: false, _compactCollections: true }).f(), 860)
  is(run(src, { optimize: 3, _compactCollections: true }).f(), 860)
})

// ============================================
// Set/Map grow past capacity + delete
// INIT_CAP=8, grows at 75% load (size≥6). These force ≥2 grows (8→16→32) so
// the forwarding/rehash path runs, and exercise backward-shift delete against
// the dense probe-chain collisions a grown table produces.
// ============================================

test('Set: grow past initial capacity keeps all members', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    for (let i = 0; i < 20; i++) s.add(i)
    let ok = 1
    for (let i = 0; i < 20; i++) if (!s.has(i)) ok = 0
    return ok + s.size
  }`)
  is(f(), 21)  // ok=1, size=20 — no member lost across rehash
})

test('Map: grow past initial capacity keeps all entries', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    for (let i = 0; i < 20; i++) m.set(i, i * 10)
    let sum = 0
    for (let i = 0; i < 20; i++) sum += m.get(i)
    return sum + m.size
  }`)
  is(f(), 1920)  // sum(i*10, 0..19)=1900, +size 20
})

test('Set: delete removes member and decrements size', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    s.add(1); s.add(2); s.add(3)
    let r = s.delete(2)
    return r + (s.has(2) ? 100 : 0) + s.size
  }`)
  is(f(), 3)  // delete→1, has(2)→false, size→2
})

test('Map: delete removes entry and get returns undefined', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    m.set(1, 10); m.set(2, 20)
    m.delete(1)
    return (m.get(1) === undefined ? 1 : 0) + m.size
  }`)
  is(f(), 2)  // get(1)→undefined, size→1
})

test('Set: delete absent member returns false (boolean, not boxed coll)', () => {
  // Regression: methodValType inferred `.delete` as VAL.SET, so `let r = s.delete(x)`
  // boxed the i32 result into a (truthy) NaN-box — absent deletes read as true.
  const { f } = run(`export let f = () => {
    let s = new Set()
    s.add(1)
    let r = s.delete(99)
    return (r ? 100 : 0) + s.size
  }`)
  is(f(), 1)  // delete(99)→false, size unchanged at 1
})

test('Set: delete preserves probe chain for survivors', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    for (let i = 0; i < 20; i++) s.add(i)
    for (let i = 0; i < 20; i += 2) s.delete(i)
    let ok = 1
    for (let i = 1; i < 20; i += 2) if (!s.has(i)) ok = 0
    for (let i = 0; i < 20; i += 2) if (s.has(i)) ok = 0
    return ok + s.size
  }`)
  is(f(), 11)  // odds survive, evens gone, size→10
})

test('Map: delete after grow preserves remaining entries', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    for (let i = 0; i < 20; i++) m.set(i, i)
    for (let i = 0; i < 10; i++) m.delete(i)
    let sum = 0
    for (let i = 10; i < 20; i++) sum += m.get(i)
    return sum + m.size
  }`)
  is(f(), 155)  // sum(10..19)=145, +size 10
})

test('Map: delete then re-add same key', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    m.set(5, 50)
    m.delete(5)
    m.set(5, 99)
    return m.get(5) + m.size
  }`)
  is(f(), 100)  // 99 + size 1
})

test('Set: delete down to empty then re-add', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    s.add(1); s.add(2)
    s.delete(1); s.delete(2)
    let emptied = s.size
    s.add(7)
    return emptied * 10 + (s.has(7) ? 1 : 0) + s.size
  }`)
  is(f(), 2)  // emptied=0, has(7)=1, size=1
})

// ============================================
// Set/Map has/delete boundary: real JS booleans, not 1/0
// ============================================
// Regression for the banked ".has()/.delete() boundary returns 1/0, not
// boolean" deviation (.work/archive/todo.md, 2026-08-19): ECMA-262 Map.prototype.has/
// Set.prototype.has/delete return a genuine boolean. kind-traits.js'
// methodValType already claimed VAL.BOOL for these on a proven Map/Set
// receiver, and the boundary wrapper's own resultBool/boolBoxIR mechanism
// (src/compile/index.js synthesizeBoundaryWrappers) already boxes a proven-
// BOOL result correctly — but the whole-function return-kind passes
// (narrowValResults/narrowBoolResults, src/compile/narrow.js) couldn't see a
// body-local receiver's kind through a compound return tail (`return m.has(k)`),
// so func.valResult never got set and the boxing never fired.
// Fixed at the type-inference layer (kind.js valTypeOfWithLocals now resolves
// an `obj.method(...)` return tail through its own local receiver-kind
// resolver — the same locals-aware mechanism every other op there already
// uses), not by hand-patching interop.js's decoder.
test('Map/Set: has/delete cross the JS boundary as real booleans (proven receiver), every optimize level', () => {
  for (const optimize of [false, 2, 3]) {
    const o = `O${optimize || 0}`
    is(jz(`export let f = () => { let m = new Map(); m.set(7, 1); return m.has(7) }`, { optimize }).exports.f(), true, `${o}: Map.has present`)
    is(jz(`export let f = () => { let m = new Map(); m.set(7, 1); return m.has(8) }`, { optimize }).exports.f(), false, `${o}: Map.has absent`)
    is(jz(`export let f = () => { let s = new Set(); s.add(7); return s.has(7) }`, { optimize }).exports.f(), true, `${o}: Set.has present`)
    is(jz(`export let f = () => { let s = new Set(); s.add(7); return s.has(8) }`, { optimize }).exports.f(), false, `${o}: Set.has absent`)
    is(jz(`export let f = () => { let m = new Map(); m.set(7, 1); return m.delete(7) }`, { optimize }).exports.f(), true, `${o}: Map.delete present`)
    is(jz(`export let f = () => { let m = new Map(); m.set(7, 1); return m.delete(8) }`, { optimize }).exports.f(), false, `${o}: Map.delete absent`)
    is(jz(`export let f = () => { let s = new Set(); s.add(7); return s.delete(7) }`, { optimize }).exports.f(), true, `${o}: Set.delete present`)
    is(jz(`export let f = () => { let s = new Set(); s.add(7); return s.delete(8) }`, { optimize }).exports.f(), false, `${o}: Set.delete absent`)
  }
})

test('Map/Set: has() crosses the boundary as a real boolean through a genuinely dynamic (unproven) receiver, every optimize level', () => {
  // A single closure called with BOTH a Map and a Set receiver: no single ptrKind
  // narrows its param, so at O0 `.has()` routes through module/collection.js's
  // collProbeDyn (the runtime Map-vs-Set __ptr_type dispatch) rather than the
  // proven `.MAP:has`/`.SET:has` emitters — the other half of the probe family
  // this fix covers (collProbeDyn already boxed its own result; the gap was
  // purely in func.valResult never getting set to route through it at the
  // boundary). O2/O3 constant-fold this same program before dispatch is
  // observable in the WAT, but the crossed VALUE must still agree.
  const src = `export let f = () => {
    let probe = (c, k) => c.has(k)
    let m = new Map(); m.set(7, 1)
    let s = new Set(); s.add(9)
    return probe(m, 7) && !probe(m, 8) && probe(s, 9) && !probe(s, 10)
  }`
  for (const optimize of [false, 2, 3])
    is(jz(src, { optimize }).exports.f(), true, `O${optimize || 0}: dynamic Map+Set receiver`)
})

test('Map: has() on a receiver laundered across the export boundary itself', () => {
  // A Map returned from one export and passed as an argument into another
  // round-trips through interop's JS-Map materialize/re-encode path — hitting
  // a SEPARATE, already-banked bug (.work/archive/todo.md: Map/Set set/get/has "total
  // miss" on a boundary-round-tripped receiver, fix pending in a parallel
  // worktree), not this fix's own concern. This fix's own claim — that a
  // has() result, hit or miss, decodes as a genuine boolean rather than a
  // bare 0/1 number — is asserted unconditionally; the real hit/miss VALUE is
  // only asserted once `size()` proves the separate bug isn't the reason
  // (`size` reading back `undefined` is that bug's own signature).
  const src = `
    export let mk = () => { let m = new Map(); m.set(7, 1); return m }
    export let sizeOf = (c) => c.size
    export let probe = (c, k) => c.has(k)
  `
  for (const optimize of [false, 2, 3]) {
    const o = `O${optimize || 0}`
    const { exports } = jz(src, { optimize })
    const m = exports.mk()
    const r = exports.probe(m, 7)
    is(typeof r, 'boolean', `${o}: boundary-round-tripped receiver still decodes has() as a real boolean`)
    if (exports.sizeOf(m) === undefined) continue  // known separate bug (banked) — not this fix's scope
    is(r, true, `${o}: Map.has(7) on a boundary-round-tripped receiver`)
  }
})

// ============================================
// Edge cases: push chain, empty pop
// ============================================

test('array: push chained', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    a.push(2)
    a.push(3)
    a.push(4)
    return a[0] + a[1] + a[2] + a[3]
  }`)
  is(f(), 10)
})

test('array: push preserves existing', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20]
    a.push(30)
    return a[0] + a[1]
  }`)
  is(f(), 30)  // original elements unchanged
})

test('array: push beyond capacity triggers grow', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    a.push(3)
    a.push(4)
    a.push(5)
    a.push(6)
    let b = [100]
    return a[4] + a[5] + b[0]
  }`)
  is(f(), 111)  // 5+6+100 — no heap corruption
})

test('array: grow links dynamic move helper after hash helpers', () => {
  const { f } = run(`export let f = () => {
    let obj = Object.fromEntries([["x", 3]])
    let values = []
    values.push({ a: 1 })
    values.push({ a: 2 })
    values.push({ a: 3 })
    values.push({ a: 4 })
    values.push({ a: 5 })
    return values.length + obj.x
  }`)
  is(f(), 8)
})

test('array: push many beyond initial cap', () => {
  const { f } = run(`export let f = () => {
    let a = []
    a.push(1)
    a.push(2)
    a.push(3)
    a.push(4)
    a.push(5)
    a.push(6)
    a.push(7)
    a.push(8)
    return a.length + a[7]
  }`)
  is(f(), 16)  // length=8, a[7]=8
})

test('array: out-of-range read returns undefined', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    return a[1]
  }`)
  ok(Number.isNaN(f()))
})

test('array: split missing item is undefined', () => {
  const { f } = run(`export let f = () => "unreachable".split(" ")[1]`)
  ok(Number.isNaN(f()))
})

test('array: truthy with ||', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    return (a || [2])[0]
  }`)
  is(f(), 1)
})

test('array: truthy with &&', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    return (a && [2])[0]
  }`)
  is(f(), 2)
})

test('array: pop on single element', () => {
  const { f } = run(`export let f = () => {
    let a = [42]
    let v = a.pop()
    return v + a.length
  }`)
  is(f(), 42)  // v=42, length=0
})

// ============================================
// Module-scope initialization (__start)
// ============================================

test('module-scope: let with expression', () => {
  is(run(`
    let q = 1 + 2
    export let f = () => q
  `).f(), 3)
})

test('module-scope: jzify hoisted bare var is global', () => {
  const wasm = compile(`
    var x
    x = 3
    export let f = () => x
  `, { jzify: true })
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm))
  inst.exports._initialize?.()  // wasi leg: reactor init (js leg ran the start section)
  is(inst.exports.f(), 3)
})

test('module-scope: array init', () => {
  is(run(`
    let a = [10, 20, 30]
    export let f = () => a[1]
  `).f(), 20)
})

test('module-scope: object init', () => {
  is(run(`
    let o = {x: 5, y: 10}
    export let f = () => o.x + o.y
  `).f(), 15)
})

test('module-scope: string init', () => {
  is(run(`
    let s = "hello"
    export let f = () => s.length
  `).f(), 5)
})

test('module-scope: const folded to immutable i32', () => {
  is(run(`
    const N = 100
    export let f = () => N * 2
  `).f(), 200)
})

test('module-scope: const expr folded', () => {
  is(run(`
    const N = 2 + 3
    export let f = () => N
  `).f(), 5)
})

test('module-scope: const float immutable', () => {
  const r = run(`
    const PI = 3.14159
    export let f = () => PI
  `).f()
  ok(Math.abs(r - 3.14159) < 0.0001)
})

test('module-scope: param shadows global', () => {
  is(run(`
    let x = 7
    export let f = (x) => x
  `).f(3), 3)
})

test('module-scope: local shadows global', () => {
  const { f, g } = run(`
    let x = 7
    export let f = () => { let x = 3; return x }
    export let g = () => x
  `)
  is(f(), 3)
  is(g(), 7)  // global x unchanged
})

test('Regression: negative literal index reads undefined, not heap (array + typed)', () => {
  // `a[-1]` once fell through the non-negative-literal fast path to a raw
  // `payload + (-1)*8` load that read heap *before* the allocation (a silent
  // info leak). A literal negative index is out of range → undefined (JS).
  // valTypeOf returns null for it too, so `=== undefined` isn't folded to false.
  const { arr, ta, deep, inb } = run(`
    export let arr = () => { let a = [10, 20, 30]; return a[-1] === undefined ? 7 : 9 }
    export let ta = () => { let a = new Float64Array(4); a[0] = 1.5; return a[-1] === undefined ? 7 : 9 }
    export let deep = () => { let a = [10, 20, 30]; return a[-3] === undefined ? 7 : 9 }
    export let inb = () => { let a = [10, 20, 30]; return a[1] }
  `)
  is(arr(), 7)
  is(ta(), 7)
  is(deep(), 7)
  is(inb(), 20)  // in-bounds read unchanged
})

test('Root F proof boundary: literal/masked indexes on static-length arrays stay unchecked; computed lengths stay checked', () => {
  // typedStaticLen rides the ctor tracker (multi-def invalidated); typedIdxProven
  // admits literals and `x & m` masks under it. The boundary is WAT-observable in
  // the exported fn: a proven read carries NO bounds compare (i32.lt_u) — watr may
  // inline __len, so the compare (not the call) is the stable observable.
  const fnWat = (src) => {
    const w = compile(src, { wat: true, optimize: 2 })
    return w.split(/(?=\(func \$)/).find(p => p.startsWith('(func $f')) || ''
  }
  const provenLit = fnWat(`const a = new Float64Array(4)
    export let f = () => { a[1] = 5; return a[0] + a[3] }`)
  ok(!/i32\.lt_u/.test(provenLit), 'literal idx < static len: unchecked')
  const provenMask = fnWat(`const a = new Float64Array(8)
    export let f = (x) => a[x & 7]`)
  ok(!/i32\.lt_u/.test(provenMask), 'x & 7 on len-8: unchecked')
  const unprovenMask = fnWat(`const a = new Float64Array(8)
    export let f = (x) => a[x & 8]`)
  ok(/i32\.lt_u/.test(unprovenMask), 'x & 8 on len-8 can reach 8: checked')
  const computed = fnWat(`export let f = (n, i) => { const a = new Float64Array(n); return a[i & 3] }`)
  ok(/i32\.lt_u/.test(computed), 'computed length: no static proof, checked')
  // stale-length hygiene: a sibling function\'s same-named local must not prove this one
  const sibling = run(`
    let g = () => { const a = new Float64Array(16); return a[9] }
    export let f = () => { const a = new Float64Array(4); let i = 9; return a[i & 15] === undefined ? -1 : 0 }
    export let both = () => g() + (f() === -1 ? 1 : 0)`)
  is(sibling.f(), -1)
  is(sibling.both(), 1)
})

test('Regression (Root F): RUNTIME-variable typed index — OOB reads undefined, OOB writes are ignored', () => {
  // The known-elem `.typed:[]` fast path emitted a raw `data + (i<<shift)` load/store
  // with NO bounds check for a runtime index: in-range-but-past-the-end silently read
  // or CORRUPTED adjacent heap; far indexes trapped. JS: typed OOB reads are
  // `undefined`, typed OOB writes are no-ops (the RHS still evaluates). The direct
  // unchecked form is now gated on the structural in-bounds proof (the canonical
  // `for (i=C; i<a.length; i++)` scan) — proven loops keep byte-identical emit — and
  // every unproven index takes the checked form (`i u< len`, negatives included).
  const { rd, wr, neigh, fx, loopSum } = run(`
    const a = new Float64Array(4)
    const b = new Float64Array(4)
    export let rd = (i) => { a[0] = 7; a[3] = 9; return a[i] === undefined ? -1 : a[i] }
    export let wr = (i, v) => { a[i] = v; return a[3] }
    export let neigh = (i, v) => { b[0] = 5; a[i] = v; return b[0] }
    export let fx = (i) => { let hit = 0; a[i] = (hit = 1, 42); return hit }
    export let loopSum = () => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k]; return s }
  `)
  is(rd(0), 7); is(rd(3), 9)
  is(rd(4), -1); is(rd(1e7), -1); is(rd(-1), -1)      // OOB / far / negative → undefined
  is(wr(3, 2.5), 2.5); is(wr(4, 111), 2.5)            // OOB write ignored, a[3] intact
  is(wr(1e7, 222), 2.5); is(wr(-2, 333), 2.5)
  is(neigh(4, 123.456), 5)                             // adjacent array NOT corrupted
  is(fx(1000), 1)                                      // RHS effects still run on OOB write
  is(loopSum(), 7 + 2.5)                               // proven loop reads all elements (a[3] was overwritten to 2.5)
})


// ES2024 Object.groupBy / Map.groupBy (2026-07-11, Ring 2): buckets are arrays
// in iteration order; Object.groupBy keys via ToPropertyKey (string), result is
// a dictionary; Map.groupBy keys by SameValueZero (objects stay identity keys).
test('groupBy: Object.groupBy / Map.groupBy', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => { let g = Object.groupBy([1,2,3,4], x => x % 2 ? "odd" : "even"); return g.odd.length * 10 + g.even.length }`), 22)
  is(j(`export let f = () => { let g = Object.groupBy([1,2,3,4,5], x => x < 3 ? "lo" : "hi"); return g.lo.join(",") + "|" + g.hi.join(",") }`), '1,2|3,4,5')
  is(j(`export let f = () => { let g = Object.groupBy([1,2,3], x => x % 2); return g[1].length * 10 + g[0].length }`), 21)  // numeric key → ToString
  is(j(`export let f = () => { let g = Map.groupBy([1,2,3,4], x => x % 2); return g.get(1).length * 10 + g.get(0).length }`), 22)
  is(j(`export let f = () => { let ka = {n:1}, kb = {n:2}; let g = Map.groupBy([1,2,3], x => x < 3 ? ka : kb); return g.get(ka).length * 10 + g.get(kb).length }`), 21)  // identity keys
  is(j(`export let f = () => Map.groupBy([], x => x).size`), 0)
  is(j(`export let f = () => { let t = new Float64Array([1,2,3]); return Map.groupBy(t, x => x > 1 ? 1 : 0).get(1).length }`), 2)  // typed source
})

// structuredClone (2026-07-11, Ring 2): deep arena clone — cycles terminate,
// diamond sharing (incl. a buffer shared by views) is preserved, Map keys AND
// values clone, Set/Map keep insertion order, Dates clone via their branded
// schema. Closures/host handles throw (DataCloneError). transfer is ignored.
test('structuredClone: deep copy + isolation', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => structuredClone(42.5)`), 42.5)
  is(j(`export let f = () => structuredClone("hey")`), 'hey')
  is(j(`export let f = () => structuredClone(true)`), true)
  is(j(`export let f = () => structuredClone(null)`), null)
  is(j(`export let f = () => { let a = [1,[2,3]]; let b = structuredClone(a); b[1][0] = 9; return a[1][0] }`), 2)
  is(j(`export let f = () => { let o = {x: 1, y: {z: 2}}; let c = structuredClone(o); c.y.z = 9; return o.y.z + c.x }`), 3)
  is(j(`export let f = () => { let o = {x: 5, y: "s"}; let c = structuredClone(o); return c.y + c.x }`), 's5')
})
test('structuredClone: identity — cycles and diamond sharing', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => { let a = [1]; a.push(a); let b = structuredClone(a); return (b[1] === b && b[1] !== a) ? "ok" : "broken" }`), 'ok')
  is(j(`export let f = () => { let inner = {v: 1}; let o = {a: inner, b: inner}; let c = structuredClone(o); c.a.v = 7; return c.b.v * 10 + inner.v }`), 71)
})
test('structuredClone: collections, dates, typed, buffers', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => { let s = new Set([3,1,2]); let c = structuredClone(s); s.add(9); return [...c].join(",") + ":" + c.size }`), '3,1,2:3')
  is(j(`export let f = () => { let m = new Map([["a",1],["b",2]]); let c = structuredClone(m); m.set("a", 9); return c.get("a") + c.size }`), 3)
  is(j(`export let f = () => { let k = {id: 1}; let m = new Map([[k, "v"]]); return structuredClone(m).has(k) ? "aliased" : "cloned" }`), 'cloned')
  is(j(`export let f = () => { let d = new Date(86400000); let c = structuredClone(d); c.setTime(0); return d.getTime() + c.getTime() }`), 86400000)
  is(j(`export let f = () => { let a = new Int32Array(3); a[0] = 7; let b = structuredClone(a); a[0] = 1; return b[0] + b.length }`), 10)
  // two views over one buffer: the clone shares ONE cloned buffer, source untouched
  is(j(`export let f = () => { let buf = new ArrayBuffer(8); let a = new Int32Array(buf, 0, 2), b = new Int32Array(buf, 4, 1); let c = structuredClone([a, b]); c[0][1] = 42; return c[1][0] + ":" + new Int32Array(buf, 4, 1)[0] }`), '42:0')
})
test('structuredClone: DataCloneError on functions', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => { let fn = (x) => x; try { structuredClone({fn}); return "no-throw" } catch (e) { return "threw" } }`), 'threw')
})

// Insertion-order Map/Set (spec: ES OrdinaryMap/Set iteration order): the seq
// packed into each entry's hash-word high bits + __coll_order. Host-exact:
// delete + re-add moves the key to the END; overwrite keeps position; a rehash
// (growth) preserves order.
test('collections: insertion-order iteration', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => { let s = new Set([1,2,3]); s.delete(2); s.add(2); return [...s].join(",") }`), '1,3,2')
  is(j(`export let f = () => { let m = new Map([["a",1],["b",2],["c",3]]); m.delete("a"); m.set("a",9); return [...m.keys()].join("") }`), 'bca')
  is(j(`export let f = () => { let m = new Map([["a",1],["b",2]]); m.set("a",9); return [...m.keys()].join("") }`), 'ab')
  is(j(`export let f = () => { let s = new Set(["z","a","m"]); let r = ""; s.forEach(v => r += v); return r }`), 'zam')
  is(j(`export let f = () => { let s = new Set(); for (let i = 19; i >= 0; i--) s.add(i); return [...s].slice(0,5).join(",") }`), '19,18,17,16,15')
})

// Review pins: spec IsCallable throw (GroupBy step 2, before iteration); boolean
// identity of jzify-synthesized instanceof predicates (__is_map is VAL.BOOL, so
// `=== true` compares booleans, not a raw 0/1 carrier vs the TRUE atom); dates'
// branded schema keeps dynamic reads clean (aux=0 used to alias schema id 0).
test('groupBy: non-callable callback throws before iterating', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => { try { Object.groupBy([1], null); return "no" } catch (e) { return "threw" } }`), 'threw')
  is(j(`export let f = () => { try { Map.groupBy([1], undefined); return "no" } catch (e) { return "threw" } }`), 'threw')
})
test('instanceof predicate is a real boolean', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => { let m = Map.groupBy([1], i => "k"); return (m instanceof Map) === true ? "y" : "n" }`), 'y')
  is(j(`export let f = () => { let s = new Set([1]); return (s instanceof Set) === true && (s instanceof Map) === false ? "y" : "n" }`), 'y')
})
test('date dynamic property read is undefined (branded schema)', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => { let d = new Date(5); let k = "x"; return d[k] === undefined ? "undef" : "leak" }`), 'undef')
})

// delete on a dictionary-mode object: the receiver IS its own storage — __dyn_del
// deletes its entry table directly (every other arm probes the props sidecar,
// which dictionaries don't use; the key silently survived before). Enum cache
// invalidates; re-added keys move to the end (host order).
test('dictionary delete: removes own entries', () => {
  const j = (code, ...a) => jz(code).exports.f(...a)
  is(j(`export let f = (k) => { let d = {}; d[k] = 1; delete d[k]; return d[k] === undefined ? "gone" : "still" }`, 'a'), 'gone')
  is(j(`export let f = (k, k2) => { let d = {}; d[k] = 1; d[k2] = 2; delete d[k]; return JSON.stringify(d) }`, 'a', 'b'), '{"b":2}')
  is(j(`export let f = (k, k2) => { let d = {}; d[k] = 1; d[k2] = 2; delete d[k]; d[k] = 9; return Object.keys(d).join(",") + "=" + d[k] }`, 'a', 'b'), 'b,a=9')
  is(j(`export let f = (k, k2) => { let d = {}; d[k] = 1; d[k2] = 2; let r = ""; for (let x in d) r += x; delete d[k]; for (let x in d) r += "|" + x; return r }`, 'a', 'b'), 'ab|b')
})

// Probe hash-lane integrity (collection.js): every table carries an i32 hash
// lane after its entries — the only thing probes walk — maintained by insert,
// grow-rehash, backward-shift delete, .clear and Map-from-pairs (the ctor that
// once allocated LANE-LESS and let inserts write past the table: entries
// "vanished" because probes read a foreign lane). Churn all of those paths and
// compare against the host verbatim.
test('hash lane: churn (from-pairs, delete-shift, grow, clear, dict) matches host', () => {
  const SRC = `export let f = () => {
    let out = ''
    // Map from pairs (the lane-less-alloc regression), then grow past 75%
    let m = new Map([['k0', 0], ['k1', 1]])
    for (let i = 2; i < 40; i++) m.set('k' + i, i)
    out += m.get('k0') + ',' + m.get('k25') + ',' + m.size
    // delete every third key — backward-shift must carry lane words
    for (let i = 0; i < 40; i += 3) m.delete('k' + i)
    out += '|' + m.size + ',' + (m.get('k3') === undefined) + ',' + m.get('k4')
    // reinsert over the shifted table, then grow again
    for (let i = 40; i < 80; i++) m.set('k' + i, i * 2)
    out += '|' + m.get('k70') + ',' + m.get('k1') + ',' + m.size
    // clear zeroes lane + entries
    m.clear()
    m.set('kz', 9)
    out += '|' + m.size + ',' + m.get('kz')
    // dictionary-mode object: same table family via __hash_*
    let d = {}
    for (let i = 0; i < 50; i++) d['w' + i] = i
    for (let i = 0; i < 50; i += 7) delete d['w' + i]
    let s = 0
    for (let k in d) s = s + d[k]
    out += '|' + s + ',' + (d.w7 === undefined) + ',' + d.w8
    // Set: add/delete/has across growth
    let st = new Set()
    for (let i = 0; i < 30; i++) st.add(i * 3)
    for (let i = 0; i < 30; i += 2) st.delete(i * 3)
    out += '|' + st.size + ',' + st.has(3) + ',' + st.has(6)
    return out
  }`
  const host = new Function(SRC.replace('export let f', 'let f') + '; return f()')()
  const { exports, memory } = jz(SRC)
  const got = exports.f()
  is(typeof got === 'bigint' ? memory.read(got) : got, host)
})

// --- ToNumber discipline for undefined through compound assignment ---
// UNDEF is a quiet-NaN payload; raw f64.add propagates it to the boundary where
// it decodes back as `undefined` (JS: NaN). compoundAssign routes both operands
// through toNumF64; the plain-array inline checked read tags checkedNumRead so
// the miss arm folds to canonical NaN (module/array.js).
test('compound assign: undefined operands coerce to NaN, never leak the sentinel', () => {
  const m = run(`
    export let oobAcc = () => { const a = [1, 2]; let s = 0; s += a[5]; return s }
    export let undefVar = () => { let u; let s = 0; s += u; return s }
    export let undefLhs = () => { let s; s += 1; return s }
  `)
  ok(Number.isNaN(m.oobAcc()), 'a[oob] += accumulates to NaN')
  ok(Number.isNaN(m.undefVar()), 'uninitialized rhs coerces to NaN')
  ok(Number.isNaN(m.undefLhs()), 'uninitialized lhs coerces to NaN')
  // PARKED (maybe-miss i32-cell class, .work/archive/todo.md): `let s=0; for(i<7) s+=a[i]`
  // over len-3 — the i32-narrowed accumulator trunc_sats the miss's NaN to 0.
  // The emit-time widen pass that fixes this is parked with its patch — it
  // entangles with the arrayElemRange fixpoint convergence bug (vm row).
})

// --- i32 cell typing requires proven-in-bounds reads (exprType [] gate) ---
// A maybe-miss read is number|undefined; an i32 accumulator cell trunc_sats the
// NaN to 0. Proven shapes (canonical loop pair, literal idx vs static length)
// must KEEP the fast i32 path — only unproven reads widen.
test('int elem reads: proven shapes stay i32-exact', () => {
  // PARKED (maybe-miss i32-cell class, .work/archive/todo.md): the u8oob variant
  // (`for(i<7) s+=u8[i]` over len 3 → NaN) and the oobDecl variant
  // (`const x = a[5]` OOB → x must stay undefined, not trunc-sat 0) both
  // require the emit-time widen pass parked with the miss-class patch.
  const m = run(`
    export let u8sum = () => { const a = new Uint8Array(3); a[0]=5; a[1]=6; a[2]=7; let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s }
    export let i32lit = () => { const a = new Int32Array(4); a[3]=9; return a[3] + a[0] }
  `)
  is(m.u8sum(), 18)
  is(m.i32lit(), 9)
})

// --- closure-visible array mutation rejects the static-length fact ---
// inferInternalArrayLengths (narrow.js) must see into arrows: a captured push
// undercounts (stale .length folds), a captured pop OVERcounts — bounds proofs
// from the stale fact would justify raw reads past the real end.
test('internal array length: arrow-captured mutation rejects the fact, values stay JS-exact', () => {
  const m = run(`
    const grow = () => { const a = [1]; const g = () => a.push(7); g(); return a }
    const shrink = () => { const a = [1, 2, 3, 4, 5, 6, 7]; const g = () => { a.pop() }; g(); g(); return a }
    export let growLen = () => { const A = grow(); return A.length }
    export let growTail = () => { const A = grow(); return A[A.length - 1] }
    export let shrinkLen = () => { const B = shrink(); return B.length }
    export let shrinkSum = () => { const B = shrink(); let s = 0; for (let i = 0; i < 7; i++) s += B[i]; return s }
  `)
  is(m.growLen(), 2)
  is(m.growTail(), 7)
  is(m.shrinkLen(), 5)
  ok(Number.isNaN(m.shrinkSum()), 'reads past the popped end are undefined -> NaN, not stale cells')
})

// PARKED (maybe-miss call-arg class, .work/archive/todo.md): `use(u8[oob])` — the i32
// param spec trunc_sats the UNDEF box at the boundary (callee sees 0/1; JS:
// undefined/NaN). The argWasmType veto + missArg param coercion are parked in
// the miss-class patch alongside the cell-widen pass.

// --- closed heterogeneous-record union: guard-free devirt stays JS-exact ---
// The tagged-union chain (closed elem-schema set -> discriminant census incl.
// the mask-excluded trailing else -> proof refinement) must keep exact values
// through build/measure, and an ALIASED (open) array must stay dynamic-correct.
test('closed-union tagged records: exact values, trailing-else variant, open-array fallback', () => {
  const SRC = `
    const initRows = () => {
      const rows = []
      let s = 0x1234abcd | 0
      for (let i = 0; i < 512; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5
        const k = s & 3
        const a = (s >>> 3) & 255, b = (s >>> 13) & 255
        if (k === 0) rows.push({ k: k, x: a, y: b })
        else if (k === 1) rows.push({ k: k, r: a })
        else if (k === 2) rows.push({ k: k, w: a, h: b })
        else rows.push({ k: k, n: a, s: b })
      }
      return rows
    }
    const measure = (o) => {
      const k = o.k
      if (k === 0) return (o.x + o.y) | 0
      else if (k === 1) return Math.imul(o.r, 3)
      else if (k === 2) return Math.imul(o.w, o.h)
      return Math.imul(o.n, o.s)
    }
    const runKernel = (rows) => {
      let h = 0
      for (let it = 0; it < 3; it++) { let sum = it | 0; for (let i = 0; i < rows.length; i++) sum = (sum + measure(rows[i])) | 0; h = (Math.imul(h, 31) + sum) | 0 }
      return h
    }
    export let main = () => runKernel(initRows())
  `
  const host = new Function(SRC.replace('export let main =', 'const main =').replace(/const /g, 'var ') + '; return main()')()
  is(run(SRC).main(), host)
})

// --- dict-use walkers terminate + stay JS-exact (leanDictUse/i32DictUse/dictDomain) ---
// These three analyzeBody gates (lean-hash, i32-histogram, domain-cap) were
// nested self-recursive closures with heavy capture — the exact shape the
// SELF-COMPILED kernel miscompiled into infinite recursion (bool-identity leg
// red, bisected to 83d6add5). Rewritten as module-scope iterative worklists.
// The kernel-leg bool-identity test is the recursion pin (native never hung);
// this differential pins that the iterative verdicts keep values JS-exact.
test('dict-use idioms: lean-hash, i32-histogram, domain-keyed all JS-exact', () => {
  const m = run(`
    export let lean = (n) => { let h = {}; for (let i = 0; i < n; i++) { let k = 'x' + i; h[k] = i * i }; let s = 0; for (let i = 0; i < n; i++) { let k = 'x' + i; s += h[k] }; return s }
    export let hist = (n) => { let d = {}; for (let i = 0; i < n; i++) { let k = 'w' + (i & 7); d[k] = (d[k] | 0) + 1 }; let s = 0; for (let i = 0; i < 8; i++) s = (s + (d['w' + i] | 0)) | 0; return s }
    export let domain = (n) => { let ks = ['p', 'q', 'r']; let o = {}; for (let i = 0; i < 3; i++) o[ks[i]] = i + 1; let s = 0; for (let i = 0; i < 3; i++) s += o[ks[i]]; return s }
  `)
  const host = new Function(`
    return {
      lean: (n) => { let h = {}; for (let i = 0; i < n; i++) { let k = 'x' + i; h[k] = i * i }; let s = 0; for (let i = 0; i < n; i++) { let k = 'x' + i; s += h[k] }; return s },
      hist: (n) => { let d = {}; for (let i = 0; i < n; i++) { let k = 'w' + (i & 7); d[k] = (d[k] | 0) + 1 }; let s = 0; for (let i = 0; i < 8; i++) s = (s + (d['w' + i] | 0)) | 0; return s },
      domain: (n) => { let ks = ['p', 'q', 'r']; let o = {}; for (let i = 0; i < 3; i++) o[ks[i]] = i + 1; let s = 0; for (let i = 0; i < 3; i++) s += o[ks[i]]; return s },
    }`)()
  is(m.lean(20), host.lean(20))
  is(m.hist(50), host.hist(50))
  is(m.domain(3), host.domain(3))
})

// dyn-prop KEYING: a PLAIN (non-self-referencing) write to an i32-lean HASH
// local — ledger 2026-07-29, repro B's root. dictWalkI32 (analyze.js) proves
// a dict-mode HASH local "lean" (values stored as raw i32 in the low 32 bits,
// not NaN-boxed f64) whenever every WRITE is a discarded statement and every
// READ is immediately bitwise-coerced — `counts[k] = 7` (a literal RHS, no
// self-read) satisfies that exactly as much as `counts[k] = (counts[k]|0)+1`
// does, but only the RMW-fusion emitter (`o[k]=f(o[k])`, emit-assign.js
// tryHashRmwFusion) honored the lean contract on write; a plain write (RMW
// fusion declines — no self-reference to fuse) fell through to the generic
// __dyn_set path, which always stores a full NaN-boxed f64. The lean READ's
// bare `i32.wrap_i64` then saw the f64 box's low word (0 for any small
// integer value) instead of the raw i32 — `counts[k]=7; return counts[k]|0`
// silently read 0. Fixed in dynSetCall (emit-assign.js), the single choke
// point every generic HASH write (proven-string-key and unproven-key alike)
// routes through: it now stores `i64.extend_i32_u(asI32(value))` instead of
// the f64 box whenever the receiver is i32HashLocals-proven lean.
test('dyn-keys: plain (non-RMW) write to an i32-lean HASH local is readable', () => {
  is(run(`export let f = () => {
    let k = 'cd'
    let counts = {}
    counts[k] = 7
    return counts['cd'] | 0
  }`).f(), 7)
  // 2-hop cross-call variant (repro B): the write is a plain assignment in the
  // OUTER function; the read is inlined from a DIFFERENT function (probe) —
  // same lean contract, must still agree.
  is(run(`let build = () => { let ws = []; ws.push('ab'); ws.push('cd'); return ws }
    let probe = (counts, keys) => counts[keys[1]] | 0
    export let f = () => {
      let words = build()
      let picks = []
      for (let i = 0; i < 2; i++) picks.push(words[i])
      let counts = {}
      counts[words[1]] = 7
      return probe(counts, picks)
    }`).f(), 7)
})

test('RepresentationPlan: Map storage preserves dynamic BigInt keys and values', () => {
  const src = `
    export let vkind = flag => {
      let m = new Map()
      m.set('k', flag ? 5n : 2)
      return typeof m.get('k')
    }
    export let kget = flag => {
      let m = new Map()
      m.set(flag ? 7n : 7, 'seen')
      return m.get(flag ? 7n : 7) === 'seen'
    }
    export let khas = flag => {
      let m = new Map()
      m.set(flag ? 7n : 7, 1)
      return m.has(flag ? 7n : 7) ? 1 : 0
    }
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    is(e.vkind(0), 'number', `O${optimize || 0}: Number map value`)
    is(e.vkind(1), 'bigint', `O${optimize || 0}: BigInt map value stored tagged`)
    is(e.kget(0), true, `O${optimize || 0}: Number key round-trips`)
    is(e.kget(1), true, `O${optimize || 0}: BigInt key round-trips through get`)
    is(e.khas(0), 1, `O${optimize || 0}: Number key probes`)
    is(e.khas(1), 1, `O${optimize || 0}: BigInt key probes through has`)
  }
})

test('RepresentationPlan: Set membership preserves dynamic BigInt members', () => {
  const src = `
    export let member = flag => {
      let s = new Set()
      s.add(flag ? 9n : 9)
      return s.has(flag ? 9n : 9) ? 1 : 0
    }
    export let cross = flag => {
      let s = new Set()
      s.add(flag ? 9n : 9)
      return s.has(flag ? 9 : 9n) ? 1 : 0
    }
    export let del = flag => {
      let s = new Set()
      s.add(flag ? 9n : 9)
      s.delete(flag ? 9n : 9)
      return s.size
    }
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    is(e.member(0), 1, `O${optimize || 0}: Number member probes`)
    is(e.member(1), 1, `O${optimize || 0}: BigInt member probes`)
    is(e.cross(0), 0, `O${optimize || 0}: 9n stored, 9 probed - SameValueZero distinguishes`)
    is(e.cross(1), 0, `O${optimize || 0}: 9 stored, 9n probed - SameValueZero distinguishes`)
    is(e.del(0), 0, `O${optimize || 0}: Number member deletes`)
    is(e.del(1), 0, `O${optimize || 0}: BigInt member deletes`)
  }
})

test('RepresentationPlan: array mutators preserve dynamic BigInt values', () => {
  const src = `
    export let viaPush = flag => {
      let a = []
      a.push(flag ? 5n : 2)
      return typeof a[0]
    }
    export let viaPushMulti = flag => {
      let a = []
      a.push(1, flag ? 5n : 2, 3)
      return typeof a[1]
    }
    export let viaUnshift = flag => {
      let a = [0]
      a.unshift(flag ? 5n : 2)
      return typeof a[0]
    }
    export let viaUnshiftMulti = flag => {
      let a = [0]
      a.unshift(flag ? 5n : 2, 9)
      return typeof a[0]
    }
    export let viaFill = flag => {
      let a = [0, 0]
      a.fill(flag ? 5n : 2)
      return typeof a[1]
    }
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    for (const name of ['viaPush', 'viaPushMulti', 'viaUnshift', 'viaUnshiftMulti', 'viaFill']) {
      is(e[name](0), 'number', `O${optimize || 0}: ${name} Number member`)
      is(e[name](1), 'bigint', `O${optimize || 0}: ${name} BigInt member stored tagged`)
    }
  }
})

test('RepresentationPlan: JSON.stringify throws on dynamic BigInt in every position', () => {
  const src = `
    export let bare = flag => { try { return JSON.stringify(flag ? 5n : 2) } catch (e) { return "threw" } }
    export let inObj = flag => { try { return JSON.stringify({v: flag ? 5n : 2}) } catch (e) { return "threw" } }
    export let inArr = flag => { try { return JSON.stringify([flag ? 5n : 2]) } catch (e) { return "threw" } }
    export let nested = flag => { try { return JSON.stringify({a: [1, {b: flag ? 5n : 2}]}) } catch (e) { return "threw" } }
    export let uncaught = () => JSON.stringify(9n)
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    is(e.bare(0), '2', `O${optimize || 0}: bare Number serializes`)
    is(e.bare(1), 'threw', `O${optimize || 0}: bare BigInt throws`)
    is(e.inObj(0), '{"v":2}', `O${optimize || 0}: object Number serializes`)
    is(e.inObj(1), 'threw', `O${optimize || 0}: object BigInt throws`)
    is(e.inArr(1), 'threw', `O${optimize || 0}: array BigInt throws`)
    is(e.nested(0), '{"a":[1,{"b":2}]}', `O${optimize || 0}: nested Number serializes`)
    is(e.nested(1), 'threw', `O${optimize || 0}: nested BigInt throws`)
    // host boundary decodes the code to the real TypeError class + message
    let caught = null
    try { e.uncaught() } catch (err) { caught = err }
    ok(caught instanceof TypeError, `O${optimize || 0}: host boundary TypeError`)
    ok(String(caught.message).includes('BigInt'), `O${optimize || 0}: host boundary message`)
  }
})

test('tagged-union strict equality: a non-BigInt member never bit-collides with a raw BigInt (re-audit P0)', () => {
  // A plan-MATERIALIZED union local (every BigInt member boxed): its Number
  // member must never compare strictly equal to a BigInt by bit collision —
  // tagged Number 0's bits equal raw 0n's payload, Number.MIN_VALUE's equal
  // 1n's. The proven-tagged compare arm short-circuits non-box members to
  // FALSE; OPEN operands (raw BigInt possible) never take that arm and keep
  // the documented raw-carrier bits semantics on the dynamic path.
  for (const optimize of [false, 2, 3]) {
    const e = jz(`
      export let f = (flag) => { let value = flag ? 1n : 0; return value === 0n }
      export let g = (flag) => { let value = flag ? 1n : 0; return value === 1n }
      export let h = (flag) => { let value = flag ? 1n : Number.MIN_VALUE; return value === 1n }
    `, { optimize }).exports
    is(e.f(0), false, `O${optimize || 0}: Number 0 !== 0n (zero-bits collision)`)
    is(e.f(1), false, `O${optimize || 0}: 1n !== 0n`)
    is(e.g(1), true, `O${optimize || 0}: 1n === 1n through the box`)
    is(e.g(0), false, `O${optimize || 0}: Number 0 !== 1n`)
    is(e.h(0), false, `O${optimize || 0}: MIN_VALUE !== 1n (subnormal collision)`)
    is(e.h(1), true, `O${optimize || 0}: 1n === 1n beside a subnormal arm`)
  }
})

test('equality folds preserve operand effects, in source order (re-audit P0)', () => {
  // JS sequences operand evaluation before comparing — a statically-decided
  // fold (differing primitives, non-nullable vs sentinel, tagged-union
  // dispatch) must still evaluate effectful operands exactly once, in
  // order. Pure operands (names/literals) keep the zero-cost constant.
  // O3 runs the same value asserts since the C5 hoisted-temp fix: the O3
  // inliner's expression-position hoist wrapped its temp as the boxed-literal
  // shape `[null, tmp]`, which erased the temp's bigint kind (valTypeOf read
  // it as a literal) and dodged the C3 tag dispatch — value === bump()
  // compared raw carrier bits, colliding tagged Number 0 with 0n. The bare-
  // name hoist restores kind + plan resolution for the temp like any local.
  for (const optimize of [false, 2, 3]) {
    const e = jz(`
      let n = 0
      function bump() { n = n + 1; return 0n }
      export let f = (flag) => { let value = flag ? 1n : 0; return value === bump() }
      export let frev = (flag) => { let value = flag ? 1n : 0; return bump() === value }
      export let count = () => n
    `, { optimize }).exports
    is(e.f(0), false, `O${optimize || 0}: tagged-Number vs 0n compares false`)
    is(e.count(), 1, `O${optimize || 0}: raw-side effect ran (left operand tagged)`)
    is(e.frev(0), false, `O${optimize || 0}: reversed order compares false`)
    is(e.count(), 2, `O${optimize || 0}: raw-side effect ran (right operand tagged)`)
    const d = jz(`
      let m = 0
      function bump2() { m = m + 1; return 5 }
      export let g = () => { let s = 'a'; return s === bump2() }
      export let mc = () => m
    `, { optimize }).exports
    is(d.g(), false, `O${optimize || 0}: differing-primitive fold false`)
    is(d.mc(), 1, `O${optimize || 0}: differing-primitive fold still evaluated the call`)
    const s = jz(`
      let k = 0
      function mk() { k = k + 1; return 7 }
      export let h = () => mk() === null
      export let kc = () => k
    `, { optimize }).exports
    is(s.h(), false, `O${optimize || 0}: non-nullable vs null folds false`)
    is(s.kc(), 1, `O${optimize || 0}: sentinel fold still evaluated the call`)
  }
})

test('bigint: inlined mixed-entry callee keeps tag discipline (C5 gnorm probe)', () => {
  // The banked 2-export shape (.work/archive/phase-c-unification.md §inlined-union):
  // gnorm's result is a string|number-entry union with bigint via body write.
  // With few exports the callee is an inline candidate — the union must keep
  // its materialization (tag discipline) whether the call is kept or inlined,
  // and the host boundary must decode a real lossless BigInt either way.
  const gnorm = `export let gnorm = (n) => { if (typeof n === 'string') n = BigInt(n); return n }\n`
  const two = gnorm + `export let geq = (x) => gnorm(x) === 9n`
  const five = gnorm + `export let geq = (x) => gnorm(x) === 9n
    export let ga = (x) => gnorm(x)
    export let gb = (x) => gnorm(x)
    export let gc = (x) => gnorm(x)`
  for (const optimize of [false, 2, 3]) for (const [label, src] of [['2exp', two], ['5exp', five]]) {
    const e = jz(src, { optimize }).exports
    is(e.geq('9'), true, `O${optimize || 0} ${label}: string entry converts, 9n === 9n`)
    is(e.geq(9), false, `O${optimize || 0} ${label}: number entry stays number, 9 !== 9n`)
    const a = e.gnorm('7')
    ok(typeof a === 'bigint' && a === 7n, `O${optimize || 0} ${label}: bigint crosses typed`)
    is(e.gnorm(7), 7, `O${optimize || 0} ${label}: number path unboxed`)
    const big = e.gnorm('9007199254740993')
    ok(typeof big === 'bigint' && big === 9007199254740993n, `O${optimize || 0} ${label}: lossless past 2^53`)
    // Negative sign coverage (test/inference.js's negative-host-BigInt-
    // ingress fix is a DIFFERENT seam — interop.js isBox misclassifying a
    // raw negative host BigInt argument — than this string-parse path
    // exercises: BigInt('-7') negates inside wasm, module/number.js
    // __to_bigint's own `$neg` two's-complement branch, never touching
    // isBox/mem.BigInt at all. Pinned here so the C5 gnorm family carries
    // full sign coverage alongside the positive/lossless cases above.
    const neg = e.gnorm('-7')
    ok(typeof neg === 'bigint' && neg === -7n, `O${optimize || 0} ${label}: negative bigint string crosses typed`)
    const bigNeg = e.gnorm('-9007199254740993')
    ok(typeof bigNeg === 'bigint' && bigNeg === -9007199254740993n, `O${optimize || 0} ${label}: negative lossless past 2^53`)
  }
})

test('bigint: ANONYMOUS direct-return union join materializes (C5b — was KNOWN-WRONG)', () => {
  // C5's fixpoint (representation-plan.js buildBodyData, materializedJoins) only
  // ever admitted a join reached through a NAMED LOCAL (`let value = flag ? 1n :
  // 0; return value` — the gnorm-adjacent shape above, and the tagged-equality
  // test below). `directResultNodes` unconditionally excluded any join that IS
  // itself the return/expression-body result, so an ANONYMOUS direct-return
  // union never reached materializedJoins: representationJoinArmAction
  // rejected both arms, the '?:' emitter fell through to the raw select/if
  // path, and 1n's raw i64 bits crossed unboxed — the host read them
  // reinterpreted as a plain f64 (1n's bits, 0x1, read as the subnormal
  // Number.MIN_VALUE, 5e-324) — never a real BigInt. Wrong at EVERY
  // optimization level (a plan-time gap, not an optimizer artifact).
  //
  // Fix: a join's position (direct result / named-local RHS / any other
  // operand) doesn't gate materialization — the fixpoint now admits ANY
  // eligible '?:'/'&&'/'||'/'??' node regardless of where its value flows.
  // representationResultTagRequired's exprMayBox also consults
  // materializedJoins directly (ground truth) instead of only guessing from
  // unresolved arm recursion, so the export lane routes the generic decode
  // precisely rather than by coincidence of the boundary-current fallback.
  for (const optimize of [false, 2, 3]) {
    const t = jz(`export let g = (flag) => flag ? 1n : 0`, { optimize }).exports
    ok(typeof t.g(1) === 'bigint' && t.g(1) === 1n, `O${optimize || 0}: direct-return '?:' 1n arm crosses typed`)
    is(t.g(0), 0, `O${optimize || 0}: the Number 0 arm stays a Number`)

    const big = jz(`export let g = (flag) => flag ? 9007199254740993n : 0`, { optimize }).exports
    ok(typeof big.g(1) === 'bigint' && big.g(1) === 9007199254740993n, `O${optimize || 0}: direct-return '?:' lossless past 2^53`)
    is(big.g(0), 0, `O${optimize || 0}: the Number 0 arm stays a Number (lossless variant)`)

    // '||'/'&&'/'??' materialize the same way — none had ANY box-application
    // wiring before this slice (not even through a named local), a larger gap
    // than '?:'s alone. Each arm doubles as condition-tested value for these
    // three (unlike '?:'s separate condition slot), so a bare open param arm
    // can't trivially prove its own carrier — these use a literal-producing
    // sub-expression on the non-bigint side, mirroring '?:'s own literal arm.
    const o = jz(`export let g = (flag) => (flag ? 0 : 5) || 1n`, { optimize }).exports
    ok(typeof o.g(1) === 'bigint' && o.g(1) === 1n, `O${optimize || 0}: direct-return '||' 1n arm crosses typed`)
    is(o.g(0), 5, `O${optimize || 0}: '||' Number arm stays a Number`)

    const a = jz(`export let g = (flag) => (flag ? 5 : 0) && 1n`, { optimize }).exports
    ok(typeof a.g(1) === 'bigint' && a.g(1) === 1n, `O${optimize || 0}: direct-return '&&' 1n arm crosses typed`)
    is(a.g(0), 0, `O${optimize || 0}: '&&' Number arm stays a Number`)

    const n = jz(`export let g = (flag) => (flag ? 1n : null) ?? 5`, { optimize }).exports
    ok(typeof n.g(1) === 'bigint' && n.g(1) === 1n, `O${optimize || 0}: direct-return '??' 1n arm crosses typed`)
    is(n.g(0), 5, `O${optimize || 0}: '??' Number arm stays a Number`)
  }
})

test('bigint: C5b adjacent join gaps — bare params, nested nullish unions, and raw-specialized callees', () => {
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`

    const open = jz(`function choose(flag, n) { return flag ? 1n : n }
      export let big = () => choose(1, 0)
      export let num = () => choose(0, 0)`, { optimize }).exports
    is(open.big(), 1n, `${lbl}: precise non-BigInt param arm no longer injects a BOOL veto`)
    is(open.num(), 0, `${lbl}: bare Number param arm stays Number`)

    const nested = jz(`export let f = flag => (flag ? null : 5) ?? 1n`, { optimize }).exports
    is(nested.f(1), 1n, `${lbl}: nested nullish-vs-Number join materializes its BigInt outer arm`)
    is(nested.f(0), 5, `${lbl}: nested Number arm stays Number`)

    const specialized = jz(`function choose(flag, n) { return flag ? 1n : n }
      export let boxed = () => choose(1, 0)
      export let raw = () => choose(0, 2n)
      export let number = () => choose(0, 0)`, { optimize }).exports
    is(specialized.boxed(), 1n, `${lbl}: boxed specialized caller crosses tagged`)
    is(specialized.raw(), 2n, `${lbl}: raw-specialized callee result keeps raw boundary ABI`)
    is(specialized.number(), 0, `${lbl}: Number specialization stays Number`)
  }
})

test('bigint: storage-read box-pointer-bits leak through a reassigned param across a call (shape #6 — was corrupt)', () => {
  // .work/archive/phase-c-unification.md §"Shape #6": a storage-read BigInt (array
  // .at()/.get()/.pop()/.shift()) feeding a PARAM that's then REASSIGNED via
  // a compound op (`n >>= 7n`) and passed to a SECOND function doing
  // LEB128-style bitwise consumption — the exact shape CI's watr leg hit
  // (test/official/memory64.wast data-segment offset garbage; watr's own
  // encode.js i64() does this same read->param->shift->consume chain).
  // Pre-fix, the callee's reassigned param never entered its OWN
  // materializedNames (five compounding gaps in representation-plan.js: 1-2
  // currentOf/plannedOf/edgeMaterializable didn't recognize the full
  // STORAGE_READ_METHODS set as boxed-by-construction; 3 same gap for plain
  // []/.member reads; 4 the readiness gate rejected every compound-assign
  // def outright; 5 a covered callee's OWN boundary semantic inherited an
  // uninformative "any of 14 kinds, closed" legacy census answer for a
  // storage-read call argument, tripping the BOOL-member veto permanently —
  // plus two emission-side companions: the bitwise/arithmetic compound-
  // assign write-back never boxed a materialized target, and coerceArg
  // gated its UNBOX/BOX application behind valTypeOf(node), which is
  // deliberately blind to storage-read call-member nodes). Silent result:
  // the BOX POINTER BITS (a small heap offset under a PTR.BIGINT NaN-box
  // tag, not the unboxed i64 payload) got shifted/masked as if they were
  // the raw value.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const e = jz(`
      function leb(n) {
        let bytes = []
        while (true) {
          let byte = Number(n & 0x7Fn)
          n >>= 7n
          if (n === 0n) { bytes.push(byte); break }
          bytes.push(byte | 0x80)
        }
        return bytes.length
      }
      export let f = (i) => {
        let arr = []
        arr.push(0n)
        arr.push(624485n)
        return leb(arr.at(i))
      }
      export let g = (i) => {
        let arr = []
        arr.push(0n)
        arr.push(900n)
        let n = arr.at(i)
        n >>= 7n
        return n
      }
    `, { optimize }).exports
    is(e.f(1), 3, `${lbl}: LEB128 byte count through storage-read -> reassigned param -> cross-function bitwise consumption (was: box-pointer-bits garbage)`)
    ok(typeof e.g(1) === 'bigint' && e.g(1) === 7n, `${lbl}: single-function storage-read + reassign crosses as real 7n, never box-pointer bits`)
  }
})

test('bigint: storage-read method-family sweep — get/pop/shift/at/[]/.member compound-reassign across a call (shape #6)', () => {
  // Every STORAGE_READ_METHODS member plus the plain []/.member producer
  // (representation-plan.js's memberReceiver shape) x a compound
  // reassignment (`n >>= 7n`) x both a same-function local and a
  // cross-function (covered, reassigned) param. 900n >> 7n === 7n for every
  // cell. Pinned as one family so a regression in any single producer shape
  // shows up immediately, matching this fixpoint's own discipline
  // (.work/archive/phase-c-unification.md's falsified-predicate-forms note).
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const single = (setup, read) => `export let f = (i) => { ${setup}; let n = ${read}; n >>= 7n; return n }`
    const cross = (setup, read) => `
      export let leb = (n) => n
      function g(n) { n >>= 7n; return leb(n) }
      export let f = (i) => { ${setup}; return g(${read}) }`
    const bigOk = (v) => typeof v === 'bigint' && v === 7n

    const setupM = `let m = new Map(); m.set(0, 0n); m.set(1, 900n)`
    ok(bigOk(jz(single(setupM, 'm.get(i)'), { optimize }).exports.f(1)), `${lbl}: get() single-function`)
    ok(bigOk(jz(cross(setupM, 'm.get(i)'), { optimize }).exports.f(1)), `${lbl}: get() cross-function`)

    const setupPop = `let arr = []; arr.push(0n); arr.push(900n)`
    ok(bigOk(jz(single(setupPop, 'arr.pop()'), { optimize }).exports.f(0)), `${lbl}: pop() single-function`)
    ok(bigOk(jz(cross(setupPop, 'arr.pop()'), { optimize }).exports.f(0)), `${lbl}: pop() cross-function`)

    const setupShift = `let arr = []; arr.push(900n); arr.push(0n)`
    ok(bigOk(jz(single(setupShift, 'arr.shift()'), { optimize }).exports.f(0)), `${lbl}: shift() single-function`)
    ok(bigOk(jz(cross(setupShift, 'arr.shift()'), { optimize }).exports.f(0)), `${lbl}: shift() cross-function`)

    const setupAt = `let arr = []; arr.push(0n); arr.push(900n)`
    ok(bigOk(jz(single(setupAt, 'arr.at(i)'), { optimize }).exports.f(1)), `${lbl}: at() single-function`)
    ok(bigOk(jz(cross(setupAt, 'arr.at(i)'), { optimize }).exports.f(1)), `${lbl}: at() cross-function`)
    ok(bigOk(jz(single(setupAt, 'arr[i]'), { optimize }).exports.f(1)), `${lbl}: [] single-function`)
    ok(bigOk(jz(cross(setupAt, 'arr[i]'), { optimize }).exports.f(1)), `${lbl}: [] cross-function`)

    const setupObj = `let obj = {}; obj.v = 900n`
    ok(bigOk(jz(single(setupObj, 'obj.v'), { optimize }).exports.f(0)), `${lbl}: .member single-function`)
    ok(bigOk(jz(cross(setupObj, 'obj.v'), { optimize }).exports.f(0)), `${lbl}: .member cross-function`)
  }
})

test('bigint: ++/-- on a covered-function param uses RepresentationPlan provenance (shape #6)', () => {
  // valTypeOf(name) is deliberately local and can stay unknown for a covered,
  // reassigned param. representationCompoundAssignAction is the frozen
  // whole-program proof that the binding is materialized BigInt; ++/-- must
  // consult it just like the other compound assignments.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const e = jz(`
      function g(n) { n++; return n }
      function h(n) { n--; return n }
      export let f = () => { let arr = []; arr.push(900n); return g(arr.pop()) }
      export let d = () => { let arr = []; arr.push(900n); return h(arr.pop()) }
    `, { optimize }).exports
    is(e.f(), 901n, `${lbl}: provenance-only ++`)
    is(e.d(), 899n, `${lbl}: provenance-only --`)
  }
})

test('bigint: storage-read forwarded through a closure/dispatch-table call (shape #6 closure close)', () => {
  // Closure bodies are outside the named-function provenance scan. Their own
  // local storage census now marks `nodes.shift()` as a boxed-by-construction
  // producer; the materialization fixpoint may therefore normalize the local
  // before its BigInt compound update. This is the actual watr HANDLER[key]
  // dispatch shape, not a direct-call approximation.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const e = jz(`
      const HANDLER = {
        i64: (nodes) => { let n = nodes.shift(); n >>= 7n; return n },
      }
      function encode(imm, nodes) {
        return HANDLER[imm](nodes)
      }
      export let f = () => {
        let nodes = []
        nodes.push(900n)
        return encode("i64", nodes)
      }
    `, { optimize }).exports
    is(e.f(), 7n, `${lbl}: closure/dispatch-table storage-read forwarding`)
  }
})

test('bigint: storage-read forwarded OUT of a dispatch-table closure into a second function\'s reassigned param (shape #7 — LANDED)', () => {
  // Sibling of the pin above, was NOT covered by its fix. That fix (generic
  // closure planning's closure-local storage census) recognizes `let n =
  // nodes.shift(); n >>= 7n` when the storage-read, the LOCAL BINDING, and
  // the compound reassignment all live in the SAME closure body. Real watr
  // never does this: compile.js's `i64:` HANDLER entry (compile.js ~1050,
  // `HANDLER[imm](nodes, ctx, op, out)` computed dispatch) reads
  // `encode.i64(n.shift(), out)` -- the storage-read is forwarded INLINE,
  // unbound, straight into a SEPARATE named function (encode.js's `i64()`,
  // ~118-136), which reassigns its OWN param in its LEB128 loop (`n >>=
  // 7n`). No local ever exists inside the closure for the storage census to
  // mark.
  //
  // Root cause (three independent gaps, all in solveBigintProvenance,
  // representation-plan.js): (1) `visitCallSites` (Shape #6 layer 5's
  // paramBigintOnly proof, the whole-program "every call site's argument is
  // a provably-closed bigint" census) explicitly refused to descend into
  // closure (`=>`) bodies -- `leb`'s ONLY real call site sits inside the
  // HANDLER.i64 closure, so `leb`'s param semantic fell back to the coarse
  // closed-ALL-kinds legacy answer, whose synthetic BOOL member vetoes
  // materializedNames permanently (the exact Shape #6 layer-5 disease, one
  // level deeper). (2) EVEN once visitCallSites sees the call site, the
  // storage census (`storage` -- which names are provably real, mutation-
  // tracked arrays) is name-keyed, and the closure's OWN param is a
  // DIFFERENT static name from the array pushed-to in `f` -- the by-
  // reference taint that already forward-propagates through a DIRECT-NAME
  // call (Shape #6 layer 6) never crossed a COMPUTED-key dispatch call at
  // all, because nothing enumerated which closures such a call could reach.
  // (3) The closure's OWN materializedResult admission (closure-forwarding
  // slice) only recognized a directly-tagged PARAM as evidence
  // (closureBoxParams); a closure that is pure result-forwarding (no
  // param of its own is ever itself a bigint) had no admission path at all.
  //
  // Fix: `collectDispatchTableClosures` (new) statically enumerates every
  // closure literal assigned as a property of a `let/const NAME = { … }`
  // object-literal dispatch table -- the same move collectLocalClosures
  // already makes for a single bound name, promoted to every property of a
  // table. Wired into THREE seams: `exprMay`'s computed-call branch (a
  // computed dispatch may carry bigint when ANY candidate's own result may),
  // `scan`'s forward+backward storage-taint rules (mirrored per candidate,
  // by reference, same soundness argument as the existing direct-call
  // rules), and `visitCallSites` now descends into closure bodies (a
  // closure's call to a NAMED function is a real, enumerable call site for
  // THAT function's param evidence, unlike scan()'s own local-name tracking
  // which closures correctly re-derive separately). Plus a fourth, additive
  // disjunct on the closure's own materializedResult gate: a result that
  // forwards through a proven-ready (materialized name/join, or a callee
  // whose OWN materializedResult already holds) expression is legitimate
  // evidence, independent of closureBoxParams. No pipeline reorder, no
  // change to the plan-as-sole-authority discipline; the plan simply sees a
  // second closure-storage shape (an object-literal table) it was blind to.
  //
  // Correct now at every optimization level (a plan-time fix, not an
  // optimizer-dependent one). This is the watr memory64 CI signature:
  // /test/official/memory64.wast data-segment offset 9221823924769379472
  // (0x7ffa80001113d490) and /test/official/float_memory64.wast offset
  // 9221823924662201080 (0x7ffa80000ab06af8) -- both from watr's `(memory
  // (data ...))` desugar and its explicit `(data (i64.const N) ...)` encode
  // path, both routing through this exact HANDLER[imm] -> encode.i64
  // forwarding seam; a third official test, call_indirect64.wast, failed
  // alongside them ("table index is out of bounds") -- same seam, a table64
  // index instead of a data offset.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const e = jz(`
      function leb(n) { n >>= 7n; return n }
      const HANDLER = { i64: (nodes) => leb(nodes.shift()) }
      function encode(imm, nodes) { return HANDLER[imm](nodes) }
      export let f = () => {
        let nodes = []
        nodes.push(900n)
        return encode("i64", nodes)
      }
    `, { optimize }).exports
    is(e.f(), 7n, `${lbl}: closure-forwarded storage-read into a second function's reassigned param crosses as a real BigInt`)
  }
})

test('bigint: storage-read forwarded through TWO plain named functions, no closure/dispatch table (shape #7 sibling — LANDED)', () => {
  // Found while probing shape #7's own "no closure at all" variant (phase-c
  // doc): drop the dispatch table and the closure entirely -- a bare
  // `f() -> handle(nodes) -> leb(nodes.shift())` direct-call chain, the
  // SAME shape Shape #6 layer 6's forward-taint rule already covers (its
  // own doc names this exact shape: "function handle(arr){ return
  // i64(arr.shift()) }"). Was correct at O0/O2; wrong at O3 only -- a
  // SEPARATE, narrower root cause from shape #7's own dispatch-table gap
  // (which was wrong at every level, unconditionally): this shape has no
  // closure and no computed-key dispatch anywhere, so none of shape #7's
  // dispatch-table fix seams (collectDispatchTableClosures, exprMay/scan's
  // dispatch-table wiring, visitCallSites' closure descent) touch it.
  //
  // Root cause (live-traced): at -O3, `inlineHotInternalCalls` (plan/
  // index.js) splices `handle`'s call into `f` BEFORE solveRepresentation
  // Boundaries ever runs (confirmed: `f`'s own body already reads `return
  // leb(nodes.shift())` -- `handle` never appears in it -- by the time
  // solveBigintProvenance walks the AST) -- but `handle`'s OWN function
  // declaration survives, fully intact and unreferenced, in ctx.funcs.list.
  // This orphaned copy still calls `leb(nodes.shift())` using ITS OWN
  // (now-uncallable) param -- and since nothing calls `handle` anymore, the
  // forward storage-taint rule that would normally prove that param BOXED
  // (Shape #6 layer 6, which requires the receiver be a PROVEN bigint-pure
  // array) never fires for it: no live call site exists to carry the taint.
  // solveBigintProvenance's whole-program paramBigintOnly census
  // (`markCallArg`) is sticky-impure BY DESIGN (a genuine union stays a
  // union) -- it cannot distinguish "one caller can't prove kind-purity"
  // from "this caller is dead code, ignore it" -- so the orphaned,
  // unreachable call site permanently poisons `leb`'s param KIND-PURITY
  // proof for EVERY caller, including `f`'s own genuinely-provable inlined
  // one.
  //
  // Fix: closed as a side effect of the SAME `paramNeverBool` proof shape
  // #7's own encode.i64 sibling gap needed (see the pin above and
  // representation-plan.js) -- a STRUCTURALLY weaker bar than
  // paramBigintOnly's kind-purity one (any storage-read-shaped argument,
  // regardless of receiver content-purity, regardless of whether that
  // particular call site is live or orphaned post-inline -- the AST SHAPE
  // of an argument expression doesn't change when its enclosing function
  // becomes unreachable). Both the orphaned and the live call site's
  // arguments are STRUCTURALLY `.shift()` reads either way, so
  // paramNeverBool stays true regardless of which one poisons
  // paramBigintOnly -- the BOOL-veto (the actual thing blocking
  // materialization) no longer needs kind-purity to clear, only boolean-
  // impossibility, which an orphaned call site can't retroactively revoke.
  // The inliner/dead-code-liveness gap itself (a fully-spliced-away callee
  // surviving in ctx.funcs.list) remains real and unfixed -- this pin closes
  // because the SYMPTOM it produced no longer reaches a wrong value, not
  // because the orphan stopped existing.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const e = jz(`
      function leb(n) { n >>= 7n; return n }
      function handle(nodes) { return leb(nodes.shift()) }
      export let f = () => {
        let nodes = []
        nodes.push(900n)
        return handle(nodes)
      }
    `, { optimize }).exports
    is(e.f(), 7n, `${lbl}: plain two-hop named-function storage forwarding crosses as a real BigInt`)
  }
})

test('bigint: typeof-guarded normalizer reached through a `.`-member call, not a bare name (shape #8 — FIXED)', () => {
  // Was KNOWN-WRONG (shape #8): watr's actual memory64/float_memory64/
  // call_indirect64 CI failures survived shape #7's closure/dispatch-table
  // fix (above) because `encode.i64`'s own `n = i64.parse(n)` is a
  // `.`-MEMBER call to `i64.parse` (`i64.parse = n => {…}`, a function
  // attached as a static property of `i64`, a same-module sibling — not a
  // bare name, not a computed dispatch, not a closure). Every provenance
  // function in this file (currentOf/semanticOf/exprMay/exprRep/
  // visitCallSites/scan) gated its direct-callee branch on
  // `typeof node[1] === 'string'` exclusively, so a `.`-member call to a
  // real, user-defined function was invisible to analysis even though
  // emission's own dynamic dispatch called it correctly at the VALUE level
  // — the exact same callee body, called by bare name (the control just
  // above), was already correct; called via `ns.parse(...)`, the raw i64
  // bits crossed unboxed and were misread as a subnormal Number
  // (`3.5e-323`).
  //
  // Fixed by call-target-index.js: one frozen, same-module index, built
  // once in plan/index.js before representation-plan.js's provenance walk
  // or narrow.js's signature narrowing ever run, proving a `.`-member call's
  // callee from whole-program property-write evidence (never a name guess).
  // representation-plan.js's exprMay/exprRep/scan/visitCallSites now resolve
  // a `.`-member callee through the SAME index bare-name calls trivially
  // already had; emission's trySchemaClosureCall (a schema-known property
  // dispatched as a closure call) applies the identical runtime-verified
  // box-tag strategy tryDynamicPropCall already used for its own guessed
  // targets, now fed the index's proven candidate too. An unresolved
  // `.`-member call is untouched — same runtime dispatch, same "no claim"
  // default as before this fix.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const src = `
      function parseNum(n) {
        if (typeof n === 'string') n = BigInt(n)
        n >>= 7n
        return n
      }
      export let control = () => {
        let nodes = []
        nodes.push("900")
        return parseNum(nodes.shift())
      }
    `
    const control = jz(src, { optimize }).exports
    is(control.control(), 7n, `${lbl}: bare-name control (same callee body) is already correct`)
    const e = jz(`
      function parseNum(n) {
        if (typeof n === 'string') n = BigInt(n)
        n >>= 7n
        return n
      }
      const ns = {}
      ns.parse = parseNum
      export let f = () => {
        let nodes = []
        nodes.push("900")
        return ns.parse(nodes.shift())
      }
    `, { optimize }).exports
    is(e.f(), 7n, `${lbl}: identical callee reached via .member call now crosses as a real BigInt`)
  }
})

test('bigint: BOXED-target reassigned param crosses into a RAW-expecting bare-name callee argument (shape #9 — FIXED)', () => {
  // Found while validating shape #8's own real watr shape (i64.parse
  // attached to a NAMED FUNCTION, not an object literal — a distinct
  // resolver strategy from shape #8's own landed one, attempted and
  // reverted after it regressed kernel-oracle; see .work/archive/phase-c-
  // unification.md's own note on this pin for the trail). Isolated to a
  // MINIMAL repro with ZERO `.`-member calls anywhere — confirmed
  // pre-existing on unmodified main (aff67069), unrelated to the call-target
  // index or any shape #6/#7/#8 mechanism.
  //
  // Root cause (live-traced, CORRECTS this pin's original prose): `leb`'s
  // own boundary/body TARGET for `n` is BOXED, not RAW — `targetRepFor`
  // only picks RAW when the legacy whole-program param census
  // (`programFacts.paramReps`, which `current`/`target` deliberately stay
  // pinned to — see the Shape #6 "TWO REGRESSIONS" note) can prove `n`
  // closed-kind-pure bigint across every call site. `leb`'s ONLY call site
  // (`i64`'s `return leb(n)`) passes a BARE NAME that is itself a
  // REASSIGNED CALLER LOCAL (`i64`'s own `n`, string at entry, `BigInt` via
  // `n = parseIt(n)`) — opaque to that census, which falls back to the
  // "any of the 14 kinds, closed" answer (BOOL included). That coarse,
  // closed semantic trips buildBodyData's BOOL-veto, so `leb`'s `n` never
  // enters `leb`'s OWN materializedNames for ANY caller — `representation
  // CallArgAction` sees `bodyReady=false` and REJECTs the edge (not a
  // BOXED-vs-RAW mismatch to bridge: there is no coercion at all), so the
  // caller's still-boxed pointer bits cross unconverted and get misread as
  // the i64 payload. Exactly the residual `solveBigintProvenance`'s own
  // `paramBigintOnly` doc comment already named and scoped out: "a bare-name
  // argument... resolves through exprRep as ANY_BIGINT — open, not closed
  // ... a missed opportunity, not a soundness gap".
  //
  // Fix (representation-plan.js, `solveBigintProvenance`): extend the
  // call-site argument proof feeding `paramNeverBool`/`markNeverBoolArg`
  // (the SAME structurally-weaker, sufficient bar Shape #7 already
  // established — boolean-impossibility, not kind purity) — a bare-name
  // argument now also counts as structurally never-boolean when every
  // explicit reaching definition of that name within the caller's own body
  // (`collectDefs`, already computed as `defMapByFunc`) is itself
  // structurally never-bool (a bigint origin, a storage read, a literal, or
  // a call whose callee's own return tail(s) are structurally
  // `isBigintOrigin` — pure AST inspection, no plan/provenance data, so no
  // ordering hazard), AND the name's own entry semantic, if it is itself a
  // parameter, is also never-bool per the same legacy census. This clears
  // the BOOL-veto so `leb`'s `n` materializes (BOXED, unchanged from the
  // legacy-derived target) — the call-arg edge becomes an ordinary
  // BOXED→BOXED KEEP once both ends agree, no new box/unbox primitive
  // needed for THIS shape. `argStructurallyNeverBool`/`markNeverBoolArg`
  // fire through the SAME shared `visitCallSites` call-arg loop Shape #8
  // already resolves `.`-member callees through — bare-name and
  // index-resolved callees get the identical proof (sibling pin below).
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const e = jz(`
      function leb(n) {
        n >>= 7n
        return n
      }
      function parseIt(n) {
        n = n.replaceAll('_', '')
        return BigInt(n)
      }
      function i64(n) {
        if (typeof n === 'string') n = parseIt(n)
        return leb(n)
      }
      export let f = () => {
        return i64("900")
      }
    `, { optimize }).exports
    is(e.f(), 7n, `${lbl}: BOXED-target reassigned param crosses into leb(n)'s argument as a real BigInt`)
  }
})

test('bigint: shape #9 sibling materializes through an index-resolved member callee', () => {
  // A named function used through a property has an uncovered value ABI.
  // RepresentationPlan now admits its parameter only when the complete def
  // set is materializable, then normalizes closure ingress, body writes, and
  // result to the same boxed contract. CallTargetIndex remains the sole
  // authority that proves obj.leb names this function.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const e = jz(`
      function leb(n) {
        n >>= 7n
        return n
      }
      const obj = {}
      obj.leb = leb
      function parseIt(n) {
        n = n.replaceAll('_', '')
        return BigInt(n)
      }
      function i64(n) {
        if (typeof n === 'string') n = parseIt(n)
        return obj.leb(n)
      }
      export let f = () => {
        return i64("900")
      }
    `, { optimize }).exports
    is(e.f(), 7n, `${lbl}: value-used leb reached through .member returns a real BigInt`)
  }
})

test('bigint: shape #9 sibling — `.`-member callee feeds a CALLER-side binding write, not the RAW-consuming callee itself (FIXED)', () => {
  // The pin above reaches the RAW-consuming callee through a member value ABI;
  // it is now closed by RepresentationPlan's value-ABI materialization. THIS
  // pin is the residual its own comment separately named: `directCallBoundary`
  // (buildBodyData's callee lookup, feeding semanticOf/currentOf/plannedOf/
  // walkEdges) was bare-name-only, so a caller's OWN bigint-provenance proof
  // for a reassigned local depended on resolving a `.`-member callee — here,
  // `i64.parse` (a lifted named-function property, watr's own real shape,
  // matching the "shape #7-residual" pin above) is the RHS of `i64`'s own
  // binding write `n = i64.parse(n)`; `leb` (the eventual RAW-consuming
  // callee) stays bare-name, unlike the pin above.
  //
  // Root cause, live-traced (two layers, both in representation-plan.js):
  // (1) buildBodyData's directCallBoundary consumers (semanticOf/currentOf/
  // plannedOf/walkEdges/emittedCandidate) gained a `calleeNameOf` helper —
  // `typeof node[1] === 'string' ? node[1] : provenance.resolveMemberCallee
  // (node[1])?.name` — reusing the SAME frozen call-target-index resolver
  // solveBigintProvenance's own exprMay/exprRep/scan/visitCallSites already
  // use (Shape #8), so `i64.parse(n)`'s callee now resolves to `i64$parse`
  // and `currentOf` can read its proven RAW_BIGINT result. (2) That alone
  // surfaced a SECOND, narrower gap: `edgeMaterializable`'s BOX/UNBOX safety
  // check (guards buildBodyData's materializedNames/materializedResult
  // fixpoints against boxing a value that isn't actually proven bigint)
  // trusted ONLY `valTypeOf(node) === VAL.BIGINT` — kind.js's OWN Tier-1
  // bare-name call resolution (narrow.js's whole-program valResult census),
  // which has no `.`-member equivalent (deliberately — that was the shelved
  // fix/shape8-member-callee branch's own kernel-taint lesson). A resolved
  // `.`-member callee whose OWN body plan already proves a CLOSED bigint
  // result (`calleeBody.materializedResult`, falling back to the callee's
  // BOUNDARY-level current when its body hasn't settled yet at THIS caller's
  // analysis time — same callee-before-caller body-readiness fallback
  // currentOf's own Shape #7 comment already documents) is exactly as safe
  // to admit as what valTypeOf already proves for a bare name — a new
  // `calleeProvenBigintResult` helper reuses that ground truth instead of
  // widening trust in `source`'s bits generally (which can also reach a
  // closed bigint bit through the unrelated NUMERIC_VALUE_OPS+canBeBigint
  // heuristic, still correctly gated by valTypeOf alone).
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const e = jz(`
      function i64(n) { if (typeof n === 'string') n = i64.parse(n); return leb(n) }
      i64.parse = n => { n = n.replaceAll('_', ''); return BigInt(n) }
      function leb(n) { n >>= 7n; return n }
      export let f = () => i64("900")
    `, { optimize }).exports
    is(e.f(), 7n, `${lbl}: i64.parse's proven BigInt result now reaches i64's own binding write, leb(n) gets a real BigInt`)
  }
})

test('bigint: one-authority fix — valTypeOf itself resolves a `.`-member callee (large magnitude, tag-aliasing-prone)', () => {
  // Root-cause residual found landing the one-authority fix (kind.js's
  // valTypeOf, VT['()'], now consults the frozen call-target index for a
  // `.`-member callee directly — the SAME Tier-1 answer calleeValType's
  // bare-name tail already gives, mirrored exactly): applyBigintRepresenta-
  // tionAction (ir.js) and edgeMaterializable's BOX/UNBOX gate (representation-
  // plan.js) previously had their OWN separate `.`-member widenings
  // (calleeSourceProvenBigint / memberCalleeResultProvenBigint) standing in
  // for `valTypeOf(node) === VAL.BIGINT` — both removed now that valTypeOf
  // answers the `.`-member case directly. This magnitude
  // (0xaf00f0000_9999 / 3078696982321561, watr's own int_literals.wast
  // "i64-hex-sep1" case) has bits that alias PTR.BIGINT's own NaN-box tag
  // pattern (tag=5) when the reassigned `n = i64.parse(n)` result is left
  // UNBOXED and mistaken for a real payload downstream — the exact "box-
  // tag-shaped i64 constant" hazard this file documents elsewhere. Small
  // magnitudes (900) don't collide with the tag and passed even before
  // this fix; this one didn't.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const e = jz(`
      function i64(n) { if (typeof n === 'string') n = i64.parse(n); return leb(n) }
      i64.parse = n => BigInt(n)
      function leb(n) { n >>= 7n; return n }
      export let f = () => i64("3078696982321561")
    `, { optimize }).exports
    is(e.f(), 24052320174387n, `${lbl}: large tag-aliasing magnitude survives i64.parse's .-member boundary correctly`)
  }
})

test('bigint: one-authority fix — `.`-member callee result as a ternary arm feeding bitwise |/&/<<', () => {
  // plannedOf/semanticOf (representation-plan.js buildBodyData) had their
  // OWN separate gap from calleeNameOf/directCallBoundary: both used only
  // a callee's coarse PRE-BODY boundary guess (`directCallBoundary(...)
  // .result.target`/`.semantic`), never upgrading to the callee's own
  // SETTLED body result once materialized — an asymmetry with currentOf,
  // which already had this upgrade (Shape #7's own documented pattern).
  // Reachable once a `.`-member callee's call node starts flowing through
  // plannedOf/semanticOf's call-node branch at all (this fix). Without the
  // upgrade, a ternary joining a closed-RAW literal against a `.`-member
  // call whose result is ALSO proven closed-RAW emitted the two arms
  // ASYMMETRICALLY (the literal stayed raw, the call's result got
  // independently, incorrectly boxed at the call site) — found via watr's
  // real f64() NaN-payload encoder (`value = flag ? QUIET : i64.parse(tail);
  // value |= NAN`), reduced here to the minimal shape. Sign-bit-safe
  // magnitudes only (0x00ff... not 0xff...) — a value with the i64 sign bit
  // set hits a SEPARATE, pre-existing, unrelated BigInt boundary-decode gap
  // (confirmed identical on the bare-name control sibling below, so it is
  // not this fix's own regression) not exercised by this pin.
  const BODY = `
    export let trueOr = () => pick(true, '123') | 0x1n
    export let trueAnd = () => pick(true, '123') & 0xffn
    export let trueShl = () => pick(true, '123') << 1n
    export let falseOr = () => pick(false, '123456789') | 0x1n
    export let falseAnd = () => pick(false, '123456789') & 0xffn
    export let falseShl = () => pick(false, '123456789') << 1n
  `
  const memberSrc = `
    const MASK = 0x00ff000000000000n
    function i64(n) { return n }
    i64.parse = n => BigInt(n)
    function pick(flag, tail) { return flag ? MASK : i64.parse(tail) }
    ${BODY}
  `
  const bareSrc = `
    const MASK = 0x00ff000000000000n
    function parseIt(n) { return BigInt(n) }
    function pick(flag, tail) { return flag ? MASK : parseIt(tail) }
    ${BODY}
  `
  const expect = { trueOr: 71776119061217281n, trueAnd: 0n, trueShl: 143552238122434560n,
    falseOr: 123456789n, falseAnd: 21n, falseShl: 246913578n }
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const member = jz(memberSrc, { optimize }).exports
    for (const [fn, want] of Object.entries(expect))
      is(member[fn](), want, `${lbl}: .-member callee ternary arm, ${fn}`)
    const bare = jz(bareSrc, { optimize }).exports
    for (const [fn, want] of Object.entries(expect))
      is(bare[fn](), want, `${lbl}: bare-name control ternary arm, ${fn}`)
  }
})

test('bigint: shape #9 sibling — non-reassigned BOXED param (O0/O2/O3 all correct)', () => {
  // Same edge class with the BOXED source coming from a genuine call-site
  // union (Number|BigInt) on a param that is NEVER reassigned — `relay`'s
  // own `n` — rather than from a reassignment inside the caller. `relay`
  // stays covered (no property/value use anywhere): both `relay(900n)`
  // (real, executed) and `relay(5)` (real, executed, but structurally
  // routed away from `leb`'s raw arithmetic by relay's own typeof guard —
  // avoids the genuine JS TypeError mixing Number/BigInt in `>>=` would
  // throw) are visible call sites, so the legacy census sees a real
  // {number, bigint} union and `relay`'s target is BOXED by construction
  // (targetRepFor's default), never reassigned, `stable` throughout.
  // `argStructurallyNeverBool`'s param-entry branch (this fix) proves `n`
  // never-bool from that same census, same as the primary pin.
  //
  // O3 used to be KNOWN-WRONG (a corrupted-number misread — `f()` returned
  // the raw bigint bits reinterpreted as a plain f64, e.g. 3.5e-323 — not
  // merely a typeof cosmetic): confirmed PRE-EXISTING and IDENTICAL on
  // unmodified fb2dec2e, unrelated to the argStructurallyNeverBool fix this
  // test's siblings pin. Now fixed as a side effect of the possibleKinds
  // census ordering fix (narrow.js mergeRule trackKind deferred to a single
  // post-convergence pass — see "RepresentationPlan: a forwarded, genuinely
  // monomorphic array param is trusted" above): verified via direct A/B
  // against the pre-fix narrow.js on this exact source — 3.5e-323 (wrong)
  // before, 7n (correct) after — and NOT gated by paramValTrustworthy
  // (confirmed no distrust event fires for this program; 'bigint' isn't in
  // PTR_TAGGED_KINDS). representation-plan.js's OWN, separate
  // paramEntryExcludesBool reads `rep.possibleKinds`/`kindsCoverage`
  // directly (the census this file's comment above calls "the legacy
  // census") to decide whether `relay`'s param `n`, forwarded into `leb`,
  // structurally excludes BOOL — the same class of consumer as
  // paramValTrustworthy (trusting a closed-coverage possibleKinds snapshot),
  // just a different call site than the one this fix's primary repro traces
  // in full; not independently re-traced to its exact premature-join site
  // with the same rigor, but the mechanism (a stale KIND_UNIVERSE surviving
  // in possibleKinds from before this fix) is the same family and the value
  // flip is real and reproduced, not assumed.
  const src = `
    function leb(n) { n >>= 7n; return n }
    function relay(n) { return typeof n === 'bigint' ? leb(n) : n }
    export let f = () => relay(900n)
    export let g = () => relay(5)
  `
  for (const [optimize, lbl] of [[false, 'O0'], [2, 'O2'], [3, 'O3']]) {
    const e = jz(src, { optimize }).exports
    is(e.f(), 7n, `${lbl}: non-reassigned BOXED union param crosses into leb(n)'s argument as a real BigInt`)
    is(e.g(), 5, `${lbl}: the Number arm stays untouched (never reaches leb)`)
  }
})

test('bigint: shape #9 negative control — RAW-to-RAW bare call stays a plain i64 pass, no unbox inserted', () => {
  // A call argument that already agrees with the callee's RAW target on
  // both ends (a bare bigint literal, the callee's ONLY call site) must
  // stay a KEEP — kernel size/speed must not regress from this fix.
  const src = `
    function leb(n) { n >>= 7n; return n }
    export let f = () => leb(900n)
  `
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const e = jz(src, { optimize }).exports
    is(e.f(), 7n, `${lbl}: plain RAW bigint literal argument crosses unchanged`)
  }
  // WAT-shape (O0, unfolded): `f`'s own body must carry the raw i64 bits
  // straight into `leb` — no `$__ptr_type` tag-check (maybeUnboxBigInt's
  // own primitive) and no `$__alloc` call (boxBigInt's own primitive)
  // inserted for an edge that never needed either.
  const wat = String(compile(src, { optimize: false, wat: true }))
  const start = wat.indexOf('(func $f')
  ok(start >= 0, '$f found in WAT')
  const next = wat.indexOf('\n  (func ', start + 1)
  const fBody = next >= 0 ? wat.slice(start, next) : wat.slice(start)
  ok(!/call \$__ptr_type/.test(fBody), 'O0: no unbox tag-check inserted for an already-RAW call argument')
  ok(!/call \$__alloc/.test(fBody), 'O0: no box allocation inserted for an already-RAW call argument')
})

// Range-boundary BOX/UNBOX OOB (2026-08 fix, src/ir.js applyBigintRepresentationAction
// + src/compile/emit.js coerceArg): every plan-directed UNBOX now routes through
// maybeUnboxBigInt (runtime tag-checked) instead of the unconditional unboxBigInt —
// see that fix's own doc comment and test/pointers.js's "carrier: unboxBigInt applied
// to a RAW…" pins for the mechanism (a raw payload's own low-32 bits misused as a heap
// address once a plan proof calls for UNBOX on a value that never got boxed; 0x7fff…f
// and 0xffff…f both decode to the address ~4 GiB, tripping "memory access out of
// bounds" specifically, where a smaller BigInt would just silently misread nearby
// heap memory). The three box-forcing shapes below (storage, Number|BigInt union,
// host export boundary) are the ones that route real programs through the fixed
// chokepoints; none of them crashed on unmodified main either (representation-plan.js's
// own materializedNames/emittedCandidate proof stays order-safe for every one of these
// — the crash is real and reproduced directly, test/pointers.js's __unbox_bigint pins
// above, but needs an order-UNSAFE proof no ordinary program shape reaches without
// landing fix/shape8-member-callee's own `.`-member callee resolution). Pinned here as
// regression coverage for the fixed chokepoints themselves, across every representation
// the family can take: ±(2^63-1), the 2^64-1 wrapped forms (asUintN(64,·) collapses
// both to small-magnitude i64 bit patterns, ±1), and ±2^62 as in-range controls.
test('bigint: range-boundary family survives storage box/unbox (array push+read+arithmetic)', () => {
  const FAMILY = {
    'i64 max (2^63-1)': ['9223372036854775807n', 9223372036854775807n],
    'negated i64 max': ['-9223372036854775807n', -9223372036854775807n],
    'i64 min (-2^63)': ['-9223372036854775808n', -9223372036854775808n],
    '2^64-1 wrapped': ['18446744073709551615n', -1n],
    'negated 2^64-1 wrapped': ['-18446744073709551615n', 1n],
    '+2^62 control': ['4611686018427387904n', 4611686018427387904n],
    '-2^62 control': ['-4611686018427387904n', -4611686018427387904n],
  }
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    for (const [name, [lit, expect]] of Object.entries(FAMILY)) {
      // Seeded array literal (`[0n]`, not `[]`) — an untyped empty-array-literal's
      // own element-kind inference is a separate, pre-existing gap (unrelated to
      // this fix) this pin isn't testing; seeding with a BigInt element gives the
      // array a provable BigInt-typed storage from its first write.
      const { f } = jz(`export let f = () => { let a = [0n]; a[0] = ${lit}; return a[0] + 0n }`, { optimize }).exports
      is(f(), expect, `${lbl}: storage round-trip, ${name}`)
    }
  }
})

test('bigint: range-boundary family survives a Number|BigInt union box/unbox (mixed-kind reassignment)', () => {
  const FAMILY = {
    'i64 max (2^63-1)': ['9223372036854775807n', 9223372036854775807n],
    'negated i64 max': ['-9223372036854775807n', -9223372036854775807n],
    'i64 min (-2^63)': ['-9223372036854775808n', -9223372036854775808n],
    '2^64-1 wrapped': ['18446744073709551615n', -1n],
    'negated 2^64-1 wrapped': ['-18446744073709551615n', 1n],
    '+2^62 control': ['4611686018427387904n', 4611686018427387904n],
    '-2^62 control': ['-4611686018427387904n', -4611686018427387904n],
  }
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    for (const [name, [lit, expect]] of Object.entries(FAMILY)) {
      // `x` starts Number, reassigned to the boundary BigInt on the taken branch —
      // a genuine Number|BigInt union, unconditionally boxed by construction — then
      // forced back through arithmetic (`+ 0n`), which only type-checks once the
      // BigInt arm is the one actually reached (`present` truthy).
      const { f } = jz(`export let f = (present) => { let x = 0; if (present) x = ${lit}; return x + 0n }`, { optimize }).exports
      is(f(1), expect, `${lbl}: union round-trip, ${name}`)
    }
  }
})

test('bigint: range-boundary family survives the host export boundary (string in, BigInt out)', () => {
  const FAMILY = {
    'i64 max (2^63-1)': ['9223372036854775807', 9223372036854775807n],
    'negated i64 max': ['-9223372036854775807', -9223372036854775807n],
    'i64 min (-2^63)': ['-9223372036854775808', -9223372036854775808n],
    '2^64-1 wrapped': ['18446744073709551615', -1n],
    'negated 2^64-1 wrapped': ['-18446744073709551615', 1n],
    '+2^62 control': ['4611686018427387904', 4611686018427387904n],
    '-2^62 control': ['-4611686018427387904', -4611686018427387904n],
  }
  // String param, not a raw host BigInt argument: interop.js's own i64Arg
  // marshaling for a raw-BigInt host argument (jz:hostabi's raw/tag split)
  // turns out to have a PRE-EXISTING, unrelated compile-state-leak fragility
  // in this exact suite's warm context — confirmed independent of this fix
  // (still reproduces with src/ir.js and src/compile/emit.js reverted to
  // unmodified main) — not this P1's mechanism (interop.js touches none of
  // the box/unbox emission this fix changes) and out of scope to chase here.
  // BigInt(str) inside the compiled program is the exact alternative the
  // runtime's own error for that path names ("pass a decimal string to a
  // typeof-guarded normalizing parameter") — a genuine host round-trip
  // (string crosses in, BigInt crosses back out) through the SAME
  // materialize-then-arithmetic box-forcing shape as the union pin above,
  // without the unrelated raw-argument marshaling gap.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const { f } = jz(`export let f = (s) => { let n = BigInt(s); return n + 0n }`, { optimize }).exports
    for (const [name, [str, expect]] of Object.entries(FAMILY)) is(f(str), expect, `${lbl}: host boundary round-trip, ${name}`)
  }
})

test('bigint: BigInt typed-array stores recover a materialized RHS payload (was KNOWN-WRONG)', () => {
  const FAMILY = {
    'i64 max (2^63-1)': '9223372036854775807n',
    'negated i64 max': '-9223372036854775807n',
    'i64 min (-2^63)': '-9223372036854775808n',
    '2^64-1 wrapped': '18446744073709551615n',
    'negated 2^64-1 wrapped': '-18446744073709551615n',
    '+2^62 control': '4611686018427387904n',
    '-2^62 control': '-4611686018427387904n',
    'PTR.BIGINT-shaped raw payload': BIGINT_TYPED_STORE_PAYLOAD,
  }
  // A Number|BigInt local is materialized as PTR.BIGINT on the taken arm. The
  // typed store must write that box's i64 payload, not the pointer bits. Both
  // signed and unsigned 64-bit constructors share this emitter. Values outside
  // signed i64 use JZ's documented wrapping BigInt dialect.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    for (const ctor of ['BigInt64Array', 'BigUint64Array']) {
      for (const [name, lit] of Object.entries(FAMILY)) {
        const e = jz(`export let f = (present) => { let x = 0; if (present) x = ${lit}; const arr = new ${ctor}(1); arr[0] = x; return arr[0] === ${lit} ? 1 : 0 }`, { optimize }).exports
        is(e.f(1), 1, `${lbl}: ${ctor} materialized store, ${name}`)
      }
    }
  }

  // The Number arm is not a value JZ may silently reinterpret as i64. ToBigInt
  // fails before the indexed store even when the index is out of bounds.
  const hostMismatch = index => { const arr = new BigInt64Array(1); let value = 0; arr[index] = value }
  throws(() => hostMismatch(0), error => error instanceof TypeError)
  throws(() => hostMismatch(2), error => error instanceof TypeError)
  const hostCaughtMismatch = () => {
    let trace = 0, value = 0
    if (trace < 0) value = 7n
    const arr = new BigInt64Array(1)
    try { arr[(trace = trace + 1, 2)] = value; return 99 }
    catch (error) { return trace * 10 + (error instanceof TypeError ? 1 : 0) }
  }
  is(hostCaughtMismatch(), 11, 'Node oracle: OOB conversion throws after the index effect and is catchable')
  // JZ's compact runtime code-error channel becomes a real host TypeError, but
  // is not a source-level Error object; reject a surrounding catch rather than
  // accept different catch identity/effects.
  for (const optimize of [false, 2, 3])
    throws(() => jz(BIGINT_TYPED_STORE_CATCH_SOURCE, { optimize }), /inside try\/catch is not supported/)
  // Other statically non-BigInt inputs take the allowed correct-or-reject path;
  // JZ does not pretend their raw carriers are i64 payloads.
  for (const value of ['1', 'true', "'1'"])
    throws(() => compile(`export let f = () => { const arr = new BigInt64Array(1); arr[0] = ${value} }`),
      /BigInt typed-array element store cannot prove ToBigInt/)

  // Shared native/kernel source pairs the positive case with the load-bearing
  // negative control: raw bits that look exactly like PTR.BIGINT must not be
  // runtime-unboxed. Its hostile 0xffffffff low word would trap near 4 GiB if
  // the old unconditional maybeUnboxBigInt attempt returned.
  for (const optimize of [false, 2, 3]) {
    const e = jz(BIGINT_TYPED_STORE_SOURCE, { optimize }).exports
    for (const { fn, args, expect } of BIGINT_TYPED_STORE_CALLS)
      is(e[fn](...args), expect, `O${optimize || 0}: ${fn}`)
    const errors = jz(BIGINT_TYPED_STORE_ERROR_SOURCE, { optimize }).exports
    for (const { fn, args } of BIGINT_TYPED_STORE_THROW_CALLS)
      throws(() => errors[fn](...args), error => error instanceof TypeError)
  }

  const bodyOf = (src, name) => {
    const wat = String(compile(src, { optimize: false, wat: true }))
    const start = wat.indexOf(`(func $${name}\n`)
    ok(start >= 0, `$${name} found in O0 WAT`)
    const next = wat.indexOf('\n  (func ', start + 1)
    return next < 0 ? wat.slice(start) : wat.slice(start, next)
  }
  ok(/call \$__ptr_type/.test(bodyOf(BIGINT_TYPED_STORE_SOURCE, 'boxedI64')),
    'materialized store uses readI64\'s PTR.BIGINT check')
  ok(!/call \$__ptr_type/.test(bodyOf(BIGINT_TYPED_STORE_SOURCE, 'rawI64')),
    'proven-raw store remains a direct reinterpret with no tag check')

  // Node oracle for the dialect-compatible value plus an effect pin: the
  // computed index runs exactly once before the write. The carrier-specific
  // positive/negative pair above separately proves the RHS representation.
  const hostEffects = () => {
    let trace = 0, x = 0
    if (1) x = 0x7ffa8000ffffffffn
    const arr = new BigInt64Array(1)
    const index = () => { trace = trace * 10 + 1; return 0 }
    arr[index()] = x
    return trace * 10 + (arr[0] === 0x7ffa8000ffffffffn ? 1 : 0)
  }
  const effectSource = `export let f = () => { let trace = 0, x = 0; if (1) x = ${BIGINT_TYPED_STORE_PAYLOAD}; const arr = new BigInt64Array(1); const index = () => { trace = trace * 10 + 1; return 0 }; arr[index()] = x; return trace * 10 + (arr[0] === ${BIGINT_TYPED_STORE_PAYLOAD} ? 1 : 0) }`
  is(hostEffects(), 11, 'Node oracle: computed index evaluates once before the write')
  for (const optimize of [false, 3])
    is(jz(effectSource, { optimize }).exports.f(), 11, `O${optimize || 0}: matches Node source order and effects`)
})

test('bigint: unary "-"/"~" and joint-binary census results materialize through RepresentationPlan', () => {
  // The retired sentinel export lane could not be disabled until these
  // producer shapes materialized through the generic tagged decode; doing so
  // earlier produced silent
  // wrong values on the present-key case at every optimize level (`-m.get('x')`
  // with x=5n present read back as `2.5e-323`, 5n's raw i64 bits misread as an
  // f64 subnormal — the exact disease this whole mechanism exists to prevent).
  // Fix: representation-plan.js's buildBodyData admits the census-shaped
  // producers into the SAME materializedJoins set C5b's join fixpoint populates
  // — the return edge now boxes the "real bigint" branch, representation
  // ResultTagRequired's exprMayBox sees it (STRICT proof), and compile/
  // index.js's synthesizeBoundaryWrappers routes the generic decode lane
  // instead of the sentinel lane for these covered exports (verified
  // separately below — the sentinel lane itself stays in place, unused for
  // these shapes, a dead-but-present fallback per this slice's own scope).
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`

    // UNARY_NEG ('-'): present key → real (possibly negative) BigInt; absent
    // key → Number NaN (ES2024 13.5.6 ToNumeric(undefined)); a plain-number
    // Map is untouched (regression guard — non-bigint programs unaffected).
    const neg = jz(`export let f = (present) => { const m = new Map(); if (present) m.set('x', 5n); return -m.get('x') }`, { optimize }).exports
    ok(typeof neg.f(1) === 'bigint' && neg.f(1) === -5n, `${lbl}: -m.get('x') present crosses typed BigInt`)
    ok(typeof neg.f(0) === 'number' && Number.isNaN(neg.f(0)), `${lbl}: -m.get('x') absent stays Number NaN`)
    const negNeg = jz(`export let f = () => { const m = new Map(); m.set('x', -5n); return -m.get('x') }`, { optimize }).exports
    is(negNeg.f(), 5n, `${lbl}: -m.get('x') on a stored-negative BigInt crosses correctly signed`)
    const negNum = jz(`export let f = () => { const m = new Map(); m.set('x', 7); return -m.get('x') }`, { optimize }).exports
    is(negNum.f(), -7, `${lbl}: -m.get('x') on a plain-number Map stays a plain Number (unaffected)`)

    // UNARY_NOT ('~'): present key → real BigInt (bitwise complement, i64 xor
    // -1); absent key → Number -1 (ES2024 13.5.9 ToNumeric(undefined)).
    const not = jz(`export let f = (present) => { const m = new Map(); if (present) m.set('x', 5n); return ~m.get('x') }`, { optimize }).exports
    ok(typeof not.f(1) === 'bigint' && not.f(1) === -6n, `${lbl}: ~m.get('x') present crosses typed BigInt`)
    ok(typeof not.f(0) === 'number' && not.f(0) === -1, `${lbl}: ~m.get('x') absent stays Number -1`)
    const notNum = jz(`export let f = () => { const m = new Map(); m.set('x', 7); return ~m.get('x') }`, { optimize }).exports
    is(notNum.f(), ~7, `${lbl}: ~m.get('x') on a plain-number Map stays a plain Number (unaffected)`)

    // JOINT_BINARY ('+'): BOTH operands independently census-BIGINT — present
    // (both keys set) crosses a real BigInt sum; a plain-number Map (neither
    // operand census-BIGINT) is untouched.
    const joint = jz(`export let f = () => { const m = new Map(); m.set('a', 5n); m.set('b', 3n); return m.get('a') + m.get('b') }`, { optimize }).exports
    is(joint.f(), 8n, `${lbl}: m.get('a') + m.get('b') (both present BigInt) crosses typed BigInt`)
    const jointLossless = jz(`export let f = () => { const m = new Map(); m.set('a', 9007199254740993n); m.set('b', 1n); return m.get('a') + m.get('b') }`, { optimize }).exports
    is(jointLossless.f(), 9007199254740994n, `${lbl}: joint-binary present-BigInt sum stays lossless past 2^53`)
    const jointNum = jz(`export let f = () => { const m = new Map(); m.set('a', 5); m.set('b', 3); return m.get('a') + m.get('b') }`, { optimize }).exports
    is(jointNum.f(), 8, `${lbl}: joint-binary on a plain-number Map stays a plain Number (unaffected)`)
  }

  // The retired sentinel wrapper was the only export body that called
  // $__ptr_type inline. Every census-BigInt shape now takes the generic
  // plan-owned tagged decode, including the formerly residual bare read.
  const wrapperBody = (src, fname) => {
    const wat = compile(src, { optimize: false, wat: true })
    const start = wat.indexOf(`(func $${fname}$exp`)
    ok(start >= 0, `$${fname}$exp wrapper found in WAT`)
    const next = wat.indexOf('\n  (func ', start + 1)
    return next >= 0 ? wat.slice(start, next) : wat.slice(start)
  }
  const bareBody = wrapperBody(`export let f = () => { const m = new Map(); m.set('x', 5n); return m.get('x') }`, 'f')
  ok(!/call \$__ptr_type/.test(bareBody), 'O0: BARE export no longer takes the sentinel lane')
  const negBody = wrapperBody(`export let f = () => { const m = new Map(); m.set('x', 5n); return -m.get('x') }`, 'f')
  ok(!/call \$__ptr_type/.test(negBody), 'O0: UNARY_NEG export wrapper no longer takes the sentinel lane (generic decode routes instead)')
  const notBody = wrapperBody(`export let f = () => { const m = new Map(); m.set('x', 5n); return ~m.get('x') }`, 'f')
  ok(!/call \$__ptr_type/.test(notBody), 'O0: UNARY_NOT export wrapper no longer takes the sentinel lane')
  const jointBody = wrapperBody(`export let f = () => { const m = new Map(); m.set('a', 5n); m.set('b', 3n); return m.get('a') + m.get('b') }`, 'f')
  ok(!/call \$__ptr_type/.test(jointBody), 'O0: JOINT_BINARY export wrapper no longer takes the sentinel lane')
})

test('typeof folds preserve operand effects, in source order (audit P0: emitTypeofCmp erased calls)', () => {
  // emitTypeofCmp (src/compile/emit.js) emits its operand into `va` ONCE, up front —
  // but three fold sites (staticFold, shared by 'boolean'/'bigint', and the NUMBER-
  // vs-BOOL-carrier fold) used to return a bare i32.const without ever placing `va`
  // in the returned tree: `typeof bump() === 'boolean'` skipped bump() entirely
  // whenever its return kind was statically known. JS evaluates the typeof operand
  // before comparing — the call must still run, exactly once, on every fold path.
  for (const optimize of [false, 2, 3]) {
    const bo = jz(`
      let n = 0
      function bump() { n = n + 1; return true }
      export let isBool = () => typeof bump() === 'boolean'
      export let notBool = () => typeof bump() !== 'boolean'
      export let isNum = () => typeof bump() === 'number'
      export let notNum = () => typeof bump() !== 'number'
      export let count = () => n
    `, { optimize }).exports
    is(bo.isBool(), true, `O${optimize || 0}: typeof boolean-return === 'boolean' (staticFold)`)
    is(bo.count(), 1, `O${optimize || 0}: staticFold still ran bump()`)
    is(bo.notBool(), false, `O${optimize || 0}: negated staticFold`)
    is(bo.count(), 2, `O${optimize || 0}: negated staticFold still ran bump()`)
    is(bo.isNum(), false, `O${optimize || 0}: typeof boolean-return === 'number' folds false (BOOL-carrier fold)`)
    is(bo.count(), 3, `O${optimize || 0}: BOOL-carrier fold still ran bump()`)
    is(bo.notNum(), true, `O${optimize || 0}: negated BOOL-carrier fold`)
    is(bo.count(), 4, `O${optimize || 0}: negated BOOL-carrier fold still ran bump()`)

    const bi = jz(`
      let m = 0
      function g() { m = m + 1; return 5n }
      export let isBig = () => typeof g() === 'bigint'
      export let notBig = () => typeof g() !== 'bigint'
      export let count = () => m
    `, { optimize }).exports
    is(bi.isBig(), true, `O${optimize || 0}: typeof bigint-return === 'bigint' (staticFold)`)
    is(bi.count(), 1, `O${optimize || 0}: bigint staticFold still ran g()`)
    is(bi.notBig(), false, `O${optimize || 0}: negated bigint staticFold`)
    is(bi.count(), 2, `O${optimize || 0}: negated bigint staticFold still ran g()`)
  }
})

test('RepresentationPlan: a polymorphic-receiver param stays runtime-dispatched, never hardcoded from one call site (fix/selfhost-hash-read)', () => {
  // Root cause (fix/selfhost-hash-read, no shape8 dependency — this is the
  // general compiler bug, reproducible on an ordinary compiled program, that
  // self-hosting exposed for representation-plan.js's own buildBodyData/
  // ensureBoundary identity param): paramReps' `val` field (exact-kind meet)
  // and `possibleKinds` (existential, wider-census join) are computed
  // INDEPENDENTLY over the same call sites (src/param-reps.js's own header).
  // A shared function whose ONE call site passes a directly-provable literal
  // (`dispatch({...})`) and whose OTHER call site passes an array-element-
  // derived value (`dispatch(list[i])` — `val`'s narrower, soft-merge
  // observation set never resolves an exact kind for it, so it contributes
  // NO vote at all) settles `val` to the literal site's kind alone, even
  // though the array-element site's value is a DIFFERENT PTR-tagged shape at
  // runtime. emitTypeTag (src/ir.js) trusted that lone, non-representative
  // `val` unconditionally, hardcoding `(i32.const PTR.OBJECT)` for `x`'s
  // runtime type-tag argument instead of reading it — so `x?.name` on the
  // array-derived (PTR.HASH) receiver misdispatched into the OBJECT
  // (schema-slot) codepath and silently returned undefined, for EVERY
  // property, not just `.name` (mirrors the identical shape defFunc's own
  // conditional-spread funcInfo hits when representation-plan.js's identity
  // param crosses its own compile/index.js array-element vs. wat/assemble.js
  // object-literal call sites, self-hosted).
  // Export is named `go`, not `run`: under host:'wasi' `run` is the entry point and its
  // return value is discarded (test/_matrix.js) — the pin must stay observable on the wasi leg.
  const src = `
    function mkHash(hasDefaults) {
      return { name: 'H', body: 1, exported: 2, sig: 3, ...(hasDefaults && {defaults: 4}) }
    }
    function dispatch(x) {
      return x?.name
    }
    const list = []
    function build(hasDefaults) {
      list.push(mkHash(hasDefaults))
    }
    function useDirect() {
      return dispatch({ name: 'O', body: 9 })
    }
    function useArrElem(i) {
      return dispatch(list[i])
    }
    export function go() {
      build(true)
      const a = useDirect()
      const b = useArrElem(0)
      return a + '|' + b
    }
  `
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    is(e.go(), 'O|H', `O${optimize || 0}: both the literal-object and array-element-HASH call sites read their own .name correctly`)
  }
})

// --- possibleKinds census ordering (src/compile/narrow.js mergeRule
// trackKind) — a forwarding argument used to permanently pessimize the
// census if the worklist visited it before its own source had settled ---

test('RepresentationPlan: a forwarded, genuinely monomorphic array param is trusted (possibleKinds census ordering)', () => {
  // Root cause: paramReps' possibleKinds census (param-reps.js — the wide,
  // existential cross-check paramValTrustworthy gates on) used to ride EVERY
  // sweep of the soft `val` worklist fixpoint (narrow.js mergeRule's
  // trackKind flag). uleb's `buffer` param (default `= []`; every call site —
  // direct, its own recursive self-call, AND a second function `wleb`
  // FORWARDING its own still-unsettled `out` param into uleb) genuinely
  // converges to one val: ARRAY. But a premature worklist visit of the
  // wleb->uleb call site — before wleb's OWN `out` had itself settled — used
  // to permanently join the full KIND_UNIVERSE into possibleKinds (joinKinds
  // is a monotone union, no retraction), so paramValTrustworthy wrongly
  // distrusted a genuinely monomorphic param and forced it onto the runtime
  // shadow-probe path (mirrors watr's actual encode.js uleb/wleb shape —
  // .work/archive/string-method-guess-notes.md's "Root cause of the REMAINING
  // ~16718-byte gap"). `pushInto` (exported — no in-program call sites at
  // all, genuinely unprovable) shares this compiled unit so the shadow-probe
  // machinery (ctx.closure.call, pulled in by makeCounter's own-property
  // closure) is definitely available — the uleb result below isn't a vacuous
  // "no closures anywhere, so nothing can ever probe."
  const src = `
    const uleb = (n, buffer = []) => {
      let byte = n & 0x7f
      n >>>= 7
      if (n === 0) { buffer.push(byte); return buffer }
      buffer.push(byte | 0x80)
      return uleb(n, buffer)
    }
    const wleb = (v, out) => { if (out) { uleb(v, out); return } return uleb(v) }
    function makeCounter() {
      const c = { n: 0 }
      c.push = (v) => { c.n += v; return c.n }
      return c
    }
    function useClosure() { return makeCounter().push(7) }
    export function pushInto(o, v) { o.push(v); return o.length }
    export function useIt() {
      const b = []
      wleb(5, b)
      return uleb(300).length + useClosure()
    }
  `
  const wat = String(compile(src, { optimize: false, wat: true }))
  const extractBody = (fname) => {
    const start = wat.indexOf(`(func $${fname}`)
    return wat.slice(start, wat.indexOf('\n  (func ', start + 1))
  }
  ok(!/__dyn_get_expr/.test(extractBody('uleb')), "O0: uleb's forwarded, genuinely-monomorphic array param keeps direct array codegen — no shadow probe")
  ok(/__dyn_get_expr/.test(extractBody('pushInto')), 'O0: pushInto (exported, genuinely unprovable) DOES get the shadow probe — confirms the probe machinery is live in this exact compiled unit, so the uleb result above is not vacuous')
  is(jz(src, { optimize: false }).exports.useIt(), 9, 'O0: uleb(300) ULEB128-encodes to 2 bytes (0xAC,0x02) — .length=2, plus useClosure()=7')
})

test('RepresentationPlan: a forwarded param stays untrusted when its OWN source is genuinely polymorphic (not merely an ordering artifact)', () => {
  // Negative control for the fix above: sink's `buf` has one direct,
  // concrete-ARRAY call site (useDirect) AND one forwarding call site
  // (forward -> sink) whose SOURCE (forward's own param `x`) is genuinely
  // polymorphic — ARRAY at one of forward's own call sites, a closure-bearing
  // hash-shaped object at the other — so forward.x's val never settles to a
  // single kind (real disagreement, not an ordering artifact). sink.buf's
  // narrow val fold still reads as pure ARRAY (the forwarding site
  // contributes no vote under the soft merge — mirrors the existing
  // "RepresentationPlan: a polymorphic-receiver param stays
  // runtime-dispatched" pin above, one forwarding hop deeper): the fix above
  // must not weaken this — sink.buf has to stay runtime-dispatched.
  const src = `
    function makeHijack() {
      const h = { n: 0 }
      h.push = (v) => { h.n += v }
      return h
    }
    function sink(buf) { buf.push(1); return buf.length }
    function forward(x) { return sink(x) }
    function useDirect() { return sink([7]) }
    function useForwardArr() { return forward([1, 2]) }
    function useForwardHijack() { return forward(makeHijack()) }
    export function polyUse() {
      return useDirect() + useForwardArr() + useForwardHijack()
    }
  `
  const wat = String(compile(src, { optimize: false, wat: true }))
  const start = wat.indexOf('(func $sink')
  const body = wat.slice(start, wat.indexOf('\n  (func ', start + 1))
  ok(/__dyn_get_expr/.test(body), "O0: sink's buf param stays runtime-dispatched — the wider census still catches the genuine polymorphism reaching it through forward, not just the ordering artifact the positive pin above fixes")
  for (const optimize of [false, 2, 3]) {
    // makeHijack's object has no .length — buf.length legitimately reads
    // undefined -> NaN through the real (runtime-dispatched) property read,
    // consistently across optimize levels, not a garbage jz-Array header word.
    ok(Number.isNaN(jz(src, { optimize }).exports.polyUse()), `O${optimize || 0}: the hijack leg's real (dynamic) .length is undefined -> NaN, not a misread ARRAY header`)
  }
})

test("RepresentationPlan: possibleKinds census is pass-order-independent — swapping two forwarding functions' declaration order yields byte-identical WAT", () => {
  // The bug was specifically an ordering artifact of narrow.js's worklist
  // (which call site the fixpoint happens to visit first) — the strongest
  // direct proof it's gone is that source-level declaration order (which
  // determines the worklist's initial seed order) no longer affects the
  // compiled output at all.
  const ulebSrc = `
    const uleb = (n, buffer = []) => {
      let byte = n & 0x7f
      n >>>= 7
      if (n === 0) { buffer.push(byte); return buffer }
      buffer.push(byte | 0x80)
      return uleb(n, buffer)
    }
  `
  const wlebSrc = `
    const wleb = (v, out) => { if (out) { uleb(v, out); return } return uleb(v) }
  `
  const tailSrc = `
    export function useIt() {
      const b = []
      wleb(5, b)
      return uleb(300).length
    }
  `
  const shapeUlebFirst = ulebSrc + wlebSrc + tailSrc
  const shapeWlebFirst = wlebSrc + ulebSrc + tailSrc
  const watUlebFirst = String(compile(shapeUlebFirst, { optimize: 3, wat: true }))
  const watWlebFirst = String(compile(shapeWlebFirst, { optimize: 3, wat: true }))
  is(watUlebFirst, watWlebFirst, 'O3: declaring uleb before wleb or after compiles to byte-identical WAT — the census no longer depends on which function the worklist happens to visit first')
})

// --- .subarray() after a same-property dynamic-index write elsewhere in the
// unit (tryRuntimePtrTypeFork's genEmitter gate — was KNOWN-WRONG) ---
//
// Root cause, two layers that turned out to be ONE mechanism:
//
// Layer A (src/kind.js VT['.'], the object-literal child-type fold, ~"schema
// slot write hazard" census): a property's static kind is nulled program-wide
// the moment ANY write to a same-named property, anywhere in the compiled
// unit, has a non-literal index the analyzer can't resolve to a constant —
// keyed by property NAME/schema slot via STATIC data-flow (the call graph /
// closure capture), not by receiver identity and not by RUNTIME reachability.
// A closure merely DEFINED (never called) that closes over the same object
// already counts, because the capture itself is a static data-flow edge; a
// standalone function whose parameter is unified with the object's schema
// through a real (even zero-iteration-at-runtime) call edge counts too. This
// half is a deliberate fail-closed conservatism for the STATIC type fold —
// sound BY ITSELF, as long as the runtime fallback for "kind unknown" stays
// correct.
//
// Layer B (src/compile/emit.js tryRuntimePtrTypeFork, method-call dispatch
// strategy #8 of emitMethodCall's 12-strategy chain) is where it stops being
// sound: this is the strategy that's SUPPOSED to catch "static kind unknown"
// by checking the receiver's real ptr-tag at runtime instead of guessing —
// but its guard was `!vt && genEmitter && (strEmitter || typedEmitter)`,
// unconditionally requiring a GENERIC (bare, non-kind-prefixed) emitter to
// exist before attempting ANY runtime dispatch. `.subarray` has no generic
// Array analog (real JS: TypedArray.prototype.subarray only — kind-traits.js
// methodValType's own comment: "no plain-array analog"), so `genEmitter` is
// always undefined for it and the whole runtime fork silently declined —
// even though `.typed:subarray` (module/typedarray.js) was right there,
// itself already capable of a further runtime dispatch when only the
// TYPED array's element ctor (not its typed-ness) is unknown. Execution fell
// through to strategy #11 (tryDynamicPropCall), which treats an unresolved
// method name as an arbitrary DYNAMIC OWN PROPERTY to fetch and invoke as a
// closure — correct for a genuine user closure property, always wrong for a
// built-in prototype intrinsic no runtime value ever stores as an own
// hash-keyed property. Depending on surrounding code shape this either
// silently returned `undefined` (small function, few locals) or trapped
// `unreachable` after jz's own runtime manufactured an internal
// "TypeError: Cannot read properties of undefined" and had no reachable
// try/catch to route it to (larger function — matches the original watr
// streaming-code-section self-compile symptom this was found chasing:
// decodeThrown seeing a RuntimeError it couldn't cleanly decode).
//
// Fix: tryRuntimePtrTypeFork's guard now only requires `(strEmitter ||
// typedEmitter)` — when no generic emitter exists, the runtime fork's
// "neither STRING nor TYPED" arm defers to the SAME tryDynamicPropCall /
// externalMethodFallback strategies the chain would have tried next anyway
// (reusing the already-evaluated receiver temp, so a non-pure receiver
// expression is never evaluated twice), instead of refusing to dispatch at
// all. General fix for any string/typed-exclusive method with no generic
// counterpart — not a `.subarray`-specific special case.
test('typed array: .subarray() stays sound after a same-property dynamic-index write elsewhere (tryRuntimePtrTypeFork genEmitter gate)', () => {
  // Minimal shape: a closure ATTACHED to the object literal post-construction
  // (`b.set = ...`, not a literal-time method) whose body writes `b.buf[i] =
  // v` using its OWN parameter as the index. Calling `b.set(...)` isn't even
  // required — the closure only has to EXIST (see the "defined, never
  // called" pin below) — but this pin also exercises the call, matching the
  // originally-reported repro shape (a closure attached to an object literal,
  // used as its own typed-array-index method).
  for (const optimize of [false, 2, 3]) {
    const src = `
      export function main() {
        const b = { buf: new Uint8Array(8), n: 0 }
        b.set = (i, v) => { b.buf[i] = v }
        b.inc = (i) => { b.buf[i]++ }
        b.set(3, 7)
        b.inc(3)
        const s = b.buf.subarray(0, 4)
        return s[3]
      }
    `
    const e = jz(src, { optimize }).exports
    is(e.main(), 8, `O${optimize || 0}: .subarray() after closure-method writes reads the real receiver, not a dynamic-property lookup of "subarray"`)
  }
})

test('typed array: .subarray() stays sound even when the poisoning closure is only DEFINED, never called', () => {
  for (const optimize of [false, 2, 3]) {
    const src = `
      export function main() {
        const b = { buf: new Uint8Array(8), n: 0 }
        b.set = (i, v) => { b.buf[i] = v }  // dead code — never invoked
        b.buf[3] = 7                        // literal-index direct write, unaffected
        const s = b.buf.subarray(0, 4)
        return s[3]
      }
    `
    const e = jz(src, { optimize }).exports
    is(e.main(), 7, `O${optimize || 0}: an uncalled closure's dynamic-index write must not null the receiver's kind for .subarray()`)
  }
})

test('typed array: .subarray() stays sound across a real (zero-iteration-at-runtime) call graph, regardless of unrelated sibling functions', () => {
  // Standalone-function variant (no methods/closures at all) mirroring the
  // watr streaming-code-section self-compile symptom this was found chasing
  // (buildCodeItemStreaming-shaped call chain: main -> writeSome -> inner ->
  // bufPush, `out` threaded as a plain parameter throughout). Traps at
  // count=0 pre-fix even though the loop body (the only place any write
  // happens) never runs — the schema-slot hazard is established by the
  // STATIC call graph (bufPush's parameter unified with makeByteBuf's return
  // shape), not by which loop iterations actually execute.
  for (const optimize of [false, 2, 3]) {
    const src = `
      const makeByteBuf = (cap) => { const buf0 = new Uint8Array(cap); const b = { buf: buf0, length: 0 }; return b }
      function bufEnsure(b, n) {
        if (b.length + n <= b.buf.length) return
        let cap2 = b.buf.length * 2 || 1024
        while (cap2 < b.length + n) cap2 *= 2
        const nb = new Uint8Array(cap2)
        nb.set(b.buf.subarray(0, b.length))
        b.buf = nb
      }
      function bufPush(b, ...xs) { bufEnsure(b, xs.length); for (let i = 0; i < xs.length; i++) b.buf[b.length++] = xs[i]; return b.length }
      function bufToBytes(b) { return b.buf.subarray(0, b.length) }
      function inner(out, seed) { bufPush(out, seed & 0xff, (seed + 1) & 0xff) }
      function writeSome(out, seed) { inner(out, seed) }
      export function main(count) {
        const buf = makeByteBuf(64)
        for (let i = 0; i < count; i++) writeSome(buf, i)
        const bytes = bufToBytes(buf)
        return bytes.length * 1000 + (bytes.length > 0 ? bytes[0] : 0)
      }
    `
    const e = jz(src, { optimize }).exports
    is(e.main(0), 0, `O${optimize || 0}: count=0 (no write ever executes) still reaches bufToBytes's .subarray() and must not trap`)
  }
})

// --- object mutated inside a function via a PARAMETER did not propagate
// back (src/compile/infer.js methodEvidence guessing ARRAY from usage) ---
//
// Root cause: infer.js's `methodEvidence` evidence source (part of
// `inferParams`, seeded into a parameter's `val` fact whenever the
// cross-function call-site fixpoint had no proof of its own — see that
// module's header, rung 2/3 of its evidence ladder) treated seeing
// `<param>.push(...)` (or pop/shift/unshift/splice/flat/flatMap —
// ARRAY_INDUCERS, kind-traits.js) as PROOF the parameter is a real Array.
// That is only sound for the STRING-vs-non-STRING question (no
// String.prototype method of those names exists) — it is NOT proof of
// ARRAY specifically: a plain OBJECT/HASH value can equally own a
// same-named closure property (`b.push = (v) => {...}`, attached to an
// object literal post-construction — the makeByteBuf/ByteBuf idiom: a
// growable byte buffer built from push/ensure/growth, exactly what watr's
// streaming WASM code-section encoder uses). Once wrongly settled to
// VAL.ARRAY, every downstream consumer trusted it as fully proven:
//   - src/compile/emit.js's tryGenericEmitter (method-call dispatch,
//     strategy #10) only shadow-probes an own property when `vt == null`;
//     a non-null (but merely guessed) ARRAY skipped the probe and
//     dispatched `.push(v)` straight to jz's built-in Array-growth codegen
//     (__arr_grow_known et al) instead of the user's own closure, so the
//     write landed on the wrong memory shape entirely — silently a no-op
//     for a small buffer, an out-of-bounds trap for a larger one.
//   - module/core.js's emitLengthAccess (property READ, not a method call)
//     unconditionally reads a jz Array's length HEADER WORD for any
//     VAL.ARRAY receiver — sound for a REAL array (no own-property shadow
//     is ever possible there), unsound here: a `.length` read elsewhere in
//     the SAME function silently read the wrong memory offset instead of
//     the object's real (dynamic, hash-keyed) `length` property.
// Two consumers independently broken by one bad fact, with no way to
// enumerate every consumer with confidence — fixed at the source instead:
// methodEvidence no longer induces a positive ARRAY verdict from usage
// syntax at all. `ARRAY_ONLY_POISON` (a strict superset of the names) still
// proves the sound negative ("not a STRING"), restoring the module's own
// documented contract ("Default is never wrong, only sometimes wider than
// necessary" — infer.js header). emit.js's tryGenericEmitter also gained a
// narrower, defense-in-depth widening of its own shadow probe for the same
// shape, kept as a second layer.
test('object mutated via a parameter: plain field reassignment propagates back', () => {
  for (const optimize of [false, 2, 3]) {
    const src = `
      function bump(o) { o.n = o.n + 1 }
      export function main() {
        const o = { n: 0 }
        bump(o)
        bump(o)
        return o.n
      }
    `
    const e = jz(src, { optimize }).exports
    is(e.main(), 2, `O${optimize || 0}: two calls through a parameter each reassign the caller's own field`)
  }
})

test('object mutated via a parameter: typed-array field growth (reassignment) propagates back', () => {
  for (const optimize of [false, 2, 3]) {
    const src = `
      function grow(o) {
        const nb = new Uint8Array(o.buf.length * 2)
        nb.set(o.buf)
        nb[0] = 99
        o.buf = nb
      }
      export function main() {
        const o = { buf: new Uint8Array(4) }
        o.buf[0] = 1
        grow(o)
        return o.buf.length + o.buf[0]
      }
    `
    const e = jz(src, { optimize }).exports
    is(e.main(), 107, `O${optimize || 0}: a callee reassigning a typed-array field (growth) is visible through the caller's own reference`)
  }
})

test('object mutated via a parameter: nested call depth 2 propagates back', () => {
  for (const optimize of [false, 2, 3]) {
    const src = `
      function inner(o, v) { o.buf[o.n] = v; o.n = o.n + 1 }
      function outer(o, v) { inner(o, v) }
      export function main() {
        const o = { buf: new Uint8Array(8), n: 0 }
        outer(o, 5)
        outer(o, 9)
        return o.n * 100 + o.buf[0] * 10 + o.buf[1]
      }
    `
    const e = jz(src, { optimize }).exports
    is(e.main(), 259, `O${optimize || 0}: a mutation two call-frames deep (main -> outer -> inner) still reaches the original object`)
  }
})

test('object mutated via a parameter: loop with zero and one iterations propagates back', () => {
  for (const optimize of [false, 2, 3]) {
    const src = `
      function bump(o) { o.n = o.n + 1 }
      export function main(count) {
        const o = { n: 0 }
        for (let i = 0; i < count; i++) bump(o)
        return o.n
      }
    `
    const e = jz(src, { optimize }).exports
    is(e.main(0), 0, `O${optimize || 0}: zero iterations — no mutation, field stays at its initial value`)
    is(e.main(1), 1, `O${optimize || 0}: one iteration — the single call's mutation propagates back`)
  }
})

test('object mutated via a parameter: closure method named like an Array builtin (.push) called through a parameter', () => {
  // The exact shape that broke: an object literal with a POST-HOC attached
  // closure property named `push` (not a real Array), mutated by calling
  // that closure THROUGH a separate function's own parameter — the
  // minimal core of the makeByteBuf/writeItem idiom below.
  for (const optimize of [false, 2, 3]) {
    const src = `
      const makeBuf = (cap) => {
        const b = { buf: new Uint8Array(cap), n: 0 }
        b.push = (v) => { b.buf[b.n] = v; b.n = b.n + 1 }
        return b
      }
      function writeOne(out, v) { out.push(v) }
      export function main(count) {
        const buf = makeBuf(64)
        for (let i = 0; i < count; i++) writeOne(buf, i + 1)
        return buf.n * 1000 + buf.buf[0] * 10 + buf.buf[1]
      }
    `
    const e = jz(src, { optimize }).exports
    is(e.main(0), 0, `O${optimize || 0}: count=0 — no push, buffer stays empty`)
    is(e.main(1), 1010, `O${optimize || 0}: one push through the param calls the object's OWN closure, not the Array builtin`)
    is(e.main(3), 3012, `O${optimize || 0}: three pushes through the param, each one visible to the next`)
  }
})

test('object mutated via a parameter: .length read elsewhere in the same function stays sound after a same-object .push() call', () => {
  // Isolates the SECOND consumer (module/core.js emitLengthAccess) from the
  // method-dispatch consumer above: `out.length` is a plain property READ,
  // not a method call, computed BEFORE any push — this pin fails if that
  // read is ever compiled as a jz-Array header load (ptr-8) instead of the
  // object's real dynamic `length` property, independent of whether
  // `.push()` itself dispatches correctly.
  for (const optimize of [false, 2, 3]) {
    const src = `
      const makeByteBuf = (cap) => {
        const buf0 = new Uint8Array(cap)
        const b = { buf: buf0, length: 0 }
        b.ensure = (n) => {
          if (b.length + n <= b.buf.length) return
          let cap2 = b.buf.length * 2 || 1024
          while (cap2 < b.length + n) cap2 *= 2
          const nb = new Uint8Array(cap2)
          nb.set(b.buf.subarray(0, b.length))
          b.buf = nb
        }
        b.push = (...xs) => { b.ensure(xs.length); for (let i = 0; i < xs.length; i++) b.buf[b.length++] = xs[i]; return b.length }
        b.set = (i, v) => { b.buf[i] = v }
        b.inc = (i) => { b.buf[i]++ }
        b.toBytes = () => b.buf.subarray(0, b.length)
        return b
      }
      const uleb5 = (value) => {
        const result = []
        for (let i = 0; i < 5; i++) {
          let byte = value & 0x7f
          value >>>= 7
          if (i < 4) byte |= 0x80
          result.push(byte)
        }
        return result
      }
      const patchUleb5 = (buf, at, value) => { const bytes = uleb5(value); for (let i = 0; i < 5; i++) buf.set(at + i, bytes[i]) }
      function writeItem(out, seed) {
        const sizeAt = out.length
        out.push(0x80, 0x80, 0x80, 0x80, 0x00)
        const bodyStart = out.length
        const n = (seed % 37) + 1
        for (let i = 0; i < n; i++) out.push((seed + i) & 0xff)
        patchUleb5(out, sizeAt, out.length - bodyStart)
      }
      export function main() {
        const buf = makeByteBuf(64)
        writeItem(buf, 0)
        return buf.buf[0] * 1000000 + buf.buf[1] * 100000 + buf.buf[2] * 10000 + buf.buf[3] * 1000 + buf.buf[4]
      }
    `
    const e = jz(src, { optimize }).exports
    is(e.main(), 143208000, `O${optimize || 0}: the ULEB128 size-prefix backpatch (first byte 0x81) lands correctly — sizeAt/.length reads stayed sound`)
  }
})

test('object mutated via a parameter: the real watr-shaped repro (makeByteBuf/writeItem/uleb5/patchUleb5) matches native JS for every count', () => {
  // The original repro this whole investigation traced back to (watr's
  // streaming WASM code-section encoder, isolated as scratch/diff/
  // snippet-bytebuf.js by the sibling agent that first hit this).
  const src = `
    const makeByteBuf = (cap) => {
      const buf0 = new Uint8Array(cap)
      const b = { buf: buf0, length: 0 }
      b.ensure = (n) => {
        if (b.length + n <= b.buf.length) return
        let cap2 = b.buf.length * 2 || 1024
        while (cap2 < b.length + n) cap2 *= 2
        const nb = new Uint8Array(cap2)
        nb.set(b.buf.subarray(0, b.length))
        b.buf = nb
      }
      b.push = (...xs) => { b.ensure(xs.length); for (let i = 0; i < xs.length; i++) b.buf[b.length++] = xs[i]; return b.length }
      b.set = (i, v) => { b.buf[i] = v }
      b.inc = (i) => { b.buf[i]++ }
      b.toBytes = () => b.buf.subarray(0, b.length)
      return b
    }
    const uleb5 = (value) => {
      const result = []
      for (let i = 0; i < 5; i++) {
        let byte = value & 0x7f
        value >>>= 7
        if (i < 4) byte |= 0x80
        result.push(byte)
      }
      return result
    }
    const patchUleb5 = (buf, at, value) => { const bytes = uleb5(value); for (let i = 0; i < 5; i++) buf.set(at + i, bytes[i]) }
    function writeItem(out, seed) {
      const sizeAt = out.length
      out.push(0x80, 0x80, 0x80, 0x80, 0x00)
      const bodyStart = out.length
      const n = (seed % 37) + 1
      for (let i = 0; i < n; i++) out.push((seed + i) & 0xff)
      patchUleb5(out, sizeAt, out.length - bodyStart)
    }
    export function main(count) {
      const buf = makeByteBuf(64)
      for (let i = 0; i < count; i++) writeItem(buf, i)
      const bytes = buf.toBytes()
      let sum = 0
      for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i] * (i % 251 + 1)) | 0
      return (sum ^ bytes.length) | 0
    }
  `
  const expected = { 0: 0, 1: 1287, 2: 5688, 3: 13824, 5: 44452 }
  for (const optimize of [false, 2, 3]) {
    const e = jz(src, { optimize }).exports
    for (const count of [0, 1, 2, 3, 5]) {
      is(e.main(count), expected[count], `O${optimize || 0} count=${count}: matches native JS`)
    }
  }
})

test('object passed as a parameter: a param that is only READ keeps its direct (non-shadow-probed) codegen — WAT shape', () => {
  // Negative control for the fix above: a parameter proven ARRAY through a
  // real construction/call-site proof (a literal array argument, resolved
  // by the cross-function paramReps fixpoint — never through the removed
  // methodEvidence guess) and used only for `.length`/index READS must
  // keep the direct, fast array-header codegen — no own-property shadow
  // probe, no dynamic dispatch. Confirms the fix is scoped to the unsound
  // guess and doesn't tax the common, already-sound proven-array path.
  const src = `
    function sumArr(a) {
      let s = 0
      for (let i = 0; i < a.length; i++) s += a[i]
      return s
    }
    export function main() {
      return sumArr([1, 2, 3, 4, 5])
    }
  `
  is(jz(src, { optimize: false }).exports.main(), 15, 'O0: sum of a literal-array argument through a read-only parameter')
  const wat = String(compile(src, { optimize: false, wat: true }))
  const start = wat.indexOf('(func $sumArr')
  const next = wat.indexOf('\n  (func ', start + 1)
  const body = wat.slice(start, next)
  ok(!/__dyn_get_expr/.test(body), 'O0: sumArr never probes for an own-property shadow — a.length/a[i] compile straight through')
  ok(/\$__ptr_offset/.test(body) && /i32\.const 8/.test(body), 'O0: .length still reads the direct array-header word (fast path unchanged)')
})

// --- object mutated/read inside a function via a PARAMETER, called with a
// method name that collides with a jz STRING builtin (charCodeAt/trim/
// padStart/…) — the STRING twin of the ARRAY_INDUCERS bug above
// (fix/string-method-guess) ---
//
// Root cause: infer.js's `methodEvidence` evidence source (the SAME source
// fixed above for ARRAY_INDUCERS) also treated seeing `<param>.charCodeAt(...)`
// (or trim/padStart/… — STRING_ONLY_METHODS) as PROOF the parameter is a real
// String. Once wrongly settled to VAL.STRING, downstream consumers trusted it
// as fully proven — a plain OBJECT/HASH value can equally own a same-named
// closure property attached post-construction (`t.charCodeAt = (i) => t.n +
// i`), and jz has no prototype chain to rule that out from the method NAME
// alone. Unlike the ARRAY_INDUCERS names (which have no `.array:${method}`
// emitter and so land on tryGenericEmitter's shadow-probed strategy 10),
// STRING_ONLY_METHODS have no `.string:${method}` sibling emitter EITHER —
// they're registered bare (`.charCodeAt`, `.trim`, …) — so they ALSO land on
// strategy 10, and a wrongly-guessed non-null `vt` skipped that strategy's
// own-property shadow probe exactly the same way, dispatching straight to
// jz's built-in STRING codegen (the SSO/heap charCodeAt decoder, the trim
// byte-scan, …) on a receiver that was never a real string
// (fix/string-method-guess: `o.charCodeAt(1)` on such an object returned NaN
// at O0 instead of calling the user's own closure). methodEvidence no longer
// induces a positive STRING (or ARRAY) verdict from method-name usage AT ALL
// — the whole rung retired to a sound no-op (see that module's header). The
// STRING_ONLY_METHODS set itself stays (notStringEvidence, a separate source,
// still needs it for the unrelated write-shape "isn't a string" proof).
test('object read via a parameter: closure method named like a String builtin (charCodeAt) called through a parameter', () => {
  // The exact shape that broke: an object literal with a POST-HOC attached
  // closure property named `charCodeAt` (not a real String), read by calling
  // that closure THROUGH a separate function's own parameter.
  for (const optimize of [false, 2, 3]) {
    const src = `
      function makeT(n) { const t = { n }; t.charCodeAt = (i) => t.n + i; return t }
      function call1(o) { return o.charCodeAt(1) }
      export function main() { return call1(makeT(100)) }
    `
    is(jz(src, { optimize }).exports.main(), 101, `O${optimize || 0}: charCodeAt through the param calls the object's OWN closure, not jz's SSO/heap string decoder`)
  }
})

test('object read via a parameter: closure method named like a String builtin (trim) called through a parameter', () => {
  for (const optimize of [false, 2, 3]) {
    const src = `
      function makeT(n) { const t = { n }; t.trim = () => t.n * 2; return t }
      function call1(o) { return o.trim() }
      export function main() { return call1(makeT(50)) }
    `
    is(jz(src, { optimize }).exports.main(), 100, `O${optimize || 0}: trim through the param calls the object's OWN closure, not jz's built-in trim`)
  }
})

test('object read via a parameter: closure method named like a String builtin (padStart) called through a parameter', () => {
  for (const optimize of [false, 2, 3]) {
    const src = `
      function makeT(n) { const t = { n }; t.padStart = (w) => t.n + w; return t }
      function call1(o) { return o.padStart(7) }
      export function main() { return call1(makeT(35)) }
    `
    is(jz(src, { optimize }).exports.main(), 42, `O${optimize || 0}: padStart through the param calls the object's OWN closure, not jz's built-in padStart`)
  }
})

test('object read via a parameter: loop with zero and one iterations propagates the charCodeAt-closure call', () => {
  for (const optimize of [false, 2, 3]) {
    const src = `
      function makeT(n) { const t = { n: n }; t.charCodeAt = (i) => { t.n = t.n + i; return t.n }; return t }
      function bump(o) { o.charCodeAt(1) }
      export function main(count) {
        const t = makeT(0)
        for (let i = 0; i < count; i++) bump(t)
        return t.n
      }
    `
    const e = jz(src, { optimize }).exports
    is(e.main(0), 0, `O${optimize || 0}: count=0 — no call, field stays at its initial value`)
    is(e.main(1), 1, `O${optimize || 0}: count=1 — the single call's own closure runs (not jz's charCodeAt decoder)`)
  }
})

test('object read via a parameter: .length read elsewhere in the same function stays sound after a same-object .charCodeAt() call', () => {
  // Isolates the SECOND consumer (module/core.js emitLengthAccess) from the
  // method-dispatch consumer above, mirroring the identical ARRAY-side pin:
  // `o.length` is a plain property READ, not a method call — this pin fails
  // if that read is ever compiled as a jz-String byteLen op instead of the
  // object's real (dynamic) `length` property, independent of whether
  // `.charCodeAt()` itself dispatches correctly.
  for (const optimize of [false, 2, 3]) {
    const src = `
      function makeT(n) { const t = { n, length: 7 }; t.charCodeAt = (i) => t.n + i; return t }
      function useIt(o) { const a = o.charCodeAt(1); const b = o.length; return a * 100 + b }
      export function main() { return useIt(makeT(2)) }
    `
    is(jz(src, { optimize }).exports.main(), 307, `O${optimize || 0}: the object's own dynamic .length (7) reads correctly, not a jz-String byte-length op`)
  }
})

test('object read via a parameter: the STRING-guess WAT-dispatch shape — unproven param gets a probe, call-site-proven param does not', () => {
  // WAT-shape controls (mirror the ARRAY fix's own negative control): whether
  // the compiler inserts an own-property shadow probe (__dyn_get_expr) around
  // a `.charCodeAt` call is driven by call-site PROOF, not by usage syntax.
  // Both programs below have a closure elsewhere (`useCallback`) so the probe
  // machinery (ctx.closure.call) is actually available in both — isolating
  // the one variable under test: is `s` proven STRING at the call site or not.
  const provenSrc = `
    function firstCode(s) { return s.charCodeAt(0) }
    function useCallback(f) { return f(1) }
    export function main() {
      return useCallback((x) => x + 1) + firstCode('ab')
    }
  `
  const unprovenSrc = `
    function firstCode(s) { return s.charCodeAt(0) }
    function useCallback(f) { return f(1) }
    export function main(x) {
      return useCallback((y) => y + 1) + firstCode(x)
    }
  `
  const extractBody = (wat) => {
    const start = wat.indexOf('(func $firstCode')
    const next = wat.indexOf('\n  (func ', start + 1)
    return wat.slice(start, next)
  }
  const provenBody = extractBody(String(compile(provenSrc, { optimize: false, wat: true })))
  const unprovenBody = extractBody(String(compile(unprovenSrc, { optimize: false, wat: true })))
  ok(!/__dyn_get_expr/.test(provenBody), 'O0: a call-site-proven (paramReps) string param keeps direct STRING dispatch — no shadow probe inserted')
  ok(/ccbase/.test(provenBody), 'O0: the proven param still reaches the SSO/heap charCodeAt fast decoder')
  ok(/__dyn_get_expr/.test(unprovenBody), 'O0: an unproven param (no call-site proof, methodEvidence retired) DOES get the own-property shadow probe — confirms the fix changes real codegen, not vacuously')
})

test('closed computed-dispatch table: a member forwarded into a named function gets its param proven from the table\'s own callers (positive) vs stays runtime-dispatched once the table escapes (negative control)', () => {
  // watr's real shape (.work/archive/string-method-guess-notes.md "Third follow-up
  // session"): `const HANDLER = { a: (buf,v) => push2(buf,v), ... }`, invoked
  // ONLY as `HANDLER[key](buf, v)`. Nobody ever calls `push2` by a bare name
  // anywhere in the program — before this fix its `buf` param had ZERO
  // observations (the outer computed dispatch is invisible to the call-site
  // walker; program-facts.js's own doc on synthesizeComputedDispatchCallSites
  // has the full mechanism). `instr`'s own `out` literal is genuinely,
  // monomorphically an array at the one real call site — call-target-index.js's
  // resolveComputed proves HANDLER closed (every property a same-module
  // arrow, no escape/dynWrite/shadow/rebind), and the synthesis walks `a`'s
  // own body for its call to push2, substituting `a`'s formal params with
  // `instr`'s actual arguments.
  const closedSrc = `
    const push2 = (buf, v) => { buf.push(v); buf.push(v + 1); return buf }
    const HANDLER = {
      a: (buf, v) => push2(buf, v),
      b: (buf, v) => { buf.push(v); return buf },
    }
    function instr(buf, key, v) { return HANDLER[key](buf, v) }
    export function main() {
      let out = []
      instr(out, 'a', 5)
      return out.length
    }
  `
  // Negative control: byte-identical shape, except HANDLER is also handed to
  // an unrelated function (`leak`) — a genuine value-escaping use (passed as
  // an argument, not a `[]`-receiver/`__keys_ro` read) — so resolveComputed
  // must decline the whole table, same as resolveMember already would.
  // push2's `buf` stays exactly as unprovable as it always was: real runtime
  // dispatch, not a wrong guess.
  const escapedSrc = `
    const push2 = (buf, v) => { buf.push(v); buf.push(v + 1); return buf }
    const HANDLER = {
      a: (buf, v) => push2(buf, v),
      b: (buf, v) => { buf.push(v); return buf },
    }
    function leak(h) { return h }
    function instr(buf, key, v) { return HANDLER[key](buf, v) }
    export function main() {
      let out = []
      instr(out, 'a', 5)
      leak(HANDLER)
      return out.length
    }
  `
  const extractBody = (wat, fname) => {
    const start = wat.indexOf(`(func $${fname}`)
    const next = wat.indexOf('\n  (func ', start + 1)
    return wat.slice(start, next)
  }
  const closedWat = String(compile(closedSrc, { optimize: false, wat: true }))
  const escapedWat = String(compile(escapedSrc, { optimize: false, wat: true }))
  ok(!/__dyn_get_expr/.test(extractBody(closedWat, 'push2')), "O0: push2's buf param, forwarded through a closed HANDLER table member reached only by computed dispatch, keeps direct array codegen — no shadow probe")
  ok(/__dyn_get_expr/.test(extractBody(escapedWat, 'push2')), 'O0: identical shape, but HANDLER also escapes via leak(HANDLER) — push2 stays runtime-dispatched, confirms the fix never guesses through an unsafe receiver')
  for (const optimize of [false, 2, 3]) {
    is(jz(closedSrc, { optimize }).exports.main(), 2, `O${optimize || 0}: closed-table computed dispatch still computes the correct value (push2 pushes 5 then 6)`)
  }
})

test('closed computed-dispatch table: declaration order relative to its caller does not affect the compiled output', () => {
  // Same discipline as the possibleKinds ordering-independence pin above
  // (test "possibleKinds census is pass-order-independent"): the strongest
  // direct proof the fix isn't an accidental worklist-order artifact is that
  // source declaration order (table before vs after the function that
  // dispatches through it) doesn't change the compiled bytes at all.
  const push2Src = `const push2 = (buf, v) => { buf.push(v); buf.push(v + 1); return buf }\n`
  const handlerSrc = `
    const HANDLER = {
      a: (buf, v) => push2(buf, v),
      b: (buf, v) => { buf.push(v); return buf },
    }
  `
  const instrSrc = `
    function instr(buf, key, v) { return HANDLER[key](buf, v) }
    export function main() {
      let out = []
      instr(out, 'a', 5)
      return out.length
    }
  `
  const watTableFirst = String(compile(push2Src + handlerSrc + instrSrc, { optimize: 3, wat: true }))
  const watTableLast = String(compile(push2Src + instrSrc + handlerSrc, { optimize: 3, wat: true }))
  is(watTableFirst, watTableLast, 'O3: declaring the dispatch table before vs after its caller compiles to byte-identical WAT')
})

test('closed computed-dispatch table: an unresolvable SIBLING argument no longer poisons the whole synthesized call', () => {
  // watr's real residual (.work/archive/string-method-guess-notes.md "Fifth
  // session"): `grab`'s inner call is `grab(lookup(idx, list), buf)` — arg0
  // nests a reference to `a`'s OWN body-local `idx` (from `list.shift()`,
  // never statically resolvable — genuinely unknown, not absent), arg1 is
  // `a`'s OWN param `buf`, forwarded cleanly from `instr`'s own array. The
  // OLD all-or-nothing gate declined the WHOLE call over arg0 alone, losing
  // arg1's perfectly good observation too. The fix keeps synthesizing
  // regardless — each argument POSITION is independent in narrow.js's own
  // fold (applySiteRules folds one call-site argument per parameter index,
  // never coupled to a sibling) — so `grab`'s `buf` param (2nd position)
  // still proves ARRAY even though `x` (1st position) stays correctly
  // unresolvable.
  const src = `
    const lookup = (k, m) => m[k]
    const grab = (x, buf) => { buf.push(x); return buf }
    const HANDLER = {
      a: (buf, list) => { const idx = list.shift(); return grab(lookup(idx, list), buf) },
      b: (buf, list) => { buf.push(list.shift()); return buf },
    }
    function instr(buf, key, list) { return HANDLER[key](buf, list) }
    export function main() {
      let out = []
      instr(out, 'a', [7])
      return out.length
    }
  `
  const extractBody = (wat, fname) => {
    const start = wat.indexOf(`(func $${fname}`)
    const next = wat.indexOf('\n  (func ', start + 1)
    return wat.slice(start, next)
  }
  const wat = String(compile(src, { optimize: false, wat: true }))
  ok(!/__dyn_get_expr/.test(extractBody(wat, 'grab')), "O0: grab's buf param (2nd position) proves ARRAY and keeps direct codegen even though its sibling argument (lookup(idx, list)) only resolves through a genuinely-unknown body-local — one unresolvable position no longer poisons the whole synthesized call")
  for (const optimize of [false, 2, 3])
    is(jz(src, { optimize }).exports.main(), 1, `O${optimize || 0}: list.shift() empties the array (idx=7, list=[]), lookup(7,[]) is undefined, grab pushes it once — computes the JS-correct length regardless of which positions the census could prove`)
})

test('closed computed-dispatch table: a member reached by a SHORT outer call declines its own unsuppliable trailing param instead of forwarding it as a false "merely unknown" fact', () => {
  // The regression this fix corrects (.work/archive/string-method-guess-notes.md
  // "Fifth session"): watr's real `for (const k in HANDLER) SIZE_HANDLER[k]
  // = (n,c,op) => HANDLER[k](n,c,op).length` idiom calls every HANDLER
  // member with 3 args, one short of the table's own 4-param convention —
  // mirrored here by `short(key, buf, v)` calling `HANDLER[key](buf, v)`
  // (2 args) against members declared `(buf, v, out)` (3 params). The
  // member's own `out` is genuinely, provably ABSENT at that call — not
  // merely unknown — so forwarding `relay`'s internal call `relay(buf, v)`
  // (2 args, missing its own `out`) would hand narrow.js's `missing()` rule
  // a call site with NO default for the missing position, which poisons
  // UNCONDITIONALLY (soft or hard, no self-heal possible — unlike an
  // ordinary unresolved VALUE) — permanently swamping the CLEAN observation
  // `a`'s own fully-supplied call already proved for that exact same
  // parameter. The fix declines synthesizing the whole under-arity call
  // instead: `relay.out` stays cleanly ARRAY from `a`'s site alone, and
  // `write`'s own `buf` param (fed ONLY by relay's internal, `if(out)`-
  // guarded call to `write`) inherits that clean proof.
  const src = `
    const write = (buf, x) => { buf.push(x); return buf }
    const relay = (buf, v, out) => { buf.push(v); if (out) write(out, v); return buf }
    const HANDLER = {
      a: (buf, v, out) => relay(buf, v, out),
      b: (buf, v) => relay(buf, v),
    }
    function instr(buf, key, v, out) { return HANDLER[key](buf, v, out) }
    function short(key, buf, v) { return HANDLER[key](buf, v) }
    export function main() {
      let out = []
      let scratch = []
      instr(out, 'a', 5, scratch)
      short('b', out, 9)
      return scratch.length + out.length
    }
  `
  const extractBody = (wat, fname) => {
    const start = wat.indexOf(`(func $${fname}`)
    const next = wat.indexOf('\n  (func ', start + 1)
    return wat.slice(start, next)
  }
  const wat = String(compile(src, { optimize: false, wat: true }))
  ok(!/__dyn_get_expr/.test(extractBody(wat, 'write')), "O0: write's buf param, fed only by relay's own if(out)-guarded internal call, proves ARRAY and keeps direct codegen — relay.out stays clean because the SHORT 2-arg call from `short`/`b` (relay's own out unsuppliable there) is declined outright instead of poisoning relay.out with a false 'missing, no default' fact")
  for (const optimize of [false, 2, 3])
    is(jz(src, { optimize }).exports.main(), 3, `O${optimize || 0}: instr(a) pushes 5 into out and 5 into scratch (out.length=1, scratch.length=1); short(b) pushes 9 into out with no 3rd arg, out param undefined so write never runs (out.length=2) — total scratch(1)+out(2)=3, JS-correct regardless of which positions the census could prove`)
})

// --- inferValAtSite: `.`-property-read call arguments (narrow.js) ---
//
// Prior sessions closed the CLOSED-COMPUTED-DISPATCH-TABLE class (the pins
// above) but left `id`/`blockid`/`reftype`'s watr-shaped residual diagnosed,
// not fixed: `inferValAtSite` had no case AT ALL for a `.`-member-read
// argument (`c.type`, `rows[i].x`) — only bare names and `[]`-element reads
// (.work/archive/string-method-guess-notes.md, sixth session, "Why the originally-
// diagnosed 24-case partial rescue... never paid off"). This resolves the
// receiver to a proven schemaId (inferSchemaId — the SAME resolver the
// `schemaId` mergeRule already runs per call-site argument) and reads that
// field's program-wide-monomorphic kind off ctx.schema's existing SlotFact
// census (module/schema.js's new slotVTBySid, the by-sid sibling of the
// slotVT kind.js's own VT['.'] already trusts for a live receiver).

test('RepresentationPlan: a param fed only a `.`-property read of a proven-schema ARRAY field gets direct array codegen (positive)', () => {
  // CTX is a genuine `{}`-literal schema (unlike watr's own real ctx, which
  // is `const ctx = []` with STRING keys attached via a `for...in`-driven
  // computed write — never schema-registered at all; see this session's own
  // notes for why the fix's schema-backed mechanism can prove THIS shape but
  // not watr's). grab's `list` param is fed ONLY `c.items` (dispatch's own
  // param `c`, forwarded — never a bare name at the call site into grab), so
  // this exercises the NEW `.`-property-read case specifically, not the
  // pre-existing bare-name/`[]`-element cases.
  // useUnproven keeps the shadow-probe/`__dyn_get_expr` machinery live in
  // this exact compiled unit (a genuinely unprovable dynamic-key read) — so
  // grab's clean codegen below isn't vacuously "nothing needs the probe."
  const src = `
    const CTX = { items: [10, 20, 30], tag: 1 }
    function grab(nm, list) { return list[nm] }
    function dispatch(nm, c) { return grab(nm, c.items) }
    export function useProp() { return dispatch(1, CTX) }
    export function useUnproven(o, k) { return o[k] }
  `
  const extractBody = (wat, fname) => {
    const start = wat.indexOf(`(func $${fname}`)
    const next = wat.indexOf('\n  (func ', start + 1)
    return wat.slice(start, next)
  }
  const wat = String(compile(src, { optimize: false, wat: true }))
  ok(!/__dyn_get_expr/.test(extractBody(wat, 'grab')), "O0: grab's list param, fed only dispatch's own `c.items` property read, proves ARRAY through the receiver's schemaId + SlotFact kind census and keeps direct array codegen — no shadow probe")
  ok(/__dyn_get_expr/.test(extractBody(wat, 'useUnproven')), 'O0: useUnproven (a genuinely unprovable dynamic-key read) DOES get the shadow probe — confirms the probe machinery is live in this exact compiled unit, so the grab result above is not vacuous')
  for (const optimize of [false, 2, 3])
    is(jz(src, { optimize }).exports.useProp(), 20, `O${optimize || 0}: dispatch(1, CTX) -> grab(1, CTX.items) -> CTX.items[1] === 20, JS-correct`)
})

test('RepresentationPlan: a `.`-property read chained off a proven array-element read also proves the field (positive, array-element-chained receiver)', () => {
  // The second proof source the `.`-property-read case supports: the
  // receiver itself is `rows[i]` (a proven-array-element read, not a bare
  // name) — `grab`'s list param is fed `rows[i].items`, two hops from a
  // literal. Exercises receiverSchemaId's arrayElemSchema fallback, not just
  // its primary inferSchemaId(bare-name) path.
  const src = `
    function grab(nm, list) { return list[nm] }
    function visit(i, rows) { return grab(0, rows[i].items) }
    export function useArrElem() {
      const rows = [{ items: [10, 20, 30], tag: 1 }, { items: [40, 50], tag: 2 }]
      return visit(1, rows)
    }
  `
  const extractBody = (wat, fname) => {
    const start = wat.indexOf(`(func $${fname}`)
    const next = wat.indexOf('\n  (func ', start + 1)
    return wat.slice(start, next)
  }
  const wat = String(compile(src, { optimize: false, wat: true }))
  ok(!/__dyn_get_expr/.test(extractBody(wat, 'grab')), "O0: grab's list param, fed rows[i].items (an array-element read chained with a property), proves ARRAY and keeps direct array codegen")
  for (const optimize of [false, 2, 3])
    is(jz(src, { optimize }).exports.useArrElem(), 40, `O${optimize || 0}: rows[1].items[0] === 40, JS-correct`)
})

test('RepresentationPlan: a `.`-property read of a genuinely mixed-kind field stays runtime-dispatched (negative control)', () => {
  // Negative control for the positive pin above: A and B share the identical
  // schema (`{items, tag}` dedupes to one schemaId), but their `items` field
  // disagrees in KIND (ARRAY vs STRING) — a real, whole-program disagreement,
  // not merely unproven. `pick`'s branch is a runtime PARAMETER (not a
  // compile-time constant), so B's construction can't be constant-folded
  // away before the census runs — both constructions stay genuinely live,
  // so the SlotFact census must see the real disagreement (an earlier,
  // constant-foldable version of this repro was checked and rejected during
  // this session: with a compile-time-constant branch, B's whole `{}`-
  // literal got folded away before the census ever ran, silently leaving
  // only A's ARRAY observation live — a vacuous, not a real, negative
  // control; this shape avoids that pitfall). dispatch's `c` param still
  // correctly proves schemaId (A/B share one schema) — only the FIELD's own
  // kind is unprovable, confirming the fix declines at the right precision:
  // "receiver's schema is known" is not "this field's kind is known."
  const src = `
    const A = { items: [10, 20, 30], tag: 1 }
    const B = { items: 'oops', tag: 2 }
    function grab(nm, list) { return list[nm] }
    function dispatch(nm, c) { return grab(nm, c.items) }
    export function useA() { return dispatch(1, A) }
    export function pick(flag) { return (flag ? B : A).items }
  `
  const extractBody = (wat, fname) => {
    const start = wat.indexOf(`(func $${fname}`)
    const next = wat.indexOf('\n  (func ', start + 1)
    return wat.slice(start, next)
  }
  const wat = String(compile(src, { optimize: false, wat: true }))
  ok(/__dyn_get_expr/.test(extractBody(wat, 'grab')), "O0: grab's list param stays runtime-dispatched — A and B share one schema but genuinely disagree on items' kind, so the SlotFact census is (correctly) poisoned and the fix must decline, not guess")
  is(jz(src, { optimize: false }).exports.useA(), 20, 'O0: the declined param still computes the JS-correct answer through the (slower) runtime-dispatch path')
})

test("RepresentationPlan: `.`-property-read schemaId resolution is pass-order-independent — swapping a 3-function forwarding chain's declaration order yields byte-identical WAT", () => {
  // Mirrors the existing possibleKinds-census ordering pin's discipline
  // (above) for this fix's own two dependencies (schemaId, ctx.schema's
  // SlotFact kind census): a 3-hop chain (grab <- relay <- outer, outer's
  // OWN param c2 must itself settle to CTX's schemaId before relay's `c`
  // can resolve it) checked across every declaration-order permutation.
  const grabSrc = 'function grab(nm, list) { return list[nm] }\n'
  const relaySrc = 'function relay(nm, c) { return grab(nm, c.items) }\n'
  const outerSrc = 'function outer(nm, c2) { return relay(nm, c2) }\n'
  const tailSrc = 'const CTX = { items: [10, 20, 30], tag: 1 }\nexport function useIt() { return outer(1, CTX) }\n'
  const perms = [
    [grabSrc, relaySrc, outerSrc],
    [outerSrc, relaySrc, grabSrc],
    [relaySrc, outerSrc, grabSrc],
    [grabSrc, outerSrc, relaySrc],
  ]
  const outs = perms.map(p => String(compile(p.join('') + tailSrc, { optimize: 3, wat: true })))
  ok(outs.every(o => o === outs[0]), 'O3: every declaration-order permutation of the 3-hop forwarding chain compiles to byte-identical WAT')
})
test('bigint: typeof-guarded normalizer reached through a `.`-member call attached to a NAMED FUNCTION, not an object literal (shape #7-residual — FIXED)', () => {
  // Shape #8 (above) resolves a `.`-member call through an OBJECT-LITERAL
  // receiver (`const ns = {}; ns.parse = parseNum`). watr's REAL shape
  // attaches the property directly onto a NAMED FUNCTION DECLARATION
  // instead — `function i64(n, buffer) {…}; i64.parse = n => {…}`, encode.js
  // — which prepare lifts into a top-level `i64$parse` function and
  // rewrites the write to `i64.parse = i64$parse` (src/prepare/index.js's
  // `'='` handler, "Function property assignment"), a shape
  // collectMemberWrites/foldWrite (call-target-index.js) can fold exactly
  // like Shape #8's object-literal write once it survives — but
  // `programFacts.nameEscapes` has no exemption for a call's OWN callee
  // position (program-facts.js's `ESCAPE_SKIP` has no `'()'` entry: "sound
  // direction: over-marking loses a fold"), so `i64` being called directly
  // ANYWHERE in the program (watr's own `encode.i64(...)`, flattened to a
  // bare call) marked the receiver "escaped" and blocked the resolution
  // regardless of whether the write itself was visible. Fixed by gating a
  // function-declaration receiver on a narrower, purpose-built escape scan
  // (`collectValueEscapes`) instead of `nameEscapes` for this one receiver
  // shape — Shape #8's own object-literal gate is untouched. `g` below
  // reproduces the actual blocking ingredient: the base function called
  // directly, elsewhere, unrelated to the `.`-member call being resolved.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const src = `
      function parseNum(n) {
        if (typeof n === 'string') n = BigInt(n)
        n >>= 7n
        return n
      }
      export let control = () => {
        let nodes = []
        nodes.push("900")
        return parseNum(nodes.shift())
      }
    `
    const control = jz(src, { optimize }).exports
    is(control.control(), 7n, `${lbl}: bare-name control (same callee body) is already correct`)
    const e = jz(`
      function i64(n) { return n }
      i64.parse = n => {
        if (typeof n === 'string') n = BigInt(n)
        n >>= 7n
        return n
      }
      export let f = () => {
        let nodes = []
        nodes.push("900")
        return i64.parse(nodes.shift())
      }
      export let g = () => i64(5n)
    `, { optimize }).exports
    is(e.f(), 7n, `${lbl}: identical callee reached via a NAMED-FUNCTION .member call now crosses as a real BigInt`)
    is(e.g(), 5n, `${lbl}: the base function itself, called directly elsewhere, is unaffected`)
  }
})

// --- DictKindIndex (src/compile/dict-kind-index.js): per-key kind facts for a
// `let/const T = []` receiver used as a static string-keyed dictionary via a
// `for (k in OBJ) T[k] = VALUE` unroll over a constant object literal — the
// FOURTH limitation .work/archive/string-method-guess-notes.md's seventh session
// diagnosed (`T` is never schema-registered: that mechanism only fires on a
// `{}`-literal AST node, never `[]`). Watr's real shape:
//   for (let kind in SECTION) ctx[SECTION[kind]] = ctx[kind] = []
// with `ctx.type`/`ctx.table`/… read elsewhere, often through a same-module
// named-function or computed-dispatch-table forwarding chain.
const extractFnBody = (wat, fname) => {
  const start = wat.indexOf(`(func $${fname}`)
  if (start < 0) return null
  const next = wat.indexOf('\n  (func ', start + 1)
  return next >= 0 ? wat.slice(start, next) : wat.slice(start)
}

test('DictKindIndex: a for-in-unrolled array-as-dictionary proves a direct `.`-property-read argument (positive)', () => {
  const src = `
    const SECTION = { type: 1, func: 2, table: 3 }
    function id(nm, list) { return list[nm] }
    function assemble() {
      const ctx = []
      for (let kind in SECTION) ctx[SECTION[kind]] = ctx[kind] = []
      ctx.type.push(42)
      return id(0, ctx.type)
    }
    function useUnproven(o, k) { return o[k] }
    export function main() { return assemble() }
    export function otherUse(o, k) { return useUnproven(o, k) }
  `
  const wat = String(compile(src, { optimize: false, wat: true }))
  ok(!/__dyn_get_expr/.test(extractFnBody(wat, 'id')), "O0: id's list param, fed only assemble's own ctx.type read, proves ARRAY through the for-in-unroll census and keeps direct array codegen — no shadow probe")
  ok(/__dyn_get_expr/.test(extractFnBody(wat, 'useUnproven')), 'O0: useUnproven (a genuinely unprovable dynamic-key read) DOES get the shadow probe — confirms the probe machinery is live in this exact compiled unit, so the id result above is not vacuous')
  for (const optimize of [false, 2, 3])
    is(jz(src, { optimize }).exports.main(), 42, `O${optimize || 0}: assemble() -> ctx.type.push(42); id(0, ctx.type) === 42, JS-correct`)
})

test('DictKindIndex: the for-in-unroll census survives a same-module named-function AND a computed-dispatch-table forwarding chain (positive, watr\'s real shape)', () => {
  // Mirrors watr's real `instr(nodes, ctx) { ... HANDLER[imm](nodes, ctx, op, out) }`
  // exactly: ctx is forwarded once through an ORDINARY named-function call
  // (instr), then once more through a computed-dispatch table's own inline
  // arrow member (HANDLER[op]) — both closed-forwarding channels this file's
  // alias-closure walk follows, chained.
  const src = `
    const SECTION = { type: 1, func: 2 }
    function id(nm, list) { return list[nm] }
    const HANDLER = {
      funcidx: (n, c, op, out) => id(n.shift(), c.func),
      typeidx: (n, c, op, out) => id(n.shift(), c.type),
    }
    function instr(nodes, ctx) {
      let op = nodes.shift()
      return HANDLER[op](nodes, ctx, op, null)
    }
    function useUnproven(o, k) { return o[k] }
    export function main() {
      const ctx = []
      for (let kind in SECTION) ctx[SECTION[kind]] = ctx[kind] = []
      ctx.func.push(11)
      ctx.func.push(22)
      return instr(['funcidx', 1], ctx)
    }
    export function otherUse(o, k) { return useUnproven(o, k) }
  `
  const wat = String(compile(src, { optimize: false, wat: true }))
  ok(!/__dyn_get_expr/.test(extractFnBody(wat, 'id')), "O0: id's list param, reached through instr's named-function forward THEN HANDLER's computed-dispatch forward, still proves ARRAY — no shadow probe")
  ok(/__dyn_get_expr/.test(extractFnBody(wat, 'useUnproven')), 'O0: sanity — the shadow-probe machinery is live in this exact compiled unit')
  for (const optimize of [false, 2, 3])
    is(jz(src, { optimize }).exports.main(), 22, `O${optimize || 0}: instr(['funcidx',1], ctx) -> id(1, ctx.func) === 22, JS-correct`)
})

test('DictKindIndex: a POSITIONAL array-of-arrows dispatch table forwards the same way as an object-literal table (positive, watr\'s real build[] shape)', () => {
  // resolveComputed (call-target-index.js) resolves ONLY object-literal
  // tables (its own header: property writes are `{}`-literal only) — watr's
  // real `build[SECTION.code](item, ctx)` is a numerically-indexed ARRAY of
  // arrows instead (needed for a real WASM call_indirect), which this file's
  // own sibling resolver (constArrayMembers) covers. Two members, deliberately
  // different arity, to also exercise arrowParamNameAt's "extra argument
  // beyond a member's own declared arity is provably unreachable, not
  // ambiguous" rule (the first member never even declares a 2nd parameter).
  const src = `
    function id(nm, list) { return list[nm] }
    const TABLE = [
      (onlyOneParam) => onlyOneParam.length,
      (item, ctx) => id(0, ctx.type),
    ]
    function dispatch(idx, item, ctx) { return TABLE[idx](item, ctx) }
    function useUnproven(o, k) { return o[k] }
    export function main() {
      const ctx = []
      const SECTION = { type: 1, func: 2 }
      for (let kind in SECTION) ctx[SECTION[kind]] = ctx[kind] = []
      ctx.type.push(77)
      return dispatch(1, [1, 2, 3], ctx)
    }
    export function otherUse(o, k) { return useUnproven(o, k) }
  `
  const wat = String(compile(src, { optimize: false, wat: true }))
  ok(!/__dyn_get_expr/.test(extractFnBody(wat, 'id')), "O0: id's list param, reached through TABLE's array-of-arrows forward (position 1, past a shorter-arity sibling member), still proves ARRAY")
  ok(/__dyn_get_expr/.test(extractFnBody(wat, 'useUnproven')), 'O0: sanity — the shadow-probe machinery is live in this exact compiled unit')
  for (const optimize of [false, 2, 3])
    is(jz(src, { optimize }).exports.main(), 77, `O${optimize || 0}: dispatch(1,[1,2,3],ctx) -> id(0, ctx.type) === 77, JS-correct`)
})

test('DictKindIndex: `??=`/`||=`/`&&=` fold their RHS the same as a plain `=` write (positive, watr\'s real metadata idiom)', () => {
  // watr's real `(ctx.metadata ??= {})[type] ??= []` — a logical-assignment
  // write must not be treated as an opaque compound mutation (which would
  // poison the WHOLE target): its short-circuit branch never introduces a
  // kind beyond what other writes to the same key already establish, so
  // folding its RHS is exactly as sound as `=`.
  const src = `
    const SECTION = { type: 1, func: 2 }
    function id(nm, list) { return list[nm] }
    function useUnproven(o, k) { return o[k] }
    export function main() {
      const ctx = []
      for (let kind in SECTION) ctx[SECTION[kind]] = ctx[kind] = []
      ctx.meta ??= {}
      ctx.meta ??= {}
      ctx.type.push(9)
      return id(0, ctx.type)
    }
    export function otherUse(o, k) { return useUnproven(o, k) }
  `
  const wat = String(compile(src, { optimize: false, wat: true }))
  ok(!/__dyn_get_expr/.test(extractFnBody(wat, 'id')), "O0: id's list param proves ARRAY even though its target's `meta` key is only ever ??='d, never poisoning the OTHER, unrelated `type` key")
  for (const optimize of [false, 2, 3])
    is(jz(src, { optimize }).exports.main(), 9, `O${optimize || 0}: JS-correct through the ??= write`)
})

test('DictKindIndex negative: a target that escapes through an unrelated function keeps runtime dispatch', () => {
  const src = `
    const SECTION = { type: 1, func: 2 }
    function id(nm, list) { return list[nm] }
    function leak(x) { return x }
    function assemble() {
      const ctx = []
      for (let kind in SECTION) ctx[SECTION[kind]] = ctx[kind] = []
      const alias = leak(ctx)
      alias.type = [5]
      return id(0, ctx.type)
    }
    function useUnproven(o, k) { return o[k] }
    export function main() { return assemble() }
    export function otherUse(o, k) { return useUnproven(o, k) }
  `
  const wat = String(compile(src, { optimize: false, wat: true }))
  ok(/__dyn_get_expr/.test(extractFnBody(wat, 'id')), "O0: ctx escapes through leak()'s own return, an unaccounted alias could write ANY key — must decline, not guess")
  is(jz(src, { optimize: false }).exports.main(), 5, 'O0: still JS-correct through the declined, slower runtime-dispatch path')
})

test('DictKindIndex negative: a same-key kind disagreement declines only that key, a sibling key from the same target stays clean', () => {
  const src = `
    const SECTION = { type: 1, func: 2 }
    function idA(nm, list) { return list[nm] }
    function idB(nm, list) { return list[nm] }
    function assemble(flag) {
      const ctx = []
      for (let kind in SECTION) ctx[SECTION[kind]] = ctx[kind] = []
      if (flag) ctx.type = 42
      const a = idA(0, ctx.type)
      const b = idB(0, ctx.func)
      return a + b
    }
    function useUnproven(o, k) { return o[k] }
    export function main(flag) { return assemble(flag) }
    export function otherUse(o, k) { return useUnproven(o, k) }
  `
  const wat = String(compile(src, { optimize: false, wat: true }))
  ok(/__dyn_get_expr/.test(extractFnBody(wat, 'idA')), "O0: idA reads ctx.type, the KEY a conditional write disagrees with — must decline (precise, per-key poison, never guess)")
  ok(!/__dyn_get_expr/.test(extractFnBody(wat, 'idB')), 'O0: idB reads ctx.func, a SIBLING key of the SAME target that never disagreed — must stay clean, proving the poison is per-key, not whole-target')
})

test('DictKindIndex negative: a non-constant (reassignable) source object declines the whole target', () => {
  const src = `
    let SECTION = { type: 1, func: 2 }
    function id(nm, list) { return list[nm] }
    function corrupt() { SECTION = { other: 9 } }
    function assemble() {
      const ctx = []
      for (let kind in SECTION) ctx[SECTION[kind]] = ctx[kind] = []
      return id(0, ctx.type)
    }
    function useUnproven(o, k) { return o[k] }
    export function main() { corrupt(); return assemble() }
    export function otherUse(o, k) { return useUnproven(o, k) }
  `
  const wat = String(compile(src, { optimize: false, wat: true }))
  ok(/__dyn_get_expr/.test(extractFnBody(wat, 'id')), 'O0: SECTION is reassigned elsewhere (corrupt()) — a stale key-name snapshot could misreport PRESENCE, not just kind — must decline')
})

test('DictKindIndex: pass-order-independent — swapping the target/reader declaration order yields byte-identical codegen for the reader', () => {
  const idSrc = `function id(nm, list) { return list[nm] }\n`
  const assembleSrc = `
    function assemble() {
      const ctx = []
      for (let kind in SECTION) ctx[SECTION[kind]] = ctx[kind] = []
      return id(0, ctx.type)
    }
  `
  const constSrc = `const SECTION = { type: 1, func: 2 }\n`
  const tailSrc = `export function main() { return assemble() }\n`
  const perms = [
    idSrc + constSrc + assembleSrc + tailSrc,
    constSrc + assembleSrc + idSrc + tailSrc,
    assembleSrc + idSrc + constSrc + tailSrc,
    constSrc + idSrc + assembleSrc + tailSrc,
  ]
  const bodies = perms.map(src => extractFnBody(String(compile(src, { optimize: 3, wat: true })), 'id'))
  ok(bodies.every(b => b === bodies[0]), "O3: id()'s own compiled body is byte-identical across every declaration-order permutation of SECTION/ctx/id/assemble")
  ok(!/__dyn_get_expr/.test(bodies[0]), 'O3: and the census genuinely resolved (no shadow probe), not vacuously identical because every permutation declined equally')
})

// The four pins below are ported from the shelved fix/shape8-member-callee
// branch (.work/archive/phase-c-unification.md's "Shape #8 branch" section, retired)
// as its own Tier-1/Tier-2 `.`-member resolver was never merged -- superseded
// by call-target-index.js above, which fixes Shape #8 through a differently-
// shaped proof. Each was re-run against MAIN's own fix (not the branch's) at
// every optimize level and labeled by what actually happens now, not by the
// branch's original labels.

test('bigint: object-literal property referencing an existing function, both shorthand and explicit key (shape #8 sibling — already covered, FIXED)', () => {
  // Covered regardless of which shape-8 mechanism is present: the branch's
  // own investigation (AST dump) found prepare's static-object-schema
  // constant folding (ctx.schema.register/staticObjectProps, src/prepare/
  // index.js + src/static.js) already resolves a property that is a bare
  // reference to an EXISTING same-module function straight to a bare-name
  // call before any `.`-member machinery -- branch's or main's -- ever runs.
  // Re-confirmed here at the value level on main: correct at every optimize
  // level, for both the `{ parseNum }` shorthand and the explicit
  // `{ parse: parseNum }` key. The inline-closure and nested-base siblings
  // below now take their own separately proven paths, so this remains the
  // direct static-object control.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const body = `
      function parseNum(n) {
        if (typeof n === 'string') n = BigInt(n)
        n >>= 7n
        return n
      }
    `
    const shorthand = jz(`
      ${body}
      const ns = { parseNum }
      export let f = () => {
        let nodes = []
        nodes.push("900")
        return ns.parseNum(nodes.shift())
      }
    `, { optimize }).exports
    is(shorthand.f(), 7n, `${lbl}: shorthand property { parseNum } crosses as a real BigInt`)
    const explicit = jz(`
      ${body}
      const ns = { parse: parseNum }
      export let f = () => {
        let nodes = []
        nodes.push("900")
        return ns.parse(nodes.shift())
      }
    `, { optimize }).exports
    is(explicit.f(), 7n, `${lbl}: explicit key { parse: parseNum } crosses as a real BigInt`)
  }
})

test('bigint: object-literal inline closure reached via STATIC `.`-access, not computed dispatch (shape #8 sibling — FIXED)', () => {
  // This control starts with an already boxed BigInt from storage and proves
  // that ordinary static inline-closure dispatch keeps the tagged value. The
  // following test separately covers a closure that creates BigInt provenance
  // through its own reassignment.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const e = jz(`
      function leb(n) { n >>= 7n; return n }
      const HANDLER = { i64: (nodes) => leb(nodes.shift()) }
      export let f = () => {
        let nodes = []
        nodes.push(900n)
        return HANDLER.i64(nodes)
      }
    `, { optimize }).exports
    is(e.f(), 7n, `${lbl}: static-access dispatch-table entry crosses as a real BigInt`)
  }
})

test('bigint: inline closure property materializes its reassigned parameter and result', () => {
  // Generic closure provenance is derived from the closure's complete def set.
  // A parameter that becomes BigInt inside the body is projected back onto the
  // closure boundary, and the value ABI candidate is accepted only when every
  // body write can be normalized to the boxed target.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const e = jz(`
      const ns = {}
      ns.parse = (n) => {
        if (typeof n === 'string') n = BigInt(n)
        n >>= 7n
        return n
      }
      export let f = () => {
        let nodes = []
        nodes.push("900")
        return ns.parse(nodes.shift())
      }
    `, { optimize }).exports
    is(e.f(), 7n, `${lbl}: inline closure property returns a real BigInt`)
  }
})

test('bigint: nested member `a.b.c(...)` resolves through a closed intermediate object', () => {
  // CallTargetIndex recursively records nested object-literal paths, but only
  // while the root and intermediate object remain unshadowed, unreassigned,
  // nonescaping, and free of computed writes. The same frozen target feeds
  // kind, provenance, and emission; tagged results are never boxed twice.
  for (const optimize of [false, 2, 3]) {
    const lbl = `O${optimize || 0}`
    const e = jz(`
      function parseNum(n) {
        if (typeof n === 'string') n = BigInt(n)
        n >>= 7n
        return n
      }
      const ns = { inner: {} }
      ns.inner.parse = parseNum
      export let f = () => {
        let nodes = []
        nodes.push("900")
        return ns.inner.parse(nodes.shift())
      }
    `, { optimize }).exports
    is(e.f(), 7n, `${lbl}: nested member target returns a real BigInt`)
  }
})

test('nested CallTargetIndex declines conflicting and computed writes', () => {
  for (const optimize of [false, 2, 3]) {
    const conflict = jz(`
      function a() { return 1 }
      function b() { return 2 }
      const ns = { inner: {} }
      ns.inner.f = a
      ns.inner.f = b
      export let f = () => ns.inner.f()
    `, { optimize }).exports
    is(conflict.f(), 2, `O${optimize || 0}: conflicting nested writes stay dynamic`)

    const computed = jz(`
      function a() { return 1 }
      function b() { return 2 }
      const ns = { inner: {} }
      ns.inner.f = a
      const key = 'f'
      ns.inner[key] = b
      export let f = () => ns.inner.f()
    `, { optimize }).exports
    is(computed.f(), 2, `O${optimize || 0}: computed nested write poisons the static target`)
  }
})

