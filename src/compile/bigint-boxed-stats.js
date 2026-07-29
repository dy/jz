/**
 * Round-3/4 boxed-bigint solver-fact stats collector. JZ_DBG_BIGINT_STATS=1-gated,
 * zero cost otherwise. Diagnostic-only counter used to report how many bindings
 * settled bigintBoxed=true vs raw across a compile — not part of the production
 * compile path.
 */
export const DBG_BIGINT_STATS = typeof process !== 'undefined' && process.env?.JZ_DBG_BIGINT_STATS === '1'

export const bigintBoxedStats = { paramsBoxed: 0, paramsRaw: 0, localsBoxed: new Set(), byFunc: new Map() }
export const resetBigintBoxedStats = () => {
  bigintBoxedStats.paramsBoxed = 0
  bigintBoxedStats.paramsRaw = 0
  bigintBoxedStats.localsBoxed.clear()
  bigintBoxedStats.byFunc.clear()
}

export const noteParamVerdict = (fname, k, boxed) => {
  if (!DBG_BIGINT_STATS) return
  if (boxed) bigintBoxedStats.paramsBoxed++; else bigintBoxedStats.paramsRaw++
  if (boxed) { let s = bigintBoxedStats.byFunc.get(fname); if (!s) bigintBoxedStats.byFunc.set(fname, s = new Set()); s.add(`param${k}`) }
}

export const noteLocalBoxed = (fname, name) => {
  if (!DBG_BIGINT_STATS) return
  bigintBoxedStats.localsBoxed.add(`${fname}::${name}`)
  let s = bigintBoxedStats.byFunc.get(fname); if (!s) bigintBoxedStats.byFunc.set(fname, s = new Set()); s.add(name)
}
