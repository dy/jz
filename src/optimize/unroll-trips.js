/**
 * An innermost loop of a few iterations known at compile time is its body
 * written out once per iteration (speed tier).
 *
 * A stencil's taps, a box window, a fixed-arity reduction run a loop whose
 * counter starts at a literal and stops at one, often only once a function is
 * specialized for its arguments (`for (let k = -r; k <= r; k++)` with r = 4,
 * nine taps). V8 unrolls such a loop fully only below four iterations, and
 * partially otherwise with its exit test kept in every copy, so each tap paid a
 * compare, a branch and the counter's step on the chain of its sums. Written
 * out, the counter is a literal in every copy and the engine folds it into the
 * addresses and the tests it reaches.
 *
 * A loop qualifies where
 *   - its body is straight-line work: no loop, no branch, no `if`, no handler
 *     (a body that branches keeps its branches in every copy, while what the
 *     copies save, the exit test and the counter's step, is the same; a box
 *     blur's clamped edge loops grew its module by a tenth for nothing measurable),
 *     and it has no result;
 *   - it is a top-test loop `(block $b … (loop $l (br_if $b C) BODY (br $l)))`,
 *     the last statement of its block, or a bottom-test loop
 *     `(loop $l BODY (br_if $l C))`;
 *   - C compares an i32 counter with a literal (in a bottom-test loop C may
 *     step it: `(local.tee $k (i32.add (local.get $k) (i32.const s)))`), every
 *     other write of the counter in the loop is one step
 *     `(local.set $k (i32.add (local.get $k) (i32.const s)))` among BODY's own
 *     statements, and the counter is set to a literal by the last write of it
 *     on the straight path before the loop, inside any loop enclosing both;
 *   - its trip count, counted as the wasm words wrap, is at least 4 (below
 *     that V8 writes it out itself) and at most 16, and its body written out
 *     that many times holds at most 300 instructions: LLVM's full-unroll
 *     threshold at -O3, the toolchain whose code jz's is measured against.
 * Labels the body's blocks declare are named afresh in each copy.
 *
 * It runs after watr, on the loops as the passes before it left them (the
 * vectorizer's tap loops among them), and before the passes that read a
 * counted loop's counter (`ringLaps`, `pointerExits`).
 *
 * @module optimize/unroll-trips
 */

const isArr = Array.isArray
export const MIN_TRIPS = 4, MAX_TRIPS = 16, MAX_SIZE = 300
const LISTS = new Set(['func', 'block', 'loop', 'then', 'else'])
const LABELLED = new Set(['block', 'loop', 'if', 'try', 'try_table'])
const WRAPPER = new Set(['then', 'else', 'result', 'param', 'type', 'local', 'export'])
const CMP = {
  'i32.lt_s': (a, b) => a < b, 'i32.le_s': (a, b) => a <= b, 'i32.gt_s': (a, b) => a > b, 'i32.ge_s': (a, b) => a >= b,
  'i32.lt_u': (a, b) => (a >>> 0) < (b >>> 0), 'i32.le_u': (a, b) => (a >>> 0) <= (b >>> 0),
  'i32.gt_u': (a, b) => (a >>> 0) > (b >>> 0), 'i32.ge_u': (a, b) => (a >>> 0) >= (b >>> 0),
  'i32.eq': (a, b) => a === b, 'i32.ne': (a, b) => a !== b,
}

const i32 = (n) => isArr(n) && n[0] === 'i32.const' && n.length === 2 && /^[-+]?(0x[0-9a-f]+|\d+)$/i.test(String(n[1])) ? Number(n[1]) | 0 : null
const get = (n, k) => isArr(n) && n[0] === 'local.get' && n[1] === k
// `(i32.add (local.get $k) (i32.const s))`: s, else null
const stepOf = (n, k) => isArr(n) && n[0] === 'i32.add' && n.length === 3 && get(n[1], k) ? i32(n[2]) : null
const size = (n) => { if (!isArr(n)) return 0; let s = typeof n[0] === 'string' && !WRAPPER.has(n[0]) ? 1 : 0; for (let i = 1; i < n.length; i++) s += size(n[i]); return s }
const some = (n, f) => isArr(n) && (f(n) || n.some((c, i) => i > 0 && some(c, f)))
const writes = (n, k) => some(n, m => (m[0] === 'local.set' || m[0] === 'local.tee') && m[1] === k)

