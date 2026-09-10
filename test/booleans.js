// Real-boolean carrier: booleans carry as the cheap 0/1 i32 internally, and a
// real boolean is materialized lazily only where boolean-ness is *observed* —
// the host boundary, typeof, String, JSON.stringify. Branches and arithmetic
// pay nothing. See README "Booleans carry as numbers, surface as booleans".
// The second half pins boolean IDENTITY across untyped carriers — the
// self-compile mother bug.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { run, oracle } from './util.js'
import { onKernel, levels } from './_matrix.js'

const fn = (code) => run(code).f
const wat = (code) => jz.compile(code, { wat: true, optimize: { watr: false } })
// A boolean-returning export boxes its 0/1 carrier into a FALSE/TRUE NaN atom —
// `(i32.or (i32.const 4) <bit>)` fed to `$__mkptr` — inside its `$f$exp` boundary
// wrapper, the boolean carrier's only footprint. A number-returning export has no
// boundary wrapper at all. (Quiet-NaN ABI: the atom rides f64, no i64 carrier.)
const boxesResult = (code) => /\(func \$f\$exp[\s\S]*?i32\.or\s+\(i32\.const 4\)/.test(wat(code))

// ============================================
// Surface as a real boolean at the host boundary
// ============================================

test('bool: literal true/false decode at boundary', () => {
  is(fn('export let f = () => true')(), true)
  is(fn('export let f = () => false')(), false)
})

test('bool: relational operators surface as boolean', () => {
  is(fn('export let f = (a, b) => a < b')(1, 2), true)
  is(fn('export let f = (a, b) => a <= b')(2, 2), true)
  is(fn('export let f = (a, b) => a > b')(2, 3), false)
  is(fn('export let f = (a, b) => a >= b')(2, 3), false)
})

test('bool: equality operators surface as boolean', () => {
  is(fn('export let f = (a, b) => a == b')(1, 1), true)
  is(fn('export let f = (a, b) => a != b')(1, 2), true)
  is(fn('export let f = (a, b) => a === b')(1, 1), true)
  is(fn('export let f = (a, b) => a !== b')(1, 2), true)
})

test('bool: logical not surfaces as boolean', () => {
  is(fn('export let f = () => !0')(), true)
  is(fn('export let f = () => !1')(), false)
  is(fn('export let f = (x) => !x')(5), false)
})

test('bool: stored logical guards preserve false beside pointer values', () => {
  for (const value of ['[1]', '{ x: 1 }', 'new Map()']) {
    const body = `const p = x > 0 && ${value}; return !p`
    const expected = Function('x', body)
    for (const optimize of levels(0, 2, 3)) {
      const f = jz(`export let f = x => { ${body} }`, { optimize }).exports.f
      for (const x of [-1, 0, 1]) is(f(x), expected(x), `${value}, ${x}, O${optimize}`)
    }
  }
})

test('bool: Boolean() surfaces as boolean', () => {
  is(fn('export let f = () => Boolean(5)')(), true)
  is(fn('export let f = () => Boolean(0)')(), false)
  is(fn('export let f = () => Boolean()')(), false)
})

// ============================================
// typeof observes a real boolean
// ============================================

test('bool: typeof of a runtime comparison is "boolean"', () => {
  is(fn('export let f = (x) => typeof (x > 0)')(5), 'boolean')
  is(fn('export let f = (a, b) => typeof (a === b)')(1, 1), 'boolean')
})

test('bool: typeof of a literal boolean is "boolean"', () => {
  is(fn('export let f = () => typeof true')(), 'boolean')
  is(fn('export let f = () => typeof false')(), 'boolean')
})

// ============================================
// String / JSON.stringify observe a real boolean
// ============================================

test('bool: String() of a comparison is "true"/"false"', () => {
  is(fn('export let f = (x) => String(x > 0)')(5), 'true')
  is(fn('export let f = (x) => String(x > 0)')(-5), 'false')
})

test('bool: JSON.stringify observes boolean', () => {
  is(fn('export let f = (x, y) => JSON.stringify(x < y)')(1, 2), 'true')
  is(fn('export let f = () => JSON.stringify([true])')(), '[true]')
})

// ============================================
// Cheap carrier — branch & arithmetic positions pay nothing
// ============================================

test('bool: comparison in branch position works without boxing', () => {
  is(fn('export let f = (a, b) => { if (a < b) return 1; return 0 }')(1, 2), 1)
  ok(!boxesResult('export let f = (a, b) => { if (a < b) return 1; return 0 }'),
    'branch-position comparison stays the cheap carrier — no boxed result')
})

test('bool: comparisons sum arithmetically as 0/1', () => {
  is(fn('export let f = (a, b, c, d) => (a < b) + (c < d)')(1, 2, 3, 2), 1)
  is(fn('export let f = (a, b, c, d) => (a < b) + (c < d)')(1, 2, 2, 3), 2)
  ok(!boxesResult('export let f = (a, b, c, d) => (a < b) + (c < d)'),
    'arithmetic over comparisons stays the cheap carrier — no boxed result')
})

test('bool: boolean-returning export is the only boxed-result footprint', () => {
  ok(boxesResult('export let f = (a, b) => a < b'), 'boolean export marks "r":1')
  ok(boxesResult('export let f = (x) => Boolean(x)'), 'Boolean() export marks "r":1')
  ok(!boxesResult('export let f = (a, b) => a + b'), 'number export has no i64 result')
})

test('bool: boolean export boxes the clean carrier without __is_truthy', () => {
  // The inner func's f64 result is a clean 0/1 carrier — never a NaN-atom — so the
  // export thunk extracts the bit with a single f64.ne and boxes `4|bit` directly.
  // The full __is_truthy NaN-discrimination would be dead weight on every boolean
  // export; pin its absence so the wrapper can't silently regrow it.
  ok(!/__is_truthy/.test(wat('export let f = (a, b) => a < b')),
    'relational export skips the __is_truthy truthy-derivation')
  ok(!/__is_truthy/.test(wat('export let f = (a, b) => a === b')),
    'equality export skips the __is_truthy truthy-derivation')
})

// ============================================
// Host → jz: a JS boolean coerces to the 0/1 carrier
// ============================================

test('bool: host boolean coerces to 0/1 in arithmetic', () => {
  is(fn('export let f = (b) => b + 0')(true), 1)
  is(fn('export let f = (b) => b + 0')(false), 0)
  is(fn('export let f = (b) => +b')(true), 1)
  is(fn('export let f = (b) => +b')(false), 0)
})

// ============================================
// Honest limitations — the carrier only appears where statically provable.
// Pinned so the README's stated boundaries can't drift silently.
// ============================================

test('bool: value-preserving &&/|| carry the boolean atom across the boundary (gap CLOSED)', () => {
  // Was a documented gap: `5 && true` crossed as raw 1 (the value-preserving
  // merge collapsed the BOOL arm to its numeric carrier). Closed by the
  // ambiguous-BOOL-merge identity work (.work/archive/todo.md §deletion-sweep):
  // a merge with a statically-BOOL arm and a NUMBER sibling boxes the BOOL
  // arm at identity/boundary escapes, so the atom survives to JS exactly.
  // Pure-NUMBER merges stay raw (byte-identical fast path) — pinned below.
  is(fn('export let f = () => 5 && true')(), true)
  is(fn('export let f = () => 0 || true')(), true)
  is(fn('export let f = () => 5 && 3')(), 3)
  is(fn('export let f = () => true && 5')(), 5)
})

test('bool: identical ambiguous merge duplicated across return branches (quarantine CLOSED)', () => {
  // The carrier-invariant design's quarantined anomaly: { if(s){return M}
  // return M } with M = ((x>0)&&1) duplicated in both branches once returned
  // 0 for BOTH arguments. Diagnosed 2026-08-01: duplication was never causal
  // — both branches independently computed the same wrong value through the
  // VT['()'] grouping blind spot (mechanism B); the parser never shares node
  // references between occurrences and no cross-occurrence cache exists, so
  // a CSE/dedup class is structurally impossible. Pinned at every tier now
  // that the boundary is proven correct.
  const src = 'export let f = (s, x) => { if (s) { return ((x>0)&&1) } return ((x>0)&&1) }'
  for (const optimize of levels(0, 2, 3)) {
    const f = jz(src, { optimize }).exports.f
    is(f(true, 5), 1, `O${optimize} taken branch, truthy merge`)
    is(f(true, -5), false, `O${optimize} taken branch, false atom survives`)
    is(f(false, 5), 1, `O${optimize} fallthrough branch, truthy merge`)
    is(f(false, -5), false, `O${optimize} fallthrough branch, false atom survives`)
  }
})

test('bool: bare boolean read from a container decodes as a real boolean', () => {
  // Was a documented gap (bare return crossed as the raw 1/0 carrier instead of
  // proving BOOL at the boundary) — closed as a side effect of the member-
  // compound-assign BigInt fix (2^62 boundary ledger entry): narrowValResults/
  // narrowBoolResults (src/compile/narrow.js), the function-return-kind
  // pre-pass, now installs the function's own analyzeBody(body).flatObjects
  // before resolving a `.`/`[]` return tail's kind — previously it ran before
  // ctx.func.flatObjects was populated for the function under examination, so
  // a proven-BOOL (or BIGINT — see statements.js) flat array/object element's
  // return tail read as unproven and kept the raw Number carrier.
  is(fn('export let f = () => { let a = [true, false]; return a[0] }')(), true)
  is(fn('export let f = () => { let a = [true, false]; return typeof a[0] }')(), 'boolean')
})

// ============================================
// audit-#12 BOOL_CARRIER closures (this commit) — test262's own reproductions
// of the join/throw-slot carrier gap, pinned at every optimize level.
// ============================================

test('bool: throw/catch preserve boolean identity (audit-#12, was WRONG)', () => {
  // src/compile/emit.js 'throw' emitter used `asF64(emit(expr))` — a raw
  // numeric box, the 18th unnamed site of bridge.js storedValue's "boxed-
  // value slot" gap (see the emitter's own doc comment). `throw true`
  // crossed the throw slot as a plain NUMBER carrier: `catch(e){ e===true }`
  // read false and `typeof e` read 'number'. Fixed by routing the thrown
  // expression through storedValue (the established chokepoint) instead —
  // covers a bare boolean AND an ambiguous join thrown directly.
  const cases = [
    ['export let f = () => { let r; try { throw true } catch (e) { r = typeof e } return r }', 'boolean'],
    ['export let f = () => { let r; try { throw true } catch (e) { r = e === true } return r }', true],
    ['export let f = () => { let r; try { throw false } catch (e) { r = e === false } return r }', true],
    ['export let f = () => { let b = true; let r; try { throw b && false } catch (e) { r = e === false } return r }', true],
    ['export let f = () => { let b = true; let r; try { throw b || false } catch (e) { r = e === true } return r }', true],
  ]
  for (const [src, want] of cases) for (const optimize of levels(0, 1, 2, 3))
    is(jz(src, { optimize }).exports.f(), want, `O${optimize} ${src}`)
})

test('bool: RegExp flag getters preserve boolean identity (audit-#12, was WRONG)', () => {
  // module/regex.js's `.regex:global`/etc. getters emitted a raw `f64.const
  // 0/1` instead of the boxed TRUE/FALSE atom: `regexp.global === true`
  // bit-compared a plain NUMBER against the atom and always read false. The
  // flag is a compile-time-known constant, so this now emits TRUE_IR/
  // FALSE_IR directly (test262 literals/regexp/S7.8.5_A3.1_T1..T6).
  const src = `export let f = () => {
    let re = /(?:)/g
    return (re.global === true ? 1 : 0) * 100 + (re.ignoreCase === false ? 1 : 0) * 10 + (re.multiline === false ? 1 : 0)
  }`
  for (const optimize of levels(0, 1, 2, 3)) is(jz(src, { optimize }).exports.f(), 111, `O${optimize}`)
})

test('bool: strict-eq boxes a short-circuited BOOL arm even when the sibling arm is unresolved (audit-#12, was WRONG)', () => {
  // emitStrictEq's "one side proven BOOL, other side dynamic-unknown" branch
  // assumed an unresolved (null) static kind can never carry a raw BOOL bit.
  // False for `true || undefined`/`true || null`: VT['||'] can't unify BOOL
  // with NULL/UNDEF (kind stays null), but the arm actually taken at runtime
  // (`true`) is still raw BOOL. Fixed via mayCarryRawBool + the
  // gate/body-split emitIdentitySafeArms (test262 logical-or/S11.11.2_A4_T4).
  const cases = [
    'export let f = () => (true || undefined) === true',
    'export let f = () => (true || null) === true',
  ]
  for (const src of cases) for (const optimize of levels(0, 1, 2, 3))
    is(jz(src, { optimize }).exports.f(), true, `O${optimize} ${src}`)
})

// ============================================
// Boolean identity across untyped carriers — the self-compile mother bug
// (kernel resolveOptimize: `1 === true` took the level-2 branch; fromEntries
// presets read back 0/1 so `cfg.pass !== false` ran passes the host skipped).
// (kernel resolveOptimize: `1 === true` took the level-2 branch; fromEntries
// presets read back 0/1 so `cfg.pass !== false` ran passes the host skipped).
//
// Contract (src/ir.js BOOL_ATOM_BASE): booleans are raw i32/f64 0/1 ONLY while
// their static type is known (branch/arithmetic position). The moment one flows
// into an untyped carrier — container store, collection key/value, closure arg,
// mixed ?:/&&/||/?? merge — it materializes as its TRUE/FALSE atom (carrierF64),
// so typeof / String / strict-eq observe boolean identity. Strict equality
// against a bool literal on an unknown operand compares atom BITS (emitStrictEq)
// — `1 === true` is false, exactly ES; BOOL∪NUMBER merges deliberately stay raw
// (the 0/1 IS the ToNumber image — VT['?:'] carries NUMBER there).
// ============================================

const LEVELS = levels(false, 2)

test('bool identity: containers round-trip the atom', async () => {
  const SRC = `
  export const probe = () => {
    const fe = Object.fromEntries([['f', false], ['t', true]])
    const m1 = new Map([['k', false]])
    const m2 = new Map(); m2.set('k', true)
    const h = {}; const dk = 'dk'; h[dk] = false
    const pairs = [['k', false]]
    const a = [0]; a[0] = true
    const p = []; p.push(false)
    return [
      typeof fe.f, String(fe.f), typeof fe.t,
      typeof m1.get('k'), typeof m2.get('k'),
      typeof h[dk], typeof pairs[0][1], typeof a[0], typeof p[0],
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(), 'boolean|false|boolean|boolean|boolean|boolean|boolean|boolean|boolean', `optimize:${optimize}`)
  }
})

test('bool identity: strict-eq is identity, loose stays ToNumber', async () => {
  const SRC = `
  export const probe = () => {
    const fe = Object.fromEntries([['f', false]])
    const g = (x) => x === true          // mixed-site param: g(true) and g(1)
    return [
      1 === true ? 'X' : 'ok',           // ES: false
      0 === false ? 'X' : 'ok',
      fe.f === false ? 'ok' : 'X',       // boxed false IS false
      fe.f !== false ? 'X' : 'ok',       // the resolveOptimize gate shape
      fe.f == 0 ? 'ok' : 'X',            // loose: ToNumber(false) == 0
      g(true) ? 'ok' : 'X',
      g(1) ? 'X' : 'ok',
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(), 'ok|ok|ok|ok|ok|ok|ok', `optimize:${optimize}`)
  }
})

test('bool identity: mixed ?:/&&/||/?? merges box the bool arm, numeric mixes stay raw', async () => {
  const SRC = `
  export const probe = (n, s) => {
    const a = []
    for (let i = 0; i < n; i++) a.push(i ? true : [7, 8])   // watr's rec-type marker shape
    const v = s || false
    const w = s && true
    const u = s ?? false
    return [
      typeof a[1], a[1] === true ? 'ok' : 'X',
      typeof v, String(v), v === false ? 'eqF' : 'neF',
      typeof w,
      typeof u,
      String(1 + (n > 0 ? 1 : n > -1)),        // BOOL∪NUMBER: raw, arithmetic exact
      String((n > 0 ? true : 'x')),            // BOOL∪STRING: identity kept
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(2, ''), 'boolean|ok|boolean|false|eqF|string|string|2|true', `optimize:${optimize} falsy`)
    is(probe(2, 'x'), 'boolean|ok|string|x|neF|boolean|string|2|true', `optimize:${optimize} truthy`)
  }
})

test('bool identity: preset-table idiom (the kernel divergence chain)', async () => {
  // KERNEL DEBT (2026-07-21a, BindingId wave): the number-level row diverges
  // through the kernel (probe('1') hits the ALL_ON copy — dynamic numeric-key
  // table lookup on a string param's JSON.parse result; same string-param
  // inference class as feature-gating's JSON.parse skip). Native leg owns this
  // pin until the class is burned down; do not widen this skip.
  if (onKernel()) return
  // resolveOptimize's exact shape: fromEntries -> freeze -> spread -> number
  // level from JSON.parse -> `=== true` branch test -> `!== false` pass gates.
  const SRC = `
  const NAMES = ['cseScalarLoad', 'propagateLocals', 'treeshake', 'fusedRewrite']
  const ALL_ON = Object.freeze(Object.fromEntries(NAMES.map(n => [n, true])))
  const ALL_OFF = Object.freeze(Object.fromEntries(NAMES.map(n => [n, false])))
  const P1 = Object.freeze({ ...ALL_OFF, treeshake: true, fusedRewrite: true })
  const TABLE = Object.freeze({ 0: ALL_OFF, 1: P1, 2: ALL_ON })
  const resolve = (opt) => {
    if (opt === false || opt === 0) return { ...ALL_OFF }
    if (opt === true || opt == null) return { ...TABLE[2] }
    if (typeof opt === 'number' || typeof opt === 'string') return { ...(TABLE[String(opt)] || TABLE[2]) }
    return { ...ALL_OFF }
  }
  export const probe = (optJSON) => {
    const cfg = resolve(JSON.parse(optJSON))
    return [
      cfg.cseScalarLoad !== false ? 'ON' : 'off',
      cfg.treeshake ? 'on' : 'OFF',
      Object.keys(cfg).length,
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe('1'), 'off|on|4', `optimize:${optimize} number level (JSON.parse('1') must NOT hit === true)`)
    is(probe('"1"'), 'off|on|4', `optimize:${optimize} string level`)
    is(probe('true'), 'ON|on|4', `optimize:${optimize} literal true takes the === true branch (frozen TABLE[2] literal read)`)
    is(probe('0'), 'off|OFF|4', `optimize:${optimize} zero level`)
  }
})

test('bool identity: dyn-spread literal bool props keep the atom (=== true survives)', async () => {
  // The rotateLoops loss: {...fromEntries(...), rotateLoops: true} lowers via
  // emitDynamicSpread (unknown spread source → HASH); its explicit `k: v` writes
  // stored `emit(v)` RAW — a literal true landed as 1.0 bits, not the TRUE atom —
  // so every `cfg.flag === true` gate read false and speed-tier passes silently
  // dropped in-kernel (sum|3 rotation, O3 preset flags). The write must go
  // through storedValue/carrierF64 like every other container ingress.
  const SRC = `
  const AO = Object.fromEntries([['p', true]])
  const P = { ...AO, a: true, b: false, s: 'speed', n: 16 }
  export const probe = () => [
    P.a === true ? 'A' : 'x', P.b === false ? 'B' : 'x',
    P.p === true ? 'P' : 'x', P.s === 'speed' ? 'S' : 'x', P.n === 16 ? 'N' : 'x',
    P.a ? 't' : 'x', typeof P.a,
  ].join('|')`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(), 'A|B|P|S|N|t|boolean', `optimize:${optimize}`)
  }
})

