/**
 * A test of a choice between literals against a literal is the choice between
 * the test's two answers (after watr):
 *
 *   (f64.ne (select (f64.const 0) (f64.const 1) c) (f64.const 0))  →  (i32.eqz c)
 *
 * A flag the program keeps as a Number (`let inside = true`, set false where a
 * test holds, read by `if (inside)`), which the optimizer folds into one value,
 * chooses its literal by the test and then tests the literal. V8 lowers a float
 * `select` on x64 to a branch around a move, and the test the data decides (a
 * sphere's frustum test: plan/exit-tests.js) mispredicts as often as it goes
 * either way; the answers are words, the choice of words a conditional move, or
 * the test itself. Each arm and the literal it is tested against are folded as
 * the operator computes them; a choice whose answers agree is the answer, its
 * test still run where it may trap or write. A tee of the choice or of an arm
 * into a local nothing reads after it (src/optimize/liveness.js) goes.
 *
 * @module optimize/tested-choices
 */
import { liveSeq } from './liveness.js'

const isArr = Array.isArray
// (sets, not patterns: the compiler compiles itself, and its source keeps to plain string tests)
const LISTS = new Set(['func', 'block', 'loop', 'then', 'else'])
const HEADER = new Set(['export', 'param', 'result', 'local', 'type'])
const CMPS = {
  eq: (a, b) => a === b, ne: (a, b) => a !== b, lt: (a, b) => a < b, gt: (a, b) => a > b, le: (a, b) => a <= b, ge: (a, b) => a >= b,
}
// the effects that keep a test whose answer is known: a write, a call, a trap
const EFFECTS = new Set(['local.set', 'local.tee', 'global.set', 'call', 'call_indirect', 'call_ref', 'br', 'br_if', 'br_table', 'unreachable',
  'block', 'loop', 'if', 'try', 'try_table', 'throw', 'return'])
const effectful = (n) => isArr(n) && (EFFECTS.has(n[0]) || typeof n[0] === 'string' && (n[0].includes('.load') || n[0].includes('.store') || n[0].includes('div') || n[0].includes('rem') || n[0].includes('trunc_f'))) ||
  isArr(n) && n.some((c, i) => i > 0 && effectful(c))

/** The value of a float or integer literal, or null (a NaN's spelling is no number here). */
const literal = (n) => {
  if (!isArr(n) || n.length !== 2 || typeof n[0] !== 'string' || !n[0].endsWith('.const')) return null
  const v = typeof n[1] === 'number' ? n[1] : Number(n[1])
  return Number.isFinite(v) ? v : null
}

/** Fold the tested choices of every function in `ast` (a module). */
export function foldTestedChoices(ast) {
  if (!isArr(ast)) return ast
  for (const fn of ast) {
    if (!isArr(fn) || fn[0] !== 'func') continue
    // the candidates: a comparison with a select operand and a literal one
    const found = []
    const walk = (n) => {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c)) continue
        walk(c)
        if (testOf(c)) found.push([c, n, i])
      }
    }
    walk(fn)
    if (!found.length) continue
    let past = null
    const deadAfter = (tee) => {
      if (!past) {
        past = new Map()
        const mark = (n) => { if (!isArr(n)) return; if (n[0] === 'local.tee') past.set(n, null); for (let i = 1; i < n.length; i++) mark(n[i]) }
        for (const [c] of found) mark(c)
        let body = 1
        for (let i = 1; i < fn.length; i++) if (isArr(fn[i]) && HEADER.has(fn[i][0])) body = i + 1
        liveSeq(['func', ...fn.slice(body)], new Set(), new Map(), new Map(), past)
      }
      const live = past.get(tee)
      return live != null && !live.has(tee[1])
    }
    // a value through its dead tees
    const strip = (n) => isArr(n) && n[0] === 'local.tee' && n.length === 3 && deadAfter(n) ? strip(n[2]) : n
    for (const [c, parent, i] of found) {
      const t = testOf(c)
      const choice = strip(c[t.at]), k = literal(c[3 - t.at])
      if (!isArr(choice) || choice[0] !== 'select' || choice.length !== 4 || k == null) continue
      const a = literal(strip(choice[1])), b = literal(strip(choice[2]))
      if (a == null || b == null) continue
      // (an f32 literal is the f32 nearest its spelling: compared as one)
      const at = t.p === 'f32' ? Math.fround : (v) => v
      const answer = (v) => (t.at === 1 ? CMPS[t.op](at(v), at(k)) : CMPS[t.op](at(k), at(v))) ? 1 : 0
      const ya = answer(a), yb = answer(b), cond = choice[3]
      parent[i] = ya === yb ? (effectful(cond) ? ['block', ['result', 'i32'], ['drop', cond], ['i32.const', ya]] : ['i32.const', ya])
        : ya === 1 ? ['i32.ne', cond, ['i32.const', 0]] : ['i32.eqz', cond]
    }
  }
  return ast
}

// `n` as a comparison of floats with a select on one side: { op, at, p } (`at` the select's
// operand, `p` the float type), else null
const testOf = (n) => {
  if (!isArr(n) || n.length !== 3 || typeof n[0] !== 'string') return null
  const dot = n[0].indexOf('.')
  if (dot !== 3) return null
  const p = n[0].slice(0, 3), op = n[0].slice(4)
  if (!(p === 'f64' || p === 'f32') || !CMPS[op]) return null
  const sel = (x) => isArr(x) && (x[0] === 'select' || x[0] === 'local.tee' && sel(x[2]))
  return sel(n[1]) && literal(n[2]) != null ? { op, at: 1, p } : sel(n[2]) && literal(n[1]) != null ? { op, at: 2, p } : null
}
