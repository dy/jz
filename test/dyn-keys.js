// Dynamic-key dictionary semantics vs V8 (the lean-write/generic-read layout
// mismatch family — ledger 2026-07-22). The load-bearing pin: a LOOP-BUILT
// dict (keys from array elements — qualifies the ephemeral write layout
// unless reads disqualify it) read with a missing key must be undefined,
// never a trap and never a garbage hit.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
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

// audit-#8 P0-2: the Map/dict value census's same-body scan (analyze.js
// dictValueTypeOf/mapValueTypeOf) AND the whole-program {fresh:true} half
// (program-facts.js observeProgramSlots) both stopped dead at any nested `=>`
// — a write CAPTURED in a callback (`[0].forEach(() => m.set('y', 'oops'))`)
// was invisible to the census on either side, so a receiver written ONLY
// NUMBER at every syntactically-visible top-level site still read back a
// stale NUMBER census kind after a captured write actually stored a STRING —
// `m.get('y') + 1` compiled straight to f64.add and silently dropped the
// string, returning `'oops'` instead of JS's `'oops1'`. Fixed by observing
// THROUGH nested closures (more observations only ever tighten/poison the
// join, never loosen it), gated on collectAllBoundNames' shadow-bail so a
// nested closure that re-declares the receiver name doesn't misattribute ITS
// writes to the outer binding.
test('Map: a write captured in a nested callback is not lost to a stale census kind (audit-#8 P0-2)', () => {
  is(jz(`const m = new Map(); m.set('x', 1)
    export let f = () => { [0].forEach(() => m.set('y', 'oops')); return m.get('y') + 1 }`).exports.f(), 'oops1')
})
test('dict: a write captured in a nested callback is not lost to a stale census kind (audit-#8 P0-2, dict sibling)', () => {
  is(jz(`const d = {}; const wk = 'x'; d[wk] = 1
    export let f = () => { [0].forEach(() => { const wk2 = 'y'; d[wk2] = 'oops' }); const rk = 'y'; return d[rk] + 1 }`).exports.f(), 'oops1')
})
// Numeric captured-write control — the dominant real-world shape
// (`arr.forEach(v => m.set(k, v))`) — a functional-correctness pin only now
// (audit #9 P0-1, .work/todo.md "audit-#9 P0-1 closed": the census consumer
// this comment originally described as "the census win, no fallback to the
// polymorphic-add path" is reverted/dormant, so EVERY `.get()`/dict read
// takes the polymorphic path unconditionally — there is no fast-path win
// left to keep. Historical note: pre-revert, this exact source was manually
// confirmed via a wasm byte-size diff (worktree at 8182e465) to take the
// narrower numeric codegen; that diff is no longer representative.
test('Map: a numeric-only write captured in a nested callback keeps working (control)', () => {
  is(run(`const m = new Map(); [1, 2, 3].forEach(v => m.set('k', v * 2)); return m.get('k') + 1`), 7)
})
// Shadow control: a nested function's OWN param/local reusing the receiver's
// name must NOT poison (or misattribute writes into) the outer census — the
// shadowed `m` inside `g` is a different binding entirely.
test('Map: a same-named local in a nested closure does not poison the outer census (shadow control)', () => {
  is(run(`const m = new Map(); m.set('k', 1)
    const g = (m) => { m.set('k', 'str') }
    g(new Map())
    m.set('k', 2)
    return m.get('k') + 1`), 3)
})
// Read-only capture control: a captured READ (no write) must not disqualify
// the census — only writes matter.
test('Map: a read-only capture does not disqualify the census (control)', () => {
  is(run(`const m = new Map(); m.set('x', 5)
    let s = 0; [0].forEach(() => { s += m.get('x') })
    return s + 1`), 6)
})

