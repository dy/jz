/**
 * Local def/use simplification family: forward-substitute single-def/single-use
 * temps (propagateSingleUse) and sink single-def RHS into a first-use tee
 * (foldSetToTee) — the watr "propagate"/"simplify-locals" folds jz's own
 * optimizer applies before watr ever runs. Both share `localRefTallies`, a
 * whole-body def/use count.
 *
 * @module optimize/locals
 */
import { findBodyStart } from '../ir.js'
import { walkAst } from '../ast.js'
import { containsV128 } from './ir-scan.js'

const localRefTallies = (fn, bodyStart) => {
  const setN = new Map(), getN = new Map(), teed = new Set()
  const recordRef = n => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === 'local.set' && typeof n[1] === 'string') setN.set(n[1], (setN.get(n[1]) || 0) + 1)
    else if (op === 'local.tee' && typeof n[1] === 'string') teed.add(n[1])
    else if (op === 'local.get' && typeof n[1] === 'string') getN.set(n[1], (getN.get(n[1]) || 0) + 1)
  }
  for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: recordRef })
  return { setN, getN, teed }
}

/**
 * Forward-substitute a single-def / single-use local into its sole use, eliminating the local,
 * its `local.set` and its `local.get`. This is watr's "propagate": jz emits short-lived address/
 * index temps (`set $t (i32.add …); … (load $t) …`) that the WAT optimizer folds away — the
 * dominant slice of the watr-optimizer-OFF size gap (a matmul carries ~14 such temps, ≈ the whole
 * delta). Closing it lets jz lean on its own optimizer instead of watr's.
 *
 * SOUND only when moving the def's RHS `E` to the use can't change order or value:
 *   - `E` is PURE — reads only locals (no load/store/call/global/memory): its value is a function
 *     of its read-locals alone, and it has no side effects to reorder past intervening statements.
 *   - the use is at the SAME loop nesting — never under a deeper `loop` than the def (which would
 *     re-evaluate `E` per iteration and could read a clobbered input).
 *   - no read-local of `E` is written between the def and the use (incl. the use statement itself).
 * Anything it can't prove safe is left untouched.
 */
export function propagateSingleUse(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Leave a vectorized function alone: it carries v128 lane sequences that are already register-tight,
  // and forward-substituting into them only adds pressure (mirrors hoistInvariantLoop's hasV128 gate).
  if (containsV128(fn)) return

  // def/use tally over the whole body. A `local.tee` is both a read and a write — exclude any
  // tee'd local from candidacy rather than reason about it.
  const { setN, getN, teed } = localRefTallies(fn, bodyStart)

  const cand = new Set()
  for (const [name, c] of setN) if (c === 1 && getN.get(name) === 1 && !teed.has(name)) cand.add(name)
  if (!cand.size) return

  const movablePure = (n) => {
    let pure = true
    walkAst(n, { enter: x => {
      if (!pure) return false
      const op = x[0]
      if (op === 'local.get') return false
      if (op === 'local.set' || op === 'local.tee' || op === 'call' || op === 'call_indirect' || op === 'call_ref'
        || op === 'global.get' || op === 'global.set' || op === 'memory.size' || op === 'memory.grow'
        || op === 'memory.copy' || op === 'memory.fill') { pure = false; return false }
      if (typeof op === 'string' && (op.includes('.load') || op.includes('.store') || op.includes('.atomic'))) { pure = false; return false }
    } })
    return pure
  }
  const readsOf = (n, out) => { walkAst(n, { enter: x => { if (x[0] === 'local.get' && typeof x[1] === 'string') out.add(x[1]) } }) }
  const writesAny = (n, R) => {
    let found = false
    walkAst(n, { enter: x => {
      if (found) return false
      if ((x[0] === 'local.set' || x[0] === 'local.tee') && R.has(x[1])) { found = true; return false }
    } })
    return found
  }
  // Locate the (local.get $t) within `root`'s subtree (not root itself); flag if it sits under a
  // `loop` relative to root (→ would re-evaluate the moved RHS each iteration).
  const locateUse = (root, t) => {
    let found = null
    const rec = (node, underLoop) => {
      if (found || !Array.isArray(node)) return
      for (let i = 1; i < node.length; i++) {
        if (found) return
        const c = node[i]
        if (Array.isArray(c) && c[0] === 'local.get' && c[1] === t) { found = { parent: node, idx: i, underLoop }; return }
        rec(c, underLoop || node[0] === 'loop')
      }
    }
    rec(root, false)
    return found
  }

  const removed = new Set()
  const optimizeList = (list, start) => {
    for (let i = start; i < list.length; i++) {
      const s = list[i]
      if (!Array.isArray(s)) continue
      // s.length === 3: an explicit-RHS `(local.set $t E)`. A bare `(local.set $t)` (length 2)
      // binds a value already on the stack — e.g. the try_table catch payload — and has no RHS to
      // move; treating its undefined RHS as movable would substitute `undefined` into the use.
      if (s[0] === 'local.set' && s.length === 3 && typeof s[1] === 'string' && cand.has(s[1]) && movablePure(s[2])) {
        const t = s[1], E = s[2], R = new Set(); readsOf(E, R)
        for (let j = i + 1; j < list.length; j++) {
          const sj = list[j]
          const u = Array.isArray(sj) ? locateUse(sj, t) : null
          if (u) {                                       // found the sole use's statement
            if (!u.underLoop && !writesAny(sj, R)) {     // same nesting + read-locals intact
              u.parent[u.idx] = E
              list.splice(i, 1)
              cand.delete(t); removed.add(t)
              i--                                        // re-process from the freed slot (forward chains)
            }
            break                                        // use located — stop scanning this candidate
          }
          if (writesAny(sj, R)) break                    // a read-local clobbered before the use → can't move
        }
        if (removed.has(s[1])) continue
      }
      // recurse into nested statement lists
      if (s[0] === 'block' || s[0] === 'loop') {
        let k = 1; while (k < s.length && Array.isArray(s[k]) && s[k][0] === 'result') k++
        optimizeList(s, k)
      } else if (s[0] === 'if') {
        for (let k = 1; k < s.length; k++) { const c = s[k]; if (Array.isArray(c) && (c[0] === 'then' || c[0] === 'else')) optimizeList(c, 1) }
      }
    }
  }
  optimizeList(fn, bodyStart)

  // drop the now-orphaned decls (deferred so the body walk above sees stable indices)
  if (removed.size) for (let i = fn.length - 1; i >= 2; i--) { const c = fn[i]; if (Array.isArray(c) && c[0] === 'local' && removed.has(c[1])) fn.splice(i, 1) }
}

