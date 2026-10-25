/**
 * A counted loop stepping a cursor around a ring runs a lap at a time (speed tier):
 *
 *   (loop $L
 *     S1                                          ;; reads p
 *     (local.set $p RING)                         ;; p + 1, 0 where that reaches m
 *     S2                                          ;; reads no p
 *     (if (i32.eqz (local.get $p)) (then W))      ;; the wrap's work (optional), no i in it
 *     (br_if $L (i32.lt_s (local.tee $i (i32.add (local.get $i) (i32.const 1))) N)))
 *
 * becomes, where `p <u m` and `i < N` as the loop is entered (the loop as written
 * the other arm),
 *
 *   (loop $o
 *     (local.set $e (i32.add i (min_u (N - i) (m - p))))      ;; the lap's end: the wrap, or N
 *     (loop $in
 *       S1 (local.set $p (i32.add (local.get $p) (i32.const 1))) S2
 *       (br_if $in (i32.ne (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $e))))
 *     (if (i32.eq (local.get $p) m) (then (local.set $p (i32.const 0)) W))
 *     (br_if $o (i32.lt_s (local.get $i) N)))
 *
 * A ring buffer's cursor (`p = (p + 1) % m`, a delay line's write head, a moving
 * window's slot) is the shape: each pass tests the cursor against the ring's
 * size and tests the wrap again for its work, two compares and two branches per
 * element besides the loop's own, and the remainder's cold arm (a division,
 * whose fixed registers the engine keeps free across the loop) holds registers
 * the hot path then spills. A lap is a loop over the elements before the wrap
 * with one test per pass, the wrap's work after it, once per lap. A boxcar
 * filter's running sum over a 16-slot window (movavg) runs 0.57x its time on
 * an AMD EPYC 7763, 0.52x on a Xeon 8573C, 0.60x on an EPYC 9V45 (hand-written
 * laps of jz's own loop, measured against it).
 *
 * Exact. Under `0 <= p <u m` each RING form is `p + 1` below m and 0 at it: the
 * remainder below the divisor (emit/arithmetic.js belowDivisorRem: `t <u m ? t :
 * t - m <u m ? t - m : t % m`, whose division a cursor below m never reaches), a
 * remainder `(p + 1) % m` (signed, under `m > 0` as well), a mask `(p + 1) & k`
 * of a ring of `k + 1 = 2^j` slots. So the cursor holds `p0 + t` on pass t of a
 * lap and wraps where t = m - p0, and the lap runs `min(N - i, m - p)` passes,
 * one at least: the counter leaves where the loop would. S1 and S2 run in the
 * order they did, with the counter and cursor they saw; the wrap's work runs at
 * the end of the pass it ended, after the counter's step, which it does not
 * read. The loop may not leave but by its own test (no branch out of it, no
 * call, return or throw), so nothing reads the cursor at m on the last pass's
 * way out.
 *
 * The step's temporaries keep their values: the lap writes `t = p + 1` where
 * the step wrote it, and the remainder's `t - m`, which the step writes at the
 * wrap alone, where the lap wraps (S2, between the two, must leave it alone:
 * the optimizer's local reuse gives a temporary's slot to other values).
 *
 * Declined: a counter or cursor written elsewhere in the loop, a ring size or
 * bound the loop writes, a cursor S2 reads (it would see p + 1 where the loop
 * read 0), a ring's work that is not the loop's last statement, a branch by
 * depth, and a loop past MAX_NODES.
 *
 * @module optimize/ring-laps
 */

const isArr = Array.isArray
const MAX_NODES = 1200   // nodes of a loop copied at most (its body runs twice, the laps and the loop as written)
// a branch, and what leaves a loop other than by a branch
const BRANCH = new Set(['br', 'br_if', 'br_table'])
const LEAVES = new Set(['return', 'call', 'call_indirect', 'call_ref', 'return_call', 'return_call_indirect', 'return_call_ref',
  'throw', 'throw_ref', 'rethrow', 'try', 'try_table', 'delegate'])
const LABELED = new Set(['block', 'loop', 'if', 'try', 'try_table'])
// the loop's own exit tests: below the bound, signed or not, or short of it
const EXIT_CMP = new Set(['i32.lt_s', 'i32.lt_u', 'i32.ne'])

const constOf = (n) => isArr(n) && n[0] === 'i32.const' && n.length === 2 && Number.isInteger(Number(n[1])) ? Number(n[1]) | 0 : null
const label = (n) => typeof n[1] === 'string' && n[1][0] === '$' ? n[1] : null
const typed = (n) => n.slice(2, 4).some(c => isArr(c) && (c[0] === 'result' || c[0] === 'param' || c[0] === 'type'))
const getOf = (n, x) => isArr(n) && n[0] === 'local.get' && n[1] === x && n.length === 2
const has = (n, pred) => isArr(n) && (pred(n) || n.some(c => has(c, pred)))
const names = (n, x) => has(n, c => (c[0] === 'local.get' || c[0] === 'local.set' || c[0] === 'local.tee') && c[1] === x)
const reads = (n, x) => has(n, c => c[0] === 'local.get' && c[1] === x)
const writes = (n, x) => has(n, c => (c[0] === 'local.set' || c[0] === 'local.tee') && c[1] === x)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const copy = (n) => isArr(n) ? n.map(copy) : n
const size = (n) => isArr(n) ? n.reduce((s, c) => s + size(c), 1) : 0
const g = (x) => ['local.get', x], k = (v) => ['i32.const', String(v)]