// audit-#8 P0-4 Part 3 (2026-08-03): unary '-'/'~' on a maybeUndefined-BIGINT
// receiver (Map.get() or a dict DYNAMIC-key read whose census claims BIGINT)
// used to i64-negate/complement the UNDEF_NAN sentinel's raw bits, producing a
// garbage bigint-shaped float. Real JS: unary ops ToNumeric a single operand —
// undefined's ToNumeric is the Number NaN, no TypeError (contrast the binary
// '+'/'-'/etc. case above, which DOES throw — a second operand's type to
// mismatch against). Fixed by emit.js's bigIntUnary (sibling of bigIntOperand):
// the maybeUndefined operand's runtime UNDEF_NAN check now selects the
// canonical NUMBER result (NaN for '-', -1 for '~') instead of doing raw i64
// math on the sentinel. A dict BRACKET-LITERAL-key read (`d['missing']`) was
// never affected by this bug in the first place — VT['[]']'s own array-vs-
// property disambiguation resolves a non-numeric string-literal key to `null`
// before ever reaching the dict census, so it already took the sound generic
// toNumF64 path; the dynamic-key case below is the one that actually exercised
// the raw-i64 branch.
// Present-key case — FIXED (Slice 5, .work/represented-maybe-undefined-
// design.md §6/§12, the `presentKindUnboxed` family — the last named
// value-wrong family from the audit campaign). Root (re-confirmed live,
// unchanged from the Slice 4 finding below): bigIntUnary's runtime
// select/isUndef branch already computes the CORRECT i64 negate/complement
// internally (present key: isUndef false, selects the negate arm; `-5n`'s
// raw i64 bits are exact) — the corruption used to happen ONE step later, at
// the export boundary (compile/index.js synthesizeBoundaryWrappers): a
// dict/Map-census BIGINT result (bare read OR unary `-`/`~` of one) has no
// STATIC `func.valResult === VAL.BIGINT` proof (the value can genuinely be
// `undefined`/NaN/-1 at runtime), so it fell into the generic resultDynamic
// lane, whose host-side decode (interop.js) reinterprets unrecognized i64
// bits as a NaN-box-or-number — misreading a small BigInt's raw bits as a
// subnormal float (`2.5e-323`) instead of recognizing them as a BigInt.
// FIXED with a LANE/KIND-INFORMATION fix, not a representation change (the
// raw-i64 BigInt carrier doctrine stays as-is): `censusBigintSentinelKind`
// (kind.js) recognizes a census-BIGINT return tail — bare dict/Map read,
// call-result, or `-`/`~` wrapping one — and `synthesizeBoundaryWrappers`
// emits a NEW `jz:i64exp` result marker (`s`: 1 = bare read/call-result,
// sentinel bits = UNDEF_NAN → `undefined`; 2 = unary `-`, sentinel = NaN's
// bits → `NaN`; 3 = unary `~`, sentinel = `-1`'s bits → `-1`) instead of the
// generic `r` marker. interop.js's new `decodeBigintSentinel` checks the
// raw i64 result against exactly that sentinel's fixed bit pattern: a match
// decodes to the sentinel's real JS value, anything else is returned as a
// raw BigInt — no generic NaN-box/number decode, so a small BigInt's bits
// never get misread. TWO deeper bugs found and fixed en route (both
// independent of the export lane itself, both re-verified via full gates):
// (1) `valTypeOfWithLocals`'s unary BigInt-preserving family (kind.js) fell
// through to `numericUnaryVT`'s unconditionally-resolving optimistic-NUMBER
// default whenever the operand's kind was genuinely UNRESOLVED (not
// genuinely NUMBER) at narrowValResults' early whole-program pass — the SAME
// "unknown side → no claim" gap the pre-existing SOUND-`+` fix already
// closed for `+`, just never extended to `u- ~ ++ --`. Left unfixed,
// `export let f = () => -m.get('x')` claimed `func.valResult = VAL.NUMBER`
// and skipped i64 boundary wrapping ENTIRELY — a live miscompile, not just a
// missed optimization. (2) type.js's `exprType` (Phase E i32-result
// narrowing) had the identical class of gap for the bitwise family
// (`~ & | ^ << >>`): an unresolved (not proven-BIGINT) operand still
// defaulted to `'i32'`, narrowing an export's WASM signature away from f64
// even when the operand could genuinely be a census-BIGINT — fixed with a
// `censusShapedNode` guard that keeps the safe `'f64'` default specifically
// for that ambiguous case (ordinary, non-census operands are unaffected).
// THE STRICT-EQUALITY assertions were already correct pre-Slice-5 (Slice 4
// finding, unchanged): `-m.get('x') === -5n` statically proves BOTH sides
// BIGINT (numericUnaryVT + the BIGINT literal), so emitStrictEq takes the
// REF_EQ_KINDS raw i64-bit-compare path, never touching the export lane.
//
// TWO MORE GAPS FOUND, both closed, while reverting Slice 4's VT wiring
// (audit #10, §14): "numericUnaryVT/numericBinaryVT's own optimistic-NUMBER
// default" (named above for `valTypeOfWithLocals`'s narrower copy) turns out
// to ALSO live in the base VT['u-']/VT['~'] entries (kind.js) that this
// present-key test depends on — and those had ONLY ever resolved BIGINT
// correctly for a census operand because Slice 4's VT['[]']/['.']/['()']
// wiring made `valTypeOf(m.get(k))` itself prove BIGINT directly. Reverting
// that wiring regressed BOTH: (1) `-m.get('x')` (assertion 4 below) via
// compile/index.js's `_resultNumeric` boundary-wrap gate wrongly trusting
// the optimistic default and skipping the i64 wrap entirely, and (2)
// `-m.get('x') === -5n` (assertion 5) via emitStrictEq's REF_EQ_KINDS path
// no longer being reached at all. Both fixed the SAME way as emitNeg/`~`'s
// own OR-arm (§13's proactive hardening): `_resultNumeric` now also checks
// `censusBigintSentinelKind(e) === 0`, and VT['u-']/VT['~'] (kind.js) gained
// a `censusMaybeUndefinedKind`-direct OR-arm scoped to exactly the
// single-operand `u-`/`~` shape — VT-independent, so both stay correct with
// Slice 4 dormant. (`_resultNumeric`'s companion `_resultBigintSentinel`
// was already VT-independent per §13 — only `_resultNumeric` itself and
// emitStrictEq's dispatch had the gap.)
test('Map: unary "-"/"~" on a .get() absent key decays to NUMBER NaN/-1, not a garbage bigint (audit-#8 P0-4 Part 3)', () => {
  is(run(`const m = new Map(); m.set('x', 1n); return -m.get('missing')`), NaN)
  is(run(`const m = new Map(); m.set('x', 1n); return ~m.get('missing')`), -1)
  is(typeof run(`const m = new Map(); m.set('x', 1n); return -m.get('missing')`), 'number')
  // present-key: value-materialization FIXED (Slice 5 — was KNOWN-FAIL
  // NaN/0, now the true -5n/-6n); the strict-eq comparisons stay correct
  // (Slice 4 flip: false → true, unaffected by Slice 5).
  is(run(`const m = new Map(); m.set('x', 5n); return -m.get('x')`), -5n)
  is(run(`const m = new Map(); m.set('x', 5n); return -m.get('x') === -5n`), true)
  is(run(`const m = new Map(); m.set('x', 5n); return ~m.get('x')`), -6n)
  is(run(`const m = new Map(); m.set('x', 5n); return ~m.get('x') === ~5n`), true)
})
test('dict: unary "-"/"~" on a DYNAMIC-key absent read decays to NUMBER NaN/-1 (audit-#8 P0-4 Part 3, dict sibling)', () => {
  is(jz(`export let f = (k1, k2) => { const d = {}; d[k1] = 1n; return -d[k2] }`).exports.f('x', 'missing'), NaN)
  is(jz(`export let f = (k1, k2) => { const d = {}; d[k1] = 1n; return ~d[k2] }`).exports.f('x', 'missing'), -1)
  // present-key: same Slice 5 fix as the Map test above.
  is(jz(`export let f = (k1) => { const d = {}; d[k1] = 5n; return -d[k1] }`).exports.f('x'), -5n)
  is(jz(`export let f = (k1) => { const d = {}; d[k1] = 5n; return -d[k1] === -5n }`).exports.f('x'), true)
  is(jz(`export let f = (k1) => { const d = {}; d[k1] = 5n; return ~d[k1] }`).exports.f('x'), -6n)
  is(jz(`export let f = (k1) => { const d = {}; d[k1] = 5n; return ~d[k1] === ~5n }`).exports.f('x'), true)
})
test('dict: unary "-" on a LITERAL-key absent read (already sound — not this bug, structural control)', () => {
  is(run(`const d = {}; d['x'] = 1n; return -d['missing']`), NaN)
})

// Slice 5 (.work/represented-maybe-undefined-design.md §6/§12, presentKindUnboxed)
// repro 5 itself — the bare `m.get()`/`d[k]` read, no unary — closing the class
// this design named the whole audit campaign's last value-wrong family. Was
// KNOWN-FAIL: `m.set('x', 5n); export let f = () => m.get('x')` returned the host
// `2.5e-323` (5n's raw i64 bits misread as an f64 subnormal), not `5n`. Fixed by
// the same `s`-lane export marker the unary tests above exercise (sentinel kind 1:
// UNDEF_NAN → `undefined`, anything else a raw BigInt) — no in-wasm change, the
// bug was purely in which lane/decode the export took.
test('Slice 5: bare Map/dict .get()/[] read materializes the true BigInt across the export boundary (repro 5, was KNOWN-FAIL)', () => {
  const mapMod = jz(`export let f = () => { const m = new Map(); m.set('x', 5n); return m.get('x') }`, { jzify: true })
  is(mapMod.exports.f(), 5n)
  is(typeof mapMod.exports.f(), 'bigint')
  const mapAbsent = jz(`export let f = () => { const m = new Map(); m.set('x', 1n); return m.get('missing') }`, { jzify: true })
  is(mapAbsent.exports.f(), undefined)
  const dictMod = jz(`export let f = (k1) => { const d = {}; d[k1] = 5n; return d[k1] }`, { jzify: true })
  is(dictMod.exports.f('x'), 5n)
  // dict bare-absent: a SEPARATE pre-existing bug closed as a side effect of this
  // slice (found live, not previously pinned anywhere) — `func.valResult` settled
  // to a plain VAL.BIGINT for a dict-sourced census read (dictValueKindOf resolves
  // EARLIER than mapValueKindOf: a whole-program pre-scan half in program-facts.js,
  // vs Map's per-function-only census) WITHOUT its valResultMayBeUndefined
  // companion ever being consulted by the export lane, so it took the plain
  // resultBigint passthrough (raw, unmarked) instead of a sentinel-aware one —
  // wrong for the absent case regardless of any unary wrapping. The Slice 5 fix
  // (computing `_resultBigintSentinel` unconditionally and letting it override a
  // stale `func.valResult` claim, compile/index.js) closes this too.
  const dictAbsent = jz(`export let f = (k1, k2) => { const d = {}; d[k1] = 1n; return d[k2] }`, { jzify: true })
  is(dictAbsent.exports.f('x', 'missing'), undefined)
})

