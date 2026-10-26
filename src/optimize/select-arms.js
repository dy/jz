/**
 * A choice whose two arms compute one tree is that tree over a choice of what
 * the arms differ in: `x < 0 ? trunc(c * x - 0.5) : trunc(c * x + 0.5)` is
 * `trunc(c * x + (x < 0 ? -0.5 : 0.5))`, one rounding over a select of two
 * literals, where the branch ran one arm and, on data that decides it,
 * mispredicted half the time (an exponential's sign-dependent rounding, a
 * library's `round` or `sign`). The arms may differ only in leaves (literals,
 * local and global reads), at most two of them; a subtraction of a literal is
 * the addition of its negation, which IEEE 754 defines it as. The shared tree
 * computes nothing the branch did not: each path ran it once.
 *
 * A tee an arm writes into a local no later evaluation reads before setting it
 * again is its value (the inliner's parameter locals, reused for others once
 * dead), so two arms that tee different locals still share their tree. The
 * test evaluates after the arms' leaves now: it may write no local and read
 * none the shared tree writes.
 *
 * It runs after watr, whose inlining and `trunc-choice.js` bring the arms
 * together, and before `select-bits.js`, which takes a float select of literals
 * as a select of their bits.
 *
 * @module optimize/select-arms
 */

import { intRanges } from './int-range.js'

const isArr = Array.isArray
const LEAF = new Set(['local.get', 'global.get', 'f64.const', 'f32.const', 'i32.const', 'i64.const'])
// operations the shared tree may hold: no effect beyond a trap both paths took, no memory
const PURE = /^(?:[if](?:32|64)\.(?:const|add|sub|mul|div|div_s|div_u|rem_s|rem_u|and|or|xor|shl|shr_s|shr_u|rotl|rotr|clz|ctz|popcnt|eqz|eq|ne|lt|lt_s|lt_u|gt|gt_s|gt_u|le|le_s|le_u|ge|ge_s|ge_u|abs|neg|ceil|floor|trunc|nearest|sqrt|min|max|copysign|wrap_i64|extend_i32_s|extend_i32_u|extend8_s|extend16_s|extend32_s|trunc_sat_f64_s|trunc_sat_f64_u|trunc_sat_f32_s|trunc_sat_f32_u|convert_i32_s|convert_i32_u|convert_i64_s|convert_i64_u|demote_f64|promote_f32|reinterpret_f64|reinterpret_f32|reinterpret_i64|reinterpret_i32)|select|local\.get|global\.get)$/
const same = (a, b) => a === b || (isArr(a) && isArr(b) && a.length === b.length && a.every((x, i) => same(x, b[i]))) || (!isArr(a) && !isArr(b) && String(a) === String(b))
const num = n => { const v = typeof n[1] === 'number' ? n[1] : typeof n[1] === 'string' && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(n[1]) ? Number(n[1]) : NaN; return Number.isFinite(v) ? v : null }
// `a - k` as `a + (-k)` (k a finite literal), or the node itself
const addForm = n => {
  if (!isArr(n) || n.length !== 3 || (n[0] !== 'f64.sub' && n[0] !== 'f32.sub') || !isArr(n[2]) || n[2][0] !== n[0].slice(0, 3) + '.const') return n
  const k = num(n[2])
  return k == null ? n : [n[0].slice(0, 3) + '.add', n[1], [n[2][0], -k]]
}

// A rounding the sign of its operand decides is the truncation: `ceil(a)` where a <= 0,
// `floor(b)` where b >= 0 (NaN rounds to NaN either way), by the function's intervals.
const roundForm = (n, s) => {
  if (!isArr(n) || n.length !== 2) return n
  const t = n[0].slice(0, 4), op = n[0].slice(4)
  if ((t !== 'f64.' && t !== 'f32.') || (op !== 'ceil' && op !== 'floor')) return n
  const v = s.at(n[1])
  return v && (op === 'ceil' ? v.hi <= 0 : v.lo >= 0) ? [t + 'trunc', n[1]] : n
}

