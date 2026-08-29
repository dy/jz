/**
 * `{ strict: true }` boundary type-conflict rejection (standalone; runs in
 * both the full-narrow and skip-narrow plan paths) — rejects a call whose
 * argument's statically-certain VAL kind can never coerce to the callee's
 * statically-certain param kind without diverging from JS semantics
 * (NUMBER vs STRING is the canonical pair: `"5" * 2` is 10 in JS, NaN here).
 *
 * @module compile/narrow/strict-boundary
 */

import { ctx, err } from '../../ctx.js'
import { valTypeOf } from '../../kind.js'
import { VAL } from '../../reps.js'
import { inferParams } from '../infer.js'

// Two value-kinds CONFLICT when passing one where the other is expected would
// rely on a JS boundary coercion jz does not implement (so the result diverges).
// NUMBER↔STRING is the canonical pair: `"5" * 2` is 10 in JS but NaN in jz, and a
// STRING passed to a numeric param reads its NaN-boxed bits as an f64. ARRAY/OBJECT
// vs NUMBER/STRING likewise. We treat the four primitive-ish kinds as mutually
// exclusive; BOOL is omitted (it nanboxes to 0/1 and numeric code tolerates it).
const STRICT_CONFLICT = {
  [VAL.NUMBER]: new Set([VAL.STRING, VAL.ARRAY, VAL.OBJECT]),
  [VAL.STRING]: new Set([VAL.NUMBER, VAL.ARRAY, VAL.OBJECT]),
  [VAL.ARRAY]: new Set([VAL.NUMBER, VAL.STRING]),
  [VAL.OBJECT]: new Set([VAL.NUMBER, VAL.STRING]),
}

const kindName = (v) => ({ [VAL.NUMBER]: 'number', [VAL.STRING]: 'string', [VAL.ARRAY]: 'array', [VAL.OBJECT]: 'object' }[v] || 'value')

/**
 * Strict-mode boundary type check (standalone; runs in both the full-narrow and
 * skip-narrow plan paths).
 *
 * jz infers a param's type from how it's used (`x * 2` → number, `s.charCodeAt`
 * → string) or from an explicit default (`x = 0` → number). In permissive mode a
 * caller may pass any type and jz silently computes a divergent result (`"5"*2`
 * is 10 in JS, NaN here). Strict mode is the canonical subset where that misuse
 * is a compile error instead — consistent with strict already rejecting `==`,
 * dynamic dispatch, and `void`.
 *
 * Fires ONLY when BOTH sides are statically certain and conflict:
 *   - the callee param has a known kind (its default-value type, or a settled
 *     `val` rep from body-usage / call-site inference), AND
 *   - the argument expression has a known, conflicting kind (a literal or a
 *     locally-typed binding).
 * An untyped param or untyped arg is never flagged — no false positives on
 * genuinely polymorphic code.
 */
export function strictBoundaryTypeCheck(programFacts) {
  if (!ctx.transform.strict) return
  const { callSites, paramReps } = programFacts

  // Per-callee body-evidence cache: methodEvidence (.charCodeAt→STRING, .push→
  // ARRAY) keyed by param name. Computed lazily, once per callee.
  const bodyEvidence = new Map()
  const evidenceOf = (func) => {
    if (!bodyEvidence.has(func.name)) {
      const names = func.sig.params.map(p => p.name).filter(Boolean)
      bodyEvidence.set(func.name, func.body ? inferParams(func.body, names) : new Map())
    }
    return bodyEvidence.get(func.name)
  }

  // Expected kind of callee param k, from any statically-certain source:
  //   1. explicit default value type — the source's own declaration (x = 0 → number)
  //   2. settled call-site/usage rep `val` (paramReps; present after full narrow)
  //   3. type-exclusive body evidence (methodEvidence; works in skip-narrow path too)
  // First certain source wins; null when the param is genuinely polymorphic.
  const paramKind = (func, k) => {
    const p = func.sig.params[k]
    if (!p) return null
    const def = func.defaults?.[p.name]
    if (def != null) { const dv = valTypeOf(def); if (dv) return dv }
    const repVal = paramReps?.get(func.name)?.get(k)?.val
    if (repVal != null) return repVal
    return evidenceOf(func).get(p.name)?.val ?? null
  }

  for (const cs of callSites) {
    const func = ctx.funcs.map.get(cs.callee)
    if (!func || func.raw || !func.sig) continue
    if (func.rest) continue                       // rest packs args into an array
    for (let k = 0; k < cs.argList.length && k < func.sig.params.length; k++) {
      const want = paramKind(func, k)
      if (want == null) continue
      const conflicts = STRICT_CONFLICT[want]
      if (!conflicts) continue
      const got = valTypeOf(cs.argList[k])
      if (got != null && conflicts.has(got)) {
        const pname = func.sig.params[k].name
        err(`strict mode: ${kindName(want)} parameter '${pname}' of '${cs.callee}' received a ${kindName(got)} argument — jz does not coerce ${kindName(got)}→${kindName(want)} at the call boundary (the result would diverge from JS). Pass a ${kindName(want)}, or { strict: false }.`)
      }
    }
  }
}

