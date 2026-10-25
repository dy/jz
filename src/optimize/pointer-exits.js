/**
 * A loop whose counter only tells it when to stop stops where its pointer
 * reaches the end instead (speed tier):
 *
 *   (local.set $i (i32.const 0))
 *   (block $B
 *     (local.set $p BASE)
 *     (loop $L
 *       (br_if $B (i32.ge_s (local.get $i) (i32.const 1024)))
 *       … (i32.load offset=4 (local.get $p)) …
 *       (local.set $i (i32.add (local.get $i) (i32.const 1)))
 *       (local.set $p (i32.add (local.get $p) (i32.const 20)))
 *       (br $L)))
 *
 * becomes
 *
 *   (block $B
 *     (local.set $p BASE)
 *     (local.set $end (i32.add (local.get $p) (i32.const 20480)))
 *     (loop $L
 *       (br_if $B (i32.eq (local.get $p) (local.get $end)))
 *       … (i32.load offset=4 (local.get $p)) …
 *       (local.set $p (i32.add (local.get $p) (i32.const 20)))
 *       (br $L)))
 *
 * watr's strength reduction (`lsr`) turns an address affine in a counter into
 * a pointer stepped beside it; where the body read the counter only through
 * those addresses, the counter is left with its step and its test, an add and
 * a register each iteration for a value nothing else reads. A walk over a
 * record array, one record an iteration at a stride an address cannot scale
 * by, is the shape: an 8-way record dispatch over shuffled records (shapes)
 * runs 7% faster without it on an AMD Zen 4, 2-4% on a Zen 3, a Zen 5 and an
 * Intel Xeon.
 *
 * Exact. The counter `i` starts at a constant I0 where the loop is entered,
 * every test compares it with a constant, and `i` and the pointer `p` each step
 * once between consecutive tests, by constants S and D, so after m steps
 * `i = I0 + m*S` and `p = P0 + m*D`. The tests' answers at m = m0, m0+1, … are
 * computed here, M being the first step count at which the loop leaves; each
 * test then asks `p == P0 + M*D`, which among the step counts the loop reaches
 * holds at m = M alone: m*D modulo 2^32 differs for each m while M*|D| < 2^32.
 * The counter may not wrap before M (its comparisons read the integer it
 * counts), and nothing else may read it; its declaration is renamed to hold
 * the end, so the function keeps its locals.
 *
 * Declined: a counter read anywhere but its own steps and tests, or written
 * outside the loop other than its constant start; steps in nested control; a
 * branch to the loop label other than the loop's last statement (a continue
 * skips the steps after it); a trip count the constants do not decide.
 *
 * @module optimize/pointer-exits
 */

const isArr = Array.isArray
const LIM = 4294967296, HALF = 2147483648
// (sets, not patterns: the compiler compiles itself, and its source keeps to plain string tests)
const CMP = new Set(['i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u', 'i32.le_s', 'i32.le_u', 'i32.gt_s', 'i32.gt_u', 'i32.ge_s', 'i32.ge_u'])
// a comparison with its operands swapped
const SWAP = new Map([['i32.eq', 'i32.eq'], ['i32.ne', 'i32.ne'], ['i32.lt_s', 'i32.gt_s'], ['i32.lt_u', 'i32.gt_u'], ['i32.le_s', 'i32.ge_s'],
  ['i32.le_u', 'i32.ge_u'], ['i32.gt_s', 'i32.lt_s'], ['i32.gt_u', 'i32.lt_u'], ['i32.ge_s', 'i32.le_s'], ['i32.ge_u', 'i32.le_u']])
const BRANCH = new Set(['br', 'br_if', 'br_table'])

