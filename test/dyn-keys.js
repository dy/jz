// Dynamic-key dictionary semantics vs V8 (the lean-write/generic-read layout
// mismatch family — ledger 2026-07-22). The load-bearing pin: a LOOP-BUILT
// dict (keys from array elements — qualifies the ephemeral write layout
// unless reads disqualify it) read with a missing key must be undefined,
// never a trap and never a garbage hit.
import test from 'tst'
import { is } from 'tst/assert.js'
import jz from '../index.js'

const run = (body) => jz('export let f = () => {' + body + '}', { jzify: true }).exports.f()

test('dyn-keys: direct-write dict, present + missing keys', () => {
  is(run(`const d = {}; d['a'] = 1; return d['a']`), 1)
  is(run(`const d = {}; d['a'] = 1; return d['zz'] === undefined ? 1 : 0`), 1)
  is(run(`const d = {}; d['a'] = 1; return d['undefined'] === undefined ? 1 : 0`), 1)
})

test('dyn-keys: loop-built dict (element-sourced keys) — the trap class', () => {
  is(run(`const d = {}; const ks = ['a','b']; for (let i = 0; i < ks.length; i++) d[ks[i]] = i; return d['zz'] === undefined ? 1 : 0`), 1)
  is(run(`const d = {}; const ks = ['a','b']; for (let i = 0; i < ks.length; i++) d[ks[i]] = i; return d['b']`), 1)
  is(run(`const d = {}; const ks = ['if','for','while','x','y','(','{',':']; for (let i = 0; i < ks.length; i++) d[ks[i]] = i + 1; return (d['undefined'] === undefined ? 10 : 20) + (d['('] === 6 ? 1 : 2)`), 11)
})

test('dyn-keys: histogram RMW stays lean-eligible (the fused read is not a plain read)', () => {
  is(run(`const d = {}; const ks = ['a','b','a']; for (let i = 0; i < ks.length; i++) d[ks[i]] = (d[ks[i]] | 0) + 1; return (d['a'] | 0) * 10 + (d['b'] | 0)`), 21)
})

test('dyn-keys: atom-vs-NaN key split (index contract preserved)', () => {
  // Real NaN keeps the documented i32-truncating index contract (a[NaN] → a[0]);
  // only ATOM boxes (undefined/null) stringify. The first ToPropertyKey arm
  // used f64.eq(k,k), which lumped real NaN in with the atoms and broke the
  // contract pin in array-methods.
  is(run(`const a = [11, 22]; const k = 0/0; return a[k]`), 11)
  is(run(`const d = {}; d['undefined'] = 7; const u = [, 1][0]; return d[u]`), 7)
})

test('dyn-keys: ToPropertyKey for atom keys (the prec[undefined] class)', () => {
  // V8 truth 2112: prec[undefined] reads key "undefined" — never index 0.
  is(run(`const prec = {}
    const keys = ['if', 'for', 'while', 'x', 'y', '(', '{', ':']
    for (let i = 0; i < keys.length; i++) prec[keys[i]] = i + 1
    const hole = [, 'k']
    const u = hole[0]
    return (prec[u] <= 5 ? 1000 : 2000) + (prec['('] === 6 ? 100 : 200) + (prec[u] === undefined ? 10 : 20) + (prec['nope'] <= 5 ? 1 : 2)`), 2112)
  is(run(`const d = {}; d['null'] = 8; return d[null]`), 8)
  // KNOWN GAP (carrier-level, pre-existing): jz booleans are bare-number
  // carriers (true ≡ 1.0 at runtime), so a DYNAMIC d[true] coerces to key '1',
  // not 'true'. Static bool keys fold correctly; only runtime-flowing bools
  // diverge. Pin the current behavior so a carrier change surfaces here.
  is(run(`const d = {}; d['true'] = 9; return d[true] === undefined ? 1 : 0`), 1)
})

