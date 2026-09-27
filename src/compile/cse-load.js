/**
 * Sound CSE of repeated pure typed-array element loads and object field loads within a
 * straight-line region.
 *
 * `re[b] = re[a] - tr;  …;  re[a] = re[a] + tr`  — the fft butterfly loads `re[a]` twice.
 * Cache the first load in a temp and reuse it (eliminating the redundant load) when no
 * intervening store can reach the cached element.
 *
 * Soundness (no non-aliasing assumption): a cached `arr[idx]` survives a store `recv[idx2]` iff
 *   - `recv` never holds typed elements (a plain array or object: separate storage), or
 *   - `recv` addresses the same element grid as `arr` and `idx2 ≠ idx` is PROVABLE. The same grid:
 *     the same binding, or two non-view typed arrays of one constructor. Aliasing non-view typed
 *     arrays share base and element width (`new T(buf)` reinterprets in place); a view
 *     (`subarray`, `new T(buf, off)`) may start mid-buffer, and another element type
 *     (`new Uint8Array(f.buffer)`) splits the bytes differently, so index reasoning fails there.
 *   Any other store invalidates. Reassigning `arr` / any var in `idx`, an impure call, or a
 *   control-flow edge also flushes. So `re[a]` (intervening stores to `re`/`im`, both owned
 *   Float64Arrays, at index `b = a+half ≠ a`) is CSE'd, while `im[a]` (the `re[a]` store is at the
 *   same index `a`) correctly is NOT.
 *
 *   provablyDiffer: distinct int constants, or `idx2 = idx ± P` with P provably > 0 — the canonical
 *   P is a loop bound: inside `for (j = C≥0; j < B; …)` the body runs only when `0 ≤ j < B`, so
 *   `B ≥ 1`, hence `a + B ≠ a`. A name index resolves through its single `let X = a + b` def.
 *
 * An `if (C) break|continue|return|throw` with no else keeps C's loads available past it:
 * the statements after it run only when C ran and fell through, and the arm stores nothing.
 * A short-circuit or a conditional runs its first operand always, so a load read there is
 * available after the expression and inside its later operands; a load first read in a later
 * operand is that operand's own, and what any operand invalidated is gone after the expression.
 *
 * A field of an object is cached the same way (`fieldOf`): `e.type` tested against four names
 * by four inlined guards is one load. The receiver is a binding, the field a slot of every
 * layout the summary lists for it (no accessor on any of them). A store of a field of that
 * name through any receiver reaches it (two bindings may hold one object), a computed-key
 * store into a receiver that may be an object reaches every field, and a call that may write
 * outer storage, a user conversion and a reassignment of the receiver flush as for elements.
 * An element store into an array or a typed array leaves fields alone: separate storage.
 *
 * Runs post-analyze (purity known) and pre-emit, mutating the body. Purely conservative.
 */

import { ASSIGN_OPS, walkAst, isReassigned } from '../ast.js'
import { NUMERIC_BINARY_OPS, NUMERIC_UNARY_OPS } from '../kind-traits.js'
import { scanBindingUses, USE, BINDING_USE_DECLS, BINDING_USE_INIT, BINDING_USE_USES, BINDING_USE_KIND } from './analyze-scans.js'
import { unitIncVar } from './loop-model.js'
import { counterInit, intExprRange } from '../static.js'

/** The storage class a receiver oracle reports for storage that never holds typed elements. */
export const UNTYPED = 'untyped'

const isArr = (x) => Array.isArray(x)   // arrow, not a bare builtin alias — jz can't self-compile a builtin as a first-class value
const isName = (x) => typeof x === 'string'

