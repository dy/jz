/**
 * program-facts split — cross-function array-param never-grown proof
 * (`analyzeParamNeverGrown`): a param is safe to raw-base-read (skip
 * `__ptr_offset`) iff the body only ever purely reads it AND the whole
 * transitive callee graph is array-growth-free. Independent of the slot
 * censuses (schema-slot facts, not array facts) — see `../program-facts.js`
 * for the full module map and build order.
 * @module program-facts/param-never-grown
 */
import { isLiteralStr, MUTATE_OPS } from '../../ast.js'
import { ctx } from '../../ctx.js'
import { VAL, repOf } from '../../reps.js'
import { valTypeOf } from '../../kind.js'
import { analyzeBody } from '../analyze.js'
import { withValueOverlay } from '../flow-state.js'
import { safeReads } from '../analyze-scans.js'
import { ARR_RESIZE_METHODS } from './shared.js'

// ————————————————————————— param neverGrown (cross-function) —————————————————————————
// scanNeverGrown proves never-relocation for fresh-literal LOCALS only; a
// read-only array PARAM (the word-frequency kernel's `words`) re-resolves its
// base through `__ptr_offset` on every element read because the param-holding
// function can't see its callers. The cross-function proof: during any
// activation of f, the array a param holds can only relocate if some code
// RUNNING WITHIN that activation grows an array it can reach — so a param is
// never-grown iff (a) the body only ever purely READS it (safeReads: index /
// .length, no aliasing, no passing on), and (b) f's body and every transitive
// callee are ARRAY-GROWTH-FREE: no resize-method call / .length write /
// non-literal-key indexed write on a possibly-ARRAY receiver, and no call
// whose callee we can't resolve (computed callees, closure params, unknown
// methods — any of which could reach user code that grows an alias).
// Name-keyed caller facts (arrResized/nameEscapes) can't express this — the
// builder's `words.push` (its own local) would collide with the kernel's
// read-only param of the same name; the activation-scoped argument doesn't.
// MEMORY-SAFETY CRITICAL (same class as scanNeverGrown): default-deny —
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
export function analyzeParamNeverGrown(paramReps) {
  if (!ctx.funcs.list.length) return
  const poisoned = new Set(), edges = new Map()
  withValueOverlay(null, () => {
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    const facts = analyzeBody(func.body)
    // Receiver kinds the body facts miss: narrowed param kinds (post-
    // narrowSignatures paramReps) and `{}`-literal decl locals — the
    // dictionary idiom's `const counts = {}` carries no valTypes entry, but
    // ANY object-literal binding is a non-ARRAY receiver.
    const reps = paramReps?.get(func.name)
    const paramIdx = new Map((func.sig?.params || []).map((p, k) => [p.name, k]))
    const objLocals = new Set()
    const collectObjDecls = (n) => {
      if (!Array.isArray(n)) return
      if (n[0] === 'let' || n[0] === 'const' || n[0] === 'var') {
        for (let i = 1; i < n.length; i++) {
          const d = n[i]
          if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' &&
              Array.isArray(d[2]) && d[2][0] === '{}') objLocals.add(d[1])
        }
      }
      for (let i = 1; i < n.length; i++) collectObjDecls(n[i])
    }
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
    const scan = (n) => {
      if (dirty || !Array.isArray(n)) return
      const op = n[0]
      if (op === '()') {
        const c = n[1]
        // function-valued ARGUMENT to any call: a builtin may invoke it with
        // receiver state we can't see; a bare func ref gives no edge to walk.
        // (Arrow LITERAL args are fine — their bodies are scanned right here.)
        const argRoot = n[2]
        const args = Array.isArray(argRoot) && argRoot[0] === ',' ? argRoot.slice(1) : argRoot === undefined ? [] : [argRoot]
        for (const a of args) if (typeof a === 'string' && ctx.funcs.map?.has(a)) { dirty = true; return }
        if (typeof c === 'string') {
          if (ctx.funcs.map?.has(c)) out.add(c)
          else if (!(c.startsWith('math.') || c.startsWith('new.') || _NG_SAFE_CALLEES.has(c))) { dirty = true; return }
        } else if (Array.isArray(c) && (c[0] === '.' || c[0] === '?.') && typeof c[2] === 'string') {
          // A method name WRITTEN anywhere program-wide could be a user
          // closure shadowing the builtin (the sidecar method fork) — its
          // body is invisible here, so it poisons like any unknown call.
          if (ctx.types.writtenProps?.has(c[2])) { dirty = true; return }
          if (ARR_RESIZE_METHODS.has(c[2])) {
            if (maybeArray(c[1])) { dirty = true; return }
          } else if (!_NG_SAFE_METHODS.has(c[2])) { dirty = true; return }
        } else { dirty = true; return }   // computed callee — could be any user closure
      } else if (MUTATE_OPS.has(op) && Array.isArray(n[1])) {
        const lhs = n[1]
        if ((lhs[0] === '.' || lhs[0] === '?.') && lhs[2] === 'length') { dirty = true; return }
        if (lhs[0] === '[]' && !isLiteralStr(lhs[2]) && maybeArray(lhs[1])) { dirty = true; return }
      }
      for (let i = 1; i < n.length; i++) scan(n[i])
    }
    withValueOverlay(facts.valTypes, () => scan(func.body))
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
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw || poisoned.has(func.name) || !edges.has(func.name)) continue
    const params = func.sig?.params || []
    for (let k = 0; k < params.length; k++) {
      if (func.rest && k === params.length - 1) continue
      if (!safeReads(func.body, params[k].name)) continue
      let reps = paramReps.get(func.name)
      if (!reps) paramReps.set(func.name, reps = new Map())
      const r = reps.get(k)
      if (r) r.neverGrown = true
      else reps.set(k, { neverGrown: true })
    }
  }
}