// Negative controls (Slice 5): the sentinel lane must not fire where it shouldn't.
test('Slice 5: negative controls — mixed-kind Map falls back to documented (unfixed) behavior; a statically-proven BigInt export is untouched', () => {
  // A Map whose values are a MIX of BIGINT and NUMBER writes: dictValueKindOf/
  // mapValueKindOf's own census returns null for a mixed receiver (no single exact
  // kind to claim), so censusBigintSentinelKind never fires either — this falls
  // back to the OLD generic resultDynamic lane, whose decode still misreads the
  // BigInt member's raw i64 bits as a subnormal float. Honestly pinned as the
  // documented, unfixed behavior (not silently left to drift) — the NUMBER member
  // is unaffected (it was never carrying a BigInt-shaped bit pattern to begin with).
  const mixed = jz(`export let f = (k) => { const m = new Map(); m.set('a', 5n); m.set('b', 6); return m.get(k) }`, { jzify: true })
  is(mixed.exports.f('a'), 2.5e-323)
  is(mixed.exports.f('b'), 6)
  // A statically-proven BigInt export (no census, no maybe-undefined) keeps taking
  // the ORIGINAL unmarked resultBigint lane, byte-for-byte unaffected by Slice 5 —
  // structural pin against the sentinel lane over-firing on an already-sound case.
  is(jz(`export let f = () => 5n`).exports.f(), 5n)
  is(jz(`export let f = () => -5n`).exports.f(), -5n)
})

// Slice 6 (.work/represented-maybe-undefined-design.md §14/§15, "begin the
// presentVal opt-in model"): a NEW `presentVal` REP field (reps.js) rides
// analyze.js's decl/reassign producer, poison-disciplined like `val` itself
// (NOT a spread-merge boolean like `mayBeUndefined`) — the KIND-carrying
// generalization one hop past a direct census read. First opt-in consumer
// found genuinely LIVE (not just representationally complete): kind.js
// `censusMaybeUndefinedKind`'s bare-name REP-fallback arm, which
// `censusBigintSentinelKind`/Slice 5's export-lane machinery already builds
// on directly — so a DECL-HOP present-key BigInt census read (`let x =
// m.get(k); return x`, one hop past Slice 5's own bare-read repro 5) now
// ALSO crosses the export boundary correctly, without any change to Slice
// 5's own lane/decode mechanism. Was silently wrong (`2.5e-323`, the exact
// repro-5 bit-pattern misread) at HEAD before this slice; confirmed via a
// direct stash diff, not assumed.
test('Slice 6: decl-hop present-key BigInt census read materializes the true BigInt across the export boundary (one hop past repro 5)', () => {
  const bare = jz(`export let f = () => { const m = new Map(); m.set('a', 5n); let x = m.get('a'); return x }`, { jzify: true })
  is(bare.exports.f(), 5n)
  is(typeof bare.exports.f(), 'bigint')
  const absent = jz(`export let f = () => { const m = new Map(); m.set('a', 5n); let x = m.get('missing'); return x }`, { jzify: true })
  is(absent.exports.f(), undefined)   // bare passthrough, no unary — JS: m.get(missing) itself is undefined
  const unaryMinus = jz(`export let f = () => { const m = new Map(); m.set('a', 5n); let x = m.get('a'); return -x }`, { jzify: true })
  is(unaryMinus.exports.f(), -5n)
  const unaryMinusAbsent = jz(`export let f = () => { const m = new Map(); m.set('a', 5n); let x = m.get('missing'); return -x }`, { jzify: true })
  is(unaryMinusAbsent.exports.f(), NaN)   // ES2024 13.5.6 ToNumeric(undefined) — sentinel kind 2
  // dict sibling, same decl-hop shape.
  const dict = jz(`export let f = (k) => { const d = {}; d[k] = 5n; let x = d[k]; return x }`, { jzify: true })
  is(dict.exports.f('k'), 5n)
})

// Negative control (Slice 6): the mixed-kind-Map carve-out (Slice 5's own
// documented, unfixed gap) must stay unfixed through the decl-hop too — the
// census returns null for a mixed receiver regardless of which hop asks.
test('Slice 6: negative control — decl-hop through a mixed-kind Map stays the documented (unfixed) Slice 5 gap', () => {
  const mixed = jz(`export let f = () => { const m = new Map(); m.set('a', 5n); m.set('b', 6); let x = m.get('a'); return x }`, { jzify: true })
  is(mixed.exports.f(), 2.5e-323)
})

// KNOWN-FAIL, PRE-EXISTING, OUT OF SCOPE for Slice 5 (external audit #10,
// 2026-08-04): a present-key census-BIGINT value used in BINARY `+` with a
// NUMBER doesn't throw the TypeError real JS gives for BigInt⊕Number mixing —
// it silently does ordinary f64 addition on the raw i64-as-f64 carrier bits,
// producing a garbage NUMBER. Confirmed unaffected by this slice (byte-for-byte
// identical before/after, verified via a HEAD stash diff) — the bug is entirely
// IN-WASM (bigintMixReject, emit.js: "Enforce it exactly where the mix is
// PROVABLE from source" — a dynamic dict/Map read doesn't count as that kind of
// proof at its own call site), not an export-boundary decode issue, so no lane
// this slice adds or touches could fix it. Audit #10's finding: fixing this
// needs JOINT runtime domain dispatch at the binary-op site (operand-local
// guards like bigintMixReject's are architecturally insufficient), a separate,
// larger design — explicitly not this task's scope. Pinned here (not
// previously pinned anywhere) so a future fix flips it deliberately.
test('KNOWN-FAIL (audit #10, out of scope): present-key census-BIGINT + NUMBER silently corrupts instead of throwing TypeError', () => {
  const r = jz(`export let f = () => { const m = new Map(); m.set('x', 5n); return m.get('x') + 1 }`, { jzify: true }).exports.f()
  // JS: throws TypeError. Actual (wrong): silent NUMBER garbage.
  is(typeof r, 'number')
})

