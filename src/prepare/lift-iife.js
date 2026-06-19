/**
 * Lambda-lift immediately-invoked arrow literals (IIFEs).
 *
 * `(params => body)(args)` is lowered by jz's default path as a CLOSURE value invoked
 * via `call_indirect` through the uniform-f64 closure ABI. That ABI can't carry a
 * `v128`, so a SIMD IIFE — `(() => f32x4.…)()` — emits invalid wasm; it also pays a
 * closure alloc + indirect call for what is really a direct, single call.
 *
 * This pass rewrites each such IIFE into a TOP-LEVEL function whose free variables are
 * appended as parameters, and replaces the call with a direct call passing those vars:
 *
 *   let r = (() => { let t = f32x4.mul(a, a); return f32x4.add(t, …) })()   // captures a
 *     ⇓
 *   let ⟨lift⟩ = (a) => { let t = f32x4.mul(a, a); return f32x4.add(t, …) }  // hoisted to top
 *   let r = ⟨lift⟩(a)                                                        // direct call
 *
 * The lifted function flows through jz's monomorphic typed-function path (like any
 * `let f = (x) => …; f(v)`), so a captured/returned `v128` is typed `v128` from the
 * single call site — and `inlineOnce` then folds the single-caller body back in, so
 * there's no residual call. Capture is BY VALUE, which is exact for a synchronous
 * immediate invocation (the value at the call instant == what the closure would read);
 * the one divergence — a capture MUTATED inside the body, which a closure writes back
 * through its cell — is the bail below.
 *
 * Bails (leaving the closure path untouched) on: non-plain params (rest / default /
 * destructured), or a body that assigns any captured variable. Everything else folds.
 *
 * @module prepare/lift-iife
 */
import { T, extractParams, classifyParam } from '../ast.js'
import { findFreeVars, findMutations } from '../compile/analyze-scans.js'

// Build a comma-list operand node (the parser's shape) from an array of nodes.
const commaList = (items) =>
  items.length === 0 ? null : items.length === 1 ? items[0] : [',', ...items]

// Unwrap parenthesis nodes (`['()', x]`, length 2) to reach the inner expression.
const unwrapParens = (n) => {
  while (Array.isArray(n) && n[0] === '()' && n.length === 2) n = n[1]
  return n
}

// `['()', callee, args]` (length 3) whose callee unwraps to an arrow literal → that arrow.
const iifeArrow = (n) => {
  if (!Array.isArray(n) || n[0] !== '()' || n.length !== 3) return null
  const callee = unwrapParens(n[1])
  return Array.isArray(callee) && callee[0] === '=>' ? callee : null
}

// Plain-name params only; anything else (rest/default/destructure) → null (bail).
const plainParamNames = (arrow) => {
  const out = []
  for (const p of extractParams(arrow[1])) {
    const c = classifyParam(p)
    if (c.kind !== 'plain' || typeof c.name !== 'string') return null
    out.push(c.name)
  }
  return out
}

// Names a function binds: its plain params + every let/const name in its body, NOT
// descending into nested arrows (their locals are their own). Over-approximating
// within a frame is safe — a free ident only resolves to one of these if it's
// actually in scope at the reference. Used to scope captures to enclosing LOCALS
// (module-level names stay global refs in the lifted body, never captured).
const collectDeclNames = (decl, out) => {
  if (!Array.isArray(decl)) return
  if (decl[0] === '=' && typeof decl[1] === 'string') out.add(decl[1])
  else if (decl[0] === '=' && Array.isArray(decl[1])) collectPatternNames(decl[1], out)
  else if (typeof decl[1] === 'string') out.add(decl[1])
}
const collectPatternNames = (pat, out) => {
  if (typeof pat === 'string') { out.add(pat); return }
  if (!Array.isArray(pat)) return
  for (let i = 1; i < pat.length; i++) collectPatternNames(pat[i], out)
}
function functionLocals(paramNodes, body) {
  const names = new Set()
  for (const p of paramNodes) { const c = classifyParam(p); if (typeof c.name === 'string') names.add(c.name); else if (c.pattern) collectPatternNames(c.pattern, names) }
  const scan = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === '=>') return
    if (n[0] === 'let' || n[0] === 'const') for (const d of n.slice(1)) collectDeclNames(d, names)
    for (let i = 1; i < n.length; i++) scan(n[i])
  }
  scan(body)
  return names
}

export function liftIIFEs(ast) {
  if (!Array.isArray(ast)) return ast
  const lifted = []        // hoisted `['let', ['=', name, arrow]]` decls
  let uid = 0

  // Copy non-index node metadata (parser `.loc`, etc.) onto a rebuilt node so error
  // source-locations survive the transform.
  const copyMeta = (to, from) => { for (const k of Object.keys(from)) if (isNaN(+k)) to[k] = from[k]; return to }

  // `locals` = union of every enclosing FUNCTION frame's bound names. The transform
  // is post-order (inner IIFEs fold first) so an outer lift sees already-direct inner
  // calls; scope tracking is top-down so each IIFE sees the right enclosing locals.
  // Identity-preserving: a node with no lifted descendant is returned unchanged.
  const visit = (node, locals) => {
    if (!Array.isArray(node)) return node

    // Descend into an arrow body with the frame extended by this arrow's locals.
    if (node[0] === '=>') {
      const inner = new Set(locals)
      for (const n of functionLocals(extractParams(node[1]), node[2])) inner.add(n)
      let changed = false
      const out = node.map((c, i) => { if (i === 0) return c; const v = visit(c, inner); if (v !== c) changed = true; return v })
      return changed ? copyMeta(out, node) : node
    }

    // Transform children first (post-order).
    let changed = false
    const mapped = node.map((c, i) => { if (i === 0) return c; const v = visit(c, locals); if (v !== c) changed = true; return v })
    const base = changed ? copyMeta(mapped, node) : node

    const arrow = iifeArrow(base)
    if (!arrow) return base

    const paramNames = plainParamNames(arrow)
    if (paramNames === null) return base                // bail: non-plain params

    const callArgs = base[2] == null ? [] : (Array.isArray(base[2]) && base[2][0] === ',') ? base[2].slice(1) : [base[2]]
    if (callArgs.some(a => Array.isArray(a) && a[0] === '...')) return base   // bail: spread into a fixed-arity direct call

    const body = arrow[2]
    const captures = []
    findFreeVars(body, new Set(paramNames), captures, locals)

    const mutated = new Set()
    findMutations(body, new Set(captures), mutated)
    if (mutated.size) return base                       // bail: a captured var is written

    // Lift: `(…params, …captures) => body`, hoisted to module top; call passes captures.
    const name = `${T}lift${uid++}`
    lifted.push(['let', ['=', name, ['=>', ['()', commaList([...paramNames, ...captures])], body]]])
    return copyMeta(['()', name, commaList([...callArgs, ...captures])], base)
  }

  const result = visit(ast, new Set())
  if (!lifted.length) return result

  // Prepend the lifted decls to the module body (`[';', …stmts]`).
  if (Array.isArray(result) && result[0] === ';') return [';', ...lifted, ...result.slice(1)]
  return [';', ...lifted, result]
}