const stableIdx = (e, runsUserCode) => {
  if (isName(e) || typeof e === 'number') return true
  if (!isArr(e)) return false
  if (runsUserCode?.(e)) return false
  const op = e[0]
  if (op == null) return typeof e[1] === 'number'
  if ((op === '+' || op === '-' || op === '*') && e.length === 3) return stableIdx(e[1], runsUserCode) && stableIdx(e[2], runsUserCode)
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

const CONTROL = new Set(['for', 'while', 'if', 'loop', 'block', '=>', '&&', '||', '??', '?:', '?.()', '?.[]',
  'br', 'br_if', 'br_table', 'return', 'continue', 'break', 'throw', 'unreachable'])
const ASSIGN = new Set([...ASSIGN_OPS, '++', '--'])
const BIT_OPS = new Set(['&', '|', '^', '<<', '>>', '>>>'])
const stableBinding = b => b && !b[BINDING_USE_USES].some(u => u[BINDING_USE_KIND] === USE.REASSIGN || u[BINDING_USE_KIND] === USE.CAPTURE)

// The counter a loop's step advances by one: the step itself, or the one part of
// a comma step that writes the tested name (`j++, k += step` beside `j < half`).
const stepCounter = (step, cond) => {
  if (!isArr(step) || step[0] !== ',') return unitIncVar(step)
  const name = isArr(cond) && isName(cond[1]) ? cond[1] : null
  if (name == null) return null
  let units = 0
  for (let i = 1; i < step.length; i++) {
    if (unitIncVar(step[i]) === name) units++
    else if (isReassigned(step[i], name)) return null
  }
  return units === 1 ? name : null
}

/** Stable definitions from the binding census; positive bounds belong only to the guarded body. */
export function indexFacts(body) {
  const bindings = scanBindingUses(body), def = new Map(), positive = new Map()
  const stable = name => stableBinding(bindings.get(name))
  for (const [name, b] of bindings) if (b[BINDING_USE_DECLS] === 1 && stable(name)) {
    const rhs = b[BINDING_USE_INIT], names = new Set()
    idxVars(rhs, names)
    if ([...names].every(stable)) def.set(name, rhs)
  }
  const guards = new Map(), stack = []
  let active = new Set()
  walkAst(body, { enter: n => {
    if (n[0] === '=>') return false
    if (guards.has(n)) { stack.push(active); active = new Set(active); active.add(guards.get(n)) }
    if (n[0] === ';') positive.set(n, active)
    if (n[0] === 'for') {
      const [, init, cond, step, loopBody] = n
      const iv = stepCounter(step, cond)
      const lo = iv && cval(counterInit(init, iv))
      if (lo != null && lo >= 0 && cond?.[0] === '<' && cond[1] === iv && isName(cond[2]) && stable(cond[2]) && !isReassigned(loopBody, iv))
        guards.set(loopBody, cond[2])
    }
  }, exit: n => { if (guards.has(n)) active = stack.pop() } })
  return { def, positive, bindings }
}

const cval = (e) => typeof e === 'number' ? e : (isArr(e) && e[0] == null ? e[1] : null)

const isPositive = (e, F, scope) => {
  const c = cval(e); if (c != null) return c > 0
  if (isName(e)) return F.positive.get(scope)?.has(e) === true
  if (isArr(e) && (e[0] === '+' || e[0] === '*') && e.length === 3) return isPositive(e[1], F, scope) && isPositive(e[2], F, scope)
  return false
}

// Positive alone does not separate word indices: a displacement of 2^32
// wraps onto the same element. Reuse the shared integer range proof.
const positiveWordOffset = (off, F, scope) => {
  const binding = isName(off) ? F.bindings.get(off) : null
  if (isName(off) && (binding?.[BINDING_USE_DECLS] !== 1 || !stableBinding(binding))) return false
  const range = intExprRange(binding ? binding[BINDING_USE_INIT] : off)
  return range && range[1] < 0x100000000 && (range[0] > 0 || isPositive(off, F, scope))
}

const asBasePlus = (e, F) => {
  if (isName(e) && F.def.has(e)) e = F.def.get(e)
  if (isArr(e) && e[0] === '+' && e.length === 3) return { base: e[1], off: e[2] }
  return null
}

/** Whether indexes `idx` and `idx2` can never be equal (`F` from indexFacts). */
export function provablyDiffer(idx, idx2, F, scope) {
  const ka = idxKey(idx), kb = idxKey(idx2)
  if (ka === kb) return false
  const va = cval(idx), vb = cval(idx2)
  if (va != null && vb != null) return Number.isInteger(va) && Number.isInteger(vb) && (va | 0) !== (vb | 0)
  const bp2 = asBasePlus(idx2, F); if (bp2 && idxKey(bp2.base) === ka && positiveWordOffset(bp2.off, F, scope)) return true
  const bp1 = asBasePlus(idx, F);  if (bp1 && idxKey(bp1.base) === kb && positiveWordOffset(bp1.off, F, scope)) return true
  return false
}

// The expression a statement evaluates first, when the path to it runs through
// first operands alone: the test of an `if`, the first operand of an operator,
// a declaration's or an assignment's value. Null past anything else (a call,
// a store through a receiver, a second declarator).
const HEAD_OPS = new Set(['if', '?:', '||', '&&', '??', '__eager||', '__eager&&', 'return', 'throw', '!', 'typeof', 'u-', 'u+', '~',
  '===', '!==', '==', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>', 'in', 'instanceof'])
const headOf = (stmt) => {
  let n = stmt
  for (;;) {
    if (!isArr(n)) return null
    const op = n[0]
    if (op === '.') return n
    if ((op === 'let' || op === 'const') && n.length === 2 && isArr(n[1]) && n[1][0] === '=' && isName(n[1][1])) n = n[1][2]
    else if (op === '=' && isName(n[1])) n = n[2]
    else if (op === '()' && n.length === 2) n = n[1]   // a grouping
    else if (HEAD_OPS.has(op)) n = n[1]
    else return null
  }
}

/**
 * @param body        function-body AST (mutated in place)
 * @param storageOf   (name) => the receiver's typed constructor (`new.Float64Array`, a
 *                    `….view` suffix for a view), UNTYPED, or null when unknown
 * @param freshName   (value) => string — unique temp local name for the cached value
 * @param isNumeric   (node) => boolean — payload is Number, possibly absent
 * @param isReadonlyCall (callNode) => boolean — the callee writes no storage that exists before
 *                    the call (frame-effects.js), so cached loads survive it
 * @param runsUserCode (node) => boolean — evaluating the node itself, past its operands, may
 *                    run user code (a toString/valueOf conversion, frame-effects.js)
 * @param fieldOf     (node) => boolean: the member read `x.p` loads a slot of an object: no
 *                    accessor, no length, a receiver the summary holds to objects. Such a
 *                    read is cached like an element: a second `e.type` with no store of a
 *                    `type` and no writing call between reads the first one's value. The
 *                    first read is the one its statement evaluates first (headOf), so the
 *                    cache is a `const` declared before that statement.
 * @param mayStoreField (recv) => boolean: a computed-key store into `recv` may write a field
 * @returns number of loads eliminated
 */
export function cseLoads(body, storageOf, freshName, isNumeric, isReadonlyCall = null, runsUserCode = null, fieldOf = null, mayStoreField = null) {
  if (!isArr(body)) return 0
  const F = indexFacts(body)
  let eliminated = 0
  const typedCtor = (name) => { const s = storageOf(name); return s != null && s !== UNTYPED ? s : null }
  // Whether a store `recv[idx2]` leaves the cached element `e` intact (see the soundness note).
  const survives = (e, recv, idx2, scope) => isName(recv) && (storageOf(recv) === UNTYPED ||
    (recv === e.arr || !e.ctor.endsWith('.view') && typedCtor(recv) === e.ctor) && provablyDiffer(e.idxNode, idx2, F, scope))

  // A branch arm that leaves the sequence and stores nothing: the statements
  // after an `if (C) break` run only when C ran and fell through.
  const exitsOnly = (arm) => {
    if (!isArr(arm)) return false
    if (arm[0] === '{}') return arm.length === 2 && exitsOnly(arm[1])
    if (arm[0] === ';') return arm.length === 2 && exitsOnly(arm[1])
    if (arm[0] === 'break' || arm[0] === 'continue') return true
    if (arm[0] !== 'return' && arm[0] !== 'throw') return false
    let pure = true
    walkAst(arm, { enter: n => { if (ASSIGN.has(n[0]) || n[0] === '()' || n[0] === 'call' || n[0] === 'new') pure = false } })
    return pure
  }

  // Process the statement list of a `[';', …]` node (children [1..]).
  const runSeq = (seq) => {
    // key → { arr, ctor, idxNode, idxVars, firstStmt, occ: [{ parent, idx, numeric }] }
    const avail = new Map()
    const shared = []   // entries a second read joined: one load at the first occurrence
    const inserts = []   // { at: stmtIdx, binding }

    let head = null   // the expression the statement being read evaluates first
    const flush = () => avail.clear()
    const invalidateVar = (name) => { for (const [k, e] of avail) if (e.arr === name || e.idxVars.has(name)) avail.delete(k) }
    // A store of a field `prop` reaches that field of every object; one under a
    // computed key (`prop` null) reaches any field.
    const invalidateField = (prop) => { for (const [k, e] of avail) if (e.field != null && (prop == null || e.field === prop)) avail.delete(k) }

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
      // A short-circuit or a conditional runs its first operand always: a load
      // read there is available after the expression, and its later operands
      // read what was available before them. A load first read in an operand
      // that may not run is that operand's own; what an operand invalidated is
      // gone after the expression whichever operand ran.
      if ((node[0] === '||' || node[0] === '&&' || node[0] === '??' || node[0] === '?:') && node.length >= 3) {
        reads(node[1], node, 1, si, noCseKey)
        const before = new Map(avail)
        for (let i = 2; i < node.length; i++) {
          reads(node[i], node, i, si, noCseKey)
          for (const [k, e] of before) if (avail.get(k) !== e) before.delete(k)
          avail.clear()
          for (const [k, e] of before) avail.set(k, e)
        }
        return
      }
      if (CONTROL.has(node[0])) { flush(); return }
      // Element/member assignment targets must stay targets. Plain `=` does not
      // read the slot; compound/update ops do, but rewriting the LHS node itself
      // turns the eventual store into a temp assignment. Only inspect receiver /
      // index subexpressions here, then let the RHS participate in load CSE.
      if (ASSIGN.has(node[0]) && isArr(node[1]) && (node[1][0] === '[]' || node[1][0] === '.' || node[1][0] === '?.')) {
        const lhs = node[1]
        reads(lhs[1], lhs, 1, si)
        if (lhs[0] === '[]') reads(lhs[2], lhs, 2, si)
        if (runsUserCode?.(lhs)) flush()
        // Leave same-slot i32 RMW reads intact for typedarray.js's stronger
        // one-guard fusion. Turning `a[i] ^ (a[i] >>> k)` into a pre-statement
        // temp forces the first checked load back outside that guard.
        const rhs = node[2]
        const i32Rmw = node[0] === '=' && lhs[0] === '[]' && isName(lhs[1]) && stableIdx(lhs[2]) && isArr(rhs) &&
          (BIT_OPS.has(rhs[0]) ||
           (rhs[0] === '()' && rhs.length > 2 && (rhs[1] === 'math.imul' ||
             (isArr(rhs[1]) && rhs[1][0] === '.' && rhs[1][1] === 'Math' && rhs[1][2] === 'imul'))))
        const ownKey = i32Rmw ? `${lhs[1]}|${idxKey(lhs[2])}` : null
        for (let i = 2; i < node.length; i++) reads(node[i], node, i, si, ownKey)    // rhs value
        if (runsUserCode?.(node)) flush()
        if (lhs[0] === '[]') {
          for (const [k, e] of avail) if (e.field == null && !survives(e, lhs[1], lhs[2], seq)) avail.delete(k)
          if (!mayStoreField || mayStoreField(lhs[1])) invalidateField(isArr(lhs[2]) && lhs[2][0] === 'str' ? lhs[2][1] : null)
        } else invalidateField(isName(lhs[2]) ? lhs[2] : null)
        return
      }
      if ((node[0] === '++' || node[0] === '--' || node[0] === 'delete') && isArr(node[1]) && (node[1][0] === '.' || node[1][0] === '?.' || node[1][0] === '[]')) {
        const lhs = node[1]
        reads(lhs[1], lhs, 1, si)
        if (lhs[0] === '[]') { reads(lhs[2], lhs, 2, si); flush() }
        else invalidateField(isName(lhs[2]) ? lhs[2] : null)
        return
      }
      // A field of an object: cached like an element, its receiver the binding.
      if (node[0] === '.' && fieldOf && isName(node[1]) && isName(node[2]) && !(parent[0] === '()' && pi === 1) && !(parent[0] === '?.()' && pi === 1) && fieldOf(node)) {
        const key = `${node[1]}.${node[2]}`
        const numeric = isNumeric(node) && (NUMERIC_BINARY_OPS.includes(parent[0]) ||
          NUMERIC_UNARY_OPS.has(parent[0]) || parent[0] === '+' && isNumeric(parent))
        const e = avail.get(key)
        if (e) {
          if (e.occ.length === 1) shared.push(e)
          e.occ.push({ parent, idx: pi, numeric })
          eliminated++
          return
        }
        if (node === head) avail.set(key, { arr: node[1], field: node[2], read: node, idxVars: new Set(), firstStmt: si, occ: [{ parent, idx: pi, numeric }] })
        return
      }
      const ctor = node[0] === '[]' && isName(node[1]) && stableIdx(node[2], runsUserCode) && !runsUserCode?.(node) ? typedCtor(node[1]) : null
      if (ctor) {
        const arr = node[1], key = `${arr}|${idxKey(node[2])}`
        if (key === noCseKey) return
        // A Number|undefined read consumed arithmetically normalizes its miss
        // (`u+`); an identity-observing use keeps the value. One load serves
        // both: the temp holds the value, a numeric use normalizes it (a
        // read every use of which is numeric normalizes once, at the binding).
        const numeric = isNumeric(node) && (NUMERIC_BINARY_OPS.includes(parent[0]) ||
          NUMERIC_UNARY_OPS.has(parent[0]) || parent[0] === '+' && isNumeric(parent))
        const e = avail.get(key)
        if (e) {
          if (e.occ.length === 1) shared.push(e)
          e.occ.push({ parent, idx: pi, numeric })
          eliminated++
          return
        }
        const vars = new Set(); idxVars(node[2], vars)
        avail.set(key, { arr, ctor, idxNode: node[2], idxVars: vars, firstStmt: si, occ: [{ parent, idx: pi, numeric }] })
        return                                            // don't descend into a stable index
      }
      // A call or a user conversion runs after its operands: loads read in them are cached
      // before it and do not survive it.
      if (node[0] === '()' || node[0] === '?.()' || node[0] === 'call') {
        for (let i = 1; i < node.length; i++) reads(node[i], node, i, si, noCseKey)
        if (!(isReadonlyCall && isReadonlyCall(node))) flush()
        return
      }
      for (let i = 1; i < node.length; i++) reads(node[i], node, i, si, noCseKey)
      if (runsUserCode && runsUserCode(node)) flush()
      if (ASSIGN.has(node[0]) && isName(node[1])) invalidateVar(node[1])
    }

    for (let si = 1; si < seq.length; si++) {
      const s = seq[si]
      if (!isArr(s)) continue
      head = headOf(s)
      if (CONTROL.has(s[0])) {
        // `if (C) break`: C runs on every path to the next statement and the
        // arm stores nothing, so C's loads stay available (the sift loop's
        // `if (a[i] >= a[child]) break` then swaps without reloading either).
        if (s[0] === 'if' && s.length === 3 && exitsOnly(s[2])) { reads(s[1], s, 1, si); continue }
        flush(); continue   // nesting handled by the outer `descend`
      }
      reads(s, seq, si, si)
    }
    for (const e of shared) {
      if (e.field != null) {
        // The statement evaluates this read first: a declaration before it holds the value.
        const read = ['.', e.arr, e.field], temp = freshName(read)
        inserts.push({ at: e.firstStmt, binding: ['const', ['=', temp, read]] })
        for (const o of e.occ) o.parent[o.idx] = temp
        continue
      }
      const read = ['[]', e.arr, e.idxNode], allNumeric = e.occ.every(o => o.numeric)
      const cached = allNumeric ? ['u+', read] : read, temp = freshName(cached)
      // Declare storage before the statement, but evaluate the load exactly at
      // its first occurrence, after preceding operands and their effects.
      // The first load dominates every use; the initializer is unobservable.
      // A numeric zero avoids introducing an artificial absent value into
      // otherwise numeric storage. A checked load still preserves its miss.
      inserts.push({ at: e.firstStmt, binding: allNumeric || isNumeric(read) ? ['let', ['=', temp, [null, 0]]] : ['let', temp] })
      for (let i = 0; i < e.occ.length; i++) {
        const o = e.occ[i]
        const value = i ? temp : ['=', temp, cached]
        o.parent[o.idx] = o.numeric && !allNumeric ? ['u+', value] : value
      }
    }
    inserts.sort((a, b) => b.at - a.at)
    for (const ins of inserts) seq.splice(ins.at, 0, ins.binding)
  }

  // Walk to every `[';', …]` sequence; run CSE on each, then recurse into its (now-rewritten) stmts.
  walkAst(body, { enter: n => { if (n[0] === ';') runSeq(n) } })
  return eliminated
}
