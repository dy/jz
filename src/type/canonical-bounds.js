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
import { ctx, getFactStore } from '../ctx.js'
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
 *  temp (`cond` becomes `i < lenTmp`, `lenTmp` declared in `init`). Also matches a
 *  bound that is a PARAMETER caller-proven (ledger-performance.md §6.1,
 *  `ctx.func.lenBoundOf`) never to exceed some OTHER param's `.length` — the
 *  tokenizer shape `scan(src, len)`'s `for (i=0; i<len; i++) src.charCodeAt(i)`,
 *  where `len` is a param, not itself `recv.length`. Sound specifically because
 *  the receiver here is a STRING: immutable by language definition, so its
 *  length cannot change during the callee's activation regardless of aliasing
 *  or re-entrancy — the one soundness question a caller-side entry-time fact
 *  would otherwise leave open (see boundedByCallerLength's doc, summaries.js).
 *  scanBoundedArrIdx (the array-idx sibling below) does NOT take this same
 *  fallback: a mutable receiver's length could shrink mid-activation, which
 *  this proof does not (yet) account for. */
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
      if (recv == null && boundVar != null) recv = ctx.func.lenBoundOf?.get(boundVar) ?? null
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

/** charCodeAt calls whose indices are proven within the receiver's length.
 * Cached by body identity for this compilation session. */
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

/**
 * Maximum advance of the counter `name` over ONE execution of `root` (a loop
 * body), or null when a write to it is not a positive constant step or the
 * control shape is not admitted. Mutually exclusive arms contribute their
 * maximum; a nested counted loop contributes trips × its body's own budget:
 *   `for (iv = A; iv </<= B; iv += c)` with A, c literals and B bounded by
 *   `evRange` (a decl of `root` evaluates through its initializer when nothing
 *   else writes it — `const np = 20 + rnd() % 101`);
 *   `while (x </<= B)` where x starts at a literal (its declaration in `root`,
 *   written nowhere but inside the loop) and every write in the loop is `x++`
 *   or `x += e` with e a literal ≥ 1 or a loop-declared counter that starts
 *   ≥ 1 and only grows — each iteration advances x by at least 1.
 * An abrupt edge out of a nested loop keeps the bound (fewer trips, never
 * more). Both the interval prover (advanceBudget) and the analysis-time
 * co-induction stamp state their cursor budgets through this one walk.
 */
export function maxAdvanceBudget(root, name, { constInt, evRange, closureWrites, MUTATE_OPS }) {
  const stmts = Array.isArray(root) && (root[0] === ';' || root[0] === '{}') ? root.slice(1) : [root]
  const bodyDecls = new Map()
  for (const st of stmts) collectDecls(st, bodyDecls)
  // A body decl written nowhere else stands for its initializer, transitively
  // (`np` → `20 + t % 101` → `20 + (s >>> 0) % 101`), so the range evaluator
  // sees the shapes it knows (`>>>`, masks, moduli) instead of provisional names.
  const stable = (nm) => bodyDecls.has(nm) && !closureWrites.has(nm) && !isReassigned(root, nm)
  const subst = (e, depth = 0) => {
    if (typeof e === 'string') return stable(e) && depth < 8 ? subst(bodyDecls.get(e), depth + 1) : e
    if (!Array.isArray(e) || e[0] === '=>' || e[0] === '()' ) return e
    return e.map((c, i) => i === 0 ? c : subst(c, depth))
  }
  const evIn = (e) => evRange(subst(e))
  const boundHi = (cond, iv) => {
    if (!Array.isArray(cond) || cond.length !== 3 || (cond[0] !== '<' && cond[0] !== '<=') || cond[1] !== iv) return null
    const B = evIn(cond[2])
    return B ? B[1] + (cond[0] === '<=' ? 1 : 0) : null
  }
  // writes to `nm` in `r`, each as a node — a declarator's `=` is a binding, not a write
  const writesTo = (r, nm) => {
    const out = []
    const walk = (y) => {
      if (!Array.isArray(y)) return
      if (y[0] === 'let' || y[0] === 'const' || y[0] === 'var') {
        for (let i = 1; i < y.length; i++) if (Array.isArray(y[i]) && y[i][0] === '=') walk(y[i][2])
        return
      }
      if (MUTATE_OPS.has(y[0]) && y[1] === nm) out.push(y)
      for (let i = 1; i < y.length; i++) walk(y[i])
    }
    walk(r)
    return out
  }
  const countWrites = (r, nm) => writesTo(r, nm).length
  const nestedTrips = (n) => {
    if (n[0] === 'for' && n.length === 5) {
      const [, init, cond, step, lb] = n
      const decls = new Map(); collectDecls(init, decls)
      if (decls.size !== 1) return null
      const [iv, initE] = [...decls][0]
      const A = constInt(initE)
      const c = Array.isArray(step) && step[1] === iv ? (step[0] === '++' ? 1 : step[0] === '+=' ? constInt(step[2]) : null) : null
      const H = boundHi(cond, iv)
      if (A == null || c == null || c <= 0 || H == null || isReassigned(lb, iv) || closureWrites.has(iv)) return null
      return Math.max(0, Math.ceil((H - A) / c))
    }
    if (n[0] === 'while' && n.length === 3) {
      const [, cond, lb] = n
      const x = Array.isArray(cond) ? cond[1] : null
      if (typeof x !== 'string' || !bodyDecls.has(x) || closureWrites.has(x)) return null
      const A = constInt(bodyDecls.get(x)), H = boundHi(cond, x)
      if (A == null || H == null) return null
      const loopDecls = new Map()
      for (const st of (Array.isArray(lb) && (lb[0] === ';' || lb[0] === '{}') ? lb.slice(1) : [lb])) collectDecls(st, loopDecls)
      const grows = (e) => {
        const k = constInt(e)
        if (k != null) return k >= 1
        if (typeof e !== 'string' || closureWrites.has(e) || !loopDecls.has(e)) return false
        const e0 = constInt(loopDecls.get(e))
        if (e0 == null || e0 < 1) return false
        const ws = writesTo(lb, e)
        const mono = ws.every(y => y[0] === '++' || (y[0] === '+=' && constInt(y[2]) > 0))
        return mono && countWrites(root, e) === ws.length
      }
      const ws = writesTo(lb, x)
      const ok = ws.length > 0 && ws.every(y => y[0] === '++' || (y[0] === '+=' && grows(y[2])))
      if (!ok || countWrites(root, x) !== ws.length) return null
      return Math.max(0, H - A)
    }
    return null
  }
  const delta = (n) => {
    if (n[0] === '++') return 1
    if (n[0] === '+=') { const d = constInt(n[2]); return d != null && d > 0 ? d : null }
    if (n[0] === '=' && Array.isArray(n[2]) && n[2][0] === '+') {
      const d = n[2][1] === name ? constInt(n[2][2]) : n[2][2] === name ? constInt(n[2][1]) : null
      return d != null && d > 0 ? d : null
    }
    return null
  }
  const seq = (xs) => { let n = 0; for (const x of xs) { const d = eff(x); if (d == null) return null; n += d } return n }
  const eff = (n) => {
    if (!Array.isArray(n)) return 0
    const op = n[0]
    if (op === '=>') return closureWrites.has(name) ? null : 0
    if (MUTATE_OPS.has(op) && n[1] === name) return delta(n)
    if (op === 'if') {
      const c = eff(n[1]), a = eff(n[2]), b = n.length > 3 ? eff(n[3]) : 0
      return c == null || a == null || b == null ? null : c + Math.max(a, b)
    }
    if (op === '?:') {
      const c = eff(n[1]), a = eff(n[2]), b = eff(n[3])
      return c == null || a == null || b == null ? null : c + Math.max(a, b)
    }
    if (op === '&&' || op === '||') {
      const a = eff(n[1]), b = eff(n[2])
      return a == null || b == null ? null : a + Math.max(0, b)
    }
    if ((op === 'for' || op === 'while') && isReassigned(n, name)) {
      const trips = nestedTrips(n)
      if (trips == null) return null
      const head = op === 'for' ? eff(n[1]) : 0
      const per = op === 'for' ? seq([n[2], n[3], n[4]]) : seq([n[1], n[2]])
      return head == null || per == null ? null : head + trips * per
    }
    if (op === 'while' || op === 'for' || op === 'do' || op === 'for-of' || op === 'for-in' ||
        op === 'switch' || op === 'try' || op === 'catch' || op === 'finally' ||
        op === 'break' || op === 'continue' || op === 'return' || op === 'throw')
      return isReassigned(n, name) ? null : 0
    return seq(n.slice(1))
  }
  return eff(root)
}
