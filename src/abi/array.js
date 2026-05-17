/**
 * src/abi/array — ARRAY backing-store carriers.
 *
 * An ARRAY value is an `__alloc_hdr` block — `[-8:len(i32)][-4:cap(i32)]` then
 * N element cells. The carrier owns where element `i` lives and how wide each
 * cell is. Every array-element access routed through `ctx.abi.array.ops` reads
 * layout from one place: the `[…]` literal store, the elem-schema fast-path
 * read, the `ir.js` element helpers (`slotAddr`/`elemLoad`/`elemStore`, and so
 * `arrayLoop`), the boxed-handle inner-array load.
 *
 * Ops are cycle-safe (no `src/*` imports) and return raw wasm IR arrays;
 * callers wrap in `typed()`. `base` is an i32 IR node holding the array's data
 * offset (post-header — a `['local.get', …]`, a `['local.tee', …]`, or a
 * `['call', '$__ptr_offset', …]` that follows the grow-forwarding chain). `idx`
 * is either a JS integer (constant slot — folds the multiply) or an i32 IR node
 * (runtime index).
 *
 *   taggedLinear — today's layout: every element one 8-byte f64 cell. An
 *                  element holds a raw f64 (Array<NUMBER>) or a NaN-boxed
 *                  pointer (Array<OBJECT|STRING>); both are 8 bytes wide, so
 *                  one carrier serves every plain `[]`.
 *
 *   structInline — SRoA layout for an `Array<{uniform K-field schema}>` whose
 *                  element pointers never escape as object identities: the K
 *                  f64 schema fields are inlined into the data region (stride
 *                  K), so `rows[i].x` is one direct `f64.load` with no per-row
 *                  object allocation and no pointer indirection. `len`/`cap`
 *                  still count *physical* f64 cells, so every stride-8 helper
 *                  (`__alloc_hdr`, `__arr_grow`, `__len`, `__set_len`) is
 *                  reused untouched — `.push` of a struct writes K cells and
 *                  adds K to `len`; `.length` divides the physical len by K.
 *                  Picked per-schema by `analyzeStructInline` (src/analyze.js),
 *                  whole-program, default-disqualify.
 *
 * Typed arrays (`Float64Array`/`Int32Array`/…) are a distinct value type
 * (`VAL.TYPED`, ctor-determined stride) handled by `module/typedarray.js`, not
 * a carrier here — they are not `VAL.ARRAY`.
 *
 * @module src/abi/array
 */

// Byte address of element `idx` off an i32 base. A JS-integer idx folds the
// `*8` (and idx=0 returns base untouched — matches `slotAddr`); an IR-node idx
// emits the runtime `i32.shl … 3`.
const addr = (base, idx) =>
  typeof idx === 'number'
    ? (idx === 0 ? base : ['i32.add', base, ['i32.const', idx * 8]])
    : ['i32.add', base, ['i32.shl', idx, ['i32.const', 3]]]

export const taggedLinear = {
  // Element operations the compiler routes array access through.
  ops: {
    // Byte address of element `idx` — for callers that need the address
    // itself (`slotAddr`) rather than a load/store.
    addr,

    // Element `idx` read as the canonical f64 value.
    load: (base, idx) => ['f64.load', addr(base, idx)],

    // Element `idx` read as raw i64 bits — moves a slot without reinterpreting
    // through f64.
    loadBits: (base, idx) => ['i64.load', addr(base, idx)],

    // Element `idx` write of an f64-typed value IR node.
    store: (base, idx, val) => ['f64.store', addr(base, idx), val],
  },
}

// structInline(K) — SRoA carrier factory. Logical element `idx` occupies K
// consecutive 8-byte cells; the carrier hands back the byte address of the
// element's first cell, and field `f` is then a plain `+f*8` composed by the
// schema slot machinery (`ctx.abi.object.ops`). Built on demand per schema
// (`K = ctx.schema.list[sid].length`) — not a `ctx.abi` default.
export const structInline = (K) => ({
  K,
  ops: {
    // Byte address of logical element `idx`'s first cell off i32 `base`.
    // A JS-integer idx folds to a constant; an IR-node idx emits `idx*K`
    // then the `<<3` (via `addr`).
    elemAddr: (base, idx) =>
      typeof idx === 'number'
        ? addr(base, idx * K)
        : addr(base, K === 1 ? idx : ['i32.mul', idx, ['i32.const', K]]),
  },
})

// Default carrier — picked when the narrower has no stronger evidence.
// Reached via `ctx.abi.array`.
export default taggedLinear
