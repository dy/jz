/**
 * Scan-loop range splitting: a counted loop whose bound may pass the end of
 * what it scans runs the steps inside it first, where every read is in
 * bounds, and the steps past it after, as written: a string's char codes
 * (`splitCharScanLoops`) and an array's elements (`splitArrayScanLoops`).
 *
 * @module compile/plan/loops
 */

import { ctx } from '../../ctx.js'
import { T, some, isReassigned, walkAst } from '../../ast.js'
import { freshId } from '../../ir.js'
import { constIntExpr } from '../../static.js'
import { containsDeclOf, cloneWithSubst, isUnitIncrement } from '../../type.js'
import { includeModule } from '../../autoload.js'
import { clonePlain, collectBindings, nodeSize, optimizing } from './common.js'
import { SOURCE_FULL } from '../../growth.js'
import { K, NULL_BITS, core, tagOf } from '../../summary/kind.js'
import { lengthRecvs, preservesLoopBounds } from '../../type/canonical-bounds.js'

// === Char-scan range splitting ===
//
// `for (let i = 0; i < N; i++) { … s.charCodeAt(i) … }` with an arbitrary
// bound N pays the OOB arm on EVERY char: charCodeAt's `i ≥ s.length` case
// yields NaN, which forces the char local to f64 and every classifier compare
// to f64 ops (the tokenizer/watr substrate cost). Split the iteration space:
//
//   let __cce = 0
//   for (let __ccm = (__cce = Math.min(N, s.length)), i = 0; i < __ccm; i++) BODY
//   for (let i2 = Math.ceil(__cce); i2 < N; i2++) BODY′
//
// The main loop's bound proof (scanBoundedLoops, via the min-aware lengthRecv)
// makes charCodeAt emit the raw i32 fast path — the char carrier narrows to
// i32 and the classifier chain follows. The tail keeps the original NaN
// semantics and only runs past the string's end (cold). `Math.ceil(__cce)` is
// exactly the main loop's exit value (unit increments from 0): integral min →
// min itself, fractional → first integer above, NaN → NaN (zero-trip tail,
// matching the original's zero trips). BODY′ renames the body's decls and the
// induction var so the main loop's narrowed i32 locals aren't widened by the
// tail's NaN arm (locals are per-name function-wide).
//
// Gates: unit-increment counter from literal 0, name bound, no break/label
// (a main-loop break must not fall into the tail), no closures (cloning would
// duplicate them), receiver/bound/counter unwritten in body, body ≤ 400 nodes
// (the clone doubles it — `splitCharScan: false` under optimize:'size').
//
// A tail step past a String's end reads no character: `i2` starts at the
// string's length (or the tail runs no step at all), so its
// `recv.charCodeAt(i2)` is NaN, and BODY′ takes the literal. Its classifier
// tests fold away and the tail is the few statements the past-the-end steps
// run, not a second copy of the scan: V8 allocates registers over the whole
// function, and a tail as large as the main loop spilled the main loop's
// carried values (the tokenizer's hash took a stack slot each character).
const hasOp = (node, ops) => some(node, n => ops.has(n[0]))
const SPLIT_BLOCKERS = new Set(['break', 'label', '=>'])
const NAN_LIT = [null, NaN]
const isNaNLit = n => Array.isArray(n) && n[0] == null && typeof n[1] === 'number' && Number.isNaN(n[1])
const charCodeAtNaN = (node, recv, i2) => {
  if (!Array.isArray(node)) return node
  if (node[0] === '()' && node[2] === i2 && Array.isArray(node[1]) && node[1][0] === '.' && node[1][1] === recv && node[1][2] === 'charCodeAt')
    return NAN_LIT.slice()
  for (let k = 1; k < node.length; k++) node[k] = charCodeAtNaN(node[k], recv, i2)
  return node
}
// `const c = NaN` (the character the tail read): its later statements read the
// literal, which the classifier tests fold. A statement that declares the name
// again, or catches into it, is left as written.
const readsAsNaN = (node, name) => {
  if (node === name) return NAN_LIT.slice()
  if (!Array.isArray(node) || node[0] == null) return node
  const from = node[0] === '.' || node[0] === '?.' ? 2 : node.length   // a property name is no read
  for (let k = 1; k < from; k++) node[k] = readsAsNaN(node[k], name)
  return node
}
const propagateNaNConsts = (node) => {
  if (!Array.isArray(node) || node[0] == null) return node
  if (node[0] === ';') {
    const names = []
    for (let k = 1; k < node.length; k++) {
      for (const name of names)
        if (!containsDeclOf(node[k], name) && !hasOp(node[k], CATCHES)) node[k] = readsAsNaN(node[k], name)
      const s = node[k]
      if (Array.isArray(s) && s[0] === 'const' && s.length === 2 && Array.isArray(s[1]) && s[1][0] === '=' && typeof s[1][1] === 'string' && isNaNLit(s[1][2]))
        names.push(s[1][1])
      else propagateNaNConsts(s)
    }
    return node
  }
  for (let k = 1; k < node.length; k++) propagateNaNConsts(node[k])
  return node
}
const CATCHES = new Set(['catch'])