// dyn-prop KEYING on a NUMERIC (non-string) key against an OBJECT receiver
// whose static type is fully unknown — repro A + sweep siblings, ledger
// 2026-07-29. Root: module/array.js's generic `arr[i]` fallback ("Unknown ->
// runtime dispatch") assumed a numeric key on an unproven receiver is always
// ARRAY/TYPED access, routing straight to __typed_idx — sound for ARRAY/TYPED,
// but __typed_idx's own non-ARRAY/TYPED fallback bounds-checks against __len
// (0 for OBJECT), which has nothing to do with dyn-props key presence: an
// empty-schema OBJECT with a literal-string-key write (`o={}; o['1']=9` — a
// LITERAL key, invisible to dynWriteVars, so `o` never qualifies as dict-mode
// HASH) silently read undefined instead of the stored value for ANY numeric
// key reached at runtime. First fixed ONLY on the runtime-is_str_key-dispatched
// arm (key kind ALSO unproven, not just the receiver); the sibling
// PROVEN-NUMBER-key fallback (last case below) was left unsound to protect a
// NAMED perf pin (test/perf.js "codegen: unknown-receiver index with NUMBER
// key skips __is_str_key dispatch") for the dominant `a[loopCounter]` hot-loop
// shape. Re-audit #5 finding #1 (2026-07-30) closed that gap too: selection
// between the typed-indexed read and the dyn-props read now depends on the
// RECEIVER pointer-kind (one tag test), not the key kind — the perf pin was
// rewritten to assert the guard shape instead of zero dispatch.
// `j` is a PARAMETER and `o`/`nums` are MODULE-LEVEL globals throughout (not
// jzify'd/wrapped locals) — load-bearing: a local `nums` can let `nums[j]`'s
// element kind get proven NUMBER, which exercises the SAME now-fixed
// receiver-kind guard rather than a different code path.
test('dyn-keys: numeric key on an unknown-type OBJECT receiver resolves through dyn-props', () => {
  // repro A: numeric key sourced from an array read (key kind unproven at the
  // outer `o[...]` site — is_str_key dispatch survives), receiver `o` has no
  // static val type (empty `{}`, literal-key-only writes).
  is(jz(`const o = {}; o['1'] = 9
    let nums = []; nums.push(1)
    export let f = (j) => o[nums[j]] | 0`).exports.f(0), 9)
  // WRITE-side sibling: a numeric key WRITE on the same shape (o[nums[j]]=v)
  // must land where the matching literal-key READ finds it.
  is(jz(`const o = {}
    let nums = []; nums.push(1)
    export let f = (j) => { o[nums[j]] = 5; return o['1'] | 0 }`).exports.f(0), 5)
  // `delete` sibling: same ToPropertyKey normalization on the removal path.
  is(jz(`const o = {}; o['1'] = 9
    let nums = []; nums.push(1)
    export let f = (j) => { delete o[nums[j]]; return o['1'] === undefined ? 1 : 0 }`).exports.f(0), 1)
  // `in` operator sibling (module/collection.js): a numeric key must
  // ToPropertyKey-probe an OBJECT's dyn-props the same way a string key
  // already does, not just check ARRAY/TYPED in-range membership.
  is(jz(`const o = {}; o['1'] = 9
    let nums = []; nums.push(1)
    export let f = (j) => (nums[j] in o) ? 1 : 0`).exports.f(0), 1)
  is(jz(`const o = {}; o['2'] = 9
    let nums = []; nums.push(1)
    export let f = (j) => (nums[j] in o) ? 1 : 0`).exports.f(0), 0)
  // Map keys are SameValueZero, NOT ToPropertyKey — must NOT be conflated
  // with the OBJECT/HASH dyn-props fix above (a Map's numeric key stays a
  // real number key, never coerced to a string).
  is(jz(`const m = new Map()
    let nums = []; nums.push(1)
    export let f = (j) => { m.set(nums[j], 'x'); return m.has('1') ? 1 : 0 }`).exports.f(0), 0)
  // Re-audit #5 finding #1 (2026-07-30): a numeric key PROVEN VAL.NUMBER at
  // compile time on an unknown receiver used to skip dispatch entirely and
  // route array-only (__typed_idx), silently reading undefined for an
  // OBJECT/HASH receiver. Fixed by a receiver-kind guard (module/array.js
  // "Proven-NUMBER key, receiver kind still unproven" arm): ARRAY/TYPED still
  // take the lean typed-array read (no runtime dispatch beyond one pointer-
  // kind tag test — no __is_str_key/__to_str call, since the key is already
  // proven non-string); OBJECT/HASH takes the SAME ToPropertyKey dyn-props
  // probe the runtime-dispatched sibling arm already used. `o[n]` for a
  // proven-number local `n` now reads the value stored under the literal
  // string key `o['1']`, matching JS.
  is(jz(`const o = {}; o['1'] = 9
    export let f = () => { let n = 1; return o[n] | 0 }`).exports.f(), 9)
})

