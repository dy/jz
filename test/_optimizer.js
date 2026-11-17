// The WAT probes and compile settings the optimizer-*.js files share.
import { compile } from './util.js'
import { parse, loopCount } from '../scripts/wat-probe.mjs'

// Count `call $NAME` nodes that survive INSIDE a loop within the user function $f
// only (scoped past module builtins, which carry their own loops).
export const findFunc = (tree, name) => { let f = null; const w = n => { if (!Array.isArray(n) || f) return; if (n[0] === 'func' && n[1] === name) { f = n; return } for (const c of n) w(c) }; w(tree); return f }
// PRE-watr (watr:false): these pins assert JZ's OWN passes (hoistInvariantLoop,
// rotateLoops). watr's later inlining splices small helpers' bodies into callers —
// the named `call` disappears while the computation (rightly) stays, so a post-watr
// call count is vacuous-0 for hoist pins and false-0 for keep pins.
export const preWatr = (opt) => typeof opt === 'object' ? { watr: false, ...opt } : { level: opt, watr: false }
// A tier without its late ToInt32 lowering, whose 32-bit range test brings an `if`,
// an `f64.lt` and an `i32.trunc_sat_f64_s` beside every `|0`: for pins on the passes before it.
export const exactToInt32 = (level) => ({ level, guardedToInt32: false })
export const callsInLoop = (src, name, opt = 2) => loopCount(findFunc(parse(src, preWatr(opt)), '$f'), n => n[0] === 'call' && n[1] === name)

export const compileMain = (src, passes = {}) => {
  // Representation pins name the original locals, before slot allocation.
  const wat = compile(src, { wat: true, optimize: { watr: false, coalesceLocals: false, ...passes } })
  return wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
}