test('bool identity: typed-array element writes ToNumber the box', async () => {
  const SRC = `
  export const probe = () => {
    const f = new Float64Array(2), u = new Uint8Array(2)
    const k = 0
    f[k] = true; u[k] = true      // dyn index defeats the inline typed store
    f[1] = false; u[1] = false
    return [f[0], f[1], u[0], u[1]].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(), '1|0|1|0', `optimize:${optimize}`)
  }
})

test('bool identity: JSON, truthiness, arithmetic on boxed bools', async () => {
  const SRC = `
  export const probe = () => {
    const fe = Object.fromEntries([['f', false], ['t', true]])
    return [
      JSON.stringify({ a: false, b: [true] }),
      fe.t ? 'T' : 'X', fe.f ? 'X' : 'F',    // truthiness of boxed atoms
      fe.t + 1, fe.f + 1,                    // ToNumber through the box
      [false, true].indexOf(true),
      [false].includes(false) ? 'inc' : 'X',
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(), '{"a":false,"b":[true]}|T|F|2|1|1|inc', `optimize:${optimize}`)
  }
})

// A boolean that may be nullish is not statically boolean. `litTruth`'s
// shape (src/prepare/const-fold.js) returns `!!x` or null; `t === false` was
// lowered as "t is falsy", so null took the false arm and foldConstIf dropped
// every `if` whose condition was no literal — the kernel compiled
// `if (idx > 1) return idx * 8; return 7` to `return 7`. The identity of the
// nullish member is its carrier's; loose `==` converts the present boolean
// and rejects the nullish (JS: `null == false` is false, `true == 1` true).
test('bool identity: a boolean-or-null result keeps null apart from false and true', () => {
  const SRC = `
  const tri = n => n === 1 ? true : n === 0 ? false : null
  export let f = (n) => { const t = tri(n); return (t === true ? 1 : 0) + (t === false ? 2 : 0) + (t !== false ? 4 : 0) + (t === null ? 8 : 0) + (t == null ? 16 : 0) }
  export let g = (n) => { const t = tri(n); return (t == false ? 1 : 0) + (t == 0 ? 2 : 0) + (t == 1 ? 4 : 0) + (t != true ? 8 : 0) }
  export let fold = (idx) => { if (idx > 1) return idx * 8; return 7 }`
  const host = oracle(SRC)
  for (const optimize of levels(false, 1)) {
    const ex = run(SRC, { memory: 256, optimize })
    for (const n of [1, 0, 2]) { is(ex.f(n), host.f(n), `=== O${optimize || 0} tri(${n})`); is(ex.g(n), host.g(n), `== O${optimize || 0} tri(${n})`) }
    is(ex.fold(2), 16, `the guarded return survives (O${optimize || 0})`)
  }
})

