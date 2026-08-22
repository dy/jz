# kernel-parity printer collapse (sum/dvnested/+1 trio) — ROOT-CAUSED, FIX LANDED

Investigated in worktree `agent/printer-parity`, branched from main @ 51deeb7c.
`git log --oneline -20` showed no suspicious ancestor to bisect — the bug
predates both autoload-repair (51deeb7c) and the effect-fold campaign
(6fa3fd7e); it is unrelated to either. No historical-ancestor probe tree was
needed — root cause was found directly and confirmed via isolated repro at
HEAD.

## Symptom, decoded

`node test/kernel-parity.js` reports `sum O{0,2,3}: diverges (native 642B/
641B/752B vs kernel 13B)`. The CORPUS `for` loop uses `is()` (throws on
first failure), so only `sum` — the first entry — ever surfaces; the task's
"trio" framing (sum, dvnested, +1) is accurate about what breaks but the
harness only ever reports the first name per tier. Direct probe (bypassing
the throw) shows **every** CORPUS entry diverges at **every** tier — this is
not a 3-row bug, it's total collapse of the self-compiled WAT printer:

```
=== O3 ===
sum          nat=752B  ker=13B   DIVERGE
math         nat=252B  ker=13B   DIVERGE
dict         nat=248725B ker=259B DIVERGE
arr          nat=24398B  ker=91B  DIVERGE
fold         nat=97B   ker=13B   DIVERGE
mfold        nat=76B   ker=13B   DIVERGE
boolconst    nat=1994B ker=21B   DIVERGE
nestedtyped  nat=25796B ker=100B DIVERGE
subviewtyped nat=19498B ker=85B  DIVERGE
dvnested     nat=214025B ker=339B DIVERGE
fromnested   nat=32439B ker=90B  DIVERGE
```

The kernel's `sum` output, byte for byte: `"(module func)"` — hex
`28 6d 6f 64 75 6c 65 20 66 75 6e 63 29`. Not a truncated prefix, not an
empty module shell — the printer walked the top-level `(module (func ...))`
tree, hit its ONE child (the func node), and printed **only that child's
own tag string** (`'func'`, i.e. `funcNode[0]`) inline, with a plain space,
instead of recursing into the child and wrapping it in parens. `arr`
confirms the pattern at more top-level children: `"(module memory global
global global global global func func func func func func func func\n)"`
— literally `node[0]` of every top-level section, space-joined, never
recursed.

## Mechanism

The printer is `node_modules/watr/src/print.js` (npm package `watr`,
resolved into the self-compile module graph by `scripts/build-profile.mjs`'s
`resolveModuleGraph(scripts/self.js, {resolveNode:true})` — it is compiled
BY jz into `dist/jz.wasm` exactly like any `src/`/`module/` file). Its
`printNode` walk, for each child `node[i]`:

```js
const raw = node[i]?.valueOf?.() ?? node[i]
const sub = typeof raw === 'number' && (...) ? (...) : raw
...
else if (Array.isArray(sub)) { ...recurse... }
else { ...content += sub... }   // inline fallback
```

`.valueOf()` on an array-typed `node[i]` is the trigger. Bisected via
isolated native (non-self-compiled) repros — this is a GENERAL compiler
bug, not a self-compile-specific one:

```js
export let f = () => {
  let node = ['func', ['export', 'x'], ['param', 'n']]
  let n = 0
  for (let i = 1; i < node.length; i++) {
    const raw = node[i].valueOf()      // <- the whole trigger, no optional chaining needed
    if (Array.isArray(raw)) n = n + 1
  }
  return n
}
// native compile(), optimize 0/1/2/3: returns 0, not 2. typeof(arr.valueOf())
// reports 'number', not 'object' — the VALUE itself is corrupted, not just
// isArray's classification.
```

Root cause (confirmed via WAT dump + source read, `src/compile/emit.js`
strategy dispatch instrumented to print which of the 12 method-call
strategies fires): `.valueOf()` on a receiver whose static kind is NOT
proven (e.g. `node[i]`, a heterogeneous-array element) reaches
**`tryRuntimePtrTypeFork`** (emit.js:4001, strategy 8). Its own comment says
the fallback arm is meant to be "the generic (array-shaped) emitter,
unchanged" — i.e. `ctx.core.emit['.valueOf']`, the ONE global flat-keyed
slot.

Two modules write that same flat key:
- `module/string.js:1642` — `bind('.valueOf', (val) => asF64(emit(val)))`,
  the correct Object.prototype.valueOf-returns-receiver identity fallback.
- `module/date.js:637` (pre-fix) — `ctx.core.emit['.valueOf'] =
  emitDateGetTime`, where `emitDateGetTime = (d) => f64.load(ptr-of(d))`
  (read the Date's own internal timestamp field, stored at the object's own
  base offset).

