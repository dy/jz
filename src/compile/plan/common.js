/**
 * Shared AST utilities for plan/ subsystems.
 *
 * Helpers used by multiple subfiles (scalarize/loops/inline). Single-use helpers
 * stay with their consumer.
 *
 * @module compile/plan/common
 */

import { ctx } from '../../ctx.js'
import { ASSIGN_OPS, some, callArgs } from '../../ast.js'
import { constIntExpr } from '../../static.js'
import { typedElemCtor } from '../../type.js'
import { PASS_NAMES } from '../../optimize/index.js'

/** True iff the optimizer is active (any non-falsy pass under `ctx.transform.optimize`). */
export const optimizing = () => { const c = ctx.transform.optimize; return !!c && PASS_NAMES.some(n => c[n]) }

/** Ops whose body opens a new loop scope. (`for-in`/`for-of` excluded — they
 *  bind a fresh per-iter local on each entry, so jz lowers them differently.) */
export const LOOP_OPS = new Set(['for', 'while', 'do', 'do-while'])

/** Inline-substitution argument check — pure, side-effect-free, captures nothing. */
export const isSimpleArg = node => {
  if (typeof node === 'string' || typeof node === 'number') return true
  if (!Array.isArray(node)) return false
  if (node[0] == null) return typeof node[1] === 'number'
  if (node[0] === 'str') return typeof node[1] === 'string'
  if (node[0] === 'u-' || (node[0] === '-' && node.length === 2)) return isSimpleArg(node[1])
  if (['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>'].includes(node[0]))
    return isSimpleArg(node[1]) && isSimpleArg(node[2])
  return false
}

/** Maximum loop nesting under `node`. Closures (`=>`) opaque — their loops don't count. */
export const loopDepth = (node, depth) => {
  if (!Array.isArray(node)) return depth
  if (node[0] === '=>') return depth
  const here = LOOP_OPS.has(node[0]) ? depth + 1 : depth
  let max = here
  for (let i = 1; i < node.length; i++) {
    const d = loopDepth(node[i], here)
    if (d > max) max = d
  }
  return max
}

/** Node-count weight — drives inline cost heuristics. */
export const nodeSize = (node) => {
  if (!Array.isArray(node)) return 1
  let n = 1
  for (let i = 1; i < node.length; i++) n += nodeSize(node[i])
  return n
}

/** Collect every binder name in `node` into `out` (lexical-scope set; doesn't
 *  descend into nested arrow bodies — those open a new scope). */
export const collectBindings = (node, out) => {
  if (!Array.isArray(node)) return
  const op = node[0]
  if (op === '=>') return
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < node.length; i++) collectBindingTarget(node[i], out)
  }
  for (let i = 1; i < node.length; i++) collectBindings(node[i], out)
}

const collectBindingTarget = (node, out) => {
  if (typeof node === 'string') { out.add(node); return }
  if (!Array.isArray(node)) return
  if (node[0] === '=') collectBindingTarget(node[1], out)
  else if (node[0] === '...' && typeof node[1] === 'string') out.add(node[1])
  else if (node[0] === ',' || node[0] === '[]' || node[0] === '{}')
    for (let i = 1; i < node.length; i++) collectBindingTarget(node[i], out)
}

/** True iff `node` writes to any name in `names` (incl. `++`/`--` and compound assigns). */
export const mutatesAny = (node, names) => some(node, n => {
  const op = n[0]
  if ((op === '++' || op === '--') && typeof n[1] === 'string') return names.has(n[1])
  return ASSIGN_OPS.has(op) && typeof n[1] === 'string' && names.has(n[1])
})

/** Deep-clone array-tree AST. Plain values pass through by identity. */
export const clonePlain = node => Array.isArray(node) ? node.map(clonePlain) : node

/** AST index of a `for` loop's body, or null if `stmt` isn't a `for`.
 *  Handles both `['for', cond, body]` (3-arg while-like) and the full
 *  `['for', init, cond, step, body]` C-style form. */
export const forLoopBodyIndex = (stmt) =>
  Array.isArray(stmt) && stmt[0] === 'for' ? (stmt.length === 3 ? 2 : 4) : null

/** Reconstruct a `for` node with its body replaced. Preserves arity. */
export const withForLoopBody = (stmt, body) =>
  stmt.length === 3 ? ['for', stmt[1], body] : ['for', stmt[1], stmt[2], stmt[3], body]

// === Fixed-size typed-array recognition ===
// Shared by scalarize (replaces the literal with N locals) and inline (filters
// inlinings that would trample a typed-array param). Tables/thresholds live here
// so both subsystems agree on what "scalarizable" means.

/** Fixed-size typed-array ctors eligible for scalar replacement, mapped to the
 *  element store-coercion kind ('' = none, i.e. Float64Array's f64-identity).
 *  Excluded: Float32Array (Math.fround pulls module), Uint32Array (range > i32),
 *  Uint8ClampedArray (round-half-even clamp). Coerced (truthy) types are only
 *  scalarized when fully local. */
export const SCALAR_TYPED_COERCE = {
  'new.Float64Array': '',
  'new.Int32Array': 'i32',
  'new.Int16Array': 'i16', 'new.Uint16Array': 'u16',
  'new.Int8Array': 'i8', 'new.Uint8Array': 'u8',
}

// Default 64 covers the 8×8 block kernels (DCT/JPEG-shaped). Measured at 64
// elements: scalarized form is ~2.2× SMALLER (stores fold away; local refs
// out-LEB the memory ops they replace) and 2.5× faster than the memory form —
// there is no LEB128 cliff in practice.
export const maxScalarTypedArrayLen = () => ctx.transform.optimize?.scalarTypedArrayLen ?? 64

/** Recognize `new TypedArrayCtor(N)` with `N` a static small integer.
 *  Returns `{len, coerce}` or null. */
export const fixedScalarTypedArray = (expr) => {
  const ctor = typedElemCtor(expr)
  if (ctor == null || !(ctor in SCALAR_TYPED_COERCE)) return null
  const args = callArgs(expr)
  if (!args || args.length !== 1) return null
  const len = constIntExpr(args[0])
  return len != null && len >= 0 && len <= maxScalarTypedArrayLen()
    ? { len, coerce: SCALAR_TYPED_COERCE[ctor] } : null
}

/** Map of name → {len, coerce} for every fixed-size typed-array binding declared
 *  via `let`/`const` directly in `body` (no descent into nested arrows). */
export const fixedTypedArraysInBody = (body) => {
  const out = new Map()
  const walk = node => {
    if (!Array.isArray(node) || node[0] === '=>') return
    if (node[0] === 'let' || node[0] === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        const fixed = fixedScalarTypedArray(d[2])
        if (fixed != null) out.set(d[1], fixed)
      }
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return out
}