// An i32 operation of two words, as wasm computes it, or undefined.
const ARITH = {
  'i32.add': (a, b) => (a + b) | 0, 'i32.sub': (a, b) => (a - b) | 0, 'i32.mul': (a, b) => Math.imul(a, b),
  'i32.and': (a, b) => a & b, 'i32.or': (a, b) => a | b, 'i32.xor': (a, b) => a ^ b,
  'i32.shl': (a, b) => a << (b & 31), 'i32.shr_s': (a, b) => a >> (b & 31), 'i32.shr_u': (a, b) => (a >>> (b & 31)) | 0,
}
// what a body written out may not hold: it is straight-line work
const STRAIGHT_OUT = new Set(['loop', 'if', 'br', 'br_if', 'br_table', 'return', 'throw', 'throw_ref', 'rethrow', 'try', 'try_table', 'return_call', 'return_call_indirect', 'return_call_ref'])
const HANDLER = new Set(['try', 'try_table', 'catch', 'catch_all', 'catch_ref', 'catch_all_ref', 'delegate'])
const FLOW = new Set(['if', 'block', 'loop', 'br', 'br_if', 'br_table', 'return', 'unreachable', 'try', 'try_table', 'throw', 'return_call', 'return_call_indirect'])

/** The literal values of locals on the straight path into a point: `at(path, x)` is the word
 *  local `x` holds just before the child `path` ends at (the ancestors, each with the index of
 *  the child on the way), or null. The path is followed back to the last statement that writes
 *  x, which runs straight through (no branch, no conditional arm): its evaluation, from the
 *  words it reads there, gives the value; above the head of a loop another iteration's value
 *  arrives. */
const entryValues = () => {
  const memo = new Map()
  const at = (path, x, depth = 0) => {
    if (depth > 8) return null
    for (let d = path.length - 1; d >= 0; d--) {
      const [list, i0] = path[d]
      const listy = LISTS.has(list[0])
      // (what a handler resumes after is unknown)
      if (HANDLER.has(list[0])) return null
      for (let i = i0 - 1; i >= 1; i--) {
        const s = list[i]
        // (an arm runs alone: an else arm's path passes the test, not the then arm)
        if (list[0] === 'if' && isArr(s) && (s[0] === 'then' || s[0] === 'else')) continue
        if (!writes(s, x)) continue
        // (an earlier operand of an instruction ran before, as an earlier statement did)
        if (some(s, m => FLOW.has(m[0]))) return null
        const key = s
        let env = memo.get(key)
        if (!env) {
          env = new Map()
          const before = path.slice(0, d).concat([[list, i]])
          const ev = (n) => {
            if (!isArr(n)) return null
            const op = n[0]
            if (op === 'i32.const') return i32(n)
            if (op === 'local.get') return env.has(n[1]) ? env.get(n[1]) : at(before, n[1], depth + 1)
            if (op === 'local.set' || op === 'local.tee') { const v = n.length === 3 ? ev(n[2]) : null; env.set(n[1], v); return op === 'local.tee' ? v : null }
            const vs = []
            for (let j = 1; j < n.length; j++) if (isArr(n[j])) vs.push(ev(n[j]))
            return ARITH[op] && vs.length === 2 && vs[0] != null && vs[1] != null ? ARITH[op](vs[0], vs[1]) : null
          }
          ev(s)
          memo.set(key, env)
        }
        return env.get(x) ?? null
      }
      // (above a loop's head another iteration's value arrives; a function's start: a parameter)
      if (listy && (list[0] === 'loop' || list[0] === 'func')) return null
    }
    return null
  }
  return at
}

/** The test of `cond`: { k, step, test(k) } where C compares the counter with a word `bound`
 *  gives (a literal, a local the loop does not write), possibly through the counter's own step. */
const testOf = (cond, bound) => {
  if (!isArr(cond) || !CMP[cond[0]] || cond.length !== 3) return null
  let [, a, b] = cond, f = CMP[cond[0]]
  const counter = (n) => isArr(n) && (n[0] === 'local.get' || n[0] === 'local.tee' && n.length === 3) && typeof n[1] === 'string'
  if (!counter(a) || counter(b) && bound(b) == null) { [a, b] = [b, a]; const g = f; f = (x, y) => g(y, x) }
  const c = bound(b)
  if (c == null || !counter(a)) return null
  if (a[0] === 'local.get') return { k: a[1], step: null, test: v => f(v, c) }
  const s = stepOf(a[2], a[1])
  return s == null ? null : { k: a[1], step: s, test: v => f(v, c) }
}

