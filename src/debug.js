/** Developer-only lifecycle checks. Callers gate these with DBG_INVARIANTS;
 * release builds remove the calls and this module. No compiler policy lives here. */
import { isInactiveFunction } from './compile/active-function.js'

export const DBG_INVARIANTS = typeof process === 'undefined' ? false : process.env?.JZ_DEBUG_INVARIANTS === '1'

const PHASE_ORDER = ['post-reset', 'post-prepare', 'post-compile']
const FEATURE_KEYS = ['sso', 'blockingTimers', 'bigint', 'error', 'errorClasses', 'timers']
let sessionPhase = null, _featureSnapshot = null, _postAnalyze = false, _preAssemble = false
const snapFeatureVal = v => v instanceof Set ? [...v].sort() : v
const snapFeatureEq = (a, b) => Array.isArray(a)
  ? Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])
  : a === b
const snapshotFeatures = (ctx, keys, into) => { for (const k of keys) into[k] = snapFeatureVal(ctx.features[k]); return into }

export function resetInvariants(bridge) {
  sessionPhase = null
  _featureSnapshot = null
  _postAnalyze = false
  _preAssemble = false
  for (const h of ['emit', 'flat', 'body', 'bool', 'idx', 'spread', 'emitIdentitySafe'])
    if (typeof bridge?.[h] !== 'function') throw new Error(`reset: bridge hook '${h}' missing`)
}

export function assertFeatureWrite(key) {
  if (_postAnalyze) throw new Error(`[ctx invariant] ctx.features.${key} written after post-analyze`)
}

export function assertLinkDemandWrite(key) {
  if (_preAssemble) throw new Error(`[ctx invariant] ctx.linkDemand.${key} written after pre-assemble`)
}

export function assertCtxInvariants(ctx, phase) {
  const fail = msg => { throw new Error(`[ctx invariant] ${phase}: ${msg}`) }
  const must = (cond, msg) => { if (!cond) fail(msg) }
  const po = PHASE_ORDER.indexOf(phase)
  if (po >= 0) {
    if (po > 0) must(sessionPhase === PHASE_ORDER[po - 1],
      `phase out of order (previous: '${sessionPhase}', expected '${PHASE_ORDER[po - 1]}')`)
    sessionPhase = phase
  }

  must(ctx.core && ctx.module && ctx.scope && ctx.funcs && ctx.func && ctx.transform && ctx.features && ctx.linkDemand && ctx.plans,
       'sub-contexts present')
  if (phase !== 'pre-reset') {
    must(ctx.core.includes instanceof Set, 'core.includes is Set')
    must(ctx.core.emit && typeof ctx.core.emit === 'object', 'core.emit table')
    must(Array.isArray(ctx.funcs.list), 'funcs.list array')
    must(ctx.funcs.names instanceof Set, 'funcs.names Set')
    must(ctx.funcs.map instanceof Map, 'funcs.map Map')
    must(ctx.funcs.multiProp instanceof Map, 'funcs.multiProp Map')
    must(ctx.func.locals instanceof Map, 'func.locals Map')
    must(ctx.func.refinements === null || ctx.func.refinements instanceof Map, 'func.refinements Map or unallocated')
  }
  if (phase === 'pre-emit') {
    must(ctx.func.current, 'func.current set before emit')
    must(ctx.func.locals.size != null, 'locals open for writes')
  }
  if (phase === 'post-compile')
    must(isInactiveFunction(ctx), 'active function record restored after analysis/emission')

  if (phase === 'post-reset') { _featureSnapshot = null; _postAnalyze = false; _preAssemble = false }
  if (phase === 'post-prepare') _featureSnapshot = snapshotFeatures(ctx, FEATURE_KEYS, {})
  if (phase === 'post-analyze') { _featureSnapshot ??= snapshotFeatures(ctx, FEATURE_KEYS, {}); _postAnalyze = true }
  if (phase === 'pre-assemble') {
    _preAssemble = true
    const present = new Set(Object.keys(ctx.features))
    for (const k of FEATURE_KEYS) {
      must(present.has(k), `ctx.features.${k} missing — every FeaturePlan key must be seeded, not an absent key`)
      if (_featureSnapshot && k in _featureSnapshot)
        must(snapFeatureEq(_featureSnapshot[k], snapFeatureVal(ctx.features[k])),
          `ctx.features.${k} drifted after its settling phase — frozen FeaturePlan facts must not change during emission`)
    }
  }
}

