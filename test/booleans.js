// Real-boolean carrier: booleans carry as the cheap 0/1 i32 internally, and a
// real boolean is materialized lazily only where boolean-ness is *observed* —
// the host boundary, typeof, String, JSON.stringify. Branches and arithmetic
// pay nothing. See README "Booleans carry as numbers, surface as booleans".
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'

const run = (code) => jz(code).exports.f
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
  is(run('export let f = () => true')(), true)
  is(run('export let f = () => false')(), false)
})

test('bool: relational operators surface as boolean', () => {
  is(run('export let f = (a, b) => a < b')(1, 2), true)
  is(run('export let f = (a, b) => a <= b')(2, 2), true)
  is(run('export let f = (a, b) => a > b')(2, 3), false)
  is(run('export let f = (a, b) => a >= b')(2, 3), false)
})

test('bool: equality operators surface as boolean', () => {
  is(run('export let f = (a, b) => a == b')(1, 1), true)
  is(run('export let f = (a, b) => a != b')(1, 2), true)
  is(run('export let f = (a, b) => a === b')(1, 1), true)
  is(run('export let f = (a, b) => a !== b')(1, 2), true)
})

test('bool: logical not surfaces as boolean', () => {
  is(run('export let f = () => !0')(), true)
  is(run('export let f = () => !1')(), false)
  is(run('export let f = (x) => !x')(5), false)
})

test('bool: Boolean() surfaces as boolean', () => {
  is(run('export let f = () => Boolean(5)')(), true)
  is(run('export let f = () => Boolean(0)')(), false)
  is(run('export let f = () => Boolean()')(), false)
})

// ============================================
// typeof observes a real boolean
// ============================================

test('bool: typeof of a runtime comparison is "boolean"', () => {
  is(run('export let f = (x) => typeof (x > 0)')(5), 'boolean')
  is(run('export let f = (a, b) => typeof (a === b)')(1, 1), 'boolean')
})

test('bool: typeof of a literal boolean is "boolean"', () => {
  is(run('export let f = () => typeof true')(), 'boolean')
  is(run('export let f = () => typeof false')(), 'boolean')
})

// ============================================
// String / JSON.stringify observe a real boolean
// ============================================

test('bool: String() of a comparison is "true"/"false"', () => {
  is(run('export let f = (x) => String(x > 0)')(5), 'true')
  is(run('export let f = (x) => String(x > 0)')(-5), 'false')
})

test('bool: JSON.stringify observes boolean', () => {
  is(run('export let f = (x, y) => JSON.stringify(x < y)')(1, 2), 'true')
  is(run('export let f = () => JSON.stringify([true])')(), '[true]')
})

// ============================================
// Cheap carrier — branch & arithmetic positions pay nothing
// ============================================

test('bool: comparison in branch position works without boxing', () => {
  is(run('export let f = (a, b) => { if (a < b) return 1; return 0 }')(1, 2), 1)
  ok(!boxesResult('export let f = (a, b) => { if (a < b) return 1; return 0 }'),
    'branch-position comparison stays the cheap carrier — no boxed result')
})

test('bool: comparisons sum arithmetically as 0/1', () => {
  is(run('export let f = (a, b, c, d) => (a < b) + (c < d)')(1, 2, 3, 2), 1)
  is(run('export let f = (a, b, c, d) => (a < b) + (c < d)')(1, 2, 2, 3), 2)
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
  is(run('export let f = (b) => b + 0')(true), 1)
  is(run('export let f = (b) => b + 0')(false), 0)
  is(run('export let f = (b) => +b')(true), 1)
  is(run('export let f = (b) => +b')(false), 0)
})

// ============================================
// Honest limitations — the carrier only appears where statically provable.
// Pinned so the README's stated boundaries can't drift silently.
// ============================================

test('bool: value-preserving &&/|| carry the boolean atom across the boundary (gap CLOSED)', () => {
  // Was a documented gap: `5 && true` crossed as raw 1 (the value-preserving
  // merge collapsed the BOOL arm to its numeric carrier). Closed by the
  // ambiguous-BOOL-merge identity work (.work/todo.md §deletion-sweep):
  // a merge with a statically-BOOL arm and a NUMBER sibling boxes the BOOL
  // arm at identity/boundary escapes, so the atom survives to JS exactly.
  // Pure-NUMBER merges stay raw (byte-identical fast path) — pinned below.
  is(run('export let f = () => 5 && true')(), true)
  is(run('export let f = () => 0 || true')(), true)
  is(run('export let f = () => 5 && 3')(), 3)
  is(run('export let f = () => true && 5')(), 5)
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
  for (const optimize of [0, 2, 3]) {
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
  is(run('export let f = () => { let a = [true, false]; return a[0] }')(), true)
  is(run('export let f = () => { let a = [true, false]; return typeof a[0] }')(), 'boolean')
})
