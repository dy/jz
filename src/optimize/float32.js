// Single-precision arithmetic.
//
// `Math.fround` lowers to a demote under a promote, and a Float32Array element
// loads through a promote, so f32 code, the C-float idiom the reference ports
// keep (`x = fround(x - fround(d * nx))`, `out[i] = sx * scale`), computes
// each step in f64 and rounds it back. The rounding is the same when the step
// computes in f32: f64 carries 53 bits, more than the 2·24 + 2 that make a
// double rounding of a sum, difference, product, quotient or square root of
// f32 values agree with the single one (Figueroa 1995). Negation, magnitude,
// the roundings to an integer, min, max, copysign and the comparisons are
// exact in either width.
//
// The pass retypes locals first. A write holds an exact f32 value when it is a
// promoted f32, a constant the format holds, a conditional of such, or a read
// of a local narrowed here; a write of one rounding step over exact operands
// (`x *= s`, the store temp of `out[i] = sx * scale`) may round early when
// every read it reaches only rounds the value (a demote, or a NaN test of the
// value against itself). A local becomes f32 when every write is one or the
// other; its reads promote. Reaching writes come from one walk of the
// function in evaluation order, loop bodies walked twice. Then a bottom-up
// fold takes each demote to its operand's f32 form: a promote peels, a step
// of exact operands computes in f32, a conditional demotes in its arms. What
// remains f64 stays f64: a value that may hold the undefined box, a sum of
// f64 values, a local read where the rounding would show.
//
// Runs after the lane lift, which reads `fround` code in its f64 form.

import { conditional } from './int-range.js'

const isArr = Array.isArray
const RESULT = n => isArr(n) && n[0] === 'result' ? n[1] : null
// A shallow copy of a node with its own properties, the marks emit left for later passes.
const copy = n => Object.assign([], n)

/** The f32 constant an f64 constant node holds exactly, or null. The special
 *  values print as their tokens. A NaN payload is not carried across widths:
 *  only the canonical NaN (either sign) converts, never a NaN box, which a
 *  number can carry as its bits. */
const bits64 = new BigUint64Array(new Float64Array(1).buffer), f64of = new Float64Array(bits64.buffer)
const f32Const = c => {
  if (typeof c === 'number') {
    if (!Number.isNaN(c)) return Math.fround(c) === c ? ['f32.const', c] : null
    f64of[0] = c
    const b = bits64[0]
    return (b & 0x7FFFFFFFFFFFFFFFn) === 0x7FF8000000000000n ? ['f32.const', b >> 63n ? '-nan' : 'nan'] : null
  }
  return c === 'nan' || c === '-nan' || c === 'inf' || c === '-inf' || c === '+inf' ? ['f32.const', c] : null
}
const EXACT_UNARY = { 'f64.neg': 'f32.neg', 'f64.abs': 'f32.abs', 'f64.floor': 'f32.floor', 'f64.ceil': 'f32.ceil', 'f64.trunc': 'f32.trunc', 'f64.nearest': 'f32.nearest' }
const EXACT_BINARY = { 'f64.min': 'f32.min', 'f64.max': 'f32.max', 'f64.copysign': 'f32.copysign' }
const ROUNDED = { 'f64.add': 'f32.add', 'f64.sub': 'f32.sub', 'f64.mul': 'f32.mul', 'f64.div': 'f32.div', 'f64.sqrt': 'f32.sqrt' }
const COMPARE = { 'f64.eq': 'f32.eq', 'f64.ne': 'f32.ne', 'f64.lt': 'f32.lt', 'f64.gt': 'f32.gt', 'f64.le': 'f32.le', 'f64.ge': 'f32.ge' }
const LEAVES = new Set(['return', 'unreachable', 'throw', 'throw_ref', 'rethrow', 'return_call', 'return_call_indirect', 'return_call_ref'])

