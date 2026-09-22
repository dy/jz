/**
 * Statement scheduling for instruction-level parallelism.
 *
 * A straight-line run of statements keeps its data order and nothing else:
 * each statement goes as early as the longest chain of work still depending
 * on it warrants, so independent long computations (kernel calls,
 * divisions) start together and the processor overlaps them. colorpq's
 * three PQ channels each take an inner and an outer pow; written channel by
 * channel, each outer pow waits for its inner one while the next channel's
 * inner pow, independent of both, sits behind it in program order beyond
 * the processor's window. Scheduled, the three inner pows run first, then
 * the three outer ones.
 *
 * Dependencies: a local's write goes after its earlier reads and writes,
 * its reads after its write; a memory read after a write and a write after
 * a read or a write, globals likewise; statements with an effect (a store,
 * a call with effects, a global write, an operator that can trap) keep
 * their order among themselves. A control statement, or one that branches
 * out of itself or leaves a value, bounds a run. A run is rescheduled only
 * when it holds two computations worth overlapping.
 *
 * Runs after value numbering (optimize/value-number.js), whose holder
 * statements are the shared computations this moves.
 *
 * @module optimize/schedule
 */
import { findBodyStart } from '../ir.js'
import { walkAst } from '../ast.js'
import { mayTrapOp } from '../ir/classify.js'
import { isMemWrite as writesMemory } from 'watr/optimize'
import { pureKernel } from './pure-funcs.js'

const isArr = Array.isArray
const CONTROL = new Set(['block', 'loop', 'if', 'try_table', 'br', 'br_if', 'br_table', 'return', 'return_call', 'return_call_indirect', 'return_call_ref', 'unreachable', 'throw', 'throw_ref', 'rethrow'])
const BRANCH = new Set(['try_table', 'br', 'br_if', 'br_table', 'return', 'return_call', 'return_call_indirect', 'return_call_ref', 'unreachable', 'throw', 'throw_ref', 'rethrow'])
const VOID = new Set(['local.set', 'global.set', 'drop', 'nop', 'call'])
const HEAVY = /\.(div|div_s|div_u|sqrt)$/
const isLoad = (op) => op.includes('.load')
/** The first child of a loop or block past its label and result. */
const seqStart = (n) => { let i = 1; while (i < n.length && (typeof n[i] === 'string' || (isArr(n[i]) && n[i][0] === 'result'))) i++; return i }
const intersects = (a, b) => { for (const x of a) if (b.has(x)) return true; return false }

/** A statement that can move: void, and no branch inside it. */
const movable = (s) => {
  if (!isArr(s) || typeof s[0] !== 'string') return false
  if (CONTROL.has(s[0]) || !(VOID.has(s[0]) || writesMemory(s[0]))) return false
  let branch = false
  walkAst(s, { enter: (c) => { if (branch) return false; const op = c[0]; if (BRANCH.has(op) || (typeof op === 'string' && (op.startsWith('table.') || op.includes('atomic') || op === 'memory.size'))) branch = true } })
  return !branch
}

/** What a statement reads and writes, whether its order is fixed, and the work it holds. */
const facts = (s, pureFns) => {
  const defs = new Set(), uses = new Set()
  let memR = false, memW = false, globR = false, globW = false, ordered = false, lat = 0, heavy = 0
  walkAst(s, { enter: (c) => {
    const op = c[0]
    if (typeof op !== 'string') return
    if (op === 'local.get') uses.add(c[1])
    else if (op === 'local.set' || op === 'local.tee') defs.add(c[1])
    else if (op === 'global.get') globR = true
    else if (op === 'global.set') { globW = true; ordered = true }
    else if (op === 'call') {
      if (pureKernel(c[1])) { lat += 40; heavy++ }
      else if (pureFns != null && pureFns.has(c[1])) { lat += 40; heavy++; memR = true; globR = true; ordered = true }
      else { ordered = true; memR = memW = globR = globW = true; lat += 40 }
    }
    else if (op === 'call_indirect' || op === 'call_ref') { ordered = true; memR = memW = globR = globW = true; lat += 40 }
    else if (writesMemory(op)) { memW = true; ordered = true; lat += 1 }
    else if (isLoad(op)) { memR = true; ordered = true; lat += 4 }
    else if (mayTrapOp(op)) { ordered = true; lat += 12 }
    else if (HEAVY.test(op)) { lat += 12; heavy++ }
    else if (!op.endsWith('.const')) lat += 1
  } })
  return { defs, uses, memR, memW, globR, globW, ordered, lat, heavy }
}

/** Whether statement `j` must follow statement `i`. */
const after = (i, j) =>
  intersects(j.uses, i.defs) || intersects(j.defs, i.uses) || intersects(j.defs, i.defs) ||
  (i.memW && (j.memR || j.memW)) || (i.memR && j.memW) ||
  (i.globW && (j.globR || j.globW)) || (i.globR && j.globW) ||
  (i.ordered && j.ordered)

/** Reorder the run seq[start..end) by height; returns whether it changed. */
const scheduleRun = (seq, start, end, pureFns) => {
  const n = end - start
  if (n < 2) return false
  const f = []
  for (let i = start; i < end; i++) f.push(facts(seq[i], pureFns))
  let heavy = 0
  for (const x of f) if (x.heavy) heavy++
  if (heavy < 2) return false
  const preds = f.map(() => []), succs = f.map(() => [])
  for (let j = 1; j < n; j++) for (let i = 0; i < j; i++) if (after(f[i], f[j])) { preds[j].push(i); succs[i].push(j) }
  const height = new Array(n)
  for (let i = n - 1; i >= 0; i--) { let h = 0; for (const j of succs[i]) if (height[j] > h) h = height[j]; height[i] = f[i].lat + h }
  const left = preds.map(p => p.length), order = []
  for (let k = 0; k < n; k++) {
    let pick = -1
    for (let i = 0; i < n; i++) if (left[i] === 0 && (pick < 0 || height[i] > height[pick])) pick = i
    order.push(pick); left[pick] = -1
    for (const j of succs[pick]) left[j]--
  }
  if (order.every((i, k) => i === k)) return false
  const items = order.map(i => seq[start + i])
  for (let k = 0; k < n; k++) seq[start + k] = items[k]
  return true
}

/** Schedule every run of movable statements in the sequence seq[from..]. */
const scheduleSeq = (seq, from, pureFns) => {
  let start = from
  for (let i = from; i <= seq.length; i++) {
    if (i < seq.length && movable(seq[i])) continue
    scheduleRun(seq, start, i, pureFns)
    start = i + 1
  }
}

/**
 * @param fn a `(func …)` IR node, rewritten in place
 * @param pureFns user functions proven to write nothing (optimize/pure-funcs.js)
 */
export function scheduleStatements(fn, pureFns = null) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  scheduleSeq(fn, bodyStart, pureFns)
  walkAst(fn, { enter: (c) => {
    if (c[0] === 'loop' || c[0] === 'block') scheduleSeq(c, seqStart(c), pureFns)
    else if (c[0] === 'then' || c[0] === 'else') scheduleSeq(c, 1, pureFns)
  } })
}
