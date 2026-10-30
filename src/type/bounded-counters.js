/**
 * Counters a loop test bounds: the increments of a captured binding (a
 * scanner's position, which its closures read and advance) that run inside a
 * loop whose test keeps the binding below a string's length.
 *
 * Such an increment leaves the binding at most the length plus the steps taken
 * since the test. A string's UTF-16 units fill less than the 4 GiB above the
 * 1 KiB the heap starts past, so its length is under 2^31 - 2^9, and the steps
 * add at most STEP_BUDGET: the value stays an exact int32 however long the loop
 * runs. The integer levels (type/int-certain.js) then read the step as no wider
 * than the binding, and a cell whose every write is an int32 keeps its word
 * (compile/analyze-for-emit.js, the closure-capture narrowing). An array's
 * length bounds nothing here: its header may hold a length no element fills
 * (`new Array(n)`), up to int32's end.
 *
 * An increment counts only where nothing between the test and it can move the
 * binding past the bound: no other write of it (an assignment resets what the
 * test proved, as does one a later conjunct of the test makes), no call of a
 * closure that writes it (directly, or through a closure it calls) and, where a
 * closure that writes it escapes the function's own direct calls, no call at
 * all. A loop inside the loop is judged by its own test; after one that writes
 * the binding or makes such a call, nothing the outer test proved holds.
 *
 * @module type/bounded-counters
 */
import { ctx } from '../ctx.js'
import { K, tagOf, core } from '../summary/kind.js'

// the most a path adds to the binding between the test and a step it counts
const STEP_BUDGET = 256
const LOOPS = new Set(['for', 'while'])
const BRANCHES = new Set(['if', '?:'])
const SHORT = new Set(['&&', '||', '??'])
// a suspension lets other code run before the body goes on
const SUSPEND = new Set(['yield', 'yield*', 'await'])

const constInt = (e) => Array.isArray(e) && e[0] == null && Number.isInteger(e[1]) ? e[1] : null
const stepSize = (e) => { const c = constInt(e); return c != null && c >= 1 ? c : null }

/** The step of an increment of `x` at node `n` (`x++`, `x += c`, `x = x + c`), or null. */
const stepOf = (n, x) => {
  if (!Array.isArray(n)) return null
  if (n[0] === '++' && n[1] === x) return 1
  if (n[0] === '+=' && n[1] === x) return stepSize(n[2])
  if (n[0] === '=' && n[1] === x && Array.isArray(n[2]) && n[2][0] === '+' && n[2].length === 3)
    return n[2][1] === x ? stepSize(n[2][2]) : n[2][2] === x ? stepSize(n[2][1]) : null
  return null
}
/** Whether node `n` writes `x` (an assignment, a compound one, `++`/`--`, a declaration of it). */
const writes = (n, x) => Array.isArray(n) && typeof n[0] === 'string' &&
  ((n[0] === '++' || n[0] === '--' || n[0].endsWith('=') && n[0] !== '==' && n[0] !== '===' && n[0] !== '!=' && n[0] !== '!==' && n[0] !== '<=' && n[0] !== '>=' && n[0] !== '=>') && n[1] === x)

/** The receiver whose length bounds a test's right side (`s.length`, `s.length | 0`), or null. */
const lengthReceiver = (e) => {
  if (Array.isArray(e) && e[0] === '|' && constInt(e[2]) === 0) e = e[1]
  return Array.isArray(e) && e[0] === '.' && e[2] === 'length' && typeof e[1] === 'string' ? e[1] : null
}
/** A string's length, far from int32's end. The summary answers for every
 *  value the binding may hold, a closure's writes included. */
const boundedLength = (e) => {
  const r = lengthReceiver(e)
  return r != null && tagOf(core(ctx.summary?.at(ctx.func.current)?.kindOfExpr(r) ?? 0)) === K.STRING
}
/** Whether a comparison keeps `x` below a bounded length. */
const bounds = (cmp, x) => Array.isArray(cmp) &&
  ((cmp[0] === '<' || cmp[0] === '<=') && cmp[1] === x && boundedLength(cmp[2]) ||
   (cmp[0] === '>' || cmp[0] === '>=') && cmp[2] === x && boundedLength(cmp[1]))

/**
 * The increment nodes of `names` (captured bindings of `body`'s closures) that
 * a loop test bounds, as defined above. `body` is the function owning the
 * bindings, its closures included.
 */