// AUDIT #10 BATTERY (represented-maybe-undefined-design.md §14): the full
// repro set the audit named as live consequences of Slice 4's global VT
// promotion — composed expressions, container storage, kind-specific
// dispatch, String `+` inversion, BigInt joint dispatch. Re-verified
// differentially against real JS with the census dormant (this revert):
// every row the audit named as broken by VT promotion is JS-correct again
// via the generic dynamic path — no new mechanism, the same "disable costs
// nothing, the generic path already handles it" finding every prior slice
// disable also confirmed. Every container is PRIMED with a same-kind write
// before the absent-key read (an empty census has no claim to promote in
// the first place, VT wired or not — priming is what actually exercises the
// bug class).
test('audit #10: composed expressions (ternary/&&/||/comma) around an absent census-NUMBER read are JS-correct with the census dormant', () => {
  const ternary = jz(`export let f = () => { const m = new Map(); m.set('present', 1); return (true ? m.get('missing') : 999) + 1 }`, { jzify: true }).exports.f
  is(ternary(), NaN, 'JS: (true ? undefined : 999) + 1 = NaN')
  const and = jz(`export let f = () => { const m = new Map(); m.set('present', 1); return (true && m.get('missing')) + 1 }`, { jzify: true }).exports.f
  is(and(), NaN, 'JS: (true && undefined) + 1 = NaN')
  const or = jz(`export let f = () => { const m = new Map(); m.set('present', 1); return (false || m.get('missing')) + 1 }`, { jzify: true }).exports.f
  is(or(), NaN, 'JS: (false || undefined) + 1 = NaN')
  const comma = jz(`export let f = () => { const m = new Map(); m.set('present', 1); let y = 0; return ((y = 1), m.get('missing')) + 1 }`, { jzify: true }).exports.f
  is(comma(), NaN, 'JS: (y=1, undefined) + 1 = NaN')
})
test('audit #10: container storage (array-literal index, object-literal prop) around an absent census read is JS-correct with the census dormant', () => {
  const arrIdx = jz(`export let f = () => { const m = new Map(); m.set('present', 1); return [m.get('missing'), 1][0] + 1 }`, { jzify: true }).exports.f
  is(arrIdx(), NaN, 'JS: [undefined, 1][0] + 1 = NaN')
  const objProp = jz(`export let f = () => { const m = new Map(); m.set('present', 1); return ({ x: m.get('missing') }).x + 1 }`, { jzify: true }).exports.f
  is(objProp(), NaN, 'JS: ({x: undefined}).x + 1 = NaN')
  const arrIdxStr = jz(`export let f = () => { const m = new Map(); m.set('present', 's'); return String([m.get('missing'), 1][0]) }`, { jzify: true }).exports.f
  is(arrIdxStr(), 'undefined')
  const objPropStr = jz(`export let f = () => { const m = new Map(); m.set('present', 's'); return String(({ x: m.get('missing') }).x) }`, { jzify: true }).exports.f
  is(objPropStr(), 'undefined')
})
test('audit #10: Array.isArray on an absent ARRAY-census read is JS-correct with the census dormant (was: TRUE)', () => {
  const f = jz(`export let f = () => { const m = new Map(); m.set('present', [1, 2]); return Array.isArray(m.get('missing')) }`, { jzify: true }).exports.f
  is(f(), false, 'JS: Array.isArray(undefined) = false — the audit-#10-live TRUE misfire is gone with the census dormant')
})
// KNOWN-FAIL, PRE-EXISTING, NOT this task's scope (audit #10 names it, future
// work — "isArray/length-trap→TypeError" per the task's own framing): a
// kind-specific member access on a genuinely-undefined value (real JS throws
// TypeError) instead traps (wasm bounds/table trap) or, for a HOST-dispatched
// method (String.prototype.slice/Number.prototype.toFixed), throws jz's own
// internal dispatch Error — never the real TypeError. Independent of census
// on/off (the generic dynamic path has never distinguished "genuinely
// undefined" from "OOB/absent" at the member-access site either) — pinned as
// the CURRENT actual behavior with the census dormant, not "fixed", so a
// future TypeError-conformance fix flips these deliberately.
test('KNOWN-FAIL (audit #10, future work): kind-specific member access on a genuinely-undefined census read traps/dispatch-errors instead of throwing TypeError', () => {
  // Wasm traps (a table-index or memory-access trap) are HOST-level
  // exceptions — jz's own in-source try/catch cannot intercept them (they
  // never reach jz's JS-error machinery at all), so those two cases must be
  // caught OUTSIDE exports.f(), matching how they'd actually surface to a
  // real host caller today.
  const arrLen = jz(`export let f = () => { const m = new Map(); m.set('present', [1, 2]); try { return m.get('missing').length } catch (e) { return 'THROW:' + e.constructor.name } }`, { jzify: true }).exports.f
  is(arrLen(), undefined, 'JS: TypeError. Actual: reads OOB as undefined, no trap')
  const call = jz(`export let f = () => { const m = new Map(); m.set('present', () => 1); return m.get('missing')() }`, { jzify: true }).exports.f
  let callErr = null; try { call() } catch (e) { callErr = e }
  ok(callErr && /table index/.test(callErr.message), 'JS: TypeError. Actual: wasm table-index trap, uncatchable in-source')
  const strLen = jz(`export let f = () => { const m = new Map(); m.set('present', 'hi'); try { return m.get('missing').length } catch (e) { return 'THROW:' + e.constructor.name } }`, { jzify: true }).exports.f
  is(strLen(), undefined, 'JS: TypeError. Actual: reads OOB as undefined, no trap')
  const strSlice = jz(`export let f = () => { const m = new Map(); m.set('present', 'hi'); return m.get('missing').slice() }`, { jzify: true }).exports.f
  let sliceErr = null; try { strSlice() } catch (e) { sliceErr = e }
  ok(sliceErr && /memory access/.test(sliceErr.message), 'JS: TypeError. Actual: wasm memory-access trap, uncatchable in-source')
  const numFixed = jz(`export let f = () => { const m = new Map(); m.set('present', 1); return m.get('missing').toFixed(2) }`, { jzify: true }).exports.f
  let fixedErr = null; try { numFixed() } catch (e) { fixedErr = e }
  ok(fixedErr instanceof Error && /dispatched this/.test(fixedErr.message),
    "JS: TypeError. Actual: jz's own host-dispatch Error thrown from the JS-side interop shim, uncatchable in-source (not a wasm exception at all)")
})
test('audit #10: String `+` inversion — a STRING-census absent read through `+` is JS-correct with the census dormant (was: static concat "undefined1")', () => {
  const present = jz(`export let f = () => { const m = new Map(); m.set('a', 'x'); return m.get('a') + 1 }`, { jzify: true }).exports.f
  is(present(), 'x1', 'present-key STRING `+` NUMBER still concatenates (unaffected — a real STRING value, not a maybeUndefined coercion)')
  const absent = jz(`export let f = () => { const m = new Map(); m.set('a', 'x'); return m.get('missing') + 1 }`, { jzify: true }).exports.f
  is(absent(), NaN, 'JS: undefined + 1 = NaN, not "undefined1" — the audit-#10-live STATIC-concat-branch misfire is gone with the census dormant')
})
// FIXED (audit-#10 Error-bundle finding-1, 2026-08-04): was a compile-time
// CRASH (module/object.js:535's Object.assign, `internal: stdlib
// '__arr_set_idx_ptr' was requested but never registered`) — a literal `new
// TypeError('x')` used directly as Object.assign's TARGET (never bound to a
// name first) fell through `resolveSchema` unrecognized, routing into
// `emitObjectAssignDynamic`'s dynamic path, which never pulls the `array`
// module its own `__dyn_set` dependency needs. Root-fixed by teaching
// `resolveSchema` (module/object.js) the same literal `new X(...)`/`X(...)`
// Error-constructor-call shape `isErrorSchemaSource` already recognized for
// SOURCE position, now for TARGET position too (and mirrored into
// src/kind.js's `spreadSchema`, kept in sync per its own "must agree with
// resolveSchema" contract) — the schema becomes KNOWN, so Object.assign takes
// its ordinary fixed-schema fast path (mutates the target's own slots in
// place, returns the SAME pointer — Object.assign's real JS semantics: return
// the target, not a new object), never reaching the broken dynamic path at
// all. Object.assign returning the identical pointer it was given also
// preserves the Error's schema id (class identity), closing the provenance
// loss the crash was masking.
test('Object.assign onto a literal (unbound) Error instance mutates it in place, preserving instanceof (was KNOWN-FAIL, audit #10)', () => {
  const f = jz(`export let main = () => { const e = Object.assign(new TypeError('x'), {message: 'y'}); return e instanceof TypeError }`, { jzify: true }).exports.main
  is(f(), true, 'JS: true — Object.assign returns its target unchanged in class/identity')
  const g = jz(`export let main = () => Object.assign(new TypeError('x'), {message: 'y'}).message`, { jzify: true }).exports.main
  is(g(), 'y', 'the message slot was actually overwritten')
})

