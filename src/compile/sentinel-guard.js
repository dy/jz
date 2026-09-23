/**
 * Sentinel guards: one range test where only a data sentinel bounds a cursor.
 *
 * The lower envelope pops its hull cursor while a comparison holds
 * (`while (s <= z[k]) { k--; … v[k] … }`); nothing but the `z[0] = −∞`
 * sentinel keeps `k` from −1, so no static proof bounds the reads at the pop.
 * A scan cursor stops at the `+∞` above the hull (`while (z[k + 1] < q) k++`),
 * and the read after the scan (`v[k]`) is bounded by that sentinel alone.
 * Each such read stays checked, and its Number-or-undefined result keeps the
 * value in an f64 carrier through the arithmetic and any dependent index.
 *
 * A guard versions the code on the cursor's range, tested once per pass:
 *   - a loop whose test reads at the cursor:
 *       while (C) B   →   while (G && C′) B′; if (!G) while (C) B
 *     The fast loop runs while the cursor stays in range; when it leaves the
 *     range at a test, the original loop finishes from that same state.
 *   - the rest of a block, after the statement that moves the cursor:
 *       S   →   if (G) S′ else S
 * G tests only the bounds a read's proof lacked (the interval proof's hull
 * of each unproven access). C′, B′, S′ are copies whose declared names are
 * fresh: the interval proof proves their reads under G (an access node
 * carries its own occurrence's proof), they keep their own local types, and
 * the originals keep their checks for the rare pass that leaves the range.
 *
 * The cursor `c` is a function local the program never captures, and the
 * reads are indexed `c`, `c ± k` or `k + c` on a receiver of known length:
 *   the loop form: a `while` without a label, `break` or `continue` of its
 *     own that declares no `c`, whose test reads at `c`, never writes it and
 *     counts nothing (no relational conjunct on a name the body steps); body
 *     reads count up to the first write of `c` that is not a constant step
 *     (`c--`, `c += 2`, `c = c - 1`);
 *   the suffix form: a block whose statement before the suffix moves `c` by
 *     constant steps only, and whose suffix never writes it; the copied reads
 *     may sit in nested loops.
 * A counted loop and a computed index (`let i = y * w + x`) are loop-entry
 * versioning's (type/loop-versioning.js): one test per loop entry, not per
 * pass. Neither form copies a closure. Reads inside a loop form's original
 * loop (the slow path) stay as they are. Off at the size tier: every guard
 * duplicates code.
 *
 * @module compile/sentinel-guard
 */
import { ctx } from '../ctx.js'
import { walkAst, some, isReassigned, collectAllBoundNames, stmtList, hasOwnBreakOrContinue, MUTATE_OPS, T } from '../ast.js'
import { freshId } from '../ir.js'
import { intLiteralValue } from '../static.js'
import { cloneWithSubst } from '../type/clone.js'
import { intervalMisses } from '../type/interval-proof.js'
import { invalidateRewrittenBody } from './analyze/body-facts.js'
import { withBodyTypedFacts } from './flow-state.js'

const isArr = Array.isArray
const LOOPS = new Set(['for', 'while', 'do', 'for-of', 'for-in'])
const REL = new Set(['<', '<=', '>', '>='])
const num = (v) => [null, v]

/** An index `c`, `c + k`, `c - k` or `k + c` as [c, k]; null otherwise. */
const cursorIndex = (e) => {
  if (typeof e === 'string') return [e, 0]
  if (!isArr(e) || e.length !== 3) return null
  if ((e[0] === '+' || e[0] === '-') && typeof e[1] === 'string') {
    const k = intLiteralValue(e[2])
    return k == null ? null : [e[1], e[0] === '+' ? k : -k]
  }
  if (e[0] === '+' && typeof e[2] === 'string') {
    const k = intLiteralValue(e[1])
    return k == null ? null : [e[2], k]
  }
  return null
}

