# represented maybeUndefined join + BindingId alias/escape ownership — design (2026-08-02)

Read-only deliverable. Prerequisite the audit-#7 P0 revert (f8f61591, reverting
1db8e55e) named verbatim: ".work/todo.md" "audit-#7 P0 closed" entry, open
design item. Blocks re-enabling ANY container value-census consumer
(kind.js's dormant `mapValueKindOf`, and the live-but-unsound
`dictValueKindOf`). Two audit repros pinned red (test/dyn-keys.js:132,137) plus
one KNOWN-FAIL (test/dyn-keys.js:154) plus one undocumented-until-now leak
(`Number.isNaN`) all reproduced live in this session — exact values below.

## Ground truth (reproduced live, `node -e` probes against index.js, no dist rebuild)

```
Number.isNaN([1][2])                    jz=true        JS=false
Number.isNaN(a[2])  (named array)        jz=true        JS=false   (arith/String already correct on this receiver)
Number.isNaN("hi")                       jz=true        JS=false   (NEW finding, broader than the OOB framing — see §4)
Number.isNaN({})                         jz=true        JS=false   (NEW finding, same root)
Number.isNaN(5)                          jz=false       JS=false   (correct — genuine number)
d={}; d[wk]=1 (wk='a'); d['zz'] + 1       jz=undefined   JS=NaN     (KNOWN-FAIL, test/dyn-keys.js:155)
String(d['zz'])                          jz='NaN'       JS='undefined'
[1][2] + 1                                jz=NaN         JS=NaN     (already correct)
String([1][2])                            jz='undefined' JS='undefined' (already correct)
```

The last two rows are load-bearing for scoping: **arithmetic and String() are
already sound for array/typed-array OOB reads** (module/array.js:1003,
module/typedarray.js:1765/1779/1808/1828 stamp `.checkedNumRead` on the
result IR; `ir.js` toNumF64 lines 959-970 fold the sentinel arm through
`__to_num`'s canonical-NaN path before the `vt===NUMBER` fast return can see
it). The dict/map census has **no such IR tag** — `dictValueKindOf`/(dormant)
`mapValueKindOf` are pure `valTypeOf`-time static claims with no producer-side
marking on the emitted node, so `toNumF64`/String()'s fast arms see a bare
`vt===VAL.NUMBER` and take the unguarded path. This is why the KNOWN-FAIL
dict row above is wrong while the array-OOB row is right — **two structurally
different mechanisms protecting the same JS-level guarantee, one complete, one
missing.** `Number.isNaN` is a third, independent, unguarded mechanism (proven
above to be wrong even on the ALREADY-protected array-OOB case, and on
plain-wrong-typed non-nullish values) — its fix does not depend on either of
the first two.

## 1. The `maybeUndefined` join — representation decision

**Rejected: a new `VAL.*` lattice member** (e.g. `VAL.NUMBER_OR_UNDEF`).
carrier-invariant-design.md's own rejected-alternative (b) already
established why: "the codebase has ZERO switch/case on VAL.\* (115 scattered
`===VAL.BOOL` comparisons) — no structural switch to hang exhaustiveness on."
A new union member multiplies every one of those ~115+ (now ~120, see below)
comparison sites into a 3-way branch with no compiler-enforced exhaustiveness
— it *creates* MECHANISM A's enumerated-list-drift disease, doesn't close it.

**Rejected: a new stored `ValueRep` field** (`REP_FIELDS` boolean, mirroring
`nullable`/`bigintBoxed`). `nullable` is name-keyed (a *binding* may hold
null/undefined on some path) — the census leak is *expression*-shaped (`d[k]`,
`m.get(k)`), not binding-shaped; threading a fresh boolean through
`dictValueKindOf`/`mapValueKindOf`'s return convention (both return a bare
`string|null`, consulted at 4 call sites — kind.js:399, kind.js:480, and
the two now-deleted `.get` sites) would require changing that return shape
project-wide for a fact only 2-3 consumers need.

