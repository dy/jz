# stdlib generators: string.js / array.js — map + refactor record

Baseline: b70dd817 (branch point). Follows `.work/stdlib-generators.md`'s
precedent (collection.js → collection/upsert.js+durable.js, typedarray.js →
typedarray/simd-map.js+elem-tables.js).

## Shape difference from the precedent (read before the plan below)

collection.js/typedarray.js had cohesive generator families defined as
**top-level functions BEFORE** the `export default (ctx) => {...}` closure,
each called from exactly one site inside the closure — a clean "helper
function, single call site" shape.

string.js/array.js are structured differently: `wat(name, body)` /
`bind(name, handler)` / `ctx.core.stdlib[name] =` / `ctx.core.emit[name] =`
calls (the two registration dialects, CONTRIBUTING.md "Stdlib registration")
are interleaved **throughout** the closure body — each runtime primitive is
defined and registered in the same place, not built by a separate generator
called later. There is no large detached "generator family" of the
collection.js probe-family shape in either file.

What IS real, matching the task's own target categories ("template-fragment
generator families, encoding tables, SIMD/scalar codegen factories"):

- **string.js** has two genuinely self-contained, single-purpose encoding
  subsystems near the end of the file, each already delimited by the
  original author's own structure (a `deps()`-map comment grouping for the
  first, a `// ===` section marker for the second): the URI percent-codec
  (`encodeURIComponent`/`encodeURI`/`decodeURIComponent`/`decodeURI`) and the
  base64/hex codec (`btoa`/`atob` + the `Uint8Array.fromBase64/toBase64/
  fromHex/toHex/setFrom*` runtime primitives typedarray.js's emitters call by
  name). Both are PURE MOVES.
