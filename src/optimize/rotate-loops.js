/**
 * Loop rotation (loop inversion), on the tape. jz's top-test loop idiom
 *   (block $brk (loop $loop (br_if $brk ¬C) BODY… (br $loop)))
 * becomes a guarded bottom-test loop with a FUSED conditional back-edge:
 *   (block $brk (br_if $brk ¬C) (loop $loop BODY… (br_if $loop C)))
 *
 * V8 lowers the fused `br_if $loop C` to one hardware loop branch, the
 * shape LLVM gives rust and zig, and the reason their hot scalar loops (lz's
 * greedy match scan, qoi's run-length scan) beat the top-test form, which
 * compiles to a forward exit branch plus a separate back jump: 1.35x on the
 * lz inner loop. watr's `loopify` collapses to `loop { if C { …; br } }`,
 * whose back jump stays unfused.
 *
 * C is evaluated as often as before: the guard once, then once per back
 * edge, as the top test was, so the rotation holds even when C has effects
 * (a `local.tee` recurrence, a call). The condition is duplicated in the
 * text alone (guard and back edge), a small size-for-speed trade: speed tier.
 *
 * Skipped: a loop with a v128 instruction (register-tight already), and a
 * body that branches to $loop (a `continue` without a step lands on the
 * loop label, which after rotation sits before the back-edge test).
 *
 * @module optimize/rotate-loops
 */
import { T, NONE, OP_STR, node, sym, push, clone, replace, intern } from '../ir/tape.js'
import { ops, bodyOf, hasV128 } from './fn.js'

// i32 comparison negations: a break condition flipped into the loop-continue
// condition. f64 compares are absent: ¬(a<b) ≠ (a≥b) across NaN, so those
// take the `i32.eqz` wrap.
const ROT_NEG = {
  'i32.eq': 'i32.ne', 'i32.ne': 'i32.eq',
  'i32.lt_s': 'i32.ge_s', 'i32.ge_s': 'i32.lt_s', 'i32.gt_s': 'i32.le_s', 'i32.le_s': 'i32.gt_s',
  'i32.lt_u': 'i32.ge_u', 'i32.ge_u': 'i32.lt_u', 'i32.gt_u': 'i32.le_u', 'i32.le_u': 'i32.gt_u',
}

export function rotateLoops(f) {
  const O = ops(), body = bodyOf(f)
  if (body === NONE) return
  const TYPE = O.TYPE, PARAM = O.PARAM, RESULT = O.RESULT
  const isLabel = (c) => c !== NONE && T.op[c] === OP_STR && T.syms[T.sym[c]][0] === '$'
  const only = (n) => T.a[n] !== NONE && T.next[T.a[n]] === NONE ? T.a[n] : NONE
  const children = (n) => { const out = []; for (let c = T.a[n]; c !== NONE; c = T.next[c]) out.push(c); return out }
  const detach = (id) => { T.next[id] = NONE; return id }
  const mk = (op, ...kids) => { const n = node(op); for (const k of kids) push(n, detach(k)); return n }
  // The negation, folded to one compare where the op has one (the back edge stays one fused compare-and-branch).
  const negate = (c) => {
    if (T.op[c] === O.I32_EQZ && only(c) !== NONE) return only(c)
    const neg = ROT_NEG[T.syms[T.op[c]]], x = T.a[c], y = x === NONE ? NONE : T.next[x]
    if (neg && y !== NONE && T.next[y] === NONE) { const n = node(intern(neg)); T.a[n] = x; return n }
    return mk(O.I32_EQZ, c)
  }
  const targetsLabel = (n, label) => {
    const stack = [n]
    while (stack.length) {
      const x = stack.pop(), op = T.op[x]
      if (op === O.BR || op === O.BR_IF) { if (T.a[x] !== NONE && T.sym[T.a[x]] === label) return true }
      else if (op === O.BR_TABLE) { for (let c = T.a[x]; c !== NONE; c = T.next[c]) if (T.op[c] === OP_STR && T.sym[c] === label) return true }
      for (let c = T.a[x]; c !== NONE; c = T.next[c]) if (T.op[c] >= 0) stack.push(c)
    }
    return false
  }
  const tryRotate = (blk) => {
    const kids = children(blk)
    if (!kids.length || !isLabel(kids[0])) return NONE
    const blockLabel = T.sym[kids[0]]
    // The loop is the block's final child; LICM may hoist invariant snaps into a
    // `local.set` pre-header before it, kept ahead of the guard (the guard may read
    // them). Anything else (a typed block, a side computation) bails.
    const preamble = []
    let loop = NONE
    for (let i = 1; i < kids.length; i++) {
      const c = kids[i]
      if (T.op[c] === O.LOOP) { if (loop !== NONE || i !== kids.length - 1) return NONE; loop = c }
      else if (T.op[c] === O.LOCAL_SET && loop === NONE) preamble.push(c)
      else return NONE
    }
    if (loop === NONE) return NONE
    const lk = children(loop)
    if (!lk.length || !isLabel(lk[0])) return NONE
    const loopLabel = T.sym[lk[0]]
    let li = 1
    const header = []
    while (li < lk.length) {
      const c = lk[li]
      if (T.op[c] === TYPE) { header.push(c); li++; continue }
      if (T.op[c] === PARAM || T.op[c] === RESULT) return NONE
      break
    }
    const bodyKids = lk.slice(li)
    if (bodyKids.length < 2) return NONE
    const head = bodyKids[0], tail = bodyKids[bodyKids.length - 1]
    const hk = children(head), tk = children(tail)
    if (!(T.op[head] === O.BR_IF && hk.length === 2 && T.op[hk[0]] === OP_STR && T.sym[hk[0]] === blockLabel)) return NONE
    if (!(T.op[tail] === O.BR && tk.length === 1 && T.op[tk[0]] === OP_STR && T.sym[tk[0]] === loopLabel)) return NONE
    const inner = bodyKids.slice(1, -1)
    if (inner.some((s) => targetsLabel(s, loopLabel))) return NONE   // continue to the loop top
    if (hasV128(head) || inner.some(hasV128)) return NONE            // vectorized: leave tight
    const cond = hk[1]
    return mk(O.BLOCK, sym(blockLabel), ...preamble,
      mk(O.BR_IF, sym(blockLabel), clone(cond)),
      mk(O.LOOP, sym(loopLabel), ...header, ...inner, mk(O.BR_IF, sym(loopLabel), negate(detach(cond)))))
  }
  const walk = (n) => {
    for (let c = T.a[n]; c !== NONE; c = T.next[c]) {
      if (T.op[c] < 0) continue
      if (T.op[c] === O.BLOCK) { const rot = tryRotate(c); if (rot !== NONE) { replace(n, c, rot); c = rot } }
      walk(c)
    }
  }
  walk(f)
}
