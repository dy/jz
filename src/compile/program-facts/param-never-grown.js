/**
 * program-facts split — cross-function array-param never-grown proof
 * (`analyzeParamNeverGrown`): a param is safe to raw-base-read (skip
 * `__ptr_offset`) iff the body only ever purely reads it AND the whole
 * transitive callee graph is array-growth-free. Independent of the slot
 * censuses (schema-slot facts, not array facts) — see `../program-facts.js`
 * for the full module map and build order.
 * @module program-facts/param-never-grown
 */
import { isLiteralStr, MUTATE_OPS, walkAst } from '../../ast.js'
import { ctx } from '../../ctx.js'
import { VAL, repOf } from '../../reps.js'
import { valTypeOf } from '../../kind.js'
import { typedElemCtor } from '../../type.js'
import { analyzeValueFacts } from '../analyze.js'
import { withValueOverlay } from '../flow-state.js'
import {
  arrayUsesSafe, scanBindingUses, USE, BINDING_USE_DECLS, BINDING_USE_INIT, BINDING_USE_USES, BINDING_USE_KIND,
  BINDING_USE_KEY, BINDING_USE_OP, BINDING_USE_COMPOUND, BINDING_USE_CALLEE, BINDING_USE_ARG_INDEX,
} from '../analyze-scans.js'
import { ARR_RESIZE_METHODS } from './shared.js'
import { frameNode, frameRoots } from '../../function.js'
import { isExported } from '../func-exports.js'

// ————————————————————————— param neverGrown (cross-function) —————————————————————————
// neverGrownCandidate proves never-relocation for fresh-literal LOCALS only; a
// read-only array PARAM (the word-frequency kernel's `words`) re-resolves its
// base through `__ptr_offset` on every element read because the param-holding
// function can't see its callers. The cross-function proof: during any
// activation of f, the array a param holds can only relocate if some code
// RUNNING WITHIN that activation grows an array it can reach — so a param is
// never-grown iff (a) the body only ever purely READS it (arrayUsesSafe: index /
// .length, no aliasing, no passing on), and (b) f's body and every transitive
// callee are ARRAY-GROWTH-FREE: no resize-method call / .length write /
// non-literal-key indexed write on a possibly-ARRAY receiver, and no call
// whose callee we can't resolve (computed callees, closure params, unknown
// methods — any of which could reach user code that grows an alias).
// Name-keyed caller facts (arrResized/nameEscapes) can't express this — the
// builder's `words.push` (its own local) would collide with the kernel's
// read-only param of the same name; the activation-scoped argument doesn't.
// (c) The pointer must arrive live: a caller whose binding went stale before
// the call (`a.toArray(arr)` grew `arr` in the callee, the caller's local
// still boxes the pre-relocation block) passes a box only a forwarding
// follow can read. Liveness is a fixpoint over the program: a value is live
// when it is a fresh array expression, a call whose every return is live, or
// a binding that starts live (so, or as a never-grown param) and whose every
// use reads it, grows it through its own name (the pointer written back,
// own-name-current), returns it, or passes it where the callee only reads
// it. Every visible site must pass a live value; a host caller passes a copy;
// a function some emitted or unknown caller reaches (a dispatcher, an escaped
// name, no visible site) has no proof.
// MEMORY-SAFETY CRITICAL (same class as neverGrownCandidate): default-deny —
// nested arrows are walked as part of the enclosing body (builtin-invoked
// callbacks run within the activation), unknown callees poison.
const _NG_SAFE_CALLEES = new Set([
  'JSON.parse', 'JSON.stringify', 'String.fromCharCode', 'performance.now',
  'Object.keys', 'Object.values', 'Object.entries', 'Number.isInteger',
  'Number.isFinite', 'Number.isNaN', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
])
// Builtin methods that never RELOCATE their receiver nor call user code
// (beyond function-valued args, which are handled separately): pure reads,
// fresh-allocating transforms, and the in-place non-relocating mutators.
const _NG_SAFE_METHODS = new Set([
  'length', 'charCodeAt', 'charAt', 'codePointAt', 'indexOf', 'lastIndexOf',
  'includes', 'slice', 'substring', 'concat', 'join', 'split', 'toString',
  'toLowerCase', 'toUpperCase', 'trim', 'startsWith', 'endsWith', 'repeat',
  'padStart', 'padEnd', 'get', 'set', 'has', 'add', 'delete', 'keys', 'values',
  'entries', 'sort', 'reverse', 'fill', 'copyWithin', 'subarray', 'at',
  'map', 'filter', 'forEach', 'reduce', 'reduceRight', 'some', 'every',
  'find', 'findIndex', 'flat', 'flatMap', 'now',
])
/** Compute per-function array-growth-freedom (poison fixpoint over the direct
 *  call graph) and stamp `paramReps[f][k].neverGrown` for safe-read params.
 *  Consumed at emit via localReps (module/array.js's raw-base fast path). */