const trySplitFor = (node, parent, idx, view) => {
  const [, init, cond, step, body] = node
  if (!Array.isArray(cond) || cond[0] !== '<' || typeof cond[1] !== 'string' || typeof cond[2] !== 'string') return false
  const i = cond[1], B = cond[2]
  if (B === i) return false
  // init: single decl `let i = 0`
  if (!Array.isArray(init) || (init[0] !== 'let' && init[0] !== 'const') || init.length !== 2) return false
  const iDecl = init[1]
  if (!Array.isArray(iDecl) || iDecl[0] !== '=' || iDecl[1] !== i || constIntExpr(iDecl[2]) !== 0) return false
  if (!isUnitIncrement(step, i)) return false
  if (hasOp(body, SPLIT_BLOCKERS)) return false
  if (nodeSize(body) > 250) return false
  if (isReassigned(body, i) || isReassigned(body, B) || containsDeclOf(body, i)) return false
  // at least one `recv.charCodeAt(i)` with a stable name receiver
  let recv = null
  some(body, n => {
    if (n[0] === '()' && Array.isArray(n[1]) && n[1][0] === '.' && n[1][2] === 'charCodeAt'
        && typeof n[1][1] === 'string' && n[2] === i) { recv = n[1][1]; return true }
    return false
  })
  if (!recv || recv === i || recv === B || isReassigned(body, recv)) return false

  // tail clone: fresh induction var + fresh names for every body decl
  const declNames = new Set()
  collectBindings(body, declNames)
  const rename = new Map()
  for (const d of declNames) rename.set(d, `${T}rs${freshId(ctx)}_${d}`)
  const i2 = `${T}rsi${freshId(ctx)}`
  const subst = new Map([[i, i2]])
  let tailBody = cloneWithSubst(body, subst, rename)
  const tailStep = cloneWithSubst(step, subst, new Map())
  if (view && tagOf(core(view.kindOfExpr(recv))) === K.STRING) tailBody = propagateNaNConsts(charCodeAtNaN(tailBody, recv, i2))

  includeModule('math')  // plan-time injection of math.min/math.ceil — prepare's auto-import has already run
  // The tail reads the bound through `E`, declared before both loops: a copy a
  // later pass makes of the main loop (unswitch-loops.js, integral-loops.js)
  // renames what the loop declares, `M`, and still assigns `E` as it enters.
  const M = `${T}ccm${freshId(ctx)}`, E = `${T}cce${freshId(ctx)}`
  node[1] = ['let', ['=', M, ['=', E, ['()', 'math.min', [',', B, ['.', recv, 'length']]]]], iDecl]
  node[2] = ['<', i, M]
  const tailFor = ['for', ['let', ['=', i2, ['()', 'math.ceil', E]]], ['<', i2, B], tailStep, tailBody]
  parent[idx] = [';', ['let', ['=', E, [null, 0]]], node, tailFor]
  return true
}

export const splitCharScanLoops = () => {
  if (!optimizing() || ctx.transform.optimize?.splitCharScan === false) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    // (a split loop runs a copy of its body past the string: none past the function's growth budget, src/growth.js)
    if (nodeSize(func.body) > SOURCE_FULL) continue
    let view
    walkAst(func.body, { enter: (node, parent, idx) => {
      if (node[0] === '=>') return false
      if (node[0] === 'for' && node.length === 5 && parent &&
          trySplitFor(node, parent, idx, view ??= ctx.summary?.at(func.sig) ?? null)) { changed = true; return false }
    } })
    // body root itself can't be a bare `for` without a parent slot — wrap-walk
    // handles every nested position; a top-level-for body is `{}`-wrapped.
  }
  return changed
}

