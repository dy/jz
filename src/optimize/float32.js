/**
 * Single-precision arithmetic in single precision.
 *
 * `Math.fround` of an operator over `Math.fround`s is the way JS writes float
 * arithmetic, and the way the emitter lowers it is in doubles:
 *
 *   fround(fround(a) * fround(b))   (f64.promote_f32 (f32.demote_f64 (f64.mul
 *                                     (f64.promote_f32 a) (f64.promote_f32 b))))
 *
 * The double's 53 bits hold the exact result of `+`, `-`, `*`, `/` and `sqrt`
 * over two 24-bit operands closely enough that rounding it to single gives
 * what the single operator gives (the double rounding is innocuous where the
 * wide format has at least 2p + 2 bits: Figueroa, "When is double rounding
 * innocuous?", SIGNUM Newsletter 30(3), 1995; 53 ≥ 2·24 + 2). So the operator
 * runs on the singles and the conversions are gone:
 *
 *   (f64.promote_f32 (f32.mul a b))
 *
 * The same holds, trivially, for the operators whose result is one of the
 * values a single holds: `abs`, `neg`, `floor`, `ceil`, `trunc`, `nearest`,
 * `min`, `max`, `copysign`. A constant that is a single's value is that
 * single; `demote` of `promote` is the operand.
 *
 * A local every definition of which is a single's value (`x = fround(x)`, a
 * binding of its own since prepare/split-bindings.js) reads as one. Where
 * every read of it is then converted to single, the local is a single: its
 * definitions store the single and its reads convert nothing.
 *
 * A NaN made canonical under the conversion (`select nan x (x ≠ x)` over a
 * `sqrt`, a `neg`) is made canonical over it instead: a NaN converts to a NaN
 * either way, and the operator below is then one the rule above reads.
 *
 * Runs after the lane vectorizer, whose recognizers read the double form.
 *
 * @module optimize/float32
 */
import { findBodyStart } from '../ir.js'

const isArr = Array.isArray
const BINARY = new Map([['f64.add', 'f32.add'], ['f64.sub', 'f32.sub'], ['f64.mul', 'f32.mul'], ['f64.div', 'f32.div'],
  ['f64.min', 'f32.min'], ['f64.max', 'f32.max'], ['f64.copysign', 'f32.copysign']])
const UNARY = new Map([['f64.sqrt', 'f32.sqrt'], ['f64.abs', 'f32.abs'], ['f64.neg', 'f32.neg'],
  ['f64.floor', 'f32.floor'], ['f64.ceil', 'f32.ceil'], ['f64.trunc', 'f32.trunc'], ['f64.nearest', 'f32.nearest']])

const isPromote = (n) => isArr(n) && n[0] === 'f64.promote_f32' && n.length === 2
const isDemote = (n) => isArr(n) && n[0] === 'f32.demote_f64' && n.length === 2
const singleConst = (n) => isArr(n) && n[0] === 'f64.const' && n.length === 2 && typeof n[1] === 'number' && Number.isFinite(n[1]) && Math.fround(n[1]) === n[1]
const isGet = (n, name) => isArr(n) && n[0] === 'local.get' && n[1] === name && n.length === 2
const isNan = (n) => isArr(n) && n[0] === 'f64.const' && n[1] === 'nan' && n.length === 2
const selfNe = (n, name) => isArr(n) && n[0] === 'f64.ne' && n.length === 3 && isGet(n[1], name) && isGet(n[2], name)
/** `n` as a NaN made canonical, `[value, rebuild]`, or null: the block form the emitter writes or the `tee` form. */
const canonical = (n) => {
  if (!isArr(n)) return null
  if (n[0] === 'select' && n.length === 4 && isNan(n[1]) && isArr(n[2]) && n[2][0] === 'local.tee' && n[2].length === 3 && selfNe(n[3], n[2][1]))
    return [n[2][2], (v) => ['select', n[1], ['local.tee', n[2][1], v], n[3]]]
  if (n[0] === 'block' && n.length === 4 && isArr(n[1]) && n[1][0] === 'result' && n[1][1] === 'f64' &&
      isArr(n[2]) && n[2][0] === 'local.set' && n[2].length === 3 && isArr(n[3]) && n[3][0] === 'select' && n[3].length === 4 &&
      isNan(n[3][1]) && isGet(n[3][2], n[2][1]) && selfNe(n[3][3], n[2][1]))
    return [n[2][2], (v) => ['block', n[1], ['local.set', n[2][1], v], n[3]]]
  return null
}