export function analyzeParamNeverGrown(paramReps, callSites = [], addressTaken = null) {
  if (!ctx.funcs.list.length) return
  const poisoned = new Set(), edges = new Map(), factsOf = new Map()
  withValueOverlay(null, () => {
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    const facts = analyzeValueFacts(func.body)
    factsOf.set(func.name, facts)
    // Receiver kinds the body facts miss: narrowed param kinds (post-
    // narrowSignatures paramReps) and `{}`-literal decl locals — the
    // dictionary idiom's `const counts = {}` carries no valTypes entry, but
    // ANY object-literal binding is a non-ARRAY receiver.
    const reps = paramReps?.get(func.name)
    const paramIdx = new Map((func.sig?.params || []).map((p, k) => [p.name, k]))
    const objLocals = new Set()
    const collectObjDecls = (n) => walkAst(n, { enter: n => {
      if (n[0] === 'let' || n[0] === 'const') {
        for (let i = 1; i < n.length; i++) {
          const d = n[i]
          if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' &&
              Array.isArray(d[2]) && d[2][0] === '{}') objLocals.add(d[1])
        }
      }
    } })
    collectObjDecls(func.body)
    const out = new Set()
    let dirty = false
    const kindOf = (x) => typeof x === 'string'
      ? (objLocals.has(x) ? VAL.OBJECT
        : paramIdx.has(x) ? (reps?.get(paramIdx.get(x))?.val ?? null)
        : repOf(x)?.val ?? valTypeOf(x))
      : valTypeOf(x)
    // Only ARRAY receivers relocate on growth; an unknown kind could be one.
    // (OBJECT/HASH keyed writes land in slots / dict tables — arena-bump
    // allocation never moves an existing array.)
    const maybeArray = (x) => { const v = kindOf(x); return v == null || v === VAL.ARRAY }
    const scan = (n) => walkAst(n, { enter: n => {
      if (dirty) return false
      const op = n[0]
      if (op === '()') {
        const c = n[1]
        // function-valued ARGUMENT to any call: a builtin may invoke it with
        // receiver state we can't see; a bare func ref gives no edge to walk.
        // (Arrow LITERAL args are fine — their bodies are scanned right here.)
        const argRoot = n[2]
        const args = Array.isArray(argRoot) && argRoot[0] === ',' ? argRoot.slice(1) : argRoot === undefined ? [] : [argRoot]
        for (const a of args) if (typeof a === 'string' && ctx.funcs.map?.has(a)) { dirty = true; return false }
        if (typeof c === 'string') {
          if (ctx.funcs.map?.has(c)) out.add(c)
          else if (!(c.startsWith('math.') || c.startsWith('new.') || _NG_SAFE_CALLEES.has(c))) { dirty = true; return false }
        } else if (Array.isArray(c) && (c[0] === '.' || c[0] === '?.') && typeof c[2] === 'string') {
          // A method name WRITTEN anywhere program-wide could be a user
          // closure shadowing the builtin (the sidecar method fork) — its
          // body is invisible here, so it poisons like any unknown call.
          if (ctx.types.writtenProps?.has(c[2])) { dirty = true; return false }
          if (ARR_RESIZE_METHODS.has(c[2])) {
            if (maybeArray(c[1])) { dirty = true; return false }
          } else if (!_NG_SAFE_METHODS.has(c[2])) { dirty = true; return false }
        } else { dirty = true; return false }   // computed callee — could be any user closure
      } else if (MUTATE_OPS.has(op) && Array.isArray(n[1])) {
        const lhs = n[1]
        if ((lhs[0] === '.' || lhs[0] === '?.') && lhs[2] === 'length') { dirty = true; return false }
        if (lhs[0] === '[]' && !isLiteralStr(lhs[2]) && maybeArray(lhs[1])) { dirty = true; return false }
      }
    } })
    // a parameter default runs in the activation: its growth counts
    withValueOverlay(facts.valTypes, () => { for (const r of frameRoots(func)) scan(r) })
    if (dirty) poisoned.add(func.name)
    else edges.set(func.name, out)
  }
  })
  // Poison propagation: a caller of a poisoned/unknown callee is poisoned.
  let changed = true
  while (changed) {
    changed = false
    for (const [name, out] of edges) {
      if (poisoned.has(name)) continue
      for (const callee of out)
        if (poisoned.has(callee) || !edges.has(callee)) { poisoned.add(name); changed = true; break }
    }
  }
  // The params a body only reads, by function and position.
  const safe = new Map()
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw || poisoned.has(func.name) || !edges.has(func.name)) continue
    const params = func.sig?.params || []
    if (!params.length) continue
    const uses = scanBindingUses(frameNode(func), new Set(params.map(p => p.name)))
    const ks = new Set()
    for (let k = 0; k < params.length; k++) {
      if (func.rest && k === params.length - 1) continue
      if (arrayUsesSafe(uses.get(params[k].name))) ks.add(k)
    }
    if (ks.size) safe.set(func.name, ks)
  }
  // (c): the pointer arrives live at every site (the liveness fixpoint above).
  const sitesOf = new Map()
  for (const site of callSites) {
    if (site.synthetic || !safe.has(site.callee)) continue
    let l = sitesOf.get(site.callee); if (!l) sitesOf.set(site.callee, l = []); l.push(site)
  }
  const byName = new Map(ctx.funcs.list.map(f => [f.name, f]))
  const usesOf = new Map()
  const bindingUses = (f) => { let u = usesOf.get(f.name); if (!u) usesOf.set(f.name, u = scanBindingUses(frameNode(f))); return u }
  const fresh = (a) => Array.isArray(a) && (a[0] === '[' || (a[0] === '()' && (a[1] === 'new.Array' || a[1] === 'Array.from' || a[1] === 'Array.of')))
  // A typed array never relocates: its pointer is live wherever it is.
  const typed = (f, a) => typedElemCtor(a) != null || (typeof a === 'string' && !!f && (factsOf.get(f.name)?.valTypes?.get(a) === VAL.TYPED ||
    paramReps.get(f.name)?.get((f.sig?.params || []).findIndex(p => p.name === a))?.val === VAL.TYPED))
  let liveBindings, liveResults   // memos of one round; a cycle answers no
  const liveValue = (f, a) => fresh(a) || typed(f, a) || (typeof a === 'string' ? !!f && liveBinding(f, a)
    : Array.isArray(a) && a[0] === '()' && typeof a[1] === 'string' && byName.has(a[1]) && liveResult(byName.get(a[1])))
  const liveBinding = (f, name) => {
    const key = f.name + '\0' + name
    if (liveBindings.has(key)) return liveBindings.get(key)
    liveBindings.set(key, false)
    const k = (f.sig?.params || []).findIndex(p => p.name === name)
    let ok
    if (k >= 0) ok = safe.get(f.name)?.has(k) === true
    else {
      const s = f.body && !f.raw ? bindingUses(f).get(name) : null
      ok = !!s && s[BINDING_USE_DECLS] === 1 && liveValue(f, s[BINDING_USE_INIT]) && s[BINDING_USE_USES].every(u => {
        const kind = u[BINDING_USE_KIND], key = u[BINDING_USE_KEY], op = u[BINDING_USE_OP]
        if (kind === USE.MEMBER_R) return key === 'length' || op === '[]'
        if (kind === USE.RETURN) return true
        if (kind === USE.MEMBER_CALL) return op === '.' && key === 'push'
        if (kind === USE.MEMBER_W) return !u[BINDING_USE_COMPOUND] && (key === 'length' || op === '[]')
        if (kind === USE.CALL_ARG) return typeof u[BINDING_USE_CALLEE] === 'string' && safe.get(u[BINDING_USE_CALLEE])?.has(u[BINDING_USE_ARG_INDEX]) === true
        return false
      })
    }
    liveBindings.set(key, ok)
    return ok
  }
  const liveResult = (f) => {
    if (liveResults.has(f.name)) return liveResults.get(f.name)
    liveResults.set(f.name, false)
    let ok = !!f.body && !f.raw
    if (ok) walkAst(f.body, { enter: n => { if (n[0] === '=>') return false; if (n[0] === 'return' && n.length > 1 && !liveValue(f, n[1])) ok = false } })
    liveResults.set(f.name, ok)
    return ok
  }
  for (let changed = true; changed;) {
    changed = false
    liveBindings = new Map(); liveResults = new Map()
    for (const [name, ks] of safe) {
      const func = byName.get(name), sites = sitesOf.get(name) ?? []
      const exported = isExported(func)
      const unknownCaller = func.sig?.dispatcher === true || addressTaken?.has(name) || (!exported && !sites.length)
      for (const k of ks) {
        if (!unknownCaller && sites.every(site => liveValue(site.callerFunc, site.argList[k]))) continue
        ks.delete(k); changed = true
      }
      if (!ks.size) { safe.delete(name); changed = true }
    }
  }
  for (const [name, ks] of safe) {
    let reps = paramReps.get(name)
    if (!reps) paramReps.set(name, reps = new Map())
    for (const k of ks) { const r = reps.get(k); if (r) r.neverGrown = true; else reps.set(k, { neverGrown: true }) }
  }
}
