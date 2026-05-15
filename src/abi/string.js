/**
 * src/abi/string — string carriers.
 *
 * One file holds every strategy the compiler may pick for a string-typed
 * binding. Carriers are named exports; the narrower tags each site with the
 * chosen carrier, and codegen reads `ctx.abi.string[<carrier>]` (today only
 * the default carrier `sso` is reached — per-site picking arrives with the
 * JS String Builtins specialization workstream).
 *
 * Carriers:
 *   - `sso`         default. NaN-boxed STRING pointer (PTR.STRING=4) with
 *                   Small-String-Optimization for ≤4 ASCII chars packed inline
 *                   in the aux+offset fields.
 *   - `jsstring`    architectural scaffold. Native JS strings via JS String
 *                   Builtins (`wasm:js-string` imports); externref slot. Empty
 *                   ops table — the 9-item compiler-wide checklist below blocks
 *                   real codegen.
 *
 * No `name`/`type` discriminant field — carriers are referenced by object
 * identity from the default-bundle in `src/abi/index.js`.
 *
 * @module src/abi/string
 */

// ─────────────────────────────────────────────────────────────────────────
// Op contract (shared by every carrier)
//
//     ops.<op>(...slotCarriers, ctx) → wasm IR
//
//   - Every string-valued argument is a **slot-carrier IR**: IR whose runtime
//     WASM value matches `slotTypes[0]`. Under `sso` that's `f64` (the NaN-
//     boxed pointer); under `jsstring` that's `externref`. The caller is
//     responsible for producing slot-carrier IR — typically
//     `asF64(emit(strNode))` today; once non-f64 string slots ship, call
//     sites switch to a carrier-driven `coerceSlot` helper.
//   - The op is self-contained: it inlines whatever WASM
//     reinterprets/wraps it needs to reach its stdlib helper signature.
//     `sso` emits `['i64.reinterpret_f64', sF64]` inline rather than
//     importing `asI64` from `src/ir.js` — this module is loaded transitively
//     from `src/ctx.js`, so importing back into `src/ir.js` would read
//     `LAYOUT.NAN_PREFIX_BITS` before `src/ctx.js`'s `LAYOUT` const is bound.
//   - `ctx` is the ambient compilation context, passed last. Each op
//     registers its stdlib dependency via `ctx.core.includes.add(name)`.
//
// Layout the `sso` ops are calibrated against (defined in `src/ctx.js`):
//   - LAYOUT.NAN_PREFIX_BITS, LAYOUT.TAG_SHIFT, LAYOUT.AUX_SHIFT,
//     LAYOUT.OFFSET_MASK, LAYOUT.SSO_BIT
//   - PTR.STRING = 4
// ─────────────────────────────────────────────────────────────────────────

// ── sso ───────────────────────────────────────────────────────────────────

// Local inline coercer — IR-only, no src/* import (cycle safety). Caller is
// expected to pass IR whose WASM-level value is already f64 (e.g. via
// `asF64(emit(strNode))`); this wraps the unbox to i64 the stdlib helpers
// take. Kept as a one-liner so each op reads as a single `call`.
const ssoI64 = (sF64) => ['i64.reinterpret_f64', sF64]

export const sso = {
  // Wasm slot type a string value occupies under this carrier: the f64
  // NaN-boxed slot (PTR.STRING tag in the high bits, SSO inline data or
  // 32-bit heap offset in the low). Read by `src/compile.js` signature
  // synthesis to type string params/returns at the JS↔wasm boundary.
  slotTypes: ['f64'],

  ops: {
    /** Byte length. Receiver: f64 slot carrier. Returns i32 — caller widens
     *  to f64 if it needs JS-spec `.length` semantics. */
    byteLen: (sF64, ctx) => {
      ctx.core.includes.add('__str_byteLen')
      return ['call', '$__str_byteLen', ssoI64(sF64)]
    },

    /** Char code at index i. Receiver: f64 slot carrier; index: i32. Returns
     *  i32 — 0 for out-of-bounds (NUL byte). Keeps tokenizer hot loops on the
     *  i32 ABI (no per-iteration f64 widen/truncate). User code that wants
     *  JS-spec NaN-for-OOB can guard with an explicit length check. */
    charCodeAt: (sF64, iI32, ctx) => {
      ctx.core.includes.add('__char_at')
      return ['call', '$__char_at', ssoI64(sF64), iI32]
    },

    /** Content equality. Both args: f64 slot carriers. Returns i32 boolean. */
    eq: (aF64, bF64, ctx) => {
      ctx.core.includes.add('__str_eq')
      return ['call', '$__str_eq', ssoI64(aF64), ssoI64(bF64)]
    },

    /** Three-way byte compare. Both args: f64 slot carriers. Returns i32 ∈ {-1, 0, 1}. */
    cmp: (aF64, bF64, ctx) => {
      ctx.core.includes.add('__str_cmp')
      return ['call', '$__str_cmp', ssoI64(aF64), ssoI64(bF64)]
    },

    /** Concat with ToString coercion on both sides. Both args: f64 slot
     *  carriers. Returns f64 (the new STRING ptr's slot carrier). */
    concat: (aF64, bF64, ctx) => {
      ctx.core.includes.add('__str_concat')
      return ['call', '$__str_concat', ssoI64(aF64), ssoI64(bF64)]
    },

    /** Concat assuming both sides are already strings (skip ToString). */
    concatRaw: (aF64, bF64, ctx) => {
      ctx.core.includes.add('__str_concat_raw')
      return ['call', '$__str_concat_raw', ssoI64(aF64), ssoI64(bF64)]
    },
  },
}

