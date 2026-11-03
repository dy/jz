/**
 * A test that skips a loop's inner scan runs the rest of the round in a copy
 * of its own (speed tier):
 *
 *   (loop $L …
 *     (block $B … (br_if $B c) … (loop $W …) …)
 *     REST…
 *     (br_if $L C))
 *
 * where c tests the scan's data, becomes
 *
 *   (block $out
 *     (loop $L …
 *       (block $B … (if c (then REST′… (br_if $L C) (br $out))) … (loop $W …) …)
 *       REST…
 *       (br_if $L C)))
 *
 * A scan entered on a test of its data (a hull that pops while the new
 * parabola hides the last, a cursor that steps to the next boundary, a walk
 * along a chain) stops at its first element as often as not. V8 lays a
 * function out as written: the round that skips the scan jumped past it, and
 * past the arms the scan's slow path keeps after it, to the rest of the round
 * and the latch, a taken branch a round on the loop's shortest way. The round
 * that skips now falls through into its copy and takes only the latch; the
 * round that runs the scan branches to it, once beside the scan's own
 * branches. On an Apple M4, an exact distance transform (sdf: a hull's pop, a
 * scan to the next boundary) ran about 10% faster, a hash join (hashjoin)
 * about 20%, a dictionary (dict) 12% and an LZ compressor (lz) 5%.
 *
 * REST′ is what runs from the end of $B to the end of the loop body: the
 * statements after each construct that holds $B, out to the body itself, with
 * the tests the way to the branch decides folded. The way decides a test of a
 * word against a literal where the round set the word to a literal (a flag it
 * clears before the scan), where an earlier test bounded it (a cursor its
 * guard keeps in range: `(br_if $B (i32.gt_s (local.get $k) (i32.const 383)))`
 * not taken), where an enclosing conditional's test did, or where the test
 * that takes the branch does. A conditional so decided keeps the arm it takes,
 * a branch so decided is a branch or nothing. The copy holds no loop (an arm
 * with one the way decides away, a guarded scan's slow path, does not count)
 * and at most MAX_COPY instruction nodes; its labels are its own. A branch in
 * it to a construct around $B leaves to the original code after that
 * construct, which is what the copy runs. A loop without a latch at its end, a
 * test of words alone (a counted loop's entry test, which holds on nearly
 * every round), a construct of a value on the way, and a function that
 * branches by depth keep their shape.
 *
 * @module optimize/skip-latches
 */

const isArr = Array.isArray
// (sets, not patterns: the compiler compiles itself, and its source keeps to plain string tests)
const LABELLED = new Set(['block', 'loop', 'if', 'try', 'try_table'])
const HANDLER = new Set(['try', 'try_table', 'catch', 'catch_all', 'catch_ref', 'catch_all_ref', 'delegate', 'rethrow', 'throw_ref'])
const WRAPPER = new Set(['then', 'else', 'result', 'param', 'type'])
const ENDS = new Set(['br', 'br_table', 'return', 'unreachable', 'throw', 'return_call', 'return_call_indirect', 'return_call_ref'])
/** The instruction nodes a copy of the rest of a round may hold. */
export const MAX_COPY = 96

const label = (n) => typeof n[1] === 'string' && n[1][0] === '$' ? n[1] : null
// (a construct carrying a type yields a value: out of scope)
const typed = (n) => n.some((c, i) => i > 0 && isArr(c) && (c[0] === 'result' || c[0] === 'param' || c[0] === 'type'))
const some = (n, f) => isArr(n) && (f(n) || n.some((c, i) => i > 0 && some(c, f)))
const size = (n) => { if (!isArr(n)) return 0; let s = typeof n[0] === 'string' && !WRAPPER.has(n[0]) ? 1 : 0; for (let i = 1; i < n.length; i++) s += size(n[i]); return s }
// a test of words alone: counters against bounds, a counted loop's entry test, which holds on
// nearly every round (where the scan's data is read from memory or compared as a Number)
const WORDS = new Set(['local.get', 'local.tee', 'i32.const', 'i32.eqz', 'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u', 'i32.le_s', 'i32.le_u',
  'i32.gt_s', 'i32.gt_u', 'i32.ge_s', 'i32.ge_u', 'i32.add', 'i32.sub', 'i32.mul', 'i32.and', 'i32.or', 'i32.xor', 'i32.shl', 'i32.shr_s', 'i32.shr_u'])
