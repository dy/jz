/**
 * Numeric shadows. A local that may hold undefined or null (a checked element
 * read, `let x = null`) is converted at every numeric use: ToNumber is two
 * compares and a select per read, and inside a recursion (`z = z * a + x[i]`)
 * it sits on every iteration's critical path. When every read is numeric the
 * local normalizes on write instead (reps.js numericStorage); a local also read
 * as itself (`return z`) keeps its value, so its ToNumber rides beside it in a
 * shadow local, written with the local at each definition and read by the
 * numeric uses (ir/coerce.js toNumF64, ir/vars.js writeVar, emitDecl).
 *
 * A candidate is a function's own `let`/`const` f64 local, not captured, that
 * the summary may find nullish or absent, written only by its declaration,
 * assignments and updates, and read numerically inside a loop.
 *
 * @module compile/num-shadow
 */
import { ctx } from '../ctx.js'
import { T, ASSIGN_OPS } from '../ast.js'
import { K, hasTag, tagOf, core } from '../summary/kind.js'
import { numericStorage } from '../reps.js'

// A read in these positions converts its operand with ToNumber.
const NUMERIC_OPS = new Set(['-', '*', '/', '%', '**', 'u-', 'u+', '<', '<=', '>', '>='])
const LOOPS = new Set(['for', 'while', 'do', 'for-in', 'for-of'])

/** Plan the shadows of the function whose body is about to be emitted. */
export function planNumericShadows(body, params) {
  const view = ctx.summary?.at(ctx.func.current)
  if (!view || !Array.isArray(body)) return
  const declared = new Set(), bad = new Set(), loopUses = new Set()
  const paramNames = new Set(params.map(p => p.name))
  const numberOf = (e) => tagOf(core(view.kindOfExpr(e))) === K.NUMBER
  const walk = (n, inLoop) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === '=>') return
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (typeof d === 'string') { declared.add(d); continue }
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') { declared.add(d[1]); walk(d[2], inLoop); continue }
        walk(d, inLoop)
        // a pattern binds names this scan does not follow
        markBound(d, bad)
      }
      return
    }
    if (inLoop && typeof n[1] === 'string' && (NUMERIC_OPS.has(op) ||
        op === '+' && n.length === 3 && numberOf(n[2])))
      loopUses.add(n[1])
    if (inLoop && typeof n[2] === 'string' && (NUMERIC_OPS.has(op) && n.length === 3 ||
        op === '+' && numberOf(n[1])))
      loopUses.add(n[2])
    if ((ASSIGN_OPS.has(op) || op === '++' || op === '--') && Array.isArray(n[1])) markBound(n[1], bad)
    const loop = LOOPS.has(op)
    for (let i = 1; i < n.length; i++) walk(n[i], inLoop || loop)
  }
  walk(body, false)
  for (const name of loopUses) {
    if (!declared.has(name) || bad.has(name) || paramNames.has(name)) continue
    if (ctx.func.locals.get(name) !== 'f64' || ctx.func.boxed?.has(name) || numericStorage(name)) continue
    const k = view.kindOf(name)
    if (tagOf(core(k)) !== K.NUMBER || !(hasTag(k, K.NULLISH) || hasTag(k, K.ABSENT))) continue
    const shadow = `${name}${T}num`
    ctx.func.locals.set(shadow, 'f64')
    ;(ctx.func.numShadow ??= new Map()).set(name, shadow)
  }
}

// Names a destructuring target binds: excluded, their writes take other paths.
function markBound(n, out) {
  if (typeof n === 'string') { out.add(n); return }
  if (!Array.isArray(n) || n[0] === '.' || n[0] === '[]' || n[0] === '?.') return
  for (let i = 1; i < n.length; i++) markBound(n[i], out)
}
