/**
 * Shared AST utilities for plan/ subsystems.
 *
 * Helpers used by multiple subfiles (scalarize/loops/inline). Single-use helpers
 * stay with their consumer.
 *
 * @module compile/plan/common
 */

import { ctx } from '../../ctx.js'
import { ASSIGN_OPS, some, callArgs, walkAst } from '../../ast.js'
import { constIntExpr } from '../../static.js'
import { typedElemCtor } from '../../type.js'
import { PASS_NAMES } from '../../optimize/index.js'

/** True iff the optimizer is active (any non-falsy pass under `ctx.transform.optimize`). */
export const optimizing = () => { const c = ctx.transform.optimize; return !!c && PASS_NAMES.some(n => c[n]) }

/** Ops whose body opens a new loop scope. (`for-in`/`for-of` excluded — they
 *  bind a fresh per-iter local on each entry, so jz lowers them differently.) */
export const LOOP_OPS = new Set(['for', 'while'])

const SIMPLE_BINARY_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>'])
/** Inline-substitution argument check — pure, side-effect-free, captures nothing. */
export const isSimpleArg = node => {
  if (typeof node === 'string' || typeof node === 'number') return true
  if (!Array.isArray(node)) return false
  if (node[0] == null) return typeof node[1] === 'number'
  if (node[0] === 'str') return typeof node[1] === 'string'
  if (node[0] === 'u-') return isSimpleArg(node[1])
  if (SIMPLE_BINARY_OPS.has(node[0]))
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

// the source measure, beside the growth budget it serves
export { nodeSize } from '../../growth.js'

/** Collect every binder name in `node` into `out` (lexical-scope set; doesn't
 *  descend into nested arrow bodies — those open a new scope). */
export const collectBindings = (node, out) => walkAst(node, { enter: n => {
  if (n[0] === '=>') return false
  if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) collectBindingTarget(n[i], out)
} })

const collectBindingTarget = (node, out) => {
  if (typeof node === 'string') { out.add(node); return }
  if (!Array.isArray(node)) return
  if (node[0] === '=') collectBindingTarget(node[1], out)
  else if (node[0] === '...' && typeof node[1] === 'string') out.add(node[1])
  else if (node[0] === ',' || node[0] === '[]' || node[0] === '{}')
    for (let i = 1; i < node.length; i++) collectBindingTarget(node[i], out)
}

/** True iff `node` writes a queried name; opts select the same scope boundary as some(). */
export const mutatesAny = (node, names, opts) => some(node, n => {
  const op = n[0]
  if ((op === '++' || op === '--') && typeof n[1] === 'string') return names.has(n[1])
  return ASSIGN_OPS.has(op) && typeof n[1] === 'string' && names.has(n[1])
}, opts)

/** Deep-clone array-tree AST. Plain values pass through by identity. */
export const clonePlain = node => {
  if (!Array.isArray(node)) return node
  const out = node.map(clonePlain)
  // (a function's parameter list or body: it has no `prototype`, jzify transform.js prototypeless)
  if (node.noProto) out.noProto = true
  // (a read buffer's constructor, plan/read-buffers.js: a copy reads what its source read)
  if (node.noFill) out.noFill = true
  return out
}

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
const SCALAR_TYPED_COERCE = {
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

/** Does `expr` allocate a FRESH typed-array buffer of static numeric length —
 *  `new Float64Array(N)` with N a compile-time integer? Excludes view ctors
 *  (`new Float64Array(someBuffer)` — the arg is a buffer ref, not an int), so the
 *  result provably aliases no other buffer. Used by param-distinctness. */
// A length no buffer can be: a constant, an operator's result, a list literal
// (copied), or a const of one. A bare name else may hold an ArrayBuffer, which
// the array would view.
const PRIMITIVE_LEN_OPS = new Set(['+', '-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>', '~', 'u-', 'u+'])
const primitiveLen = (a, consts) => constIntExpr(a) != null || typeof a === 'string' && consts.has(a) ||
  Array.isArray(a) && (a[0] == null || PRIMITIVE_LEN_OPS.has(a[0]) || a[0] === '[]' && a.length === 2)
const isFreshTypedArrayAlloc = (expr, consts) => {
  if (typedElemCtor(expr) == null) return false
  const args = callArgs(expr)
  return !!args && args.length === 1 && primitiveLen(args[0], consts)
}

/** Local names const-bound to a fresh typed-array allocation (each a unique buffer, distinct from
 *  every other such binding and from any pre-existing value). `const` only — an immutable binding
 *  always holds that fresh buffer. Element writes (`a[i]=…`) don't reassign `a`, so they're fine.
 *  `numbers` are names known to hold numbers (a function's number parameters), `freshFns` the
 *  functions each call of which returns a buffer it allocated (freshReturningFuncs). */
export const freshTypedArrayLocals = (body, numbers = null, freshFns = null) => {
  const fresh = new Set(), consts = new Set(numbers ?? [])
  walkAst(body, { enter: node => {
    if (node[0] === '=>') return false
    if (node[0] === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        if (isFreshTypedArrayAlloc(d[2], consts) || freshCall(d[2], freshFns)) fresh.add(d[1])
        else if (primitiveLen(d[2], consts)) consts.add(d[1])
      }
    }
  } })
  return fresh
}
const freshCall = (e, freshFns) => !!freshFns && Array.isArray(e) && e[0] === '()' && typeof e[1] === 'string' && freshFns.has(e[1])

/** The functions each call of which returns a typed array the call allocated: every `return`
 *  of the body (none of a nested function's) names a fresh local of its own, or an expression
 *  body is the allocation. Two calls' results are two buffers, as two allocations are. */
export const freshReturningFuncs = (funcs) => {
  const out = new Set()
  const numbersOf = (func) => new Set((func.sig?.params ?? []).filter(p => p.val === 'number' && !p.ptrKind).map(p => p.name))
  // (a function returning another's fresh result is fresh in its turn: a few rounds reach it)
  for (let round = 0, grew = true; grew && round < 4; round++) {
    grew = false
    for (const func of funcs) {
      const body = func.body
      if (!body || func.raw || typeof func.name !== 'string' || out.has(func.name)) continue
      const numbers = numbersOf(func)
      let ok = true, any = false
      if (!Array.isArray(body) || body[0] !== '{}') ok = any = isFreshTypedArrayAlloc(body, numbers) || freshCall(body, out)
      else {
        const fresh = freshTypedArrayLocals(body, numbers, out)
        if (!fresh.size) continue
        walkAst(body, { enter: n => {
          if (!ok || n[0] === '=>') return false
          if (n[0] === 'return') { if (typeof n[1] === 'string' && fresh.has(n[1])) any = true; else ok = false; return false }
        } })
      }
      if (ok && any) { out.add(func.name); grew = true }
    }
  }
  return out
}

/** Map of name → {len, coerce} for every fixed-size typed-array binding declared
 *  via `let`/`const` directly in `body` (no descent into nested arrows). */
export const fixedTypedArraysInBody = (body) => {
  const out = new Map()
  walkAst(body, { enter: node => {
    if (node[0] === '=>') return false
    if (node[0] === 'let' || node[0] === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        const fixed = fixedScalarTypedArray(d[2])
        if (fixed != null) out.set(d[1], fixed)
      }
    }
  } })
  return out
}
