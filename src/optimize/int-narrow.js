// Integer registers for integer values.
//
// A number that holds an integer is an f64 wherever its range was unknown when
// its local was typed: an element index `f * 3` may pass 2^31, the difference
// `table[slot] - 1` may fall below -2^31, a counter may start from a
// parameter. Every index it reaches then converts, its remainder divides in
// floating point (`x - trunc(x / 3) * 3`), and a comparison with an element
// converts the element.
//
// Below 2^53 the integers are exact in f64, so a sum, difference or product of
// integers that stays within 2^52 is the same number computed in i64, its
// remainder by a constant is `rem_s`, its quotient under a truncation is
// `div_s`, and a comparison of two such values compares the integers. The pass
// reads each value's interval (optimize/int-range.js), carries an f64 local in
// an i32 or an i64 when every write of it is such an integer, and computes the
// integer form of each expression an integer consumer reads: a truncation, a
// comparison with another integer, a write of a narrowed local. A test the
// intervals decide (the NaN test of an integer, the boxed-value test of a
// number) folds to its answer.
//
// A narrowed local reads through a conversion wherever f64 code reads it, so a
// local narrows only when it removes more conversions than it adds, weighted
// by loop depth. A value that may be -0 narrows only when nothing can see the
// sign of its zero: every read is an integer consumer's.

import { intRanges, isInt, fitsI32, remainderOf, quotientOf, pure, plainNaN, conditional, KIND, LIMIT } from './int-range.js'
import { int32 } from '../static.js'

const isArr = Array.isArray
const RESULT = n => isArr(n) && n[0] === 'result' ? n[1] : null
const copy = n => Object.assign([], n)
const CMP = { 'f64.eq': 'eq', 'f64.ne': 'ne', 'f64.lt': 'lt_s', 'f64.le': 'le_s', 'f64.gt': 'gt_s', 'f64.ge': 'ge_s' }
const TEST = new Set([...Object.keys(CMP), 'i64.eq', 'i64.ne', 'i32.eq', 'i32.ne', 'i32.eqz', 'i32.lt_s', 'i32.le_s', 'i32.gt_s', 'i32.ge_s', 'i32.lt_u', 'i32.le_u', 'i32.gt_u', 'i32.ge_u'])
const ARITH = { 'f64.add': 'add', 'f64.sub': 'sub', 'f64.mul': 'mul' }
const ROUND = new Set(['f64.floor', 'f64.ceil', 'f64.trunc', 'f64.nearest'])
const TRUNC = new Set(['i64.trunc_sat_f64_s', 'i32.trunc_sat_f64_s', 'i32.trunc_sat_f64_u'])
const DIVISION = 8   // what a floating division costs beside a conversion

// The value positions of a conditional or a block with a result.
const shape = n => {
  let i = 1
  if (typeof n[i] === 'string') i++
  if (RESULT(n[i]) == null) return null
  const resultAt = i++
  if (n[0] === 'if') {
    const then = n[i + 1], els = n[i + 2]
    if (!isArr(then) || then[0] !== 'then' || then.length < 2 || !isArr(els) || els[0] !== 'else' || els.length < 2) return null
    return { resultAt, arms: [[then, then.length - 1], [els, els.length - 1]] }
  }
  return n[0] === 'block' && n.length > i ? { resultAt, arms: [[n, n.length - 1]] } : null
}
// A NaN constant, a number's or a box's: what a truncation takes to zero.
const nanConst = n => isArr(n) && n[0] === 'f64.const' && (plainNaN(n) || (typeof n[1] === 'number' && Number.isNaN(n[1])) || (typeof n[1] === 'string' && /^[-+]?nan/.test(n[1])))

const declsOf = fn => {
  let bodyStart = 2
  const decls = new Map()
  for (; bodyStart < fn.length; bodyStart++) {
    const d = fn[bodyStart]
    if (!isArr(d) || (d[0] !== 'param' && d[0] !== 'local' && d[0] !== 'result' && d[0] !== 'export' && d[0] !== 'type')) break
    if (d[0] === 'local' && typeof d[1] === 'string' && d[2] === 'f64') decls.set(d[1], d)
  }
  return { bodyStart, decls }
}