export function narrowFloat32(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  let any = false
  const seek = (n) => { if (any || !isArr(n)) return; if (n[0] === 'f32.demote_f64' || n[0] === 'f64.promote_f32') { any = true; return } for (let i = 1; i < n.length; i++) seek(n[i]) }
  for (let i = bodyStart; i < fn.length && !any; i++) seek(fn[i])
  if (!any) return

  // The f64 locals every definition of which is a single's value: a `promote`, a
  // constant a single holds, a read of such a local. A parameter holds what it was passed.
  const decls = new Map()   // name → its declaration
  for (let i = 2; i < bodyStart; i++) { const d = fn[i]; if (isArr(d) && d[0] === 'local' && typeof d[1] === 'string' && d[2] === 'f64' && d.length === 3) decls.set(d[1], d) }
  const defs = new Map()    // name → the values stored to it; null where a store has none (a flat form)
  const note = (n) => {
    if (!isArr(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && decls.has(n[1])) {
      const l = defs.get(n[1])
      if (n.length !== 3) defs.set(n[1], null)
      else if (l !== null) { if (l) l.push(n[2]); else defs.set(n[1], [n[2]]) }
    }
    for (let i = 1; i < n.length; i++) note(n[i])
  }
  for (let i = bodyStart; i < fn.length; i++) note(fn[i])
  const singles = new Set()
  for (const [name, l] of defs) if (l) singles.add(name)
  const holds = (v) => isPromote(v) || singleConst(v) || (isArr(v) && (v[0] === 'local.get' || v[0] === 'local.tee') && singles.has(v[1]))
  for (let settled = false; !settled;) {
    settled = true
    for (const name of singles) if (!defs.get(name).every(holds)) { singles.delete(name); settled = false }
  }

  /** The single `n` is the exact widening of, or null. */
  const single = (n) => !isArr(n) ? null
    : isPromote(n) ? n[1]
    : singleConst(n) ? ['f32.const', n[1]]
    : (n[0] === 'local.get' || n[0] === 'local.tee') && singles.has(n[1]) ? ['f32.demote_f64', n]
    : null
  /** `f32.demote_f64` of `x`, in single precision where `x` is an operator over singles. */
  const demote = (x) => {
    if (!isArr(x)) return null
    if (isPromote(x)) return x[1]
    const two = BINARY.get(x[0])
    if (two !== undefined && x.length === 3) {
      const a = single(x[1]), b = single(x[2])
      if (a !== null && b !== null && !(singleConst(x[1]) && singleConst(x[2]))) return [two, a, b]
    }
    const one = UNARY.get(x[0])
    if (one !== undefined && x.length === 2 && !singleConst(x[1])) { const a = single(x[1]); if (a !== null) return [one, a] }
    return null
  }
  let changed = false
  const rewrite = (n) => {
    if (!isArr(n)) return n
    for (let i = 1; i < n.length; i++) if (isArr(n[i])) n[i] = rewrite(n[i])
    if (isDemote(n)) { const out = demote(n[1]); if (out !== null) { changed = true; return out } }
    // the conversion of a NaN made canonical: canonical over the conversion
    else if (isPromote(n) && isDemote(n[1])) {
      const c = canonical(n[1][1]), inner = c && demote(c[0])
      if (inner) { changed = true; return c[1](['f64.promote_f32', inner]) }
    }
    return n
  }
  for (let i = bodyStart; i < fn.length; i++) if (isArr(fn[i])) fn[i] = rewrite(fn[i])
  if (!singles.size) return

  // A local read only through `demote` holds the single itself.
  const wide = new Set()   // read as a double somewhere
  const uses = (n, under) => {
    if (!isArr(n)) return
    if ((n[0] === 'local.get' || n[0] === 'local.tee') && singles.has(n[1]) && !under) wide.add(n[1])
    const d = isDemote(n)
    for (let i = 1; i < n.length; i++) uses(n[i], d && i === 1)
  }
  // a statement's own value is no read: a `tee` there is a `set`, and none is written as one
  for (let i = bodyStart; i < fn.length; i++) uses(fn[i], false)
  const narrow = new Set([...singles].filter(name => !wide.has(name)))
  if (!narrow.size) return
  // what a narrowed local is defined with, as a single
  const store = (v) => isPromote(v) ? v[1] : singleConst(v) ? ['f32.const', v[1]] : narrow.has(v[1]) ? v : ['f32.demote_f64', v]
  const retype = (n) => {
    if (!isArr(n)) return n
    if (isDemote(n) && isArr(n[1]) && (n[1][0] === 'local.get' || n[1][0] === 'local.tee') && narrow.has(n[1][1])) return retype(n[1])
    for (let i = 1; i < n.length; i++) if (isArr(n[i])) n[i] = retype(n[i])
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && narrow.has(n[1])) n[2] = store(n[2])
    return n
  }
  for (let i = bodyStart; i < fn.length; i++) if (isArr(fn[i])) fn[i] = retype(fn[i])
  for (const name of narrow) decls.get(name)[2] = 'f32'
}
