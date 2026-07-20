/**
 * Sound CSE of repeated pure typed-array element loads within a straight-line region.
 *
 * `re[b] = re[a] - tr;  …;  re[a] = re[a] + tr`  — the fft butterfly loads `re[a]` twice.
 * Cache the first load in a temp and reuse it (eliminating the redundant load) when every
 * intervening store writes a provably-DIFFERENT element, so it cannot clobber the cached value.
 *
 * Soundness (no array-distinctness / non-aliasing assumption):
 *   A cached `arr[idx]` survives a store `any[idx2]` iff `idx2 ≠ idx` is PROVABLE. If the indices
 *   differ, the store hits a different element even if `any` aliases `arr`. If `idx2` might equal
 *   `idx` (incl. a different array at the same index — could alias), invalidate. Array-name-
 *   agnostic; never assumes non-aliasing. Reassigning `arr` / any var in `idx`, an impure call, or
 *   a control-flow edge also flushes. So `re[a]` (intervening stores all at index `b = a+half ≠ a`)
 *   is CSE'd, while `im[a]` (the `re[a]` store is at the same index `a`) correctly is NOT.
 *
 *   provablyDiffer: distinct int constants, or `idx2 = idx ± P` with P provably > 0 — the canonical
 *   P is a loop bound: inside `for (j = C≥0; j < B; …)` the body runs only when `0 ≤ j < B`, so
 *   `B ≥ 1`, hence `a + B ≠ a`. A name index resolves through its single `let X = a + b` def.
 *
 * Runs post-analyze (purity known) and pre-emit, mutating the body. Purely conservative.
 */

import { ASSIGN_OPS } from '../ast.js'

const isArr = (x) => Array.isArray(x)   // arrow, not a bare builtin alias — jz can't self-host a builtin as a first-class value
const isName = (x) => typeof x === 'string'

const stableIdx = (e) => {
  if (isName(e) || typeof e === 'number') return true
  if (!isArr(e)) return false
  const op = e[0]
  if (op == null) return typeof e[1] === 'number'
  if ((op === '+' || op === '-' || op === '*') && e.length === 3) return stableIdx(e[1]) && stableIdx(e[2])
  return false
}

const idxKey = (e) => {
  if (isName(e)) return e
  if (typeof e === 'number') return `#${e}`
  if (isArr(e) && e[0] == null) return `#${e[1]}`
  if (isArr(e)) return `(${e[0]} ${idxKey(e[1])} ${e[2] !== undefined ? idxKey(e[2]) : ''})`
  return '?'
}

const idxVars = (e, out) => {
  if (isName(e)) out.add(e)
  else if (isArr(e)) for (let i = 1; i < e.length; i++) idxVars(e[i], out)
}

const CONTROL = new Set(['for', 'while', 'do', 'if', 'loop', 'block', 'switch', 'try', '=>',
  'br', 'br_if', 'br_table', 'return', 'continue', 'break', 'throw', 'unreachable'])
const ASSIGN = new Set([...ASSIGN_OPS, '++', '--'])

function buildFacts(body) {
  const def = new Map(), declCount = new Map(), positive = new Set()
  const scan = (n) => {
    if (!isArr(n)) return
    const op = n[0]
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (isName(d)) declCount.set(d, (declCount.get(d) || 0) + 1)
        else if (isArr(d) && d[0] === '=' && isName(d[1])) {
          declCount.set(d[1], (declCount.get(d[1]) || 0) + 1)
          def.set(d[1], d[2])
        }
      }
    }
    if (op === 'for') {
      // parse shape ['for', [';', init, cond, step], body]; post-prepare ['for', init, cond, step, body].
      const hdr2 = isArr(n[1]) && n[1][0] === ';'
      const init = hdr2 ? n[1][1] : n[1]
      const cond = hdr2 ? n[1][2] : n[2]
      const lo = isArr(init) && (init[0] === 'let' || init[0] === 'const') && isArr(init[1]) && init[1][0] === '=' ? init[1][2]
        : (isArr(init) && init[0] === '=' ? init[2] : null)
      const loZero = (typeof lo === 'number' && lo >= 0) || (isArr(lo) && lo[0] == null && lo[1] >= 0)
      // `for (j = 0; j < BOUND; …)` ⇒ inside the body BOUND ≥ 1 (j ≥ 0 ∧ j < BOUND). Mark BOUND positive.
      if (loZero && isArr(cond) && (cond[0] === '<' || cond[0] === '<=') && isName(cond[2])) positive.add(cond[2])
    }
    for (let i = 1; i < n.length; i++) scan(n[i])
  }
  scan(body)
  for (const [n, c] of declCount) if (c > 1) def.delete(n)   // reassigned ⇒ not a stable def
  return { def, positive }
}