// Strict equality of a certain number against a value the program cannot type
// statically converts nothing. The number-beside-unknown arm shared loose
// `==`'s ToNumber lowering, so `b[1] === 0` read a parsed WAT immediate '0'
// as equal: the kernel's peephole folded `(i32.or x (i32.const 0))` where
// native kept it (the string-equality template's byte divergence). Every
// carrier kind, both operand orders, negated, and a join whose boolean arm
// would collapse to a raw 0/1, against the JS oracle.
test('bool identity: strict equality of a number against an untyped operand converts nothing', () => {
  const SRC = `const box = (v) => [v][0]
  const node = (v) => ['i32.const', v]
  export const strict = () => {
    const vals = [box('0'), box(''), box(' '), box('1'), box(true), box(false), box(null), box(undefined), box(0), box(1), box(0n), box([0])]
    return vals.map(v => (v === 0 ? 1 : 0) + (0 === v ? 2 : 0) + (v !== 0 ? 4 : 0) + (v === 1 ? 8 : 0) + (1 !== v ? 16 : 0)).join(',')
  }
  const imm = ['0', 0, 1, '1']
  export const member = (i) => { const b = node(imm[i]); return (b[1] === 0 ? 1 : 0) + (b[1] !== 0 ? 2 : 0) + (b[1] === 1 ? 4 : 0) }
  export const join = (a, b) => {
    const o = { a: box(a), b: box(b) }
    return ((o.a > 0 || o.b) === 1 ? 1 : 0) + ((o.a > 0 || o.b) !== 1 ? 2 : 0) + ((o.a > 0 && o.b) === 0 ? 4 : 0) + ((o.a > 0 || o.b) === true ? 8 : 0)
  }`
  const host = oracle(SRC)
  for (const optimize of levels(false, 1, 2)) {
    const ex = run(SRC, { memory: 256, optimize })
    is(ex.strict(), host.strict(), `boxed carriers O${optimize || 0}`)
    for (const i of [0, 1, 2, 3]) is(ex.member(i), host.member(i), `member holding imm[${i}] O${optimize || 0}`)
    for (const [a, b] of [[1, 1], [0, 1], [1, 0], [0, 0], [1, 'x'], [0, 'x']]) is(ex.join(a, b), host.join(a, b), `join(${a}, ${JSON.stringify(b)}) O${optimize || 0}`)
  }
})

