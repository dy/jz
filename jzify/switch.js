/**
 * switch → if/else + fall-through lowering.
 * @module jzify/switch
 */

/** Flatten a switch clause body to a single node, dropping ASI position markers.
 * Unlike a plain statement list this keeps any `break` intact — transformSwitch
 * needs the breaks to gate fall-through; it rewrites them to a sticky flag. */
export function normalizeCaseBody(body) {
  if (!Array.isArray(body) || body[0] !== ';') return body
  const stmts = body.slice(1).filter(s => s != null && typeof s !== 'number')
  return stmts.length === 0 ? null : stmts.length === 1 ? stmts[0] : [';', ...stmts]
}

const SWITCH_BREAK_BOUNDARIES = new Set(['for', 'for-in', 'for-of', 'while', 'do', 'switch', '=>', 'function', 'class'])

function hasOwnSwitchBreak(node) {
  if (!Array.isArray(node)) return false
  if (node[0] === 'break') return true
  if (SWITCH_BREAK_BOUNDARIES.has(node[0])) return false
  for (let i = 1; i < node.length; i++) if (hasOwnSwitchBreak(node[i])) return true
  return false
}

function rewriteSwitchBreaks(node, flag) {
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op === 'break') return ['=', flag, [null, true]]
  if (SWITCH_BREAK_BOUNDARIES.has(op)) return node

  if (op === ';') {
    const out = []
    const stmts = node.slice(1)
    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i]
      out.push(rewriteSwitchBreaks(stmt, flag))
      if (hasOwnSwitchBreak(stmt) && i < stmts.length - 1) {
        const tail = rewriteSwitchBreaks([';', ...stmts.slice(i + 1)], flag)
        out.push(['if', ['!', flag], tail])
        break
      }
    }
    return out.length === 0 ? null : out.length === 1 ? out[0] : [';', ...out]
  }

  return node.map((part, i) => i === 0 ? part : rewriteSwitchBreaks(part, flag))
}

/** Transform a switch into structured control flow with faithful fall-through.
 *
 * A pure if/else-if chain (the former lowering) can't express fall-through,
 * stacked labels, or a `default` clause that isn't last \u2014 it ran only the first
 * matching body. The correct model is two-phase, evaluated once with no goto:
 *
 *   1. ENTRY \u2014 compare the discriminant against each `case` label in source
 *      order; the first `===` match fixes the entry index. No case matches \u2192
 *      entry = the `default` clause's source index (or past-end if none).
 *   2. RUN \u2014 walk clauses in source order; `entry <= i` runs clause i, so every
 *      clause from the entry onward executes (fall-through). A `break` flips the
 *      sticky `brk` flag (via rewriteSwitchBreaks) and gates the rest.
 *
 * The discriminant is bound to a temp only when re-reading it isn't free/safe; a
 * bare identifier is compared directly \u2014 a synthetic temp would shed its STRING
 * val-type and mis-fold string `case`s to `false` under strict-=== folding. */
export function createSwitchLowering(transform, names) {
  return function transformSwitch(discriminant, cases) {
  const disc = transform(discriminant)
  const simple = typeof disc === 'string' || (Array.isArray(disc) && disc[0] == null)
  const tmp = simple ? disc : names.switchDisc()
  const start = names.switchStart()
  const needsBreakFlag = cases.some(c => hasOwnSwitchBreak(c[0] === 'case' ? c[2] : c[1]))
  const brk = needsBreakFlag ? names.switchBreak() : null

  const n = cases.length
  let defaultIdx = -1
  const bodies = cases.map((c, i) => {
    if (c[0] === 'default') { defaultIdx = i; return transform(c[1]) }
    return transform(c[2])
  })

  const stmts = []
  if (!simple) stmts.push(['let', ['=', tmp, disc]])

  // Phase 1 \u2014 entry index. Init to default's position (or n = "no clause runs"),
  // then let the first matching label override it via an if/else-if chain.
  stmts.push(['let', ['=', start, [null, defaultIdx >= 0 ? defaultIdx : n]]])
  let chain = null
  for (let i = n - 1; i >= 0; i--) {
    if (cases[i][0] !== 'case') continue
    const hit = ['=', start, [null, i]]
    const cond = ['===', tmp, transform(cases[i][1])]
    chain = chain != null ? ['if', cond, hit, chain] : ['if', cond, hit]
  }
  if (chain) stmts.push(chain)
  if (brk) stmts.push(['let', ['=', brk, [null, false]]])

  // Phase 2 \u2014 run clauses from the entry index, falling through until a break.
  for (let i = 0; i < n; i++) {
    if (bodies[i] == null) continue
    const body = brk ? rewriteSwitchBreaks(bodies[i], brk) : bodies[i]
    const reached = ['<=', start, [null, i]]
    stmts.push(['if', brk ? ['&&', ['!', brk], reached] : reached, body])
  }
  return [';', ...stmts]
  }
}
