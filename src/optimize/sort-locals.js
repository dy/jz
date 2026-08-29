/**
 * Encoding-compactness pass: reorder local decls for 1-byte LEB128 indices.
 *
 * @module optimize/sort-locals
 */
import { walkAst } from '../ast.js'

/**
 * Reorder non-param local decls by reference count (hot locals first).
 * WASM `local.get/set/tee` encode local idx as ULEB128 — 1 B for idx < 128, else 2 B.
 * Only the decl order changes; refs by name are unchanged and re-resolved by watr.
 * Params are fixed (their slot defines the call ABI) — only `(local …)` nodes move.
 */
export function sortLocalsByUse(fn, precomputedCounts) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const localIdxs = []
  let totalDecls = 0
  let i
  for (i = 2; i < fn.length; i++) {
    const c = fn[i]
    if (!Array.isArray(c)) continue
    if (c[0] === 'param' || c[0] === 'result') { totalDecls++; continue }
    if (c[0] === 'local') { localIdxs.push(i); totalDecls++; continue }
    break
  }
  if (localIdxs.length < 2) return
  if (totalDecls <= 128) {
    // Every index fits 1-byte LEB, so ordering is free for the body — group
    // same-type runs so the binary locals vector squashes to one (n, type)
    // entry per type instead of a run per interleaving (wasm-opt emits two
    // groups here; watr's encoder merges only CONSECUTIVE same-type runs).
    // Stable within a type: original declaration order.
    const TYPE_ORDER = { i32: 0, i64: 1, f32: 2, f64: 3, v128: 4 }
    const keyed = localIdxs.map((i, k) => [fn[i], k])
    keyed.sort((a, b) => ((TYPE_ORDER[a[0][a[0].length - 1]] ?? 9) - (TYPE_ORDER[b[0][b[0].length - 1]] ?? 9)) || (a[1] - b[1]))
    localIdxs.forEach((i, k) => { fn[i] = keyed[k][0] })
    return
  }
  let counts = precomputedCounts
  if (!counts) {
    counts = new Map()
    const recordRef = n => {
      if (Array.isArray(n) && (n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string')
        counts.set(n[1], (counts.get(n[1]) || 0) + 1)
    }
    for (let i = totalDecls + 2; i < fn.length; i++) walkAst(fn[i], { enter: recordRef })
  }
  const locals = localIdxs.map(i => fn[i])
  const TYPE_ORDER = { i32: 0, i64: 1, f32: 2, f64: 3, v128: 4 }
  // Hot-first for 1-byte LEB coverage; equal counts tie-break by type so the
  // locals vector still squashes into runs where frequency permits.
  locals.sort((a, b) => ((counts.get(b[1]) || 0) - (counts.get(a[1]) || 0)) ||
    ((TYPE_ORDER[a[a.length - 1]] ?? 9) - (TYPE_ORDER[b[b.length - 1]] ?? 9)))
  localIdxs.forEach((i, k) => { fn[i] = locals[k] })
}
