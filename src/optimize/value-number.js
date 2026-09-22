/**
 * Value numbering: two expressions that compute one value compute it once.
 *
 * A helper inlined twice with the same arguments (colorpq's
 * `spow(L / 10000, nv)` in the numerator and the denominator of one
 * fraction) leaves two chains of locals that hold the same values under
 * different names: `a1 = L / c; v1 = |a1|; p1 = pow(v1, e)` and then `a2 =
 * L / c; v2 = |a2|; p2 = pow(v2, e)`. watr's CSE dedupes identical subtrees,
 * and `L / c` is one; but `|a2|` is not `|a1|` to it, so the chains stay two
 * and the kernel runs twice. This pass numbers values instead of names: a
 * local's number is its definition's, an expression's is its operator over
 * its operands' numbers, a load's adds the state clock (every store, global
 * write, impure call and region boundary advances it). An expression whose number was
 * computed before, into a local that still holds it, becomes a read of that
 * local; a computation with no holder gets one when a later site will read
 * it: a statement of its own before the statement it sits in (so the
 * scheduler can move it, optimize/schedule.js), or a tee in place when it
 * reads a local that statement assigns, can trap, calls a read-only user
 * function, or sits under a condition. Only computations worth a local are shared: a
 * call, a division, a square root, or three operators and more.
 *
 * Regions keep it sound. A loop's body may run any number of times, so
 * every local it assigns is unknown on entry and on exit. An `if` arm is
 * unknown to the other arm and to what follows: the arms start from the
 * same state, and every local either assigns is unknown after the `if`. A
 * block that a branch targets ends the same way. Straight-line code inside
 * a region shares freely. Impure calls and stores touch no local, so the
 * numbering survives them; state-dependent values, keyed by the clock, do not.
 *
 * Runs once, last in the per-function pipeline, on the shapes the
 * vectorizer and the inliners leave; watr's CSE then sees one chain.
 *
 * @module optimize/value-number
 */
import { findBodyStart, nextLocalId } from '../ir.js'
import { walkAst } from '../ast.js'
import { mayTrapOp } from '../ir/classify.js'
import { isMemWrite as writesMemory } from 'watr/optimize'
import { pureKernel } from './pure-funcs.js'

