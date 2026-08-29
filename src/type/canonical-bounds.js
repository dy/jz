/**
 * Canonical single induction-loop in-bounds proof: `for (let i = C≥0; i < recv.length;
 * i++)` (or a hoisted-bound twin) makes every `recv.charCodeAt(i)` / `recv[i]` in the
 * loop body provably within `[0, recv.length)`. Two sibling proofs (charCodeAt is an
 * i32/f64 contract choice, array-idx is a bounds-check elision) sharing one loop-shape
 * recognizer. Also home to `idxKey`, the structural `"recv\x00idx"` key every bounds-
 * proof family in `type/` uses to name a `recv[idx]` site — relocated here (from its
 * original position beside `typedIdxProven`) so `loop-versioning.js` and
 * `interval-proof.js` can both depend on it without depending on each other.
 *
 * @module type/canonical-bounds
 */
import { isReassigned, some, walkAst } from '../ast.js'
import { getFactStore } from '../ctx.js'
import { intLiteralValue } from '../static.js'

/** Structural key for a `recv[idx]` site — the assumedBounds channel between the
 *  versioning scan and typedIdxProven. JSON is structural, so the key matches even
 *  when the prover sees a clone of the scanned node. */
export const idxKey = (recv, idx) => recv + '\x00' + (typeof idx === 'string' ? idx : JSON.stringify(idx))

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
export function isUnitIncrement(step, name) {
  if (!Array.isArray(step)) return false
  if (step[0] === '++' && step[1] === name) return true
  // postfix `i++` in value position lowers to `(++i) - 1`
  if (step[0] === '-' && Array.isArray(step[1]) && step[1][0] === '++'
      && step[1][1] === name && intLiteralValue(step[2]) === 1) return true
  return false
}

export function isUnitDecrement(step, name) {
  if (!Array.isArray(step)) return false
  if (step[0] === '--' && step[1] === name) return true
  // postfix `i--` in value position lowers to `(--i) + 1`
  if (step[0] === '+' && Array.isArray(step[1]) && step[1][0] === '--'
      && step[1][1] === name && intLiteralValue(step[2]) === 1) return true
  return false
}

/** `let`/`const` re-declaration of `name` within `node` — does not cross `=>`
 *  (a closure has its own scope; collection already stops at closure boundaries). */
export function redeclaresName(node, name) {
  return some(node, n => {
    if (n[0] !== 'let' && n[0] !== 'const') return false
    for (let k = 1; k < n.length; k++) {
      const d = n[k]
      if (d === name) return true
      if (Array.isArray(d) && d[0] === '=' && d[1] === name) return true
    }
    return false
  })
}

/** Collect `recv.charCodeAt(idxVar)` callee nodes within `node`. Stops at `=>`:
 *  a closure may run after the loop, when `idxVar` has reached `recv.length`. */
function collectBoundedCC(node, recv, idxVar, set) {
  walkAst(node, { enter: n => {
    if (n[0] === '=>') return false
    if (n[0] === '()' && n.length === 3 && n[2] === idxVar
        && Array.isArray(n[1]) && n[1][0] === '.'
        && n[1][1] === recv && n[1][2] === 'charCodeAt')
      set.add(n[1])
  } })
}

/** Receiver of a `.length` expression, possibly wrapped in `(… | 0)` — the
 *  shape `prepare` produces when it hoists a for-cond bound. */
export function lengthRecv(expr) {
  if (Array.isArray(expr) && expr[0] === '|' && intLiteralValue(expr[2]) === 0) expr = expr[1]
  if (Array.isArray(expr) && expr[0] === '.' && expr[2] === 'length'
      && typeof expr[1] === 'string') return expr[1]
  // `Math.min(X, recv.length)` (either arg order): min ≤ recv.length regardless
  // of X, so the bound proof carries through. This is the shape
  // splitCharScanLoops plants for the in-bounds main loop of a split scan.
  if (Array.isArray(expr) && expr[0] === '()' && expr[1] === 'math.min') {
    const argsNode = expr[2]
    const args = Array.isArray(argsNode) && argsNode[0] === ',' ? argsNode.slice(1) : [argsNode]
    for (const a of args) { const r = lengthRecv(a); if (r) return r }
  }
  return null
}

/** Flatten `let`/`const` declarations (incl. `;`-joined groups) into `out`,
 *  mapping each declared name to its initializer expression. */