/**
 * Sink a single-def local's RHS to its FIRST use as a `local.tee` (the simplify-locals
 * transform watr's use-count propagate doesn't do, confirmed by diffing jz+watr vs Binaryen):
 *
 *   (local.set $t (call $f ...))           ⇒   (i64.store a (local.tee $t (call $f ...)))
 *   (i64.store a (local.get $t))                ... later (local.get $t) ...
 *   ... later (local.get $t) ...
 *
 * — removes the standalone `set` statement + the first `local.get` (~2–4 B/site). For a
 * SINGLE-use local the RHS is forwarded outright (no tee, decl dropped) — this also catches
 * effectful single-use temps (`call`/`load` RHS) that `propagateSingleUse` skips. Runs after
 * `propagateSingleUse`, so it sees only the cases that one leaves: multi-use, and effectful.
 *
 * Correctness rests on `scanUse`, an eval-order walk that flags a conflict BEFORE the use:
 *   - a write to any local the RHS reads (R),
 *   - a control-flow transfer (br/return/throw/…) that could skip the use while a later use lives,
 *   - for a memory-reading RHS, an intervening memory/global WRITE,
 *   - for a memory-writing RHS (incl. any call), ANY intervening memory/global access.
 * Plus: a multi-use fold (and an effectful single-use forward) requires the use to be
 * UNCONDITIONALLY reached (not under if/loop/block) so the tee always runs before later reads;
 * never sink under a `loop` (would re-evaluate / re-effect the RHS per iteration).
 */