const isArr = Array.isArray
const TYPED = /^(i32|i64|f32|f64|v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./
const SCALAR = new Set(['i32', 'i64', 'f32', 'f64'])
const CONTROL = new Set(['block', 'loop', 'if', 'then', 'else', 'br', 'br_if', 'br_table', 'return', 'return_call', 'unreachable'])
/** Operators that touch no local and no memory: their operands are straight-line code. */
const TRANSPARENT = new Set(['drop', 'nop', 'result'])
const COMPARE = /^(eq|ne|lt|gt|le|ge|lt_s|lt_u|gt_s|gt_u|le_s|le_u|ge_s|ge_u|eqz)$/
const OPERAND_OPS = /^(add|sub|mul|div|div_s|div_u|rem_s|rem_u|and|or|xor|not|andnot|shl|shr_s|shr_u|rotl|rotr|min|max|pmin|pmax|copysign|abs|neg|sqrt|ceil|floor|trunc|nearest|eqz|clz|ctz|popcnt|bitselect|eq|ne|lt|gt|le|ge|lt_s|lt_u|gt_s|gt_u|le_s|le_u|ge_s|ge_u)$/
const laneScalar = (p) => p === 'f64x2' ? 'f64' : p === 'f32x4' ? 'f32' : p === 'i64x2' ? 'i64' : 'i32'

const isLoad = (op) => op.includes('.load')
/** An operator whose value comes from its operands: numeric, lane or select; loads join it under the memory clock. */
const valueOp = (op) => (TYPED.test(op) && !writesMemory(op) && !op.includes('atomic')) || op === 'select'

/** The type an expression produces, from its operator; null for a call (see `consumerType`). */
const selfType = (n, types) => {
  const op = n[0]
  if (op === 'local.get' || op === 'local.tee') return types.get(n[1]) ?? null
  if (op === 'select') return isArr(n[1]) ? selfType(n[1], types) : null
  if (op === 'if' || op === 'block') { const r = n.find(c => isArr(c) && c[0] === 'result'); return r ? r[1] : null }
  const m = TYPED.exec(op)
  if (!m) return null
  const p = m[1], rest = op.slice(p.length + 1)
  if (SCALAR.has(p)) return COMPARE.test(rest) ? 'i32' : p
  if (rest.startsWith('extract_lane')) return laneScalar(p)
  if (rest === 'any_true' || rest === 'all_true' || rest === 'bitmask') return 'i32'
  return 'v128'
}

/** The type an operand position takes, from the operator that consumes it. */
const consumerType = (parent, idx, types) => {
  const op = parent[0]
  if (op === 'local.set' || op === 'local.tee') return types.get(parent[1]) ?? null
  const m = TYPED.exec(op)
  if (!m) return null
  const p = m[1], rest = op.slice(p.length + 1)
  if (SCALAR.has(p)) return OPERAND_OPS.test(rest) ? p : null
  if (rest === 'splat') return laneScalar(p)
  if (rest === 'replace_lane') return idx === 3 ? laneScalar(p) : 'v128'
  return OPERAND_OPS.test(rest) ? 'v128' : null
}

/** Whether a shared computation is worth a local: a call, a division, a root, or three operators and more. */
const worth = (n) => {
  let ops = 0, heavy = false
  walkAst(n, { enter: (c) => {
    const op = c[0]
    if (op === 'call' || /\.(div|div_s|div_u|sqrt)$/.test(op)) heavy = true
    else if (op !== 'local.get' && !op.endsWith('.const')) ops++
  } })
  return heavy || ops >= 3
}

/** Every local the subtree assigns. */
const assigned = (n, out = new Set()) => {
  walkAst(n, { enter: (c) => { if ((c[0] === 'local.set' || c[0] === 'local.tee') && typeof c[1] === 'string') out.add(c[1]) } })
  return out
}

/** Whether a branch inside the block targets its label: a br, a br_table row, or a try_table catch clause. */
const CATCHES = new Set(['catch', 'catch_ref', 'catch_all', 'catch_all_ref'])
const targeted = (block) => {
  const label = typeof block[1] === 'string' && block[1].startsWith('$') ? block[1] : null
  if (!label) return false
  let hit = false
  walkAst(block, { enter: (c) => {
    if (hit) return false
    if ((c[0] === 'br' || c[0] === 'br_if') && c[1] === label) hit = true
    else if (c[0] === 'br_table' || CATCHES.has(c[0])) for (let i = 1; i < c.length && typeof c[i] === 'string'; i++) if (c[i] === label) hit = true
  } })
  return hit
}

/** The children of an `if`: its condition, its `then` and its `else` (null when absent). */
const ifParts = (n) => {
  let cond = null, then = null, els = null
  for (let i = 1; i < n.length; i++) {
    const c = n[i]
    if (!isArr(c) || c[0] === 'result') continue
    if (c[0] === 'then') then = c
    else if (c[0] === 'else') els = c
    else cond = i
  }
  return { cond, then, els }
}

/**
 * @param fn a `(func …)` IR node, rewritten in place
 * @param pureFns user functions proven to write nothing (optimize/pure-funcs.js):
 *   their calls are values too, under the state clock (they may read memory or globals)
 */
export function valueNumber(fn, pureFns = null) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const types = new Map()
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (isArr(c) && (c[0] === 'param' || c[0] === 'local') && typeof c[1] === 'string' && c[1].startsWith('$')) types.set(c[1], c[2])
  }

  // Region facts, computed once per node: the tree is fixed through the
  // analysis, and the rewrite adds holders only, which it tracks by name.
  const assignedMemo = new Map(), targetedMemo = new Map()
  const assignedOf = (n) => { let s = assignedMemo.get(n); if (!s) assignedMemo.set(n, s = assigned(n)); return s }
  const targetedOf = (n) => { let t = targetedMemo.get(n); if (t == null) targetedMemo.set(n, t = targeted(n)); return t }
  const armsAssigned = (then, els) => { const out = new Set(then ? assignedOf(then) : []); if (els) for (const x of assignedOf(els)) out.add(x); return out }

  // Analysis: a number per keyed node, a site count per number. Locals carry
  // the number of their last definition; a kill gives them a fresh one.
  const vnOf = new Map(), sites = new Map(), keys = new Map(), unstable = new Set()
  let next = 1, clock = 0
  const fresh = () => next++
  let locals = new Map()
  const readLocal = (name) => { let v = locals.get(name); if (v == null) locals.set(name, v = fresh()); return v }
  const kill = (names) => { for (const name of names) locals.set(name, fresh()) }
  const record = (n, v, site = n[0] !== 'local.get' && n[0] !== 'local.tee') => {
    if (unstable.has(n)) return v
    if (vnOf.has(n)) { if (vnOf.get(n) !== v) { vnOf.delete(n); unstable.add(n) } return v }
    vnOf.set(n, v)
    if (site) sites.set(v, (sites.get(v) || 0) + 1)
    return v
  }
  const analyzeChildren = (n, from = 1) => { for (let i = from; i < n.length; i++) analyze(n[i]) }
  /** Analyze a `local.set`: the local takes its value's number; returns that number (null when it has none). */
  const analyzeSet = (n) => { const v = analyze(n[2]); locals.set(n[1], v ?? fresh()); return v }
  /** Analyze a node in evaluation order; returns its value number, or null when it has none. */
  const analyze = (n) => {
    if (!isArr(n)) return null
    const op = n[0]
    if (op === 'local.get') return record(n, readLocal(n[1]))
    if (op === 'local.set') { analyzeSet(n); return null }
    if (op === 'local.tee') {
      const v = analyze(n[2])
      locals.set(n[1], v ?? fresh())
      return v != null ? record(n, v) : null
    }
    if (op === 'loop') { kill(assignedOf(n)); clock++; analyzeChildren(n); kill(assignedOf(n)); clock++; return null }
    if (op === 'if') {
      // A conditional whose condition and arms are single values is a value
      // itself (a select that evaluates one arm); any other arm is a region.
      const { cond, then, els } = ifParts(n)
      const vc = cond != null ? analyze(n[cond]) : null
      const before = new Map(locals), clockBefore = clock
      const arm = (a) => { if (a.length === 2 && isArr(a[1])) return analyze(a[1]); analyzeChildren(a); return null }
      const vt = then ? arm(then) : null
      locals = new Map(before); clock = clockBefore
      const ve = els ? arm(els) : null
      // Either arm's assignments (a tee inside a value) hold only on its own path.
      kill(armsAssigned(then, els))
      if (vc != null && vt != null && ve != null) return record(n, keyed(`if #${vc} #${vt} #${ve}`))
      clock++
      return null
    }
    if (op === 'block') {
      if (targetedOf(n)) { analyzeChildren(n); kill(assignedOf(n)); clock++; return null }
      // A block of pure `local.set`s ending in a value is that value: an
      // inlined body's temporaries and its result (`(block (local.set $t …) (select … $t …))`).
      let pure = n.some(c => isArr(c) && c[0] === 'result'), last = null
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c) || c[0] === 'result') continue
        const v = c[0] === 'local.set' ? analyzeSet(c) : analyze(c)
        const isLast = i === n.length - 1
        if (isLast) last = c[0] === 'local.set' ? null : v
        else if (c[0] !== 'local.set' || v == null) pure = false
      }
      return pure && last != null ? record(n, last, false) : null
    }
    if (CONTROL.has(op) || TRANSPARENT.has(op)) { analyzeChildren(n); return null }
    if (op === 'global.get') return null
    if (op === 'global.set') { analyzeChildren(n); clock++; return null }
    if (op === 'call') {
      const vs = []
      for (let i = 2; i < n.length; i++) vs.push(analyze(n[i]))
      const kernel = pureKernel(n[1]), user = !kernel && pureFns != null && pureFns.has(n[1])
      if (!kernel && !user) { clock++; return null }
      return vs.some(v => v == null) ? null : record(n, keyed(`call ${n[1]} ${vs.join(' ')}${user ? ` @${clock}` : ''}`))
    }
    if (typeof op === 'string' && writesMemory(op)) { analyzeChildren(n); clock++; return null }
    if (typeof op !== 'string' || !valueOp(op)) {
      // Unknown to this pass: its operands are code, its effect is any.
      analyzeChildren(n); kill(assignedOf(n)); clock++
      return null
    }
    // A stack-style operator (no folded operands) reads what an earlier instruction left.
    if (!op.endsWith('.const') && !n.some(isArr)) return null
    const parts = [op]
    let complete = true
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (!isArr(c)) { parts.push(Object.is(c, -0) ? '-0' : String(c)); continue }
      const v = analyze(c)
      if (v == null) complete = false
      parts.push(`#${v}`)
    }
    if (!complete) return null
    if (isLoad(op)) parts.push(`@${clock}`)
    return record(n, keyed(parts.join(' ')))
  }
  const keyed = (key) => { let v = keys.get(key); if (v == null) keys.set(key, v = fresh()); return v }
  for (let i = bodyStart; i < fn.length; i++) analyze(fn[i])

  // Rewrite: a computation whose number a local still holds becomes a read
  // of it; the first site of a number read again later becomes its holder.
  // A replaced node's own assignments vanish with it, so a local it assigns
  // may be read inside it only.
  const reads = new Map()
  walkAst(fn, { enter: (c) => { if (c[0] === 'local.get') reads.set(c[1], (reads.get(c[1]) || 0) + 1) } })
  const readOutside = (n) => {
    const names = assigned(n)
    if (!names.size) return false
    const inside = new Map()
    walkAst(n, { enter: (c) => { if (c[0] === 'local.get' && names.has(c[1])) inside.set(c[1], (inside.get(c[1]) || 0) + 1) } })
    for (const name of names) if ((reads.get(name) || 0) > (inside.get(name) || 0)) return true
    return false
  }
  const holders = new Map()
  let held = new Map(), minted = nextLocalId(fn, 'vn')
  const captures = new Map(), mintedNames = []
  /** Forget a region's assignments: the tree's own, and the holders minted inside it. */
  const forgetRegion = (names, mark) => { forget(names); for (let i = mark; i < mintedNames.length; i++) held.set(mintedNames[i], token()) }
  // The statement being rewritten: its sequence and position, the conditional
  // depth it starts at, and the holder statements to insert before it.
  let stmt = null, depth = 0
  const localReads = (n) => { const out = new Set(); walkAst(n, { enter: (c) => { if (c[0] === 'local.get') out.add(c[1]) } }); return out }
  const mayTrap = (n) => { let hit = false; walkAst(n, { enter: c => { if (hit) return false; if (mayTrapOp(c[0]) || (c[0] === 'call' && !pureKernel(c[1]))) hit = true } }); return hit }
  /** Whether `n` can precede its statement without conflicting local reads/writes or a trap.
   *  A branch condition keeps
   *  its computation in place (a tee): a statement before a loop's exit test is what stops the
   *  tape's loop rotation (optimize/rotate-loops.js), which hashjoin's probe loop lives on. */
  const hoistable = (n) => {
    if (!stmt || stmt.depth !== depth || stmt.seq[stmt.at][0] === 'br_if') return false
    if (mayTrap(n)) return false
    const own = assigned(n), outside = new Set(), outsideReads = new Set()
    walkAst(stmt.seq[stmt.at], { enter: (c) => {
      if (c === n) return false
      if ((c[0] === 'local.set' || c[0] === 'local.tee') && typeof c[1] === 'string') outside.add(c[1])
      else if (c[0] === 'local.get') outsideReads.add(c[1])
    } })
    for (const name of localReads(n)) if (outside.has(name)) return false
    for (const name of own) if (outside.has(name) || outsideReads.has(name)) return false
    return true
  }
  const rewriteSeq = (seq, from) => {
    const outer = stmt
    for (let i = from; i < seq.length; i++) {
      stmt = { seq, at: i, depth, hoisted: [] }
      rewrite(seq[i], seq, i)
      if (stmt.hoisted.length) { seq.splice(i, 0, ...stmt.hoisted); i += stmt.hoisted.length }
    }
    stmt = outer
  }
  const rewriteArm = (seq, from) => { depth++; rewriteSeq(seq, from); depth-- }
  const token = () => -(next++)
  const hold = (v, name) => { if (v == null) return; let list = holders.get(v); if (!list) holders.set(v, list = []); list.push(name); held.set(name, v) }
  const holderOf = (v) => { const list = holders.get(v); if (list) for (let i = list.length - 1; i >= 0; i--) if (held.get(list[i]) === v) return list[i]; return null }
  const forget = (names) => { for (const name of names) held.set(name, token()) }
  const rewriteChildren = (n, from = 1) => { for (let i = from; i < n.length; i++) rewrite(n[i], n, i) }
  const seqStart = (n) => { let i = 1; while (i < n.length && (typeof n[i] === 'string' || (isArr(n[i]) && n[i][0] === 'result'))) i++; return i }
  const rewrite = (n, parent, idx) => {
    if (!isArr(n)) return
    const op = n[0]
    if (op === 'local.set' || op === 'local.tee') {
      const v = vnOf.get(n[2]) ?? null
      rewrite(n[2], n, 2)
      held.set(n[1], v ?? token())
      hold(v, n[1])
      return
    }
    const v = op === 'local.get' ? null : vnOf.get(n)
    const shared = v != null && (sites.get(v) || 0) >= 2 && worth(n)
    if (shared) {
      const h = holderOf(v)
      if (h != null && !readOutside(n)) {
        const capture = captures.get(h)
        if (capture) capture.used = true
        parent[idx] = ['local.get', h]
        return
      }
    }
    const mark = mintedNames.length
    if (op === 'loop') { forget(assignedOf(n)); rewriteArm(n, seqStart(n)); forgetRegion(assignedOf(n), mark) }
    else if (op === 'if') {
      const { cond, then, els } = ifParts(n)
      if (cond != null) rewrite(n[cond], n, cond)
      const before = new Map(held)
      if (then) rewriteArm(then, 1)
      held = new Map(before)
      if (els) rewriteArm(els, 1)
      forgetRegion(armsAssigned(then, els), mark)
    }
    else if (op === 'block') { if (targetedOf(n)) { rewriteArm(n, seqStart(n)); forgetRegion(assignedOf(n), mark) } else rewriteSeq(n, seqStart(n)) }
    else if (op === 'local.get' || CONTROL.has(op) || TRANSPARENT.has(op) || (typeof op === 'string' && writesMemory(op))) rewriteChildren(n)
    else if (typeof op === 'string' && !valueOp(op) && op !== 'call') { rewriteChildren(n); forgetRegion(assignedOf(n), mark) }
    else rewriteChildren(n, op === 'call' ? 2 : 1)
    if (!shared || parent[0] === 'local.set' || parent[0] === 'local.tee') return
    // The first site of a value read again later holds it for the rest.
    const type = selfType(n, types) ?? consumerType(parent, idx, types)
    if (!type) return
    const name = `$__vn${minted++}`
    types.set(name, type); mintedNames.push(name)
    let set = null
    if (hoistable(n)) { set = ['local.set', name, n]; stmt.hoisted.push(set); parent[idx] = ['local.get', name] }
    else parent[idx] = ['local.tee', name, n]
    captures.set(name, { replacement: parent[idx], value: n, set, used: false })
    hold(v, name)
  }
  rewriteSeq(fn, bodyStart)
  // The census counts occurrences, not dominating reuse. Restore captures
  // whose later occurrences were behind a branch or invalidation boundary.
  const decls = []
  for (const [name, capture] of captures) {
    if (capture.used) { decls.push(['local', name, types.get(name)]); continue }
    // Keep the original node and its marks. The shared block cleanup removes
    // this wrapper; Object.assign does not copy array elements in the kernel.
    capture.replacement.splice(0, capture.replacement.length,
      'block', ['result', types.get(name)], capture.value)
    if (capture.set) capture.set.splice(0, capture.set.length, 'nop')
  }
  if (decls.length) fn.splice(bodyStart, 0, ...decls)
}
