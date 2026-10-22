// Loop strength reduction of a division and remainder by a loop-invariant divisor.
//
// JS `%` and `/` are float operations; with a runtime divisor even an int32
// remainder is a hardware division, 20 to 40 cycles. A dividend affine in the
// loop's unit counter (`i % w`, `~~(i / w)`, a gather's `srcIdx % up` and
// `srcIdx / up` over `const srcIdx = upIdx - k`) moves by one each pass, so its
// floored quotient and remainder do too: the remainder steps by one and wraps
// at the divisor, carrying into the quotient. The copy keeps `q` and `r` with
// `E = q * w + r`, `0 <= r < w`, seeded once before the loop and stepped at the
// end of its body (a `while` loop's after its increment), in the arms of a test
// of the wrap: a pass carries `r ± 1` alone. Each form reads what it denotes
// and no more:
//   `E % w === 0` (and `==`, `!==`, `!=`) is `r === 0`, whatever E's sign;
//   `Math.floor(E / w)` is `q`;
//   `E % w`, `(E / w) | 0`, `~~(E / w)`, `Math.trunc(E / w)` are `r` and `q`
//     where E is not negative: a test `E >= 0` dominating the read, or, for an
//     ascending E, a guard that the entry is not negative;
//   `E / w` is `q` where a test `E % w === 0` dominates it (an exact quotient).
// A form the copy cannot prove stays a division, which is exact still.
//
// The copy runs under an entry guard: a positive int32 divisor, int32 dividend
// operands (none -0), a dividend that stays an int32 over the counter's range.
// Other inputs run the loop as written, marked cold. A loop with a closure or
// a `continue` in it is left alone, as is one whose counter, divisor or operands
// the loop (or any closure of the function) writes. A plan pass ahead of the
// integral copies: they read the copy's counters, the summary its fresh names.

import { litN, loopLitVal, normalizeLoop, rewriteBlocks, freshLoopId, soleUnitInc, unitIncVar, loopHazards, closureMutatedVars } from './loop-model.js'
import { T, some, numberGuard, walkAst } from '../ast.js'
import { ctx } from '../ctx.js'
import { frameNode } from '../function.js'
import { freshId } from '../ir.js'
import { cloneWithSubst } from '../type.js'
import { collectBindings, nodeSize } from './plan/common.js'
import { invalidateBodies } from './analyze.js'
import { invalidateProgramFactsCache } from './program-facts.js'

const I32_MAX = 2147483647, I32_MIN = -2147483648
const MAX_SIZE = 800   // nodes a copy duplicates at most (plan/unswitch-loops.js's budget)
const lit = (v) => [null, v]
const and = (tests) => tests.reduce((a, b) => ['&&', a, b])
const word = (n) => ['&&', numberGuard(n), ['===', n, ['|', n, lit(0)]]]
const notNegZero = (n) => ['||', ['!==', n, lit(0)], ['>', ['/', lit(1), n], lit(0)]]
const intLit = (n) => { const v = loopLitVal(n); return v != null && Number.isInteger(v) && v >= I32_MIN && v <= I32_MAX && !Object.is(v, -0) ? v : null }
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)

// a `continue` that targets THIS loop (not one nested inside) — would skip a while loop's increment
const hasOuterContinue = (n) => Array.isArray(n) &&
  (n[0] === 'continue' || (n[0] !== 'while' && n[0] !== 'for' && n[0] !== '=>' && n.some(hasOuterContinue)))

/** The loop's facts for one candidate: its counter, the names the loop writes, invariance. */
function loopModel(L, cm) {
  // (a `for` of one statement is a list of it: the copy appends its steps)
  const body = L.kind === 'for' && Array.isArray(L.body) && L.body[0] !== ';' && L.body[0] !== '{}' ? [';', L.body] : L.body
  if (!Array.isArray(body) || body[0] !== ';') return null
  // a closure in the loop runs whenever: its captures and calls are out of view
  if (some(body, n => n[0] === '=>') || some(L.cond, n => n[0] === '=>') || some(L.step, n => n[0] === '=>')) return null
  let iv = null, ivIdx = -1
  if (L.kind === 'for') iv = L.step ? unitIncVar(L.step) : null
  else { const inc = soleUnitInc(body); if (inc) ({ iv, ivIdx } = inc) }
  // what the loop writes: its body, its test, its step (the counter's own step aside)
  const scope = [';', body, L.cond ?? lit(0), ...(L.kind === 'for' && L.step && !iv ? [L.step] : [])]
  const hz = loopHazards(cm, scope)
  const global = (n) => ctx.scope.globalTypes?.has(n) && !ctx.scope.consts?.has(n)
  const invariant = (n) => intLit(n) != null || typeof n === 'string' && n !== iv && !global(n) && !hz.mutated(n)
  if (iv && (global(iv) || cm.has(iv) || (L.kind === 'for' ? hz.mutated(iv) : loopHazards(cm, body).mutated(iv, ivIdx)))) iv = null
  // (the counters step at the end of the body, a `while`'s after its increment: a `continue` would skip them)
  if (iv && hasOuterContinue(body)) iv = null
  return { body, iv, ivIdx, invariant, hz }
}