// The positions of a value-producing conditional or block: the result and the
// arms or statements, `arms` listing [container, valueIndex] pairs.
const shape = n => {
  let i = 1
  if (typeof n[i] === 'string') i++
  const result = RESULT(n[i])
  if (result == null) return null
  const resultAt = i++
  if (n[0] === 'if') {
    const then = n[i + 1], els = n[i + 2]
    if (!isArr(then) || then[0] !== 'then' || then.length < 2 || !isArr(els) || els[0] !== 'else' || els.length < 2) return null
    return { resultAt, arms: [[then, then.length - 1], [els, els.length - 1]] }
  }
  if (n[0] === 'block') return n.length > i ? { resultAt, arms: [[n, n.length - 1]] } : null
  return null
}

// A copy of a value-producing conditional or block with an f32 result, its
// arm values mapped by `value` and everything else by `rest`, each child once
// (`rest` may rewrite a child in place).
const retype = (n, s, value, rest) => {
  const out = copy(n)
  out[s.resultAt] = ['result', 'f32']
  const arms = new Map(s.arms.map(([c, k]) => [c, k]))
  for (let i = s.resultAt + 1; i < out.length; i++) {
    const c = n[i]
    if (arms.has(c)) {
      const arm = out[i] = copy(c), k = arms.get(c)
      for (let j = 1; j < arm.length; j++) arm[j] = j === k ? value(c[j]) : rest(c[j])
    } else out[i] = n === s.arms[0][0] && i === s.arms[0][1] ? value(c) : rest(c)
  }
  return out
}

/** Whether `v` (f64 IR) holds an exact f32 value; `exactRead` judges a read or
 *  a tee of a local. */
const exactF32 = (v, exactRead) => {
  if (!isArr(v)) return false
  const op = v[0]
  if (op === 'f64.promote_f32') return v.length === 2
  if (op === 'f64.const') return f32Const(v[1]) !== null
  if (op === 'local.get' || op === 'local.tee') return exactRead(v)
  if (op === 'select') return v.length === 4 && exactF32(v[1], exactRead) && exactF32(v[2], exactRead)
  if (op in EXACT_UNARY) return exactF32(v[1], exactRead)
  if (op in EXACT_BINARY) return exactF32(v[1], exactRead) && exactF32(v[2], exactRead)
  if (op === 'if' || op === 'block') {
    const s = shape(v)
    return !!s && v[s.resultAt][1] === 'f64' && s.arms.every(([c, k]) => exactF32(c[k], exactRead))
  }
  return false
}

/** Whether a read (a `local.get`, or a tee's own value) is consumed only up to
 *  its f32 rounding: by a demote, or by the NaN test of the value against
 *  itself, reached through the value positions of conditionals; `chain` lists
 *  the read's ancestors, innermost last. */
const roundingUse = (chain, read) => {
  const same = x => x === read || (isArr(x) && x[0] === 'local.get' && read[0] === 'local.get' && x[1] === read[1])
  let child = read
  for (let i = chain.length - 1; i >= 0; i--) {
    const p = chain[i]
    if (p[0] === 'f32.demote_f64') return true
    if ((p[0] === 'f64.ne' || p[0] === 'f64.eq') && same(p[1]) && same(p[2])) return true
    if (p[0] === 'select' && p.length === 4 && (p[1] === child || p[2] === child)) { child = p; continue }
    if ((p[0] === 'then' || p[0] === 'else') && p[p.length - 1] === child) { child = p; continue }
    const s = (p[0] === 'if' || p[0] === 'block') && shape(p)
    if (s && p[s.resultAt][1] === 'f64' && s.arms.some(([c]) => c === child || c[c.length - 1] === child)) { child = p; continue }
    return false
  }
  return false
}

const ENTRY = Symbol('entry')

/** The reads each write of a tracked local reaches, and the writes reaching
 *  each read, from one walk in evaluation order; null when the control flow
 *  has a shape the walk does not follow. */
