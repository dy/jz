/**
 * In-bounds charCodeAt proof via canonical induction loops.
 * @module bounds
 */
import { isReassigned } from './ast.js'
import { ctx } from './ctx.js'
import { intLiteralValue } from './const.js'

// =============================================================================
// charCodeAt in-bounds proof
// =============================================================================
// `String.prototype.charCodeAt` returns NaN for an out-of-range index, so the
// generic codegen contract is an f64 result (see module/string.js). When the
// index is the induction variable of a `for (let i = C; i < recv.length; i++)`
// loop, every `recv.charCodeAt(i)` in the loop body is statically inside
// `[0, recv.length)` — OOB is impossible — so the call may use the cheaper i32
// (raw-byte) contract instead. This is a static guarantee, not a guess.

/** Step expression of a `for` that increments `name` by exactly 1. */
function isUnitIncrement(step, name) {
  if (!Array.isArray(step)) return false
  if (step[0] === '++' && step[1] === name) return true
  // postfix `i++` in value position lowers to `(++i) - 1`
  if (step[0] === '-' && Array.isArray(step[1]) && step[1][0] === '++'
      && step[1][1] === name && intLiteralValue(step[2]) === 1) return true
  return false
}

/** `let`/`const` re-declaration of `name` within `node` — does not cross `=>`
 *  (a closure has its own scope; collection already stops at closure boundaries). */
function redeclaresName(node, name) {
  if (!Array.isArray(node) || node[0] === '=>') return false
  if (node[0] === 'let' || node[0] === 'const') {
    for (let k = 1; k < node.length; k++) {
      const d = node[k]
      if (d === name) return true
      if (Array.isArray(d) && d[0] === '=' && d[1] === name) return true
    }
  }
  for (let k = 1; k < node.length; k++) if (redeclaresName(node[k], name)) return true
  return false
}

/** Collect `recv.charCodeAt(idxVar)` callee nodes within `node`. Stops at `=>`:
 *  a closure may run after the loop, when `idxVar` has reached `recv.length`. */
function collectBoundedCC(node, recv, idxVar, set) {
  if (!Array.isArray(node) || node[0] === '=>') return
  if (node[0] === '()' && node.length === 3 && node[2] === idxVar
      && Array.isArray(node[1]) && node[1][0] === '.'
      && node[1][1] === recv && node[1][2] === 'charCodeAt')
    set.add(node[1])
  for (let k = 1; k < node.length; k++) collectBoundedCC(node[k], recv, idxVar, set)
}

/** Receiver of a `.length` expression, possibly wrapped in `(… | 0)` — the
 *  shape `prepare` produces when it hoists a for-cond bound. */
function lengthRecv(expr) {
  if (Array.isArray(expr) && expr[0] === '|' && intLiteralValue(expr[2]) === 0) expr = expr[1]
  if (Array.isArray(expr) && expr[0] === '.' && expr[2] === 'length'
      && typeof expr[1] === 'string') return expr[1]
  return null
}

/** Flatten `let`/`const` declarations (incl. `;`-joined groups) into `out`,
 *  mapping each declared name to its initializer expression. */
function collectDecls(node, out) {
  if (!Array.isArray(node)) return
  if (node[0] === ';') { for (let k = 1; k < node.length; k++) collectDecls(node[k], out); return }
  if (node[0] === 'let' || node[0] === 'const') {
    for (let k = 1; k < node.length; k++) {
      const d = node[k]
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') out.set(d[1], d[2])
    }
  }
}

/** Walk `node`, recording in `set` the `charCodeAt` callee nodes proven in-bounds
 *  by an enclosing canonical induction loop `for (let i = C; i < recv.length; i++)`.
 *  Matches the post-`prepare` shape, where the `.length` bound is hoisted into a
 *  temp (`cond` becomes `i < lenTmp`, `lenTmp` declared in `init`). */
export function scanBoundedLoops(node, set) {
  if (!Array.isArray(node)) return
  if (node[0] === 'for' && node.length === 5) {
    const [, init, cond, step, body] = node
    let idx = null, recv = null, boundVar = null
    if (Array.isArray(cond) && cond[0] === '<' && typeof cond[1] === 'string') {
      const decls = new Map()
      collectDecls(init, decls)
      idx = cond[1]
      // index must be declared in `init` as `let i = C`, C an integer literal ≥ 0
      const start = decls.has(idx) ? intLiteralValue(decls.get(idx)) : null
      if (start == null || start < 0) idx = null
      // bound is `recv.length`, directly or via a hoisted temp declared in `init`
      let bound = cond[2]
      if (typeof bound === 'string') { boundVar = bound; bound = decls.get(bound) }
      recv = lengthRecv(bound)
    }
    // step `i++`; body never writes `i`/`recv`/the bound temp (incl. via
    // closures) and never re-declares `i`. Then every bare `i` in the body
    // satisfies `0 ≤ C ≤ i < recv.length`.
    if (idx && recv && idx !== recv && isUnitIncrement(step, idx)
        && !isReassigned(body, idx) && !isReassigned(body, recv)
        && (boundVar == null || !isReassigned(body, boundVar))
        && !redeclaresName(body, idx))
      collectBoundedCC(body, recv, idx, set)
  }
  for (let k = 1; k < node.length; k++) scanBoundedLoops(node[k], set)
}

const NO_BOUNDED_CC = new Set()  // shared immutable empty result

/** Set of `['.', recv, 'charCodeAt']` callee nodes in the current function whose
 *  index argument is provably within `[0, recv.length)`. Memoised per body. */
export function inBoundsCharCodeAt(ctx) {
  const body = ctx.func?.body
  if (!Array.isArray(body)) return NO_BOUNDED_CC
  if (ctx.func._ccBody === body) return ctx.func.ccInBounds
  const set = new Set()
  scanBoundedLoops(body, set)
  ctx.func.ccInBounds = set
  ctx.func._ccBody = body
  return set
}