// Slice 3 (.work/represented-maybe-undefined-design.md §4/§8 point 3): the
// chokepoint-sweep completion — bigintMixReject (emit.js, the compile-time
// BigInt/Number literal-mix TypeError check) and the `+` STRING-concat raw
// fast path now also consult censusMaybeUndefined (the SAME predicate every
// other chokepoint in this file already asks), the two gaps the design names
// as NEVER covered by the original chokepoint list. HONEST BOUNDARY (mirrors
// Slices 1/2's own §9/§10 finding, verified this session by direct trace):
// neither gap is reachable by ANY live compile today. `bigintMixReject`
// needs `valTypeOf(a) === VAL.BIGINT` to even ask the census question, but
// VT['()']'s own `.get()` dispatch (kind.js, ~line 730 "NO `.get` short-
// circuit here") never promotes a Map/dict read to an exact kind — so
// `valTypeOf` on a census-shaped node (direct or via a mayBeUndefined-
// flagged bare name, whose `val` Slice 1/2 confirmed never settles either)
// stays null, and `aBig`/`bBig` are false regardless of this fix. Same root
// cause blocks the `+` STRING-concat gate. Both fixes are representationally
// correct and become load-bearing the moment Slice 4 (VT re-enablement, §5)
// lands — pinned here as negative controls (genuine BigInt-mix / genuine
// STRING-concat behavior unchanged) so a regression in EITHER surfaces now,
// not silently at Slice 4.
test('Slice 3: bigintMixReject / `+` STRING-concat — negative controls (fix is representationally live, behaviorally inert pre-Slice-4)', () => {
  // genuine BigInt/Number literal mix still throws (bigintMixReject unaffected
  // for a PROVEN, non-census BIGINT operand — the new guard only excuses a
  // maybeUndefined-flagged claim, never a real one).
  let threw = false
  try { run(`return 1n + 1`) } catch (e) { threw = true }
  is(threw, true)
  // genuine BigInt + BigInt still adds normally (no false-positive reject).
  is(run(`return 1n + 2n`), 3n)
  // genuine proven-STRING + STRING concat still takes the raw fast path (no
  // spurious __to_str detour for an ordinary, non-census string operand).
  is(run(`const s = 'a'; const t = 'b'; return s + t`), 'ab')
  is(run(`let s = 'x'; s += 'y'; return s`), 'xy')
})

// Slice 3 acceptance repro table (task's audit-#9-table hop shapes) for a
// NON-'+' arithmetic operator: decl-hop / param-hop / capture-hop all
// ALREADY return JS-correct values at HEAD, independent of Slice 3's own
// two fixes above (neither touches '-') — the census being fully dormant
// (audit-#9 P0-1) means every hop already takes the generic dynamic path,
// which correctly ToNumber-coerces `undefined` to NaN with no static kind
// claim to falsify. Pinned here as a REGRESSION GUARD at this exact hop
// shape (decl/param/capture), not a red→green flip — verified red→green
// only means something once VT re-enables (Slice 4) and an exact kind
// claim starts riding these same hops.
test('Slice 3: decl/param/capture-hop arithmetic already JS-correct (regression pin, not a Slice-3 flip)', () => {
  const declMinus = jz(`export let f = (k) => { const m = new Map(); m.set('a', 1); let x = m.get(k); return x - 1 }`, { jzify: true }).exports.f
  is(declMinus('missing'), NaN)
  is(declMinus('a'), 0)
  const paramMinus = jz(`
    const g = (v) => v - 1
    export let f = (k) => { const m = new Map(); m.set('a', 1); return g(m.get(k)) }
  `, { jzify: true }).exports.f
  is(paramMinus('missing'), NaN)
  is(paramMinus('a'), 0)
  const captureMinus = jz(`export let f = (k) => { const m = new Map(); m.set('a', 1); let x = m.get(k); const h = () => x - 1; return h() }`, { jzify: true }).exports.f
  is(captureMinus('missing'), NaN)
  is(captureMinus('a'), 0)
})

// FIXED (audit, 2026-08): was KNOWN-FAIL — `const g = (v) => v + 1` called with a
// Map absent-key argument through a SEPARATE (non-inlined) function returned
// `undefined` instead of `NaN`. Root-caused past the earlier trace (`optimize:false`
// vs default byte-for-byte diff showed emit.js's `+` handler correctly emitting the
// SAFE runtime-dispatch form — `__is_str_key` guard + the NaN self-compare atom
// ladder — and the POST-optimize module having it collapsed to a bare `f64.add`):
// the eliminating pass is `foldStrDispatchF64` (src/optimize/index.js), gated on
// `vectorizeLaneLocal` (default-on at level 2+, so it fired even with `watr:false`
// — confirmed NOT a watr-package bug via per-pass bisection over every PASS_NAMES
// entry against `{level:2, watr:false}`). Its "proof" that a `(param $v f64)` can
// never carry a string/atom NaN-box is FALSE under jz's NaN-boxing ABI — every
// dynamically-typed value (string, undefined, null, a bool atom, a boxed object)
// is carried in an f64-typed local exactly like a genuine number, so a bare
// declared-f64 param proves nothing about its runtime domain. The fold's actual
// intended and ONLY sound use is `pureFuncMap`-driven inline substitution into a
// per-pixel-color SIMD lane loop (tryPerPixelColor, src/optimize/vectorize.js),
// where the substituted argument IS independently proven numeric (a per-lane
// typed-array read) — but it ran on (and mutated in place) the real, standalone,
// module-emitted function body too, both via `buildPureFuncMap` (src/wat/
// assemble.js) building `pureFuncMap` by folding `funcs` entries directly, and via
// a second, redundant direct call inside `optimizeFunc` before `vectorizeLaneLocal`.
// FIX: `buildPureFuncMap` now folds a deep CLONE per candidate (the clone alone
// populates `pureFuncMap`, used only by the lane-proven inline path); the second
// direct call inside `optimizeFunc` is removed outright (no lane-proven substitution
// context exists there — it was folding the callee's own declaration, the same
// unsound premise). Sibling shapes verified same-fix (see next test): dict absent-
// key param-hop, double param-hop, an in-loop param-hop, and an out-of-bounds array
// read all through the identical `(v) => v + 1`-shaped single-call-site guard.
test('single-call-site "+" param-hop: absent Map key through a separate callee is JS-correct (regression pin, was KNOWN-FAIL)', () => {
  const paramPlus = jz(`
    const g = (v) => v + 1
    export let f = (k) => { const m = new Map(); m.set('a', 1); return g(m.get(k)) }
  `, { jzify: true }).exports.f
  is(paramPlus('missing'), NaN)   // JS: undefined + 1 === NaN
  is(paramPlus('a'), 2)           // present-key stays correct
})

// Sibling sweep for the SAME foldStrDispatchF64/pureFuncMap fix (audit, 2026-08):
// every carrier-domain producer feeding the identical single-call-site "+"
// param-hop guard shape, not just Map.get. All were unsound before the fix
// (foldStrDispatchF64 mutated the real function regardless of producer) and are
// JS-correct after it (regression pins).
test('single-call-site "+" param-hop: sibling carrier-domain producers (regression pins)', () => {
  // dict (not Map) absent key
  is(jz(`
    const g = (v) => v + 1
    export let f = (k) => { const d = {}; d['a'] = 1; return g(d[k]) }
  `, { jzify: true }).exports.f('missing'), NaN)
  // two-hop param chain (g -> h, both single-call-site)
  is(jz(`
    const h = (v) => v + 1
    const g = (v) => h(v)
    export let f = (k) => { const m = new Map(); m.set('a', 1); return g(m.get(k)) }
  `, { jzify: true }).exports.f('missing'), NaN)
  // param used inside the callee's OWN loop, not just a leaf expression
  is(jz(`
    const g = (v) => { let s = 0; for (let i = 0; i < 3; i++) { s = s + v }; return s }
    export let f = (k) => { const m = new Map(); m.set('a', 1); return g(m.get(k)) }
  `, { jzify: true }).exports.f('missing'), NaN)
  // out-of-bounds array read
  is(jz(`
    const g = (v) => v + 1
    export let f = (k) => { const a = [1, 2, 3]; return g(a[k]) }
  `, { jzify: true }).exports.f(10), NaN)
})