**Chosen: reuse the AST-shape predicate `nullableOperand` already computes
inline** (src/compile/emit.js:2304-2306) for its own soundness carve-out —
promote it to a named, exported predicate in kind.js (co-located with
`dictValueKindOf`, whose doc comment already states the exact soundness
argument this predicate encodes):

```js
// kind.js, immediately after dictValueKindOf (currently line 292)
export function censusMaybeUndefined(node) {
  return Array.isArray(node) && (node[0] === '[]' || node[0] === '.') && node.length === 3
    && typeof node[1] === 'string' && !!dictValueKindOf(node[1])
  // Map re-enablement (§3) adds a second arm here recognizing
  // ['()', ['.', recv, 'get'], k] gated on mapValueKindOf(recv) — same shape
  // 1db8e55e's nullableOperand carve-out already used (git show 1db8e55e,
  // the deleted lines), not written yet: no live producer to protect today.
}
```

This is a **zero-new-representation** decision: `dictValueKindOf`/
`mapValueKindOf` keep returning an exact `VAL.*` string exactly as today (the
census's whole *point* is exposing that kind to the ~120 fast-path
`valTypeOf(node)===VAL.NUMBER`-style consumers that want it — see the
"impossible, not carve-out" discussion below for why this is the correct
trade, not a shortcut). The join is expressed not as a stored value but as
*"is this exact-kind claim one that a bare read could falsify at runtime" —*
a question already answerable from the AST shape alone, with the answering
logic already written and shipped (nullableOperand). What's missing is
wiring three more consumers to ask it before trusting the exact kind:

### 1a. Arithmetic — ir.js `toNumF64`, line 977