- **array.js**'s core (allocation, indexed read/write, grow/relocate,
  push/pop/shift/splice/unshift, map/filter/reduce/forEach + their upstream-
  fusion optimization) is one deeply-interconnected web with no low-fan-in
  seam — same verdict as collection.js's "general primitives... stays" and
  typedarray.js's registration bulk. Two genuinely self-contained families
  DO exist, each with a single external call-site cluster: the callback-
  invocation strategy (`makeCallback`'s inline-vs-closure fast path) and the
  early-exit iteration family (`.some`/`.every`/`.find*`). Both need the same
  shared leaf (mirrors durable.js/elem-tables.js's cycle-avoidance role) to
  move without creating a cycle.
- `arrMethod` (array.js) is grep-verified DEAD — defined once, zero call
  sites anywhere in the repo. Deleted (task step 4), not moved.

## string.js map (2883 lines before)

- 1-38: imports, module doc, i64-hex consts. **Stays.**
- 39-158: SSO codec (`ssoEncode`/`MAX_SSO`/`ssoAux`/`ssoCharWat`/`ssoLenWat`/
  `ssoLenFromAux`/`heapLenExpr`/`sliceSsoPackWat`/`internProbeWat`), top-level
  (before the closure). `ssoCharWat` alone has ~20 call sites from line 106
  to 1184; `ssoAux` used up to line 2169. File-wide utility, exactly the
  collection.js "general primitives used file-wide" pattern. Also has an
  existing external consumer (`module/collection.js` imports `ssoEncode`).
  **Stays.**
- 160-236: `export default (ctx) => {` open, the `deps()` stdlib-dependency
  map (flat name→name[] data, location-independent — doesn't force anything
  to stay together), doc comment. **Stays.**
- 237-2220: core string primitives — literal construction, char extraction,
  eq/cmp, byteLen, slice (incl. no-copy view), substring-equality fusion,
  indexOf/lastIndexOf, repeat, ToString coercion, byte copy, bump-extend
  concat family, split, join/array-to-string, pad, then "Method emitters"
  (the JS-level `bind()` dispatch table: slice/indexOf/replace/case/pad/
  charAt/charCodeAt/String()/fromCharCode/fromCodePoint/.../.encode/.decode/
  .encodeInto — dozens of methods sharing small helpers like `sliceEmitter`/
  `posIndex`/`searchArg`/`stringSearchMethod`/`caseMethod`/`padMethod`/
  `charAtOr`). Deeply interconnected, high fan-in both ways (shared local
  helpers used by many unrelated methods). **Stays** — this is the module's
  load-bearing core + its own registration bulk, same role as collection.js's
  "general primitives" + "module wiring".
- **2222-2407 (186 lines): URI percent-codec family.** `URI_RESERVED`/
  `uriReservedTest`/`uriSafeTest`/`uriEncodeKernel`/`uriEncodeBind`/
  `wat('__uri_hex',...)`/`uriKeepReserved`/`uriDecodeKernel`/`uriDecodeBind`
  + the 6 `wat()`/`bind()` registrations for `encodeURIComponent`/
  `encodeURI`/`decodeURIComponent`/`decodeURI`. Grep-verified: every one of
  these JS names is used ONLY inside this range (repo-wide, module/ + src/).
  `__uri_hex` is also called at the WASM level from `__hex_dec_raw` (base64
  family, line 2834 pre-move) — a runtime `call $__uri_hex` inside a WAT
  template string, not a JS symbol reference, so it needs no JS import
  either direction (name-keyed registration, order-independent — module/
  index.js's own doc: "Order matters only for readability"). **MOVES** to
  `module/string/uri.js`.
- 2409-2579: `.at`/`.search`/`.match`/`__wrap1`/TextEncoder+TextDecoder
  dummies/`.encode`/`.decode`/`.encodeInto` — general methods interleaved
  between the two encoding families, no dedicated `===` marker, low
  standalone value to split further. **Stays.**
- **2581-2882 (302 lines): base64/hex codec family**, under the file's own
  `// === base64 / hex codecs ===` marker (also independently grouped in the
  `deps()` map with its own comment, line ~206 pre-move: "base64/hex codec
  family (Uint8Array.fromBase64/toBase64/…, atob/btoa)"). `b64put`/
  `__b64_enc`/`__b64_dec_raw`/`__u8_data`/`__btoa`/`__atob`/`__b64_from`/
  `__b64_set`/`__hex_enc`/`__hex_dec_raw`/`__hex_from`/`__hex_set` +
  `bind('btoa',...)`/`bind('atob',...)`. Grep-verified: every name used only
  inside this range in string.js; module/typedarray.js references 6 of these
  names (`__b64_enc`/`__u8_data`/`__b64_from`/`__b64_set`/`__hex_enc`/
  `__hex_from`/`__hex_set`) but only via `inc('name')` — a runtime dependency
  string, not a JS import — pre-existing, unaffected by which file registers
  them. **MOVES** to `module/string/base64.js`.
- 2883: closing `}`.

No cycle risk for either move: neither new file imports from the other or
from `../string.js`; both import only from `../../src/*`.

## array.js map (2790 lines before)

- 1-33: imports, module doc, `NOT_ARRAY_OR_TYPED`. **Stays.**
- 34-64: `allocArray`/`staticArrayPtr` (exported, used by module/collection.js
  nowhere — only array.js's own array-literal path) — general alloc helpers.
  **Stays.**
- **66-72: `hoistArrayValue`.** Pure (`temp`/`asF64`/`emit`/`typed` only, no
  `ctx` dependency). Used by ~20 call sites across the WHOLE file (splice,
  reverse, sort, indexOf, includes, lastIndexOf, slice, concat, map/filter/
  reduce/forEach fusion, earlyExitMethod). **MOVES** (leaf — see below).
- 74: `arrayLenFromPtr` — used only by map/filter (fusion fast paths, stay in
  array.js). **Stays.**
- **76-108: pure-expression AST check** (`NOT_PURE_OPS`/`isPureExpr`/
  `substExpr`/`exprUses`) — private support for `makeCallback`'s inline
  fast-path test. Not used anywhere else (distinct from the separately-named
  `isPureCallback`/`collectLocals` at line 2005ff, which is map/filter/
  reduce/forEach's OWN fusion-purity check and stays in array.js). **MOVES**
  (leaf).
- **110-178: `makeCallback`** — the callback-invocation strategy: inline a
  literal-arrow pure-expression body with zero closure allocation, or fall
  back to `ctx.closure.call`. Used by Array.from, earlyExitMethod, and
  map/filter/reduce/reduceRight/forEach (14 call sites total). **MOVES** (leaf).
- **180-203: `callbackArgReps`** — derives callback param val-type hints from
  the receiver. Used alongside `makeCallback` at the same call sites.
  **MOVES** (leaf).
- **205-210: `arrMethod`** — "Factory for simple arr→call stdlib patterns
  (mirrors strMethod in string.js)". Grep-verified DEAD: defined once, zero
  call sites anywhere in module/, src/, test/. **DELETED** (step 4), not moved.
- 212-298: `needsArrayDynMove`/`needsDurableFwdLog`/`arrayGrowDeps`/
  `DYN_PROPS_GLOBAL_SENTINEL`/`maybeDynMoveIR`/`headerPropsCopyIR`/
  `headerPropsToGlobalIR` — the array-resize dynamic-props relocation
  family. Looks collection.js-durable-family-shaped, but its consumers
  (`__arr_grow`/`__arr_grow_known`/`__arr_set_idx_ptr`/`__arr_push1`/
  `__arr_set_length`/`__arr_shift`/`__arr_unshift`/`__arr_splice`/
  `__arr_fill`/`__arr_copyWithin`) are scattered from line 300 to 2492 —
  the WHOLE registration bulk, not one call site. Not a PURE-MOVE candidate
  (would require fragmenting into the resize functions themselves, a much
  larger and riskier cut with no natural low-fan-in seam). **Stays.**
- 300-2041: `export default (ctx) => {` body — `deps()` map, array literal,
  index read/write, grow, push/pop/shift/fill/splice/unshift/copyWithin,
  `Array.from`'s two neighbors (`__arr_idx`/`__arr_idx_known`/`__arr_from`
  stay — general index/copy primitives, not Array.from-specific), and the
  map/filter/reduce/forEach fusion-detection helpers
  (`collectLocals`/`isPureCallback`/`detectUpstream`). Deeply
  interconnected. **Stays**, except the two carve-outs below.
- **457-663 (207 lines): `Array.from` family.** `isUndefinedNode`/
  `isNonCallableMapFn`/`arrayFromThrow`/`nanPtrTypeEq`/`callbackSetup`/
  `staticArrayLikeLength`/`ARRAY_FROM_MAX_LENGTH`/`toLengthIR` (all private,
  zero use outside this range) + the `ctx.core.emit['Array.from']`
  registration (single call site of every one of these helpers). Uses
  `makeCallback`/`idxArg` from the callback leaf (imports back). **MOVES**
  to `module/array/from.js`.
- **2043-2047: `idxF64`/`idxArg`.** `idxF64` note: a `const idxF64 = ...`
  inside Array.from's general-path branch (original line 624) SHADOWS the
  function locally — a same-named local variable, not a call to the
  function; grep-verified the function `idxF64` itself is called only from
  inside `idxArg`. Used by Array.from, earlyExitMethod, and map/filter/
  reduce/reduceRight/forEach. **MOVES** (leaf).
- **1927-1987 (61 lines): `earlyExitMethod` family.** The early-exit
  iterator factory + its 6 registrations (`.some`/`.every`/`.findIndex`/
  `.find`/`.findLastIndex`/`.findLast`) — single cluster, all 6 built from
  the one factory, matching the collection.js probe-family shape exactly
  (one parametrized generator, several call sites, all adjacent). Uses
  `hoistArrayValue`/`makeCallback`/`callbackArgReps`/`idxArg` from the
  callback leaf. **MOVES** to `module/array/early-exit.js`.
- 1989-2790: "Array methods" — map/filter/reduce/reduceRight/forEach (with
  upstream map/filter fusion), reverse/toReversed, sort/toSorted, .with,
  .copyWithin, Array.of, indexOf/includes/lastIndexOf, .at, .slice, .concat,
  .flat/.flatMap, .join. Deeply interconnected (shared `detectUpstream`/
  `isPureCallback`/`arrEqIR`/`undefNanIR`, high fan-in both ways). Imports
  `hoistArrayValue`/`makeCallback`/`callbackArgReps`/`idxF64`/`idxArg` back
  from the callback leaf. **Stays** otherwise.

### The callback leaf (cycle avoidance — mirrors durable.js/elem-tables.js)

`Array.from` and `earlyExitMethod` both need `makeCallback`/
`callbackArgReps`/`idxArg` (and `earlyExitMethod` also needs
`hoistArrayValue`); array.js's OWN remaining map/filter/reduce/forEach ALSO
need all of these. If they stayed in array.js, `array/from.js` and
`array/early-exit.js` would import them FROM `../array.js`, while
`array.js` imports its `Array.from`/early-exit registrations FROM those
files — a two-node cycle, exactly the class `resolveModuleGraph` rejects
(confirmed by the precedent for collection.js/upsert.js). Fix: extract
`hoistArrayValue` + the pure-expression trio + `makeCallback` +
`callbackArgReps` + `idxF64`/`idxArg` into **`module/array/callback.js`**, a
true leaf (imports only from `../../src/*`). `array.js`, `array/from.js`,
and `array/early-exit.js` all import from this sibling; the leaf imports
from none of them. One-directional star, no cycle.

## Commits

1. `.work/stdlib-string-array.md` (this file).
2. array.js: delete dead `arrMethod` (205-210).
3. PURE MOVE: `module/string/uri.js` extracted from string.js 2222-2407;
   string.js imports the 6 `bind()` names' registration back (calls the
   registration function at the original position).
4. PURE MOVE: `module/string/base64.js` extracted from string.js 2581-2882;
   string.js imports the registration function back.
5. PURE MOVE (leaf): `module/array/callback.js` extracted from array.js
   66-72, 76-203, 2043-2047 (hoistArrayValue, pure-expr trio, makeCallback,
   callbackArgReps, idxF64/idxArg); array.js imports
   `hoistArrayValue`/`makeCallback`/`callbackArgReps`/`idxF64`/`idxArg` back.
6. PURE MOVE: `module/array/from.js` extracted from array.js 457-663
   (post-step-5 line numbers); imports the callback leaf; array.js imports
   the registration function back.
7. PURE MOVE: `module/array/early-exit.js` extracted from array.js
   1927-1987 (post-step-6 line numbers); imports the callback leaf;
   array.js imports the registration function back.

## Verification

- Every extraction: sed-extracted body text vs. new sibling file body diffed
  byte-identical (mechanical, never retyped).
- `node scripts/refactor-oracle.mjs check --ref b70dd817` run after each
  commit.
- Full battery before reporting: oracle clean, `node test/index.js` (excl.
  bench-c.js), kernel build + `JZ_TEST_TARGET=jz.wasm node test/index.js`,
  `node test/kernel-parity.js`, kernel-oracle, kernel byte count before/
  after, `node scripts/bench-size.mjs --json`.

(Numbers filled in as commits land — see the final report.)