// ── affine dividends of the counter ──

/** The direction E moves per counter step (+1 / -1), or 0: `i`, `i ± a`, `a + i`, `a - i`, a invariant. */
const affineSign = (e, M) => {
  if (e === M.iv) return 1
  if (!Array.isArray(e) || e.length !== 3) return 0
  const [op, a, b] = e
  if (op === '+' && a === M.iv && M.invariant(b)) return 1
  if (op === '+' && b === M.iv && M.invariant(a)) return 1
  if (op === '-' && a === M.iv && M.invariant(b)) return 1
  if (op === '-' && b === M.iv && M.invariant(a)) return -1
  return 0
}
/** The invariant operand of an affine E (or null for E = iv). */
const affineOperand = (e, iv) => e === iv ? null : e[1] === iv ? e[2] : e[1]

/** The constants a loop body declares as affine dividends: name → E. */
function affineConsts(M) {
  const map = new Map()
  for (let k = 1; k < M.body.length; k++) {
    const s = M.body[k]
    if (!Array.isArray(s) || s[0] !== 'const') continue
    for (let d = 1; d < s.length; d++) {
      const x = s[d]
      if (Array.isArray(x) && x[0] === '=' && typeof x[1] === 'string' && affineSign(x[2], M)) map.set(x[1], x[2])
    }
  }
  return map
}

const DIVS = new Set(['%', '/'])
/** The first `E % w` / `E / w` the body reads, E affine, w an invariant name: { key, E, w }. */
function findPair(M, consts) {
  let found = null
  walkAst(M.body, { enter: (n) => {
    if (found || n[0] === '=>') return false
    // (a module constant is a literal to the emitter, whose division by it the engine multiplies)
    if (!DIVS.has(n[0]) || n.length !== 3 || typeof n[2] !== 'string' || intLit(n[2]) != null || ctx.scope.consts?.has(n[2]) || !M.invariant(n[2])) return
    const e = typeof n[1] === 'string' && consts.has(n[1]) ? consts.get(n[1]) : n[1]
    if (affineSign(e, M)) found = { key: n[1], E: e, w: n[2] }
  } })
  return found
}

/** Conjuncts of a test (`a && b && …`). */
const conjuncts = (t, out = []) => { if (Array.isArray(t) && t[0] === '&&' && t.length === 3) { conjuncts(t[1], out); conjuncts(t[2], out) } else out.push(t); return out }
const isZero = (n) => litN(n, 0)