/** The copy `i` of `stmts`, the labels their blocks declare named afresh (nothing branches to them). */
const copyOf = (stmts, i, taken) => {
  const names = new Map()
  const declare = (n) => {
    if (!isArr(n)) return
    if (LABELLED.has(n[0]) && typeof n[1] === 'string' && n[1][0] === '$' && !names.has(n[1])) {
      let name = `${n[1]}_u${i}`
      while (taken.has(name)) name += '_'
      taken.add(name)
      names.set(n[1], name)
    }
    for (let j = 1; j < n.length; j++) declare(n[j])
  }
  stmts.forEach(declare)
  const copy = (n) => {
    if (!isArr(n)) return n
    const out = n.map((c, j) => j === 0 ? c : copy(c))
    if (LABELLED.has(n[0]) && names.has(n[1])) out[1] = names.get(n[1])
    return out
  }
  return stmts.map(copy)
}

/** Write out the qualifying loops of every function in `module`. */
export function unrollTrips(module) {
  if (!isArr(module)) return module
  for (const fn of module) {
    if (!isArr(fn) || fn[0] !== 'func' || !some(fn, n => n[0] === 'loop')) continue
    const taken = new Set(), at = entryValues()
    some(fn, n => { if (LABELLED.has(n[0]) && typeof n[1] === 'string') taken.add(n[1]); return false })
    const visit = (n, path) => {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c)) continue
        path.push([n, i])
        visit(c, path)
        path.pop()
        if (c[0] === 'loop' && LISTS.has(n[0])) {
          const out = unrollAt(c, n, i, path, taken, at)
          if (out) { n.splice(i, 1, ...out); i += out.length - 1 }
        }
      }
    }
    visit(fn, [])
  }
  return module
}

// The statements that replace `loop` (child `pos` of the statement list `list`, `path` its
// ancestors), or null. `at` reads a local's word on the way in.
function unrollAt(loop, list, pos, path, taken, at) {
  const label = typeof loop[1] === 'string' && loop[1][0] === '$' ? loop[1] : null
  if (!label) return null
  const body = loop.slice(2)
  if (body.some(s => isArr(s) && (s[0] === 'result' || s[0] === 'param' || s[0] === 'type'))) return null
  // straight-line work: no inner loop, no branch, no choice, no handler
  const first = body[0], last = body[body.length - 1]
  let shape, cond, inner
  if (isArr(last) && last[0] === 'br' && last[1] === label && last.length === 2 &&
      isArr(first) && first[0] === 'br_if' && first.length === 3 && list[0] === 'block' && list[1] === first[1] && pos === list.length - 1) {
    shape = 'top'; cond = first[2]; inner = body.slice(1, -1)
  } else if (isArr(last) && last[0] === 'br_if' && last[1] === label && last.length === 3) {
    shape = 'bottom'; cond = last[2]; inner = body.slice(0, -1)
  } else return null
  if (inner.some(s => some(s, m => STRAIGHT_OUT.has(m[0])))) return null
  const into = path.concat([[list, pos]])
  // a bound: a literal, or a local the loop leaves alone that holds a word on the way in
  const bound = (b) => i32(b) ?? (isArr(b) && b[0] === 'local.get' && typeof b[1] === 'string' && !writes(loop, b[1]) ? at(into, b[1]) : null)
  const t = testOf(cond, bound)
  if (!t || (shape === 'top' && t.step != null)) return null
  const { k } = t
  // the counter's writes: its steps among the body's own statements, the step of the test
  let step = t.step
  for (const s of inner) {
    if (isArr(s) && s[0] === 'local.set' && s[1] === k && s.length === 3 && stepOf(s[2], k) != null && !writes(s[2], k)) {
      if (step != null) return null
      step = stepOf(s[2], k)
    } else if (writes(s, k)) return null
  }
  if (!step) return null
  const k0 = at(into, k)
  if (k0 == null) return null
  // the trips, as the words wrap
  let trips = 0, v = k0
  if (shape === 'top') { while (!t.test(v)) { if (++trips > MAX_TRIPS) return null; v = (v + step) | 0 } }
  else { for (;;) { if (++trips > MAX_TRIPS) return null; v = (v + step) | 0; if (!t.test(v)) break } }
  if (trips < MIN_TRIPS) return null
  if (trips * inner.reduce((s, x) => s + size(x), 0) > MAX_SIZE) return null
  // (a bottom test that steps the counter leaves the step in each copy)
  const tail = shape === 'bottom' && t.step != null ? [['local.set', k, ['i32.add', ['local.get', k], ['i32.const', String(t.step)]]]] : []
  const out = []
  for (let i = 0; i < trips; i++) out.push(...copyOf(inner.concat(tail), i, taken))
  return out
}