// Slice 4 (represented-maybe-undefined-design.md §8, VT re-enablement) —
// dictValueKindOf/mapValueKindOf wired back into VT['[]']/VT['.']/VT['()'].
// §5 criterion 1's own acceptance shape: a census claim reaching a
// NON-chokepoint consumer through 2+ hops (decl → arg → return → use), not
// just the single-hop repros earlier slices pinned.
//
// REVERTED (audit #10, §14 — the four "Slice 4" pins below): VT['[]']/
// ['.']/['()']'s exact-kind promotion is dormant again, same reason as this
// file's audit-#9-era "RENAMED"/"RE-RENAMED" pins above. Kept exactly as
// written and STILL GREEN — every assertion here is a JS-VALUE correctness
// pin, not a WAT-codegen-shape pin, and the generic dynamic dispatch path
// (the only path live once the census stops claiming an exact kind) already
// produces the correct value for all four shapes — the audit's own finding,
// re-confirmed: "the generic dynamic paths handle it, that's been true at
// every prior disable."
test('Slice 4: multi-hop (decl -> call-arg -> return -> use) arithmetic stays JS-correct', () => {
  const f = jz(`
    const inner = (v) => v
    const relay = (v) => inner(v)
    export let f = (k) => {
      const m = new Map(); m.set('a', 1)
      let x = m.get(k)
      let y = relay(x)
      return y + 1
    }
  `, { jzify: true }).exports.f
  is(f('missing'), NaN)
  is(f('a'), 2)
})

// Slice 4 IDENTITY-fold acceptance, live for the first time (Slices 1-3 were
// representationally complete but inert here per their own honest-boundary
// notes — `val` never settled non-null at any hop while VT stayed dormant).
// Decl/param/capture-hop `=== undefined` on a bare name that traces to a
// census read.
test('Slice 4: decl/param/capture-hop identity compare (`=== undefined`) on a census-traced bare name', () => {
  const decl = jz(`export let f = (k) => { const m = new Map(); m.set('a', 1); let x = m.get(k); return x === undefined ? 1 : 0 }`, { jzify: true }).exports.f
  is(decl('missing'), 1)
  is(decl('a'), 0)
  const param = jz(`
    const g = (v) => v === undefined ? 1 : 0
    export let f = (k) => { const m = new Map(); m.set('a', 1); return g(m.get(k)) }
  `, { jzify: true }).exports.f
  is(param('missing'), 1)
  is(param('a'), 0)
  const capture = jz(`export let f = (k) => { const m = new Map(); m.set('a', 1); let x = m.get(k); const h = () => x === undefined ? 1 : 0; return h() }`, { jzify: true }).exports.f
  is(capture('missing'), 1)
  is(capture('a'), 0)
})

// Slice 4 gap found LIVE while walking §5 criterion 3's chokepoint-composition
// check (kind.js `callResultMayBeUndefinedKind`, new): a call to a
// non-inlined user function whose whole-program return-kind fixpoint
// (narrow.js narrowValResults, Slice 2) settled BOTH a definite `valResult`
// kind AND `valResultMayBeUndefined` is a census fact one call-hop removed.
// Before this fix, `g(k) === undefined` constant-folded to the SAME wrong
// boolean for a present AND an absent key (kind-traits.js calleeValType
// returns `f.valResult` with no accompanying mayBeUndefined signal, and
// nothing consulted `valResultMayBeUndefined` — it existed only for
// ctx.inspect, per reps.js's own doc comment). `g` must NOT be a
// single-expression arrow here — those inline before this check ever runs,
// which is exactly why this class survived the multi-hop test above
// unnoticed (relay/inner there both got inlined into a direct `.get()` node).
test('Slice 4: call-result identity compare (`g(k) === undefined`) through a non-inlined callee (regression pin, found live)', () => {
  const f = jz(`
    const m = new Map(); m.set('a', 1)
    const g = (k) => { let s = 0; for (let i = 0; i < 1; i++) s = s + i; return m.get(k) }
    export let f = (k) => g(k) === undefined ? 1 : 0
  `, { jzify: true }).exports.f
  is(f('missing'), 1)
  is(f('a'), 0)
})

// Slice 4 gap #2, found live continuing the SAME investigation: the
// ARITHMETIC sibling of the identity-fold gap above. `g(k) + 1` through a
// non-inlined callee whose result may be undefined silently returned JS
// `undefined` instead of `NaN` (ir.js toNumF64's `vt === VAL.NUMBER &&
// censusMaybeUndefined(node)` gate, :999-1012 — calleeValType already
// trusted `f.valResult` unconditionally; the fix above made
// censusMaybeUndefined see the call-result claim, but toNumF64's own
// `coerceNullishToNum` wrapper wasn't reachable through it yet either).
test('Slice 4: call-result arithmetic (`g(k) + 1`) through a non-inlined callee is JS-correct (regression pin, found live)', () => {
  const f = jz(`
    const m = new Map(); m.set('a', 1)
    const g = (k) => { let s = 0; for (let i = 0; i < 1; i++) s = s + i; return m.get(k) }
    export let f = (k) => g(k) + 1
  `, { jzify: true }).exports.f
  is(f('missing'), NaN)
  is(f('a'), 2)
})

// Slice 4 SOUNDNESS regression found and fixed while landing the two pins
// above: `coerceNullishToNum` (ir.js) is documented as requiring its input
// be side-effect-free — true for the ORIGINAL dict/Map-read and bare-name
// census arms (a pure read), but the NEW call-result arm can carry a
// genuinely side-effecting call (a captured-mutation counter, here). Before
// the fix (hoist into a temp before coerceNullishToNum's triplicating
// cloneIR, ir.js toNumF64), `g(k) + 1` where `g` mutates a captured local as
// a side effect ran `g` THREE TIMES instead of once — count/total-calls came
// out at 3x the correct value. This is the exact `audit-#8 P0-2`/e79b0647
// captured-mutation class, one call-hop further out.
test('Slice 4: call-result arithmetic does not triplicate a captured-mutation side effect (soundness regression pin)', () => {
  const f = jz(`
    export const main = (k) => {
      let count = 0
      const xs = [1, 2, 3, 4, 5]
      const at = (i) => { count = count + 1; return xs[i] }
      let s = 0
      for (let i = 0; i < xs.length; i++) s += at(i)
      return s * 1000 + count
    }
  `, { jzify: true }).exports.main
  is(f(0), 15005, 's=15 (sum of xs), count=5 (one increment per call) — not 15015 (count tripled)')
})

// Slice 7 (.work/represented-maybe-undefined-design.md §14/§15, "widen the
// opt-in consumer chokepoints"): the arithmetic/coercion chokepoints
// (ir.js toNumF64, emit.js's binary `+` BigInt dispatch) gated on
// `valTypeOf(node)` FIRST and never saw a decl/direct census claim (`vt`
// stays permanently null for this shape, §14 point 3) — widened to also
// consult `censusMaybeUndefinedKind`/`presentVal` directly, the SAME
// discipline `nullableOperand`/`bigIntOperand`/`bigIntUnary` already had
// (found, while landing this slice, to NOT need widening — they already
// call the census predicate unconditionally, never gated on `vt` first).
//
// Real, live value-correctness win, found and verified (not assumed): a
// binary `+` between two decl-hop present-key BigInt census reads — NEITHER
// side separately provable (no literal, no unary wrapper) — fell through to
// the generic dynamic-NUMBER `+` dispatch, which did `f64.add` on the raw
// i64-reinterpreted-as-f64 BigInt carrier bits (nonsense float arithmetic on
// two tiny subnormals) AND, even had the i64 arithmetic itself been correct,
// the export-boundary decode (compile/index.js `_resultNumeric`/
// `_resultBigintSentinel`) had no way to know this `+` node's result was
// really a BigInt (VT['+']'s own "unknown operand → optimistic NUMBER"
// default). Both fixed together: emit.js's `bothBigIntOperands` (an AND, not
// an OR — see its own doc comment for why an OR would silently corrupt a
// BigInt-census-operand-paired-with-a-real-NUMBER mix, the exact §14 point 4
// out-of-scope class) routes the WASM computation through the correct i64
// `bigIntOperand`/`bigIntMixReject` machinery; VT['+']'s own both-census
// upgrade plus `censusBigintSentinelKind`'s new kind-4 arm (kind.js) teach
// the SAME both-census fact to the export lane, so the return crosses the
// boundary as a real i64 BigInt, not a misdecoded NUMBER.
test('Slice 7: decl-hop binary `+` between two present-key BigInt census reads crosses the export boundary correctly (was garbage NUMBER)', () => {
  const present = jz(`export let f = () => { const m = new Map(); m.set('a', 5n); m.set('b', 3n); let x = m.get('a'); let y = m.get('b'); return x + y }`, { jzify: true }).exports.f
  is(present(), 8n)
  is(typeof present(), 'bigint')
  // dict sibling, same decl-hop shape (dynamic key on both sides, matching
  // the Slice 6 dict test's own precedent — a STATIC string-literal key
  // read, e.g. `d['a']`, does not take the census/dict-mode dynamic-get path
  // at all, a pre-existing, unrelated distinction, not this test's concern).
  const dict = jz(`export let f = (k, j) => { const d = {}; d[k] = 5n; d[j] = 3n; let x = d[k]; let y = d[j]; return x + y }`, { jzify: true }).exports.f
  is(dict('a', 'b'), 8n)
  // one side absent — real JS: ToNumeric(undefined) is the Number NaN, and
  // the OTHER side is a genuine BigInt, so the mix throws TypeError; jz's own
  // bigIntOperand runtime guard already implements exactly this (audit-#8
  // P0-3), now reachable through this widened entry gate too.
  let threw = false
  try { jz(`export let f = () => { const m = new Map(); m.set('a', 5n); let x = m.get('a'); let y = m.get('missing'); return x + y }`, { jzify: true }).exports.f() }
  catch (e) { threw = /BigInt/.test(e.message) }
  ok(threw, 'JS: TypeError (Number NaN from the absent side mixed with a real BigInt)')
})

