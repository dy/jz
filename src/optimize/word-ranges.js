/**
 * The interval each i32 value of a function holds where it is computed, read
 * off its control flow: a counter `i` under `br_if $loop (i < 64)` lies in
 * [0, 63] in the loop and its sum with 1 in [1, 64], a hash `h & 63` in
 * [0, 63], a byte load in [0, 255].
 *
 * A walk in evaluation order keeps the interval each i32 local holds at each
 * point (a local the function declares starts at 0, a parameter anywhere),
 * refines it in the arm or past the branch a comparison decides (with a
 * literal, or a word within its own interval), joins the ways into a block's
 * end and a loop's head, and records the interval of every i32 expression it
 * evaluates. A loop's head is the join of its entry and every branch back to
 * it, walked again until it holds: a bound still moving after a pass widens to
 * the next bound a comparison names (or past it by one), then to no bound; a
 * head that holds then narrows to its entry and branches back while they stay
 * within it. Arithmetic a word could wrap in has no interval. A branch to a
 * label it cannot resolve, a `try`, a local named by its index or an
 * instruction in stack form leaves the function without facts.
 *
 * @module optimize/word-ranges
 */

import { nrBinary, nrInts, nrSpan } from '../summary/num-range.js'

const isArr = Array.isArray
const MIN = -2147483648, MAX = 2147483647
const FULL = { lo: MIN, hi: MAX }
const range = (lo, hi) => lo >= MIN && hi <= MAX && lo <= hi ? { lo, hi } : null
const LEAVES = new Set(['return', 'unreachable', 'throw', 'throw_ref', 'rethrow', 'return_call', 'return_call_indirect', 'return_call_ref'])
const OPAQUE = new Set(['try', 'try_table', 'catch', 'catch_all', 'delegate', 'br_on_null', 'br_on_non_null', 'br_on_cast', 'br_on_cast_fail'])
const HEADER = new Set(['param', 'result', 'type'])
const FLAG = new Set(['i32.eqz', 'i64.eqz', ...['i32', 'i64'].flatMap(t => ['eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u'].map(o => `${t}.${o}`)),
  ...['f32', 'f64'].flatMap(t => ['eq', 'ne', 'lt', 'gt', 'le', 'ge'].map(o => `${t}.${o}`))])
const NEGATE = { 'i32.lt_s': 'i32.ge_s', 'i32.ge_s': 'i32.lt_s', 'i32.gt_s': 'i32.le_s', 'i32.le_s': 'i32.gt_s',
  'i32.lt_u': 'i32.ge_u', 'i32.ge_u': 'i32.lt_u', 'i32.gt_u': 'i32.le_u', 'i32.le_u': 'i32.gt_u', 'i32.eq': 'i32.ne', 'i32.ne': 'i32.eq' }
const SWAP = { 'i32.lt_s': 'i32.gt_s', 'i32.gt_s': 'i32.lt_s', 'i32.le_s': 'i32.ge_s', 'i32.ge_s': 'i32.le_s',
  'i32.lt_u': 'i32.gt_u', 'i32.gt_u': 'i32.lt_u', 'i32.le_u': 'i32.ge_u', 'i32.ge_u': 'i32.le_u', 'i32.eq': 'i32.eq', 'i32.ne': 'i32.ne' }
const WIDEN_AFTER = 2, PASSES = 4, NARROW = 3

// a literal's value: a number, or its text (`0xff`, `-8`) where the tree came from text
const constOf = (n) => {
  if (!isArr(n) || n[0] !== 'i32.const' || n.length !== 2) return null
  let v = n[1]
  if (typeof v === 'string') { const m = /^([-+]?)(0x[0-9a-f]+|\d+)$/i.exec(v); v = m ? (m[1] === '-' ? -1 : 1) * Number(m[2]) : NaN }
  return typeof v === 'number' && Number.isInteger(v) ? v | 0 : null
}
const join = (a, b) => !a || !b ? null : { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi) }
const within = (a, b) => !b || (!!a && a.lo >= b.lo && a.hi <= b.hi)
const sameEnv = (a, b) => { if (a.size !== b.size) return false; for (const [k, x] of a) { const y = b.get(k); if (!y || y.lo !== x.lo || y.hi !== x.hi) return false } return true }
// every interval of `a` within its local's in `b` (a local `b` lacks may hold anything)
const withinEnv = (a, b) => { for (const [k, y] of b) if (!within(a.get(k), y)) return false; return true }
const mergeEnv = (a, b) => {
  if (!a) return b
  if (!b) return a
  const out = new Map()
  for (const [k, x] of a) { const y = b.get(k); if (y) out.set(k, join(x, y)) }
  return out
}
// the bits a non-negative value below 2^31 may set: [0, 2^k - 1]
const mask = (hi) => hi <= 0 ? 0 : 2 ** (32 - Math.clz32(hi)) - 1

