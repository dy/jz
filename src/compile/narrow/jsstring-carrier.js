/**
 * Externref string-param boundary opt-in — flips an exported function's
 * provably-safe STRING param ('.length'/'.charCodeAt' only, in-bounds via
 * scanBoundedLoops) to a `wasm:js-string` externref, skipping the NaN-boxed
 * f64 carrier at the host boundary. jsstringEnabled gates the whole family on
 * host + opt-out; applyJsstringBoundaryCarrierStandalone is Phase J's entry
 * for the skip-whole-program-narrowing path; adviseJsstringCarrier is a
 * warn-only near-miss diagnostic.
 *
 * @module compile/narrow/jsstring-carrier
 */

import { ctx, warn } from '../../ctx.js'
import { warningsView } from '../../session-views.js'
import { some } from '../../ast.js'
import { isLiteralStr } from '../../ir.js'
import { scanBoundedLoops } from '../../type.js'
import { VAL, updateRep } from '../../reps.js'

/** Gate the jsstring carrier on the host. ON by default for the JS host: a
 *  js-host build is already JS-locked (it imports `env.*`), so the externref +
 *  `wasm:js-string` carrier's JS dependency is free there, and the zero-copy
 *  string-read path is a clear win. OFF under WASI: the carrier needs a JS host,
 *  and wasi builds must stay portable (wasmtime/Go/Rust). Opt out on JS with
 *  `optimize: { jsstring: false }` (e.g. side-by-side benchmarks). */
export function jsstringEnabled() {
  if (!ctx.transform.targetProfile.jsStringInterop) return false
  if (ctx.transform.optimize?.jsstring === false) return false
  return true
}

/** Phase J standalone: runs even when `canSkipWholeProgramNarrowing` short-circuits
 *  the main narrow pass. The check is body-local and export-boundary-only, so call-
 *  site lattice isn't needed; just guard on host and run the use-scan. */
export function applyJsstringBoundaryCarrierStandalone(programFacts) {
  if (!jsstringEnabled()) return
  applyJsstringBoundaryCarrier(new Map(), programFacts.programIndex.addressTaken)
}

// ── jsstring boundary carrier ───────────────────────────────────────────────
//
// Mappable use of an exported string param:
//   - `s.length`               → wasm:js-string.length
//   - `s.charCodeAt(idx)`      → wasm:js-string.charCodeAt — but ONLY when the
//                                index is provably in-bounds (scanBoundedLoops).
//                                The builtin traps on OOB; JS semantics return
//                                NaN. The only way to preserve JS semantics with
//                                zero overhead is to refuse non-bounded use.
// Anything else (concat, indexing `s[i]`, regex, hash key, passing to a non-
// externref param, reassignment, closure capture, `==` with anything, …) is a
// fallback trigger and disqualifies the param.

const JSS_OK_PROPS = new Set(['length', 'charCodeAt'])

/**
 * Decide whether `name` (an exported func's STRING-shaped param) can flow
 * through the boundary as `externref`. Walk the body once: every leaf
 * occurrence of `name` must be the receiver of `.length` (always safe) or
 * `.charCodeAt` whose callee node lives in `safeCC` (provably bounded).
 * Reassignment / `++` / `--` / closure capture all reject conservatively.
 *
 * Returns `{ ok, stringDiscriminating, reason? }` — `stringDiscriminating` is
 * true iff we saw at least one string-only use (`.charCodeAt`); `reason` names
 * the first blocking use when `ok` is false.
 */