// Negative controls (Slice 7): a single census-BigInt operand paired with a
// PROVEN (non-census) side must keep taking its EXISTING path unchanged —
// this already worked before this slice (the proven side alone satisfied the
// old `valTypeOf(a)===BIGINT||valTypeOf(b)===BIGINT` gate) and must not
// regress. A genuine literal BigInt/Number mix must still compile-error.
test('Slice 7: negative controls — single-proven-side BigInt mixes and genuine literal mixes are unaffected', () => {
  const singleSide = jz(`export let f = () => { const m = new Map(); m.set('a', 5n); let x = m.get('a'); return x + 3n }`, { jzify: true }).exports.f
  is(singleSide(), 8n)
  let threw = false
  try { jz('export let f = () => { return 1n + 1 }', { jzify: true }) } catch (e) { threw = true }
  ok(threw, 'genuine BigInt/Number literal mix still throws at compile time')
  is(jz('export let f = () => { return 1n + 2n }', { jzify: true }).exports.f(), 3n, 'genuine BigInt+BigInt (no census involved) unaffected')
})

// GENERAL valTypeOfWithLocals gap CLOSED (round-7, follow-up to Slice 7/
// 38dd0dca): that entry pinned two DISTINCT sub-shapes together under one
// "pre-existing, general valTypeOfWithLocals gap" umbrella. Splitting them
// here, now that the root cause is actually understood:
//
//   (a) a LOCALLY-provable BigInt (`let x = BigInt(v)`, or any other decl
//       `analyzeBody` can settle a `valTypes` fact for) flowing through `-`/
//       `*`/`/`/`%`/the bitwise family — genuinely the `valTypeOfWithLocals`
//       gap the old comment named: its SOUND `+` arm computed `a`/`b` via
//       `rec` (the local resolver) but then DISCARDED them, falling through
//       to a blind `valTypeOf(expr)` re-derivation that can only see MODULE-
//       global facts, never a plain local — so a local proven BIGINT through
//       `rec` still locked in a WRONG `func.valResult`/`_resultNumeric`
//       NUMBER claim. Confirmed live even for `+` itself (contradicting the
//       old comment's premise that `+` was already immune — it wasn't; `rec`
//       and the final derivation just happened to agree whenever the operand
//       ALSO existed as a global). Fixed: every arm computes its result
//       DIRECTLY from `rec`'s own `a`/`b`, never re-derives blindly. See the
//       "FIXED" test below.
//   (b) a CENSUS-provable BigInt (`m.get(k)`, no `presentVal`/`valTypes` fact
//       — that machinery is a totally separate fact system `resolveLocal`
//       never consults) and a fully-opaque, zero-evidence PARAM (a plain
//       `export let f = (a, b) => a - b` called directly from the JS host,
//       no in-source call site or decl to prove anything). NEITHER is a
//       `valTypeOfWithLocals` gap — (a)'s fix doesn't and can't touch them:
//       (b-census) still needs its OWN `bothBigIntOperands`/VT-census-upgrade
//       widening per op (Slice 7's own deliberately-scoped-out "next slice",
//       unattempted here — a census fact and a locally-resolved fact are
//       different inputs to the SAME function, not the same gap); (b-param)
//       is architecturally out of reach of ANY static-proof mechanism — an
//       unboxed dynamic export param crossing the JS↔wasm boundary has no
//       runtime tag distinguishing "raw BigInt carrier" from "a genuinely
//       tiny subnormal float the program computed" (interop.js's own `bits`/
//       `i64ToF64` doc comments), so disambiguating it needs NEW boxing
//       infrastructure at the boundary (§6's presentKindUnboxed/bigintBoxed
//       producer gap), not a kind.js derivation fix. Both remain pinned,
//       unchanged, below — for their own, now-precise reasons.
test('KNOWN-FAIL (unchanged by the round-7 general fix, for two SEPARATE, still out-of-scope reasons): census-BigInt reads and zero-evidence dynamic params still misdecode', () => {
  const two = (op) => jz(`export let f = () => { const m = new Map(); m.set('a', 5n); m.set('b', 3n); let x = m.get('a'); let y = m.get('b'); return x ${op} y }`, { jzify: true }).exports.f()
  is(typeof two('-'), 'number', 'JS: 2n (bigint) — census-BigInt sub-case, its own separate Slice-7-scoped-out widening, not this fix')
  is(typeof two('*'), 'number')
  is(typeof two('/'), 'number')
  is(typeof two('%'), 'number')
  is(typeof two('&'), 'number')
  // A plain, zero-evidence exported param pair — architecturally out of reach
  // of any static proof (see the block comment above); confirms this is a
  // DIFFERENT gap from (a), not just an unfixed leftover of it.
  const plainSub = jz('export let f = (a, b) => a - b', { jzify: true }).exports.f
  is(typeof plainSub(5n, 3n), 'number', 'JS: 2n — a real, zero-evidence dynamic-param BigInt pair through `-`, architecturally unprovable, not a valTypeOfWithLocals gap')
})

// FIXED (round-7): `valTypeOfWithLocals`'s binary arms (kind.js) now settle
// BIGINT-vs-NUMBER directly from `rec`'s own locally-resolved operand kinds
// — for `+` (previously silently wrong for this exact shape despite the
// "SOUND +" framing, see above) and its `-`/`*`/`/`/`%`/`&`/`|`/`^`/`<<`/`>>`
// siblings (previously had no local-aware handling AT ALL, falling straight
// to the file-ending `valTypeOf(expr)` catch-all). `BigInt(v)` is a
// compile-time-KNOWN-BIGINT-returning callee (kind-traits.js CALLEE_VAL) —
// analyzeBody's decl-time `valTypes` tracker already recorded `x`/`y` as
// BIGINT; only the WITHOUT-locals re-derivation the export-lane decision
// depended on was blind to it.
// Native BigInt operator functions (no `eval` — this repo's own errors.js
// pins `eval` as a prohibited construct in COMPILED source; using it here to
// compute an expected value in the TEST HARNESS is a different concern, but
// explicit functions keep the oracle unambiguous either way).
const BIGINT_OP = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b,
  '/': (a, b) => a / b, '%': (a, b) => a % b,
  '&': (a, b) => a & b, '|': (a, b) => a | b, '^': (a, b) => a ^ b,
  '<<': (a, b) => a << b, '>>': (a, b) => a >> b,
}