/** Rewrite the reads of one (E, w) pair in a loop body to its counters r and q. */
function rewritePair(body, P, r, q, baseNonneg) {
  const isKey = (n) => same(n, P.key)
  const isRem = (n) => Array.isArray(n) && n[0] === '%' && n.length === 3 && isKey(n[1]) && n[2] === P.w
  const isQuot = (n) => Array.isArray(n) && n[0] === '/' && n.length === 3 && isKey(n[1]) && n[2] === P.w
  const used = { r: false, q: false, base: false }
  // what a test proves of E where it holds: not negative, divisible by w
  const implied = (test, facts) => {
    let out = facts
    for (const t of conjuncts(test)) {
      if (!Array.isArray(t) || t.length !== 3) continue
      if ((t[0] === '>=' && isKey(t[1]) && isZero(t[2])) || (t[0] === '<=' && isZero(t[1]) && isKey(t[2]))) out = { ...out, nonneg: 'dom' }
      if ((t[0] === '===' || t[0] === '==') && ((isRem(t[1]) && isZero(t[2])) || (isZero(t[1]) && isRem(t[2])))) out = { ...out, divisible: true }
    }
    return out
  }
  const nonneg = (facts) => { if (facts.nonneg === 'base') used.base = true; return !!facts.nonneg }
  const walk = (n, facts) => {
    if (!Array.isArray(n) || n[0] === '=>') return n
    const op = n[0]
    // a remainder against zero: r === 0 whatever the sign
    if ((op === '===' || op === '==' || op === '!==' || op === '!=') && n.length === 3 &&
        ((isRem(n[1]) && isZero(n[2])) || (isZero(n[1]) && isRem(n[2])))) { used.r = true; return [op, r, lit(0)] }
    if (isRem(n) && nonneg(facts)) { used.r = true; return r }
    if (isQuot(n) && facts.divisible) { used.q = true; return q }
    if (op === '()' && n.length === 3 && isQuot(n[2]) && (n[1] === 'math.floor' || n[1] === 'math.trunc' && nonneg(facts))) { used.q = true; return q }
    if (((op === '|' && isZero(n[2]) && isQuot(n[1])) || (op === '~' && Array.isArray(n[1]) && n[1][0] === '~' && n[1].length === 2 && isQuot(n[1][1]))) && nonneg(facts)) { used.q = true; return q }
    if (op === '&&' && n.length === 3) return ['&&', walk(n[1], facts), walk(n[2], implied(n[1], facts))]
    if ((op === 'if' || op === '?:') && n.length >= 3) {
      const out = [op, walk(n[1], facts), walk(n[2], implied(n[1], facts))]
      for (let i = 3; i < n.length; i++) out.push(walk(n[i], facts))
      return out
    }
    let out = null
    for (let i = 1; i < n.length; i++) { const c = walk(n[i], facts); if (c !== n[i]) (out ??= n.slice())[i] = c }
    return out ?? n
  }
  const out = walk(body, { nonneg: baseNonneg ? 'base' : false, divisible: false })
  return { body: out, used }
}

/** E with the counter at value `at` (the dividend's range ends). */
const affineAt = (E, iv, at) => E === iv ? at : E.map((x, i) => i && x === iv ? at : x)

/** A `for` init's names: name → initializer, or null for an init of another shape. */
function initNames(init) {
  const out = new Map()
  if (init == null) return out
  if (Array.isArray(init) && (init[0] === 'let' || init[0] === 'const')) {
    for (let i = 1; i < init.length; i++) {
      const d = init[i]
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') out.set(d[1], d[2])
      else if (typeof d === 'string') out.set(d, null)
      else return null
    }
    return out
  }
  for (const x of Array.isArray(init) && init[0] === ',' ? init.slice(1) : [init]) {
    if (Array.isArray(x) && x[0] === '=' && typeof x[1] === 'string' && !out.has(x[1])) out.set(x[1], x[2])
    else return null
  }
  return out
}