/** `x + 1`, either order. */
const plusOne = (e, x) => isArr(e) && e[0] === 'i32.add' && e.length === 3 && (getOf(e[1], x) && constOf(e[2]) === 1 || getOf(e[2], x) && constOf(e[1]) === 1)
/** The one value an arm (`then`/`else`) yields, or null. */
const armValue = (a, tag) => isArr(a) && a[0] === tag && a.length === 2 ? a[1] : null
const tee = (n) => isArr(n) && n[0] === 'local.tee' && n.length === 3 && typeof n[1] === 'string' ? n : null

/**
 * The ring `e`, a value stored to cursor `p`, steps p around: { m, temps, signed }, m the
 * ring's size (a local's read or a constant), temps the locals the step writes, or null.
 */
const ringOf = (e, p) => {
  if (!isArr(e)) return null
  // the remainder below the divisor: t <u m ? t : (t - m <u m ? t - m : t rem m)
  if (e[0] === 'if' && e.length === 5 && isArr(e[1]) && e[1][0] === 'result' && e[1][1] === 'i32') {
    const c = e[2], t = c?.[0] === 'i32.lt_u' && c.length === 3 ? tee(c[1]) : null
    if (!t || !plusOne(t[2], p) || !getOf(armValue(e[3], 'then'), t[1])) return null
    const m = c[2], inner = armValue(e[4], 'else')
    if (!isArr(inner) || inner[0] !== 'if' || inner.length !== 5 || !same(inner[1], e[1])) return null
    const c2 = inner[2], s = c2?.[0] === 'i32.lt_u' && c2.length === 3 && same(c2[2], m) ? tee(c2[1]) : null
    if (!s || !isArr(s[2]) || s[2][0] !== 'i32.sub' || s[2].length !== 3 || !getOf(s[2][1], t[1]) || !same(s[2][2], m)) return null
    if (!getOf(armValue(inner[3], 'then'), s[1]) || !isArr(armValue(inner[4], 'else'))) return null
    return { m, temps: [t[1], s[1]], signed: false }
  }
  if ((e[0] === 'i32.rem_s' || e[0] === 'i32.rem_u') && e.length === 3 && plusOne(e[1], p)) {
    const v = constOf(e[2])
    if (v !== null) return v > 0 ? { m: e[2], temps: [], signed: false } : null
    return isArr(e[2]) && e[2][0] === 'local.get' && e[2].length === 2 ? { m: e[2], temps: [], signed: e[0] === 'i32.rem_s' } : null
  }
  // a mask of 2^j - 1 slots: (p + 1) & k
  if (e[0] === 'i32.and' && e.length === 3) {
    const v = plusOne(e[1], p) ? constOf(e[2]) : plusOne(e[2], p) ? constOf(e[1]) : null
    if (v !== null && v > 0 && (v & (v + 1)) === 0) return { m: k((v + 1) | 0), temps: [], signed: false }
  }
  return null
}

/** The wrap's work `W` of `(if (p == 0) (then W))`, or null. */
const wrapOf = (s, p) => {
  if (!isArr(s) || s[0] !== 'if' || s.length !== 3 || !isArr(s[2]) || s[2][0] !== 'then') return null
  const c = s[1]
  const zero = isArr(c) && (c[0] === 'i32.eqz' && c.length === 2 && getOf(c[1], p) ||
    c[0] === 'i32.eq' && c.length === 3 && (getOf(c[1], p) && constOf(c[2]) === 0 || getOf(c[2], p) && constOf(c[1]) === 0))
  return zero ? s[2].slice(1) : null
}