// === Array-scan range splitting ===
//
// A counted loop indexing an array by its counter under another bound, a
// constant, a count or another array's length, may run past the array's end:
// there a read is undefined and a store grows the array. So every `a[i]` keeps
// its bounds test, every store its growth call, and the receiver is read anew
// after each store, which may have moved it. The same split as the char scan:
//
//   const __asm = Math.min(B, a.length, b.length)
//   for (let i = C; i < __asm; i++) BODY
//   for (let i2 = Math.max(C, Math.ceil(__asm)) & 0x7fffffff; i2 < B; i2++) BODY′
//
// The main loop's counter stays below each array's length at entry, and the
// body shrinks no array (canonical-bounds.js preservesLoopBounds, the proof's
// own condition), so every `a[i]` in it is in bounds (scanBoundedArrIdx, a
// bound a constant declared before the loop holds below the lengths): a read
// loads, a store stores in place, nothing moves. The
// tail is the loop as written for the steps past the shortest end, its
// counter starting where the main loop's stopped (or at C, where the main
// loop ran none). A NaN bound runs neither, as the loop as written runs none.
//
// The bound is evaluated once for the main loop and again at each step of
// the tail, so it must not change in the main loop: a constant, a local Number
// no closure names and the loop never writes, or the length of such an array,
// which the main loop may grow but never shrinks (the tail reads it live). The
// receivers are arrays of the same standing, never nullish, so reading their
// lengths ahead of the loop throws nothing. Gates as the char scan's: a unit
// counter from a constant at or above zero, no break or label (a main-loop
// break must not fall into the tail), no closure (the clone would duplicate
// it), at most 250 body nodes; `splitArrayScan: false` under optimize:'size'.
const isArrayKind = (k) => k != null && tagOf(k) === K.ARRAY && (k & NULL_BITS) === 0
const isNumberKind = (k) => k != null && tagOf(k) === K.NUMBER && (k & NULL_BITS) === 0
const trySplitArrayFor = (node, parent, idx, view, stable, consts) => {
  const [, init, cond, step, body] = node
  if (!Array.isArray(cond) || cond[0] !== '<' || typeof cond[1] !== 'string') return false
  const i = cond[1], B = cond[2]
  if (!Array.isArray(init) || init[0] !== 'let' || init.length !== 2) return false
  const iDecl = init[1]
  if (!Array.isArray(iDecl) || iDecl[0] !== '=' || iDecl[1] !== i) return false
  // (a -0 start the tail could not hand back where the main loop ran no step)
  const C = constIntExpr(iDecl[2])
  if (C == null || C < 0 || Object.is(C, -0) || !isUnitIncrement(step, i)) return false
  if (hasOp(body, SPLIT_BLOCKERS) || nodeSize(body) > 250) return false
  if (isReassigned(body, i) || containsDeclOf(body, i)) return false
  const loop = [';', body, step]
  const steady = (name) => typeof name === 'string' && name !== i && stable(name) && !isReassigned(loop, name)
  // the bound: a constant, a steady Number, or a steady array's length (a
  // constant holding one, `const n = a.length`, is that length)
  const intBound = constIntExpr(B) != null
  const boundRecvs = intBound ? [] : lengthRecvs(typeof B === 'string' ? consts.get(B) : B)
  if (!intBound && !(typeof B === 'string' && steady(B) && isNumberKind(view.kindOfExpr(B))) &&
      !(boundRecvs.length === 1 && steady(boundRecvs[0]) && isArrayKind(view.kindOfExpr(boundRecvs[0])))) return false
  // the arrays the counter indexes, those the bound does not already hold it
  // below, nor a length the program fixes (a literal never resized) at or past it
  const recvs = [], fixedPast = (r) => intBound && (view.fixedLenOfExpr?.(r) ?? -1) >= constIntExpr(B)
  // (an array index the counter is not leaves its test in the loop: two copies of a body, entered
  // as often as the loop is, for a test of the many it runs)
  let tested = false
  walkAst(body, { enter: n => {
    if (n[0] === '=>') return false
    if (n[0] !== '[]' || n.length !== 3) return
    if (n[2] !== i) tested ||= !(Array.isArray(n[2]) && n[2][0] == null) && isArrayKind(view.kindOfExpr(n[1]))
    else if (typeof n[1] === 'string' && !recvs.includes(n[1]) && !boundRecvs.includes(n[1]) &&
        n[1] !== B && steady(n[1]) && isArrayKind(view.kindOfExpr(n[1])) && !fixedPast(n[1])) recvs.push(n[1])
  } })
  if (tested || !recvs.length || !preservesLoopBounds(body, view, [...recvs, ...boundRecvs, i])) return false

  const declNames = new Set()
  collectBindings(body, declNames)
  const rename = new Map()
  for (const d of declNames) rename.set(d, `${T}as${freshId(ctx)}_${d}`)
  // (`ast`: the array store's own temporaries are `asi`/`asj`/`asv`, emit-assign.js, from a count of their own)
  const i2 = `${T}ast${freshId(ctx)}`
  const subst = new Map([[i, i2]])
  const tailBody = cloneWithSubst(body, subst, rename)
  const tailStep = cloneWithSubst(step, subst, new Map())

  includeModule('math')  // plan-time injection of math.min/max/ceil — prepare's auto-import has already run
  // The bound, a constant both loops see (a copy a later pass makes of the
  // main loop renames what the loop declares, never what it reads), with the
  // summary's hull of it (summary/index.js noteHull): the counted loop's span.
  // (a min of int32s, a constant's or a length's, is one: in a word, so no later
  // pass versions the main loop on its integrality)
  const M = `${T}asm${freshId(ctx)}`, min = ['()', 'math.min', [',', clonePlain(B), ...recvs.map(r => ['.', r, 'length'])]]
  const bound = ['=', M, intBound || boundRecvs.length ? ['|', min, [null, 0]] : min]
  const top = 0x1fffffff   // an array holds fewer than 2^29 elements
  const lo = intBound ? Math.min(constIntExpr(B), 0) : boundRecvs.length ? 0 : null
  if (lo != null) { bound.lo = lo; bound.hi = intBound ? Math.max(Math.min(constIntExpr(B), top), lo) : top }
  node[2] = ['<', i, M]
  // The main loop's exit value: an integral min itself, a fraction the first
  // integer above it, C where it ran no step; masked to a word, so the tail
  // indexes the arrays as the loop as written does. It is below 2^29 there,
  // and NaN, which the mask makes 0, only for a NaN bound, past which the
  // tail runs no step.
  const end = intBound ? M : ['()', 'math.ceil', M]
  const start = ['&', ['()', 'math.max', [',', [null, C], end]], [null, 0x7fffffff]]
  const tailInit = ['let', ['=', i2, start]]
  parent[idx] = [';', ['const', bound], node, ['for', tailInit, ['<', i2, clonePlain(B)], tailStep, tailBody]]
  return true
}

