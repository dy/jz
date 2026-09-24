import { ctx } from '../ctx.js'
import { typed } from '../ir.js'

/** For union-CURSOR params (stage 3's
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