// What the evaluation from a point does to local `L` first: 'read', 'write' (or the
// function's end: the value dies), null (nothing yet) or 'unknown' (a branch).
const BRANCH = new Set(['br', 'br_if', 'br_table', 'throw', 'rethrow', 'try', 'try_table', 'delegate', 'return_call', 'return_call_indirect', 'return_call_ref'])
const scan = (n, L) => {
  if (!isArr(n)) return null
  const op = n[0]
  if (op === 'local.get') return n[1] === L ? 'read' : null
  if (op === 'if') {
    let i = 1
    if (typeof n[i] === 'string') i++
    while (isArr(n[i]) && (n[i][0] === 'result' || n[i][0] === 'param' || n[i][0] === 'type')) i++
    const c = scan(n[i], L)
    if (c) return c
    const arms = n.slice(i + 1).map(a => scanSeq(isArr(a) ? a.slice(1) : [], L))
    while (arms.length < 2) arms.push(null)
    return arms[0] === arms[1] ? arms[0] : arms.includes('read') ? 'read' : 'unknown'
  }
  if (op === 'block' || op === 'loop') return scanSeq(n.slice(1), L)
  for (let i = 1; i < n.length; i++) { const r = scan(n[i], L); if (r) return r }
  if ((op === 'local.set' || op === 'local.tee') && n[1] === L) return 'write'
  if (op === 'return' || op === 'unreachable') return 'write'
  if (BRANCH.has(op)) return 'unknown'
  return null
}
const scanSeq = (list, L) => { for (const n of list) { const r = scan(n, L); if (r) return r } return null }
// After the node at the end of `path` (its ancestors, each [node, index of the child]):
// whether the value a tee there stores is read before the local is set again.
const deadAfter = (path, L) => {
  for (let k = path.length - 1; k >= 0; k--) {
    const [p, i] = path[k], op = p[0]
    if (op === 'func') { const r = scanSeq(p.slice(i + 1), L); return r !== 'read' && r !== 'unknown' }
    if (op === 'if') {
      // the test: the arms follow; an arm: what follows the `if`
      const arms = p.filter(c => isArr(c) && (c[0] === 'then' || c[0] === 'else'))
      if (!arms.includes(p[i])) {
        const r = arms.map(a => scanSeq(a.slice(1), L))
        while (r.length < 2) r.push(null)
        if (r[0] !== r[1]) return r.includes('read') || r.includes('unknown') ? false : null
        if (r[0]) return r[0] === 'write'
      }
      continue
    }
    // (the rest of a block or a loop body, then what follows it: a branch back is 'unknown')
    if (BRANCH.has(op) && op !== 'br_if') return false
    const r = scanSeq(p.slice(i + 1), L)
    if (r) return r === 'write'
    if (op === 'br_if' || op === 'br_table') return false
    if ((op === 'local.set' || op === 'local.tee') && p[1] === L) return true
  }
  return false
}

/**
 * The tree `a` and `b` share, over selects (`select(x, y, cond)`) of the leaves they
 * differ in, or null. `pa`/`pb` are their paths; `sel` collects the selects, `writes`
 * the locals the shared tree tees.
 */