// audit P0 (1db8e55e revert, external bisection): the Map value-census .get()
// consumer promoted EVERY read on a proven-Map receiver to the exact VAL.*
// kind of every observed .set() write. Unsound two ways: (1) an ABSENT key
// reads real JS `undefined` at runtime — not a value of the observed kind;
// (2) the census scan keys observations by SYNTACTIC receiver name, so a
// write through an alias is invisible to a census keyed on the original
// name, leaving a stale kind in place after the alias write changes it.
// Both promote past what the actual runtime value is. Consumer reverted
// (kind.js mapValueKindOf, emit.js nullableOperand carve-out); these pin
// the bisected repros.
test('Map: .get() on an absent key behaves as real undefined, not the census kind (audit P0)', () => {
  is(run(`const m = new Map(); m.set('a', 1); return m.get('b') + 1`), NaN)  // undefined + 1 === NaN
  is(run(`const m = new Map(); m.set('a', 1); return String(m.get('b'))`), 'undefined')  // NOT "NaN"
})

test('Map: a write through an alias is not lost to a stale census kind (audit P0)', () => {
  // m.set('k', 1) alone would (wrongly) settle the census at NUMBER; the
  // syntactic-name scan never observes the alias.set() STRING write below,
  // so a sound consumer must not trust a stale NUMBER kind for m.get('k').
  is(run(`const m = new Map(); m.set('k', 1)
    const alias = m; alias.set('k', 'oops1')
    return m.get('k') - 0`), NaN)  // 'oops1' - 0 === NaN, same as plain JS
})

// FIXED (.work/maybe-undefined-design.md Slice 1, value-join): dictValueKindOf
// (kind.js, consumed by VT['[]']/VT['.']) had the SAME absent-key
// exact-promotion unsoundness as the reverted mapValueKindOf — the census is
// "every value ever WRITTEN", not "this key exists". Closed by
// `censusMaybeUndefined` (kind.js, promoted from emit.js's `nullableOperand`
// carve-out), wired into ir.js's toNumF64 (coerces through
// coerceNullishToNum: undefined→NaN) and module/string.js's `bind('String', …)`
// (falls through to the already-correct toStrI64/__to_str general arm). The
// dict-value-census consumer itself is UNCHANGED — still live, still returns
// the exact kind — only these two arithmetic/ToString chokepoints now ask
// "could this exact-kind claim be falsified by an absent key" first.
test('dict: .get()-equivalent read on an absent key behaves as real undefined (Slice 1, dict-census sibling of audit P0)', () => {
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1; const rk = 'zz'; return d[rk] + 1`), NaN)  // undefined + 1 === NaN
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1; const rk = 'zz'; return String(d[rk])`), 'undefined')
})

