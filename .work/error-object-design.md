# Error-object model + `instanceof` — design (2026-08-02)

Read-only deliverable. User decision (todo.md:704-706, "DECISIONS EXECUTED
2026-08-01"): "(4) Error model → BUILD: minimal Error objects (.message/
.name/instanceof, ~60-100B when constructed) + distinct per-site codes +
host-side code→message table." The latter two are DONE — err-codes.js's
`ERR`/`ERR_INFO` registry (48 sites, landed) and interop.js's `decodeThrown`
host-side resolution (commit 2a973082) already close those. This design
closes the remaining item: real in-wasm Error objects and the `instanceof`
subset that reads them. Prior investigation (todo.md:886-911, "ERROR-MESSAGE
EVAPORATION INVESTIGATED") already measured object machinery at ~60-100B and
found the 5KB fear was an unrelated String()/Ryu pull — that finding is the
size anchor for everything below.

## Ground truth (reproduced live)

```
new Error(msg) today: module/core.js:1768-1770 passthroughError — msg==null
  → UNDEF_NAN, else asF64(emit(msg)). No object. e IS the message value.
catch(e) binding: src/compile/emit.js:3961-3979 — e is the raw NaN-boxed f64
  thrown value, untouched. Never materializes anything.
String({x:1,y:2}) (dynamic param) → '{"x":1,"y":2}' (JSON-ish, NOT JS's
  '[object Object]' — pre-existing divergence, unrelated to this design).
`${o}` (dynamic param, template literal) → "" — EMPTY. __to_str's wasm body
  (module/string.js:1099) falls through to `(local.get $val)` — the raw
  OBJECT pointer bits reinterpreted as a string — for any tag it doesn't
  special-case (only ARRAY is, line 1096-1098). This is a genuine,
  pre-existing bug for ALL objects, not Error-specific — SURPRISING FIND,
  flagged in §Consequence below because it would make `${e}` on a caught
  Error silently wrong if not addressed in the same slice.
instanceof: src/op-policy.js:20 REJECT_OPS.instanceof — hard rejection,
  unconditional (rejectHandlers(err) spreads into prepare's `handlers` with
  nothing overriding it — src/prepare/index.js:2303). Fires in BOTH default
  and strict mode; test/errors.js:54's "strict rejects" title undersells it.
```

## 1. Error representation in-wasm

**Chosen: PTR.OBJECT + a single shared schema, reusing the existing schema
machinery (module/schema.js) verbatim — no new heap pointer tag, no new
runtime dispatch cases.**

Schema: `['message', 'name', '__errcls__']`, registered once via
`ctx.schema.register(...)` (module/schema.js:25-40 dedupes by prop-list
content, so every error-class constructor registering the identical array
gets back the same id — call it `ERR_SID`). Slot 2 (`__errcls__`) is a
compiler-internal f64-encoded small int (0-6, one per built-in class — see
§2), never exposed through dot-syntax (no source text can spell it — same
reservation convention as `'__inner__'` boxed-schema slot 0, schema.js:70,
and `__heap`/`__`-prefixed internal-name rejection, test/errors.js:217-218).

Construction reuses the exact runtime object-literal path (module/object.js:
206-220): `$__alloc_hdr(0, allocSlots(3))` then one `ctx.abi.object.ops.store`
per slot, then `mkPtrIR(PTR.OBJECT, ERR_SID, ptr)`. No new allocation
primitive. Per-instance cost: one 3-slot object (24B payload + 16B header =
40B) plus, for classes whose name exceeds SSO (`≤6` ASCII, layout.js
SSO_BIT) — every class but 'Error' itself — one SHARED static string
constant for `.name` (data-segment, amortized across all instances of that
class, zero marginal cost). Matches the ledger's ~60-100B estimate.

**Rejected: dedicated `PTR.ERROR = 5` tag** (layout.js's free tag, which the
task brief flags). Would let `.name` be *derived* from aux (no 3rd slot) and
make instanceof a pure tag+aux compare with no memory load at all — cheaper
per-instance than the schema approach. Rejected on blast radius: a new heap
pointer tag needs a new case in every PTR-tag switch in the codebase —
`__dyn_get`/`__dyn_set` (module/collection.js), JSON.stringify (module/
json.js), structuredClone, `typeof`/`__typeof` (module/core.js:1710-1744),
interop.js's `mem.read`/`mem.write`/`type()`, FORWARDING_MASK membership
(layout.js:47) — none of which know PTR.ERROR today. That is "genuinely
unbounded, no way to enumerate every site with confidence" (the same
standard maybe-undefined-design.md §1 used to reject MECHANISM-A-shaped
fixes) for a save of ~8B/instance on a cold path. PTR.OBJECT + schema flows
through every one of those switches for free, because Error becomes "just
an object."

**Rejected: tagged-pointer-wraps-message (no object at all, keep today's
model but box `.message`/`.name` via aux bits).** Can't fit 3 independent
fields (a dynamic message string pointer + a class tag + a mutable name) in
15 aux bits without another indirection — collapses back to "needs a heap
cell," i.e. the schema object, just reached less directly.

## 2. Constructor semantics

`ERR_CLASS_NAMES = ['Error','TypeError','RangeError','SyntaxError',
'ReferenceError','URIError','EvalError']` (index = `__errcls__` value) and
`ERR_SCHEMA_PROPS = ['message','name','__errcls__']` — **new exports in
err-codes.js** (project root, compiler-free, already the shared "which
ECMAScript error name" registry per its own docstring: "module/*.js and
src/ir.js pull ERR... never import compile/emit/ir modules here" — this
design's two new consumers, module/core.js and src/compile/emit.js, both
already satisfy that constraint).

**module/core.js:1758-1777** — replace the 7-line `passthroughError`
dispatch with a shared builder:
```js
const buildErrorObject = (className, msg) => {
  inc('__alloc_hdr')
  const sid = ctx.schema.register(ERR_SCHEMA_PROPS)
  const t = tempI32('errp')
  const nameIR = asF64(emit(['str', className]))          // static, shared per class
  const msgIR = msg == null ? asF64(emit(['str', '']))     // spec default: message omitted → ''
    : typed(['f64.reinterpret_i64', toStrI64(msg, emit(msg))], 'f64')  // ToString(msg)
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ctx.abi.object.ops.allocSlots(3)]]],
    ctx.abi.object.ops.store(['local.get', `$${t}`], 0, msgIR),
    ctx.abi.object.ops.store(['local.get', `$${t}`], 1, nameIR),
    ctx.abi.object.ops.store(['local.get', `$${t}`], 2, ['f64.convert_i32_s', ['i32.const', ERR_CLASS_NAMES.indexOf(className)]]),
    mkPtrIR(PTR.OBJECT, sid, ['local.get', `$${t}`])], 'f64')
}
for (const cls of ERR_CLASS_NAMES) ctx.core.emit[cls] = (msg) => buildErrorObject(cls, msg)
```
`toStrI64` (ir.js:1122, msg-coercion chokepoint) gives ToString(msg) with a
free identity fast path when msg is already proven a string — the common
`new Error("literal")` case pays nothing extra over today's `asF64(emit(msg))`.

**No `new`-dispatch change needed.** `new Error(x)`/`Error(x)` (with or
without `new`) already route to the identical `ctx.core.emit['Error']` key
— `includeForRuntimeCtor` (src/autoload.js:239-246) does not list Error, so
prepare's `'new'` handler (src/prepare/index.js:3503-3504) falls to the
generic "unknown ctor → plain call" path for it, same as today. Correct per
spec: `Error(x)` called without `new` also constructs a fresh Error.

**`throw errObj` writes to `$__jz_last_err_bits`: unchanged (emit.js:3952-
3959) — it's a bare `asF64(emit(expr))`, works identically whether `expr`
evaluates to a number, a string, or our new Error-object pointer.** No
change to the throw emitter.

## 3. catch binding

**Unchanged.** `catch(e)` (emit.js:3961-3979) binds `e` to the raw thrown f64
verbatim, regardless of what was thrown — number (internal code), string,
bool, or now an Error-object pointer. This is the right answer for all three
cases the task names:
- (a) user-thrown Error object → `e` is the OBJECT pointer; `.message`/
  `.name` reads and `instanceof` work via the mechanisms below.
- (b) internal coded throw → `e` is the raw f64 number, exactly as today.
  **No lazy materialization in this design's slices A/B** — see §5/§7 for
  why, and the explicit scope cut this implies.
- (c) non-error throws (`throw 42`, `throw "s"`) → `e` is that value,
  unchanged; `instanceof AnyClass` on it is `false` by construction (tag/
  range mismatch), never a crash — matches real JS (`42 instanceof TypeError
  === false`, no throw).

## 4. `instanceof` operator

**Truth table (LHS runtime kind × RHS class):**

| RHS | LHS is... | compile-time fold | runtime check |
|---|---|---|---|
| `Array` | provably ARRAY | `true` | `$__ptr_type(e) == PTR.ARRAY` |
| `Map` / `Set` | provably MAP/SET | `true`/fold | `$__ptr_type(e) == PTR.MAP/SET` |
| `Int8Array`…`Float64Array`, `BigInt64Array`, `BigUint64Array` | provably that `typedCtor` (reps.js `typedCtor` field) | fold | `$__ptr_type(e)==PTR.TYPED && $__ptr_aux(e)==elemCode` (encodeTypedElemAux, layout.js:102) |
| `ArrayBuffer` | provably BUFFER | fold | `$__ptr_type(e) == PTR.BUFFER` |
| `Error`/`TypeError`/…/`EvalError` (7 classes) | constructed via `new X(...)`/`X(...)` (AST shape `['()', className, ...]`) | fold `true` for exact class, `false` for a DIFFERENT one of the 7 (never confuse siblings) | tag+schema test (below) **OR** internal-code range test (below) |
| any other identifier (`Object`, `Function`, `RegExp`, `Promise`, `WeakMap`, `WeakSet`, user binding, computed expr) | — | — | **loud compile-time reject** |

**Error-family runtime check** (when LHS kind isn't provable — the
`catch(e){ e instanceof X }` common case):
```
i32.or
  ; (a) real Error object: tag+aux compare, same shape as emitSchemaSlotGuarded
  ; (module/core.js:1108-1110's objectSchemaGuardHex pattern) + one slot load
  (i32.and
    (i64.eq (i64.and bits OBJECT_SCHEMA_HI_MASK) objectSchemaGuardHex(ERR_SID))
    (f64.eq (load __errcls__ slot) (f64.const <classIdx>)))
  ; (b) internal coded throw: f64 range compare(s), see below
  (i32.or (f64.ge e (f64.const lo1)) (f64.le e (f64.const hi1))) ...
```
Ordered comparisons on a NaN bit pattern (any pointer, including our own
Error object, reinterpreted as f64) are `false` by IEEE754 — so arm (b)'s
range compares need **no prior "is this a real number" tag check**; a
pointer silently fails every `f64.ge`/`f64.le`, for free.

**Internal-code arm — derived, not hand-maintained ranges.** New
`err-codes.js` export:
```js
export const ERR_CODE_RANGES = (() => {
  const out = {}, sorted = Object.keys(ERR_INFO).map(Number).sort((a, b) => a - b)
  let run = null
  for (const code of sorted) {
    const name = ERR_INFO[code].name
    if (run && run.name === name && code === run.hi + 1) { run.hi = code; continue }
    run = { name, lo: code, hi: code }
    ;(out[name] ??= []).push(run)
  }
  return out
})()
```
Grouping the sorted, contiguous-by-value runs (not a hand-picked "1xx/2xx/
3xx" table) makes this immune to future insertions — err-codes.js's own
docstring already licenses renumbering ("Renumbering is safe"), so no
renumbering is actually needed: `TypeError→[[100,115]]`, `RangeError→
[[200,212]]`, `SyntaxError→[[300,302],[311,318]]` (two runs — URIError's
303-310 splits it), `URIError→[[303,310]]`, `ReferenceError`/`EvalError`→`[]`
(zero jz-internal sites — matches reality, never throws, instanceof is
correctly always-false via the empty range list). **Rejected alternative:**
a `br_table`/lookup-helper `$__jz_err_cls(code)`. More general, but a real
data table for no benefit — the actual class boundaries are ≤2 contiguous
runs each; inlining 2-4 f64 range compares per `instanceof <Class>` call
site is smaller and needs no shared function, no gating, no dep-graph entry.

**Compile-time fold, cheap tier (ships in slice B, not deferred):** a
literal-shaped LHS `['()', className, ...]` (i.e. `new TypeError(x)
instanceof TypeError` or the same value read straight from a `const`
binding whose ValueRep carries `schemaId === ERR_SID` — reuse the *existing*
`repOf(name)?.schemaId` field, reps.js:53, no new ValueRep field needed)
folds directly, matching every OTHER `valTypeOf`-driven instanceof fold in
the table above — same mechanism, not a special case.

**Loud rejection — prepare-time, new handler.** src/op-policy.js:20: delete
the `instanceof:` entry from `REJECT_OPS` (it becomes a real op, not a
blanket reject). src/prepare/index.js: add `'instanceof'(lhs, rhs)` to
`handlers` (near the `'new'` handler, ~3446), mirroring `shadowsBuiltin`
(src/prepare/index.js:979-980, already the guard `dispatchConstructorCall`
uses for the identical "is this identifier still the builtin" question):
```js
'instanceof'(lhs, rhs) {
  if (typeof rhs !== 'string' || shadowsBuiltin(rhs) || !INSTANCEOF_ALLOW.has(rhs))
    err(`instanceof: unsupported right-hand side (got ${JSON.stringify(rhs)}) — ` +
        `jz has no prototype chain; instanceof works only for Array, Map, Set, ` +
        `the TypedArray/ArrayBuffer constructors, and Error/TypeError/RangeError/` +
        `SyntaxError/ReferenceError/URIError/EvalError`)
  return ['instanceof', prep(lhs), rhs]
}
```
`INSTANCEOF_ALLOW` = `Array`, `Map`, `Set`, `ArrayBuffer`, `TYPED_CTORS`
(src/autoload.js:63), `ERR_CLASS_NAMES`. `WeakMap`/`WeakSet` are explicitly
EXCLUDED (not just omitted): they fold to Map/Set at parse time (src/
prepare/index.js:3454-3458, "no GC → weakness unobservable"), so a real
`new WeakMap()` value is tag-indistinguishable from Map at the point
`instanceof` would run — silently answering via the Map tag would be
confidently wrong (a real `new Map()` is never `instanceof WeakMap` in JS).
Reject, don't guess.

**Emitter** — src/compile/emit.js, new entry beside the `===`/`<`/`>`
cluster (~4526): `'instanceof': (a, rhs) => {...}` dispatching on `rhs` per
the table above.

## 5. Message strings — lazy inclusion

**User-constructed errors need no table at all**: the message is whatever
string expression the user passed to `new Error(msg)`, already emitted by
ordinary codegen (§2) — there is no code→message resolution step for this
path, so no gating question arises.

**Internal coded throws' `.message`/`.name` reads are OUT OF SCOPE for
slices A/B** (this is the one deliberate, named scope cut in this design).
`catch(e){ e.message }` on an internally-thrown code falls through jz's
EXISTING dynamic property-read path (schema-table dispatch, module/
collection.js's `__dyn_get`/`buildObjectSchemaArm`) — a NUMBER receiver has
no matching schema, so it reads `undefined`, exactly like today's pinned
"number.length returns undefined" behavior (test/errors.js:236-242) — no
crash, an honest gap, not a new one. Closing it needs a genuine code→message
table compiled into the module (err-codes.js's `ERR_INFO` messages, which
ARE real bytes — unlike the code→CLASS mapping in §4, there's no "just
compare ranges" trick for arbitrary message text). **Gate precedent to
reuse when this is built**: module/core.js's `__typeof` closure-arm splice
(core.js:1710-1716, `ctx.features.closure ? closureArm : ''`) — a WAT
runtime helper conditionally growing a fragment based on a whole-program
condition, checked at generation time, zero cost when absent. The condition
here would be "does any catch body read `.message`/`.name` off a name bound
by that catch clause" (or, conservatively, "is `.message`/`.name` read
anywhere at all," matching `includeForProperty`'s existing per-prop
granularity, src/autoload.js:230-234). Left unbuilt — flagged as slice C/D,
not required for a landable slice A or B.

## Consequence found while reading: `String(e)`/`` `${e}` `` on the new
object must not regress

`toStrI64` (ir.js:1122-1147) is the ONE chokepoint both `String()` (module/
string.js:2036-2063, its final fallback) and template-literal interpolation
(module/string.js's `strcat`/`partStrI64`, per the maybeUndefined design's
own citation) route through for a non-primitive operand. Its current OBJECT
branch (line 1131, gated on `ctx.closure.call` — a genuinely different
condition than anything Error needs) tries a user-defined `toString`/
`valueOf` method chain, then falls to generic `__to_str`. `__to_str`'s wasm
body (module/string.js:1077-1099) has NO general-object case — only ARRAY
is special-cased (line 1096-1098); everything else (including OBJECT) falls
through to `(local.get $val)`, returning the raw pointer bits AS a string
value. Live probe confirms this is already wrong for template literals on
ANY dynamic object (`` `${o}` `` → `""`) — pre-existing, not Error-specific.
`String(o)` measured correct-looking JSON for the same value, so there is a
SEPARATE existing OBJECT-aware path somewhere upstream of `__to_str` for
`String()` specifically that this investigation did not fully trace (out of
budget) — not necessary to resolve for this design, because **whatever it
is, it is not the real-JS-correct `"TypeError: msg"` format**, so it must be
overridden for Error, not relied upon.

**Required fix, same slice as §2 (this is not optional polish — without it,
`` `${e}` `` on a caught constructed Error goes from correct (today's
message-passthrough model) to silently empty, a real regression):** add an
Error-schema special case to `toStrI64` (ir.js, right after the `vt ===
VAL.STRING` identity check, before the existing `vt === VAL.OBJECT`
toPrimitiveChain branch) that recognizes (a) statically, `ctx.schema.idOf(node) === ERR_SID`,
or (b) dynamically, a runtime tag+aux guard identical in shape to §4's
Error-object arm — and in both cases emits `name + ": " + message` (spec's
`Error.prototype.toString`: name if message is empty, message if name is
empty, `name + ": " + message` otherwise, `"Error"` if both empty) via the
ordinary `+` string-concat path, not a new primitive. Gate this branch's
existence in the *compiled module* on whether `ERR_SID` was ever registered
(mirrors `__typeof`'s closure-arm pattern, §5) — a program that never
constructs an Error pays nothing extra in `__to_str`'s dispatch.

## 6. Self-host risk + gates

**Touched files**: err-codes.js (2 new exports, pure data, no behavior
change to existing exports — zero risk to existing 48-site consumers).
module/core.js:1758-1778 (Error ctor family — self-hosted; the compiler's
own `throw`/`catch` sites that construct `new Error(...)`/`new TypeError
(...)` for compile errors are HOST-SIDE JS `Error`, not jz `Error` — this
change affects only *compiled jz programs'* Error, not the compiler's own
error reporting. Confirmed no self-host blast radius from this alone).
src/op-policy.js:20 (delete one entry). src/prepare/index.js (new handler,
additive). src/compile/emit.js (new emitter entry, additive — the emitter
table dispatches by `node[0]` string key; adding `'instanceof'` cannot
change any existing key's behavior). src/ir.js `toStrI64` (touched function
is on the self-hosted compiler's OWN string-formatting hot path — any
program that calls `String()`/uses a template literal on an object,
INCLUDING the compiler compiling itself, executes the new early-exit check;
it is a cheap `ctx.schema.idOf`/tag compare that is false for every
non-Error object, so behavior for every existing call site is unchanged —
still needs the DECL-INIT-WALL-class caution the maybeUndefined design
flagged for near-identical-looking `ir.js`/`string.js` changes). interop.js
`decodeThrown` (host-side only, not compiled — zero self-host risk).

**Self-host fixed-point risk is concentrated in `toStrI64`**, the one
touched function actually on the compiler's self-compilation path. Every
other change is either pure data (err-codes.js), additive dispatch-table
entries (emit.js/prepare's handler map), or host-side-only (interop.js).

**Gates** (mirrors maybeUndefined-design.md's own list): repro-first (a
failing `e instanceof TypeError` / `e.message === undefined` case red before,
green after, for both slices); full battery (test/index.js TESTS); kernel-
parity (byte-identical O0/O2/O3, since this changes emitted bytes for any
program using Error/instanceof); kernel-oracle; fresh dist rebuild ×2 (self-
host fixed point, verifying `toStrI64`'s new branch doesn't perturb the
compiler compiling itself — the exact class of bug the DECL-INIT WALL
precedent warns about); selfhost.js + selfhost-perf.js (warm/fresh caps);
minimal-output.js full run (error-free programs must show zero new bytes —
add a new pin: `'export let f = (a,b) => a+b'` compiles byte-identical
before/after, since Error/instanceof code paths are unreached); a NEW
minimal-output pin for "a program that constructs one Error and does
nothing else" staying in the ~60-100B ballpark (regression guard on the
ledger's own measurement); perf-ratchet (instanceof's new range/tag compares
inside a hot loop would show up here — unlikely in the bench corpus per the
maybeUndefined design's own "point reads, not loop bodies" precedent for
similar dispatch-adjacent features, but check, don't assume); watr self-host.

## 7. Slicing

**Slice A — Error object + construction + catch (unchanged) + String()/
template-literal fidelity + interop decode.**
- err-codes.js: `ERR_CLASS_NAMES`, `ERR_SCHEMA_PROPS` exports.
- module/core.js:1758-1778: `buildErrorObject` replacing `passthroughError`
  for the 7 classes.
- src/ir.js `toStrI64`: Error-schema early-exit arm (§Consequence).
- interop.js: import `ERR_CLASS_NAMES` (alongside existing `ERR_INFO`
  import, line 29); `decodeThrown` (line ~756) gains an `__errcls__`-gated
  branch building the real host `Ctor` from `value.name`/`__errcls__`,
  ahead of the existing `typeof value === 'number'` branch. **Rejected
  alternative**: trust `value.name` alone (skip `__errcls__`) — rejected
  because a plain user-thrown object coincidentally shaped `{name:'Array',
  message:'x'}` would then wrongly upgrade to a host `Array` "error." The
  `__errcls__` sentinel (only jz's own constructors ever write it) is the
  correctness gate.
- test/errors.js:755-764 REWRITTEN (not deleted — the div­ergence pin
  flips to a correctness pin): `e.message === 'boom'`, `e.name ===
  'TypeError'`, `String(e) === 'TypeError: t'`, `` `${e}` === 'Error: x' ``.
  Every OTHER test/errors.js pin (host-decode, trap-lowering, dead-throw
  carrier) is untouched — none of them construct a jz-side Error object.
- Gate: full list in §6, scoped to this slice's files.

**Slice B — `instanceof`.**
- src/op-policy.js:20: delete `instanceof` from `REJECT_OPS`.
- src/prepare/index.js: new `'instanceof'(lhs, rhs)` handler +
  `INSTANCEOF_ALLOW` set.
- src/compile/emit.js: new `'instanceof'` emitter (~4526), dispatching per
  §4's table — Array/Map/Set/TypedArray/ArrayBuffer tag compares (no
  dependency on Slice A) AND the Error-family tag+schema+range compares
  (depends on Slice A's `ERR_SID`/`ERR_CLASS_NAMES`/`ERR_CODE_RANGES`).
- err-codes.js: `ERR_CODE_RANGES` derived export.
- test/errors.js: replace/extend `'strict rejects: instanceof'` (test
  currently at line 54) — keep the reject-path test for an unsupported RHS
  (`x instanceof SomeUserThing`), add accept-path tests for every row of
  §4's table including the internal-code arm (`try{JSON.parse('x')}
  catch(e){return e instanceof SyntaxError}` → `true`).
- Gate: full list in §6.

**Slice C (optional, deferred) — lazy code→message table** per §5's gate-
precedent sketch. Independent of A/B; closes `.message`/`.name` on an
internally-thrown code. Sized separately because it introduces a genuinely
new gated-inclusion mechanism (not reuse), the highest-novelty piece here.

**Slice D (optional, deferred, pure optimization) — compile-time constant
`schemaId`-based instanceof fold beyond the `['()', className, ...]` literal
shape** (e.g. flow-narrowed catch bodies where every reachable throw is
provably one class) — no correctness value, only saves a runtime compare;
not worth its own design pass until a bench corpus shows it matters.

## Open questions

None — the engineering calls above (schema over new PTR tag; unchanged
catch; derived contiguous-range internal-code check over a lookup table;
WeakMap/WeakSet rejected as instanceof RHS; internal-code `.message`
deferred to slice C) are each made and justified inline. The one item that
is genuinely a product call rather than an engineering one: whether Slice C
(internal-code `.message`) is worth building at all before real usage shows
demand — flagged, not decided, matching this ledger's own convention for
priority-only questions.

## As-landed corrections (audit-#8 P0-1/2/3, 2026-08-03)

Three independent soundness failures were found live at HEAD minutes after
Slice A/B shipped — none caught by the gates above, because all three were
either default-mode-only (the gates above ran strict-mode source) or a
design error in §4 itself, not an implementation slip. Recorded here because
§4's own text still describes the pre-fix (unsound) shape in two places.

**P0-1 — default mode never reached this design at all.** §4's whole truth
table, and the `'instanceof'` handler/emitter it describes, is reached from
`src/prepare/index.js`/`src/compile/emit.js` — but `src/front.js` only runs
`prepare()` after jzify, and jzify (jzify/transform.js) has ALWAYS had its
own, older, separate `'instanceof'` handler that answers every RHS itself
(Array→`Array.isArray`, Map/Set/TypedArray→`__is_map`/`__is_set`/
`__is_typed`, everything else — including all 7 Error classes — to a bare
`typeof x === 'object'` guess). Slice B's sound machinery only runs in
STRICT mode, which skips jzify entirely (`src/front.js`: `if (!strict &&
jzify) parsed = jzify(parsed)`) — default mode (the common case) never
reached it. Live repro: `let e = new TypeError("x"); e instanceof
RangeError` answered `true` in default mode (JS: `false`) — jzify's
`typeof===object` fallback can't discriminate ANY object shape, let alone
sibling Error classes. Fixed by making jzify's handler PASS THROUGH every
RHS this design's core already supports (`CORE_INSTANCEOF_ALLOW` in
jzify/transform.js, built from the same two arrays — `TYPED_ELEM_NAMES`,
`ERR_CLASS_NAMES` — as prepare's `INSTANCEOF_ALLOW`) as a real
`['instanceof', val, rhs]` node, instead of answering it itself. jzify keeps
its OWN Promise/Iterator shape-probes (RHS names the core rejects — jz-level
semantics, not this design's). `src/compile/flow-types.js`'s
`extractRefinements` needed a matching update: it narrowed `x`'s VAL kind
from the OLD `__is_map`/`__is_set`/`__is_typed` call shape only: a new
`op === 'instanceof'` arm (`instanceofRefinement`) reads the same fact off
the real `instanceof` node so `if (x instanceof Map) x.has(k)` still
devirtualizes to `__map_has` in default mode, not just strict.

**P0-2 — the internal-code range arm (§4, "internal-code arm — derived, not
hand-maintained ranges") was a DESIGN ERROR, not an implementation bug.**
The arm tested whether an internally-thrown NUMBER fell inside
`ERR_CODE_RANGES[class]` and treated a match as `instanceof class ===
true`. This is unsound by construction: jz's internal error codes and a
user's own `throw <number>` are the SAME representation (a raw f64 NUMBER,
error-object-design.md §3(b) already says this) — there is no tag bit that
distinguishes "the compiler threw 300" from "the user threw 300". Live
repro: `export let f = x => x instanceof SyntaxError; f(300)` answered
`true` for an ARBITRARY CALLER-SUPPLIED NUMBER that happened to land in
SyntaxError's derived range (300-302, 311-318) — nothing to do with
JSON.parse. The arm is deleted (`emitErrorInstanceof`, src/compile/emit.js);
internal-code catches are now honestly `instanceof`-false for every Error
class, same treatment as any other non-Error thrown value (§3(c)) — this
also means a provably-NUMBER LHS now folds to a compile-time `false`
(`vt !== VAL.OBJECT` alone, not `vt !== VAL.OBJECT && vt !== VAL.NUMBER`),
which is BOTH sounder and cheaper than before. `err-codes.js`'s
`ERR_CODE_RANGES` export is kept (unused by `instanceof` now) as the exact
data a future catch-site materialization would key off of — see Slice C
below, unchanged in shape, still the only sound way to recover this.
test/errors.js's internal-code-arm pins (`JSON.parse` SyntaxError,
`Array#with` OOB RangeError) are FLIPPED from `true` to `false`, both modes,
with the mechanism recorded inline.

**P0-3 — `__errcls__` (§1's schema slot 2) was documented as "never exposed
through dot-syntax" but nothing enforced it.** `e.__errcls__ = 2` compiled
and silently flipped `instanceof` (repro: an object that should be
`TypeError` read back `instanceof RangeError === true` after the write);
`Object.keys`/`JSON.stringify`/`for-in` all showed the slot. Investigated
the preferred fix (give each of the 7 classes its own schema id, so identity
lives in the pointer's aux bits and `__errcls__` can be deleted outright):
`ctx.schema.register` (module/schema.js) dedupes PURELY by prop-list content
(`props.length + '\x01' + props.join('\x01')`) with no per-caller "force a
distinct id" parameter — giving 7 classes 7 different ids would need either
7 different prop lists (which breaks the shared `.message`/`.name` slot
layout every consumer relies on) or register-signature surgery touching
every one of its callers (module/object.js literals, prepare's schema
tracking, JSON.parse's runtime schema cache). Ruled structurally out of
reach for a P0 fix, same standard §1's own PTR.ERROR rejection used
("genuinely unbounded, no way to enumerate every site with confidence").
Landed the documented fallback instead — the slot stays, but:
  - `src/prepare/index.js`'s `'.'` handler rejects `.__errcls__` in both
    read and write position (`ERR_CLS_SLOT`, now exported from
    err-codes.js) — loud compile error, not silent.
  - Its `'{}'` handler rejects `__errcls__` as an object-literal key
    (shorthand and `key: value` forms both) — a literal `{message, name,
    __errcls__: N}` would otherwise register under the SAME schema id as a
    real Error object and forge `instanceof`.
  - Every enumeration emitter excludes it by name: `module/object.js`'s
    `emitKeysGeneric`/`__keys_ro` (compile-time-known schema) and
    `emitEnumerateObject`'s runtime schema-walk loop AND its for-in
    raw-array fast path (both gated on `ctx.features.error`); `module/
    json.js`'s `__json_obj` runtime stringify walk.
  - Went further than the documented-residual floor: the dyn GET/SET/DELETE
    dispatch (`module/collection.js`'s `buildObjectSchemaArm`/
    `buildObjectSchemaSetArm`/`buildObjectSchemaDelArm`) also excludes
    `ERR_CLS_SLOT` by comparing the interned key string at runtime
    (`schemaKeyEqPublic`), so a COMPUTED access (`e['__errcls__']`/`e['__err'
    + 'cls__']`) can no longer read the real classIdx or corrupt it either —
    a computed write lands in the ordinary dyn sidecar as ANY other unknown
    key would, and a computed read sees `undefined`. The one true residual
    left: object-SPREAD construction (`{...e, x: 1}`) was not audited for
    this session — flagged, not fixed, lowest-risk of the vectors since it
    requires an existing Error object to spread FROM in the first place.
  All of these gate on `ctx.features.error` (mirrors `emitErrorInstanceof`'s
  own gate) — a program that never constructs an Error pays nothing extra
  in Object.keys/JSON.stringify/dyn-dispatch codegen. Confirmed empirically:
  `extractF64Bits`/content-deduped static string literals
  (`module/string.js`'s `dataDedup`/`strPoolDedup`) make the runtime string
  comparison exact pointer equality, not a text scan.

**README correction (audit-#8 P2):** README.md's "What are the differences
with JS?" (~230) and "What will JZ never support" (~251) bullets still
described the PRE-Slice-A model (errors are message strings, no `.message`/
`.name`/`instanceof`) even though Slice A/B had already shipped before this
session — a documentation gap independent of the three P0s above. Rewritten
to state the CURRENT split honestly: constructed errors are real objects
throughout (in-wasm and at the host boundary); internal runtime-raised
errors stay raw numeric codes with `.message`/`.name` undefined and
`instanceof` `false` (not a guess), consistent with the P0-2 correction
above.

## Brand redesign (audit-#9 P0-2, 2026-08-04) — SUPERSEDES §1's `__errcls__`
## slot and the "As-landed corrections" P0-3 entry above

**Finding: the P0-3 patch was the enumerated-invariant disease it was trying
to cure, wearing a disguise.** §1 chose a shared schema (one sid for all 7
classes) with class identity in a hidden slot 2, because "`ctx.schema.register`
has no per-caller 'force a distinct id' mechanism… giving 7 classes 7
different ids would need… register-level surgery" (§1, and repeated verbatim
as the P0-3 investigation's own stated blocker). Both statements were true of
`ctx.schema.register`'s SIGNATURE, and both undersold how small the actual fix
was: `register(props, salt)` — one optional parameter, folded into the
existing content-based dedupe key (`props.length + '\x01' + props.join('\x01')
+ (salt ? '\x02' + salt : '')`), a no-op for the ~15 other call sites that
never pass it. The P0-3 patch instead spent its effort making the hidden slot
UN-REACHABLE (prepare-time rejection at 2 sites, runtime exclusion at 5 more)
rather than making it NOT EXIST — precisely the shape the task brief's own
directive named: "a hidden schema/header brand… not a source-visible
property," and precisely the shape that bit twice (P0-2 groups 1/2: two
compiler crashes from consumers that had never been taught the slot existed;
group 3: a stolen property name from a rejection this session deleted). The
audit's diagnosis stands as the general lesson: an enumerated invariant
("every consumer must remember to filter X") is not closed by a more complete
enumeration — it's closed by removing X from the set of things that need
filtering.

**The fix.** `ctx.schema.errorSid(className)` (module/schema.js) mints one
DISTINCT schema id per class, salted by the class name, all sharing the
IDENTICAL physical layout `['message','name']` — no reserved slot, nothing
unspellable, nothing to filter anywhere. instanceof reads the sid (masked
tag+aux compare, same `OBJECT_SCHEMA_HI_MASK`/`objectSchemaGuardHex` shape §4
already used, now one compare per relevant class instead of one compare +
one slot load). `.name`/`.message` are ordinary slots 1/0. A NEW prepare-time
fact, `ctx.features.errorClasses` (Set<className>, populated alongside the
existing `ctx.features.error` boolean), lets both instanceof's base-'Error'
OR-chain and toStrI64's Error-schema recognition arm iterate exactly the
classes the program can ever actually construct — a genuinely NEVER-
constructed specific class (`x instanceof RangeError` in a program that only
ever builds `TypeError`) now folds to compile-time `false`, a precision the
old shared-sid design's blanket boolean gate couldn't express.

**Consequence: the physical schema being genuinely, uniformly public makes
every P0-3 filter dead code, not just unreachable code.** `emitKeysGeneric`,
`__keys_ro`, `emitEnumerateObject`'s raw-array shortcut and its per-slot skip
loop, `module/collection.js`'s dyn GET/SET/DELETE dispatch, `module/json.js`'s
stringify walk — all had an `ERR_CLS_SLOT`-shaped carve-out; all deleted,
restoring each to the plain, schema-agnostic form it would have had if Error
had never existed. This is the "subtract, don't accrete" gate from first
principles: the P0-3 patch's ~120 lines of filtering across 5 files collapse
to zero, replaced by ~15 lines in one file (the `salt` param + 5 accessor
methods) that every consumer above gets for free by construction.

**Interop consequence — a new small custom section, not a design compromise.**
Moving identity into the sid instead of a decodable slot value means
`interop.js`'s `decodeThrown` (host-boundary Error reconstruction, §Slice A)
can no longer read class identity out of the decoded `{message, name}` object
— the sid is compiler-internal state that doesn't survive into the compiled
artifact on its own. Fix: `src/compile/index.js` emits a tiny `'jz:errcls'`
custom section (sid → className pairs, present only when the program
constructs at least one Error class) mirroring the existing `'jz:schema'`
section's own custom-section convention; `interop.js` reads it into
`mem.errorSidToClass` at instantiation, and `decodeThrown` looks up
`aux(errBits)` in it, gated on `type(errBits) === PTR.OBJECT` first (the
gate that prevents a numerically-coincidental aux value on some OTHER pointer
type from spoofing a class — the direct descendant of the old design's
`ERR_CLASS_NAMES[value.__errcls__] === value.name` cross-check, but sound for
a stronger reason: the sid is read off the pointer's own tag bits, which no
source-level write can reach, rather than a decoded property value that
COULD, in the old design, in principle be tampered with by anything that
found a way around the P0-3 rejections).

**Spread/Object.assign FROM an Error — fixes P0-2 groups 1/2, closes §1's own
flagged residual.** §1's P0-3 entry explicitly flagged spread as un-audited
("object-SPREAD construction… was not audited for this session"). Real JS:
`message`/`name` are OWN but NON-enumerable on a real Error
(`Object.getOwnPropertyDescriptor(new Error('x'), 'message').enumerable ===
false`, node-verified), so `Object.assign`/spread FROM an Error copies
NOTHING — the result is an empty plain object. `module/object.js` gained a
SOURCE-position-only override (`sourceSchema`, wrapping `resolveSchema`) that
answers `[]` for an Error-schema source — both the literal-call-shaped case
(`{...new TypeError(x)}`) and a bound variable's case (`let e = new
TypeError(x); {...e}`, which additionally needed a new prepare-time
declaration-schema binding for Error-constructor-initialized `let`s,
mirroring the existing object-literal case — without it, `repOf(name)
.schemaId` was never populated for this declaration shape at all, meaning
`instanceof`'s own "tier 2: bound name" fold documented in §4 was DEAD CODE
for exactly this shape before this session, never exercised by any live
program). This override is intentionally NOT a `resolveSchema` change: dot-
access, `instanceof`, `toStrI64`, JSON.stringify, and Object.keys/values/
entries/for-in are UNCHANGED (still see the real 2-slot layout — `Object.keys
(new TypeError('x'))` in jz is `['message','name']`, a PRE-EXISTING divergence
from real JS's `[]` that predates this session, out of scope, unaffected
either direction by this fix). The crash itself (group 1/2) was a SEPARATE,
general `__obj_clone` bug (any unknown-schema single-spread source hits it,
confirmed with a non-Error repro, `({...param})`) that Error incidentally
triggered because its schema was unrecognized, not because of anything
Error-specific — the fix above sidesteps it for Error by making the schema
KNOWN (empty), never by touching `__obj_clone` itself.

**Message coercion (audit-#9 P1, folded into this session since it shares the
ctor-path code this fix already touches).** ES 20.5.1.1: message argument
absent OR its VALUE is `undefined` → no message (`''`); otherwise
`ToString(message)`. Two independent, narrowly-scoped fixes in
`buildErrorObject`'s new `errorMessageIR`, neither touching `toStrI64` itself
(matching the established per-call-site convention other direct `toStrI64`
callers already follow — module/string.js's per-leaf template formatter,
`src/compile/emit.js`'s `+`-concat `strOperand` — rather than inventing a
`toStrI64`-internal special case, which would touch the compiler's own
self-hosted string-formatting hot path for a fix two call sites already show
the right shape for): (1) a statically-proven BOOL operand is boxed through
the same true/false `select` those other callers use BEFORE reaching
`toStrI64` — the raw unboxed 0/1 arithmetic carrier jz keeps booleans in was
hitting `coerceRest`'s i32-provable-NUMBER fast path un-guarded
(`new Error(false).message` read `"0"`); (2) a closed object-literal argument
(no spread, no `toString`/`valueOf` key — a STATICALLY PROVABLE empty
method chain, not merely an unproven one) resolves directly to the static
`'[object Object]'` tag, closing the one case of `toStrI64`'s generic-OBJECT
gap (error-object-design.md's own "Consequence" section, still open for any
OTHER dynamic object) that Error's own constructor can prove sound. The
undefined-vs-absent distinction routes through `isUndef` (the same helper
default-parameter substitution already uses), which folds to a compile-time
constant for any literal argument — the common `new Error("literal")` case
pays zero runtime cost, matching this design's own recurring performance
discipline.

**Gates, all green** — full 88-file battery (13 chunks), selfhost.js 21/21,
kernel-parity 33/33 byte-identical, kernel-oracle, perf-ratchet 10/10 (every
row +0), fuzz (2000×4), fresh `build-dist.mjs` ×2 byte-identical (wasm AND
js), a throwaway `git worktree` size spot-check (Error module 76B SMALLER at
O2; Error-free module byte-identical), per-instance heap footprint ~32B (was
~40B). Full account: `.work/todo.md`'s 2026-08-04 audit-#9 P0-2 entry.

## Findings 1-4 (audit-#10, 2026-08-04) — Object.assign provenance, general
## ToString(message), enumerability DECIDED, host-boundary return decode

Four independent gaps found live by audit-#10, none caught by any gate above
— three were reached only through AST shapes/call directions the Brand
redesign's own gates never exercised (a literal Object.assign target, a
BOUND non-literal message object, a RETURNED-not-thrown Error); the fourth
(enumerability) was a design-level inconsistency between two already-shipped
fixes (Object.keys/JSON.stringify vs. spread/assign), not an implementation
bug in either. Full technical account in `.work/todo.md`'s 2026-08-04 entry;
summarized here because they touch this design's own machinery directly.

**1 (P0) — Object.assign target provenance.** `resolveSchema` (module/
object.js) recognized the literal Error-constructor-call shape at SOURCE
position (`isErrorSchemaSource`, the "As-landed corrections"/"Brand redesign"
sections above) but never at Object.assign's TARGET position — a literal,
un-bound `Object.assign(new TypeError('x'), {...})` fell through to the
broken dynamic-assign path and crashed (`__arr_set_idx_ptr` never
registered). Fixed by moving the literal-shape recognition INTO
`resolveSchema` itself (so every consumer — Object.assign target, Object.keys/
values/entries on an unbound literal — gets it uniformly, not just the one
call site that crashed), and mirroring the identical branch into `src/kind.js`'s
`spreadSchema` (its own comment already requires agreement with
`resolveSchema` for the OBJECT-vs-HASH decision — was silently out of sync
for this exact shape until this fix).

**2 (P1) — message ToString, the bound-object gap.** `errorMessageIR`
(module/core.js) already routed any non-special-cased message through
`toStrI64`, the same chokepoint `String()` uses — the "general invariant" was
never actually absent. The real gap was narrower: `isClosedObjLiteralNoStringMethod`
only recognized the literal `{}` AST shape, not a BOUND name with an
equally-closed schema, so `let o = {x:1}; new Error(o)` fell into
`toStrI64`'s generic OBJECT fallback — which has its OWN pre-existing,
general (not Error-specific) bug this design's own "Consequence" section
already named and left out of scope (`__to_str` has no real object-rendering
case; a plain object round-trips as itself, not a string, confirmed live via
`typeof String(o) === 'object'`). Generalized the closed-world check
(`isClosedObjNoStringMethod`) from "AST is a `{}` literal" to "a bound name
whose declaration schema is closed" — same fix shape as #1. A truly EMPTY
`let o = {}` stays a residual (prepare.js never binds it a schema at all,
`props.length` guard) — general, pre-existing, out of this bundle's scope.

**3 (P1) — enumerability, DECIDED.** The "Spread/Object.assign FROM an
Error" section above gave Error's SOURCE-position schema `[]` (matching real
JS's non-enumerable message/name) while `Object.keys`/`JSON.stringify` (same
section, same session) kept the physical 2-slot schema (enumerable) — the
SAME object answering "does this enumerate" differently by which builtin
asked, an internally-impossible state. DECIDED here: documented divergence,
not full fidelity. Error is an ordinary, uniformly enumerable object on
every surface (keys/JSON/spread/assign/for-in) — diverges from real JS
(non-enumerable everywhere) but costs nothing, and the alternative (a per-
property enumerability flag reaching every enumeration site) is exactly the
enumerated-invariant shape this file's own "Brand redesign" section already
demonstrated is worse than removing the special case. `isErrorSchemaSource`
is deleted; `sourceSchema` is now `resolveSchema` verbatim.

**4 (P1) — host-boundary return decode.** interop.js's Error-class upgrade
(`mem.errorSidToClass`, "Interop consequence" section above) ran only inside
`decodeThrown`, reached exclusively by an escaping THROW — a function that
plainly `return`s a constructed Error decoded as a bare `{message,name}`
object at the host boundary, never `instanceof Error`. Fixed by extracting
the sid→class lookup into a shared `errorSidClassOf`, consumed by both
`decodeThrown` (unchanged behavior) and a new `readRet` wired into the
export-wrapper return path AND the async promise-settle path. A pre-
existing, general, Error-unrelated bug was found alongside this (an async
function that RESOLVES — not throws — with any heap value silently loses it
or traps, before host decode is ever reached) — flagged, not fixed, out of
this bundle's scope.

**Gates, all green** — repros red→green natively before each fix; full
88-file battery (15 chunks of ≤6); kernel-parity 33/33 byte-identical;
kernel-oracle 11/11; perf-ratchet 10/10 at +0; optimizer 214/214 (3949
assertions); errors.js BOTH modes (native + kernel-leg, 133/133 each — the
kernel-leg run needed a fresh `npm run build` first, since the kernel target
compiles against the committed `dist/jz.wasm` artifact, not live source);
dyn-keys.js 38/38 both legs; minimal-output.js unaffected (error-free module
byte-identical per its own pinned probe); selfhost.js 21/21; fuzz 2000×4
(seeds 1-8000) zero divergence; fresh `build-dist.mjs` ×2 byte-identical.
Full account: `.work/todo.md`'s 2026-08-04 audit-#10 Error-bundle entry.
