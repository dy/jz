/**
 * Module-level arena-rewind escape analysis — invoked from src/wat/assemble.js.
 *
 * @module optimize/arena-rewind
 */
import { findBodyStart } from '../ir.js'
import { walkAst } from '../ast.js'

/**
 * Module-level arena rewind: transitive escape analysis.
 *
 * Per-function `applyArenaRewind` in compile.js is limited to a static whitelist
 * of internal helpers. This pass generalizes by building a call graph and
 * propagating "arena-safe callee" status via fixed-point iteration.
 *
 * A function is an arena-safe callee if:
 *   - no global.set, call_indirect, call_ref in body
 *   - all user-function calls are to other arena-safe callees
 *
 * A function is arena-rewindable (gets heap save/restore injected) if:
 *   - single scalar result (f64 or i32)
 *   - contains allocation ($__alloc / $__alloc_hdr)
 *   - no global.set, return_call, call_indirect, call_ref
 *   - all user-function calls are to arena-safe callees
 *   - does NOT return a pointer (checked via ptrTypes map from compile.js)
 *
 * Unlike the per-function pass, this does NOT require 0 params.
 *
 * @param {Array[]} fns - Array of func IR nodes (sec.funcs + sec.stdlib + sec.start)
 * @param {boolean} sharedMemory - Whether memory is shared (affects heap get/set IR)
 * @param {Map<string, {ptrKind: *}|null>} [ptrTypes] - Map from func name to ptrKind info.
 *   Functions with ptrKind != null return pointers and cannot be rewound.
 *   If omitted, no pointer-return check is done (conservative: fewer functions rewound).
 */
export function arenaRewindModule(fns) {
  const BUILTIN_SAFE = new Set([
    '$__alloc', '$__alloc_hdr', '$__alloc_hdr_n', '$__mkptr',
    '$__ptr_offset', '$__ptr_type', '$__ptr_aux',
    '$__len', '$__cap', '$__typed_shift', '$__typed_data',
  ])

  // Phase 1: collect per-function metadata
  const fnMap = new Map()
  for (const fn of fns) {
    if (!Array.isArray(fn) || fn[0] !== 'func') continue
    const name = fn[1]
    if (typeof name !== 'string') continue

    let results = [], hasGlobalSet = false, hasReturnCall = false
    let hasCallIndirect = false, hasCallRef = false, hasAlloc = false
    const calls = new Set()
    const bodyStart = findBodyStart(fn)

    for (let i = 2; i < fn.length; i++) {
      const c = fn[i]
      if (!Array.isArray(c)) continue
      if (c[0] === 'result') { results.push(c[1] || c[2]); continue }
      if (i >= bodyStart) break
    }

    const recordEffect = node => {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === 'global.set') hasGlobalSet = true
      else if (op === 'return_call') hasReturnCall = true
      else if (op === 'call_indirect') hasCallIndirect = true
      else if (op === 'call_ref') hasCallRef = true
      else if (op === 'call') {
        const callee = node[1]
        if (callee === '$__alloc' || callee === '$__alloc_hdr' || callee === '$__alloc_hdr_n') hasAlloc = true
        if (typeof callee === 'string' && !BUILTIN_SAFE.has(callee)) calls.add(callee)
      }
    }
    for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: recordEffect })

    fnMap.set(name, {
      fn, results,
      hasGlobalSet, hasReturnCall, hasCallIndirect, hasCallRef, hasAlloc,
      calls: [...calls],
    })
  }

  // Phase 2: fixed-point transitive safety analysis
  const safeCallees = new Set(BUILTIN_SAFE)
  let changed = true
  while (changed) {
    changed = false
    for (const [name, info] of fnMap) {
      if (safeCallees.has(name)) continue
      if (info.hasGlobalSet || info.hasCallIndirect || info.hasCallRef) continue
      if (info.calls.every(c => safeCallees.has(c) || !fnMap.has(c))) {
        safeCallees.add(name)
        changed = true
      }
    }
  }

  return safeCallees
}