const merge = (a, b, pa, pb, s) => {
  if (same(a, b) && pure(a)) return a
  if (!isArr(a) || !isArr(b)) return null
  // a dead tee is its value
  if (a[0] === 'local.tee' && (b[0] !== 'local.tee' || b[1] !== a[1]) && deadAfter(pa, a[1])) return merge(a[2], b, [...pa, [a, 2]], pb, s)
  if (b[0] === 'local.tee' && (a[0] !== 'local.tee' || a[1] !== b[1]) && deadAfter(pb, b[1])) return merge(a, b[2], pa, [...pb, [b, 2]], s)
  if (LEAF.has(a[0]) && LEAF.has(b[0])) {
    if (s.sel.length >= 2 || s.type(a) == null || s.type(a) !== s.type(b)) return null
    const sel = ['select', a, b, null]
    s.sel.push(sel)
    return sel
  }
  if (a[0] !== b[0]) {
    const x = addForm(roundForm(a, s)), y = addForm(roundForm(b, s))
    return x !== a || y !== b ? (x[0] === y[0] ? merge(x, y, pa, pb, s) : null) : null
  }
  if (a.length !== b.length) return null
  if (a[0] === 'local.tee') {
    // (tees of two locals, each live, store apart: no one tree)
    if (a[1] !== b[1]) return null
    const v = merge(a[2], b[2], [...pa, [a, 2]], [...pb, [b, 2]], s)
    if (!v) return null
    s.writes.add(a[1])
    return ['local.tee', a[1], v]
  }
  if (!PURE.test(a[0])) return null
  const out = [a[0]]
  for (let i = 1; i < a.length; i++) {
    if (!isArr(a[i]) || !isArr(b[i])) { if (!same(a[i], b[i])) return null; out.push(a[i]); continue }
    const c = merge(a[i], b[i], [...pa, [a, i]], [...pb, [b, i]], s)
    if (!c) return null
    out.push(c)
  }
  return out
}
const pure = n => !isArr(n) || ((PURE.test(n[0]) || LEAF.has(n[0])) && n.every(pure))
const copy = n => isArr(n) ? n.map(copy) : n
const reads = (n, out = new Set()) => { if (isArr(n)) { if (n[0] === 'local.get' || n[0] === 'local.tee') out.add(n[1]); n.forEach(c => reads(c, out)) } return out }

/** Rewrite each two-armed choice of values in `module`'s functions whose arms share their tree. */
export function selectArms(module) {
  if (!isArr(module)) return module
  for (const fn of module) {
    if (!isArr(fn) || fn[0] !== 'func') continue
    const types = new Map()
    for (const d of fn) if (isArr(d) && (d[0] === 'param' || d[0] === 'local') && typeof d[1] === 'string') types.set(d[1], d[2])
    const type = n => n[0] === 'local.get' ? types.get(n[1]) ?? null : n[0] === 'global.get' ? null : n[0].slice(0, 3)
    // (the intervals, read once before any rewrite where an arm's rounding asks: they key the nodes)
    let av
    const at = n => {
      if (av === undefined) { let k = 2; while (isArr(fn[k]) && ['export', 'type', 'param', 'result', 'local'].includes(fn[k][0])) k++; av = intRanges(fn, k)?.av ?? null }
      return av?.get(n) ?? null
    }
    const visit = (n, path) => {
      for (let i = 1; i < n.length; i++) {
        if (!isArr(n[i])) continue
        const here = [...path, [n, i]]
        visit(n[i], here)
        const c = n[i]
        if (c[0] !== 'if') continue
        let k = 1
        if (typeof c[k] === 'string') k++
        if (!isArr(c[k]) || c[k][0] !== 'result' || c[k].length !== 2) continue
        const test = c[k + 1], then = c[k + 2], other = c[k + 3]
        if (c.length !== k + 4 || !isArr(then) || then[0] !== 'then' || then.length !== 2 || !isArr(other) || other[0] !== 'else' || other.length !== 2) continue
        if (!pure(test)) continue
        const s = { sel: [], writes: new Set(), type, at }
        const tree = merge(then[1], other[1], [...here, [c, k + 2], [then, 1]], [...here, [c, k + 3], [other, 1]], s)
        if (!tree || !s.sel.length) continue
        const tested = reads(test)
        if ([...s.writes].some(x => tested.has(x))) continue
        for (const sel of s.sel) sel[3] = sel !== s.sel[0] ? copy(test) : test
        n[i] = tree
      }
    }
    visit(fn, [])
  }
  return module
}