export function boundedSteps(body, names) {
  const out = new Set()
  if (!names?.size) return out
  // Each closure bound to a `const` of the body, and whether every reference
  // to its name is a direct call (else it escapes: unknown code may call it).
  const arrowOf = new Map(), escapes = new Set(), arrows = [], escaped = new Set()
  const visit = (n, parent) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'const') for (let i = 1; i < n.length; i++) {
      const d = n[i]
      // a name bound twice answers for neither closure
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && Array.isArray(d[2]) && d[2][0] === '=>')
        arrowOf.has(d[1]) ? escapes.add(d[1]) : arrowOf.set(d[1], d[2])
    }
    if (n[0] === '=>') arrows.push(n)
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (typeof c === 'string') {
        const declTarget = n[0] === '=' && i === 1 && parent?.[0] === 'const'
        const notRef = (n[0] === '.' || n[0] === '?.') && i === 2 || n[0] === 'str'
        if (!declTarget && !notRef && !(n[0] === '()' && i === 1)) escapes.add(c)
      } else visit(c, n)
    }
  }
  visit(body, null)
  const known = (name) => arrowOf.has(name) && !escapes.has(name)
  const bound = new Set()
  for (const [name, a] of arrowOf) if (known(name)) bound.add(a)
  for (const a of arrows) if (!bound.has(a)) escaped.add(a)
  // An arrow's own statements (its nested arrows are other closures).
  const own = (node, f) => {
    const go = (n) => { if (!Array.isArray(n)) return; if (n[0] === '=>' && n !== node) return; f(n); for (let i = 1; i < n.length; i++) go(n[i]) }
    go(node)
  }
  for (const x of names) {
    // The closures that write x, and whether one escapes.
    const writers = new Set()
    for (const a of arrows) { let w = false; own(a[2], n => { if (writes(n, x)) w = true }); if (w) writers.add(a) }
    const loose = [...writers].some(a => escaped.has(a))
    const memo = new Map()
    // Whether calling a closure may write x: it writes x, or a call it makes may.
    const writesVia = (a) => {
      if (writers.has(a)) return true
      if (memo.has(a)) return memo.get(a)
      memo.set(a, true)   // a cycle back to a closure being judged: assume it writes
      let w = false
      own(a[2], n => { if (!w && n[0] === '()' && unsafeCall(n[1])) w = true })
      memo.set(a, w)
      return w
    }
    const unsafeCall = (callee) => typeof callee === 'string' && known(callee) ? writesVia(arrowOf.get(callee)) : loose
    // What the loop body adds to x since the test, through its paths.
    const merge = (a, b) => ({ dirty: a.dirty || b.dirty, steps: Math.max(a.steps, b.steps) })
    const flow = (n, st) => {
      if (!Array.isArray(n)) return st
      const op = n[0]
      if (op === '=>') return st
      if (LOOPS.has(op) || op === 'do') {
        let moves = false
        own(n, m => { if (writes(m, x) || m[0] === '()' && unsafeCall(m[1])) moves = true })
        return moves ? { dirty: true, steps: st.steps } : st
      }
      if (BRANCHES.has(op)) {
        const c = flow(n[1], st)
        return merge(flow(n[2], c), n.length > 3 ? flow(n[3], c) : c)
      }
      if (SHORT.has(op)) { const a = flow(n[1], st); return merge(a, flow(n[2], a)) }
      const step = stepOf(n, x)
      if (step != null) {
        // its operands are x and a constant: nothing to flow before it
        if (!st.dirty && st.steps + step <= STEP_BUDGET) { out.add(n); return { dirty: false, steps: st.steps + step } }
        return { dirty: true, steps: st.steps }
      }
      let s = st
      for (let i = 1; i < n.length; i++) s = flow(n[i], s)
      if (writes(n, x) || SUSPEND.has(op)) return { dirty: true, steps: s.steps }
      if (op === '()' && unsafeCall(n[1])) return { dirty: true, steps: s.steps }
      return s
    }
    // The state a loop test hands its body: clean after a conjunct that bounds
    // x, then moved by every conjunct evaluated after it; null where none bounds.
    const entry = (cond) => {
      if (bounds(cond, x)) return { dirty: false, steps: 0 }
      if (!Array.isArray(cond) || cond[0] !== '&&') return null
      const l = entry(cond[1])
      return l ? flow(cond[2], l) : entry(cond[2])
    }
    const loop = (n) => {
      if (!Array.isArray(n)) return
      // ['for', init, test, update, body], ['while', test, body]: the update runs after the body
      const st = n[0] === 'for' && n.length === 5 ? entry(n[2]) : n[0] === 'while' ? entry(n[1]) : null
      if (st && n[0] === 'for') flow(n[3], flow(n[4], st))
      else if (st) flow(n[2], st)
      for (let i = 1; i < n.length; i++) loop(n[i])
    }
    loop(body)
  }
  return out
}