/** Rewrite the ring loops of function `fn`. */
const rewriteFunc = (fn) => {
  // a branch by depth names no label: the copies could not be checked
  if (has(fn, n => BRANCH.has(n[0]) && n.slice(1).some(c => typeof c === 'number' || typeof c === 'string' && c[0] >= '0' && c[0] <= '9'))) return
  const taken = new Set()
  const collect = (n) => { if (!isArr(n)) return; for (const c of n) if (typeof c === 'string' && c[0] === '$') taken.add(c); else collect(c) }
  collect(fn)
  let uid = 0
  const fresh = () => { let s = `$__rl${uid++}`; while (taken.has(s)) s = `$__rl${uid++}`; taken.add(s); return s }
  const locals = []

  // the plan for loop L, or null
  const plan = (L) => {
    const lab = label(L)
    if (!lab || typed(L) || size(L) > MAX_NODES) return null
    const S = L.slice(2), back = S[S.length - 1]
    if (!isArr(back) || back[0] !== 'br_if' || back.length !== 3 || back[1] !== lab) return null
    const test = back[2], ti = EXIT_CMP.has(test?.[0]) && test.length === 3 ? tee(test[1]) : null
    if (!ti || !plusOne(ti[2], ti[1])) return null
    const i = ti[1], N = test[2]
    const invariant = (n) => constOf(n) !== null || isArr(n) && n[0] === 'local.get' && n.length === 2 && !writes(L, n[1])
    if (!invariant(N) || getOf(N, i)) return null
    // the cursor: one statement steps it around its ring
    let at = -1, ring = null
    for (let j = 0; j < S.length - 1; j++) {
      const s = S[j], r = isArr(s) && s[0] === 'local.set' && s.length === 3 && typeof s[1] === 'string' ? ringOf(s[2], s[1]) : null
      if (!r) continue
      if (ring) return null
      at = j; ring = r
    }
    if (!ring) return null
    const p = S[at][1], m = ring.m
    if (p === i || !invariant(m) || getOf(m, i) || getOf(m, p) || getOf(N, p)) return null
    // the counter steps at the back edge alone, the cursor at its step alone
    if (writes(S.slice(0, -1), i) || writes(S.slice(0, at), p) || writes(S.slice(at + 1), p)) return null
    const rest = S.slice(at + 1, -1), last = rest[rest.length - 1]
    const W = last !== undefined ? wrapOf(last, p) : null
    const S2 = W ? rest.slice(0, -1) : rest
    if (reads(S2, p) || W && names(W, i)) return null
    // the step's temporaries: the lap writes the first where the step did; the second, which the
    // step writes at the wrap alone, the lap writes where it wraps, after S2, which must leave it alone
    const [t, s] = ring.temps
    if (t === p || t === i || s === p || s === i || s && (s === t || names(S2, s))) return null
    // the loop leaves by its own test alone: no branch out, back but at the end, or call
    const inside = new Set()
    const defs = (n) => { if (!isArr(n)) return; if (LABELED.has(n[0]) && label(n)) inside.add(n[1]); for (const c of n) defs(c) }
    for (const s of S) defs(s)
    let escapes = false
    const scan = (n) => {
      if (!isArr(n) || escapes) return
      if (LEAVES.has(n[0])) { escapes = true; return }
      if (BRANCH.has(n[0]) && n.slice(1).some(c => typeof c === 'string' && c[0] === '$' && !inside.has(c))) { escapes = true; return }
      for (const c of n) scan(c)
    }
    S.slice(0, -1).forEach(scan)
    if (escapes) return null
    return { L, S, at, i, N, p, m, ring, S2, W, op: test[0] }
  }

  // the laps of a plan beside the loop as written
  const laps = ({ L, S, at, i, N, p, m, ring, S2, W, op }) => {
    const e = fresh(), a = fresh(), b = fresh(), outer = fresh(), inner = fresh()
    locals.push(e, a, b)
    // entered with the cursor in its ring and a pass to run
    let guard = ['i32.and', ['i32.lt_u', g(p), copy(m)], [op, g(i), copy(N)]]
    if (ring.signed) guard = ['i32.and', guard, ['i32.gt_s', copy(m), k(0)]]
    const end = ['local.set', e, ['i32.add', g(i), ['select', ['local.tee', a, ['i32.sub', copy(N), g(i)]], ['local.tee', b, ['i32.sub', copy(m), g(p)]],
      ['i32.lt_u', g(a), g(b)]]]]
    const [t, s] = ring.temps
    const step = ['i32.add', g(p), k(1)]
    const lap = ['loop', inner, ...S.slice(0, at).map(copy), ['local.set', p, t ? ['local.tee', t, step] : step], ...S2.map(copy),
      ['br_if', inner, ['i32.ne', ['local.tee', i, ['i32.add', g(i), k(1)]], g(e)]]]
    const wrap = ['if', ['i32.eq', g(p), copy(m)], ['then', ['local.set', p, s ? ['local.tee', s, ['i32.sub', g(p), copy(m)]] : k(0)], ...(W ?? []).map(copy)]]
    return ['if', guard, ['then', ['loop', outer, end, lap, wrap, ['br_if', outer, [op, g(i), copy(N)]]]], ['else', L]]
  }

  // innermost first, each loop planned against its body as the source left it
  const found = []
  const visit = (n) => {
    if (!isArr(n)) return
    for (let j = 1; j < n.length; j++) {
      const c = n[j]
      if (!isArr(c)) continue
      visit(c)
      if (c[0] === 'loop') { const P = plan(c); if (P) found.push([n, P]) }
    }
  }
  visit(fn)
  if (!found.length) return
  for (const [list, P] of found) list[list.indexOf(P.L)] = laps(P)
  let head = 2
  while (head < fn.length && isArr(fn[head]) && (fn[head][0] === 'export' || fn[head][0] === 'import' || fn[head][0] === 'type' ||
    fn[head][0] === 'param' || fn[head][0] === 'result' || fn[head][0] === 'local')) head++
  fn.splice(head, 0, ...locals.map(x => ['local', x, 'i32']))
}

/** Run each ring loop of `ast` (a module) a lap at a time. */
export function ringLaps(ast) {
  if (!isArr(ast)) return ast
  for (const fn of ast) if (isArr(fn) && fn[0] === 'func') rewriteFunc(fn)
  return ast
}