// FIXED (.work/maybe-undefined-design.md §2/Slice 3, nameEscapes alias gate):
// dictValueKindOf (the ALREADY-LIVE dict census consumer) had the SAME
// alias-write unsoundness as the reverted mapValueKindOf — the census keys
// observations by SYNTACTIC receiver name (analyze.js's dictValueTypeOf
// same-body scan), so a write through an alias (`const a = d; a[k] = v`) is
// invisible to a census keyed on `d`, leaving a stale exact-kind claim live
// after the alias write changes the real value's kind. Closed by gating
// `dictValueKindOf` on `ctx.types.nameEscapes.has(name)` (kind.js) — `d`
// lands in nameEscapes the moment it's read in a value position anywhere
// (here, the `const alias = d` initializer).
// LANDING FOUND AND FIXED A SECOND, PRE-EXISTING BUG this gate depends on:
// nameEscapes itself (program-facts.js) never marked a bare-name DECL
// initializer's RHS (`const alias = d`) at all — walkFacts' 'let'/'const'
// special case hand-walks each declarator instead of visiting the '='
// node through the normal recursive call, so observeNodeFacts' generic
// per-arg escape-marking loop (and the declEq exemption it pre-registers)
// never ran for decl form. A plain (non-decl) reassignment (`let alias;
// alias = d`) was NOT affected — that '=' node DOES reach observeNodeFacts
// via walkFacts' unconditional entry call. Confirmed by direct trace (both
// forms, live instrumentation): decl-form left 'd' OUT of nameEscapes;
// reassignment-form correctly marked it. This is the exact `const alias = m`
// shape the audit-P0 Map pins (above) and design §2's own worked example
// use — without this fix, the nameEscapes gate silently does NOT fire for
// the design's own canonical alias-creation idiom. Fixed by having the
// 'let'/'const' branch call `observeNodeFacts(decl, acc)` on each
// '='-shaped declarator explicitly (program-facts.js) — the pre-registered
// declEq exemption still protects the LHS binding slot; only the previously-
// invisible bare-name RHS case is newly (and correctly) marked.
// Repro confirmed red at HEAD (both with and without the kind.js gate alone
// — the nameEscapes bug meant the gate had nothing to consult): `jz =
// 'oops1'` (a raw NaN-boxed string pointer surviving `- 0` bit-for-bit,
// decoded back to the string by the host bridge) vs `JS = NaN`. Green only
// with BOTH fixes landed together.
// String() is NOT a distinguishing case here (unlike the Slice 1 absent-key
// repro above) — Slice 1's censusMaybeUndefined already routes ANY node
// where dictValueKindOf(name) is truthy through toStrI64/__to_str's fully
// general, runtime-tag-correct path for String(), regardless of whether the
// exact-kind claim itself was sound — confirmed this already returned
// 'oops1' correctly even at HEAD, pre-Slice-3. Only toNumF64's arithmetic
// fast return (`asF64(v)` unguarded by any runtime tag check) is exploitable
// by a wrong-but-unpoisoned exact-kind claim; kept below as a passing
// control, not a red→green pin.
test('dict: a write through an alias is not lost to a stale census kind (audit P0 sibling, Slice 3)', () => {
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1
    const alias = d; const wk2 = 'k'; alias[wk2] = 'oops1'
    return d[wk2] - 0`), NaN)  // 'oops1' - 0 === NaN, same as plain JS
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1
    const alias = d; const wk2 = 'k'; alias[wk2] = 'oops1'
    return String(d[wk2])`), 'oops1')  // already correct pre-Slice-3 (see comment above) — control, not a flip
})