export function foldSetToTee(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // v128 lane sequences are already register-tight — folding only adds pressure (mirrors propagateSingleUse).
  if (containsV128(fn)) return

  const { setN, getN, teed } = localRefTallies(fn, bodyStart)

  const cand = new Set()
  for (const [name, c] of setN) if (c === 1 && (getN.get(name) || 0) >= 1 && !teed.has(name)) cand.add(name)
  if (!cand.size) return

  const readsOf = (n, out) => { walkAst(n, { enter: x => { if (x[0] === 'local.get' && typeof x[1] === 'string') out.add(x[1]) } }) }
  const noLocalWrite = (n) => {
    let clean = true
    walkAst(n, { enter: x => {
      if (!clean) return false
      if (x[0] === 'local.set' || x[0] === 'local.tee') { clean = false; return false }
    } })
    return clean
  }
  const isWriteOp = (op) => op === 'call' || op === 'call_indirect' || op === 'call_ref' || op === 'return_call'
    || op === 'return_call_indirect' || op === 'global.set' || op === 'memory.grow' || op === 'memory.copy'
    || op === 'memory.fill' || (typeof op === 'string' && (op.includes('.store') || op.includes('.atomic')))
  const isReadOp = (op) => op === 'global.get' || op === 'memory.size' || (typeof op === 'string' && op.includes('.load'))
  const isCF = (op) => op === 'if' || op === 'loop' || op === 'block' || op === 'try' || op === 'try_table'
  const isTransfer = (op) => op === 'br' || op === 'br_if' || op === 'br_table' || op === 'return'
    || op === 'return_call' || op === 'return_call_indirect' || op === 'unreachable' || op === 'throw' || op === 'rethrow'
  const rhsKind = (n) => {                              // 'writes' | 'reads' | 'pure'
    let w = false, r = false
    walkAst(n, { enter: x => { if (isWriteOp(x[0])) w = true; else if (isReadOp(x[0])) r = true } })
    return w ? 'writes' : r ? 'reads' : 'pure'
  }
  // Walk `root` in eval order for the first `(local.get t)`; return {use, conflict}.
  // `conflict` reflects only what is evaluated strictly BEFORE the use (or the whole node if no use).
  const scanUse = (root, t, mode, R) => {
    let use = null, conflict = false
    const rec = (node, underLoop, underCond) => {
      if (use || conflict || !Array.isArray(node)) return
      const op = node[0]
      for (let i = 1; i < node.length; i++) {
        if (use || conflict) return
        const c = node[i]
        if (Array.isArray(c) && c[0] === 'local.get' && c[1] === t) { use = { parent: node, idx: i, underLoop, underCond }; return }
        // an `if`'s CONDITION (child 1) and all `select` operands evaluate UNCONDITIONALLY when
        // the construct is reached — only then/else bodies are conditional. Treating the condition
        // as conditional would wrongly refuse the common `if ((local.tee $t E) …)` fold.
        const childCond = (op === 'if' && i === 1) || op === 'select' ? underCond : underCond || isCF(op)
        rec(c, underLoop || op === 'loop', childCond)
      }
      if (use || conflict) return
      // post-order: this node's own effect, relative to the RHS we want to move past it
      if ((op === 'local.set' || op === 'local.tee') && R.has(node[1])) conflict = true
      else if (isTransfer(op)) conflict = true
      else if (mode === 'writes' && (isWriteOp(op) || isReadOp(op))) conflict = true
      else if (mode === 'reads' && isWriteOp(op)) conflict = true
    }
    rec(root, false, false)
    return { use, conflict }
  }

  const removed = new Set()
  const optimizeList = (list, start) => {
    for (let i = start; i < list.length; i++) {
      const s = list[i]
      if (!Array.isArray(s)) continue
      let folded = false
      if (s[0] === 'local.set' && s.length === 3 && typeof s[1] === 'string' && cand.has(s[1]) && noLocalWrite(s[2])) {
        const t = s[1], E = s[2], R = new Set(); readsOf(E, R)
        if (!R.has(t)) {                                  // self-ref RHS reads the very local — leave it
          const single = (getN.get(t) || 0) === 1
          const mode = rhsKind(E)
          for (let j = i + 1; j < list.length; j++) {
            const sj = list[j]
            if (!Array.isArray(sj)) continue
            const { use, conflict } = scanUse(sj, t, mode, R)
            if (conflict) break                           // unsafe to move RHS this far
            if (use) {
              // effectful single-use, or any multi-use, must reach the use unconditionally;
              // never sink under a loop (re-eval / re-effect).
              const okCond = (single && mode !== 'writes') ? true : !use.underCond
              if (!use.underLoop && okCond) {
                use.parent[use.idx] = single ? E : ['local.tee', t, E]
                list.splice(i, 1); cand.delete(t); if (single) removed.add(t); i--; folded = true
              }
              break
            }
          }
        }
      }
      if (folded) continue                                // re-process from the freed slot
      // recurse into nested statement lists
      if (s[0] === 'block' || s[0] === 'loop') {
        let k = 1; while (k < s.length && Array.isArray(s[k]) && s[k][0] === 'result') k++
        optimizeList(s, k)
      } else if (s[0] === 'if') {
        for (let k = 1; k < s.length; k++) { const c = s[k]; if (Array.isArray(c) && (c[0] === 'then' || c[0] === 'else')) optimizeList(c, 1) }
      }
    }
  }
  optimizeList(fn, bodyStart)

  if (removed.size) for (let i = fn.length - 1; i >= 2; i--) { const c = fn[i]; if (Array.isArray(c) && c[0] === 'local' && removed.has(c[1])) fn.splice(i, 1) }
}