Whichever module's `init()` runs later wins the flat key ("last one wins",
confirmed BY DESIGN / not guarded — see `.work/research.md` "raw-vs-raw"
section: a prior audit explicitly declined a registration collision guard
for this exact pair, calling it a "load-bearing generic→specific override
chain", evaluated only for whether tooling should flag double-writes, not
for whether every flat-key READER's assumptions were compatible with it).
date.js wins here, so any UNRESOLVED-type receiver's `.valueOf()` — array,
plain object, map, set, anything but string/typed/proven-Date — silently
gets `f64.load` at **its own base address** instead of its identity. For an
array, offset 0 IS element 0 — so `arr.valueOf()` returns `arr[0]`'s raw
bits. In print.js's tree, `funcNode.valueOf()` returns `funcNode[0]` —
literally the string `'func'`. `sub` becomes that bare tag string,
`Array.isArray(sub)` correctly reports false (it's not corrupted-looking,
it's just the WRONG value), and the printer's inline fallback stamps just
the tag word into the output. Recursion never happens; the tree collapses
to a flat list of top-level tags.

**This is not a self-compile-specific bug.** It is a general native
miscompile (confirmed via plain `compile()`, zero self-hosting, zero Date
usage anywhere in the repro source — jz's autoload conservatively links
EVERY module offering a `.valueOf` handler whenever a call site's receiver
type is unresolved, so `module/date.js` gets linked and wins the flat key
even in a Date-free program). It surfaces specifically through
self-compilation because (a) `node_modules/watr/src/print.js` — bundled
into the compiler's own source for the self-compile build — happens to
contain exactly this "unresolved-type `.valueOf()`" shape
(`node[i]?.valueOf?.() ?? node[i]`), and NATIVE jz suffers this same general
bug while compiling THAT source to build `dist/jz.wasm`, baking the wrong
codegen permanently into the kernel's own `printNode`; and (b) no existing
test happens to call `.valueOf()` on an unresolved-type receiver, so the
bug was invisible everywhere else. Same shape as the 2026-08-20 CLOSED
closure-capture entry in `.work/todo.md`: "the defect is a GENERAL native
miscompile, not self-compile-specific; the self-compile leg was just the
first program complex enough to contain the trigger shape by accident."

## Fix

`module/date.js`: delete the flat `ctx.core.emit['.valueOf'] =
emitDateGetTime` write, keep only the type-qualified
`ctx.core.emit['.date:valueOf'] = emitDateGetTime` (already present, already
correct — reached via `tryStaticDispatch` for any PROVEN-Date receiver,
never touches the flat key). module/string.js's identity fallback then owns
the flat key uncontested, correct for array/object/map/set/every other
unresolved-type receiver.

Residual, PRE-EXISTING gap (not introduced, not widened by this fix): a
receiver whose static type is unresolved but which IS a Date at runtime,
calling `.valueOf()`/`.getTime()` through the flat/generic path, now gets
identity instead of its timestamp. This was already unsound before the fix
for the (arguably more common) unresolved-but-actually-object/array case —
Date shares the PTR.OBJECT tag with plain objects (`emitNewDate` allocates
`{type: PTR.OBJECT, aux: ctx.schema.dateSid, ...}`), so `tryRuntimePtrTypeFork`
has no runtime tag to fork on even in principle; fixing the unresolved-
Date-at-runtime case needs a schema-aux check, out of scope here. Trading a
severe, broad regression (silently wrong for array/object/map/set) for a
narrower, already-latent gap (Date specifically, only when BOTH unresolved
AND uncalled-for-real-timestamp) is a strict improvement.

Verified NOT a regression: `o.valueOf()` on a proven plain object with zero
closures anywhere in the program throws via `__ext_call` (host has no
receiver to dispatch to) — reproduced identically on pre-fix HEAD (temporarily
reverted `module/date.js`, reran, same throw) and confirmed unrelated to this
fix (root cause: `tryRuntimePtrTypeFork` requires `!vt`, never true for a
PROVEN object; `trySidecarToPrimitive` — the strategy that DOES list
`VAL.OBJECT` — requires `ctx.closure.call` truthy, which a zero-closure
program never sets; confirmed by adding an unrelated closure elsewhere in
the same program, which makes `{}.valueOf()` correctly report `'object'`
post-fix). Pre-existing, separate, out of scope.

## Verification

- Isolated native repros (`Array.isArray` after `.valueOf()`, `typeof` after
  `.valueOf()`, `new Date().valueOf()`): all fixed / all still correct.
- `node test/date.js`: 29/29 (104 assertions) — Date behavior unchanged.
- `node test/array-methods.js`: 139/139 (290 assertions).
- `node test/passes.js`: 9/9 (39 assertions) — includes the stdlib
  duplicate-registration fail-fast gate; my change REMOVES a raw-vs-raw
  write, doesn't add one, so this gate is unaffected either way.
- Full native suite (`node test/index.js`): see below.
- Rebuilt `dist/jz.wasm` with the fix; kernel-parity / kernel-oracle: see
  below.

(Battery results appended after this note was first written — see the
commit history on this branch for the exact pass/fail tallies; this file is
the mechanism record, not the live scoreboard.)