function reachingWrites(fn, bodyStart, tracked) {
  const reach = new Map()     // read node → Set of write nodes (or ENTRY)
  const readsOf = new Map()   // write node → [read node, ancestors]
  const labels = [], stack = []
  let abort = false
  const frameOf = name => {
    for (let i = labels.length - 1; i >= 0; i--) if (labels[i].name === name) return labels[i]
    abort = true
    return null
  }
  // (the maps and the sets are written once: a side that adds nothing is the join)
  const merge = (a, b) => {
    if (!a) return b
    if (!b || a === b) return a
    let out = null
    for (const [k, s] of b) {
      const t = a.get(k)
      if (t === s) continue
      let more = !t
      if (t) for (const w of s) if (!t.has(w)) { more = true; break }
      if (!more) continue
      if (!out) out = new Map(a)
      out.set(k, t ? new Set([...t, ...s]) : s)
    }
    return out ?? a
  }
  const exit = (name, env) => { const f = frameOf(name); if (f && env) f.exits.push(env) }
  // A read node an emitter placed at several points (the IR is a DAG) is reached
  // by the writes of every one of them.
  const note = (read, env) => {
    const ws = env.get(read[1]) ?? new Set([ENTRY])
    const seen = reach.get(read)
    reach.set(read, seen ? new Set([...seen, ...ws]) : ws)
    const chain = stack.slice(0, -1)
    for (const w of ws) if (w !== ENTRY) (readsOf.get(w) ?? readsOf.set(w, []).get(w)).push([read, chain])
  }
  const walk = (n, env) => {
    if (abort || !isArr(n)) return env
    stack.push(n)
    try { return visit(n, env) } finally { stack.pop() }
  }
  const visit = (n, env) => {
    const op = n[0]
    if (op === 'local.get') {
      if (env && tracked.has(n[1])) note(n, env)
      return env
    }
    if (op === 'local.set' || op === 'local.tee') {
      env = walk(n[2], env)
      if (!env || !tracked.has(n[1])) return env
      const e = new Map(env)
      e.set(n[1], new Set([n]))
      if (op === 'local.tee') note(n, e)
      return e
    }
    if (op === 'block' || op === 'loop') {
      let i = 1, name = null
      if (typeof n[i] === 'string') name = n[i++]
      if (RESULT(n[i]) != null) i++
      const frame = { name, loop: op === 'loop', exits: [] }
      labels.push(frame)
      const body = n.slice(i)
      const seq = env => { for (const s of body) { if (!env) break; env = walk(s, env) } return env }
      let out = seq(env)
      if (frame.loop) {
        // Writes late in the body reach reads early in the next iteration.
        let head = merge(env, out)
        for (const x of frame.exits) head = merge(head, x)
        frame.exits = []
        out = seq(head)
      } else for (const x of frame.exits) out = merge(out, x)
      labels.pop()
      return out
    }
    if (op === 'if') {
      // (a kernel written as text keeps its comments among its children)
      const { test, then, otherwise } = conditional(n)
      env = walk(test, env)
      if (!env) return null
      const arm = a => {
        if (!isArr(a)) return env
        if (a[0] !== 'then' && a[0] !== 'else') return walk(a, env)
        stack.push(a)
        try { return a.slice(1).reduce((e, s) => e ? walk(s, e) : e, env) } finally { stack.pop() }
      }
      const yes = arm(then), no = otherwise == null ? env : arm(otherwise)
      return merge(yes, no)
    }
    if (op === 'br') { exit(n[1], env); return null }
    if (op === 'br_if') { env = walk(n[2], env); exit(n[1], env); return env }
    if (op === 'br_table') {
      for (let i = 1; i < n.length; i++) if (isArr(n[i])) env = walk(n[i], env)
      for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string') exit(n[i], env)
      return null
    }
    if (op === 'try' || op === 'try_table' || op === 'catch' || op === 'catch_all') { abort = true; return null }
    for (let i = 1; i < n.length; i++) { env = walk(n[i], env); if (!env) return null }
    return LEAVES.has(op) ? null : env
  }
  let env = new Map()
  for (let i = bodyStart; i < fn.length; i++) env = walk(fn[i], env)
  return abort ? null : { reach, readsOf }
}

