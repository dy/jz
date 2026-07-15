/**
 * src/abi/object — OBJECT layout carriers.
 *
 * An OBJECT value is `__alloc_hdr` + N field cells; the carrier owns where
 * field `i` lives and how wide each cell is. Every object-field access in the
 * compiler — literal stores, `.prop` / `obj['k']` reads & writes, the bulk
 * copies in `Object.values`/`entries`/`assign`/`create` and object spread,
 * JSON-const objects, boxed-handle slot 0, `toPrimitive` method slots —
 * routes through `ctx.abi.object.ops` so layout lives in one place.
 *
 * Ops are cycle-safe (no `src/*` imports) and return raw wasm IR arrays;
 * callers wrap in `typed()`. `base` is an i32 IR node holding the object's
 * data offset (a `['local.get', …]` or a `ptrOffsetIR(…)` expression).
 *
 *   tagged  — today's layout: schema-tagged, every field one 8-byte f64 cell.
 *
 * A future `packed` carrier (narrowing per-field width from
 * `ctx.schema.slotIntCertain` / `slotTypes`) slots in here without touching a
 * single call site — that is the seam this file exists to provide.
 *
 * `flat` (SRoA) is the third object strategy but lives outside this seam: a
 * non-escaping `let/const o = {staticLiteral}` binding has no heap presence at
 * all — its fields are dissolved into plain WASM locals (`o#0`, `o#1`, …) and
 * `o.prop` compiles to `local.get`. It carries no memory base, so it cannot be
 * expressed as `ops.load(base, i)`; it is a binding-dissolution transform
 * driven by `scanFlatObjects` (src/analyze.js) and the codegen flat hooks
 * (emitDecl, the `.`/`[]` read & write emitters), not a layout carrier here.
 *
 * @module src/abi/object
 */

// Byte address of field `i` off an i32 base. idx=0 returns the base node
// untouched — matches `slotAddr` so routed sites stay byte-identical.
const addr = (base, i) => i === 0 ? base : ['i32.add', base, ['i32.const', i * 8]]

// 4-byte sibling for packed i32 cells.
const addr4 = (base, i) => i === 0 ? base : ['i32.add', base, ['i32.const', i * 4]]

/** Packed i32 field cells — the carrier for structInline arrays whose schema
 *  is all-strict-int32 (ctx.schema.inlineCellI32): field `i` is a raw i32 at
 *  `base + i*4`. Values are exact by the slotI32Certain census (every write
 *  provably int32, never -0), so loads/stores skip the f64 boxing layer
 *  entirely. Reached only through cursor/cell nodes tagged `.cellI32` — a
 *  standalone object of the same schema keeps `tagged` f64 slots. */
export const packedI32 = {
  ops: {
    addr: addr4,
    load: (base, i) => ['i32.load', addr4(base, i)],
    store: (base, i, val) => ['i32.store', addr4(base, i), val],
  },
}

export const tagged = {
  // Field operations the compiler routes object access through.
  ops: {
    // Heap cells `__alloc_hdr` must reserve for an N-field object. Floored at
    // 1 so a zero-field object still owns a header-addressable cell.
    allocSlots: (n) => Math.max(1, n),

    // Field `i` read as the canonical f64 value.
    load: (base, i) => ['f64.load', addr(base, i)],

    // Field `i` read as raw i64 bits — dyn-shadow writes and cross-schema
    // copies move slots without reinterpreting through f64.
    loadBits: (base, i) => ['i64.load', addr(base, i)],

    // Field `i` write of an f64-typed value IR node.
    store: (base, i, val) => ['f64.store', addr(base, i), val],
  },
}

// Default carrier — picked when the narrower has no stronger evidence.
// Reached via `ctx.abi.object`.
export default tagged