/** The constant step a node moves `c` by (`c++`, `--c`, `c += 2`, `c = c - 1`), or null. */
const stepOf = (s, c) => {
  if (!isArr(s) || s[1] !== c) return null
  if (s[0] === '++') return 1
  if (s[0] === '--') return -1
  if (s[0] === '+=' || s[0] === '-=') { const k = intLiteralValue(s[2]); return k == null ? null : s[0] === '+=' ? k : -k }
  if (s[0] === '=' && isArr(s[2]) && (s[2][0] === '+' || s[2][0] === '-') && s[2][1] === c) {
    const k = intLiteralValue(s[2][2]); return k == null ? null : s[2][0] === '+' ? k : -k
  }
  return null
}

/** Whether `n` writes or declares `c`. */
const writes = (n, c) => isReassigned(n, c) || collectAllBoundNames(n).has(c)

/** Whether `n` moves `c`, by constant steps only. */
const stepsOnly = (n, c) => isReassigned(n, c) && !collectAllBoundNames(n).has(c)
  && !some(n, x => MUTATE_OPS.has(x[0]) && x[1] === c && stepOf(x, c) == null)

/** The `&&` conjuncts of a test. */
const conjuncts = (c) => isArr(c) && c[0] === '&&' ? c.slice(1).flatMap(conjuncts) : [c]

/** Whether a conjunct of `cond` compares a name `body` steps: a counted loop. */
const counted = (cond, body) => conjuncts(cond).some(t => isArr(t) && REL.has(t[0])
  && [t[1], t[2]].some(x => typeof x === 'string' && some(body, y => stepOf(y, x) != null)))

/** Typed accesses directly in `n` (not in closures, and not in nested loops unless `deep`). */
const accessesIn = (n, deep, out = []) => {
  walkAst(n, { enter: (x) => {
    if (x[0] === '=>' || (!deep && x !== n && LOOPS.has(x[0]))) return false
    if (x[0] === '[]' && x.length === 3 && typeof x[1] === 'string') out.push(x)
  } })
  return out
}

/** A copy of `nodes` whose `let`/`const` names are fresh (a `var` outlives its block). */
const copyFresh = (nodes) => {
  const names = new Set()
  for (const n of nodes) walkAst(n, { enter: (x) => { if (x[0] === 'let' || x[0] === 'const') collectAllBoundNames(x, names) } })
  const rename = new Map([...names].map(name => [name, `${T}sg${freshId(ctx)}_${name}`]))
  return nodes.map(n => cloneWithSubst(n, new Map(), rename))
}

/** The test `c` against [lo, hi]; a missing bound is not tested. */
const guardOf = (c, lo, hi) => {
  const tests = []
  if (lo != null) tests.push(['>=', c, num(lo)])
  if (hi != null) tests.push(['<=', c, num(hi)])
  return tests.length === 2 ? ['&&', ...tests] : tests[0]
}

/**
 * Guard the sentinel-bounded cursor reads of `body` the interval proof left
 * unproven; `facts` is the body analysis (its local typed receivers and
 * lengths). Returns whether the body changed.
 */