function paramAllUsesJsstringMappable(body, name, safeCC) {
  if (body == null) return { ok: false, stringDiscriminating: false, reason: null }
  let ok = true
  let stringDiscriminating = false
  let reason = null
  const fail = (msg) => { ok = false; reason ||= msg }
  const refsParam = (node) => {
    if (node === name) return true
    if (!Array.isArray(node)) return false
    for (let i = 1; i < node.length; i++) if (refsParam(node[i])) return true
    return false
  }
  const walk = (node) => {
    if (!ok) return
    if (typeof node === 'string') {
      if (node === name) fail('bare use of the string param disables the zero-copy externref boundary carrier')
      return
    }
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') {
      const params = node[1]
      const shadowed = Array.isArray(params)
        ? params.some(p => (typeof p === 'string' && p === name) ||
                           (Array.isArray(p) && p[1] === name))
        : params === name
      if (!shadowed) fail('closure capture of the string param disables the zero-copy externref boundary carrier')
      return
    }
    if ((op === '=' || op === '+=' || op === '-=' || op === '*=' || op === '/=' ||
         op === '%=' || op === '&=' || op === '|=' || op === '^=' ||
         op === '>>=' || op === '<<=' || op === '>>>=' ||
         op === '||=' || op === '&&=' || op === '??=' ||
         op === '++' || op === '--') && node[1] === name) {
      fail('reassigning the string param disables the zero-copy externref boundary carrier')
      return
    }
    if (op === '+' && node.slice(1).some(arg => refsParam(arg))) {
      fail('string concatenation on the param disables the zero-copy externref boundary carrier')
      return
    }
    if (op === '.' && node[1] === name && JSS_OK_PROPS.has(node[2])) {
      if (node[2] === 'length') return
      if (safeCC.has(node)) { stringDiscriminating = true; return }
      fail(`\`.${node[2]}\` on the string param disables the zero-copy externref boundary carrier`)
      return
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return { ok, stringDiscriminating, reason }
}

export function applyJsstringBoundaryCarrier(paramReps, addressTaken) {
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.exported) continue
    if (!func.body) continue
    if (func.rest) continue                          // rest position stays packed-array
    if (addressTaken.has(func.name)) continue       // indirect callers may pass non-string
    // Pre-compute the in-bounds .charCodeAt callee nodes once per body.
    const safeCC = new Set()
    scanBoundedLoops(func.body, safeCC)
    const reps = paramReps.get(func.name)
    for (let k = 0; k < func.sig.params.length; k++) {
      const p = func.sig.params[k]
      if (p.type !== 'f64' || p.ptrKind != null) continue
      // String-literal defaults (`s = ''`, `s = 'default'`) are both string-
      // discrimination proof AND substituted JS-side by the interop wrapper —
      // see `jz:extparam` def field. Non-string defaults still disqualify:
      // the wasm side has no way to materialise an arbitrary externref default
      // at boundary-check time without a host import.
      const defVal = func.defaults?.[p.name]
      if (defVal != null && !isLiteralStr(defVal)) continue
      const { ok: usesOk, stringDiscriminating } = paramAllUsesJsstringMappable(func.body, p.name, safeCC)
      if (!usesOk) continue
      const r = reps?.get(k)
      // Skip if any rep says non-STRING (`r.val` set to ARRAY/TYPED at any
      // call site rules out jsstring).
      if (r && r.val != null && r.val !== VAL.STRING) continue
      // Discrimination signal: either a string-discriminating body use
      // (`.charCodeAt`), a call-site proof (`r.val === STRING`), or an
      // explicit string-literal default (the source intent declaration).
      const hasStringDefault = defVal != null && isLiteralStr(defVal)
      if (!stringDiscriminating && r?.val !== VAL.STRING && !hasStringDefault) continue
      p.type = 'externref'
      p.jsstring = true
      updateRep(p.name, { carrier: 'jsstring', val: VAL.STRING })
      if (hasStringDefault) p.jsstringDefault = defVal[1]
    }
  }
}

/** Soft warnings when a string param could use the externref carrier but doesn't. */
export function adviseJsstringCarrier(paramReps, addressTaken) {
  if (!warningsView().warnings || !jsstringEnabled()) return

  for (const func of ctx.funcs.list) {
    if (func.raw || !func.exported || !func.body || func.rest) continue
    if (addressTaken?.has(func.name)) continue

    const safeCC = new Set()
    scanBoundedLoops(func.body, safeCC)
    const reps = paramReps?.get(func.name)

    for (let k = 0; k < func.sig.params.length; k++) {
      const p = func.sig.params[k]
      if (p.jsstring) continue
      if (p.type !== 'f64' || p.ptrKind != null) continue

      const defVal = func.defaults?.[p.name]
      if (defVal != null && !isLiteralStr(defVal)) continue

      const r = reps?.get(k)
      if (r && r.val != null && r.val !== VAL.STRING) continue

      const hasStringDefault = defVal != null && isLiteralStr(defVal)
      const { ok: usesOk, stringDiscriminating, reason } =
        paramAllUsesJsstringMappable(func.body, p.name, safeCC)
      const isCandidate = stringDiscriminating || r?.val === VAL.STRING || hasStringDefault
      if (!isCandidate || usesOk) continue

      warn('jsstring-declined',
        `export '${func.name}' param '${p.name}': ${reason || 'string param uses disable the zero-copy externref boundary carrier'}`,
        { fn: func.name }, func.body.loc)
    }
  }
}