export function collectDecls(node, out) {
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
 *  index argument is provably within `[0, recv.length)`. Memoised per body
 *  (AdHocMemo retirement — .work/archive/ctxfunc-survey.md §2/§5: WeakMap on body identity,
 *  getFactStore().ccInBounds, same session-ownership idiom as kind.js's
 *  mayBeUndefinedTrace — persists across enterFunc by design, self-
 *  invalidating on body identity, cleared fresh every beginSession). */
export function inBoundsCharCodeAt(ctx) {
  const body = ctx.func?.body
  if (!Array.isArray(body)) return NO_BOUNDED_CC
  const cache = getFactStore().ccInBounds
  const hit = cache.get(body)
  if (hit) return hit
  const set = new Set()
  scanBoundedLoops(body, set)
  cache.set(body, set)
  return set
}

/** Collect proven-in-bounds `recv[idxVar]` accesses within a canonical induction
 *  loop. Stores `"recv\x00idxVar"` keys — `\x00` isn't a valid identifier char so
 *  the pair is unambiguous. Stops at `=>` (a closure may run after the loop, when
 *  `idxVar` has reached `recv.length`). */
function collectBoundedArrIdx(node, recv, idxVar, set) {
  walkAst(node, { enter: n => {
    if (n[0] === '=>') return false
    if (n[0] === '[]' && n.length === 3 && n[1] === recv && n[2] === idxVar)
      set.add(recv + '\x00' + idxVar)
  } })
}

/** Walk `node`, recording `"recv\x00idx"` pairs for `recv[idx]` reads proven within
 *  `[0, recv.length)` by an enclosing canonical loop `for (let i = C; i < recv.length;
 *  i++)`. Same loop contract as `scanBoundedLoops` (charCodeAt) — sibling proof for
 *  the ARRAY indexed-read fast path in `module/array.js`. */
export function scanBoundedArrIdx(node, set, litSet) {
  if (!Array.isArray(node)) return
  if (node[0] === 'for' && node.length === 5) {
    const [, init, cond, step, body] = node
    let idx = null, recv = null, boundVar = null
    if (Array.isArray(cond) && cond[0] === '<' && typeof cond[1] === 'string') {
      const decls = new Map()
      collectDecls(init, decls)
      idx = cond[1]
      const start = decls.has(idx) ? intLiteralValue(decls.get(idx)) : null
      if (start == null || start < 0) idx = null
      let bound = cond[2]
      if (typeof bound === 'string') { boundVar = bound; bound = decls.get(bound) }
      recv = lengthRecv(bound)
    }
    if (idx && recv && idx !== recv && isUnitIncrement(step, idx)
        && !isReassigned(body, idx) && !isReassigned(body, recv)
        && (boundVar == null || !isReassigned(body, boundVar))
        && !redeclaresName(body, idx))
      collectBoundedArrIdx(body, recv, idx, set)
    // LITERAL-bound loop `for (let i = C≥0; i < B; i++)`: every `X[i]` read is in
    // [C, B) — provable against a receiver whose STATIC length ≥ B (typedIdxProven
    // consults litSet's recorded bound vs ctx.func.typedLen). Collected for every
    // receiver name in the body; per-receiver reassignment guarded like the
    // .length form. Two loops sharing (recv, i) names keep the MAX bound —
    // conservative for the proof.
    if (litSet && !(idx && recv)) {
      // re-derive idx with the same start guard (the .length branch nulled it only
      // when recv didn't resolve — recompute cleanly for the literal branch)
      if (Array.isArray(cond) && cond[0] === '<' && typeof cond[1] === 'string') {
        const decls = new Map()
        collectDecls(init, decls)
        const idx2 = cond[1]
        const start = decls.has(idx2) ? intLiteralValue(decls.get(idx2)) : null
        let bound = cond[2]
        if (typeof bound === 'string' && decls.has(bound)) bound = decls.get(bound)
        const B = intLiteralValue(bound)
        if (start != null && start >= 0 && B != null && B >= 0
            && isUnitIncrement(step, idx2) && !isReassigned(body, idx2) && !redeclaresName(body, idx2)) {
          const recvs = new Set()
          walkAst(body, { enter: n => {
            if (n[0] === '=>') return false
            if (n[0] === '[]' && n.length === 3 && typeof n[1] === 'string' && n[2] === idx2) recvs.add(n[1])
          } })
          for (const r of recvs) {
            if (r === idx2 || isReassigned(body, r)) continue
            const key = r + '\x00' + idx2
            const prev = litSet.get(key)
            litSet.set(key, prev == null ? B : Math.max(prev, B))
          }
        }
      }
    }
  }
  for (let k = 1; k < node.length; k++) scanBoundedArrIdx(node[k], set, litSet)
}

/** Set of `"recv\x00idx"` keys for `recv[idx]` reads in the current function proven
 *  in-bounds. Memoised per body (separate slot from the charCodeAt proof; AdHocMemo
 *  retirement — see inBoundsCharCodeAt's comment for the WeakMap idiom, here
 *  getFactStore().aiInBounds/aiLitBounds, always populated together). */
export function inBoundsArrIdx(ctx) {
  const body = ctx.func?.body
  if (!Array.isArray(body)) return NO_BOUNDED_CC
  const cache = getFactStore().aiInBounds
  const hit = cache.get(body)
  if (hit) return hit
  const set = new Set()
  const litSet = new Map()
  scanBoundedArrIdx(body, set, litSet)
  cache.set(body, set)
  getFactStore().aiLitBounds.set(body, litSet)
  return set
}

/** Map of `"recv\x00idx"` → max literal loop bound for `recv[idx]` reads under
 *  `for (let i = C≥0; i < LIT; i++)` — proven in-bounds iff LIT ≤ the receiver's
 *  static length (typedIdxProven). Memoised with inBoundsArrIdx. */
export function litBoundArrIdx(ctx) {
  inBoundsArrIdx(ctx)
  const body = ctx.func?.body
  return getFactStore().aiLitBounds.get(body) || NO_LIT_BOUNDS
}
const NO_LIT_BOUNDS = new Map()