export const splitArrayScanLoops = () => {
  if (!optimizing() || ctx.transform.optimize?.splitArrayScan === false) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    // (a split loop runs a copy of its body past the array: none past the function's growth budget, src/growth.js)
    if (nodeSize(func.body) > SOURCE_FULL) continue
    const view = ctx.summary?.at(func.sig) ?? null
    if (!view) continue
    // a local no closure names: only the function's own statements write it
    const captured = new Set()
    walkAst(func.body, { enter: (n) => {
      if (n[0] !== '=>') return
      walkAst(n, { enter: (m) => { for (let k = 1; k < m.length; k++) if (typeof m[k] === 'string') captured.add(m[k]) } })
      return false
    } })
    const locals = new Set((func.sig?.params ?? []).map(p => p.name))
    collectBindings(func.body, locals)
    const stable = (name) => locals.has(name) && !captured.has(name)
    // what each constant holds (prepared names are the function's own, one each)
    const consts = new Map()
    walkAst(func.body, { enter: (n) => {
      if (n[0] === '=>') return false
      if (n[0] === 'const') for (let k = 1; k < n.length; k++) if (Array.isArray(n[k]) && n[k][0] === '=' && typeof n[k][1] === 'string') consts.set(n[k][1], n[k][2])
    } })
    walkAst(func.body, { enter: (node, parent, idx) => {
      if (node[0] === '=>') return false
      if (node[0] === 'for' && node.length === 5 && parent &&
          trySplitArrayFor(node, parent, idx, view, stable, consts)) { changed = true; return false }
    } })
  }
  return changed
}
