/**
 * The length of an array the summary knows for good, read where it is known,
 * is that number (summary/query.js builtLenOf): `const n = coefs.length` of the
 * array a design function built by eight counted pushes is `const n = 8`, and a
 * loop bounded by `n` runs eight times, which the loop passes read off its shape.
 *
 * Only a name's length folds: reading it does nothing a literal does not, the
 * name being an array that is never missing.
 *
 * @module compile/plan/built-lengths
 */
import { ctx } from '../../ctx.js'
import { MUTATE_OPS } from '../../ast.js'

export const foldBuiltLengths = () => {
  let changed = false
  for (const f of ctx.funcs.list) {
    if (!f.body || f.raw) continue
    const view = ctx.summary?.at(f.sig)
    if (!view?.builtLenOf) continue
    const walk = (n) => {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        // a closure reads in a scope of its own
        if (!Array.isArray(c) || c[0] == null || c[0] === 'str' || c[0] === '=>') continue
        if (c[0] === '.' && c[2] === 'length' && typeof c[1] === 'string' && !(i === 1 && MUTATE_OPS.has(n[0]))) {
          const len = view.builtLenOf(c[1])
          if (len != null) { n[i] = [null, len]; changed = true; continue }
        }
        walk(c)
      }
    }
    walk(f.body)
  }
  return changed
}