const ofWords = (e) => !isArr(e) || WORDS.has(e[0]) && e.every((c, i) => i === 0 || ofWords(c))
const writes = (n) => some(n, m => m[0] === 'local.tee' || m[0] === 'local.set' || typeof m[0] === 'string' && m[0].startsWith('call'))

/** The word of an `i32.const`, or null. */
const i32 = (n) => {
  if (!isArr(n) || n[0] !== 'i32.const' || n.length !== 2) return null
  const s = String(n[1]), neg = s[0] === '-', t = neg || s[0] === '+' ? s.slice(1) : s
  if (!/^(0x[0-9a-f]+|\d+)$/i.test(t)) return null
  const v = Number(t)
  return (neg ? -v : v) | 0
}

// A test of a word against a literal: { x, op, c }.
const OPS = { 'i32.lt_s': 'lt', 'i32.le_s': 'le', 'i32.gt_s': 'gt', 'i32.ge_s': 'ge', 'i32.eq': 'eq', 'i32.ne': 'ne', 'i32.lt_u': 'ltu', 'i32.le_u': 'leu', 'i32.gt_u': 'gtu', 'i32.ge_u': 'geu' }
const NEG = { lt: 'ge', ge: 'lt', le: 'gt', gt: 'le', eq: 'ne', ne: 'eq', ltu: 'geu', geu: 'ltu', leu: 'gtu', gtu: 'leu' }
const SWAP = { lt: 'gt', gt: 'lt', le: 'ge', ge: 'le', eq: 'eq', ne: 'ne', ltu: 'gtu', gtu: 'ltu', leu: 'geu', geu: 'leu' }
const word = (n) => isArr(n) && typeof n[1] === 'string' && (n[0] === 'local.get' && n.length === 2 || n[0] === 'local.tee' && n.length === 3) ? n[1] : null
const testOf = (e) => {
  if (!isArr(e)) return null
  const w = word(e)
  if (w) return { x: w, op: 'ne', c: 0 }
  if (e[0] === 'i32.eqz' && e.length === 2) { const t = testOf(e[1]); return t && { x: t.x, op: NEG[t.op], c: t.c } }
  const op = OPS[e[0]]
  if (!op || e.length !== 3) return null
  let x = word(e[1]), c = i32(e[2])
  if (x && c != null) return { x, op, c }
  x = word(e[2]); c = i32(e[1])
  return x && c != null ? { x, op: SWAP[op], c } : null
}
const not = (t) => ({ x: t.x, op: NEG[t.op], c: t.c })