const cval = (e) => typeof e === 'number' ? e : (isArr(e) && e[0] == null ? e[1] : null)

const isPositive = (e, F) => {
  const c = cval(e); if (c != null) return c > 0
  if (isName(e)) return F.positive.has(e)
  if (isArr(e) && (e[0] === '+' || e[0] === '*') && e.length === 3) return isPositive(e[1], F) && isPositive(e[2], F)
  return false
}

const asBasePlus = (e, F) => {
  if (isName(e) && F.def.has(e)) e = F.def.get(e)
  if (isArr(e) && e[0] === '+' && e.length === 3) return { base: e[1], off: e[2] }
  return null
}

function provablyDiffer(idx, idx2, F) {
  const ka = idxKey(idx), kb = idxKey(idx2)
  if (ka === kb) return false
  const va = cval(idx), vb = cval(idx2)
  if (va != null && vb != null) return va !== vb
  const bp2 = asBasePlus(idx2, F); if (bp2 && idxKey(bp2.base) === ka && isPositive(bp2.off, F)) return true
  const bp1 = asBasePlus(idx, F);  if (bp1 && idxKey(bp1.base) === kb && isPositive(bp1.off, F)) return true
  return false
}

/**
 * @param body        function-body AST (mutated in place)
 * @param isTypedArray (name) => boolean — receiver is a pure typed-array load
 * @param freshName   () => string — unique temp local name
 * @returns number of loads eliminated
 */