// A boolean the analysis marks nullable (a builtin's result, `la.has(a)`,
// fails closed) keeps its raw 0/1 carrier; strictly compared with a value the
// program cannot kind (`lb.has(b)`, lb a slot value: its result is an atom)
// it enters the dynamic compare as its atom, as it would enter any untyped
// carrier. The raw 1 beside the TRUE atom read unequal: the compiler's own
// closure-body dedup (src/wat/assemble/closure-table.js, `al !== bl`) found no
// equal bodies in the kernel and kept 1,249 duplicates.
test('bool identity: a nullable boolean beside an unkinded boolean compares strictly as its atom', () => {
  const SRC = `const namesOf = (fn) => { const names = new Set(); for (const n of fn) if (typeof n === 'string') names.add(n); return names }
  const equalBodies = (fa, la, fb, lb) => {
    const eq = (a, b) => {
      const as = typeof a === 'string', bs = typeof b === 'string'
      if (as || bs) {
        if (!as || !bs) return false
        const al = la.has(a), bl = lb.has(b)
        if (al !== bl) return false
        if (al === bl) { if (!al) return a === b; return true }
        return false
      }
      return a === b
    }
    for (let i = 0; i < fa.length; i++) if (!eq(fa[i], fb[i])) return false
    return true
  }
  export const dedup = () => {
    const fns = [['$a', '$b'], ['$c', '$d'], ['x', 'y'], ['x', 'z']]
    const buckets = []
    let dup = 0
    for (const fn of fns) {
      const locals = namesOf(fn)
      let hit = false
      for (const cand of buckets) if (equalBodies(fn, locals, cand.fn, cand.locals)) { hit = true; break }
      if (hit) dup++; else buckets.push({ fn, locals })
    }
    return dup
  }
  export const pair = (k) => { const s = new Set([1]); const o = { t: new Set([1]) }; const al = s.has(k), bl = o.t.has(1); return (al === bl ? 1 : 0) + (al !== bl ? 2 : 0) + (bl === al ? 4 : 0) + (al == bl ? 8 : 0) }`
  const host = oracle(SRC)
  for (const optimize of levels(false, 1, 2)) {
    const ex = run(SRC, { memory: 256, optimize })
    is(ex.dedup(), host.dedup(), `dedup O${optimize || 0}`)
    for (const k of [1, 2]) is(ex.pair(k), host.pair(k), `pair(${k}) O${optimize || 0}`)
  }
})