/** The interval of each i32 expression of `fn` (a Map from its node), or null where the walk cannot follow the function. */
export function wordRanges(fn) {
  const words = new Set()
  let body = 2
  for (; body < fn.length; body++) {
    const d = fn[body]
    if (!isArr(d) || d[0] === 'export' || d[0] === 'import' || d[0] === 'type' || d[0] === 'result') continue
    if (d[0] !== 'param' && d[0] !== 'local') break
    if (typeof d[1] !== 'string') return null   // an unnamed declaration: a reference by index the walk cannot name
    if (d[2] === 'i32') words.add(d[1])
  }
  const params = new Set(fn.filter(d => isArr(d) && d[0] === 'param').map(d => d[1]))
  const out = new Map(), labels = []
  // the bounds the comparisons name, each and one on either side: where a widened bound comes to rest
  const steps = new Set([0])
  let abort = false
  // A loop walks its body until its head holds, and each walk walks the loops
  // inside it as often: a nest costs its passes to the power of its depth.
  // Past a budget of 4096 visits per node of the function (watr's compile
  // peaks at 778), a loop widens a bound still moving straight to none and
  // does not narrow, two or three walks: sound, an interval only looser.
  let visits = 0, budget = 50000
  const weigh = (n) => { budget += 4096; for (let i = 1; i < n.length; i++) if (isArr(n[i])) weigh(n[i]) }
  weigh(fn)
  const frameOf = (label) => {
    if (typeof label === 'number' || /^\d+$/.test(label)) { const f = labels[labels.length - 1 - Number(label)]; if (!f) abort = true; return f }
    for (let i = labels.length - 1; i >= 0; i--) if (labels[i].name === label) return labels[i]
    abort = true
    return null
  }
  const leave = (label, env) => { const f = frameOf(label); if (f) (f.loop ? f.backs : f.exits).push(env) }
  const get = (env, x) => words.has(x) ? env.get(x) ?? null : null

  // the facts a condition gives where it holds (`yes`) or fails: [local, interval, named by a tee of it]
  const facts = (c, env, yes, into) => {
    if (!isArr(c)) return
    const op = c[0]
    if (op === 'i32.eqz') return facts(c[1], env, !yes, into)
    if ((op === 'i32.and' && yes) || (op === 'i32.or' && !yes)) { facts(c[1], env, yes, into); facts(c[2], env, yes, into); return }
    const x = localOf(c)
    if (x) {
      const r = get(env, x) ?? FULL
      if (!yes) into.push([x, { lo: 0, hi: 0 }, c[0] === 'local.tee'])
      else if (r.lo >= 0) into.push([x, { lo: Math.max(r.lo, 1), hi: r.hi }, c[0] === 'local.tee'])
      return
    }
    if (!NEGATE[op] || c.length !== 3) return
    let a = c[1], b = c[2], cmp = yes ? op : NEGATE[op]
    if (!localOf(a)) { [a, b] = [b, a]; cmp = SWAP[cmp] }
    // (a bound of no interval is still a word)
    const name = localOf(a), k = out.get(b) ?? FULL
    if (!name) return
    for (const v of [k.lo - 1, k.lo, k.lo + 1, k.hi - 1, k.hi, k.hi + 1]) steps.add(v)
    const r = get(env, name) ?? FULL
    let lo = r.lo, hi = r.hi
    if (cmp === 'i32.lt_s') hi = Math.min(hi, k.hi - 1)
    else if (cmp === 'i32.le_s') hi = Math.min(hi, k.hi)
    else if (cmp === 'i32.gt_s') lo = Math.max(lo, k.lo + 1)
    else if (cmp === 'i32.ge_s') lo = Math.max(lo, k.lo)
    else if (cmp === 'i32.eq') { lo = Math.max(lo, k.lo); hi = Math.min(hi, k.hi) }
    else if ((cmp === 'i32.lt_u' || cmp === 'i32.le_u') && k.lo >= 0) {
      // below a non-negative bound, unsigned: a non-negative value within it
      lo = Math.max(lo, 0); hi = Math.min(hi, cmp === 'i32.lt_u' ? k.hi - 1 : k.hi)
    } else if ((cmp === 'i32.gt_u' || cmp === 'i32.ge_u') && r.lo >= 0 && k.lo >= 0) lo = Math.max(lo, cmp === 'i32.gt_u' ? k.lo + 1 : k.lo)
    else return
    into.push([name, { lo, hi }, a[0] === 'local.tee'])
  }
  // the local a value names as it stands after evaluation: a read or a tee of it
  const localOf = (n) => isArr(n) && (n[0] === 'local.get' || n[0] === 'local.tee') && words.has(n[1]) ? n[1] : null
  const refine = (env, cond, yes) => {
    if (!env) return env
    const into = []
    facts(cond, env, yes, into)
    if (!into.length) return env
    // a fact of a local the condition writes holds only as the one fact of the one write, a tee it compares
    const written = writesIn(cond), e = new Map(env)
    for (const [x, r, tee] of into) {
      const w = written.get(x) || 0
      if (w && (w > 1 || !tee || into.filter(f => f[0] === x).length > 1)) continue
      const cur = e.get(x)
      // (an empty meet: the way cannot run, and any interval holds there)
      const lo = cur ? Math.max(cur.lo, r.lo) : r.lo, hi = cur ? Math.min(cur.hi, r.hi) : r.hi
      e.set(x, lo <= hi ? { lo, hi } : r.lo <= r.hi ? r : cur ?? FULL)
    }
    return e
  }

  // (an instruction in stack form, a bare op among the statements, is one the walk cannot follow,
  // but a `drop` or `nop` touches no local and an `unreachable` or `return` ends the way)
  const seq = (list, env) => {
    for (const s of list) {
      if (!env || abort) return null
      if (isArr(s)) env = walk(s, env)
      else if (s === 'unreachable' || s === 'return') env = null
      else if (s !== 'drop' && s !== 'nop') { abort = true; return null }
    }
    return env
  }
  const value = (n, r, env) => { if (r) out.set(n, r); else out.delete(n); return env }
  const walk = (n, env) => {
    if (!env || abort || !isArr(n)) return env
    visits++
    const op = n[0]
    if (OPAQUE.has(op)) { abort = true; return null }
    // (a local named by its index may be one the walk tracks by name)
    if ((op === 'local.get' || op === 'local.set' || op === 'local.tee') && typeof n[1] !== 'string') { abort = true; return null }
    if (op === 'local.get') return value(n, get(env, n[1]), env)
    if (op === 'local.set' || op === 'local.tee') {
      env = walk(n[2], env)
      if (!env || !words.has(n[1])) return env
      const r = out.get(n[2]) ?? null, e = new Map(env)
      if (r) e.set(n[1], r); else e.delete(n[1])
      return op === 'local.tee' ? value(n, r, e) : e
    }
    if (op === 'block' || op === 'loop' || op === 'if') {
      let i = 1, name = null
      if (typeof n[i] === 'string') name = n[i++]
      while (isArr(n[i]) && HEADER.has(n[i][0])) i++
      if (op === 'if') {
        const cond = n[i], a = n[i + 1], b = n[i + 2]
        env = walk(cond, env)
        if (!env) return null
        const frame = { name, exits: [] }
        labels.push(frame)
        let res = seq(isArr(a) && a[0] === 'then' ? a.slice(1) : [a], refine(env, cond, true))
        res = mergeEnv(res, b == null ? refine(env, cond, false) : seq(isArr(b) && b[0] === 'else' ? b.slice(1) : [b], refine(env, cond, false)))
        labels.pop()
        for (const x of frame.exits) res = mergeEnv(res, x)
        return res
      }
      const list = n.slice(i)
      if (op === 'block') {
        const frame = { name, exits: [] }
        labels.push(frame)
        let res = seq(list, env)
        labels.pop()
        for (const x of frame.exits) res = mergeEnv(res, x)
        return res
      }
      // a loop: its head joins the entry and every branch back, walked until it holds; then,
      // from a head that holds, the entry and the branches back alone narrow it while they lie within
      thresholds(n, steps)
      const plain = visits > budget
      let head = env, narrowing = 0, mayNarrow = !plain
      for (let pass = 0; ; pass++) {
        const frame = { name, loop: true, backs: [] }
        labels.push(frame)
        const res = seq(list, head)
        labels.pop()
        if (abort) return null
        let back = env
        for (const x of frame.backs) back = mergeEnv(back, x)
        if (narrowing) {
          // (a head the walk keeps within holds: the walk's facts are sound)
          if (withinEnv(back, head)) {
            if (sameEnv(back, head) || narrowing >= NARROW) return res
            head = back; narrowing++; continue
          }
          narrowing = 0; mayNarrow = false   // (a step that left the head: climb again, and hold where it holds)
        }
        const next = mergeEnv(head, back)
        if (sameEnv(next, head)) {
          if (sameEnv(back, head) || !mayNarrow) return res
          head = back; narrowing = 1; continue
        }
        // a bound still moving widens to the next bound a comparison names, then to none
        head = plain ? widen(head, next, []) : pass < WIDEN_AFTER ? next : widen(head, next, pass < WIDEN_AFTER + PASSES ? [...steps] : [])
      }
    }
    if (op === 'br') { walkOperands(n, env); leave(n[1], env); return null }
    if (op === 'br_if') {
      env = walkOperands(n, env)
      if (!env) return null
      const cond = n[n.length - 1]
      leave(n[1], refine(env, cond, true))
      return refine(env, cond, false)
    }
    if (op === 'br_table') {
      env = walkOperands(n, env)
      if (env) for (let i = 1; i < n.length; i++) if (!isArr(n[i])) leave(n[i], env)
      return null
    }
    env = walkOperands(n, env)
    if (!env) return null
    if (LEAVES.has(op)) return null
    return value(n, rangeOf(n), env)
  }
  const walkOperands = (n, env) => { for (let i = 1; i < n.length; i++) { if (isArr(n[i])) env = walk(n[i], env); if (!env) return null } return env }
  // the interval of an operator over operands the walk has evaluated
  const rangeOf = (n) => {
    const op = n[0]
    const k = constOf(n)
    if (k != null) return { lo: k, hi: k }
    if (FLAG.has(op)) return { lo: 0, hi: 1 }
    if (op === 'i32.load8_u') return { lo: 0, hi: 255 }
    if (op === 'i32.load16_u') return { lo: 0, hi: 65535 }
    if (op === 'i32.load8_s') return { lo: -128, hi: 127 }
    if (op === 'i32.load16_s') return { lo: -32768, hi: 32767 }
    if (op === 'i32.clz' || op === 'i32.ctz' || op === 'i32.popcnt') return { lo: 0, hi: 32 }
    if (op === 'select') return join(out.get(n[1]), out.get(n[2]))
    if (n.length !== 3 || typeof op !== 'string' || !op.startsWith('i32.')) return null
    const a = out.get(n[1]), b = out.get(n[2]), kb = constOf(n[2])
    if (op === 'i32.and') {
      const na = a && a.lo >= 0 ? a : null, nb = b && b.lo >= 0 ? b : null
      return na && nb ? { lo: 0, hi: Math.min(na.hi, nb.hi) } : na ? { lo: 0, hi: na.hi } : nb ? { lo: 0, hi: nb.hi } : null
    }
    if (op === 'i32.shr_u' && kb != null && (kb & 31)) return a && a.lo >= 0 ? { lo: a.lo >>> (kb & 31), hi: a.hi >>> (kb & 31) } : { lo: 0, hi: 2 ** (32 - (kb & 31)) - 1 }
    if (!a || !b) return null
    if (op === 'i32.add') return range(a.lo + b.lo, a.hi + b.hi)
    if (op === 'i32.sub') return range(a.lo - b.hi, a.hi - b.lo)
    if (op === 'i32.mul') { const p = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi]; return range(Math.min(...p), Math.max(...p)) }
    if (op === 'i32.shl' && kb != null) return range(a.lo * 2 ** (kb & 31), a.hi * 2 ** (kb & 31))
    if (op === 'i32.shr_s' && kb != null) return { lo: a.lo >> (kb & 31), hi: a.hi >> (kb & 31) }
    if ((op === 'i32.or' || op === 'i32.xor') && a.lo >= 0 && b.lo >= 0) return { lo: op === 'i32.or' ? Math.max(a.lo, b.lo) : 0, hi: mask(Math.max(a.hi, b.hi)) }
    // (read unsigned, the remainder of the values where both are non-negative)
    if (op === 'i32.rem_u' && b.lo > 0 && a.lo >= 0) { const r = nrSpan(nrBinary('%', nrInts(a.lo, a.hi), nrInts(b.lo, b.hi))); return r && { lo: r[0], hi: r[1] } }
    if (op === 'i32.div_u' && b.lo > 0 && a.lo >= 0) return { lo: Math.floor(a.lo / b.hi), hi: Math.floor(a.hi / b.lo) }
    return null
  }

  const entry = new Map()
  for (const x of words) if (!params.has(x)) entry.set(x, { lo: 0, hi: 0 })
  seq(fn.slice(body), entry)
  return abort ? null : out
}