/**
 * Which f64 locals of `fn` hold integers, and how their reads are consumed:
 *   facts   the intervals (int-range.js)
 *   N       local → 'i32' | 'i64', the locals worth narrowing
 *   early   the locals of N that hold a truncation taken where they are written
 *   use     (ancestors, read) → 'int' | 'f64' | 'gone'
 * or null when the intervals could not be read. `only` limits the locals
 * considered.
 */
export function integerPlan(fn, assume = null, regions = null) {
  const { bodyStart, decls } = declsOf(fn)
  const facts = intRanges(fn, bodyStart, assume, regions)
  if (!facts) return null
  const { av, writes, reads, loops } = facts
  const at = n => av.get(n) ?? null
  const whole = n => isInt(at(n))

  // The integer-valued locals: every write the walk reached is an integer. A
  // local every read of which is truncated on the spot holds the truncation
  // instead (`early`): the quotient temp of `(x / 3) | 0`.
  const N = new Map(), early = new Set()
  const bounded = v => !!v && (v.lo > v.hi || (v.lo >= -LIMIT && v.hi <= LIMIT))
  const truncation = v => v && { lo: Math.min(Math.trunc(v.lo), v.nan ? 0 : Infinity), hi: Math.max(Math.trunc(v.hi), v.nan ? 0 : -Infinity), int: true, nz: false, nan: false }
  // A test the intervals decide reads nothing: it folds to its answer.
  const decided = (chain) => {
    const p = chain[chain.length - 1], t = p?.[0] === 'i64.reinterpret_f64' ? chain[chain.length - 2] : p
    const v = t && at(t)
    return !!v && v.lo === v.hi && TEST.has(t[0]) && pure(t)
  }
  const truncatedOnly = name => (reads.get(name) ?? []).every(([r, chain]) => {
    const p = chain[chain.length - 1]
    if (p && p[1] === r && (p[0] === 'i64.trunc_sat_f64_s' || (p[0] === 'i32.trunc_sat_f64_s' && fitsI32(truncation(at(r)))))) return true
    return r[0] === 'local.get' && decided(chain)
  })
  for (const [name] of decls) {
    const ws = writes.get(name)
    if (!ws?.length) continue
    if (!ws.every(w => whole(w[2]))) {
      if (!ws.every(w => bounded(at(w[2]))) || !reads.get(name)?.length || !truncatedOnly(name)) continue
      early.add(name)
    }
    N.set(name, ws.every(w => fitsI32(truncation(at(w[2])))) ? 'i32' : 'i64')
  }

  // A use inside a loop runs more often: each level weighs four times the one around it.
  const weight = d => 4 ** Math.min(d, 4)
  const depth = chain => weight(chain.reduce((d, p) => d + (p[0] === 'loop'), 0))
  // How an integer reads: what its consumer is, found through the integer
  // operators above it. `int` consumers take the integer form; a `gone` read
  // disappears with its test or with the repeat of a remainder's dividend.
  const use = (chain, node) => {
    if (decided(chain)) return 'gone'
    if (early.has(node[1])) return 'int'
    let child = node
    for (let i = chain.length - 1; i >= 0; i--) {
      const p = chain[i], op = p[0]
      if (TRUNC.has(op)) return 'int'
      if (op in CMP) return whole(p[1] === child ? p[2] : p[1]) ? 'int' : 'f64'
      if (op === 'local.set' || op === 'local.tee') {
        // (a copy kept of the local is carried as the local is)
        if (p[2] === child && decls.get(p[1])?.copyOf === node[1] && child === node) return 'gone'
        return p[2] === child && N.has(p[1]) ? 'int' : 'f64'
      }
      if (op === 'f64.copysign') {
        if (!remainderOf(p)) return 'f64'
        if (p[2] === child) return 'gone'
        if (!whole(p)) return 'f64'
        child = p
        continue
      }
      if (op === 'f64.sub' && chain[i - 1]?.[0] === 'f64.copysign' && chain[i - 1][1] === p && remainderOf(chain[i - 1])) {
        if (p[1] !== child) return 'gone'   // under the product: a repeat of the dividend
        child = p
        continue
      }
      if (op === 'f64.div') {
        const t = chain[i - 1]
        if (p[1] !== child || !t) return 'f64'
        if (t[0] === 'f64.trunc' && chain[i - 2]?.[0] === 'f64.mul' && chain[i - 3]?.[0] === 'f64.sub' && remainderOf(chain[i - 4])) return 'gone'
        if (!quotientOf(['f64.trunc', p]) || !whole(child)) return 'f64'
        if (TRUNC.has(t[0])) return 'int'
        if (t[0] !== 'f64.trunc' || !whole(t)) return 'f64'
        child = t; i--
        continue
      }
      if ((op in ARITH || op === 'f64.neg' || op === 'f64.abs' || op === 'f64.min' || op === 'f64.max' || ROUND.has(op)) && whole(p)) { child = p; continue }
      if (op === 'select' && p.length === 4 && (p[1] === child || p[2] === child) && whole(p)) { child = p; continue }
      if ((op === 'then' || op === 'else') && p[p.length - 1] === child) { child = p; continue }
      const s = (op === 'if' || op === 'block') && shape(p)
      if (s && p[s.resultAt][1] === 'f64' && whole(p) && s.arms.some(([c]) => c === child || c[c.length - 1] === child)) { child = p; continue }
      return 'f64'
    }
    return 'f64'
  }
  // What the integer form of a value does to its conversions: `gain` counts
  // the ones it removes (an integer converted to f64, a floating division as
  // several), `cost` the truncations it adds (a value that stays f64), `held`
  // the narrowed locals it reads, which the f64 form would convert.
  const tally = (v, t = { gain: 0, cost: 0, held: 0 }) => {
    if (!isArr(v)) return t
    const op = v[0]
    if (op === 'f64.const') return t
    if (op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u' || op === 'f64.convert_i64_s') { t.gain++; return t }
    if (op === 'local.get') { if (N.has(v[1])) t.held++; else t.cost++; return t }
    if (op === 'local.tee') { if (N.has(v[1])) { t.held++; return tally(v[2], t) } t.cost++; return t }
    const q = quotientOf(v)
    if (q && whole(q.x)) { t.gain += DIVISION; return tally(q.x, t) }
    if (!whole(v)) { t.cost++; return t }
    const r = remainderOf(v)
    if (r && whole(r.x)) { t.gain += DIVISION; return tally(r.x, t) }
    if (op in ARITH || op === 'f64.min' || op === 'f64.max') return whole(v[1]) && whole(v[2]) ? tally(v[2], tally(v[1], t)) : (t.cost++, t)
    if (op === 'f64.neg' || op === 'f64.abs' || ROUND.has(op)) return whole(v[1]) ? tally(v[1], t) : (t.cost++, t)
    if (op === 'select' && v.length === 4) {
      // (one the intervals decide is the operand it takes)
      const c = at(v[3])
      if (c && c.lo === c.hi && pure(v[3]) && pure(c.lo ? v[2] : v[1])) return tally(c.lo ? v[1] : v[2], t)
      return whole(v[1]) && whole(v[2]) ? tally(v[2], tally(v[1], t)) : (t.cost++, t)
    }
    const s = (op === 'if' || op === 'block') && shape(v)
    if (s && v[s.resultAt][1] === 'f64' && s.arms.every(([c, k]) => whole(c[k]))) { for (const [c, k] of s.arms) tally(c[k], t); return t }
    t.cost++
    return t
  }
  // What an early truncation holds: the quotient of a division by a constant
  // is a value of its own, any other fraction truncates where it is written.
  const held = v => whole(v) ? v : v[0] === 'f64.div' && quotientOf(['f64.trunc', v]) && whole(v[1]) ? ['f64.trunc', v] : v
  const zero = name => !early.has(name) && writes.get(name).some(w => at(w[2]).nz)
  const score = name => {
    let n = 0, floats = false
    // a narrowed local a write reads converts unless this one narrows too
    // (a copy made where a read leaves a specialized loop runs once: it
    // counts for the sign of a zero it would show, not for its conversion)
    for (const w of writes.get(name)) { if (w.cold) continue; const t = tally(held(w[2])); n += (t.gain + t.held - t.cost) * weight(loops.get(w) ?? 0) }
    for (const [r, chain] of reads.get(name) ?? []) {
      const u = use(chain, r)
      if (r.cold) { if (u === 'f64') floats = true; continue }
      if (u === 'f64') { n -= depth(chain); floats = true } else if (u === 'int') n += depth(chain)
    }
    return floats && zero(name) ? -Infinity : n
  }
  for (let changed = true; changed;) {
    changed = false
    for (const [name] of N) {
      if (score(name) > 0) continue
      N.delete(name)
      early.delete(name)
      changed = true
    }
  }
  // A copy of a narrowed local (the value a specialized loop keeps of it at the
  // top of an iteration) is carried as the local is.
  for (const [name, d] of decls) if (d.copyOf != null && N.has(d.copyOf) && !early.has(d.copyOf) && writes.get(name)?.every(w => w[2][0] === 'local.get' && w[2][1] === d.copyOf)) N.set(name, N.get(d.copyOf))
  return { bodyStart, decls, facts, N, early, use, tally, held, score, at, whole }
}

/** Carry the integer-valued f64 locals of `fn` in integer registers. `assume`
 *  is the entry facts of specialized loops (int-range.js). Returns whether the
 *  function changed. */
export function narrowInts(fn, assume = null) {
  if (!isArr(fn) || fn[0] !== 'func') return false
  const plan = integerPlan(fn, assume)
  if (!plan) return false
  const { bodyStart, decls, facts, N, early, tally, held, at, whole } = plan
  const { av } = facts

  // Temporaries of the integer forms (the two operands of a minimum).
  let next = 0
  for (let i = 2; i < bodyStart; i++) {
    const m = isArr(fn[i]) && typeof fn[i][1] === 'string' && /^\$__in(\d+)$/.exec(fn[i][1])
    if (m) next = Math.max(next, +m[1] + 1)
  }
  const temps = []
  const temp = type => { const name = `$__in${next++}`; temps.push(['local', name, type]); return name }
  let did = false

  const widthOf = (...es) => es.every(e => fitsI32(at(e))) ? 'i32' : 'i64'
  const as = (node, from, to) => from === to ? node : to === 'i64' ? ['i64.extend_i32_s', node] : ['i32.wrap_i64', node]
  const konst = (c, w) => w === 'i32' ? ['i32.const', int32(c)] : ['i64.const', String(c + 0)]
  // The truncation of a value that stays f64: exact, the value is an integer.
  const truncated = (node, w) => w === 'i64' ? ['i64.trunc_sat_f64_s', node] : ['i32.wrap_i64', ['i64.trunc_sat_f64_s', node]]
  const divisor = (x, k) => widthOf(x) === 'i32' && Math.abs(k) < 2 ** 31 ? 'i32' : 'i64'
  const answered = n => { const c = at(n); return c && c.lo === c.hi && pure(n) ? c.lo : null }

  /** The integer form of `e` in width `w`: the value when it fits, its low
   *  word otherwise (sums and products keep the low word). `e` is an integer
   *  within 2^52; under a truncation (`zero`) it may also be a conditional
   *  with a NaN arm, which truncates to 0. */
  const I = (e, w, zero = false) => {
    const op = e[0]
    if (op === 'f64.const') return zero && nanConst(e) ? konst(0, w) : konst(e[1], w)
    if (op === 'f64.convert_i32_s') return as(F(e[1]), 'i32', w)
    if (op === 'f64.convert_i32_u') return w === 'i32' ? F(e[1]) : ['i64.extend_i32_u', F(e[1])]
    if (op === 'f64.convert_i64_s') return as(F(e[1]), 'i64', w)
    if (op === 'local.get') return N.has(e[1]) ? as(e, N.get(e[1]), w) : truncated(e, w)
    if (op === 'local.tee') {
      if (!N.has(e[1])) return truncated(F(e), w)
      const t = copy(e)
      t[2] = I(early.has(e[1]) ? held(e[2]) : e[2], N.get(e[1]))
      return as(t, N.get(e[1]), w)
    }
    if (op === 'select' && e.length === 4) {
      const c = answered(e[3])
      if (c != null && pure(c ? e[2] : e[1])) return I(c ? e[1] : e[2], w, zero)
      if ([e[1], e[2]].every(a => whole(a) || (zero && nanConst(a)))) return ['select', I(e[1], w, zero), I(e[2], w, zero), F(e[3])]
      return truncated(F(e), w)
    }
    const s = (op === 'if' || op === 'block') && shape(e)
    if (s && e[s.resultAt][1] === 'f64' && s.arms.every(([c, k]) => whole(c[k]) || (zero && (nanConst(c[k]) || integral(c[k]))))) return retype(e, s, w, zero)
    const q = quotientOf(e)
    if (q && whole(q.x)) { const x = divisor(q.x, q.k); return as([x + '.div_s', I(q.x, x), konst(q.k, x)], x, w) }
    if (!whole(e)) return truncated(F(e), w)
    // `i++` as a value, written as the step taken back: the local as it was,
    // stepped behind it.
    const p = stepped(e)
    if (p) {
      const x = N.get(p.name), t = temp(x)
      return as(['block', ['result', x], ['local.set', p.name, [x + '.add', ['local.tee', t, ['local.get', p.name]], konst(p.by, x)]], ['local.get', t]], x, w)
    }
    const r = remainderOf(e)
    if (r && whole(r.x) && r.again.every(pure)) { const x = divisor(r.x, r.k); return as([x + '.rem_s', I(r.x, x), konst(r.k, x)], x, w) }
    if (op in ARITH) return whole(e[1]) && whole(e[2]) ? [w + '.' + ARITH[op], I(e[1], w), I(e[2], w)] : truncated(F(e), w)
    if (ROUND.has(op)) return whole(e[1]) ? I(e[1], w) : truncated(F(e), w)
    if (op === 'f64.neg' && whole(e[1])) { const x = widthOf(e, e[1]); return as([x + '.sub', konst(0, x), I(e[1], x)], x, w) }
    if (op === 'f64.abs' && whole(e[1])) {
      const x = widthOf(e, e[1]), t = temp(x)
      return as(['select', ['local.tee', t, I(e[1], x)], [x + '.sub', konst(0, x), ['local.get', t]], [x + '.ge_s', ['local.get', t], konst(0, x)]], x, w)
    }
    if ((op === 'f64.min' || op === 'f64.max') && whole(e[1]) && whole(e[2])) {
      const x = widthOf(e[1], e[2]), a = temp(x), b = temp(x)
      return as(['select', ['local.tee', a, I(e[1], x)], ['local.tee', b, I(e[2], x)],
        [x + (op === 'f64.min' ? '.lt_s' : '.gt_s'), ['local.get', a], ['local.get', b]]], x, w)
    }
    return truncated(F(e), w)
  }
  // `(x = x + k) - k` over a narrowed local, k a constant: { name, by }.
  const stepped = e => {
    const tee = e[1], step = tee?.[2]
    if ((e[0] !== 'f64.sub' && e[0] !== 'f64.add') || e.length !== 3 || tee?.[0] !== 'local.tee' || !N.has(tee[1]) || early.has(tee[1])) return null
    if ((step?.[0] !== 'f64.sub' && step?.[0] !== 'f64.add') || step[0] === e[0] || step[1]?.[0] !== 'local.get' || step[1][1] !== tee[1]) return null
    if (step[2]?.[0] !== 'f64.const' || e[2]?.[0] !== 'f64.const' || typeof step[2][1] !== 'number' || step[2][1] !== e[2][1] || !Number.isInteger(e[2][1])) return null
    return whole(tee) && whole(step[1]) ? { name: tee[1], by: step[0] === 'f64.add' ? e[2][1] : -e[2][1] } : null
  }
  // A conditional whose every arm is an integer or a NaN: what a truncation reads as an integer.
  const integral = e => {
    if (!isArr(e)) return false
    if (whole(e) || nanConst(e)) return true
    if (e[0] === 'select' && e.length === 4) return integral(e[1]) && integral(e[2])
    const s = (e[0] === 'if' || e[0] === 'block') && shape(e)
    return !!s && e[s.resultAt][1] === 'f64' && s.arms.every(([c, k]) => integral(c[k]))
  }
  const retype = (n, s, w, zero) => {
    const out = copy(n)
    out[s.resultAt] = ['result', w]
    const arms = new Map(s.arms.map(([c, k]) => [c, k]))
    for (let i = s.resultAt + 1; i < out.length; i++) {
      const c = n[i]
      if (arms.has(c) && c !== n) {
        const arm = out[i] = copy(c), k = arms.get(c)
        for (let j = 1; j < arm.length; j++) arm[j] = j === k ? I(c[j], w, zero) : F(c[j])
      } else out[i] = n === s.arms[0][0] && i === s.arms[0][1] ? I(c, w, zero) : F(c)
    }
    return out
  }

  // Whether an integer consumer's operands cost no more conversions in their
  // integer form: a truncation is itself one the f64 form pays.
  const takes = (...es) => {
    const t = { gain: 0, cost: 0, held: 0 }
    for (const e of es) tally(e, t)
    return t.cost <= t.gain + t.held + (es.length === 1 ? 1 : 0)
  }
  const heldRead = e => isArr(e) && (e[0] === 'local.get' || e[0] === 'local.tee') && early.has(e[1])
  // The operand of a truncation in its integer form, or null: an integer, a
  // quotient, or a conditional of integers and NaN.
  // `to` is the consumer: 'i64', 'i32' (saturating: the value must fit) or
  // 'low' (the low word of the i64 truncation).
  const truncates = (e, to) => {
    if (!isArr(e)) return null
    const w = to === 'low' ? 'i32' : to
    if (heldRead(e)) return I(e, w)
    if (whole(e)) return (to !== 'i32' || fitsI32(at(e))) && takes(e) ? I(e, w) : null
    const q = e[0] === 'f64.div' && quotientOf(['f64.trunc', e])
    if (q && whole(q.x)) {
      const v = at(q.x)
      if (to === 'i32' && !(Math.abs(v.lo / q.k) < 2 ** 31 && Math.abs(v.hi / q.k) < 2 ** 31)) return null
      const x = divisor(q.x, q.k)
      return as([x + '.div_s', I(q.x, x), konst(q.k, x)], x, w)
    }
    if (to !== 'i32' && integral(e) && !nanConst(e)) return I(e, w, true)
    return null
  }

  /** `n` in its own type: integer consumers read integer forms, a narrowed
   *  local converts where f64 code reads it. */
  const F = n => {
    if (!isArr(n)) return n
    const op = n[0]
    if (op === 'local.get' && N.has(n[1])) return [N.get(n[1]) === 'i32' ? 'f64.convert_i32_s' : 'f64.convert_i64_s', n]
    if ((op === 'local.set' || op === 'local.tee') && N.has(n[1])) {
      const w = copy(n)
      w[2] = I(early.has(n[1]) ? held(n[2]) : n[2], N.get(n[1]))
      did = true
      return op === 'local.tee' ? [N.get(n[1]) === 'i32' ? 'f64.convert_i32_s' : 'f64.convert_i64_s', w] : w
    }
    // A test the intervals decide.
    if (TEST.has(op) && av.has(n)) { const c = answered(n); if (c != null) { did = true; return ['i32.const', c] } }
    // A conditional whose test they decide is the arm it takes, after what
    // the test does on its way (a local it sets).
    if (op === 'if') {
      const { test, then, otherwise } = conditional(n), v = test && at(test)
      if (v && v.lo === v.hi && !v.of && (!then || then[0] === 'then') && (!otherwise || otherwise[0] === 'else')) {
        const arm = v.lo ? then : otherwise, out = ['block']
        for (let i = 1; n[i] !== test; i++) out.push(n[i])   // its label, its result
        if (!pure(test)) out.push(['drop', F(test)])
        if (arm) for (let i = 1; i < arm.length; i++) out.push(F(arm[i]))
        did = true
        return out
      }
    }
    // What the runtime answers about a number: it is no key, no missing value
    // and no object, and two numbers are equal as numbers are.
    if (op === 'call' && n.length === 3 && typeof n[1] === 'string' && KIND.test(n[1]) && at(n)?.hi === 0) {
      did = true
      return pure(n[2]) ? ['i32.const', 0] : ['block', ['result', 'i32'], ['drop', F(n[2])], ['i32.const', 0]]
    }
    if (op === 'call' && n[1] === '$__eq_strict' && n.length === 4 && at(n[2])?.of && at(n[3])?.of && at(n[2]).mask == null && at(n[3]).mask == null) {
      did = true
      return ['f64.eq', ['f64.reinterpret_i64', F(n[2])], ['f64.reinterpret_i64', F(n[3])]]
    }
    if (op === 'select' && n.length === 4) {
      const c = answered(n[3])
      if (c != null && pure(c ? n[2] : n[1])) { did = true; return F(c ? n[1] : n[2]) }
    }
    if ((op === 'i32.and' || op === 'i32.or') && n.length === 3) {
      // One side of a conjunction of tests decided: the other is the answer,
      // or nothing is left to ask. (The operators are bitwise: a side that is
      // not 0 or 1 is a word, not an answer.)
      const test = e => { const v = at(e); return !!v && v.lo >= 0 && v.hi <= 1 }
      for (const [k, o] of [[1, 2], [2, 1]]) {
        const c = answered(n[k])
        if (c !== 0 && c !== 1) continue
        if (c === (op === 'i32.and' ? 0 : 1)) { if (pure(n[o]) && (c === 0 || test(n[o]))) { did = true; return ['i32.const', c] } }
        else if (c === 0 || test(n[o])) { did = true; return F(n[o]) }
      }
    }
    if (op === 'i32.wrap_i64' && n[1]?.[0] === 'i64.trunc_sat_f64_s') { const v = truncates(n[1][1], 'low'); if (v) { did = true; return v } }
    if (op === 'i64.trunc_sat_f64_s') { const v = truncates(n[1], 'i64'); if (v) { did = true; return v } }
    if (op === 'i32.trunc_sat_f64_s') { const v = truncates(n[1], 'i32'); if (v) { did = true; return v } }
    if (op === 'i32.trunc_sat_f64_u' && fitsI32(at(n[1])) && at(n[1]).lo >= 0 && takes(n[1])) { did = true; return I(n[1], 'i32') }
    if (op in CMP && whole(n[1]) && whole(n[2]) && takes(n[1], n[2])) {
      const x = widthOf(n[1], n[2])
      did = true
      return [x + '.' + CMP[op], I(n[1], x), I(n[2], x)]
    }
    // A remainder f64 code reads: the integers' remainder, converted, under
    // the sign of the dividend (the zero of a negative dividend is -0).
    const r = op === 'f64.copysign' && remainderOf(n)
    if (r && whole(r.x) && r.again.every(pure)) {
      const x = divisor(r.x, r.k), v = at(r.x), conv = x === 'i32' ? 'f64.convert_i32_s' : 'f64.convert_i64_s'
      did = true
      if (v.lo >= 0 && !v.nz) return [conv, [x + '.rem_s', I(r.x, x), konst(r.k, x)]]
      const t = temp(x)
      return ['f64.copysign', [conv, [x + '.rem_s', ['local.tee', t, I(r.x, x)], konst(r.k, x)]], [conv, ['local.get', t]]]
    }
    const out = copy(n)
    for (let i = 1; i < out.length; i++) out[i] = F(out[i])
    return out
  }

  const body = []
  for (let i = bodyStart; i < fn.length; i++) body.push(F(fn[i]))
  if (!did && !N.size) return false
  for (let i = bodyStart; i < fn.length; i++) fn[i] = body[i - bodyStart]
  for (const [name, w] of N) decls.get(name)[2] = w
  if (temps.length) fn.splice(bodyStart, 0, ...temps)
  return true
}
