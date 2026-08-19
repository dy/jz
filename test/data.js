// Comprehensive data type tests: arrays, objects, strings
// Adapted from old arch tests + new NaN-boxing architecture
import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onWasi, onKernel, adaptI64 } from './_matrix.js'

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

test('audit-#11 P0-1: bigint-using-program carrier divergence — DOCUMENTED, still open by design (not a regression)', () => {
  // The runtime half of the fix (module/number.js `__to_num`'s subnormal-as-
  // BigInt-carrier arm) is gated on `ctx.features.bigint` — OFF (closed) for a
  // program that never constructs a BigInt anywhere (every case above), ON
  // (unchanged from before this fix) for one that does. This is the documented,
  // PERMANENT remainder the carrier design accepts: once a program can
  // construct a BigInt, `__to_num` genuinely cannot distinguish "a real
  // subnormal Number reaching an unproven-kind coercion" from "a real BigInt's
  // raw i64-as-f64 carrier reaching that same coercion" — both are the
  // identical 64 bits, and nothing short of the boxed-bigint carrier redesign
  // (ledgered, deliberately not adopted — see README "One known divergence
  // class") removes the ambiguity. Only fires when the value's STATIC kind is
  // truly unproven (a dict-shaped property / mixed-type array element here —
  // a plain local or parameter gets proven NUMBER by narrower inference and
  // never reaches this arm, which is why the bare-parameter shape stays exact
  // even in a bigint-using program). Native and kernel agree (both wrong the
  // same documented way) — JS: both `+o.a`/`+a[0]` are `5e-324`.
  is(run('let big = 1n; export function f() { let o = {}; o.a = 5e-324; o.b = 1; return +o.a }').f(), 1)
  is(run('let big = 1n; export function f() { const a = []; a.push(5e-324); a.push("s"); return +a[0] }').f(), 1)
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
  const { f } = run(`export let f = () => {
    let s = new Set()
    let s2 = s
    s.add(42)
    return s2.has(42)
  }`)
  is(f(), 1)  // s2 sees the add
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

// ES2025 Set algebra (2026-07-11, Ring 2): union/intersection/difference/
// symmetricDifference return a NEW Set (receiver untouched) in the spec result
// order (test262 result-order.js: union = A then B-not-in-A; intersection
// walks the SMALLER side, ties → this; difference always A's order; symmetric
// = A-not-in-B then B-not-in-A). Predicates return real booleans. A Map other
// participates as its key set; a non-Set/Map other is treated as empty (the
// native-litmus line: no arbitrary set-like .has/.keys dispatch).
test('Set algebra: union/intersection/difference/symmetricDifference', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => [...new Set([1,2]).union(new Set([2,3]))].join(",")`), '1,2,3')
  is(j(`export let f = () => [...new Set([3,1]).union(new Set([2,1]))].join(",")`), '3,1,2')      // insertion order
  is(j(`export let f = () => [...new Set([1,3,5]).intersection(new Set([3,2,1]))].join(",")`), '1,3')   // A ≤ B → A's order
  is(j(`export let f = () => [...new Set([3,2,1,0]).intersection(new Set([1,3,5]))].join(",")`), '1,3') // B smaller → B's order
  is(j(`export let f = () => [...new Set([1,2,3]).difference(new Set([2]))].join(",")`), '1,3')
  is(j(`export let f = () => [...new Set([1,2,3]).symmetricDifference(new Set([2,4]))].join(",")`), '1,3,4')
  is(j(`export let f = () => { let m = new Map(); m.set(9, 1); return [...new Set([1]).union(m)].join(",") }`), '1,9')  // Map = key set
  is(j(`export let f = () => { let a = new Set([1]); a.union(new Set([2])); return a.size }`), 1)  // receiver intact
  is(j(`export let f = () => new Set().union(new Set()).size`), 0)
})
test('Set algebra predicates: isSubsetOf/isSupersetOf/isDisjointFrom', () => {
  const j = (code) => jz(code).exports.f()
  is(j(`export let f = () => new Set([1,2]).isSubsetOf(new Set([1,2,3]))`), true)
  is(j(`export let f = () => new Set([1,9]).isSubsetOf(new Set([1,2,3]))`), false)
  is(j(`export let f = () => new Set([1,2,3]).isSupersetOf(new Set([2,3]))`), true)
  is(j(`export let f = () => new Set([1,2]).isSupersetOf(new Set([2,9]))`), false)
  is(j(`export let f = () => new Set([1,2]).isDisjointFrom(new Set([3,4]))`), true)
  is(j(`export let f = () => new Set([1,2]).isDisjointFrom(new Set([2,3]))`), false)
  is(j(`export let f = () => new Set().isSubsetOf(new Set())`), true)   // vacuous truth
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
  // PARKED (maybe-miss i32-cell class, .work/todo.md): `let s=0; for(i<7) s+=a[i]`
  // over len-3 — the i32-narrowed accumulator trunc_sats the miss's NaN to 0.
  // The emit-time widen pass that fixes this is parked with its patch — it
  // entangles with the arrayElemRange fixpoint convergence bug (vm row).
})

// --- i32 cell typing requires proven-in-bounds reads (exprType [] gate) ---
// A maybe-miss read is number|undefined; an i32 accumulator cell trunc_sats the
// NaN to 0. Proven shapes (canonical loop pair, literal idx vs static length)
// must KEEP the fast i32 path — only unproven reads widen.
test('int elem reads: proven shapes stay i32-exact', () => {
  // PARKED (maybe-miss i32-cell class, .work/todo.md): the u8oob variant
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

// PARKED (maybe-miss call-arg class, .work/todo.md): `use(u8[oob])` — the i32
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