export function cseLoads(body, isTypedArray, freshName) {
  if (!isArr(body)) return 0
  const F = buildFacts(body)
  let eliminated = 0

  // Process the statement list of a `[';', …]` node (children [1..]).
  const runSeq = (seq) => {
    // key → { arr, idxNode, idxVars, temp, firstParent, firstIdx, firstStmt }
    const avail = new Map()
    const inserts = []   // { at: stmtIdx, binding }

    const flush = () => avail.clear()
    const invalidateVar = (name) => { for (const [k, e] of avail) if (e.arr === name || e.idxVars.has(name)) avail.delete(k) }

    const reads = (node, parent, pi, si, noCseKey = null) => {
      if (!isArr(node) || node[0] === 'str') return
      // A CONTROL boundary nested INSIDE a statement (a while inside a `{}`
      // block, an if arm): its body re-executes / conditionally executes, so an
      // element read in there is NOT the same value as a textual twin outside —
      // `while (…) { s ^= a[i]; i++ }  s ^= a[i]` must not CSE across the loop
      // (the pair+tail unroll shape exposed this: the tail's a[i] fused with
      // the loop body's and hoisted a loop-VARYING load above the while).
      // descend() gives each nested sequence its own table; here we stop and
      // flush — nothing cached before a control edge survives it.
      if (CONTROL.has(node[0])) { flush(); return }
      // Element/member assignment targets must stay targets. Plain `=` does not
      // read the slot; compound/update ops do, but rewriting the LHS node itself
      // turns the eventual store into a temp assignment. Only inspect receiver /
      // index subexpressions here, then let the RHS participate in load CSE.
      if (ASSIGN.has(node[0]) && isArr(node[1]) && (node[1][0] === '[]' || node[1][0] === '.' || node[1][0] === '?.')) {
        const lhs = node[1]
        reads(lhs[0] === '[]' ? lhs[2] : lhs[1], lhs, lhs[0] === '[]' ? 2 : 1, si)   // index / receiver
        // Leave same-slot i32 RMW reads intact for typedarray.js's stronger
        // one-guard fusion. Turning `a[i] ^ (a[i] >>> k)` into a pre-statement
        // temp forces the first checked load back outside that guard.
        const rhs = node[2]
        const i32Rmw = node[0] === '=' && lhs[0] === '[]' && isName(lhs[1]) && stableIdx(lhs[2]) && isArr(rhs) &&
          (['&', '|', '^', '<<', '>>', '>>>'].includes(rhs[0]) ||
           (rhs[0] === '()' && rhs.length > 2 && (rhs[1] === 'math.imul' ||
             (isArr(rhs[1]) && rhs[1][0] === '.' && rhs[1][1] === 'Math' && rhs[1][2] === 'imul'))))
        const ownKey = i32Rmw ? `${lhs[1]}|${idxKey(lhs[2])}` : null
        for (let i = 2; i < node.length; i++) reads(node[i], node, i, si, ownKey)    // rhs value
        return
      }
      if (node[0] === '[]' && isName(node[1]) && isTypedArray(node[1]) && stableIdx(node[2])) {
        const arr = node[1], key = `${arr}|${idxKey(node[2])}`
        if (key === noCseKey) return
        const e = avail.get(key)
        if (e) {
          if (e.temp === null) {
            e.temp = freshName()
            inserts.push({ at: e.firstStmt, binding: ['let', ['=', e.temp, ['[]', arr, e.idxNode]]] })
            e.firstParent[e.firstIdx] = e.temp           // rewrite the 1st occurrence to read the temp
          }
          parent[pi] = e.temp                            // rewrite this (2nd+) occurrence
          eliminated++
          return
        }
        const vars = new Set(); idxVars(node[2], vars)
        avail.set(key, { arr, idxNode: node[2], idxVars: vars, temp: null, firstParent: parent, firstIdx: pi, firstStmt: si })
        return                                            // don't descend into a stable index
      }
      if (node[0] === '()' || node[0] === 'call') { flush(); for (let i = 1; i < node.length; i++) reads(node[i], node, i, si, noCseKey); return }
      for (let i = 1; i < node.length; i++) reads(node[i], node, i, si, noCseKey)
    }

    const writes = (node) => {
      if (!isArr(node)) return
      const op = node[0]
      if (ASSIGN.has(op)) {
        const lhs = node[1]
        if (isName(lhs)) invalidateVar(lhs)
        else if (isArr(lhs) && lhs[0] === '[]') {
          const idx2 = lhs[2]
          for (const [k, e] of [...avail]) if (!provablyDiffer(e.idxNode, idx2, F)) avail.delete(k)
        }
        for (let i = 2; i < node.length; i++) writes(node[i])
        return
      }
      for (let i = 1; i < node.length; i++) writes(node[i])
    }

    for (let si = 1; si < seq.length; si++) {
      const s = seq[si]
      if (!isArr(s)) continue
      if (CONTROL.has(s[0])) { flush(); continue }   // nesting handled by the outer `descend`
      reads(s, seq, si, si)
      writes(s)
    }
    inserts.sort((a, b) => b.at - a.at)
    for (const ins of inserts) seq.splice(ins.at, 0, ins.binding)
  }

  // Walk to every `[';', …]` sequence; run CSE on each, then recurse into its (now-rewritten) stmts.
  const descend = (node) => {
    if (!isArr(node)) return
    if (node[0] === ';') runSeq(node)
    for (let i = 1; i < node.length; i++) descend(node[i])
  }
  descend(body)
  return eliminated
}