export function guardSentinels(body, facts = null) {
  if (!isArr(body)) return false
  const misses = withBodyTypedFacts(facts, () => intervalMisses(ctx, body))
  if (!misses.size) return false
  const guardable = (c) => typeof c === 'string' && ctx.func.locals?.has(c) && !ctx.func.boxed?.has(c)
    && !some(body, x => x[0] === '=>' && isReassigned(x, c))
  /** The unproven cursor `c` of access `a`, if guardable. */
  const cursorOf = (a) => {
    const ci = misses.has(a) ? cursorIndex(a[2]) : null
    return ci && guardable(ci[0]) ? ci[0] : null
  }
  // The bounds the reads in `accs` need for `c` at the point where `delta(acc)`
  // is the access's offset from that point: [lo, hi] with null for a bound
  // the proof already has, or null when no read of `c` is unproven.
  const needs = (accs, c, delta) => {
    let lo = null, hi = null, any = false
    for (const a of accs) {
      const m = misses.get(a), ci = m ? cursorIndex(a[2]) : null
      if (!m || !ci || ci[0] !== c) continue
      const d = delta(a)
      if (d == null) continue
      const off = d + ci[1], L = m[2]
      if (m[0] == null || m[0] < 0) { lo = lo == null ? -off : Math.max(lo, -off); any = true }
      if (m[1] == null || m[1] > L - 1) { hi = hi == null ? L - 1 - off : Math.min(hi, L - 1 - off); any = true }
    }
    return any && (lo == null || hi == null || lo <= hi) ? [lo, hi] : null
  }
  const plans = []
  // Planned regions: an original loop kept as the slow path (its reads stay
  // checked) and a suffix about to be copied are not planned again.
  const planned = new Set()
  walkAst(body, { enter: (n, parent) => {
    if (n[0] === '=>' || planned.has(n)) return false
    if (n[0] === 'while' && n.length === 3 && parent?.[0] !== 'label' && !hasOwnBreakOrContinue(n[2])
        && !some(n, x => x[0] === '=>')) {
      const [, cond, loopBody] = n
      // body reads count until the first write of the cursor that is not a constant step
      const offset = new Map()
      const collect = (c) => {
        offset.clear()
        for (const a of accessesIn(cond, false)) offset.set(a, 0)
        let d = 0
        for (const s of stmtList(loopBody)) {
          if (!writes(s, c)) { for (const a of accessesIn(s, false)) offset.set(a, d); continue }
          const k = stepOf(s, c)
          if (k == null) break
          d += k
        }
      }
      const cursors = new Set()
      for (const a of accessesIn(cond, false)) {
        const c = cursorOf(a)
        if (c && !isReassigned(cond, c) && !collectAllBoundNames(n).has(c)) cursors.add(c)
      }
      if (cursors.size && !counted(cond, loopBody)) for (const c of cursors) {
        collect(c)
        const need = needs([...offset.keys()], c, a => offset.get(a))
        if (!need) continue
        plans.push({ kind: 'loop', node: n, parent, c, need })
        planned.add(n)
        return false
      }
    }
    if (n[0] === ';') {
      const stmts = n
      for (let p = stmts.length - 1; p >= 2; p--) {
        const moves = stmts[p - 1]
        const rest = stmts.slice(p)
        if (rest.some(s => some(s, x => x[0] === '=>'))) break
        const cands = new Set()
        for (const s of rest) for (const a of accessesIn(s, true)) {
          const c = cursorOf(a)
          if (c && stepsOnly(moves, c) && !rest.some(r => writes(r, c))) cands.add(c)
        }
        for (const c of cands) {
          const need = needs(rest.flatMap(s => accessesIn(s, true)), c, () => 0)
          if (!need) continue
          plans.push({ kind: 'suffix', node: stmts, p, c, need })
          for (const s of rest) planned.add(s)
          return
        }
      }
    }
  } })
  if (!plans.length) return false
  for (const pl of plans) {
    const G = guardOf(pl.c, pl.need[0], pl.need[1])
    if (pl.kind === 'loop') {
      const [, cond, loopBody] = pl.node
      const [c2, b2] = copyFresh([cond, loopBody])
      const fast = ['while', ['&&', G, c2], b2]
      const rest = ['if', ['!', guardOf(pl.c, pl.need[0], pl.need[1])], pl.node]
      const i = pl.parent.indexOf(pl.node)
      pl.parent[i] = ['{}', [';', fast, rest]]
    } else {
      const { node: stmts, p } = pl
      const rest = stmts.slice(p)
      const fast = copyFresh(rest)
      stmts.splice(p, stmts.length - p, ['if', G, ['{}', [';', ...fast]], ['{}', [';', ...rest]]])
    }
  }
  invalidateRewrittenBody(body)
  return true
}
