import { cloneNode, nodeEqual as exprEq, walkAst } from '../../ast.js'
import { constNum, isI32Const, isLocalGet } from './addr-model.js'
import { normTee } from './idioms.js'
import { isArr } from './node-utils.js'

// ---- Same-array dependences of a lane lift (the general map and stencil) ----
//
// A vector step runs `lanes` iterations at once, so a store and any other access to its base
// must touch elements at least `lanes` apart, or the same element: otherwise a lane reads what
// the scalar loop would not have written yet, or overwrites what it would still read. Every
// index here is affine in the counter at coefficient 1, so the distance between two sites is
// one number for the whole loop: the difference of their linear forms, where the counter
// cancels. A constant distance decides now (the same element or `lanes` apart is fine; closer
// is a windowed recurrence, and the loop declines); an invariant one becomes a check hoisted
// before the loop, `D ≤ −lanes || D ≥ lanes`, one per distinct distance.

/** The i32 index `n` as a constant plus integer multiples of opaque terms (a local, a global,
 *  or a subexpression the form does not decompose), terms keyed by structure. An index
 *  temporary (`defs`) or a tee stands for its value. Arithmetic is modulo 2^32, like the
 *  index itself, so a difference of forms is exact whatever either side wraps to. */
function linearIndex(n, defs) {
  let k = 0
  const terms = new Map()
  const add = (x, m) => {
    if (isI32Const(x)) { k = (k + Math.imul(m, constNum(x))) | 0; return }
    if (isLocalGet(x) && defs?.has(x[1])) return add(defs.get(x[1]), m)
    if (isArr(x) && x[0] === 'local.tee' && x.length === 3) return add(x[2], m)
    if (isArr(x) && (x[0] === 'i32.add' || x[0] === 'i32.sub') && x.length === 3) {
      add(x[1], m); add(x[2], x[0] === 'i32.add' ? m : -m); return
    }
    if (isArr(x) && x[0] === 'i32.mul' && x.length === 3 && isI32Const(x[2])) return add(x[1], Math.imul(m, constNum(x[2])))
    if (isArr(x) && x[0] === 'i32.mul' && x.length === 3 && isI32Const(x[1])) return add(x[2], Math.imul(m, constNum(x[1])))
    if (isArr(x) && x[0] === 'i32.shl' && x.length === 3 && isI32Const(x[2])) return add(x[1], Math.imul(m, 1 << (constNum(x[2]) & 31)))
    const key = JSON.stringify(normTee(x)), t = terms.get(key)
    if (t) t.coeff = (t.coeff + m) | 0
    else terms.set(key, { key, node: x, coeff: m | 0 })
  }
  add(n, 1)
  return { k, terms }
}

/** `a − b` in elements, oriented so equal and opposite distances share one form. */
function distance(a, b, defs) {
  const A = linearIndex(a, defs), B = linearIndex(b, defs)
  for (const t of B.terms.values()) {
    const u = A.terms.get(t.key)
    if (u) u.coeff = (u.coeff - t.coeff) | 0
    else A.terms.set(t.key, { ...t, coeff: -t.coeff | 0 })
  }
  const terms = [...A.terms.values()].filter(t => t.coeff !== 0).sort((x, y) => x.key < y.key ? -1 : x.key > y.key ? 1 : 0)
  let k = (A.k - B.k) | 0
  if (terms.length && terms[0].coeff < 0) { for (const t of terms) t.coeff = -t.coeff | 0; k = -k | 0 }
  return { k, terms }
}

const distanceExpr = ({ k, terms }) => {
  let e = null
  for (const { node, coeff } of terms) {
    const t = coeff === 1 ? cloneNode(node) : ['i32.mul', cloneNode(node), ['i32.const', coeff]]
    e = e ? ['i32.add', e, t] : t
  }
  return k ? ['i32.add', e, ['i32.const', k]] : e
}

/**
 * The hoisted checks that make a lane lift of these sites safe: [] when none is needed, null
 * when the lift must decline. `sites` are `{ kind, base, idx, memBytes }` (a `gather` reads a
 * base no store touches, and pairs with nothing); `defs` resolves index temporaries; `varying`
 * holds every local the loop writes, which a hoisted check cannot read.
 */
export function aliasGuards(sites, stride, lanes, { defs = null, varying, version = true }) {
  const guards = new Map()
  for (const st of sites) {
    if (st.kind !== 'store') continue
    for (const s of sites) {
      if (s === st || s.kind === 'gather' || !exprEq(normTee(s.base), normTee(st.base))) continue
      if ((st.memBytes - s.memBytes) % stride !== 0) return null
      const d = distance(s.idx, st.idx, defs)
      d.k = (d.k + (s.memBytes - st.memBytes) / stride) | 0
      if (!d.terms.length) {
        if (d.k !== 0 && Math.abs(d.k) < lanes) return null
        continue
      }
      if (!version) return null
      let reads = false
      for (const t of d.terms) walkAst(t.node, { enter: c => { if (c[0] === 'local.get' && varying.has(c[1])) reads = true } })
      if (reads) return null
      const key = JSON.stringify([d.k, d.terms.map(t => [t.key, t.coeff])])
      if (guards.has(key)) continue
      const D = distanceExpr(d)
      guards.set(key, ['i32.or',
        ['i32.le_s', D, ['i32.const', -lanes]],
        ['i32.ge_s', cloneNode(D), ['i32.const', lanes]]])
    }
  }
  return [...guards.values()]
}