const constOf = (n) => isArr(n) && n[0] === 'i32.const' && n.length === 2 && Number.isInteger(Number(n[1])) ? Number(n[1]) | 0 : null
const label = (n) => typeof n[1] === 'string' && n[1][0] === '$' ? n[1] : null
const typed = (n) => n.slice(2, 4).some(c => isArr(c) && (c[0] === 'result' || c[0] === 'param' || c[0] === 'type'))
const getOf = (n, x) => isArr(n) && n[0] === 'local.get' && n[1] === x && n.length === 2
const writesTo = (n, x) => isArr(n) && (n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === x
const has = (n, pred) => isArr(n) && (pred(n) || n.some(c => has(c, pred)))

/** The constant `x` steps by in `e` (`x + c`, `c + x`, `x - c`), or 0. */
const stepBy = (e, x) => {
  if (!isArr(e) || e.length !== 3) return 0
  if (e[0] === 'i32.add') return (getOf(e[1], x) ? constOf(e[2]) : getOf(e[2], x) ? constOf(e[1]) : 0) || 0
  if (e[0] === 'i32.sub' && getOf(e[1], x)) return -(constOf(e[2]) || 0) | 0
  return 0
}
/** `(local.set x (x + c))`: c, or 0. */
const stepStmt = (s, x) => isArr(s) && s[0] === 'local.set' && s[1] === x && s.length === 3 ? stepBy(s[2], x) : 0
/** The local a statement steps by a constant, or null. */
const stepped = (s) => isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3 && stepBy(s[2], s[1]) ? s[1] : null

/** Whether comparison `op` holds of integers a and b, read by its signedness. */
const holds = (op, a, b) => {
  if (op === 'i32.eq') return a === b
  if (op === 'i32.ne') return a !== b
  if (op.endsWith('_u')) { if (a < 0) a += LIM; if (b < 0) b += LIM }
  const o = op.slice(4, 6)
  return o === 'lt' ? a < b : o === 'le' ? a <= b : o === 'gt' ? a > b : a >= b
}

/**
 * A comparison of a local with a constant, `(op X N)` or `(op N X)` under any
 * number of `i32.eqz`, X `(local.get x)` or `(local.tee x E)`: { x, op, n, neg,
 * tee, step, start } read with x on the left (`step` for E = x + S, `start` for
 * E a constant), or null.
 */
const testOf = (cond) => {
  let neg = false
  while (isArr(cond) && cond[0] === 'i32.eqz' && cond.length === 2) { neg = !neg; cond = cond[1] }
  if (!isArr(cond) || !CMP.has(cond[0]) || cond.length !== 3) return null
  let op = cond[0], a = cond[1], n = constOf(cond[2])
  if (n === null) { n = constOf(cond[1]); a = cond[2]; op = SWAP.get(op) }
  if (n === null || !isArr(a) || typeof a[1] !== 'string') return null
  if (a[0] === 'local.get' && a.length === 2) return { x: a[1], op, n, neg, tee: false, step: 0, start: null }
  if (a[0] !== 'local.tee' || a.length !== 3) return null
  const step = stepBy(a[2], a[1]), start = constOf(a[2])
  return step || start !== null ? { x: a[1], op, n, neg, tee: true, step, start: step ? null : start } : null
}

/** Rewrite the counted loops of function `fn`. */
const rewriteFunc = (fn) => {
  // census: every read and write of each local; a branch by depth keeps the function as it is
  const reads = new Map(), writes = new Map(), names = new Set()
  let byDepth = false
  const bump = (m, x) => m.set(x, (m.get(x) || 0) + 1)
  const census = (n) => {
    if (!isArr(n)) return
    const op = n[0]
    if (op === 'local.get') bump(reads, n[1])
    else if (op === 'local.set' || op === 'local.tee') bump(writes, n[1])
    else if (BRANCH.has(op) && n.slice(1).some(c => typeof c === 'number' || typeof c === 'string' && c[0] >= '0' && c[0] <= '9')) byDepth = true
    if (typeof n[1] === 'string' && n[1][0] === '$') names.add(n[1])
    for (let i = 1; i < n.length; i++) census(n[i])
  }
  census(fn)
  if (byDepth) return
  const decl = new Map()
  for (const c of fn) if (isArr(c) && c[0] === 'local' && c.length === 3 && typeof c[1] === 'string' && c[2] === 'i32') decl.set(c[1], c)
  let uid = 0
  const fresh = () => { let s = `$__pe${uid++}`; while (names.has(s)) s = `$__pe${uid++}`; names.add(s); return s }

  // innermost first; `up` holds the nodes enclosing the one visited, outermost first
  const visit = (n, up) => {
    const inner = [...up, n]
    for (const c of n.slice(1)) if (isArr(c)) visit(c, inner)
    if (n[0] === 'loop') counted(n, up)
  }

  // Drop the counter of loop `L` (enclosed by `up`) where it has one to drop.
  const counted = (L, up) => {
    const lab = label(L)
    if (!lab || typed(L) || !up.length) return
    const S = L.slice(2), last = S[S.length - 1]
    // the loop's last statement is its one branch back
    if (!isArr(last) || !(last[0] === 'br' && last.length === 2 || last[0] === 'br_if' && last.length === 3) || last[1] !== lab) return
    let backs = 0
    const countBacks = (n) => { if (!isArr(n)) return; if (BRANCH.has(n[0]) && n.includes(lab)) backs++; for (const c of n) countBacks(c) }
    countBacks(L)
    if (backs !== 1) return
    const counters = new Set(), pointers = new Set()
    for (const s of S) {
      const t = isArr(s) && s[0] === 'br_if' && s.length === 3 ? testOf(s[2]) : null
      if (t && t.start === null && decl.has(t.x)) counters.add(t.x)
      const q = stepped(s)
      if (q && decl.has(q)) pointers.add(q)
    }
    for (const x of counters) {
      const plan = counter(L, S, x, pointers, up)
      if (plan) { apply(plan); return }
    }
  }

  // A plan to drop counter `x` of loop `L`, or null.
  const counter = (L, S, x, pointers, up) => {
    const lab = label(L), tests = [], steps = []
    let ci = 0, stepI = 0, r = 0, w = 0
    for (let k = 0; k < S.length; k++) {
      const s = S[k], st = stepStmt(s, x)
      if (st) {
        if (stepI && st !== stepI) return null
        stepI = st; ci++; r++; w++; steps.push(k)
        continue
      }
      const t = isArr(s) && s[0] === 'br_if' && s.length === 3 ? testOf(s[2]) : null
      if (!t || t.x !== x) continue
      if (t.start !== null) return null
      if (t.step) { if (stepI && t.step !== stepI) return null; stepI = t.step; ci++; w++ }
      r++
      tests.push({ k, t, c: ci, exits: s[1] !== lab })
    }
    if (!tests.length || !stepI) return null
    // every read and write of x is one of these, and the start before the loop
    if ((reads.get(x) || 0) !== r || (writes.get(x) || 0) !== w + 1) return null
    const init = startOf(x, L, up)
    if (!init) return null
    for (const p of pointers) {
      if (p === x) continue
      const plan = lockstep({ L, S, x, tests, steps, n: ci, stepI, init }, p)
      if (plan) return plan
    }
    return null
  }

  // The constant `x` holds where loop `L` is entered (its last write before it, in
  // the lists the loop is entered through): { value, stmt } or { value, guard, t }, or null.
  const startOf = (x, L, up) => {
    let node = L, k = up.length - 1
    for (;;) {
      const list = up[k]
      for (let i = list.indexOf(node) - 1; i >= 1; i--) {
        const s = list[i]
        if (!has(s, n => writesTo(n, x))) continue
        if (isArr(s) && s[0] === 'local.set' && s[1] === x && s.length === 3 && constOf(s[2]) !== null) return { value: constOf(s[2]), stmt: s, list }
        const t = isArr(s) && s[0] === 'br_if' && s.length === 3 ? testOf(s[2]) : null
        if (t && t.x === x && t.start !== null) return { value: t.start, guard: s, list, t }
        return null
      }
      // no write here: the list must be a block, entered by falling into it
      if (list[0] !== 'block' || k === 0) return null
      node = list; k--
    }
  }

  // The plan for counter `c.x` (its loop, steps and tests) and pointer p, or null where they do not step together.
  const lockstep = (c, p) => {
    const { L, S, x, tests, steps, n, stepI, init } = c
    let cp = 0, stepP = 0, ti = 0
    const at = []
    for (let k = 0; k < S.length; k++) {
      if (ti < tests.length && tests[ti].k === k) at.push(cp), ti++
      const st = stepStmt(S[k], p)
      if (!st) continue
      if (stepP && st !== stepP) return null
      stepP = st; cp++
    }
    // p is written in the loop by these steps alone, as often as x and at the same points
    if (cp !== n) return null
    let wIn = 0
    const countW = (q) => { if (!isArr(q)) return; if (writesTo(q, p)) wIn++; for (const c of q) countW(c) }
    countW(L)
    if (wIn !== n) return null
    for (let j = 0; j < tests.length; j++) if (at[j] !== tests[j].c) return null
    // one step of each between consecutive tests, around the back edge too
    for (let j = 1; j < tests.length; j++) if (tests[j].c - tests[j - 1].c !== 1) return null
    if (n - tests[tests.length - 1].c + tests[0].c !== 1) return null
    // the step count at which the loop leaves: test j sees m = m0 + j + k*T
    const m0 = tests[0].c, T = tests.length, I0 = init.value
    const unsigned = tests.some(e => e.t.op.endsWith('_u'))
    const leaves = (j, m) => {
      const t = tests[j].t, ans = holds(t.op, I0 + m * stepI, t.n) !== t.neg
      return tests[j].exits ? ans : !ans
    }
    // the last step count at which the counter still reads as the integer it counts
    const bound = stepI > 0 ? Math.floor((HALF - 1 - I0) / stepI) : Math.floor(((unsigned ? 0 : -HALF) - I0) / stepI)
    if (bound < m0 || unsigned && I0 < 0) return null
    let M = Infinity
    for (let j = 0; j < T; j++) {
      const mAt = (k) => m0 + j + k * T, kMax = Math.floor((bound - m0 - j) / T)
      if (kMax < 0) continue
      const op = tests[j].t.op
      let k = -1
      if (leaves(j, mAt(0))) k = 0
      else if (op === 'i32.eq' || op === 'i32.ne') {
        // it leaves where the counter meets the constant, or one step past it
        const d = tests[j].t.n - I0
        if (d % stepI === 0 && d / stepI === mAt(0)) { if (kMax >= 1 && leaves(j, mAt(1))) k = 1 }
        else if (d % stepI === 0 && d / stepI > mAt(0) && (d / stepI - m0 - j) % T === 0 && d / stepI <= bound && leaves(j, d / stepI)) k = (d / stepI - m0 - j) / T
      } else if (leaves(j, mAt(kMax))) {
        // an ordered comparison of a counter that does not wrap: its answers change once
        let lo = 0, hi = kMax
        while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (leaves(j, mAt(mid))) hi = mid; else lo = mid }
        k = hi
      }
      if (k >= 0 && mAt(k) < M) M = mAt(k)
    }
    if (M === Infinity || (M - m0) * Math.abs(stepP) >= LIM) return null
    // a rotated loop's guard, which reads the start, must let the loop run
    if (init.guard && holds(init.t.op, I0, init.t.n) !== init.t.neg) return null
    return { L, x, p, tests, steps, init, end: (M * stepP) | 0 }
  }

  // The counter's declaration holds the end, set where the loop is entered.
  const apply = ({ L, x, p, tests, steps, init, end }) => {
    const e = fresh(), d = decl.get(x)
    d[1] = e
    decl.delete(x)
    for (const { k, exits } of tests) L[2 + k] = ['br_if', L[2 + k][1], [exits ? 'i32.eq' : 'i32.ne', ['local.get', p], ['local.get', e]]]
    const drop = new Set(steps.map(k => 2 + k))
    const body = L.filter((_, k) => !drop.has(k))
    L.length = 0
    for (const s of body) L.push(s)
    // the start goes: a set, or a rotated loop's guard, which never branches
    const s = init.stmt || init.guard
    init.list.splice(init.list.indexOf(s), 1)
    const list = locate(L)
    list.splice(list.indexOf(L), 0, ['local.set', e, end ? ['i32.add', ['local.get', p], ['i32.const', end]] : ['local.get', p]])
  }
  // the list holding node `t`
  const locate = (t) => {
    const find = (n) => {
      if (!isArr(n)) return null
      if (n.includes(t)) return n
      for (const c of n) { const r = find(c); if (r) return r }
      return null
    }
    return find(fn)
  }

  visit(fn, [])
}

/** Stop each loop of `ast` (a module) that keeps a counter only to stop by the pointer stepped beside it. */
export function pointerExits(ast) {
  if (!isArr(ast)) return ast
  for (const fn of ast) if (isArr(fn) && fn[0] === 'func') rewriteFunc(fn)
  return ast
}
