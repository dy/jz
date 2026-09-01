/**
 * Dynamic-key refinement — a standalone late pass that narrows
 * ctx.types.anyDynKey using post-narrowSignatures type info (a per-function
 * param/local type map proves a `for-in`/computed-index access is never
 * actually dynamic, e.g. a proven TYPED/ARRAY/STRING/BUFFER receiver).
 *
 * @module compile/narrow/dyn-keys
 */

import { ctx } from '../../ctx.js'
import { REFS_THROUGH_ARROWS, walkAst, some } from '../../ast.js'
import { isLiteralStr } from '../../ir.js'
import { VAL } from '../../reps.js'

/**
 * Phase: refine ctx.types.anyDynKey using post-narrowSignatures type info.
 */
const NON_DYN_VTS = new Set([VAL.TYPED, VAL.ARRAY, VAL.STRING, VAL.BUFFER])

const TYPED_ARRAY_CTOR = /^(Float|Int|Uint|BigInt|BigUint)(8|16|32|64)(Clamped)?Array$/

export function refineDynKeys(programFacts) {
  if (!ctx.types.anyDynKey) return
  const { paramReps } = programFacts
  const addressTaken = programFacts.programIndex.addressTaken

  // Per-function type map: param vtypes from paramReps, plus locals
  // we can prove are typed arrays from `let v = new TypedArray(...)`. After
  // prepare, that node is `['()', 'new.Float64Array', ...args]`.
  const buildTypeMap = (funcName, body, params) => {
    const map = new Map()
    if (params) {
      const reps = paramReps.get(funcName)
      if (reps) for (let i = 0; i < params.length; i++) {
        const t = reps.get(i)?.val
        if (t != null) map.set(params[i].name, t)
      }
    }
    walkAst(body, { enter: node => {
      const op = node[0]
      if (op === 'let' || op === 'const') {
        for (let i = 1; i < node.length; i++) {
          const d = node[i]
          if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
          const init = d[2]
          let ctor = null
          if (Array.isArray(init) && init[0] === '()' && typeof init[1] === 'string' && init[1].startsWith('new.'))
            ctor = init[1].slice(4)
          if (ctor && TYPED_ARRAY_CTOR.test(ctor)) map.set(d[1], VAL.TYPED)
          else if (Array.isArray(init) && init[0] === '[') map.set(d[1], VAL.ARRAY)
          else if (typeof init === 'string' && map.has(init)) map.set(d[1], map.get(init))
        }
      }
      if (op === '=>') return false  // don't cross into nested arrows; they're separate funcs
    } })
    return map
  }

  let real = false
  const visit = (typeMap, node) => {
    if (real) return
    // skipArrow: false — recurse into nested arrows too. Closures stay inline
    // (defFunc skips depth>0), so a dynamic-key access captured in one — e.g.
    // `handlers[op]` in a dispatch closure — is reachable only through its
    // parent's body. Matches collectProgramFacts, which also crosses arrows
    // when setting anyDyn; not crossing here let refineDynKeys reset a flag
    // the initial scan correctly raised. Monotone-safe: extra visits only
    // ever raise `real`.
    if (some(node, n => {
      if (n[0] === 'for-in') return true
      if (n[0] !== '[]') return false
      const idx = n[2]
      if (isLiteralStr(idx)) return false
      const obj = n[1]
      const vt = typeof obj === 'string' ? typeMap.get(obj) : null
      return !NON_DYN_VTS.has(vt)
    }, REFS_THROUGH_ARROWS)) real = true
  }

  // Live: anything reachable from exports/first-class value uses. Skipping
  // dead helpers (unused benchlib imports) keeps their generic params from
  // pretending to be dyn-key access.
  const isLive = f => f.exported || paramReps.has(f.name) || addressTaken.has(f.name)

  const topMap = buildTypeMap(null, null, null)
  for (const f of ctx.funcs.list) {
    if (real) break
    if (!f.body || !isLive(f)) continue
    visit(buildTypeMap(f.name, f.body, f.sig?.params), f.body)
  }
  if (!real && ctx.module.initFacts?.anyDyn && ctx.module.moduleInits) for (const mi of ctx.module.moduleInits) {
    if (real) break
    visit(topMap, mi)
  }

  if (!real) ctx.types.anyDynKey = false
}