// widen each bound still moving to the next literal the loop compares with, then to none
function widen(head, next, steps) {
  const out = new Map()
  for (const [x, r] of next) {
    const h = head.get(x)
    if (within(r, h)) { out.set(x, r); continue }
    let lo = r.lo, hi = r.hi
    if (!h || lo < h.lo) lo = steps.filter(s => s <= lo).reduce((m, s) => Math.max(m, s), MIN)
    if (!h || hi > h.hi) hi = steps.filter(s => s >= hi).reduce((m, s) => Math.min(m, s), MAX)
    if (lo > MIN || hi < MAX) out.set(x, { lo, hi })
  }
  return out
}

// the literals a loop compares with, each and one on either side
function thresholds(loop, out) {
  const w = (n) => {
    if (!isArr(n)) return
    if (NEGATE[n[0]]) for (const c of [n[1], n[2]]) { const k = constOf(c); if (k != null) { out.add(k - 1); out.add(k); out.add(k + 1) } }
    for (let i = 1; i < n.length; i++) w(n[i])
  }
  w(loop)
}

// how many times each local is written in `n`
function writesIn(n, out = new Map()) {
  if (!isArr(n)) return out
  if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') out.set(n[1], (out.get(n[1]) || 0) + 1)
  for (let i = 1; i < n.length; i++) writesIn(n[i], out)
  return out
}