// ── jsstring ──────────────────────────────────────────────────────────────
//
// Architectural scaffold for native JS strings via JS String Builtins.
// Under this carrier, string values flow across the wasm boundary as
// `externref` instead of nanbox-tagged heap offsets. String operations
// (`length`, `charCodeAt`, `concat`, `fromCharCode`, …) are emitted as
// calls to imports from the `wasm:js-string` namespace — engine-provided
// builtins that read/write the engine's native String representation.
//
//   Spec: https://webassembly.github.io/js-string-builtins/js-api/
//   Engine support: V8 17+, Safari 18.4+, Firefox behind a flag.
//
// ### Status — scaffold, not a working codegen path
//
// Today this carrier exists to:
//   1. Slot into the default-bundle in `src/abi/index.js` so the dispatch
//      infrastructure is exercised end-to-end with two carriers.
//   2. Document the contract future string-codegen rerouting will plug into.
//   3. Outline the compiler-wide changes a real implementation requires —
//      they're larger than "fill in the ops table" and need their own plan.
//
// Until those changes land, `jsstring` is exported alongside `sso` but the
// default bundle in `src/abi/index.js` still picks `sso`. The narrower will
// flip individual sites to `jsstring` once the codegen paths below are real.
//
// ### Wire shape
//
//     (import "wasm:js-string" "length"        (func $__jss_length        (param externref) (result i32)))
//     (import "wasm:js-string" "charCodeAt"    (func $__jss_charCodeAt    (param externref i32) (result i32)))
//     (import "wasm:js-string" "concat"        (func $__jss_concat        (param externref externref) (result (ref extern))))
//     (import "wasm:js-string" "compare"       (func $__jss_compare       (param externref externref) (result i32)))
//     (import "wasm:js-string" "test"          (func $__jss_test          (param externref)            (result i32)))
//     (import "wasm:js-string" "fromCharCode"  (func $__jss_fromCharCode  (param i32)                  (result (ref extern))))
//     (import "wasm:js-string" "substring"     (func $__jss_substring     (param externref i32 i32)    (result (ref extern))))
//
// ### Compiler-wide checklist (dependency order)
//
//   1. **Import declaration channel.** Mirror `ctx.core.includes` for
//      `wasm:js-string` imports — a `ctx.core.imports` set that compile.js
//      drains into `(import ...)` nodes. The string-builtins API is feature-
//      detected (`WebAssembly.validate` with the import set), so the host
//      must either gate compile output on builtins support or polyfill the
//      imports from JS for older engines.
//
//   2. **STRING-typed locals as externref.** `ctx.func.locals` today stores
//      `'f64' | 'i32'` per local; STRING locals need `'externref'`. Touch
//      every site that declares string locals (closures, params, refinements,
//      destructuring) so the WAT `(local $name externref)` lands.
//
//   3. **emit() returns externref for STRING-typed nodes.** Today every
//      `emit(strNode)` returns f64-typed IR carrying a NaN-boxed pointer.
//      Under jsstring it must return externref-typed IR. The `asF64` call
//      sites currently feeding the carrier would route through a carrier-
//      driven `coerceSlot(emit(...))` helper instead, so the slot type swap
//      is transparent to callers.
//
//   4. **Boundary wrappers.** `src/compile.js:synthesizeBoundaryWrappers`
//      types every string param/result through f64 (or i64 for ptr carriers).
//      Read `ctx.abi.string.slotTypes[0]` — if `externref`, declare the
//      param/result `externref` and skip the nanbox box/unbox steps.
//
//   5. **Literals.** `['str', "foo"]` today writes into the heap and returns
//      a NaN-boxed pointer. Under jsstring it would need a module-level
//      `externref` global initialized from a JS-side literal table — likely
//      via a startup import that hands back the canonical `externref` for
//      each known string. Or build at runtime with `fromCharCodeArray`.
//
//   6. **Mutating fast paths.** Heap-string optimizations like
//      `__str_append_byte` (mutate in place when lhs is heap-top) don't
//      translate — engine strings are immutable. These paths must gate off
//      under jsstring (`if (slotTypes[0] === 'f64') …`) or be removed from
//      the carrier's surface entirely.
//
//   7. **Cross-carrier interop.** Mixing nanbox numeric values and externref
//      strings in the same function means locals span two slot types.
//      `i32`/`f64`/`externref` already coexist (closures use `i32` for boxed
//      cells), so the multi-slot story is incremental, not novel.
//
//   8. **`?.length`, optional access.** The `?.` emit threads `local.get`
//      through `notNullish`, which today inspects f64 NaN-shape bits.
//      `externref` nullishness is a single `ref.is_null` (no NaN inspection),
//      so the optional-chain emit needs a carrier-aware nullish predicate.
//
//   9. **Host wiring.** `interop.js` passes externref strings directly
//      (no encode/decode) and supplies the `wasm:js-string` imports object
//      when the binary references any. JS strings already act as externrefs
//      at the host boundary — the bridge mostly hands them through.