// Loose `==` between values the program cannot type statically: a boolean
// beside a number converts (`true == 1`, `false == 0`), null and undefined
// are equal to each other alone, a boolean is not a string. The runtime's
// `__eq` compared the boolean atom's bits with the number, so every such
// pair was unequal; the static BOOL arm already converted.
test('bool identity: dynamic loose equality converts a boolean beside a number', () => {
  const SRC = `const box = (v) => [v][0]
  export const probe = () => {
    const t = box(true), f = box(false), one = box(1), zero = box(0), s = box('x'), n = box(null), u = box(undefined)
    return [t == one, f == zero, t == zero, one == t, f == n, t == s, n == u, t == t, t != one, one != t, f != zero, u == zero].map(x => x ? 1 : 0).join('')
  }`
  for (const optimize of LEVELS) {
    const { probe } = run(SRC, { memory: 256, optimize })
    is(probe(), '110100110000', `optimize:${optimize}`)
  }
})

// Loose `==` of a value the program cannot kind against a number or a
// boolean it can (a literal, a proven local, a comparison result): the
// boolean atom converts on either side (`true == 1`, `x == true` with x
// holding true), a boxed BigInt compares mathematically, null and undefined
// equal no number; `!=` negates. Strict `===` through the same dynamic path
// stays identity: `true === 1` is false whatever carries the operands.
// The static side once compared raw bits (a NaN-boxed atom equals no f64),
// and the runtime's strict form inherited the loose boolean conversion.
test('bool identity: loose equality of a number or boolean against any converts; strict stays identity', () => {
  const PARTNERS = ['1', '0', '2', '-0', 'NaN', 'true', 'false', 'k > 0', 'k === 0', 'null', 'undefined']
  const table = (X) => `[${PARTNERS.flatMap(p => [`${X} == ${p}`, `${p} == ${X}`, `${X} != ${p}`, `${X} === ${p}`, `${p} === ${X}`]).join(', ')}].map(v => v ? 1 : 0).join('')`
  const VALUES = ['true', 'false', '1', '0', '2', 'null', 'undefined', "'1'", '1n', '0n']
  const SRC = (V) => `const box = (v) => [v][0]
  export const f = (k) => { const x = box(${V}); return ${table('x')} }
  export const g = (k) => { const x = box(${V}), y = box(${V}); return [x == y, x === y, x != y, x !== y, box(true) === box(1), box(1) === box(true), box(false) === box(0), box(true) == box(1), box(0n) === box(0), box(0n) == box(0), box(0n) == box(false), box(0n) === box(false)].map(v => v ? 1 : 0).join('') }`
  for (const V of VALUES) {
    const src = SRC(V)
    const host = oracle(src)
    for (const optimize of LEVELS) {
      const ex = run(src, { memory: 256, optimize })
      for (const k of [0, 1]) {
        const got = ex.f(k), want = host.f(k)
        const at = got === want ? -1 : [...got].findIndex((c, i) => c !== want[i])
        const where = at < 0 ? '' : ` ${['==', '== (reversed)', '!=', '===', '=== (reversed)'][at % 5]} ${PARTNERS[Math.floor(at / 5)]}`
        is(got, want, `any ${V}${where} (k=${k}, optimize:${optimize})`)
        is(ex.g(k), host.g(k), `any ${V} against any (k=${k}, optimize:${optimize})`)
      }
    }
  }
})

