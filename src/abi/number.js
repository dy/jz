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
 * `.work/archive/todo.md` "Boundary protocol and internal representation".
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
   * a replacement node or `null` to leave the node unchanged. (The folds that
   * hold in Wasm alone, the low word of a slot's load and of a high part or'ed
   * with a word, are the table's, optimize/rules.js; the cast round trips are
   * watr's `simplifyCast`.)
   *
   *   1. `i32.wrap_i64 (i64.reinterpret_f64 (call $__mkptr* … offset))` → offset.
   *      A NaN-boxed pointer keeps type/aux in the high bits and the i32
   *      offset in the low 32, so the f64 round-trip is pure overhead when the
   *      consumer only wants the offset. Covers generic `$__mkptr` and
   *      specialized `$__mkptr_T_A_d` trampolines (offset is the last arg).
   *   2. As (1) but reaching through `(block (result f64) … (call $__mkptr …))`
   *      — `new TypedArray(n)` lowers to this shape — by retyping the block
   *      to i32 and dropping the box on its tail.
   */
  peephole(node) {
    if (node[0] !== 'i32.wrap_i64' || node.length !== 2) return null
    const a = node[1]
    if (!Array.isArray(a) || a[0] !== 'i64.reinterpret_f64' || a.length !== 2) return null
    const inner = a[1]
    // (1) wrap(reinterpret(call $__mkptr* … offset)) → offset
    if (isMkptr(inner)) return inner[inner.length - 1]
    // (2) reach through (block (result f64) … (call $__mkptr*))
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
  },
}

// ── helpers (carrier-local; cycle-safe — no src/* import) ─────────────────

const isMkptr = (n) => Array.isArray(n) && n[0] === 'call' && typeof n[1] === 'string'
  && (n[1] === '$__mkptr' || n[1].startsWith('$__mkptr_'))
