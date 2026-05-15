/**
 * src/abi/number — number carriers.
 *
 * One file holds every strategy the compiler may pick for a number-typed
 * binding. Today `nanboxF64` is the only carrier; flat-i32 / flat-f64
 * specialization is achieved through direct type narrowing in `narrow.js`
 * (Phase E i32 results, Phase E3 pointer results, locals/params lifted by
 * the fixpoint) rather than via a carrier-bundle dispatch. The single-carrier
 * `ctx.abi` infrastructure is scaffold for the architectural cleanup that
 * would migrate those narrowed cases into named carriers here. See
 * `.work/todo.md` "Boundary protocol and internal representation".
 *
 * Carriers:
 *   - `nanboxF64`  default. f64 carrier with NaN-boxed pointers. Owns the
 *                  NaN-box-layout peephole folds — pure-WASM equivalences
 *                  (`wrap(extend x)→x`, `trunc(convert x)→x`, …) stay in
 *                  `src/optimize.js`; the folds here assume the low 32 bits
 *                  of a NaN-boxed f64 are the pointer offset.
 *
 * No `name`/`type` discriminant field — carriers are referenced by object
 * identity from the default-bundle in `src/abi/index.js`.
 *
 * @module src/abi/number
 */

// ── nanboxF64 ─────────────────────────────────────────────────────────────

export const nanboxF64 = {
  slotTypes: ['f64'],

  /**
   * Carrier-specific peephole rules — folds that depend on the NaN-box layout.
   * Called by the optimizer's fused-rewrite walk after generic folds; returns
   * a replacement node or `null` to leave the node unchanged.
   *
   * The folds:
   *   1. `i64.reinterpret_f64 (f64.reinterpret_i64 x)` → `x` — rebox-undo.
   *      Re-introduced by watr's inliner at boundaries (caller's `boxPtrIR(g)`
   *      meets callee's `i32.wrap_i64 (i64.reinterpret_f64 __env)`), so the
   *      post-watr reopt pass needs this to keep nanbox call boundaries clean.
   *   2. `f64.reinterpret_i64 (i64.reinterpret_f64 x)` → `x` — unbox-undo.
   *   3. `i32.wrap_i64 (i64.reinterpret_f64 (f64.load A ?off))` → `i32.load A ?off`.
   *      Wasm is little-endian; the low 32 bits of a NaN-boxed f64 at A are
   *      exactly i32.load(A). Saves two ops on every pointer extraction from
   *      an array slot or struct field.
   *   4. `i32.wrap_i64 (i64.reinterpret_f64 (call $__mkptr* … offset))` → offset.
   *      A NaN-boxed pointer keeps type/aux in the high bits and the i32
   *      offset in the low 32, so the f64 round-trip is pure overhead when the
   *      consumer only wants the offset. Covers generic `$__mkptr` and
   *      specialized `$__mkptr_T_A_d` trampolines (offset is the last arg).
   *   5. As (4) but reaching through `(block (result f64) … (call $__mkptr …))`
   *      — `new TypedArray(n)` lowers to this shape — by retyping the block
   *      to i32 and dropping the box on its tail.
   *   6. `i32.wrap_i64 (i64.or HIGH_ONLY (i64.extend_i32_* X))` → X.
   *      The NaN-tag-or-extend pattern: high bits hold the NaN prefix + tag,
   *      low 32 bits carry the i32 offset unchanged.
   */
  peephole(node) {
    const op = node[0]

    if (op === 'i64.reinterpret_f64' && node.length === 2) {
      const a = node[1]
      if (Array.isArray(a) && a[0] === 'f64.reinterpret_i64' && a.length === 2) return a[1]
      return null
    }

    if (op === 'f64.reinterpret_i64' && node.length === 2) {
      const a = node[1]
      if (Array.isArray(a) && a[0] === 'i64.reinterpret_f64' && a.length === 2) return a[1]
      return null
    }

    if (op === 'i32.wrap_i64' && node.length === 2) {
      const a = node[1]

      if (Array.isArray(a) && a[0] === 'i64.reinterpret_f64' && a.length === 2) {
        const inner = a[1]
        // (3) wrap(reinterpret(f64.load ADDR ?offset)) → (i32.load ADDR ?offset)
        if (Array.isArray(inner) && inner[0] === 'f64.load') {
          const out = ['i32.load']
          for (let i = 1; i < inner.length; i++) out.push(inner[i])
          return out
        }
        // (4) wrap(reinterpret(call $__mkptr* … offset)) → offset
        if (isMkptr(inner)) return inner[inner.length - 1]
        // (5) reach through (block (result f64) … (call $__mkptr*))
        if (Array.isArray(inner) && inner[0] === 'block' && isMkptr(inner[inner.length - 1])) {
          let ri = -1
          for (let i = 1; i <= 2 && i < inner.length; i++) {
            if (Array.isArray(inner[i]) && inner[i][0] === 'result') { ri = i; break }
          }
          if (ri >= 0 && inner[ri][1] === 'f64') {
            const tail = inner[inner.length - 1]
            const nb = inner.slice()
            nb[ri] = ['result', 'i32']
            nb[nb.length - 1] = tail[tail.length - 1]
            return nb
          }
        }
        return null
      }

      // (6) wrap(or HIGH_ONLY (extend X)) → X
      if (Array.isArray(a) && a[0] === 'i64.or' && a.length === 3) {
        const l = a[1], r = a[2]
        if (isHighOnly(l) && isExtend(r)) return r[1]
        if (isHighOnly(r) && isExtend(l)) return l[1]
      }
    }

    return null
  },
}

// ── helpers (carrier-local; cycle-safe — no src/* import) ─────────────────

const isMkptr = (n) => Array.isArray(n) && n[0] === 'call' && typeof n[1] === 'string'
  && (n[1] === '$__mkptr' || n[1].startsWith('$__mkptr_'))

const isExtend = (n) => Array.isArray(n) &&
  (n[0] === 'i64.extend_i32_u' || n[0] === 'i64.extend_i32_s') && n.length === 2

const isHighOnly = (n) => {
  if (!Array.isArray(n) || n[0] !== 'i64.const') return false
  const v = n[1]
  let bi
  if (typeof v === 'number') bi = BigInt(v)
  else if (typeof v === 'string') {
    try { bi = v.startsWith('-') ? -BigInt(v.slice(1)) : BigInt(v) } catch { return false }
  } else return false
  return (bi & 0xFFFFFFFFn) === 0n
}

// Default carrier — picked when narrower has no stronger evidence. Reached
// via `ctx.abi.number` (which the default-bundle in `src/abi/index.js` binds
// to this export).
export default nanboxF64
