/**
 * AST-level fusion passes.
 *
 * Unlike src/optimize.js (which is a pure WAT IR→IR rewrite, post-emission),
 * these rewrites need the *raw, pre-resolution* AST shape — bindings still named,
 * arrow bodies still inline — so they run inside prepare(), before scope
 * resolution and emit. They mutate the AST in place and always fire (cheap; the
 * shape guards are strict enough that misfires are impossible).
 *
 * @module fuse
 */

/** Sparse-read .map fusion: rewrite `const b = a.map(arrow); for(...; j<b.length; ...) USE(b[j])`
 *  into a fused for-loop that inlines `arrow(a[j])` at the read site, eliminating the materialized
 *  intermediate array. Only fires on shapes where every use of `b` is a numeric `b[idx]` read or a
 *  `b.length` read, the arrow is pure with a single named param, and `b` is not referenced after the
 *  consumer for-loop. Preserves observable behavior because the arrow's pure-expression body has no
 *  order-dependent effects. */
export function fuseSparseMapReads(root) {
  walkSparse(root)
}
function walkSparse(node) {
  if (!Array.isArray(node)) return
  for (let i = 1; i < node.length; i++) walkSparse(node[i])
  if (node[0] === ';') tryFuseInBlock(node)
}
function tryFuseInBlock(seq) {
  for (let i = 1; i < seq.length - 1; i++) {
    const fused = tryFusePair(seq[i], seq[i + 1], seq, i)
    if (fused) {
      seq.splice(i, 2, ...fused)
      i--  // re-examine same position (chained fusions)
    }
  }
}
function tryFusePair(decl, forNode, seq, declIdx) {
  if (!Array.isArray(decl) || (decl[0] !== 'const' && decl[0] !== 'let')) return null
  if (decl.length !== 2) return null  // single binding only
  const bind = decl[1]
  if (!Array.isArray(bind) || bind[0] !== '=' || typeof bind[1] !== 'string') return null
  const NAME = bind[1], rhs = bind[2]
  if (!Array.isArray(rhs) || rhs[0] !== '()') return null
  const callee = rhs[1]
  if (!Array.isArray(callee) || callee[0] !== '.' || callee[2] !== 'map') return null
  const RECV = callee[1]
  if (typeof RECV !== 'string' || RECV === NAME) return null
  const arrow = rhs[2]
  if (!Array.isArray(arrow) || arrow[0] !== '=>') return null
  // Single-name param only: `x => …` or `(x) => …`
  const ap = arrow[1]
  const PARAM = typeof ap === 'string' ? ap :
    (Array.isArray(ap) && ap[0] === '()' && typeof ap[1] === 'string' ? ap[1] : null)
  if (!PARAM || PARAM === NAME || PARAM === RECV) return null
  // Body: single-expression arrow only (block bodies skipped — could extend later).
  const aBody = arrow[2]
  if (Array.isArray(aBody) && aBody[0] === '{}') return null
  if (!isPureSparseArrowBody(aBody, PARAM)) return null
  // For-loop: ['for', [';', initStmt, cond, inc], body]
  if (!Array.isArray(forNode) || forNode[0] !== 'for' || forNode.length !== 3) return null
  const head = forNode[1]
  if (!Array.isArray(head) || head[0] !== ';' || head.length !== 4) return null
  const cond = head[2], forBody = forNode[2]
  // Verify `NAME` is used only as `NAME[idx]` or `NAME.length` inside cond+forBody.
  if (!hasOnlySparseUses(cond, NAME)) return null
  if (!hasOnlySparseUses(forBody, NAME)) return null
  if (!hasAnyIndexedRead(forBody, NAME) && !hasAnyIndexedRead(cond, NAME)) return null
  // `NAME` must not be read after the for-loop in the same block.
  for (let k = declIdx + 2; k < seq.length; k++) {
    if (refsName(seq[k], NAME)) return null
  }
  // RECV must not be reassigned inside the for-loop (would invalidate substitution).
  if (assignsName(forNode, RECV) || assignsName(forNode, NAME)) return null
  // PARAM must not collide with any binding inside forBody (otherwise substitution shadows wrongly).
  if (bindsName(forNode, PARAM)) return null
  // Apply substitution: NAME.length → RECV.length; NAME[idx] → arrowBody[PARAM ← RECV[idx]].
  const newCond = substSparse(cond, NAME, RECV, PARAM, aBody)
  const newBody = substSparse(forBody, NAME, RECV, PARAM, aBody)
  const newHead = [';', head[1], newCond, head[3]]
  return [['for', newHead, newBody]]
}
function isPureSparseArrowBody(n, PARAM) {
  if (typeof n === 'string') return true
  if (!Array.isArray(n)) return true
  const op = n[0]
  // Calls / new / assignments / increments are unsafe for repeated-substitution semantics.
  if (op === '()' || op === '?.()' || op === 'new' || op === '++' || op === '--') return false
  if (op === '=>') return false  // nested closure is opaque
  if (typeof op === 'string' && op !== '=>' && op !== '===' && op !== '!==' && op !== '==' && op !== '!=' && op !== '<=' && op !== '>=' && op.endsWith('=') && op !== '=') return false
  if (op === '=') return false
  for (let i = 1; i < n.length; i++) if (!isPureSparseArrowBody(n[i], PARAM)) return false
  return true
}
function hasOnlySparseUses(n, NAME) {
  if (typeof n === 'string') return n !== NAME
  if (!Array.isArray(n)) return true
  const op = n[0]
  if (op === '[]' && n.length === 3 && n[1] === NAME) return hasOnlySparseUses(n[2], NAME)  // NAME[idx] — idx must not reference NAME
  if (op === '.' && n[1] === NAME) {
    if (n[2] === 'length') return true
    return false  // any other property access on NAME is opaque
  }
  for (let i = 1; i < n.length; i++) if (!hasOnlySparseUses(n[i], NAME)) return false
  return true
}
function hasAnyIndexedRead(n, NAME) {
  if (!Array.isArray(n)) return false
  if (n[0] === '[]' && n.length === 3 && n[1] === NAME) return true
  for (let i = 1; i < n.length; i++) if (hasAnyIndexedRead(n[i], NAME)) return true
  return false
}
function refsName(n, NAME) {
  if (typeof n === 'string') return n === NAME
  if (!Array.isArray(n)) return false
  for (let i = 1; i < n.length; i++) if (refsName(n[i], NAME)) return true
  return false
}
function assignsName(n, NAME) {
  if (!Array.isArray(n)) return false
  const op = n[0]
  if ((op === '=' || op === '++' || op === '--' ||
       (typeof op === 'string' && op.endsWith('=') && op !== '==' && op !== '===' && op !== '!=' && op !== '!==' && op !== '<=' && op !== '>='))
      && n[1] === NAME) return true
  for (let i = 1; i < n.length; i++) if (assignsName(n[i], NAME)) return true
  return false
}
function bindsName(n, NAME) {
  if (!Array.isArray(n)) return false
  const op = n[0]
  if ((op === 'let' || op === 'const')) {
    for (let i = 1; i < n.length; i++) {
      const bind = n[i]
      if (Array.isArray(bind) && bind[0] === '=' && bind[1] === NAME) return true
    }
  }
  if (op === '=>') {
    const p = n[1]
    if (p === NAME) return true
    if (Array.isArray(p)) {
      if (p[0] === '()' && p[1] === NAME) return true
      // skip deeper destructuring forms — conservative
    }
  }
  for (let i = 1; i < n.length; i++) if (bindsName(n[i], NAME)) return true
  return false
}
function substSparse(n, NAME, RECV, PARAM, arrowBody) {
  if (typeof n !== 'object' || n === null || !Array.isArray(n)) return n
  if (n[0] === '.' && n[1] === NAME && n[2] === 'length') return ['.', RECV, 'length']
  if (n[0] === '[]' && n.length === 3 && n[1] === NAME) {
    const idx = substSparse(n[2], NAME, RECV, PARAM, arrowBody)
    return cloneAndBind(arrowBody, PARAM, ['[]', RECV, idx])
  }
  return n.map((c, i) => i === 0 ? c : substSparse(c, NAME, RECV, PARAM, arrowBody))
}
function cloneAndBind(node, PARAM, replacement) {
  if (node === PARAM) return replacement
  if (!Array.isArray(node)) return node
  return node.map((c, i) => i === 0 ? c : cloneAndBind(c, PARAM, replacement))
}