export const jsstring = {
  // Wasm slot type a string value occupies under this carrier. Read by
  // `src/compile.js:synthesizeBoundaryWrappers` for param/result typing
  // (item 4) and by the slot coercer at every STRING `emit()` call site
  // (item 3).
  slotTypes: ['externref'],

  // Names of `wasm:js-string` imports this carrier relies on. Used
  // (eventually) by the compiler to declare the import nodes once any op
  // references them.
  imports: ['length', 'charCodeAt', 'concat', 'fromCharCode', 'substring',
            'codePointAt', 'compare', 'test', 'intoCharCodeArray', 'fromCharCodeArray'],

  // Op hooks — string operations the compiler routes through ctx.abi.string.
  // Populated incrementally as items 1–9 in the checklist land. Each op
  // receives externref-typed slot carriers and emits a `call` to its
  // wasm:js-string import. Empty today; the default-bundle entry for
  // `'nanbox+jsstring'` in `src/abi/index.js` still points at `sso` until
  // these are real.
  ops: {
    // byteLen: (sExtRef, ctx) => {
    //   ctx.core.imports.add('wasm:js-string', 'length')
    //   return ['call', '$__jss_length', sExtRef]
    // },
    // charCodeAt: (sExtRef, iI32, ctx) => {
    //   ctx.core.imports.add('wasm:js-string', 'charCodeAt')
    //   return ['call', '$__jss_charCodeAt', sExtRef, iI32]
    // },
    // eq: (aExtRef, bExtRef, ctx) => {
    //   ctx.core.imports.add('wasm:js-string', 'compare')
    //   return ['i32.eqz', ['call', '$__jss_compare', aExtRef, bExtRef]]
    // },
    // cmp: (aExtRef, bExtRef, ctx) => {
    //   ctx.core.imports.add('wasm:js-string', 'compare')
    //   return ['call', '$__jss_compare', aExtRef, bExtRef]
    // },
    // concat: (aExtRef, bExtRef, ctx) => {
    //   ctx.core.imports.add('wasm:js-string', 'concat')
    //   return ['call', '$__jss_concat', aExtRef, bExtRef]
    // },
    // concatRaw is identical to concat here — `wasm:js-string.concat` doesn't
    // do ToString coercion; both sides are already strings by typing.
    // concatRaw: (aExtRef, bExtRef, ctx) =>
    //   ctx.core.imports.add('wasm:js-string', 'concat') ||
    //   ['call', '$__jss_concat', aExtRef, bExtRef],
  },

  // No peephole — string ops don't share the nanbox layout's reinterpret/
  // wrap surface, so there's nothing carrier-specific to fold. (`nanboxF64`
  // keeps its peephole; carriers that don't need one simply don't expose it.)
}

// Default carrier — picked when narrower has no stronger evidence. Reached
// via `ctx.abi.string` (which the default-bundle in `src/abi/index.js` binds
// to this export).
export default sso