// FIXED (.work/maybe-undefined-design.md Slice 5 site survey — LEAK A):
// emitLooseEq/emitStrictEq's (src/compile/emit.js) raw `f64.eq`/`f64.ne` fast
// path fired whenever EITHER side's static kind was VAL.NUMBER, with no
// runtime tag check — unlike arithmetic (toNumF64) and String(), this never
// called censusMaybeUndefined/coerceNullishToNum at all. IEEE-754 f64.eq is
// FALSE for any NaN operand, always — including two bit-identical NaN-boxed
// `undefined` sentinels — so `x === y` where BOTH x and y are genuinely
// `undefined` at runtime (one masquerading as a proven NUMBER via a dict
// census absent-key claim) wrongly read false; JS reads true. The relational
// family (`<`/`>`/`<=`/`>=`, cmpOp) does NOT have this bug — checked as part
// of the same survey: JS's `ToNumber(undefined) = NaN`, "compared to NaN" is
// always false, which is exactly what an UNGUARDED f64 relational op already
// returns for ANY NaN-boxed operand — no fix needed there (kept as a
// passing control below). Fixed by reusing `nullableOperand` (emit.js,
// already unifies the census carve-out with the unproven-typed-index-OOB
// carve-out) to gate emitLooseEq's `aSafe`/`bSafe` NUMBER-trust — a claim
// only counts as "safe" now when BOTH ===VAL.NUMBER AND non-nullable.
test('dict: strict/loose equality between two independently-maybe-undefined reads (Slice 5 LEAK A)', () => {
  // one side a real (non-census) undefined-holding local
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1; const rk = 'zz'
    let u
    return d[rk] === u ? 1 : 0`), 1)
  // both sides independent absent-key dict reads
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1; const rk = 'zz'; const rk2 = 'yy'
    return d[rk] === d[rk2] ? 1 : 0`), 1)
  // loose eq, one side NUMBER-census, other side an unrelated unproven boxed read
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1; const rk = 'zz'
    const other = {}; const owk = 'p'; other[owk] = 1; other[owk] = 'str'
    const ork = 'q'
    return d[rk] == other[ork] ? 1 : 0`), 1)
  // literal `undefined`/`null` sentinel comparisons stay correct (pre-existing carve-out, control)
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1; const rk = 'zz'
    return d[rk] === undefined ? 1 : 0`), 1)
  // relational family needs no fix — NaN-boxed operand already compares false, matching
  // JS's ToNumber(undefined)=NaN semantics (control, not a flip)
  is(run(`const d = {}; const wk = 'a'; d[wk] = 1; const rk = 'zz'
    return d[rk] > 5 ? 1 : 0`), 0)
})

// FIXED (.work/maybe-undefined-design.md Slice 5 site survey — LEAK B):
// ir.js's toStrI64 — the SAME function module/string.js's `bind('String', …)`
// already delegates to for the maybeUndefined-flagged case, on the stated
// belief it "falls through to the LAST branch... already correct" — had its
// OWN unguarded `vt === VAL.STRING` early return ABOVE that last branch.
// A dict census whose OBSERVED writes were all STRING (not NUMBER, the only
// kind Slice 1's own repro exercised) hit THIS branch instead: `asI64(v)`
// reinterpreted the absent key's raw UNDEF_NAN bits as a string i64 — which
// decodes host-side as the bare `undefined` VALUE, not the string
// `"undefined"` (a WORSE failure than a wrong string: wrong TYPE entirely).
// Reaches template-literal interpolation too (ir.js's toStrI64 is strcat's
// per-part fallback, module/string.js), contradicting the Slice 1 design's
// "template literals need no fix" claim — that claim was verified only
// against a NUMBER-kind census; the STRING-kind case was untested. Fixed at
// toStrI64 itself (the shared chokepoint), gating the `vt===VAL.STRING`
// return on `!censusMaybeUndefined(node)`.
test('dict: String() and template literals on a STRING-census absent key (Slice 5 LEAK B)', () => {
  is(run(`const d = {}; const wk = 'a'; d[wk] = 'x'; const wk2 = 'b'; d[wk2] = 'y'
    const rk = 'missing'
    return String(d[rk])`), 'undefined')
  is(run(`const d = {}; const wk = 'a'; d[wk] = 'x'; const wk2 = 'b'; d[wk2] = 'y'
    const rk = 'missing'
    return \`v=\${d[rk]}\``), 'v=undefined')
})