test('round-7: local BigInt() decls through every binary arithmetic/bitwise op cross the export boundary correctly', () => {
  const ops = ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']
  const two = (op, v, w) => jz(`export let f = (v, w) => { let x = BigInt(v); let y = BigInt(w); return x ${op} y }`,
    { jzify: true }).exports.f(v, w)
  for (const op of ops) {
    const got = two(op, 6, 3)
    const want = BIGINT_OP[op](6n, 3n)
    is(got, want, `${op}: 6n ${op} 3n`)
    is(typeof got, 'bigint', `${op}: result is a real bigint`)
  }
  // Negative operands (sign-sensitive: division truncation, arithmetic right
  // shift, two's-complement bitwise) — the class the plain small-positive
  // pins above can't distinguish from a lucky subnormal-arithmetic coincidence.
  for (const op of ops) is(two(op, -7, 2), BIGINT_OP[op](-7n, 2n), `${op}: negative operand`)
  // `/` truncates TOWARD ZERO per BigInt division (ES2024 6.1.6.2.4), not
  // floor — the class that would silently disagree with Math.floor semantics.
  is(two('/', -7, 2), -3n, 'BigInt / truncates toward zero: -7n/2n === -3n, not -4n (floor)')
  is(two('/', 7, -2), -3n, 'BigInt / truncates toward zero: 7n/-2n === -3n, not -4n')
})

// round-7: `<<`/`>>` NEGATIVE shift amount — ES2024 13.2.9/13.2.10
// BigInt::leftShift/rightShift flip DIRECTION on a negative shift count
// (`x << -3n` === `x >> 3n`, exactly), unlike Number `<<`/`>>` (ToInt32 & 31,
// no direction flip) or WASM's native i64.shl/i64.shr_s (shift count mod 64,
// also no sign awareness — a naive port silently wraps `-3` to a 61-bit
// wrong-direction shift). Found live sweeping this fix's own acceptance
// criteria, fixed via bigIntShiftIR (emit.js) alongside the arms above.
test('round-7: BigInt `<<`/`>>` flips direction on a negative shift amount (JS spec 13.2.9/13.2.10)', () => {
  const shift = (op, v, w) => jz(`export let f = (v, w) => { let x = BigInt(v); let y = BigInt(w); return x ${op} y }`,
    { jzify: true }).exports.f(v, w)
  is(shift('<<', 6, -3), 6n << -3n); is(shift('<<', 6, -3), 0n)
  is(shift('>>', 6, -3), 6n >> -3n); is(shift('>>', 6, -3), 48n)
  is(shift('<<', -6, -3), -6n << -3n); is(shift('<<', -6, -3), -1n)
  is(shift('>>', -6, -3), -6n >> -3n); is(shift('>>', -6, -3), -48n)
  // `<<=`/`>>=` compound-assign shares the identical binary-op fix (emit.js).
  const compound = (op, v, w) => jz(`export let f = (v, w) => { let x = BigInt(v); x ${op} BigInt(w); return x }`,
    { jzify: true }).exports.f(v, w)
  is(compound('<<=', 6, -3), 0n); is(compound('>>=', 6, -3), 48n)
})

// round-7: comparisons (`<` `>` `<=` `>=`) over locally-proven-BigInt operands
// — verified, not assumed, per this fix's own sweep discipline. Already
// correct at HEAD (VT.bool/CMP_OPS ignore operand kind entirely — always
// VAL.BOOL — so there was never a static-claim gap here); pinned so a future
// change can't regress it silently.
test('round-7: comparisons over local BigInt() decls are (and stay) JS-correct', () => {
  const cmp = (op, v, w) => jz(`export let f = (v, w) => { let x = BigInt(v); let y = BigInt(w); return x ${op} y }`,
    { jzify: true }).exports.f(v, w)
  const CMP_OP = { '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b }
  for (const [op, v, w] of [['<', 5, 2], ['<', 2, 5], ['<', 5, 5], ['>', -5, 2], ['<=', 5, 5], ['>=', -5, -2]])
    is(cmp(op, v, w), CMP_OP[op](BigInt(v), BigInt(w)), `${op} ${v} ${w}`)
})

// round-7 KNOWN-FAIL, found live while sweeping this fix's own acceptance
// criteria, NOT this fix's scope: real JS throws TypeError mixing BigInt and
// Number in arithmetic (ES2024 6.1.6.2.20 step 6, "Type(lnum) is not
// Type(rnum)") — `bigintMixReject` (emit.js) already implements this
// correctly at COMPILE TIME for a provable mix (one side a genuine BigInt,
// the other a numeric LITERAL — see the negative-controls test above), but
// has no RUNTIME check at all for a proven-BigInt side paired with a
// genuinely dynamic (zero-evidence) other operand — exactly audit-#10's own
// named, out-of-scope "operand-local guards are architecturally
// insufficient" class (§14 point 4), now ALSO reachable through a plain
// local BigInt() decl mixed with an ordinary dynamic param, not only through
// a census read. `bigIntOperand`'s runtime guard only checks a
// maybeUndefined-flagged operand's OWN sentinel — a genuinely-Number
// dynamic operand has none, so its raw f64 bits get silently reinterpreted
// as i64 instead of throwing. `valTypeOfWithLocals`'s own arithmetic/bitwise
// arm (kind.js, the general fix above) now correctly claims BIGINT for this
// shape (one side statically proven BigInt is enough — matches
// numericBinaryVT's own "BigInt if EITHER operand is BigInt" formula, and IS
// the textbook-correct static answer for the non-throwing case), which
// flips the export lane from a wrong NUMBER to a wrong BIGINT — still wrong,
// still this same unfixed runtime-dispatch gap, just a different wrong shape.
test('KNOWN-FAIL (found landing round-7, out of scope, audit-#10 §14 point 4 class): a proven-local BigInt mixed with a zero-evidence dynamic param silently corrupts instead of throwing TypeError', () => {
  const f = jz('export let f = (v, w) => { let x = BigInt(v); return x - w }', { jzify: true }).exports.f
  is(typeof f(5, 2), 'bigint', 'JS: TypeError (Number 2 mixed with BigInt 5n) — actual: silently wrong bigint, unchanged runtime gap')
})

// KNOWN-FAIL, found landing this slice, NOT this slice's scope: a PARAM
// never gets a `presentVal` producer (§15's own explicit scope line —
// "Params/returns/closures do NOT get a presentVal producer in this slice"),
// so a BigInt-census value passed as a call-site ARGUMENT into a callee that
// applies unary `-`/`~` to its own parameter has no `presentVal`/`val` claim
// to consult at all — `emitNeg`/`~`'s own OR-arm (censusMaybeUndefinedKind)
// correctly asks the question but gets `null` back for the param, falls to
// ordinary NUMBER negation, and corrupts the raw BigInt carrier bits (sign-
// flips them as if they were a float). Closing it is the param/return/
// closure `presentVal` propagation slice §15 names as its own future,
// comparable-sized work — not attempted here.
test('KNOWN-FAIL (found landing Slice 7, out of scope): param-hop present-key BigInt census value through unary `-` in a callee has no presentVal producer for params', () => {
  const f = jz(`
    const g = (v) => -v
    export let f = () => { const m = new Map(); m.set('a', 5n); return g(m.get('a')) }
  `, { jzify: true }).exports.f
  is(typeof f(), 'number', 'JS: -5n (bigint) — actual: wrong number, a pre-existing gap this slice does not close')
})