```js
const vt = valTypeOf(node)
if (vt === VAL.BOOL) return typed(['f64.convert_i32_s', truthyIR(v)], 'f64')
if (vt === VAL.NUMBER || vt === VAL.BIGINT) return asF64(v)   // ← unguarded fast return
```//→
```js
if (vt === VAL.NUMBER || vt === VAL.BIGINT) {
  if (vt === VAL.NUMBER && censusMaybeUndefined(node)) return coerceNullishToNum(asF64(v))
  return asF64(v)
}
```
`coerceNullishToNum` (ir.js:921-929) already exists — built for
`ctx.func.maybeNullish`-flagged bindings (nullish-literal inits) — and
already does exactly the right thing: `NULL_NAN→+0`, `UNDEF_NAN→NaN`, real
number passes through unchanged. Zero new coercion logic, one new call site.
Confirmed this is a **runtime** check (not the `checkedNumRead` family's
compile-time constant-arm fold, ir.js:944-950/959-970): a dict/map read
compiles to an opaque `call $__dyn_get_expr`/`$__hash_get_local` — the
absent-key case is decided INSIDE the wasm helper, invisible to the
compiler, so there is no constant arm to fold; `coerceNullishToNum` already
handles this (it's an `if`-form runtime bit-pattern test, not a fold).

### 1b. String() — module/string.js, line 2048 (current, post formatter-dispatch-fix)

```js
if (hasAmbiguousBoolMerge(value))
  return typed(['f64.reinterpret_i64', toStrI64(value, emitIdentitySafe(value))], 'f64')
if (valTypeOf(value) === VAL.STRING) return emit(value)
if (valTypeOf(value) === VAL.BOOL) return bool(value)
if (valTypeOf(value) === VAL.NUMBER) {          // ← unguarded fast branch
  inc('__ftoa')
  return typed(['call', '$__ftoa', asF64(emit(value)), ['i32.const', 0], ['i32.const', 0]], 'f64')
}
return typed(['f64.reinterpret_i64', toStrI64(value, emit(value))], 'f64')   // ← already correct
```
Fix: add `if (censusMaybeUndefined(value)) return typed(['f64.reinterpret_i64', toStrI64(value, emit(value))], 'f64')`
immediately after the `hasAmbiguousBoolMerge` early exit (same "early exit
before the exact-kind branches" shape that fix already uses) — falls through
to the LAST branch, which is **already correct** (confirmed live:
`String([1][2])` → `'undefined'`, matches JS, because `toStrI64`'s general
arm calls `__to_str`, and `__to_str` already special-cases `UNDEF_NAN`/
`NULL_NAN` before its generic dispatch, module/string.js:1083-1090). No
change needed to `toStrI64`/`__to_str` themselves — only to the `bind('String', …)`
wrapper's own hand-rolled bypass, exactly the same MECHANISM-A-adjacent
"static-valType check, not IR-shape check, argIR alone can't skip it" shape
formatter-dispatch-design.md already diagnosed and fixed for
`hasAmbiguousBoolMerge` at this identical call site.

**Template literals need no fix.** Traced `strcat`'s per-part loop
(module/string.js:1916-1930, per formatter-dispatch-design.md): its fast-arm
condition is `v.type === 'i32'` (an IR-shape check) — a dict/map value is
always NaN-boxed f64 (dicts store generic boxed slots, never raw i32), so the
condition is false *structurally* for every census read; execution already
falls to `partStrI64`→`toStrI64`, the correct general arm. Confirmed live:
` `${[1][2]}` ` and the equivalent dict read both already format correctly —
**verify this stays true for the dict/map case specifically as part of the
gate** (§5), not re-derive it, but no code change is predicted here.

### 1c. Computed member key / other arithmetic-adjacent sites — free

`src/compile/emit-assign.js:562`'s `storedValue(idx)` chokepoint and every
other `toNumF64`/`toStrI64` caller inherit the §1a/§1b fix automatically —
they call the chokepoint, not `asF64`/`__ftoa` directly. This is why the fix
is 2 call sites, not N: `toNumF64` and `toStrI64`-family formatting are
already the funnel MECHANISM A promoted `storedValue`/`argIR` to be for
*boxing*; this design leans on the same funnel for *coercion*.

### Why "carve-out," and why that's the right call here, not MECHANISM A again

The task's framing wants "impossible by construction, not a carve-out."
Literally impossible requires either (a) a real `Optional<VAL>` lattice
member with compiler-enforced exhaustiveness — rejected above, no structural
switch exists to hang it on, and building one is a rearchitecture far outside
this design's blast radius — or (b) never exposing the exact kind to the
general `valTypeOf`/VT machinery at all, routing it only through a bespoke
safe accessor. (b) was seriously considered and rejected: it would also
block every *sound* fast-path win the census exists to deliver (`.push()`,
method dispatch, `+`'s numeric arm skipping the polymorphic dispatch for the
overwhelming *present-key* case) — the census's entire value proposition,
not just its unsound 10%. Neither option is proportionate to a 3-site fix.

What makes THIS carve-out different from MECHANISM A's (the one that
actually burned the codebase, carrier-invariant-design.md): MECHANISM A's
problem was an *emit-time boxing decision* re-implemented ad hoc at 16+
unrelated call sites across 4 files with no shared vocabulary — genuinely
unbounded, no way to enumerate "is this every site" with confidence.
This carve-out's consumer set is the ECMAScript abstract-operation coercion
boundary — ToNumber, ToString, and (§4) the identity/typeof family — which
is *closed by the language spec itself*, not by this codebase's discipline:
there are exactly as many "does this bare-metal-read a value's kind and use
it uncoerced" chokepoints as there are primitive-conversion operators in JS,
and `toNumF64`/`toStrI64` are already the chokepoints for two of them.
A `JZ_DEBUG_INVARIANTS`-mode tripwire (matching reps.js's own `assertRepFields`/
`DBG_REPS` convention and the P1 predictor-drift assert carrier-invariant-
design.md relies on for an analogous "value-identical, looks safe" class of
bug) is the closest THIS codebase's existing tooling gets to compiler-
enforced exhaustiveness — sketched, not fully specified, as a recommended
follow-up: have `censusMaybeUndefined`, in DBG mode, register the flagged
node in a per-compile `WeakSet`; have `asF64`'s actual bit-reinterpret arm
assert the node isn't in that set unless the call arrived via
`coerceNullishToNum`/`toStrI64`'s call frame. Left unspecified (not a landing
blocker) — flagged here so a landing agent doesn't have to rediscover the
option, and doesn't mistake its absence for "not considered."