export function narrowFloat32(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return
  let bodyStart = 2
  const decls = new Map()
  for (; bodyStart < fn.length; bodyStart++) {
    const d = fn[bodyStart]
    if (!isArr(d) || (d[0] !== 'param' && d[0] !== 'local' && d[0] !== 'result' && d[0] !== 'export' && d[0] !== 'type')) break
    if (d[0] === 'local' && typeof d[1] === 'string' && d[2] === 'f64') decls.set(d[1], d)
  }
  if (decls.size) narrowLocals(fn, bodyStart, decls)
  for (let i = bodyStart; i < fn.length; i++) fn[i] = fold(fn[i])
}

function narrowLocals(fn, bodyStart, decls) {
  const flow = reachingWrites(fn, bodyStart, decls)
  if (!flow) return
  const { reach, readsOf } = flow
  const writes = new Map()
  const collect = n => {
    if (!isArr(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && decls.has(n[1])) (writes.get(n[1]) ?? writes.set(n[1], []).get(n[1])).push(n)
    for (let i = 1; i < n.length; i++) collect(n[i])
  }
  for (let i = bodyStart; i < fn.length; i++) collect(fn[i])
  // Optimistic fixpoint over the writes: a write stays good while its value is
  // exact, or is one rounding step reaching only rounding reads (rounded early
  // once its local narrows); a local narrows while every write is good; a read
  // is exact while every write reaching it is good and, if it rounds early,
  // belongs to a local that narrows. A local no visible write reaches is left
  // alone: code materialized after this pass writes such temps (a deferred
  // BigInt box's operands), and it holds what that code gives it.
  let good, narrow, early
  const barred = new Set()
  // Whether every read a write reaches only rounds the value, a copy into
  // another tracked local counting when its own reads do.
  const roundsAway = (w, seen = new Set()) => {
    if (seen.has(w)) return true
    seen.add(w)
    return (readsOf.get(w) ?? []).every(([r, chain]) => {
      if (roundingUse(chain, r)) return true
      const p = chain[chain.length - 1]
      return isArr(p) && (p[0] === 'local.set' || p[0] === 'local.tee') && p[2] === r && decls.has(p[1]) && roundsAway(p, seen)
    })
  }
  const exactRead = r => {
    const ws = reach.get(r)
    if (!ws || !writes.has(r[1])) return false
    for (const w of ws) if (w !== ENTRY && !(good.has(w) && (!early.has(w) || narrow.has(w[1])))) return false
    return true
  }
  const settle = () => {
    good = new Set(); early = new Set()
    narrow = new Set([...writes.keys()].filter(name => !barred.has(name)))
    for (const ws of writes.values()) for (const w of ws) good.add(w)
    for (let changed = true; changed;) {
      changed = false
      for (const [name, ws] of writes) for (const w of ws) {
        if (!good.has(w)) continue
        const v = w[2]
        if (exactF32(v, exactRead)) { early.delete(w); continue }
        if (narrow.has(name) && isArr(v) && v[0] in ROUNDED && v.slice(1).every(a => exactF32(a, exactRead)) && roundsAway(w)) { early.add(w); continue }
        good.delete(w); early.delete(w); changed = true
        narrow.delete(name)
      }
    }
  }
  // Narrowing is worth its promotes: a local narrows when it removes more
  // conversions than its reads in f64 code add. A flag or a count written by
  // constants alone gains nothing and would pay one promote a read.
  // What the fold takes to f32 once the narrowed locals read through a promote.
  const folds = v => {
    if (!isArr(v)) return false
    const op = v[0]
    if (op === 'f64.promote_f32') return true
    if (op === 'f64.const') return f32Const(v[1]) !== null
    if (op === 'local.get' || op === 'local.tee') return narrow.has(v[1])
    if (op === 'select') return v.length === 4 && folds(v[1]) && folds(v[2])
    if (op in EXACT_UNARY || op in EXACT_BINARY) return v.slice(1).every(folds)
    const s = (op === 'if' || op === 'block') && shape(v)
    return !!s && v[s.resultAt][1] === 'f64' && s.arms.every(([c, k]) => folds(c[k]))
  }
  // The conversions the f32 form of an exact value drops.
  const dropped = v => {
    if (!isArr(v)) return 0
    const op = v[0]
    if (op === 'f64.promote_f32') return 1
    if (op === 'select') return dropped(v[1]) + dropped(v[2])
    if (op in EXACT_UNARY || op in EXACT_BINARY) return v.slice(1).reduce((n, a) => n + dropped(a), 0)
    const s = (op === 'if' || op === 'block') && shape(v)
    return s ? s.arms.reduce((n, [c, k]) => n + dropped(c[k]), 0) : 0
  }
  // A read's balance: +1 where the fold removes a conversion around it, 0 where
  // it reads in f32 for free (a compare of two f32 values, a narrowed local's
  // write), -1 where f64 code reads it through a promote.
  const balance = (chain, read) => {
    let child = read
    for (let i = chain.length - 1; i >= 0; i--) {
      const p = chain[i], op = p[0]
      if (op === 'f32.demote_f64') return 1
      if (op in COMPARE) return p.slice(1).every(a => a === child || folds(a)) ? 0 : -1
      if ((op === 'local.set' || op === 'local.tee') && p[2] === child) return narrow.has(p[1]) ? 0 : -1
      if (op === 'select' && p.length === 4 && (p[1] === child || p[2] === child)) { child = p; continue }
      if ((op === 'then' || op === 'else') && p[p.length - 1] === child) { child = p; continue }
      const s = (op === 'if' || op === 'block') && shape(p)
      if (s && p[s.resultAt][1] === 'f64' && s.arms.some(([c]) => c === child || c[c.length - 1] === child)) { child = p; continue }
      if ((op in ROUNDED || op in EXACT_UNARY || op in EXACT_BINARY) && p.slice(1).every(a => a === child || folds(a))) { child = p; continue }
      return -1
    }
    return -1
  }
  const worth = name => {
    let n = 0
    const seen = new Set()
    for (const w of writes.get(name)) {
      n += early.has(w) ? 1 + w[2].slice(1).reduce((k, a) => k + dropped(a), 0) : dropped(w[2])
      for (const [r, chain] of readsOf.get(w) ?? []) if (r !== w && !seen.has(r)) { seen.add(r); n += balance(chain, r) }
    }
    return n > 0
  }
  for (;;) {
    settle()
    const unworthy = [...narrow].filter(name => !worth(name))
    if (!unworthy.length) break
    for (const name of unworthy) barred.add(name)
  }
  // A copy of a narrowed local (the value a specialized loop keeps of it at the
  // top of an iteration, optimize/specialize.js) is carried as the local is.
  for (const [name, d] of decls) if (d.copyOf != null && narrow.has(d.copyOf) && writes.get(name)?.every(w => w[0] === 'local.set' && w[2][0] === 'local.get' && w[2][1] === d.copyOf)) narrow.add(name)
  if (!narrow.size) return
  // The f32 form of an exact f64 value: a narrowed local reads in f32; a local
  // that stays f64 holds an exact value at this read (only exact writes reach
  // it), which demotes without loss.
  const f32 = v => {
    const op = v[0]
    if (op === 'f64.promote_f32') return rewrite(v[1])
    if (op === 'f64.const') return f32Const(v[1])
    if (op === 'local.get') return narrow.has(v[1]) ? v : ['f32.demote_f64', v]
    if (op === 'local.tee') return narrow.has(v[1]) ? ['local.tee', v[1], written(v)] : ['f32.demote_f64', ['local.tee', v[1], rewrite(v[2])]]
    if (op === 'select') return ['select', f32(v[1]), f32(v[2]), rewrite(v[3])]
    if (op in EXACT_UNARY) return [EXACT_UNARY[op], f32(v[1])]
    if (op in EXACT_BINARY) return [EXACT_BINARY[op], f32(v[1]), f32(v[2])]
    return retype(v, shape(v), f32, rewrite)
  }
  // The value a narrowed local's write holds in f32: rounded early or exact.
  const written = w => early.has(w) ? [ROUNDED[w[2][0]], ...w[2].slice(1).map(f32)] : f32(w[2])
  // Every other node keeps its type: a narrowed local's read or tee promotes.
  // Nodes are copied (a subtree an earlier pass shares rewrites once per
  // parent) with the marks later passes read (a devirtualized call's, a
  // property read's).
  const rewrite = n => {
    if (!isArr(n)) return n
    const op = n[0]
    if (op === 'local.get' && narrow.has(n[1])) return ['f64.promote_f32', n]
    if ((op === 'local.set' || op === 'local.tee') && narrow.has(n[1])) {
      const w = copy(n)
      w[2] = written(n)
      return op === 'local.tee' ? ['f64.promote_f32', w] : w
    }
    const out = copy(n)
    for (let i = 1; i < out.length; i++) out[i] = rewrite(out[i])
    return out
  }
  for (const name of narrow) decls.get(name)[2] = 'f32'
  for (let i = bodyStart; i < fn.length; i++) fn[i] = rewrite(fn[i])
}

/** The f32 form of an f64 expression when it is exact, or null. */
const f32Of = n => {
  if (!isArr(n)) return null
  const op = n[0]
  if (op === 'f64.promote_f32' && n.length === 2) return n[1]
  if (op === 'f64.const') return f32Const(n[1])
  if (op === 'select' && n.length === 4) {
    const a = f32Of(n[1]), b = f32Of(n[2])
    return a && b ? ['select', a, b, n[3]] : null
  }
  if (op in EXACT_UNARY) { const a = f32Of(n[1]); return a && [EXACT_UNARY[op], a] }
  if (op in EXACT_BINARY) { const a = f32Of(n[1]), b = f32Of(n[2]); return a && b && [EXACT_BINARY[op], a, b] }
  if (op === 'if' || op === 'block') {
    const s = shape(n)
    if (!s || n[s.resultAt][1] !== 'f64') return null
    const values = s.arms.map(([c, k]) => f32Of(c[k]))
    if (values.some(v => v === null)) return null
    let i = 0
    return retype(n, s, () => values[i++], x => x)
  }
  return null
}

/** The f32 value of `demote(x)`: the operand's own f32 form, a rounding step of
 *  exact operands in f32, a conditional demoted in its arms, else the demote. */
const demote = x => {
  const own = f32Of(x)
  if (own) return own
  if (isArr(x)) {
    const op = x[0]
    if (op in ROUNDED) {
      const args = x.slice(1).map(f32Of)
      if (args.every(a => a !== null)) return [ROUNDED[op], ...args]
    }
    if (op === 'select' && x.length === 4) return ['select', demote(x[1]), demote(x[2]), x[3]]
    const s = (op === 'if' || op === 'block') && shape(x)
    if (s && x[s.resultAt][1] === 'f64') return retype(x, s, demote, y => y)
  }
  return ['f32.demote_f64', x]
}

const fold = n => {
  if (!isArr(n)) return n
  for (let i = 1; i < n.length; i++) n[i] = fold(n[i])
  const op = n[0]
  if (op === 'f32.demote_f64' && n.length === 2) return demote(n[1])
  if (op in COMPARE && n.length === 3) {
    const a = f32Of(n[1]), b = f32Of(n[2])
    if (a && b) return [COMPARE[op], a, b]
  }
  return n
}