function tryReduce(stmt, cm) {
  const L = normalizeLoop(stmt)
  // (a loop too large to copy twice keeps its divisions, as the loop-copying passes leave it)
  if (!L || nodeSize(stmt) > MAX_SIZE) return null
  const M = loopModel(L, cm)
  if (!M) return null
  // The guard runs before the loop: a name a `for` init declares or assigns reads there as its
  // initializer where that is a literal or a name from outside the init, else not at all.
  const inits = L.kind === 'for' ? initNames(L.init) : new Map()
  if (!inits) return null
  const atEntry = (n) => {
    if (typeof n !== 'string' || !inits.has(n)) return n
    const v = inits.get(n)
    return intLit(v) != null || typeof v === 'string' && !inits.has(v) ? v : null
  }
  const tests = [], steps = [], afterInc = [], seeds = []
  let body = M.body

  // an affine dividend of the counter: needs a `<`/`<=` test of the counter against an invariant bound
  const cond = L.cond
  const bound = M.iv && Array.isArray(cond) && (cond[0] === '<' || cond[0] === '<=') && cond[1] === M.iv && M.invariant(cond[2]) ? cond[2] : null
  const P = bound != null ? findPair(M, affineConsts(M)) : null
  const a = P && affineOperand(P.E, M.iv)
  if (P && [P.w, M.iv, bound, a].every(n => n == null || atEntry(n) != null)) {
    const s = affineSign(P.E, M)
    const id = freshLoopId(), r = `${T}lsr${id}`, q = `${T}lsq${id}`
    const res = rewritePair(body, P, r, q, s > 0)
    if (res.used.r || res.used.q) {
      body = res.body
      const w = atEntry(P.w), iv0 = atEntry(M.iv), b = atEntry(bound), a0 = atEntry(a)
      const entryE = (at) => { const e = affineAt(P.E, M.iv, at); return typeof a === 'string' ? affineAt(e, a, a0) : e }
      // the divisor a positive int32; the counter an int32, not -0, its value after the last pass an int32
      tests.push(word(w), ['>', w, lit(0)])
      if (typeof iv0 === 'string') tests.push(word(iv0), notNegZero(iv0))
      if (typeof b === 'string') tests.push(word(b))
      tests.push(['<=', b, lit(cond[0] === '<' ? I32_MAX : I32_MAX - 1)])
      if (typeof a0 === 'string') tests.push(word(a0), notNegZero(a0))
      // E stays an int32 over the counter's range: both ends, the last at the counter's final step
      for (const at of [iv0, cond[0] === '<' ? b : ['+', b, lit(1)]]) tests.push(['>=', entryE(at), lit(I32_MIN)], ['<=', entryE(at), lit(I32_MAX)])
      // floored seeds where the loop starts, r = ((E % w) + w) % w and q = (E - r) / w, exact for
      // int32 operands; each step a word's (`| 0`), exact while E stays an int32, as the guard holds
      const e0 = entryE(iv0)
      seeds.push(['=', r, res.used.base ? ['|', ['%', e0, w], lit(0)] : ['|', ['%', ['+', ['%', e0, w], w], w], lit(0)]])
      seeds.push(['=', q, ['|', ['/', ['-', e0, r], w], lit(0)]])
      // (the remainder's step tests itself, as a ring's: the sum it guards stays below w)
      const wd = (x) => ['|', x, lit(0)]
      // A branch, not a select: the step a pass carries is `r ± 1`, the wrap a test the
      // predictor answers (once in w passes); selects would carry the test and the choice too.
      const wrap = s > 0 ? [['=', r, lit(0)], ['=', q, wd(['+', q, lit(1)])]] : [['=', r, wd(['-', P.w, lit(1)])], ['=', q, wd(['-', q, lit(1)])]]
      if (!res.used.q) wrap.pop()
      const upd = [['if', s > 0 ? ['<', r, ['-', P.w, lit(1)]] : ['>', r, lit(0)],
        ['{}', [';', ['=', r, wd([s > 0 ? '+' : '-', r, lit(1)])]]], ['{}', [';', ...wrap]]]]
      if (L.kind === 'for') steps.push(...upd)
      else afterInc.push(...upd)
      if (res.used.base) tests.push(['>=', e0, lit(0)])
    }
  }
  if (!tests.length) return null

  // the copy: what it declares (a `for` init's declarations too) under names of its own
  // (a `for` keeps its header as written, the form its counter's range is read from:
  // the seeds go before it, from the counter's entry value, the steps end its body)
  const b = afterInc.length ? [';', ...body.slice(1, M.ivIdx + 1), ...afterInc, ...body.slice(M.ivIdx + 1)] : steps.length ? [...body, ...steps] : body
  let fast = [';', ...(seeds.length ? [['let', ...seeds]] : []), L.kind === 'while' ? ['while', L.cond, b] : ['for', L.init, L.cond, L.step, b]]
  const own = new Set()
  collectBindings(fast, own)
  fast = cloneWithSubst(fast, new Map(), new Map([...own].map(n => [n, `${n}${T}dm${freshId(ctx)}`])))
  // (the loop as written runs for the values the guard rejects: cold, with every loop in it)
  walkAst(stmt, { enter: (n) => { if (n[0] === '=>') return false; if (n[0] === 'for' || n[0] === 'while' || n[0] === 'do') { n.cold = true; const b = n[n[0] === 'for' ? 4 : n[0] === 'while' ? 2 : 1]; if (Array.isArray(b)) b.cold = true } } })
  return [['if', and(tests), ['{}', fast], stmt]]
}

/** Strength-reduce the loops of every function body (a plan pass: the summary reads the copies' fresh names). */
export function strengthReduceLoopDivMod() {
  if (ctx.transform.optimize?.loopIVDivMod === false) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    const cm = closureMutatedVars(frameNode(func))
    const body = rewriteBlocks(func.body, stmt => tryReduce(stmt, cm))
    if (body === func.body) continue
    invalidateProgramFactsCache(func.body)
    invalidateBodies([func.body])
    func.body = body
    changed = true
  }
  return changed
}