/** The most passes a loop runs per entry, by the intervals `ranges` gives (wordRanges), or
 *  Infinity: a counter the loop writes once, `i = i + k` (k > 0) as a statement of its body
 *  or as a tee its one way back tests last, steps on every pass that goes round, never past
 *  the word (its sum has an interval), so a pass that goes round takes one more of the
 *  values its read holds, and one pass more may leave before the step. */
export function loopTrips(loop, ranges) {
  const label = loop[1]
  if (!isArr(loop) || loop[0] !== 'loop' || typeof label !== 'string') return Infinity
  let i = 2
  while (isArr(loop[i]) && HEADER.has(loop[i][0])) i++
  const body = loop.slice(i), last = body[body.length - 1]
  if (!isArr(last) || (last[0] !== 'br' && last[0] !== 'br_if') || last[1] !== label) return Infinity
  let backs = 0
  const count = (n) => {
    if (!isArr(n)) return
    if ((n[0] === 'br' || n[0] === 'br_if') && n[1] === label) backs++
    else if (n[0] === 'br_table' && n.includes(label)) backs += 2
    for (let j = 1; j < n.length; j++) count(n[j])
  }
  count(loop)
  if (backs !== 1) return Infinity
  // the steps: statements of the body, and a tee the way back compares
  const steps = []
  const step = (n) => isArr(n) && (n[0] === 'local.set' || n[0] === 'local.tee') && isArr(n[2]) && n[2][0] === 'i32.add' &&
    isArr(n[2][1]) && n[2][1][0] === 'local.get' && n[2][1][1] === n[1] && constOf(n[2][2]) > 0 ? n : null
  for (const s of body.slice(0, -1)) if (s?.[0] === 'local.set' && step(s)) steps.push(s)
  if (last[0] === 'br_if') {
    let c = last[last.length - 1]
    if (isArr(c) && c[0] === 'i32.eqz') c = c[1]
    if (isArr(c) && NEGATE[c[0]]) for (const o of [c[1], c[2]]) if (o?.[0] === 'local.tee' && step(o)) steps.push(o)
  }
  let trips = Infinity
  for (const s of steps) {
    if ((writesIn(loop).get(s[1]) || 0) !== 1) continue
    const r = ranges.get(s[2][1])
    if (!r || !ranges.get(s[2])) continue
    trips = Math.min(trips, Math.floor((r.hi - r.lo) / constOf(s[2][2])) + 2)
  }
  return trips
}