## 2. BindingId alias/escape ownership

**Surprise finding: this machinery already exists, unconsulted.**
`ctx.types.nameEscapes` (src/compile/program-facts.js:37-76, populated during
`observeNodeFacts`'s whole-program walk, installed at
src/compile/plan/index.js:133 beside `dynWriteVars`/`arrResized`) is a
whole-program, name-keyed set of every binding read in a *value position* —
assigned to another name (`const alias = m`), passed as a call argument
(`f(m)`), stored in a field (`o.x = m`), returned (`return m`), or read as a
closure-body value. `ESCAPE_SKIP` (program-facts.js:28-35) exempts ONLY the
positions that can't alias: `.`/`?.` receivers, decl LHS-es, `=>`'s own param
list — every other bare-name occurrence marks. The doc comment at
program-facts.js:43-46 already states the exact contract this design needs:
*"the reference may alias, so mutations through the alias are invisible to
per-name facts... over-marking loses a fold, only, never unsound."*
`optimize/index.js:5014-5029` (`foldStaticConstArrayReads`) already consumes
it for an analogous problem — folding a static array's base/length requires
proving no write *and no escape*, bailing with `resized.has(name) ||
escapes.has(name)`, with the identical justification ("an alias or a grow
could relocate the payload... a folded base would read stale memory").

**Chosen model: `name` (a program-wide identifier, exactly as every other
census in this codebase is already keyed — `dynWriteVars`, `arrResized`,
`dictValueTypes`, `mapValueTypes`, `literalWriteKeys`, all name-keyed,
program-facts.js:638's own comment: "same whole-program name-keyed
convention") IS the binding identity, with `nameEscapes` as its escape
oracle.** No SSA construction, no new identifier scheme. This is a deliberate
rejection of literal "BindingId" infrastructure: every other fact in this
file's architecture is name-keyed and whole-program-closed-world; an
SSA/identity-keyed census would be the only one of its kind, a structural
outlier for zero additional soundness — `nameEscapes` closes the exact gap
because a value **cannot** be aliased without first being read in a value
position, and the walk (program-facts.js:37-76) already marks every such
read, unconditionally, everywhere in the program (including nested function/
closure bodies — `observeProgramSlots`'s own docstring, program-facts.js:591,
"walk `ast` + every user function body").

**The gate**: `dictValueKindOf`/`mapValueKindOf` add one line each, first:

```js
export function dictValueKindOf(name) {
  if (ctx.types?.nameEscapes?.has(name)) return null   // BindingId ownership:
    // `name` was read in a value position somewhere in the program (assigned
    // to another binding, passed as a call arg, stored in a field, returned,
    // captured) — a write through that alias is invisible to this census
    // (analyze.js's same-body scan / program-facts.js's global census are
    // BOTH syntactic-name-keyed; see reps.js's mapValueValType doc). Fail
    // open: absent fact set (not-yet-walked) is handled identically to a
    // present-and-escaped name — see optimize/index.js:5018-5021's own
    // "facts must EXIST to fold" precedent.
  const local = ctx.func.localReps?.get(name)?.dictValueValType
  ...
```

**Both audit repros, correct by construction, traced against this gate:**

*Absent key* (test/dyn-keys.js:132-134, `m.set('a',1); m.get('b')+1`): `m`
never escapes (no alias, no call-arg, no field-store, no return) — the
`nameEscapes` gate does NOT fire, `mapValueKindOf('m')` still returns
`NUMBER`. This repro is closed by §1's join, not this gate — the exact-kind
claim is correctly trusted, but the CONSUMER (`toNumF64`, via
`censusMaybeUndefined`) now coerces the absent-key sentinel through
`coerceNullishToNum` instead of reading it raw. Correct by §1 alone.

*Alias write* (test/dyn-keys.js:137-143, `m.set('k',1); const alias = m;
alias.set('k','oops1'); m.get('k')-0`): the `const alias = m` declaration is
an `'='`-node with `args[1]='m'` in a bare value position (declEq only
exempts `args[0]`, the LHS binding name, program-facts.js:68/72) — `'m'` is
added to `nameEscapes` unconditionally, the moment that line is walked,
independent of what happens to `alias` afterward. At the `m.get('k')` read
site, `mapValueKindOf('m')` now hits the new first line, sees
`nameEscapes.has('m') === true`, returns `null` before ever consulting the
(stale, `NUMBER`-poisoned-by-the-first-write) `mapValueValType` fact. VT
falls through to `methodValType`'s generic `.get` dispatch (no kind claim) →
the read takes the fully-generic runtime path, `alias.set`'s STRING write is
read back correctly (`'oops1' - 0 === NaN`, matching JS) simply because no
unsound fast path was ever taken. Correct by §2 alone — §1's join is not
even reached for this repro (the fact never survives to be joined).

Both repros are closed by *different, independent* halves of this design —
exactly matching the revert's own framing ("unsound two independent ways").
Neither half alone closes both; that's why the open item names both as
co-requisites, not alternatives.

## 3. Re-enablement criteria

`mapValueKindOf` may be reintroduced (currently fully deleted — see `git show
1db8e55e -- src/kind.js src/compile/emit.js` for the exact prior body) once,
and only once, ALL of:

1. `dictValueKindOf` (the ALREADY-LIVE sibling) carries the `nameEscapes`
   gate (§2) — landing it on the live consumer first is a strictly smaller,
   independently gate-able slice, and de-risks the exact same wiring before
   it's reused for Map.
2. `censusMaybeUndefined` (§1) exists and is wired into `toNumF64`/
   `String()` — the reintroduced `mapValueKindOf` branch in `censusMaybeUndefined`
   MUST land in the SAME commit as the `.get()` short-circuit in
   `VT['()']` (kind.js:591-598) and `nullableOperand`'s matching carve-out
   (the exact three-file diff `git show 1db8e55e` shows, MINUS the two
   soundness lines it lacked) — the design's whole point is these three
   things are co-requisites, not sequenceable.
3. `mapValueKindOf` itself gains the SAME first-line `nameEscapes` gate shown
   in §2 for `dictValueKindOf` — written in from day one, not deferred (this
   is the revert's own explicit instruction, reps.js:122-124: "Do not wire a
   new consumer without first landing... this needs to be sound").
4. A structural site census (mirroring carrier-invariant-design.md's own
   16-site MECHANISM A inventory and formatter-dispatch-design.md's
   read-side Finding #2 sweep) is run over the ~120
   `valTypeOf(...)===VAL.NUMBER`/`===VAL.STRING`-shaped sites in src/+module/
   to confirm §1's two fixed chokepoints (`toNumF64`, `String()`) are the
   ONLY sites that bypass them for a bare-node exact-kind read reachable from
   a `.get()`/`[k]` census node — this design verified 2 (arithmetic,
   String()) by direct repro, not by exhaustive enumeration; it did NOT
   audit method-dispatch consumers (`d[k].toFixed(2)` where `d[k]` is
   census-absent — real JS throws `TypeError`, unaudited here) or `typeof`/
   `===` beyond `nullableOperand`'s pre-existing dict-mode branch (which
   already covers identity, unchanged by this design). Flagged, not closed.
5. Full gate battery green (see §5).

## 4. Coverage of pre-existing leaks

**`Number.isNaN([1][2])`**: closed by §1's `censusMaybeUndefined`-style
reasoning IF `emitIsNaN` (module/number.js:1268-1272) gains a sentinel
exclusion — but the live probes above (Ground truth table) show this bug is
**broader than the OOB framing**: `Number.isNaN("hi")` and `Number.isNaN({})`
are ALSO `true` (JS: `false`) — `emitIsNaN` performs a raw hardware
self-compare (`v !== v`) with **zero type discrimination of any kind**, not
gated on `valTypeOf` at all:
```js
const emitIsNaN = (x) => {
  const v = asF64(emit(x))
  const t = temp('t')
  return typed(['f64.ne', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]], 'i32')
}
```
Every NaN-boxed pointer (string, object, array, the undefined/null sentinels)
reads as a bit-pattern NaN under raw `f64.ne` self-compare — this is not
specific to census reads or OOB reads, it fires for `Number.isNaN("hi")` on
a **provably-STRING, non-nullable, non-census** argument. This is a
genuinely separate, pre-existing, previously-undocumented defect (no
kernel-oracle row, no test262-builtins execution catches it — grepped both,
zero hits) — **out of scope for a "maybeUndefined join" fix**: the correct
general fix is a real is-this-a-Number runtime tag check (JS: `Number.isNaN`
does NOT coerce — `typeof` semantics, not `ToNumber` semantics), which this
design does not specify. **What this design DOES close**: gating the exact
`[1][2]`/dict/map-census repros the task named, by excluding the KNOWN
sentinel bit patterns specifically (reusing `isNullish`, ir.js:1497-1510,
already exported, already combines `NULL_NAN`/`UNDEF_NAN`) whenever
`censusMaybeUndefined(x)` (or the pre-existing `checkedNumRead`-tagged-IR
case) applies:
```js
const emitIsNaN = (x) => {
  const v = asF64(emit(x))
  if (censusMaybeUndefined(x) || /* v carries .checkedNumRead, needs its own tag surface */) {
    const t = temp('t')
    return typed(['i32.and', ['i32.eqz', isNullish(v)],
      ['f64.ne', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]]], 'i32')
  }
  ... unchanged ...
}
```
This closes the task's named repro (`[1][2]`, a `checkedNumRead`-tagged
array/typed OOB read) and the dict/map census case, but leaves
`Number.isNaN("hi")`/`Number.isNaN({})` wrong — **flagged as a new, separate,
unscoped finding**, not silently folded into this design's "done" criteria.
Recommend its own dedicated design pass (likely: a proper `$__is_number`
tag-range check, mirroring how `typeof` presumably already discriminates
kinds correctly elsewhere — unaudited here, out of this session's budget).

**Dyn-dict missing reads** (the KNOWN-FAIL, test/dyn-keys.js:154-157):
closed directly by §1's `toNumF64`/`String()` fixes — `dictValueKindOf` is
already live (unlike Map), so landing §1 alone (no Map re-enablement
required) flips this KNOWN-FAIL to green. This is the highest-value,
lowest-risk slice of the whole design (§5, Slice 1).

## 5. Cost & self-host risk, staged slices

**Cost, arithmetic (`toNumF64`)**: the new branch only fires when
`censusMaybeUndefined(node)` is true — an AST-shape check on the *specific*
`['[]',name,k]`/`['.',name,k]` node shape with `dictValueKindOf(name)`
truthy, which requires (a) a dict-mode receiver AND (b) a monomorphic
writer census. Every other `vt===NUMBER` arithmetic site (loop counters,
proven locals, schema slots) sees zero new checks on the hot path — the
predicate short-circuits on `node[0]` before touching `ctx.func.localReps`.
No corpus census run in this session (heavy-battery-avoidant per task
constraints) — **required gate, not yet run**: `node scripts/bench-size.mjs`
+ `test/perf-ratchet.js` after landing, to confirm (mirroring carrier-
invariant-design.md's own "ZERO ambiguous-merge shapes in the bench corpus"
finding) that the bench corpus carries zero or near-zero dict-value-census
reads inside hot loops — plausible (dict/map census wins are point reads,
not loop bodies, per map-value-census-design.md's own corpus note: "exactly
2 `.set(` in bench") — but must be confirmed, not assumed.

**Cost, `nameEscapes` gate on `dictValueKindOf`**: this is the ONE piece of
this design that changes behavior for an ALREADY-SHIPPED, live consumer —
real regression risk. Any program in the bench/self-host corpus that
currently benefits from `dictValueKindOf`'s fast path AND aliases the dict
anywhere (assigns it to another name, passes it to a function, stores it in
a field, returns it) loses that fast path the moment this gate lands — a
genuine, not hypothetical, size/speed cost on some corpus subset. **Required
gate**: `test/bench.js`/`test/perf-ratchet.js` before/after, PLUS a targeted
grep census (`grep -n "dictValueValType\|dictValueKindOf"`-adjacent corpus
scan for dict receivers that are also assigned/passed/returned anywhere) to
enumerate the affected site count BEFORE landing, matching every other
design in this ledger's own "cost bounded, enumerated" discipline — not
performed in this session (would require compiling/profiling the bench
corpus, outside the read-only/no-heavy-battery brief).

**Self-host risk**: `dictValueKindOf`/`mapValueKindOf` consumers reach
module/string.js and src/ir.js — both self-hosted. Per carrier-invariant-
design.md's own hard-won lesson (the DECL-INIT WALL: "value-identical, looks
safe is not sufficient evidence for this codebase" — a value-identical
`storedValue`-routing change at ONE call site in `emitDecl` previously
caused total export loss when the compiler compiled itself), every gate
below is load-bearing, not a formality, even though every individual change
here is smaller than that one.

**Staged slices** (mirrors this ledger's own precedent for bigint rounds/
LoopPlan — small, independently gated):

1. **`censusMaybeUndefined` predicate (kind.js) + `toNumF64`/`String()` wiring
   (§1a/§1b) — NO `nameEscapes` gate yet.** Flips the dict KNOWN-FAIL
   (test/dyn-keys.js:154-157) green. Zero behavior change for every
   non-census read (predicate is false). Gate: repro-first (confirm KNOWN-FAIL
   red before, green after), kernel-oracle, kernel-parity byte-identity,
   full battery, fresh dist rebuild ×2 (self-host fixed point), perf-ratchet
   + bench-size (dict-in-loop census scan, §5 cost note).
2. **`emitIsNaN` sentinel exclusion (§4), scoped to `censusMaybeUndefined`
   + the pre-existing `checkedNumRead` tag surface only** (NOT the broader
   string/object leak — separate design). Flips the `[1][2]`/array-OOB
   `Number.isNaN` repro green; leaves `Number.isNaN("hi")` as a newly-pinned,
   documented KNOWN-FAIL (mirrors this ledger's own "pin the wrong value so
   a future fix flips the assert" convention, test/dyn-keys.js:154's own
   style). Gate: same as Slice 1 plus test262-builtins isNaN rows re-checked.
3. **`nameEscapes` gate on `dictValueKindOf` (§2).** The regression-risk
   slice — lands ALONE, after 1-2 are stable, so any perf/size delta is
   attributable to this change specifically, not conflated with the join.
   Gate: perf-ratchet + bench-size before/after (mandatory, see cost note
   above), full battery, fresh dist ×2.
4. **Map re-enablement**: reintroduce `mapValueKindOf` (kind.js) + the
   `VT['()']` `.get` short-circuit + `nullableOperand`'s matching carve-out,
   verbatim per `git show 1db8e55e` EXCEPT with the `nameEscapes` gate
   (§2) baked in from the first line and `censusMaybeUndefined`'s Map arm
   (§1) landing in the same commit — this is the §3 criteria, all four
   items, satisfied simultaneously, not sequenced further. Re-flip
   test/dyn-keys.js:132-143's two audit-P0 pins from "wrong, pinned" to
   "the mechanism that makes them right" (they currently pin CORRECT
   behavior achieved by having NO consumer at all — re-enabling must keep
   them green via the sound mechanism, not merely avoid re-breaking them).
   Gate: full battery, kernel-oracle, kernel-parity, dyn-keys/inference/
   provenance-inference (map/dict-census-adjacent suites), fresh dist ×2,
   selfhost.js, selfhost-perf.js warm+fresh caps, watr self-host (per
   map-value-census-design.md's own I32_MEMO/F64_MEMO win-surface note —
   confirm the fact is STILL delivering its original perf win post-gates,
   not merely "not broken").
5. **Site census (§3 item 4)** — can run in parallel with 1-4, blocks only
   the final "re-enablement complete" declaration, not any individual slice.

## 6. Honest risks

- **Nested containers / container-of-container**: `mapValueValType`/
  `dictValueValType` are single-level scalar `VAL.*` facts. A Map/dict whose
  VALUES are themselves objects/arrays is Tier 2 territory
  (map-value-census-design.md's own explicit split, `mapValueSchemaId`, "own
  design pass after Tier 1 stabilizes") — this design's join applies
  uniformly to WHATEVER kind Tier 1 or Tier 2 eventually claims, but Tier 2's
  OBJECT-edge census doesn't exist yet, so nested-container absent-key
  correctness is simply not reachable by this design at all. Out of scope,
  not silently assumed solved.
- **Destructuring a maybeUndefined-joined value**: `const {a} = m.get(k)` on
  a genuinely-absent key throws `TypeError` in real JS ("Cannot destructure
  property of undefined"); jz's shape-based destructure machinery was not
  audited in this session for whether it even checks nullishness before
  assuming its static OBJECT shape. A likely gap, unconfirmed, not covered
  by §1's arithmetic/String/isNaN consumers (destructuring is its own
  consumer class, spec-wise "RequireObjectCoercible" — different abstract
  operation than ToNumber/ToString). Flag for whoever picks this up next.
  method dispatch (`d[k].toFixed(2)`) has the identical unaudited-consumer-
  class status — see §3 item 4.
- **BigInt-typed census values**: real JS throws `TypeError` mixing BigInt
  and `undefined` in arithmetic (`5n + undefined` throws, does not coerce to
  NaN) — `coerceNullishToNum`'s uniform "undefined→NaN" answer is WRONG for
  a `dictValueValType===VAL.BIGINT` census fact specifically. Not fixed here;
  §1a's `toNumF64` patch is written to gate on `vt === VAL.NUMBER`
  specifically (not the BIGINT arm) for exactly this reason — the BIGINT
  case is left exactly as unsound as it is today (untouched), not newly
  broken, but also not closed. A correct fix needs the actual-throw
  semantics, which jz's error model (audit-#7 P1, already landed) could in
  principle support but this design doesn't specify.
- **The `nameEscapes` gate's true cost is unmeasured** (§5) — this is the
  single highest-uncertainty item in the whole design; it could be a
  complete non-issue (zero corpus dicts alias) or a real, bounded regression.
  Framed as a required gate, not guessed at.
- **`asF64(emit(value))` double-emission risk**: §1b's fix branch calls
  `toStrI64(value, emit(value))` — a FRESH `emit(value)` call, not reusing
  whatever IR the (now-skipped) `VAL.NUMBER` branch would have produced.
  Confirmed safe by inspection (every branch in the existing `bind('String', …)`
  function already re-emits per-branch, no shared/hoisted `emit(value)` — this
  matches the function's existing structure, not a new pattern), but not
  independently gated by a dedicated double-emission test in this session.

## Open questions (only the user can decide)

1. **Priority vs. the reference-benchmark refresh currently reserving the
   machine** (per this session's own operating constraint) — should Slice 1
   (dict KNOWN-FAIL fix, §5) land opportunistically once the refresh
   finishes, or wait for an explicit go-ahead? No technical blocker either
   way; purely a scheduling call.
2. **Is the newly-found broader `Number.isNaN` leak (string/object
   arguments, §4) worth its own dedicated audit-style session now**, given
   it's a correctness bug with no existing test coverage (confirmed:
   test262-builtins.js lists but does not appear to execute the isNaN
   built-in rows against non-numeric args) — or should it stay banked
   alongside this ledger's other flagged-not-fixed items? This design
   recommends flagging, not deciding scope/priority — that's a product call.
3. **Whether the `JZ_DEBUG_INVARIANTS` tripwire sketched in §1's closing
   paragraph is worth building** as part of this landing, or left as a
   pure idea. It is not required for soundness (the enumerated carve-out is
   sound on its own, per the closed-coercion-boundary argument) — it would
   only add defense-in-depth against a FUTURE new fast-path site forgetting
   to consult `censusMaybeUndefined`. Genuinely a judgment call on how much
   the "impossible, not carve-out" language in the task should be honored
   literally vs. in spirit.
