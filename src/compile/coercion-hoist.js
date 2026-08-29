import { ctx, inc } from '../ctx.js'
import { typed } from '../ir.js'
import { paramAllUsesNumeric } from './param-numeric.js'

/** Hoist each eligible param's `__to_num` coercion to a single entry `local.set`,
 *  rewriting per-use calls in `stmts` to a bare typed `local.get`. Mutates
 *  `stmts` in place; returns the prologue inits to splice ahead of the body.
 *  Only fires for params whose coercion appears inside a loop (or ≥2×) — a lone
 *  straight-line coercion isn't worth the rebind. */
export function hoistInvariantParamCoercions(stmts, func) {
  const inits = []
  const defaults = func.defaults || {}
  for (const p of func.sig.params) {
    if (p.type !== 'f64' || p.ptrKind != null || p.jsstring) continue
    if (ctx.func.boxed?.has(p.name)) continue
    if (p.name in defaults) continue
    if (!paramAllUsesNumeric(func.body, p.name)) continue
    const pat = (n) => Array.isArray(n) && n[0] === 'call' && n[1] === '$__to_num'
      && Array.isArray(n[2]) && n[2][0] === 'i64.reinterpret_f64'
      && Array.isArray(n[2][1]) && n[2][1][0] === 'local.get' && n[2][1][1] === `$${p.name}`
    let total = 0, inLoop = 0
    const count = (node, depth) => {
      if (!Array.isArray(node)) return
      const d = node[0] === 'loop' ? depth + 1 : depth
      for (let i = 1; i < node.length; i++) {
        if (pat(node[i])) { total++; if (d > 0) inLoop++ }
        else count(node[i], d)
      }
    }
    for (const s of stmts) count(s, 0)
    if (total === 0 || (inLoop === 0 && total < 2)) continue
    const strip = (node) => {
      if (!Array.isArray(node)) return
      for (let i = 1; i < node.length; i++) {
        if (pat(node[i])) node[i] = typed(['local.get', `$${p.name}`], 'f64')
        else strip(node[i])
      }
    }
    for (const s of stmts) strip(s)
    inits.push(['local.set', `$${p.name}`,
      typed(['call', '$__to_num', ['i64.reinterpret_f64', typed(['local.get', `$${p.name}`], 'f64')]], 'f64')])
    inc('__to_num')
  }
  return inits
}

/** Sibling of hoistInvariantParamCoercions for union-CURSOR params (stage 3's
 *  f64 NaN-box carrier): every packed-cell read re-derives the raw cell address
 *  with `i32.wrap_i64(i64.reinterpret_f64($o))`. Strip the repeats to one i32
 *  local bound at entry — a K-field variant then pays one unbox instead of K+1
 *  (and after watr inlines the callee, one per record instead of per read). */
export function hoistUnionCursorUnbox(stmts, func) {
  const cursors = ctx.schema.inlineUnionCursors?.get(func.sig)
  if (!cursors) return []
  const inits = []
  for (const p of func.sig.params) {
    if (p.type !== 'f64' || !cursors.has(p.name)) continue
    if (ctx.func.boxed?.has(p.name)) continue
    const pat = (n) => Array.isArray(n) && n[0] === 'i32.wrap_i64'
      && Array.isArray(n[1]) && n[1][0] === 'i64.reinterpret_f64'
      && Array.isArray(n[1][1]) && n[1][1][0] === 'local.get' && n[1][1][1] === `$${p.name}`
    let total = 0
    const count = (node) => {
      if (!Array.isArray(node)) return
      for (let i = 1; i < node.length; i++) { if (pat(node[i])) total++; else count(node[i]) }
    }
    for (const s of stmts) count(s)
    if (total < 2) continue
    const cell = `${p.name}#cell`
    const strip = (node) => {
      if (!Array.isArray(node)) return
      for (let i = 1; i < node.length; i++) {
        if (pat(node[i])) node[i] = typed(['local.get', `$${cell}`], 'i32')
        else strip(node[i])
      }
    }
    for (const s of stmts) strip(s)
    ctx.func.locals.set(cell, 'i32')
    inits.push(['local.set', `$${cell}`,
      ['i32.wrap_i64', ['i64.reinterpret_f64', typed(['local.get', `$${p.name}`], 'f64')]]])
  }
  return inits
}