// What the way holds of words: a range [lo, hi] for each word it bounded.
const MIN = -2147483648, MAX = 2147483647
const range = (facts, x) => facts.get(x) || [MIN, MAX]
// A test's answer along the way: it holds, it fails, or the way leaves it open. Words, not
// true/false/null: the self-compiled compiler (level 1) reads a literal null that shares an
// expression with literal booleans as false, which would drop the conditional's arm.
const HOLDS = 1, FAILS = 0, OPEN = -1
/** Whether `t` holds for every word the way allows, for none, or neither. */
const decide = (facts, t) => {
  const r = range(facts, t.x)
  let lo = r[0], hi = r[1], c = t.c, op = t.op
  if (op === 'ltu' || op === 'leu' || op === 'gtu' || op === 'geu') {
    if (lo < 0 && hi >= 0) return OPEN
    lo = lo >>> 0; hi = hi >>> 0; c = c >>> 0; op = op.slice(0, 2)
  }
  if (op === 'lt') return hi < c ? HOLDS : lo >= c ? FAILS : OPEN
  if (op === 'le') return hi <= c ? HOLDS : lo > c ? FAILS : OPEN
  if (op === 'gt') return lo > c ? HOLDS : hi <= c ? FAILS : OPEN
  if (op === 'ge') return lo >= c ? HOLDS : hi < c ? FAILS : OPEN
  if (op === 'eq') return lo === c && hi === c ? HOLDS : c < lo || c > hi ? FAILS : OPEN
  return lo === c && hi === c ? FAILS : c < lo || c > hi ? HOLDS : OPEN
}
/** Narrow what the way holds by `t`, which held. */
const bound = (facts, t) => {
  const r = range(facts, t.x), c = t.c, op = t.op
  let lo = r[0], hi = r[1]
  if (op === 'lt') hi = Math.min(hi, c - 1)
  else if (op === 'le') hi = Math.min(hi, c)
  else if (op === 'gt') lo = Math.max(lo, c + 1)
  else if (op === 'ge') lo = Math.max(lo, c)
  else if (op === 'eq') { lo = Math.max(lo, c); hi = Math.min(hi, c) }
  else if (op === 'ne') { if (lo === c) lo++; if (hi === c) hi-- }
  else if (op === 'ltu' && c > 0 || op === 'leu' && c >= 0) { lo = Math.max(lo, 0); hi = Math.min(hi, op === 'ltu' ? c - 1 : c) }
  else if ((op === 'gtu' || op === 'geu') && c >= 0 && lo >= 0) lo = Math.max(lo, op === 'gtu' ? c + 1 : c)
  facts.set(t.x, [lo, hi])
}
/** Forget the words `n` writes. */
const kill = (facts, n) => {
  if (!isArr(n)) return
  if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') facts.delete(n[1])
  for (let i = 1; i < n.length; i++) kill(facts, n[i])
}
/** What the way holds once statement `s` falls through to the next. */
const step = (facts, s) => {
  kill(facts, s)
  if (!isArr(s)) return
  if (s[0] === 'local.set' && s.length === 3 && typeof s[1] === 'string') { const c = i32(s[2]); if (c != null) facts.set(s[1], [c, c]) }
  else if (s[0] === 'br_if' && s.length === 3) { const t = testOf(s[2]); if (t) bound(facts, not(t)) }
}
/** What `t` decides along the way, where its test writes nothing. */
const decided = (facts, e) => {
  if (writes(e)) return OPEN
  const t = testOf(e)
  return t ? decide(facts, t) : OPEN
}
const parts = (s) => {
  const k = label(s) ? 2 : 1, th = s[k + 1], el = s[k + 2]
  return isArr(th) && th[0] === 'then' && (el === undefined || isArr(el) && el[0] === 'else') ? { k, th, el } : null
}

/** The statements `stmts` run in sequence from what `facts` holds, the tests they decide folded;
 *  null where a construct of a value would have to open. */
const fold = (stmts, facts, out) => {
  for (const s of stmts) {
    if (!isArr(s)) { out.push(s); continue }
    if (s[0] === 'if' && !typed(s)) {
      const p = parts(s), d = p ? decided(facts, s[p.k]) : OPEN
      if (d !== OPEN) {
        const arm = d === HOLDS ? p.th : p.el, body = arm ? arm.slice(1) : []
        // (an arm whose branches name the conditional: a block of that name)
        if (label(s)) { const b = ['block', s[1], ...body]; out.push(b); step(facts, b) }
        else if (!fold(body, facts, out)) return null
        if (out.length && isArr(out[out.length - 1]) && ENDS.has(out[out.length - 1][0])) return out
        continue
      }
    }
    if (s[0] === 'br_if' && s.length === 3) {
      const d = decided(facts, s[2])
      if (d === FAILS) continue
      if (d === HOLDS) { out.push(['br', s[1]]); return out }
    }
    out.push(s)
    if (ENDS.has(s[0])) return out
    step(facts, s)
  }
  return out
}

/** A copy of `stmts` whose constructs' labels are named afresh by `fresh`. */
const copyOf = (stmts, fresh) => {
  const names = new Map()
  const declare = (n) => {
    if (!isArr(n)) return
    if (LABELLED.has(n[0]) && label(n) && !names.has(n[1])) names.set(n[1], fresh(n[1].slice(1)))
    for (let j = 1; j < n.length; j++) declare(n[j])
  }
  stmts.forEach(declare)
  const name = (c) => typeof c === 'string' && names.has(c) ? names.get(c) : c
  const copy = (n) => {
    if (!isArr(n)) return n
    const br = n[0] === 'br' || n[0] === 'br_if' || n[0] === 'br_table'
    return n.map((c, j) => j === 0 ? c : j === 1 && LABELLED.has(n[0]) || br && typeof c === 'string' ? name(c) : copy(c))
  }
  return stmts.map(copy)
}