// `Number` and `Boolean` as values convert (`.map(Number)` of strings and
// booleans, `.map(Boolean)`); the identity arrow they lowered to served
// `.filter(Boolean)` alone. (A boolean's identity through a closure result
// into an array is the carrier family's, pinned elsewhere: truthiness here.)
test('bool identity: Number and Boolean as values convert', () => {
  const SRC = `const box = (v) => [v][0]
  export const probe = () => [[true, false].map(Number).join(','), [box(true), box('2.5'), null].map(Number).join(','), [0, 1, '', 'a', null].filter(Boolean).length, [2, 0, 'a', ''].map(Boolean).map(x => x ? 'T' : 'F').join('')].join('|')`
  for (const optimize of LEVELS) {
    const { probe } = run(SRC, { memory: 256, optimize })
    is(probe(), '1,0|1,2.5,0|2|TFTF', `optimize:${optimize}`)
  }
})

// A boolean produced inside an array builtin's inline callback (`map`, the
// fused filter→map and map→filter, `Array.from`'s mapper) stored raw 0/1;
// a boolean lane of a multi-value return (`return [v, 1]`) converted to a
// number; a typed array's `map` stored a closure's boolean atom as NaN. The
// host decodes each result, so the check is what it reads back.
test('bool identity: a boolean result reaches an array as itself, through a callback, a lane and a typed store', () => {
  const SRC = `function receiver() { return new Float64Array([2, 3]) }
  export function lanes(x) { const v = x > 1; return [v, 1] }
  export function lanesSome() { let value = receiver().some(x => x === 3); return [value, 1] }
  export function mapped(x) { return [3, 0].map(y => y > x) }
  export function negated() { return [1, 0].map(y => !y) }
  export function mixed(x) { return [3, 0].map(y => y > x ? 1 : false) }
  export function filterMap(x) { return [3, 0, 5].filter(y => y > 1).map(y => y > x) }
  export function mapFilter(x) { return [3, 0, 5].map(y => y > x).filter(y => y === true) }
  export function from(x) { return Array.from([3, 0], y => y > x) }
  export function sorted(x) { return [3, 0].map(y => y > x).sort() }
  export function typedMap(x) { return new Float64Array([1, 0]).map(y => y > x) }
  export function kinds(x) { return [3, 0].map(y => y > x).map(v => typeof v).join(',') }`
  const host = oracle(SRC)
  for (const optimize of LEVELS) {
    const ex = jz(SRC, { memory: 256, optimize }).exports
    for (const name of Object.keys(host)) {
      const got = ex[name](2), want = host[name](2)
      is(Array.isArray(want) || ArrayBuffer.isView(want) ? Array.from(got) : got, Array.isArray(want) || ArrayBuffer.isView(want) ? Array.from(want) : want, `${name} optimize:${optimize}`)
    }
  }
})
