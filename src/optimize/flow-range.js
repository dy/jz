import { compareFacts, f64Range } from '../ir/numeric.js'

// Flow-sensitive interval facts for f64 locals, read off real control flow.
//
// A clamp is a guarded write: after `if (v > K) v = K; else if (v < L) v = L`
// the local lies in [L, K] (or is NaN), but every definition-based range sees
// three writers and gives up. This walk follows statements in evaluation
// order, keeps the interval each f64 local holds at each point, refines it in
// the arm a comparison guards, hulls the arms at their join, and tags every
// `local.get` it reaches with the interval in force there (`node.range`).
// `f64Range` consumes the tag under its NaN-admitting mode only: a fact from a
// failed comparison admits NaN, and the ToInt32 consumers map NaN as ToInt32
// does. Only arms that execute conditionally receive facts; a `select`
// evaluates both arms, so its refinement stays inside f64Range's own value
// reasoning. Locals a loop writes are unknown at its head; a `try` drops
// every fact; a branch target that cannot be resolved abandons the function.

const merge = (a, b) => {
  if (!a) return b
  if (!b) return a
  const out = new Map()
  for (const [k, x] of a) {
    const y = b.get(k)
    if (y) out.set(k, { lo: Math.min(x.lo, y.lo), hi: Math.max(x.hi, y.hi) })
  }
  return out
}

const LEAVES = new Set(['return', 'unreachable', 'throw', 'throw_ref', 'rethrow', 'return_call', 'return_call_indirect', 'return_call_ref'])

/** Tag the reads of `fn`'s f64 locals (`floatLocals`) with their flow interval. */
export function tagFlowRanges(fn, bodyStart, floatLocals) {
  if (!floatLocals.size) return
  const labels = []
  let abort = false
  const frameOf = name => {
    for (let i = labels.length - 1; i >= 0; i--) if (labels[i].name === name) return labels[i]
    abort = true
    return null
  }
  const writesIn = n => {
    const s = new Set()
    const w = x => {
      if (!Array.isArray(x)) return
      if ((x[0] === 'local.set' || x[0] === 'local.tee') && typeof x[1] === 'string') s.add(x[1])
      for (let i = 1; i < x.length; i++) w(x[i])
    }
    w(n)
    return s
  }
  const refine = (env, fact) => {
    if (!fact || !floatLocals.has(fact.name)) return env
    const e = new Map(env), r = env.get(fact.name)
    e.set(fact.name, r ? { lo: Math.max(r.lo, fact.lo), hi: Math.min(r.hi, fact.hi) } : { lo: fact.lo, hi: fact.hi })
    return e
  }
  const exit = (name, env) => { const f = frameOf(name); if (f && !f.loop) f.exits.push(env) }
  const seq = (list, env) => {
    for (const s of list) { if (!env) return null; env = walk(s, env) }
    return env
  }
  const walk = (n, env) => {
    if (!env || abort || !Array.isArray(n)) return env
    const op = n[0]
    if (op === 'local.get') {
      if (typeof n[1] === 'string' && floatLocals.has(n[1])) {
        const r = env.get(n[1])
        if (r) n.range = r
        else if (n.range) n.range = null
      }
      return env
    }
    if (op === 'local.set' || op === 'local.tee') {
      env = walk(n[2], env)
      if (!env || typeof n[1] !== 'string' || !floatLocals.has(n[1])) return env
      const e = new Map(env), r = f64Range(n[2], null, true)
      if (r && r.lo <= r.hi) e.set(n[1], r)
      else e.delete(n[1])
      return e
    }
    if (op === 'block' || op === 'loop') {
      let i = 1, name = null
      if (typeof n[i] === 'string') name = n[i++]
      if (Array.isArray(n[i]) && n[i][0] === 'result') i++
      const frame = { name, loop: op === 'loop', exits: [] }
      if (frame.loop) { env = new Map(env); for (const k of writesIn(n)) env.delete(k) }
      labels.push(frame)
      let out = seq(n.slice(i), env)
      labels.pop()
      for (const x of frame.exits) out = merge(out, x)
      return out
    }
    if (op === 'if') {
      let i = 1
      if (typeof n[i] === 'string') i++
      if (Array.isArray(n[i]) && n[i][0] === 'result') i++
      const cond = n[i], a = n[i + 1], b = n[i + 2]
      env = walk(cond, env)
      if (!env) return null
      const fact = compareFacts(cond)
      const yes = seq(Array.isArray(a) && a[0] === 'then' ? a.slice(1) : [a], refine(env, fact?.t))
      const no = b == null ? refine(env, fact?.f) : seq(Array.isArray(b) && b[0] === 'else' ? b.slice(1) : [b], refine(env, fact?.f))
      return merge(yes, no)
    }
    if (op === 'br') { exit(n[1], env); return null }
    if (op === 'br_if') { env = walk(n[2], env); if (env) exit(n[1], env); return env }
    if (op === 'br_table') {
      for (let i = 1; i < n.length; i++) if (Array.isArray(n[i])) env = walk(n[i], env)
      if (env) for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string') exit(n[i], env)
      return null
    }
    if (op === 'try' || op === 'try_table') {
      for (let i = 1; i < n.length; i++) walk(n[i], new Map())
      return new Map()
    }
    for (let i = 1; i < n.length; i++) { env = walk(n[i], env); if (!env) return null }
    return LEAVES.has(op) ? null : env
  }
  for (let i = bodyStart; i < fn.length; i++) walk(fn[i], new Map())
  if (abort) clearFlowRanges(fn)
}

/** Drop every flow tag: the tags describe the tree as it was when tagged. */
export function clearFlowRanges(fn) {
  const w = n => {
    if (!Array.isArray(n)) return
    if (n[0] === 'local.get') { if (n.range) n.range = null; return }
    for (let i = 1; i < n.length; i++) w(n[i])
  }
  w(fn)
}