/** Give each test of `loop` (child `pos` of `parent`) that skips an inner scan the rest of the
 *  round in a copy of its own. */
function latchLoop(loop, parent, pos, fresh) {
  const L = label(loop)
  if (!L || typed(loop)) return
  const last = loop[loop.length - 1]
  if (!isArr(last) || last[1] !== L || !(last[0] === 'br_if' && last.length === 3 || last[0] === 'br' && last.length === 2)) return
  // (the label that leaves the loop: its block's, where the loop ends one, else a block of its own)
  let out = null
  const leave = () => {
    if (out) return out
    if (parent[0] === 'block' && pos === parent.length - 1 && label(parent) && !typed(parent)) return (out = parent[1])
    out = fresh('out')
    parent[pos] = ['block', out, loop]
    return out
  }
  const frames = []
  const visit = (node, from, facts) => {
    for (let i = from; i < node.length; i++) {
      const s = node[i]
      if (!isArr(s)) continue
      if (s[0] === 'br_if' && s.length === 3 && node[0] === 'block' && s[1] === node[1] && frames.length && !ofWords(s[2])
          && node.slice(i + 1).some(n => some(n, m => m[0] === 'loop'))) {
        const f = new Map(facts)
        kill(f, s[2])
        const t = testOf(s[2])
        if (t) bound(f, t)
        const rest = []
        for (let d = frames.length - 1; d >= 0; d--) { const fr = frames[d]; for (let j = fr[1] + 1; j < fr[0].length; j++) rest.push(fr[0][j]) }
        const folded = fold(rest, f, [])
        if (folded && folded.length && !folded.some(n => some(n, m => m[0] === 'loop' || HANDLER.has(m[0])))
            && folded.reduce((a, n) => a + size(n), 0) <= MAX_COPY) {
          const copy = copyOf(folded, fresh), end = copy[copy.length - 1]
          if (!(isArr(end) && ENDS.has(end[0]))) copy.push(['br', leave()])
          node[i] = ['if', s[2], ['then', ...copy]]
        }
      }
      if (s[0] === 'block' && label(s) && !typed(s)) {
        frames.push([node, i]); visit(s, 2, new Map(facts)); frames.pop()
      } else if (s[0] === 'if' && !typed(s)) {
        const p = parts(s)
        if (p) {
          const f = new Map(facts)
          kill(f, s[p.k])
          const t = testOf(s[p.k])
          frames.push([node, i])
          const ft = new Map(f)
          if (t) bound(ft, t)
          visit(p.th, 1, ft)
          if (p.el) { const fe = new Map(f); if (t) bound(fe, not(t)); visit(p.el, 1, fe) }
          frames.pop()
        }
      }
      // (a test given a copy falls through where the branch did: its copy ends in a branch)
      step(facts, s)
    }
  }
  visit(loop, 2, new Map())
}

/** Give the scans of every function in `ast` (a module) a copy of the rest of the round for the
 *  rounds that skip them. */
export function skipLatches(ast) {
  if (!isArr(ast)) return ast
  for (const fn of ast) {
    if (!isArr(fn) || fn[0] !== 'func' || !some(fn, n => n[0] === 'loop')) continue
    const labels = new Set()
    // (a branch by depth would reach another label once code moves: such a function keeps its loops)
    let byDepth = false
    const collect = (n) => {
      if (!isArr(n)) return
      if (LABELLED.has(n[0]) && label(n)) labels.add(n[1])
      if ((n[0] === 'br' || n[0] === 'br_if' || n[0] === 'br_table') && n.slice(1).some(c => typeof c === 'number' || typeof c === 'string' && c[0] >= '0' && c[0] <= '9')) byDepth = true
      for (const c of n) collect(c)
    }
    collect(fn)
    if (byDepth) continue
    let id = 0
    const fresh = (base) => {
      let name = `$${base}_s${id++}`
      while (labels.has(name)) name = `$${base}_s${id++}`
      labels.add(name)
      return name
    }
    // innermost first: a loop's copies hold no loop, and an outer loop does not look inside its inner ones
    const walk = (n) => {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c)) continue
        walk(c)
        if (c[0] === 'loop') latchLoop(c, n, i, fresh)
      }
    }
    walk(fn)
  }
  return ast
}
