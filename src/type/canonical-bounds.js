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
import { isReassigned, some, walkAst, hasOptionalChain, MUTATE_OPS, callArgs, refsName, REFS_THROUGH_ARROWS } from '../ast.js'
import { ctx, getFactStore } from '../ctx.js'
import { intLiteralValue, constIntExpr, intExprRange, counterInit } from '../static.js'
import { NUMBER, STRING } from '../summary/kind.js'
import { runsAccessor, runsConversion, primitiveKind } from '../evaluation-effects.js'
import { frameNode } from '../function.js'

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
  if (step[0] === 'postfix') step = step[1]
  if (step[0] === '++' && step[1] === name) return true
  // An explicitly spelled subtraction still performs the same update.
  if (step[0] === '-' && Array.isArray(step[1]) && step[1][0] === '++'
      && step[1][1] === name && intLiteralValue(step[2]) === 1) return true
  return false
}

export function isUnitDecrement(step, name) {
  if (!Array.isArray(step)) return false
  if (step[0] === 'postfix') step = step[1]
  if (step[0] === '--' && step[1] === name) return true
  // An explicitly spelled addition still performs the same update.
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
export function scanBoundedLoops(node, set, view = ctx.summary?.at(ctx.func.current)) {
  if (!Array.isArray(node)) return
  if (node[0] === 'for' && node.length === 5) {
    const [, init, cond, step, body] = node
    let idx = null, recv = null, boundVar = null
    if (Array.isArray(cond) && cond[0] === '<' && typeof cond[1] === 'string') {
      const decls = new Map()
      collectDecls(init, decls)
      idx = cond[1]
      // index must be declared in `init` as `let i = C`, C an integer literal ≥ 0
      const start = decls.has(idx) ? intLiteralValue(counterInit(init, idx)) : null
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
        && !redeclaresName(body, idx)) {
      const bindings = [recv, idx, boundVar], callees = new Map()
      if (preservesLoopBounds(body, view, bindings, callees, false) && preservesLoopBounds(cond, view, bindings, callees, false) &&
          (boundVar == null || preservesLoopHead(init, view, bindings, callees, idx, boundVar, false)))
        collectBoundedCC(body, recv, idx, set)
    }
  }
  for (let k = 1; k < node.length; k++) scanBoundedLoops(node[k], set, view)
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
function collectBoundedArrIdx(node, recv, idxVar, set, nodes) {
  walkAst(node, { enter: n => {
    if (n[0] === '=>') return false
    if (n[0] === '[]' && n.length === 3 && n[1] === recv && n[2] === idxVar) {
      set?.add(recv + '\x00' + idxVar)
      nodes?.add(n)
    }
  } })
}

// The condition describes the read only while no intervening effect changes
// its receiver or index. Arrays also need their extent preserved through aliases;
// strings are immutable, but their bindings can be replaced by called closures.
function preservesLoopBounds(root, view, bindings, callees, mutable = true) {
  return !some(root, n => {
    if (runsAccessor(view, n, true) || runsConversion(view, n)) return true
    const op = n[0]
    if (op === '()' || op === '?.()' || op === 'new') {
      const callee = n[1]
      if (op === '()') {
        const target = typeof callee === 'string' ? callee : view?.calleeOf?.(n)
        const func = typeof target === 'string' && ctx.funcs.map?.get(target)
        if (func?.frame?.writesOuter === false) return false
        if (func && !func.raw && Array.isArray(func.body)) {
          if (!callees.has(func)) {
            // A cycle declines. The same proof applies to defaults and callees:
            // writes to unrelated fields or typed elements cannot shrink arrays.
            callees.set(func, false)
            callees.set(func, preservesLoopBounds(frameNode(func), ctx.summary?.at(func.sig), bindings, callees, mutable))
          }
          return !callees.get(func)
        }
        // The string proof is conditional on this very receiver being a string;
        // boundary planning may establish that carrier only after this scan.
        if (Array.isArray(callee) && callee[0] === '.' && callee[2] === 'charCodeAt' &&
            (!mutable && callee[1] === bindings[0] && n[2] === bindings[1] ||
              view?.kindOfExpr(callee[1]) === STRING && callArgs(n).every(a => primitiveKind(view, a)))) return false
        if (typeof callee === 'string' && callee.startsWith('math.') && callArgs(n).every(a => primitiveKind(view, a))) return false
      }
      return true
    }
    if (!MUTATE_OPS.has(op)) return false
    if (typeof n[1] === 'string') return bindings.includes(n[1])
    if (!mutable || !Array.isArray(n[1])) return false
    const lhs = n[1]
    if (lhs[0] === '.' || lhs[0] === '?.') return lhs[2] === 'length'
    if (lhs[0] !== '[]') return false
    const key = lhs[2]
    if (Array.isArray(key) && (key[0] == null || key[0] === 'str')) return key[1] === 'length'
    return view?.kindOfExpr(key) !== NUMBER
  })
}

// The canonical head declares the induction variable and possibly its bound.
// Inspect their initializers without treating the declarations as later writes.
function preservesLoopHead(root, view, bindings, callees, idx, bound, mutable = true) {
  if (!Array.isArray(root)) return true
  if (root[0] === ';') return root.slice(1).every(n => preservesLoopHead(n, view, bindings, callees, idx, bound, mutable))
  if (root[0] === 'let' || root[0] === 'const') return root.slice(1).every(n =>
    preservesLoopBounds(Array.isArray(n) && n[0] === '=' && (n[1] === idx || n[1] === bound) ? n[2] : n, view, bindings, callees, mutable))
  return preservesLoopBounds(root, view, bindings, callees, mutable)
}

/** Walk `node`, recording `"recv\x00idx"` pairs for `recv[idx]` reads proven within
 *  `[0, recv.length)` by an enclosing canonical loop `for (let i = C; i < recv.length;
 *  i++)`. Same loop contract as `scanBoundedLoops` (charCodeAt) — sibling proof for
 *  the ARRAY indexed-read fast path in `module/array.js`. */
export function scanBoundedArrIdx(node, set, litSet, nodes, view = ctx.summary?.at(ctx.func.current)) {
  if (!Array.isArray(node)) return
  if (node[0] === 'for' && node.length === 5) {
    const [, init, cond, step, body] = node
    let idx = null, recv = null, boundVar = null
    if (Array.isArray(cond) && cond[0] === '<' && typeof cond[1] === 'string') {
      const decls = new Map()
      collectDecls(init, decls)
      idx = cond[1]
      const start = decls.has(idx) ? intLiteralValue(counterInit(init, idx)) : null
      if (start == null || start < 0) idx = null
      let bound = cond[2]
      if (typeof bound === 'string') { boundVar = bound; bound = decls.get(bound) }
      recv = lengthRecv(bound)
    }
    if (idx && recv && idx !== recv && isUnitIncrement(step, idx)
        && !isReassigned(body, idx) && !isReassigned(body, recv)
        && (boundVar == null || !isReassigned(body, boundVar))
        && !redeclaresName(body, idx)) {
      const bindings = [recv, idx, boundVar], callees = new Map()
      if (preservesLoopBounds(body, view, bindings, callees) && preservesLoopBounds(cond, view, bindings, callees) &&
          (boundVar == null || preservesLoopHead(init, view, bindings, callees, idx, boundVar)))
        collectBoundedArrIdx(body, recv, idx, set, nodes)
    }
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
        const start = decls.has(idx2) ? intLiteralValue(counterInit(init, idx2)) : null
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
  for (let k = 1; k < node.length; k++) scanBoundedArrIdx(node[k], set, litSet, nodes, view)
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
 *   ≥ 1 and only grows — each iteration advances x by at least 1;
 *   `while (x >/>= L)` where x is a `let`/`const` of the body or of an arm in
 *   it with an initializer of a bounded range (a byte read, `let rep =
 *   stream[r++]`) and every write in the loop lowers it by at least 1 — at
 *   most its entry's most above L iterations.
 * A step by a value of a known nonnegative range (`p += run` over a run read
 * from bytes) rises by at most the range's top, the range closed over the loop
 * by `stepRange` (elements and literals; never a hull of the moment); a
 * `let`/`const` of the body or of a block around the position stands for its
 * initializer from its statement on, since a read of it there runs after the
 * initializer or throws.
 * An abrupt edge out of a nested loop keeps the bound (fewer trips, never
 * more). Both the interval prover (advanceBudget) and the analysis-time
 * co-induction stamp state their cursor budgets through this one walk.
 *
 * `upperOnly` also admits decrements (`x--`, `x -= c`, `x = x - c` with c ≥ 0),
 * which advance by zero, and a nested loop of any trip count whose iterations
 * advance by zero: the result bounds how far the counter can RISE over one
 * execution, never how far it falls, so it proves an upper bound alone. A
 * stack cursor pushed once per outer iteration and popped by an inner scan
 * (the lower envelope's `k`) advances by at most 1.
 */
export const maxAdvanceBudget = (root, name, options) => advanceBudget(root, name, options, false)

// A lower bound counts only advances guaranteed on every normal body path.
// Nested loops and abrupt edges require their own continuation analysis.
export const minAdvanceBudget = (root, name, options) => advanceBudget(root, name, options, true)

// Total absolute movement bounds every prefix too, so opposite-signed writes
// cannot cancel away an intermediate overflow. The caller supplies closed
// whole-loop ranges, never entry-only facts about a changing operand.
export const maxMovementBudget = (root, name, options) => advanceBudget(root, name, options, false, true)

function advanceBudget(root, name, { constInt, evRange, closureWrites, MUTATE_OPS, upperOnly = false, stepRange = null, roundTest = null }, minimum, absolute = false) {
  if (minimum && upperOnly) return null
  // The round's own test (the loop's, `ip < n`): a nested loop entered under the same test, with
  // nothing of the test's names written before it in the round, runs at least once, so its
  // body's least advance counts once (`for (let b = 0; b < 8 && ip < n; b++) { … ip += len }`
  // under `while (ip < n)`); a guard `x >= K` floors a step's rise by `x` in its arm.
  const testNames = new Set()
  if (minimum && roundTest) { const walk = (y) => { if (!Array.isArray(y)) return; for (let i = 1; i < y.length; i++) if (typeof y[i] === 'string') testNames.add(y[i]); else walk(y[i]) }; walk(roundTest) }
  let testWrites = [...testNames].some(x => closureWrites.has(x)) ? 1 : 0
  const sameTest = (c) => roundTest != null && JSON.stringify(c) === JSON.stringify(roundTest)
  const floors = new Map()
  const stmts = Array.isArray(root) && (root[0] === ';' || root[0] === '{}') ? root.slice(1) : [root]
  const bodyDecls = new Map()
  for (const st of stmts) collectDecls(st, bodyDecls)
  // A body decl written nowhere else stands for its initializer, transitively
  // (`np` → `20 + t % 101` → `20 + (s >>> 0) % 101`), so the range evaluator
  // sees the shapes it knows (`>>>`, masks, moduli) instead of provisional names.
  // The `let`/`const` declarations in scope where the walk stands: those of the
  // body and of the blocks around the position, each from its statement on (a
  // read before it, or outside its block, sees none). The walk pushes a block's
  // scope entering it and a declaration once its statement is visited; a query
  // outside the walk (a nested loop's bound) sees the body's.
  const scopes = []
  const declared = (nm) => { for (let k = scopes.length - 1; k >= 0; k--) if (scopes[k].has(nm)) return scopes[k].get(nm); return scopes.length ? undefined : bodyDecls.get(nm) }
  const stable = (nm) => declared(nm) !== undefined && !closureWrites.has(nm) && !isReassigned(root, nm)
  const subst = (e, depth = 0) => {
    if (typeof e === 'string') return stable(e) && depth < 8 ? subst(declared(e), depth + 1) : e
    if (!Array.isArray(e) || e[0] === '=>' || e[0] === '()' ) return e
    return e.map((c, i) => i === 0 ? c : subst(c, depth))
  }
  const evIn = (e) => evRange(subst(e))
  const boundHi = (cond, iv) => {
    // (a conjunction runs at most as often as its conjunct on the counter allows)
    if (Array.isArray(cond) && cond[0] === '&&' && cond.length === 3) return boundHi(cond[1], iv) ?? boundHi(cond[2], iv)
    if (!Array.isArray(cond) || cond.length !== 3 || (cond[0] !== '<' && cond[0] !== '<=') || cond[1] !== iv) return null
    const B = evIn(cond[2])
    return B ? B[1] + (cond[0] === '<=' ? 1 : 0) : null
  }
  // whether the nested loop `n` runs at least once where it stands: entered under the round's own
  // test, intact so far, from a literal start below a literal bound (a `for`), or under that test alone (a `while`)
  const runsOnce = (n) => {
    if (testWrites) return false
    if (n[0] === 'while' && n.length === 3) return sameTest(n[1])
    if (n[0] !== 'for' || n.length !== 5) return false
    const [, init, cond] = n
    const decls = new Map(); collectDecls(init, decls)
    if (decls.size !== 1) return false
    const [iv, initE] = [...decls][0], A = constInt(initE)
    if (A == null) return false
    let own = null, rest = true
    const conj = (c) => {
      if (Array.isArray(c) && c[0] === '&&' && c.length === 3) { conj(c[1]); conj(c[2]); return }
      if (Array.isArray(c) && c.length === 3 && (c[0] === '<' || c[0] === '<=') && c[1] === iv && own == null) { own = c; return }
      if (!sameTest(c)) rest = false
    }
    conj(cond)
    if (!own || !rest) return false
    const B = constInt(own[2])
    return B != null && (own[0] === '<' ? A < B : A <= B)
  }
  // writes to `nm` in `r`, each as a node — a declarator's `=` is a binding, not a write
  const writesTo = (r, nm) => {
    const out = []
    const walk = (y) => {
      if (!Array.isArray(y)) return
      if (y[0] === 'let' || y[0] === 'const') {
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
    if (n[0] === 'while' && n.length === 3 && Array.isArray(n[1]) && (n[1][0] === '<' || n[1][0] === '<=')) {
      const [, cond, lb] = n
      const x = cond[1]
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
    // `while (x > L)` / `while (x >= L)` over a declaration of the body or of a
    // block in it whose initializer has a bounded range (a byte read, `let rep =
    // stream[r++]`), written nowhere but inside the loop, every write a decrement
    // by at least 1: each iteration lowers x by at least 1, so the trips are at
    // most its entry's most above L.
    if (n[0] === 'while' && n.length === 3 && Array.isArray(n[1]) && (n[1][0] === '>' || n[1][0] === '>=')) {
      const [, cond, lb] = n
      const x = cond[1]
      const init = typeof x === 'string' && !closureWrites.has(x) ? declared(x) : null
      if (init == null) return null
      const E = evRange(init), L = constInt(cond[2])
      if (!E || !Number.isFinite(E[1]) || L == null) return null
      const ws = writesTo(lb, x)
      const ok = ws.length > 0 && ws.every(y => y[0] === '--' || (y[0] === '-=' && constInt(y[2]) >= 1) ||
        (y[0] === '=' && Array.isArray(y[2]) && y[2][0] === '-' && y[2][1] === x && constInt(y[2][2]) >= 1))
      if (!ok || countWrites(root, x) !== ws.length) return null
      return Math.max(0, E[1] - L + (cond[0] === '>=' ? 1 : 0))
    }
    return null
  }
  // (a step written as its word, `x = (x + c) | 0` — the idiom, and the form a loop
  // version gives a cursor's steps — is the step: the word's own wrap is the cursor's)
  const unwrapped = (n) => n[0] === '=' && Array.isArray(n[2]) && n[2][0] === '|' && n[2].length === 3 ? (constInt(n[2][2]) === 0 ? ['=', n[1], n[2][1]] : constInt(n[2][1]) === 0 ? ['=', n[1], n[2][2]] : n) : n
  const delta = (n0) => {
    const n = unwrapped(n0)
    if (absolute) {
      if (n[0] === '++' || n[0] === '--') return 1
      let value = n[0] === '+=' || n[0] === '-=' ? n[2] : null
      if (n[0] === '=' && Array.isArray(n[2])) {
        const [, a, b] = n[2]
        if ((n[2][0] === '+' || n[2][0] === '-') && a === name) value = b
        else if (n[2][0] === '+' && b === name) value = a
      }
      if (value == null || refsName(value, name, REFS_THROUGH_ARROWS)) return null
      // A body declaration need not dominate this write. Only facts closed
      // over the whole body may supply an operand; do not substitute its init.
      const r = evRange(value)
      return r && Number.isInteger(r[0]) && Number.isInteger(r[1])
        ? Math.max(Math.abs(r[0]), Math.abs(r[1])) : null
    }
    if (n[0] === '++') return 1
    // (a step by a value of a known nonnegative range, `p += run` over a byte
    // read's run, rises by at most the range's top: a range closed over the
    // loop, `stepRange`, of elements and literals, never a hull of the moment)
    const rise = (v) => {
      const d = constInt(v)
      if (d != null) return d > 0 ? d : null
      const r = stepRange ? stepRange(subst(v)) : null
      // (the least rise: the floor a guard holds the step's name above, where it is higher)
      if (minimum && typeof v === 'string' && floors.has(v) && !refsName(v, name, REFS_THROUGH_ARROWS)) return Math.max(floors.get(v), r?.[0] ?? -Infinity)
      return r && Number.isFinite(r[1]) && r[0] >= 0 && !refsName(v, name, REFS_THROUGH_ARROWS) ? (minimum ? r[0] : r[1]) : null
    }
    if (n[0] === '+=') return rise(n[2])
    if (n[0] === '=' && Array.isArray(n[2]) && n[2][0] === '+') return n[2][1] === name ? rise(n[2][2]) : n[2][2] === name ? rise(n[2][1]) : null
    if (!upperOnly) return null
    if (n[0] === '--') return 0
    if (n[0] === '-=') { const d = constInt(n[2]); return d != null && d >= 0 ? 0 : null }
    if (n[0] === '=' && Array.isArray(n[2]) && n[2][0] === '-' && n[2][1] === name) {
      const d = constInt(n[2][2]); return d != null && d >= 0 ? 0 : null
    }
    return null
  }
  const leavesRound = (n) => { let out = false; const walk = (y) => { if (out || !Array.isArray(y)) return; if (y[0] === '=>') return; if (((y[0] === 'break' || y[0] === 'continue') && typeof y[1] === 'string') || y[0] === 'return' || y[0] === 'throw') { out = true; return } for (let i = 1; i < y.length; i++) walk(y[i]) }; walk(n); return out }
  const seq = (xs) => { let n = 0; for (const x of xs) { const d = eff(x); if (d == null) return null; n += d } return n }
  // (a list opens a scope; a declaration in it is in scope from its statement on)
  const seqScoped = (xs) => {
    scopes.push(new Map())
    try {
      let n = 0
      for (const x of xs) {
        const d = eff(x)
        if (Array.isArray(x) && (x[0] === 'let' || x[0] === 'const')) collectDecls(x, scopes[scopes.length - 1])
        if (d == null) return null
        n += d
      }
      return n
    } finally { scopes.pop() }
  }
  const eff = (n) => {
    if (!Array.isArray(n)) return 0
    const op = n[0]
    if (op === ';' || op === '{}') return seqScoped(n.slice(1))
    if (op === '=>') return closureWrites.has(name) ? null : 0
    if (absolute && (op === 'for' || op === 'while' || op === 'do' || op === 'switch' || op === 'catch' || op === 'finally'))
      return isReassigned(n, name) ? null : 0
    // (a nested loop writing nothing of the counter advances it by nothing, and
    // leaves the round only through its own breaks: a labeled jump, a return or
    // a throw leaves the round's advance uncounted)
    if (minimum && (op === 'for' || op === 'while' || op === 'do')) {
      if (leavesRound(n)) return null
      if (!isReassigned(n, name)) { if ([...testNames].some(x => isReassigned(n, x))) testWrites++; return 0 }
      // (a nested loop that runs at least once advances by at least one iteration's least; the test's names may be written in it)
      if (op === 'do' || !runsOnce(n)) { testWrites++; return null }
      const head = op === 'for' ? eff(n[1]) : 0
      const per = op === 'for' ? seq([n[2], n[3], n[4]]) : seq([n[1], n[2]])
      testWrites++
      return head == null || per == null ? null : head + per
    }
    // (a path that leaves the function, by a return or a throw, completes no
    // round: it bounds no round's advance)
    if (minimum && (op === 'return' || op === 'throw')) return Infinity
    if (minimum && (op === 'switch' ||
        op === 'try' || op === 'catch' || op === 'finally' || op === 'break' ||
        op === 'continue')) return null
    // Optional operands may not run, even when their receiver does.
    if (minimum && hasOptionalChain(n))
      return isReassigned(n, name) ? null : 0
    if (minimum && MUTATE_OPS.has(op) && typeof n[1] === 'string' && testNames.has(n[1]) && n[1] !== name) testWrites++
    if (MUTATE_OPS.has(op) && n[1] === name) { if (minimum && testNames.has(name)) testWrites++; return delta(n) }
    if (op === 'if') {
      const c = eff(n[1])
      // (`if (x >= K)`: the arm holds x at K or above, a floor for a step's rise by x, where the arm writes x nowhere)
      const t = n[1], floor = minimum && Array.isArray(t) && t.length === 3 && (t[0] === '>=' || t[0] === '>') && typeof t[1] === 'string' && !isReassigned(n[2], t[1]) ? constInt(t[2]) : null
      const had = floor != null ? floors.get(t[1]) : undefined
      if (floor != null) floors.set(t[1], Math.max(had ?? -Infinity, t[0] === '>' ? floor + 1 : floor))
      const a = eff(n[2])
      if (floor != null) { if (had === undefined) floors.delete(t[1]); else floors.set(t[1], had) }
      const b = n.length > 3 ? eff(n[3]) : 0
      return c == null || a == null || b == null ? null : c + (minimum ? Math.min(a, b) : Math.max(a, b))
    }
    if (op === '?:') {
      const c = eff(n[1]), a = eff(n[2]), b = eff(n[3])
      return c == null || a == null || b == null ? null : c + (minimum ? Math.min(a, b) : Math.max(a, b))
    }
    if (op === '&&' || op === '||' || op === '??') {
      const a = eff(n[1]), b = eff(n[2])
      return a == null || b == null ? null : a + (minimum ? Math.min(0, b) : Math.max(0, b))
    }
    if ((op === 'for' || op === 'while') && isReassigned(n, name)) {
      const head = op === 'for' ? eff(n[1]) : 0
      const per = op === 'for' ? seq([n[2], n[3], n[4]]) : seq([n[1], n[2]])
      if (head == null || per == null) return null
      // iterations that cannot raise the counter raise it by zero, however many run
      if (upperOnly && per === 0) return head
      const trips = nestedTrips(n)
      return trips == null ? null : head + trips * per
    }
    if (op === 'while' || op === 'for' ||
        op === 'catch' || op === 'finally' ||
        op === 'break' || op === 'continue' || op === 'return' || op === 'throw')
      return isReassigned(n, name) ? null : 0
    return seq(n.slice(1))
  }
  return eff(root)
}

/** A guarded extent proof applies only inside its versioned loop. */
export function activeBoundsFrame(ctx, recv, idx) {
  // a versioned assumption is scoped to its OWNING loop: honored only while that
  // loop's frame is on the emission stack (a textual twin of the access OUTSIDE
  // the loop sees the cursor past its bound and must stay checked)
  const owner = ctx.types.assumedBounds?.get(idxKey(recv, idx))
  const frame = owner == null ? null : ctx.func.stack?.find(f => f.bodyNode === owner)
  if (frame) return frame
  // 4b. per-RECEIVER guarded const hull — the value-level twin of the key channel.
  //     The versioned guard proved every CONSTANT extent ≤ hull.max < recv.length,
  //     so any read whose index is a compile-time constant within the hull is
  //     in-bounds regardless of how many clone/rename layers (plan unroll, per-arm
  //     emit unroll, inline suffixes) rewrote the index NODE since the scan — the
  //     AST-JSON assumption keys break under those; the receiver name + value do
  //     not. Same owner-frame scoping as the key channel.
  const hull = ctx.types.assumedConstHull?.get(recv)
  if (hull != null) {
    const frame = ctx.func.stack?.find(f => f.bodyNode === hull.owner)
    if (frame) { const v = constIntExpr(idx); if (v != null && v >= 0 && v <= hull.max) return frame }
  }
  return null
}

export const activeBoundsAssumption = (ctx, recv, idx) => activeBoundsFrame(ctx, recv, idx) != null

/** Read existing index proofs without invoking the interval interpreter. */
export function typedIndexKnown(ctx, recv, idx) {
  if (typeof recv !== 'string') return false
  if (activeBoundsAssumption(ctx, recv, idx)) return true
  if (ctx.facts.ipProven.get(ctx.func.body)?.has(idxKey(recv, idx))) return true
  if (typeof idx === 'string' && inBoundsArrIdx(ctx).has(recv + '\x00' + idx)) return true
  const len = ctx.func.typedLen?.get(recv) ?? ctx.scope?.globalTypedLen?.get(recv)
    ?? ctx.func.localReps?.get(recv)?.arrayLen
  if (len == null) return false
  const k = intLiteralValue(idx)
  if (k != null) return k >= 0 && k < len
  if (Array.isArray(idx) && idx[0] === '&' && idx.length === 3) {
    const m = intLiteralValue(idx[1]) ?? intLiteralValue(idx[2])
    if (m != null) return m >= 0 && m < len
  }
  if (typeof idx === 'string') {
    const B = litBoundArrIdx(ctx).get(recv + '\x00' + idx)
    if (B != null) return B <= len
    if (ctx.func.locals?.get(idx) === 'i32') {
      const range = intExprRange(idx)
      if (range && range[0] >= 0 && range[1] < len) return true
    }
  }
  return false
}
