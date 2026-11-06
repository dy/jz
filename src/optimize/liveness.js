/**
 * Backward liveness over structured code, into expressions as well: the
 * locals live before a node, from those live after it. A `local.set` kills
 * its local, a read brings it in, a branch brings in what is live past its
 * target, a loop's own label the loop's live-in (its least fixed point), a
 * handler's what a throw anywhere in its body could reach; the children of
 * anything else run in order, so each sees what the next needs. Liveness is
 * the whole rule: a binding the body declares is written before it is read
 * in every iteration, so it is dead at the top, and a caller's local across
 * an inlined loop, or a specialized path's copy of one, is live where its
 * reads say so.
 *
 * `at` receives the live set before each loop the caller asked about, and
 * past each block it asked about; `past`, where given, the live set past each
 * node it asks about (a statement, an operand, a loop).
 *
 * @module optimize/liveness
 */
const BR = new Set(['br', 'br_if', 'br_table'])
const HEAD = new Set(['result', 'param', 'type'])
const NONE = new Set()
const union = (a, b) => { for (const x of b) a.add(x); return a }

export const liveIn = (n, out, env, at, past = null) => {
  if (!Array.isArray(n)) return out
  const op = n[0]
  if (op === 'local.get') { if (out.has(n[1])) return out; return union(new Set(out), [n[1]]) }
  if (op === 'local.set' || op === 'local.tee') { const live = new Set(out); live.delete(n[1]); return liveIn(n[2], live, env, at, past) }
  if (BR.has(op)) {
    let live = out
    for (let i = n.length - 1; i >= 1; i--) live = typeof n[i] === 'string' ? union(new Set(live), env.get(n[i]) ?? NONE) : liveIn(n[i], live, env, at, past)
    return live
  }
  if (op === 'block' || op === 'loop') {
    const label = typeof n[1] === 'string' ? n[1] : null
    if (op !== 'loop' || !label) {
      if (at.has(n)) at.set(n, out)
      return liveSeq(n, out, label ? new Map(env).set(label, out) : env, at, past)
    }
    // a branch back to the loop brings in its own live-in: the least fixed
    // point, from what is live past the loop
    const inner = new Map(env)
    let live = out
    for (;;) {
      inner.set(label, live)
      const next = liveSeq(n, out, inner, at, past)
      if ([...next].every(x => live.has(x))) { live = next; break }
      live = union(new Set(live), next)
    }
    if (at.has(n)) at.set(n, live)
    if (past?.has(n)) past.set(n, out)
    return live
  }
  if (op === 'try_table') {
    // a throw anywhere in the body reaches a handler: what is live past each
    // is live throughout, so at the entry
    let live = new Set(out)
    for (const c of n) if (Array.isArray(c) && c[0].startsWith('catch')) union(live, env.get(c[c.length - 1]) ?? NONE)
    return liveSeq(n, live, env, at, past)
  }
  if (op === 'if') {
    let arms = null, hasElse = false, cond = out
    if (typeof n[1] === 'string') env = new Map(env).set(n[1], out)
    for (let i = n.length - 1; i >= 1; i--) {
      const c = n[i]
      if (!Array.isArray(c)) continue
      if (c[0] === 'then' || c[0] === 'else') { arms = union(liveSeq(c, out, env, at, past), arms ?? NONE); if (c[0] === 'else') hasElse = true }
    }
    cond = arms ? (hasElse ? arms : union(arms, out)) : out
    for (let i = n.length - 1; i >= 1; i--) {
      const c = n[i]
      if (Array.isArray(c) && !HEAD.has(c[0]) && c[0] !== 'then' && c[0] !== 'else') cond = liveIn(c, cond, env, at, past)
    }
    return cond
  }
  return liveSeq(n, out, env, at, past)
}
/** The children of a node in order, each seeing what the next needs. */
export const liveSeq = (n, out, env, at, past = null) => {
  let live = out
  for (let i = n.length - 1; i >= 1; i--) if (Array.isArray(n[i]) && !HEAD.has(n[i][0])) {
    if (past?.has(n[i])) past.set(n[i], live)
    live = liveIn(n[i], live, env, at, past)
  }
  return live
}

