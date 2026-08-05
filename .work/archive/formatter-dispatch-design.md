# Formatter runtime-dispatch fix — design (2026-08-02)

Read-only deliverable. Targets kernel-oracle.js's 4-row PENDING_FIX array
(String(), template literal, computed member key, captured-then-read —
row 11 stays pinned separately, DECL-INIT WALL, out of scope here).

## Finding #1: this is NOT three new "formatter" bugs — it's one already-fixed
## mechanism (storedValue) plus one already-partial mechanism (argIR), both
## un-swept at these three sites. No new runtime dispatch is needed anywhere.

`__to_str` (module/string.js:1077, the runtime WAT dispatcher every String()/
template-literal path eventually calls) **already** special-cases the atoms
correctly:
```
(if (i64.eq (local.get $val) (i64.const ${FALSE_NAN})) (then (return … "false")))
(if (i64.eq (local.get $val) (i64.const ${TRUE_NAN}))  (then (return … "true")))
```
line 1087-1090, checked *before* the generic NaN/pointer-type dispatch. Same
for `$__dyn_set`'s ToPropertyKey normalize (module/collection.js:2807-2809,
`__is_str_key` false → `local.set $key (call $__to_str …)`) — it already
routes through the same correct `__to_str`. TRUE_NAN/FALSE_NAN are exact i64
constants (`src/ir.js:401-402`, `atomNanHex(4|5)` — layout.js:152, PTR.ATOM
tag at bit 47, atom id in the aux field at bit 32; the two atoms differ only
in that field's low bit) — trivially, cheaply distinguishable by `i64.eq`,
already done at both sites named above.

**So the "runtime tag-test arm inside __to_str" option is already built and
correct.** The bug in all three rows is 100% producer-side: a value reaches
these already-correct consumers still carrying its *collapsed* raw 0.0/1.0
bit pattern (from `hasAmbiguousBoolMerge`'s benign-arithmetic-coercion
collapse, kind.js:204-216) instead of its TRUE_NAN/FALSE_NAN atom, because
the emit call feeding the consumer used plain `emit(node)` — or, worse, took
a *static-kind* fast path that bypasses the formatter dispatcher entirely.

## Mechanism decision: extend the SAME two established chokepoints (no new one)

Two chokepoints already exist, both from carrier-invariant-design.md /
bool-merge-identity-design.md:

- **`storedValue`** (src/bridge.js:41): `hasAmbiguousBoolMerge(node) ?
  emitIdentitySafe(node) : carrierF64(node, emit(node))`. Always boxes —
  correct for positions with no static-kind fast path to protect (container
  slots, keys).
- **`argIR`** (src/compile/emit.js:1176, private to emit.js): `hasAmbiguousBoolMerge(node)
  ? emitIdentitySafe(node) : emit(node)` — the non-ambiguous branch is
  byte-identical to a plain `emit(node)`, so it's the right shape wherever a
  *static-kind-driven fast path* downstream must keep working unmodified for
  the overwhelmingly common non-ambiguous case. Independently reinvented
  inline a second time at module/core.js:1706 (`typeof` operand) — same body,
  same rationale, not exported. Two more sites need it below → promote it to
  bridge.js (a straight copy-paste of emit.js:1176 — the file already imports
  `hasAmbiguousBoolMerge` at bridge.js:13 and exports `emit`/`emitIdentitySafe`
  at bridge.js:17/24, so this is a zero-new-import addition):
  ```js
  // src/bridge.js, after storedValue (line 41)
  export const argIR = (node) => hasAmbiguousBoolMerge(node) ? emitIdentitySafe(node) : emit(node)
  ```
  (emit.js keeps its own private copy — its own comment at 1178-1181 explains
  why: it owns `emit`/`emitIdentitySafe` directly, no bridge round-trip
  needed. That reasoning does not apply to module/*.js files, which already
  route both through bridge.js.)

**Rejected alternatives** (one line each, per the task):
- *Runtime tag-test arm inside `__to_str`*: already exists, already correct — nothing to add; the defect is entirely upstream of it.
- *Box unconditionally at the merge point* (`&&`/`?:`/`||` always materializes the BOOL arm's atom): this is exactly the REVERTED broad fix's failure mode the ledger already burned down (kind.js:210-213 "categorically unlike the reverted... trigger") — an arithmetic consumer (`1 + (cond ? 1 : false)`, pinned at test/bool-identity.js:75) would then read the atom's raw bits as a number and corrupt `+`.
- *A fourth bespoke `hasAmbiguousBoolMerge`-ternary written inline per call site*: this is literally MECHANISM A's own diagnosed disease (carrier-invariant-design.md "drift is the disease") — 3 independent copies already exist (emit.js:1176, core.js:1706, and now 2 more needed); promote instead of re-duplicating.

Output-size / speed cost: **zero** for the non-ambiguous case at every site
below — `argIR`'s non-ambiguous branch is byte-identical to the `emit(...)`
call it replaces; `storedValue`'s non-ambiguous, non-BOOL branch (`carrierF64`
→ `asF64(emitted)`) is byte-identical to the `asF64(emit(...))` call it
replaces at the key site. Self-host warm cost: one extra `hasAmbiguousBoolMerge`
predicate call per site — the same cost class already paid at 50+ existing
sites (kind.js:236-241's own comment) and the design doc's census found ZERO
ambiguous-merge shapes in the bench corpus (carrier-invariant-design.md COST
section) — free in hot code. Self-host structural census DID find candidates
in the compiler's own source (~21 sites, see Self-host risk below) — those
exercise the NEW branches for real, which is exactly why the self-host gate
below is mandatory, not optional.

## Exact insertion points

### 1. String() — module/string.js:2032-2041

```js
bind('String', (value) => {
  if (value === undefined) return emit(['str', ''])
  if (valTypeOf(value) === VAL.STRING) return emit(value)
  if (valTypeOf(value) === VAL.BOOL) return bool(value)
  if (valTypeOf(value) === VAL.NUMBER) {          // ← fires for the ambiguous merge too:
    inc('__ftoa')                                  //   hasAmbiguousBoolMerge's whole point is
    return typed(['call', '$__ftoa', asF64(emit(value)), ['i32.const', 0], ['i32.const', 0]], 'f64')
  }
  return typed(['f64.reinterpret_i64', toStrI64(value, emit(value))], 'f64')
})
```
Confirmed live (`node -e` probe, `String(x > 0 && 1)` at O0): compiles to
`return_call $__ftoa(f64.convert_i32_s(select …), 0, 0)` — the VAL.NUMBER
branch fires (valTypeOf collapses the merge to NUMBER) and calls `__ftoa`
*directly* on the raw select result, never reaching `toStrI64`/`__to_str` at
all. This branch is a **static-valType** check, not an IR-shape check —
`argIR` alone can't skip it (the condition never inspects `v.type`). Needs an
explicit early exit:
```js
bind('String', (value) => {
  if (value === undefined) return emit(['str', ''])
  if (hasAmbiguousBoolMerge(value))
    return typed(['f64.reinterpret_i64', toStrI64(value, emitIdentitySafe(value))], 'f64')
  if (valTypeOf(value) === VAL.STRING) return emit(value)
  … unchanged …
```
`toStrI64` (src/ir.js:1108-1134) needs no change: given the boxed atom it
takes its own general `__to_str` call-arm (line 1132-1133) since
`valTypeOf(value)` is NUMBER (not STRING/OBJECT) and `emitIdentitySafe`'s
result is always `.type === 'f64'` (every return in emit.js:2332-2384 is
`typed(…, 'f64')`), so the `v.type === 'i32'` i32-fast-arm (ir.js:1128) can't
fire either. `toStrI64` self-manages its own `inc('__to_str')` (ir.js:1132) —
no redundant `inc` needed at the call site.
Import delta: add `hasAmbiguousBoolMerge` to the existing `from '../src/kind.js'`
import (string.js:26) and `emitIdentitySafe` to the existing
`from '../src/bridge.js'` import (string.js:25).

### 2. Template literal — module/string.js:1885, 1913-1931 (`strcat`)

Confirmed live: `` `${x > 0 && 1}` `` at O0 desugars (src/prepare/index.js) to
a 3-part `['strcat', '', merge, '']` node, compiles through the per-part loop
at 1913-1931 — NOT `partStrI64`'s single-part shortcut (1889), which only
fires when `strcat` is called with exactly one part overall. The compiled WAT
shows `local.tee $7 (f64.gt …)` fed straight into `$__ilen`/`$__itoa_s` (the
i32-digit direct formatter) — the **i32-PROVEN fast path**, line 1921:
```js
const vt = valTypeOf(parts[i])
const v = vt === VAL.BOOL ? null : emit(parts[i])                         // line 1916 — raw emit
if ((vt === VAL.NUMBER || vt == null) && v.type === 'i32' && v.ptrKind == null) {  // line 1921
  inc('__ilen', '__itoa_s')                        // digit-formats the RAW select result directly
  …
  continue
}
…
ir.push(['local.set', `$${vals[i]}`, ['f64.reinterpret_i64', partStrI64(parts[i], v)]])  // line 1930
```
Unlike String()'s branch, this IS an IR-shape check (`v.type === 'i32'`) —
`argIR` fixes it for free, no extra condition needed, because
`emitIdentitySafe`'s output is always f64-typed:
```js
const v = vt === VAL.BOOL ? null : argIR(parts[i])   // was: emit(parts[i])
```
`hasAmbiguousBoolMerge(parts[i])` true → `v = emitIdentitySafe(…)`, `.type
=== 'f64'` → the i32 fast-path condition on line 1921 is false structurally
→ falls to line 1930's `partStrI64(parts[i], v)` → `toStrI64(p, v)` → same
general `__to_str` arm as String()'s fix, correctly formats the atom.
Also fix `partStrI64`'s own fallback (line 1885, covers the 1-part shortcut
at line 1889 and any other future 0-arg caller) for the same reason:
```js
const partStrI64 = (p, v) => valTypeOf(p) === VAL.BOOL ? asI64(bool(p)) : toStrI64(p, v ?? argIR(p))
// was: toStrI64(p, v ?? emit(p))
```
Import delta: add `argIR` to the bridge.js import (string.js:25); no new
import needed for `hasAmbiguousBoolMerge` in this file if the String() fix
above already added it — the strcat fix uses `argIR`, not the raw predicate.

### 3. Computed member key (WRITE) — src/compile/emit-assign.js:562

```js
const keyExpr = asF64(emit(idx))     // universal key-emit site for every
                                       // downstream branch in this function
                                       // (dynSetCall, dispatchByKeyKind, …)
```
Confirmed live: `o[x > 0 && 1] = 1` (o = `{}`, HASH receiver via
`__hash_reuse_eph`) compiles to `call $__dyn_set(o, f64.convert_i32_s(select
…), 1)` — the raw collapsed key reaches `$__dyn_set` directly (line 675:
`knownArrVT === VAL.HASH` → `dynSetCall(arr, keyExpr, valueExpr)`, line
101-113). `$__dyn_set`'s own ToPropertyKey normalize (module/collection.js:
2807-2809) is correct — `__is_str_key(0.0)` is false, so it calls
`__to_str(0.0)`, which (correctly, given what it received) formats a genuine
plain number as `"0"`. The defect is entirely that `0.0` arrived instead of
FALSE_NAN. This is **not a new mechanism** — it's the storedValue chokepoint's
own contract (box a pure BOOL too, not just the ambiguous case — no
performance argument applies here since the line already unconditionally
`asF64`s), an 18th unswept site of the *same* MECHANISM A the design doc's
17-site inventory already found (bridge.js's own `coerce` was the 17th). Fix:
```js
const keyExpr = storedValue(idx)     // storedValue already returns f64-typed
                                       // IR in every branch — no asF64 wrap needed
```
`emit-assign.js` already imports `storedValue` from `../bridge.js` (line 27)
— **zero new imports**. For the overwhelming non-ambiguous, non-pure-BOOL
case (a loop counter, a proven numeric index) `storedValue`'s fallback is
`carrierF64(node, emit(node))` = `asF64(emit(node))` (ir.js:442-444, since
`valTypeOf(node) !== VAL.BOOL`) — byte-identical to the line it replaces.

### Finding #2 (surprise, not in the pinned oracle rows): a READ-side sibling family exists

The write-side fix above only covers `o[k] = v`. The identical defect exists
on the READ side — `o[k]` alone — at module/array.js's dyn-get key sites,
all currently raw `emit(idx)`/`asI64(emit(idx))`/`asF64(emit(idx))` feeding
`__dyn_get_expr`/`__hash_get_local`: lines 710, 714, 789, 832, 838, 844, 850,
855, 1070 (already-emitted `keyExpr`), 1127. None of the 4 PENDING_FIX rows
exercise a bare read (`o[x>0&&1]` returned directly, no prior write) so this
isn't a repro-first-verified claim the way the 3 rows above are — flagging it
as a same-root, same-fix-shape, **not yet oracle-tested** gap, per the
project's own "map it, fix if same-root, pin regardless" precedent (see the
ternary BOOL|NUMBER return comment in kernel-oracle.js:309-323). Recommended:
fold into the same landing session (mechanical `emit(idx)` → `storedValue(idx)`
swap at each site, identical safety argument, plus new AGREE oracle rows —
not PENDING-FIX, since this is a proactive fix, not a documented-then-flipped
gap) rather than deferring and letting it join the "un-traced" backlog the
carrier-invariant-design.md formatter section itself warns about.

## Per-row before/after

| row | source | current (wrong) | after fix | JS oracle |
|---|---|---|---|---|
| String() | `String(x > 0 && 1)`, x=-1 | `'0'` | `'false'` | `'false'` |
| template literal | `` `${x > 0 && 1}` ``, x=-1 | `'0'` | `'false'` | `'false'` |
| computed member key | `o[x>0&&1]='v'; o['0']`, x=-1 | `'v'` | `undefined` | `undefined` |
| captured-then-read | (unchanged — DECL-INIT WALL, out of scope) | `0` | `0` (still) | `false` |

All three fixed rows move from `test/kernel-oracle.js`'s `PENDING_FIX` array
(lines 378-402) to the `AGREE` array (lines 66-226), following the exact
precedent of the 13 rows already flipped there (see the "FLIPPED from
PENDING-FIX" comments at lines 109, 122, 151) — same `not()`-tripwire style
verification, now expected to newly assert `is()` equality with the JS oracle
across O0/O2/O3, both native and kernel legs.

## Constraining pins (verified, not just assumed)

test/bool-identity.js's existing `String(...)` pins are structurally
unaffected by this fix — checked each:
- line 30/37 `String(fe.f)` — a genuine (non-merge) boxed BOOL from a
  container read; `hasAmbiguousBoolMerge` returns false for it (not a
  `?:`/`&&`/`||`/`??`/`()` node at all); routes through the unchanged
  `valTypeOf(value) === VAL.BOOL` branch.
- line 72 `String(v)`, `v = s || false` — `hasAmbiguousBoolMerge` requires
  `vt(a) === vt(b)` or one side BOOL/other NUMBER; `s`'s static type is
  unknown (param), so neither condition matches — false, unaffected.
- line 75 `String(1 + (n > 0 ? 1 : n > -1))` — the ternary alone IS an
  ambiguous merge, but `hasAmbiguousBoolMerge` only recognizes
  `?:`/`&&`/`||`/`??`/`()`-grouping node shapes (kind.js:235-267); the `+`
  wrapping it is not in that set, so `hasAmbiguousBoolMerge` on the `+` node
  (what `String()` actually receives) is false — the existing VAL.NUMBER
  `__ftoa` fast path fires unchanged, `'2'` as pinned. This is also the
  proof the fix can't accidentally leak into arithmetic position: the guard
  is on the immediate node the formatter receives, not a deep "does this
  contain an ambiguous merge anywhere" scan.
- line 76 `String(n > 0 ? true : 'x')` — BOOL∪STRING arms, not BOOL∪NUMBER;
  neither `hasAmbiguousBoolMerge` condition matches (`tb` is STRING, not
  NUMBER) — false, unaffected, handled by whatever existing BOOL∪STRING path
  already passes this pin today.
test/booleans.js:70-72 `String(x > 0)` — a plain comparison, VAL.BOOL
non-ambiguous, unaffected.

No pin found that requires an ambiguous merge to format as its collapsed
number in String()/template/computed-key position — consistent with the
oracle rows asserting the opposite (that's the whole PENDING-FIX finding).

## Self-host risk

jz compiles itself; module/string.js and src/compile/emit-assign.js are both
in the self-hosted compile path. Two distinct risk classes:

1. **Ordinary self-host regression** (wrong output from the new branches
   when the self-hosted compiler itself hits an ambiguous merge in its own
   source). carrier-invariant-design.md's own census: "Self-host structural
   grep now ~21 candidate sites" (COST section) — non-zero, unlike the bench
   corpus's zero — so these new branches WILL fire for real during a self
   dist build, not just in tests. Gate: `node scripts/build-dist.mjs` twice
   (fresh dist, self-hosted-compiling-itself fixed point — the design doc's
   own "self-host TWICE with fresh dist rebuilds" gate, carrier-invariant-
   design.md line 196-197) — diff-clean or intentional.
2. **The DECL-INIT WALL class specifically** (carrier-invariant-design.md
   "TAG-PRESERVING REBOX LANDED" section, lines 61-121): a *value-identical*
   `storedValue`-routing change at one exact call site in `emitDecl`
   previously caused **total export loss** in native-compiling-itself, for
   reasons unrelated to the patch's logic (confirmed: `export let f = (x) =>
   x + 1`, a program with no merge shapes at all, also lost every export).
   This design's three insertion points are NOT that site (module/string.js's
   `bind('String', …)`/`strcat`, emit-assign.js's dynamic-key writer are
   distinct source locations from emitDecl's `val = viewInit || emit(init)`
   line ~1712) — but the WALL's own lesson is that "value-identical, looks
   safe" is not sufficient evidence for this codebase; the mystery's blast
   radius was previously misjudged twice (see the "RE-CHARACTERIZED" and
   superseding entries in that doc). Treat every self-host gate below as
   load-bearing, not a formality.

Gates a landing agent must run (in order, matching the storedValue
promotion's own precedent, carrier-invariant-design.md lines 195-197):
- `test/kernel-oracle.js` — all 3 rows flip PENDING_FIX→AGREE; full 430-ish
  assertion count still 100% (repro-first: confirm the CURRENT wrong values
  before editing, exactly as the PENDING_FIX `not()` tripwire already does).
- `test/kernel-parity.js` — 33/33 byte-identical (proves the non-ambiguous
  path truly pays nothing; this is the anti-190 gate).
- `test/bool-identity.js`, `test/booleans.js` — full pass (the constraining
  pins verified above).
- Full battery (`npm test` / whatever the project's existing run-all is) —
  regression-free count must match baseline exactly.
- `node scripts/build-dist.mjs` — fresh dist build, TWICE (self-hosted
  fixed point), diff dist/jz.wasm or re-run the battery against each — no
  new failures, no export loss.
- `selfhost.js` (or equivalent self-host smoke test referenced in the
  ledger, e.g. "selfhost.js 21/21") — full pass.
- Warm/fresh perf caps (the ledger's own "warm gate 0.985× / fresh 0.820×"
  style check) — confirm no regression, since `hasAmbiguousBoolMerge` now
  runs at 2 more sites in a hot template-literal/String() path.
- If choosing to also land the READ-side sibling family (Finding #2): the
  same gates, plus new AGREE oracle rows for at least one read-only repro
  per site family (array.js has both HASH-local and generic-receiver arms).

## Implementation plan (ordered, sized for one landing agent)

1. **Repro-first**: run kernel-oracle.js now, confirm the 4 PENDING_FIX rows
   fail exactly as documented (native+kernel both assert the wrong value;
   `not()` tripwire holds). This is the design's own already-passing state —
   just confirm before touching anything.
2. Add `argIR` export to src/bridge.js (after `storedValue`, line 41) —
   pure addition, no existing behavior touched.
3. Fix module/string.js: `bind('String', …)` early-exit (§1), `strcat`'s
   per-part `v` computation + `partStrI64`'s fallback (§2). Add the two
   import-line deltas.
4. Fix src/compile/emit-assign.js:562 `keyExpr` (§3) — one line.
5. Flip the 3 PENDING_FIX rows (String(), template literal, computed member
   key) to AGREE in test/kernel-oracle.js, following the exact comment style
   of the 13 already-flipped rows (cite this design doc, note the mechanism).
   Leave `captured-then-read` in PENDING_FIX untouched.
6. Run every gate in the Self-host risk section, in order. Any failure at
   the dist-rebuild step: stop, do not patch around it blindly — re-read the
   DECL-INIT WALL entries in carrier-invariant-design.md first; this exact
   failure signature (clean native tests, broken self-compile) has a
   documented investigation protocol there (forced `JZ_DEBUG_INVARIANTS`
   build).
7. Optional, low-risk cleanup (not required for the fix, do only if time
   permits and gates are clean): replace module/core.js:1706's inline
   `hasAmbiguousBoolMerge(a) ? emitIdentitySafe(a) : emit(a)` with the new
   bridged `argIR(a)` — removes the 3rd duplicate, DRY, zero behavior change
   (identical body).
8. Optional, scoped follow-up (Finding #2, recommend same session): sweep
   the READ-side computed-key family in module/array.js (10 sites listed
   above) with the same `emit(idx)` → `storedValue(idx)` swap, add AGREE
   oracle rows (not PENDING-FIX). If deferred, leave a comment at each site
   pointing at this design doc so it doesn't silently join the "un-traced"
   backlog.

## Open questions

None — the task's own "expect none" holds. Every decision above is settled
by reading (the mechanism, the exact sites, the cost, the self-host gate)
rather than a judgment call only the user could make.
