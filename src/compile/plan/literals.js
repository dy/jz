/**
 * Literal-form heap elision & narrowing.
 *
 * Three related transforms over `let`/`const` literal bindings that the
 * back-end would otherwise allocate on the heap:
 *
 *   - `scalarizeFunctionTypedArrays`  — fixed-size `new Int32Array(N)` etc.
 *                                       whose every use is statically indexed
 *                                       collapse to N WASM locals; element
 *                                       coercion stays inline.
 *   - `scalarizeFunctionArrayLiterals`/`scalarizeFunctionObjectLiterals` —
 *                                       fixed-size `[…]` and `{…}` literals
 *                                       with static accesses collapse to
 *                                       per-slot locals (heap → registers).
 *   - `promoteIntArrayLiterals`       — `let xs = [1,2,3]` with every use
 *                                       typed-array-compatible promotes to
 *                                       `new Int32Array([1,2,3])`. Downstream
 *                                       narrows the carrier to a tight i32 vec.
 *
 * Each wrapper iterates to fixpoint and returns `boolean changed` so the
 * orchestrator knows when to invalidate the program-facts cache.
 *
 * @module compile/plan/literals
 */

import { ctx } from '../../ctx.js'
import {
  some, T, stmtList, refsName, REFS_IN_EXPR, ASSIGN_OPS, isReassigned, hasControlTransfer,
} from '../../ast.js'
import {
  intLiteralValue, nonNegIntLiteral, constIntExpr, staticObjectProps, staticPropertyKey,
} from '../../static.js'
import {
  smallConstForTripCount, containsDeclOf, cloneWithSubst,
} from '../../type.js'
import { VAL } from '../../reps.js'
import { includeModule } from '../../autoload.js'
import { analyzeBody, invalidateLocalsCache } from '../analyze.js'
import {
  isSimpleArg, fixedScalarTypedArray, fixedTypedArraysInBody, maxScalarTypedArrayLen, freshTypedArrayLocals,
} from './common.js'

// === Loop unrolling & scalarization ===

// AST for the store coercion a typed-array element does on write (`arr[i] = v`).
// All expressible with operators jz already lowers post-plan (no module deps).
const coerceAST = (kind, expr) => {
  if (kind === 'i32') return ['|', expr, [null, 0]]
  if (kind === 'i16') return ['>>', ['<<', expr, [null, 16]], [null, 16]]
  if (kind === 'u16') return ['&', expr, [null, 0xffff]]
  if (kind === 'i8') return ['>>', ['<<', expr, [null, 24]], [null, 24]]
  if (kind === 'u8') return ['&', expr, [null, 0xff]]
  return expr
}
const maxScalarTypedLoopUnroll = () => ctx.transform.optimize?.scalarTypedLoopUnroll ?? 16
const maxScalarTypedNestedUnroll = () => ctx.transform.optimize?.scalarTypedNestedUnroll ?? 128

const scalarArrayElems = (expr) => {
  if (!Array.isArray(expr) || expr[0] !== '[') return null
  const elems = expr.slice(1)
  if (elems.some(e => e == null || (Array.isArray(e) && e[0] === '...') || !isSimpleArg(e))) return null
  return elems
}

const scalarObjectProps = (expr) => {
  if (!Array.isArray(expr) || expr[0] !== '{}') return null
  const props = staticObjectProps(expr.slice(1))
  if (!props) return null
  const seen = new Set()
  for (let i = 0; i < props.names.length; i++) {
    const name = props.names[i]
    if (seen.has(name) || !isSimpleArg(props.values[i])) return null
    seen.add(name)
  }
  return props
}

const ASSIGN_TARGET_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '>>=', '<<=', '>>>=', '||=', '&&=', '??='])

// `name.length = n` (resize) / `name.prop op= v` / `++name.length`: a member
// write on the binding can't be modeled by fixed scalar slots — the fold would
// turn the assignment TARGET into a literal (`[null, len] = v`).
const isMemberWriteTarget = (op, node, name) =>
  (ASSIGN_TARGET_OPS.has(op) || op === '++' || op === '--')
  && Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.') && node[1][1] === name

const safeScalarArrayUse = (node, name, len, parentOp = null) => {
  if (typeof node === 'string') return node !== name
  if (!Array.isArray(node)) return true
  const op = node[0]
  if (ASSIGN_TARGET_OPS.has(op) && node[1] === name) return false
  if (isMemberWriteTarget(op, node, name)) return false
  if (isDeclOp(op) && node.slice(1).some(d => d === name || (Array.isArray(d) && d[1] === name))) return false
  if ((op === '.' || op === '?.') && node[1] === name) return node[2] === 'length'
  // Element write `name[idx] (op)= v` / `name[idx]++`: an out-of-bounds index
  // grows the array (sparse-array semantics), which the fixed scalar slot set
  // can't model — reject unless idx is a literal within the literal's bounds.
  if ((ASSIGN_TARGET_OPS.has(op) || op === '++' || op === '--')
      && Array.isArray(node[1]) && node[1][0] === '[]' && node[1][1] === name) {
    const idx = constIntExpr(node[1][2])
    if (idx == null || idx < 0 || idx >= len) return false
    for (let i = 2; i < node.length; i++) if (!safeScalarArrayUse(node[i], name, len, op)) return false
    return true
  }
  if (op === '[]' && node[1] === name) return constIntExpr(node[2]) != null
  if (op === '...' && node[1] === name) return parentOp === '['
  for (let i = 1; i < node.length; i++) {
    if (!safeScalarArrayUse(node[i], name, len, op)) return false
  }
  return true
}

const rewriteScalarArrayUses = (node, arrays, parentOp = null) => {
  if (!Array.isArray(node)) return node
  const op = node[0]
  if ((op === '.' || op === '?.') && arrays.has(node[1]) && node[2] === 'length') {
    return [, arrays.get(node[1]).length]
  }
  if (op === '[]' && arrays.has(node[1])) {
    const idx = constIntExpr(node[2])
    const elems = arrays.get(node[1])
    return idx != null && idx >= 0 && idx < elems.length ? elems[idx] : [, undefined]
  }
  if (op === '[') {
    const out = ['[']
    for (let i = 1; i < node.length; i++) {
      const item = node[i]
      if (Array.isArray(item) && item[0] === '...' && arrays.has(item[1])) {
        out.push(...arrays.get(item[1]))
      } else {
        out.push(rewriteScalarArrayUses(item, arrays, op))
      }
    }
    return out
  }
  return node.map((part, i) => i === 0 ? part : rewriteScalarArrayUses(part, arrays, op))
}

const safeScalarObjectUse = (node, name, keys) => {
  if (typeof node === 'string') return node !== name
  if (!Array.isArray(node)) return true
  const op = node[0]
  if (ASSIGN_TARGET_OPS.has(op) && node[1] === name) return false
  if (isDeclOp(op) && node.slice(1).some(d => d === name || (Array.isArray(d) && d[1] === name))) return false
  if ((op === '.' || op === '?.') && node[1] === name) return keys.has(node[2])
  if (op === '[]' && node[1] === name) {
    const key = staticPropertyKey(node[2])
    return key != null && keys.has(key)
  }
  if (op === '...' && node[1] === name) return false
  for (let i = 1; i < node.length; i++) {
    if (!safeScalarObjectUse(node[i], name, keys)) return false
  }
  return true
}

const rewriteScalarObjectUses = (node, objects) => {
  if (!Array.isArray(node)) return node
  const op = node[0]
  if ((op === '.' || op === '?.') && objects.has(node[1])) {
    const fields = objects.get(node[1])
    return fields.get(node[2]) ?? [, undefined]
  }
  if (op === '[]' && objects.has(node[1])) {
    const key = staticPropertyKey(node[2])
    const fields = objects.get(node[1])
    return key != null ? (fields.get(key) ?? [, undefined]) : node
  }
  return node.map((part, i) => i === 0 ? part : rewriteScalarObjectUses(part, objects))
}

const typedArraySlotIndex = (node, len) => {
  const idx = constIntExpr(node)
  return idx != null && idx >= 0 && idx < len ? idx : null
}

// `coerce` truthy ⇒ the array's element type truncates on store (Int*/Uint* views),
// so in-place updates (`arr[i]++`, `arr[i] += x`) can't be a plain `slot`-op rewrite —
// reject them and only scalarize plain `arr[i] = v` writes and `arr[i]` reads.
const safeScalarTypedArrayUse = (node, name, len, coerce = '') => {
  if (typeof node === 'string') return node !== name
  if (!Array.isArray(node)) return true
  const op = node[0]
  if (isDeclOp(op) && node.slice(1).some(d => d === name || (Array.isArray(d) && d[1] === name))) return false
  if (isMemberWriteTarget(op, node, name)) return false
  if ((op === '.' || op === '?.') && node[1] === name) return node[2] === 'length'
  if (op === '[]' && node[1] === name) return typedArraySlotIndex(node[2], len) != null
  if ((op === '++' || op === '--') && Array.isArray(node[1]) && node[1][0] === '[]' && node[1][1] === name)
    return !coerce && typedArraySlotIndex(node[1][2], len) != null
  if (ASSIGN_TARGET_OPS.has(op)) {
    if (node[1] === name) return false
    if (Array.isArray(node[1]) && node[1][0] === '[]' && node[1][1] === name) {
      if (coerce && op !== '=') return false
      if (typedArraySlotIndex(node[1][2], len) == null) return false
      for (let i = 2; i < node.length; i++) if (!safeScalarTypedArrayUse(node[i], name, len, coerce)) return false
      return true
    }
  }
  if (op === '...' && node[1] === name) return false
  for (let i = 1; i < node.length; i++) if (!safeScalarTypedArrayUse(node[i], name, len, coerce)) return false
  return true
}

// `name`'s reference used as a bare VALUE — anywhere except as the base of `name[i]`,
// `name.prop`, or `name.method(...)`. That captures a second handle to its backing memory.
const refsAsValue = (node, name) => {
  if (node === name) return true
  if (!Array.isArray(node)) return false
  if (node[0] === '[]' && node[1] === name) return refsAsValue(node[2], name)   // name[i]: vet the index only
  if ((node[0] === '.' || node[0] === '?.') && node[1] === name) return false    // name.prop / name.method()
  if (node[0] === '()') return false                                             // a call RESULT, not name itself
  return node.slice(1).some(e => refsAsValue(e, name))
}

// True when `name`'s backing memory ESCAPES into a persistent alias: bound to another
// variable (`let b = name`), stored into a field or literal (`o.x = name`, `[name]`), or
// captured as a `.subarray(...)` view. Mirrored scalarization syncs scalars↔memory only
// AROUND each unsafe statement, so a write through the captured alias in a LATER statement
// never reaches `name`'s scalar slots (and vice-versa) — the array must stay memory-backed.
// A bare `name` passed only as a call ARGUMENT is transient (the callee touches it during
// the call, already covered by the surrounding sync), so it is NOT a capture.
const createsTypedArrayAlias = (node, name) => {
  if (!Array.isArray(node)) return false
  if (node[0] === '()' && Array.isArray(node[1]) && node[1][0] === '.'
      && node[1][1] === name && node[1][2] === 'subarray') return true           // zero-copy view
  if (node[0] === '=' && refsAsValue(node[2], name)) return true                  // let b = name / x = name
  if ((node[0] === '[' || node[0] === '{}') && node.slice(1).some(e => refsAsValue(e, name))) return true  // [name] / {k:name}
  for (let i = 1; i < node.length; i++) if (createsTypedArrayAlias(node[i], name)) return true
  return false
}
const rewriteScalarTypedArrayUses = (node, arrays) => {
  if (!Array.isArray(node)) return node
  const op = node[0]
  const slotFor = (idxNode, entry) => {
    const idx = typedArraySlotIndex(idxNode, entry.len)
    return idx == null ? null : entry.slots[idx]
  }
  if ((op === '.' || op === '?.') && arrays.has(node[1]) && node[2] === 'length') return [null, arrays.get(node[1]).len]
  if (op === '[]' && arrays.has(node[1])) return slotFor(node[2], arrays.get(node[1])) ?? node
  if ((op === '++' || op === '--') && Array.isArray(node[1]) && node[1][0] === '[]' && arrays.has(node[1][1])) {
    const slot = slotFor(node[1][2], arrays.get(node[1][1]))
    return slot ? [op, slot] : node
  }
  if (ASSIGN_TARGET_OPS.has(op) && Array.isArray(node[1]) && node[1][0] === '[]' && arrays.has(node[1][1])) {
    const entry = arrays.get(node[1][1])
    const slot = slotFor(node[1][2], entry)
    if (!slot) return node
    const rhs = node.slice(2).map(part => rewriteScalarTypedArrayUses(part, arrays))
    return op === '=' && entry.coerce ? ['=', slot, coerceAST(entry.coerce, rhs[0])] : [op, slot, ...rhs]
  }
  return node.map((part, i) => i === 0 ? part : rewriteScalarTypedArrayUses(part, arrays))
}

const scalarTypedArrayStores = (name, entry) =>
  entry.slots.map((slot, i) => ['=', ['[]', name, [null, i]], slot])

const scalarTypedArrayLoads = (name, entry) =>
  entry.slots.map((slot, i) => ['=', slot, ['[]', name, [null, i]]])

const collectScalarTypedArrayWrites = (node, name, len, out = new Set()) => {
  if (!Array.isArray(node)) return out
  const op = node[0]
  const addSlot = target => {
    if (Array.isArray(target) && target[0] === '[]' && target[1] === name) {
      const idx = typedArraySlotIndex(target[2], len)
      if (idx != null) out.add(idx)
      return true
    }
    return false
  }
  if ((op === '++' || op === '--') && addSlot(node[1])) return out
  if (ASSIGN_TARGET_OPS.has(op) && addSlot(node[1])) {
    for (let i = 2; i < node.length; i++) collectScalarTypedArrayWrites(node[i], name, len, out)
    return out
  }
  if (op !== '=>') for (let i = 1; i < node.length; i++) collectScalarTypedArrayWrites(node[i], name, len, out)
  return out
}

const hasScalarTypedArrayRead = (node, name) => {
  if (!Array.isArray(node)) return false
  const op = node[0]
  const isTarget = target => Array.isArray(target) && target[0] === '[]' && target[1] === name
  if ((op === '++' || op === '--') && isTarget(node[1])) return true
  if (ASSIGN_TARGET_OPS.has(op)) {
    if (isTarget(node[1])) {
      if (op !== '=') return true
      for (let i = 2; i < node.length; i++) if (hasScalarTypedArrayRead(node[i], name)) return true
      return false
    }
  }
  if (op === '[]' && node[1] === name) return true
  if (op === '=>') return false
  for (let i = 1; i < node.length; i++) if (hasScalarTypedArrayRead(node[i], name)) return true
  return false
}

const scalarizeTypedArrayLiteralSeq = (seq) => {
  if (!Array.isArray(seq) || seq[0] !== ';') return { node: seq, changed: false }
  let changed = false
  const stmts = seq.slice(1).map(stmt => {
    const r = scalarizeTypedArrayLiterals(stmt)
    changed ||= r.changed
    return r.node
  })

  const candidates = new Map()
  const mirrored = new Map()
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i]
    if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) continue
    const decl = stmt[1]
    if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
    const fixed = fixedScalarTypedArray(decl[2])
    if (fixed == null) continue
    const { len, coerce } = fixed
    let hasSafeUse = false, hasUnsafeUse = false, hasAliasUse = false
    for (let j = 0; j < stmts.length; j++) {
      if (j === i) continue
      if (!refsName(stmts[j], decl[1])) continue
      const safe = safeScalarTypedArrayUse(stmts[j], decl[1], len, coerce)
      hasSafeUse ||= safe
      hasUnsafeUse ||= !safe
      hasAliasUse ||= createsTypedArrayAlias(stmts[j], decl[1])
    }
    if (hasAliasUse) continue   // persistent aliasing view (subarray) — keep memory-backed
    if (hasUnsafeUse && (!hasSafeUse || coerce)) continue
    if (!hasUnsafeUse) candidates.set(decl[1], { index: i, len, coerce, mirrored: false })
    else mirrored.set(decl[1], { index: i, len, coerce, mirrored: true })
  }
  if (!candidates.size && !mirrored.size) return { node: changed ? [';', ...stmts] : seq, changed }

  const arrays = new Map()
  for (const [name, c] of [...candidates, ...mirrored]) {
    const slots = Array.from({ length: c.len }, (_, k) => `${name}${T}ta${ctx.func.uniq++}_${k}`)
    arrays.set(name, { len: c.len, slots, mirrored: c.mirrored, coerce: c.coerce })
  }

  const out = []
  for (let i = 0; i < stmts.length; i++) {
    const entry = [...candidates.entries()].find(([, c]) => c.index === i) ||
      [...mirrored.entries()].find(([, c]) => c.index === i)
    if (entry) {
      const [name] = entry
      const arr = arrays.get(name)
      const { slots } = arr
      if (arr.mirrored) {
        out.push(stmts[i])
        if (slots.length) out.push(['let', ...slots.map(slot => ['=', slot, [null, 0]])])
      } else if (slots.length) {
        out.push(['let', ...slots.map(slot => ['=', slot, [null, 0]])])
      }
      changed = true
      continue
    }
    const unsafe = []
    for (const [name, arr] of arrays) {
      if (arr.mirrored && refsName(stmts[i], name) && !safeScalarTypedArrayUse(stmts[i], name, arr.len, arr.coerce)) unsafe.push([name, arr])
    }
    if (unsafe.length) {
      for (const [name, arr] of unsafe) out.push(...scalarTypedArrayStores(name, arr))
      out.push(stmts[i])
      for (const [name, arr] of unsafe) out.push(...scalarTypedArrayLoads(name, arr))
      changed = true
    } else {
      out.push(rewriteScalarTypedArrayUses(stmts[i], arrays))
    }
  }
  return { node: [';', ...out], changed: true }
}

function scalarizeTypedArrayLiterals(node) {
  if (!Array.isArray(node)) return { node, changed: false }
  if (node[0] === '=>') return { node, changed: false }
  if (node[0] === ';') return scalarizeTypedArrayLiteralSeq(node)
  let changed = false
  const out = [node[0]]
  for (let i = 1; i < node.length; i++) {
    const r = scalarizeTypedArrayLiterals(node[i])
    changed ||= r.changed
    out.push(r.node)
  }
  return changed ? { node: out, changed: true } : { node, changed: false }
}

const containsTypedArrayAccess = (body, names) => some(body, n => n[0] === '[]' && typeof n[1] === 'string' && names.has(n[1]))

function smallScalarTypedForTrip(init, cond, step) {
  const end = smallConstForTripCount(init, cond, step, maxScalarTypedLoopUnroll())
  if (end == null) return null
  const decl = init[1]
  return { name: decl[1], end }
}

const scalarTypedLoopBudget = (body) => {
  if (!Array.isArray(body) || body[0] === '=>') return 1
  if (body[0] === 'for') {
    const trip = smallScalarTypedForTrip(body[1], body[2], body[3])
    return trip ? trip.end * scalarTypedLoopBudget(body[4]) : 1
  }
  let max = 1
  for (let i = 1; i < body.length; i++) max = Math.max(max, scalarTypedLoopBudget(body[i]))
  return max
}

const unrollTypedArrayLoops = (node, names) => {
  if (!Array.isArray(node) || node[0] === '=>') return { node, changed: false }
  if (node[0] === ';') {
    let changed = false
    const out = [';']
    for (const stmt of node.slice(1)) {
      const r = unrollTypedArrayLoops(stmt, names)
      changed ||= r.changed
      if (Array.isArray(r.node) && r.node[0] === ';') out.push(...r.node.slice(1))
      else out.push(r.node)
    }
    return changed ? { node: out, changed: true } : { node, changed: false }
  }
  if (node[0] === '{}') {
    const r = unrollTypedArrayLoops(node[1], names)
    return r.changed ? { node: ['{}', r.node], changed: true } : { node, changed: false }
  }
  if (node[0] === 'for') {
    const trip = smallScalarTypedForTrip(node[1], node[2], node[3])
    if (trip && containsTypedArrayAccess(node[4], names) && scalarTypedLoopBudget(node[4]) * trip.end <= maxScalarTypedNestedUnroll() &&
        !hasControlTransfer(node[4]) && !containsDeclOf(node[4], trip.name) && !isReassigned(node[4], trip.name)) {
      const out = [';']
      for (let i = 0; i < trip.end; i++) {
        const cloned = cloneWithSubst(node[4], new Map([[trip.name, [null, i]]]), new Map())
        const r = unrollTypedArrayLoops(cloned, names)
        out.push(...stmtList(r.node))
      }
      return { node: out, changed: true }
    }
  }
  let changed = false
  const out = [node[0]]
  for (let i = 1; i < node.length; i++) {
    const r = unrollTypedArrayLoops(node[i], names)
    changed ||= r.changed
    out.push(r.node)
  }
  return changed ? { node: out, changed: true } : { node, changed: false }
}

const scalarTypedParamCandidates = (func, sites, fixedByFunc) => {
  if (!sites?.length || func.exported || func.raw || !func.body || !Array.isArray(func.body) || func.body[0] !== '{}') return new Map()
  if (some(func.body, n => n[0] === 'return' || n[0] === 'throw')) return new Map()
  const params = func.sig?.params || []
  const cands = new Map()
  for (let i = 0; i < params.length; i++) {
    const pname = params[i].name
    let len = null, coerce = null, ok = true
    for (const site of sites) {
      const arg = site.argList[i]
      const fixed = typeof arg === 'string' ? fixedByFunc.get(site.callerFunc)?.get(arg) : null
      if (!fixed) { ok = false; break }
      if (len == null) { len = fixed.len; coerce = fixed.coerce }
      else if (len !== fixed.len || coerce !== fixed.coerce) { ok = false; break }
    }
    if (ok && len != null && len <= maxScalarTypedArrayLen()) cands.set(pname, { len, coerce })
  }
  if (!cands.size) return cands
  for (const site of sites) {
    const seen = new Set()
    for (let i = 0; i < params.length; i++) {
      if (!cands.has(params[i].name)) continue
      const arg = site.argList[i]
      if (typeof arg !== 'string' || seen.has(arg)) return new Map()
      seen.add(arg)
    }
  }
  return cands
}

const scalarizeTypedArrayParams = (func, paramCands) => {
  for (const [name, c] of [...paramCands]) if (!safeScalarTypedArrayUse(func.body, name, c.len, c.coerce)) paramCands.delete(name)
  for (const [name] of [...paramCands]) if (!hasScalarTypedArrayRead(func.body, name)) paramCands.delete(name)
  if (!paramCands.size) return { body: func.body, changed: false }
  const arrays = new Map()
  for (const [name, c] of paramCands) {
    arrays.set(name, {
      len: c.len,
      coerce: c.coerce,
      slots: Array.from({ length: c.len }, (_, k) => `${name}${T}tap${ctx.func.uniq++}_${k}`),
    })
  }
  const prologue = []
  const writeback = []
  for (const [name, { len, slots }] of arrays) {
    if (slots.length) prologue.push(['let', ...slots.map((slot, i) => ['=', slot, ['[]', name, [null, i]]])])
    for (const i of collectScalarTypedArrayWrites(func.body, name, len)) writeback.push(['=', ['[]', name, [null, i]], slots[i]])
  }
  const rewritten = stmtList(func.body).map(stmt => rewriteScalarTypedArrayUses(stmt, arrays))
  return { body: ['{}', [';', ...prologue, ...rewritten, ...writeback]], changed: true }
}

export const scalarizeFunctionTypedArrays = (programFacts) => {
  const fixedByFunc = new Map(ctx.func.list.map(func => [func, fixedTypedArraysInBody(func.body)]))
  const sitesByCallee = new Map()
  for (const site of programFacts.callSites) {
    if (!site.callerFunc) continue
    const list = sitesByCallee.get(site.callee)
    if (list) list.push(site); else sitesByCallee.set(site.callee, [site])
  }
  let changed = false
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    const paramCands = scalarTypedParamCandidates(func, sitesByCallee.get(func.name), fixedByFunc)
    const names = new Set([...paramCands.keys(), ...fixedByFunc.get(func).keys()])
    if (names.size) {
      let guard = 0
      while (guard++ < 6) {
        const r = unrollTypedArrayLoops(func.body, names)
        if (!r.changed) break
        func.body = r.node
        changed = true
      }
    }
    const p = scalarizeTypedArrayParams(func, paramCands)
    if (p.changed) { func.body = p.body; changed = true }
    const l = scalarizeTypedArrayLiterals(func.body)
    if (l.changed) { func.body = l.node; changed = true }
    if (changed) invalidateLocalsCache(func.body)
  }
  return changed
}

// Param-distinctness (alias analysis). Marks a function's typed-array params MUTUALLY DISTINCT
// (provably different buffers) when EVERY call site passes a distinct fresh `new TypedArray` local
// for each of them. This is what lets the optimizer's LICM hoist a load from one such param across
// a store to another (the load can't be clobbered) — the alias-analysis-enabled LICM that
// rust/clang get for free (raytrace's sphere loads vs the framebuffer store). Sound because:
//   • a fresh `new TypedArray(N)` is a unique buffer (the allocator returns fresh memory);
//   • requiring ALL typed-array-param args to be fresh-new excludes views/subarrays (not fresh)
//     and forwarded params (not fresh), the only ways two args could alias;
//   • pairwise-distinct arg names rule out the same buffer passed twice;
//   • scalar (non-TYPED) params are ignored — they can't alias a buffer.
// Conservatively all-or-nothing per function: any non-fresh/duplicate typed arg ⇒ no fact.
export const analyzeParamDistinctness = (programFacts) => {
  const freshByFunc = new Map(ctx.func.list.map(func => [func, freshTypedArrayLocals(func.body)]))
  const sitesByCallee = new Map()
  for (const site of programFacts.callSites) {
    if (!site.callerFunc) continue
    const l = sitesByCallee.get(site.callee); l ? l.push(site) : sitesByCallee.set(site.callee, [site])
  }
  for (const func of ctx.func.list) {
    const params = func.sig?.params, sites = sitesByCallee.get(func.name)
    if (!params || !sites?.length) continue
    const typedIdx = []
    for (let i = 0; i < params.length; i++) if (params[i].ptrKind === VAL.TYPED) typedIdx.push(i)
    if (typedIdx.length < 2) continue   // distinctness only matters with ≥2 typed-array params
    let ok = true
    for (const site of sites) {
      const seen = new Set()
      for (const i of typedIdx) {
        const arg = site.argList?.[i]
        if (typeof arg !== 'string' || !freshByFunc.get(site.callerFunc)?.has(arg) || seen.has(arg)) { ok = false; break }
        seen.add(arg)
      }
      if (!ok) break
    }
    if (ok) func.distinctParams = new Set(typedIdx.map(i => params[i].name))
  }
}

const scalarizeArrayLiteralSeq = (seq) => {
  if (!Array.isArray(seq) || seq[0] !== ';') return { node: seq, changed: false }
  let changed = false
  const stmts = seq.slice(1).map(stmt => {
    const r = scalarizeArrayLiterals(stmt)
    changed ||= r.changed
    return r.node
  })

  const candidates = new Map()
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i]
    if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) continue
    const decl = stmt[1]
    if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
    const elems = scalarArrayElems(decl[2])
    if (!elems) continue
    let ok = true
    for (let j = 0; j < stmts.length && ok; j++) {
      if (j === i) continue
      ok = safeScalarArrayUse(stmts[j], decl[1], elems.length)
    }
    if (!ok) continue
    candidates.set(decl[1], { index: i, op: stmt[0], elems })
  }
  if (!candidates.size) return { node: changed ? [';', ...stmts] : seq, changed }

  const arrays = new Map()
  for (const [name, c] of candidates) {
    const temps = c.elems.map((_, k) => `${name}${T}arr${ctx.func.uniq++}_${k}`)
    arrays.set(name, temps)
  }

  const out = []
  for (let i = 0; i < stmts.length; i++) {
    const entry = [...candidates.entries()].find(([, c]) => c.index === i)
    if (entry) {
      const [name, c] = entry
      const temps = arrays.get(name)
      if (temps.length) {
        out.push([c.op, ...temps.map((tmp, k) =>
          ['=', tmp, rewriteScalarArrayUses(c.elems[k], arrays)])])
      }
      changed = true
      continue
    }
    out.push(rewriteScalarArrayUses(stmts[i], arrays))
  }
  return { node: [';', ...out], changed: true }
}

const scalarizeObjectLiteralSeq = (seq, escapes) => {
  if (!Array.isArray(seq) || seq[0] !== ';') return { node: seq, changed: false }
  let changed = false
  const stmts = seq.slice(1).map(stmt => {
    const r = scalarizeObjectLiterals(stmt, escapes)
    changed ||= r.changed
    return r.node
  })

  const candidates = new Map()
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i]
    if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) continue
    const decl = stmt[1]
    if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
    if (escapes.get(decl[1]) !== false) continue
    const props = scalarObjectProps(decl[2])
    if (!props) continue
    const keys = new Set(props.names)
    let ok = true
    for (let j = 0; j < stmts.length && ok; j++) {
      if (j === i) continue
      ok = safeScalarObjectUse(stmts[j], decl[1], keys)
    }
    if (!ok) continue
    candidates.set(decl[1], { index: i, op: stmt[0], props })
  }
  if (!candidates.size) return { node: changed ? [';', ...stmts] : seq, changed }

  const objects = new Map()
  for (const [name, c] of candidates) {
    const fields = new Map()
    for (let i = 0; i < c.props.names.length; i++) {
      fields.set(c.props.names[i], `${name}${T}obj${ctx.func.uniq++}_${i}`)
    }
    objects.set(name, fields)
  }

  const out = []
  for (let i = 0; i < stmts.length; i++) {
    const entry = [...candidates.entries()].find(([, c]) => c.index === i)
    if (entry) {
      const [, c] = entry
      const fields = objects.get(entry[0])
      if (c.props.names.length) {
        out.push([c.op, ...c.props.names.map((prop, k) =>
          ['=', fields.get(prop), rewriteScalarObjectUses(c.props.values[k], objects)])])
      }
      changed = true
      continue
    }
    out.push(rewriteScalarObjectUses(stmts[i], objects))
  }
  return { node: [';', ...out], changed: true }
}

function scalarizeObjectLiterals(node, escapes) {
  if (!Array.isArray(node)) return { node, changed: false }
  if (node[0] === '=>') {
    const r = scalarizeObjectLiterals(node[2], escapes)
    if (!r.changed) return { node, changed: false }
    return { node: [node[0], node[1], r.node], changed: true }
  }
  if (node[0] === ';') return scalarizeObjectLiteralSeq(node, escapes)
  let changed = false
  const out = [node[0]]
  for (let i = 1; i < node.length; i++) {
    const r = scalarizeObjectLiterals(node[i], escapes)
    changed ||= r.changed
    out.push(r.node)
  }
  return changed ? { node: out, changed: true } : { node, changed: false }
}

// === Whole-program constant fold of module-scope aggregate literals ===
//
// `var x = [1,2,3]; export const y = x[0]` materializes a data-segment array and
// indexes it through __arr_idx_known (bounds + grow-forwarding) — all dead weight
// for a never-grown constant. When EVERY reference to a module-scope const aggregate
// is a static READ, replace each `x[k]` / `x.length` / `o.key` by its literal value
// program-wide; the now-unused decl is dropped, so no array is built (no data, no
// memory, no index helper) and the global is never declared. The per-function
// scalarizers can't do this: the decl lives at module scope and may be read from
// several function bodies, so the check must span the whole program.

const ASSIGN_OR_UPDATE = (op) => ASSIGN_TARGET_OPS.has(op) || op === '++' || op === '--'
// Module-scope binding ops. `var` survives to compile at module scope (jzify only
// lowers it to `let` inside functions), so fold it too — the reassignment guard
// below keeps a re-bound `var` heap-backed.
const isDeclOp = (op) => op === 'let' || op === 'const' || op === 'var'

// Reject `delete x`, `delete x.k`, `delete x[k]` — a deletion mutates the aggregate.
const isDeleteOf = (node, name) =>
  node[0] === 'delete' && (node[1] === name || (Array.isArray(node[1]) && node[1][1] === name))

// A reference is fold-safe only if it READS `name` via a static index/key (or
// `.length` for arrays). Any write/update/delete, reassignment, second declaration,
// bare value use (escape), spread, dynamic key, or non-own member (method / proto
// chain) escapes the literal model and disqualifies the binding.
const foldSafeArrayUse = (node, name, len) => {
  if (typeof node === 'string') return node !== name
  if (!Array.isArray(node)) return true
  const op = node[0]
  if (isDeclOp(op) && node.slice(1).some(d => d === name || (Array.isArray(d) && d[1] === name))) return false
  if (isDeleteOf(node, name)) return false
  if (ASSIGN_OR_UPDATE(op)) {
    const t = node[1]
    if (t === name) return false
    if (Array.isArray(t) && (t[0] === '[]' || t[0] === '.' || t[0] === '?.') && t[1] === name) return false
  }
  if ((op === '.' || op === '?.') && node[1] === name) return node[2] === 'length'
  if (op === '[]' && node[1] === name) return constIntExpr(node[2]) != null
  if (op === '...' && node[1] === name) return false
  for (let i = 1; i < node.length; i++) if (!foldSafeArrayUse(node[i], name, len)) return false
  return true
}

const foldSafeObjectUse = (node, name, keys) => {
  if (typeof node === 'string') return node !== name
  if (!Array.isArray(node)) return true
  const op = node[0]
  if (isDeclOp(op) && node.slice(1).some(d => d === name || (Array.isArray(d) && d[1] === name))) return false
  if (isDeleteOf(node, name)) return false
  if (ASSIGN_OR_UPDATE(op)) {
    const t = node[1]
    if (t === name) return false
    if (Array.isArray(t) && (t[0] === '[]' || t[0] === '.' || t[0] === '?.') && t[1] === name) return false
  }
  if ((op === '.' || op === '?.') && node[1] === name) return keys.has(node[2])   // own key only — proto-safe
  if (op === '[]' && node[1] === name) { const k = staticPropertyKey(node[2]); return k != null && keys.has(k) }
  if (op === '...' && node[1] === name) return false
  for (let i = 1; i < node.length; i++) if (!foldSafeObjectUse(node[i], name, keys)) return false
  return true
}

const moduleStmtsOf = (seq) =>
  Array.isArray(seq) && seq[0] === ';' ? seq.slice(1)
  : Array.isArray(seq) && isDeclOp(seq[0]) ? [seq]
  : []

export function foldStaticConstAggregates(ast) {
  // Span the main module AST and every bundled sub-module init — a const declared in
  // one can be read from another or from a function body (mirrors the constInts fold).
  const seqs = [ast, ...(ctx.module.moduleInits || [])]
  const moduleStmts = seqs.flatMap(moduleStmtsOf)
  const funcs = ctx.func.list.filter(f => f.body && !f.raw)
  // A function parameter named `x` rebinds `x` for the whole body — its `x[…]` reads
  // the param, not the module binding (params live on `f.sig`, separate from `.body`,
  // so the body scan can't see them). Such a function is skipped (scan) / excluded
  // (rewrite) for that name.
  const paramNames = (f) => (f.sig?.params || []).map(p => p.name)
  // Every AST a function can reference an outer binding from: its body PLUS each
  // default-parameter expression (`(v = x[0]) => …`), which prepare extracts to
  // `f.defaults` — separate from the body, so the body scan/rewrite would miss it.
  const funcNodes = (f) => f.defaults ? [f.body, ...Object.values(f.defaults)] : [f.body]

  // Classify module statements. A binding's value comes from an inline decl
  // (`const x = […]`) OR — for `var`, which jzify lowers to `let x; x = […]` — a
  // lone module-scope assignment after an uninitialized decl. The init statement(s)
  // are excluded from the read-only scan and dropped on fold.
  const inlineInit = new Map()    // name -> {value, stmt} | null (poisoned: >1 decl)
  const assigns = new Map()       // name -> [assignStmt…]
  const uninitDecl = new Map()    // name -> declStmt  (`let x` / `var x`, string declarator)
  for (const stmt of moduleStmts) {
    if (!Array.isArray(stmt)) continue
    const op = stmt[0]
    if (isDeclOp(op) && stmt.length === 2 && Array.isArray(stmt[1]) && stmt[1][0] === '=' && typeof stmt[1][1] === 'string') {
      const name = stmt[1][1]
      inlineInit.set(name, inlineInit.has(name) ? null : { value: stmt[1][2], stmt })
    } else if (isDeclOp(op) && stmt.length === 2 && typeof stmt[1] === 'string') {
      uninitDecl.set(stmt[1], stmt)
    } else if (op === '=' && typeof stmt[1] === 'string') {
      (assigns.get(stmt[1]) ?? assigns.set(stmt[1], []).get(stmt[1])).push(stmt)
    }
  }

  // index of each statement in module-execution order — used to prove a `var`'s
  // assignment dominates its reads.
  const pos = new Map()
  moduleStmts.forEach((s, i) => pos.set(s, i))

  const arr = new Map(), obj = new Map(), initStmts = new Map()
  const consider = (name, value, init) => {
    if (ctx.func.exports?.[name]) return                 // exported → escapes to JS
    const elems = scalarArrayElems(value)
    if (elems) { arr.set(name, elems); initStmts.set(name, init); return }
    const props = scalarObjectProps(value)
    if (props) { obj.set(name, props); initStmts.set(name, init) }
  }
  for (const [name, info] of inlineInit) {
    // a decl-initialized binding that is ALSO assigned is reassigned → not constant.
    if (info && !assigns.has(name)) consider(name, info.value, new Set([info.stmt]))
  }
  for (const [name, list] of assigns) {
    // `var` lowering: exactly one assignment, a matching uninit decl, and no
    // competing inline decl. The assignment must dominate every read — conservatively,
    // it precedes all other module references and the name is unused in any function
    // body (a function could run before the assignment). `let`/`const` need no such
    // guard (TDZ forbids use-before-init).
    if (inlineInit.has(name) || list.length !== 1 || !uninitDecl.has(name)) continue
    const assign = list[0], at = pos.get(assign)
    const refsBefore = moduleStmts.some((s, i) => i < at && s !== uninitDecl.get(name) && refsName(s, name, REFS_IN_EXPR))
    const refsInFn = funcs.some(f => !paramNames(f).includes(name) && funcNodes(f).some(n => refsName(n, name, REFS_IN_EXPR)))
    if (refsBefore || refsInFn) continue
    consider(name, assign[2], new Set([assign, uninitDecl.get(name)]))
  }
  if (!arr.size && !obj.size) return false

  // Every mention outside the binding's init statement(s) — across all module
  // statements and all function bodies — must be a fold-safe static read.
  const checkAll = (name, pred) => {
    const skip = initStmts.get(name)
    return moduleStmts.every(s => skip.has(s) || pred(s))
      && funcs.every(f => paramNames(f).includes(name) || funcNodes(f).every(pred))
  }
  for (const [name, elems] of [...arr]) if (!checkAll(name, n => foldSafeArrayUse(n, name, elems.length))) arr.delete(name)
  for (const [name, props] of [...obj]) {
    const keys = new Set(props.names)
    if (!checkAll(name, n => foldSafeObjectUse(n, name, keys))) obj.delete(name)
  }
  if (!arr.size && !obj.size) return false

  const objects = new Map()
  for (const [name, props] of obj) {
    const fields = new Map()
    props.names.forEach((k, i) => fields.set(k, props.values[i]))
    objects.set(name, fields)
  }
  const rewrite = (n) => rewriteScalarObjectUses(rewriteScalarArrayUses(n, arr), objects)
  // Every init statement (the decl and, for `var`, its lone assignment) is dropped —
  // nothing reads the binding anymore, so no aggregate is built.
  const dropped = new Set()
  for (const name of [...arr.keys(), ...obj.keys()]) for (const s of initStmts.get(name)) dropped.add(s)

  // Rewrite + drop init statements in each module sequence (mutate in place so
  // callers holding `ast`/moduleInits references see the result).
  for (const seq of seqs) {
    if (!Array.isArray(seq) || seq[0] !== ';') continue
    const kept = []
    for (const stmt of seq.slice(1)) {
      if (dropped.has(stmt)) continue
      kept.push(rewrite(stmt))
    }
    seq.splice(1, seq.length - 1, ...kept)
  }
  // Rewrite each function body AND its default-parameter expressions, excluding the
  // folded names its params shadow.
  for (const f of funcs) {
    const pn = paramNames(f)
    const shadows = pn.some(p => arr.has(p) || objects.has(p))
    const rw = shadows
      ? (n) => rewriteScalarObjectUses(rewriteScalarArrayUses(n, new Map([...arr].filter(([k]) => !pn.includes(k)))), new Map([...objects].filter(([k]) => !pn.includes(k))))
      : rewrite
    f.body = rw(f.body)
    if (f.defaults) for (const k of Object.keys(f.defaults)) f.defaults[k] = rw(f.defaults[k])
  }
  return true
}

function scalarizeArrayLiterals(node) {
  if (!Array.isArray(node)) return { node, changed: false }
  if (node[0] === '=>') {
    const r = scalarizeArrayLiterals(node[2])
    if (!r.changed) return { node, changed: false }
    return { node: [node[0], node[1], r.node], changed: true }
  }
  if (node[0] === ';') return scalarizeArrayLiteralSeq(node)
  let changed = false
  const out = [node[0]]
  for (let i = 1; i < node.length; i++) {
    const r = scalarizeArrayLiterals(node[i])
    changed ||= r.changed
    out.push(r.node)
  }
  return changed ? { node: out, changed: true } : { node, changed: false }
}

export const scalarizeFunctionArrayLiterals = () => {
  let changed = false
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    let guard = 0
    while (guard++ < 4) {
      const r = scalarizeArrayLiterals(func.body)
      if (!r.changed) break
      func.body = r.node
      changed = true
    }
  }
  return changed
}



// === Int-array → Int32Array auto-promotion =================================
//
// A `let xs = [intLit, intLit, …]` binding whose every use is TYPED-compatible
// is rewritten to `let xs = new Int32Array([intLit, …])`. Downstream analysis
// then takes over: valTypeOf → VAL.TYPED, methods dispatch through `.typed:`,
// loops get auto-vectorized via i32x4 (SIMD pass), and the carrier shrinks
// from 8-byte f64 slots to packed i32. The promotion runs after literal
// scalarization (so arrays fully scalarized away are already gone) and before
// typed-array param scalarization (so a freshly-promoted array can still
// participate in subsequent loop unrolling).
//
// Safety: the binding must never appear in a pattern that TYPED can't honor.
// Disqualifiers (each fires per binding name):
//   1. reassignment `xs = …` / compound `xs +=` / `++xs` / `--xs` — TYPED has
//      no value-replacement op; `xs = new TypedArray(…)` would also drop the
//      promoted view's identity.
//   2. element write `xs[k] = v` — TYPED's i32-trunc store would lose
//      fractional/NaN bits that VAL.ARRAY would have preserved.
//   3. method calls outside the read-safe whitelist (push, pop, shift, …) —
//      TYPED arrays are fixed-length; mutators don't exist on the carrier.
//   4. `Array.isArray(xs)` — semantics flip true→false on promotion.
//   5. `…xs` spread / `xs` as call arg / `xs` as return / bare reference in
//      any other position — escape; callee may rely on ARRAY layout.
//   6. captured by a closure / shadowed by an inner decl — same escape
//      reasoning, plus the inner decl could rebind to a non-array.
//
// Elements at init must all be i32-range integer literals. A negative literal
// arrives as `[null, -n]` after prepare's constant folding; intLiteralValue
// recognizes that form. Float literals (`[1, 2.5]`) and out-of-range ints
// (`0x80000000` on the +ve side, etc.) disqualify the array as a whole.

// Methods we promote across. The bar: every entry must have a real `.typed:*`
// emitter in module/typedarray.js. Receiver-flow into chained methods is also
// typed-aware now — `.typed:map`/`.typed:filter`/`.typed:slice` all return
// TYPED carriers, and downstream `.filter`/`.slice`/`.map`/etc. on those
// re-dispatch via emit.js:2211's `.typed:<m>` lookup (VAL.TYPED ⇒ typed
// emitter). Methods missing here (.join, .sort, .reverse, .subarray, .fill,
// .toString, .copyWithin, …) lack a typed emitter — disqualify the candidate.
// Does an inline arrow callback provably yield a NUMBER for every element?
// Conservative: only shapes whose result is structurally numeric qualify —
// arithmetic/bitwise/compare ops, numeric literals, the element param itself,
// Math.* calls. A call to a user fn, an object/array/string literal, or any
// unknown shape returns false (the caller then keeps the plain-array rep).
const _NUM_OPS = new Set(['+', '-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>',
  '<', '<=', '>', '>=', '==', '!=', '===', '!==', '!', '~', 'u+', 'u-'])
const _numericCallbackBody = (fn) => {
  if (!Array.isArray(fn) || fn[0] !== '=>') return false
  const params = new Set()
  const raw = fn[1]
  for (const p of Array.isArray(raw) && raw[0] === ',' ? raw.slice(1) : raw != null ? [raw] : [])
    if (typeof p === 'string') params.add(p)
  const numeric = (n) => {
    if (typeof n === 'number') return true
    if (typeof n === 'string') return params.has(n)   // element/index param — numeric under a promoted receiver
    if (!Array.isArray(n)) return false
    if (n[0] == null) return typeof n[1] === 'number' // number node — wrapper is null OR undefined in the live AST
    if (_NUM_OPS.has(n[0])) return n.slice(1).every(a => a == null || numeric(a))
    if (n[0] === '()' && typeof n[1] === 'string' && n[1].startsWith('Math.')) return true
    if (n[0] === '?' && n.length === 4) return numeric(n[2]) && numeric(n[3])
    return false
  }
  // expression body only; block bodies ({…return…}) stay conservative
  return numeric(fn[2])
}

const _TYPED_SAFE_METHODS = new Set([
  'set',
  'map', 'filter', 'slice',
  'forEach', 'reduce',
  'indexOf', 'includes', 'find', 'findIndex', 'some', 'every',
])

// `.length` is TYPED-aware via core.js:__len (shifts the byte header by
// __typed_shift on TAG=3). `.byteLength`/`.byteOffset`/`.buffer` are
// TYPED-only — a user reading those already expects a typed array, so a
// promotion candidate that hits them is a coincidence we'd rather not
// rely on; disqualify and let them write the TypedArray construction
// themselves.
const _TYPED_SAFE_PROPS = new Set(['length'])

// Returns the i32-range integer payload of an array-literal element, or null
// if the element isn't a literal integer that fits in i32. Mirrors the shape
// check used by `intLiteralValue` but without the rep-lookup (we're pre-
// analysis here, and want a pure syntactic gate).
const _intArrayLitElems = (expr) => {
  if (!Array.isArray(expr) || expr[0] !== '[') return null
  if (expr.length < 2) return null  // empty literal — low value, skip
  const out = []
  for (let i = 1; i < expr.length; i++) {
    const v = intLiteralValue(expr[i])
    if (v == null) return null
    out.push(v)
  }
  return out
}

// Arithmetic and bitwise operators that always produce a numeric result —
// regardless of operand types — so `name[expr]` is index-safe after promotion.
// Bitwise ops (`&`, `|`, etc.) ToInt32 their operands; pure-arithmetic ops with
// numeric leaves stay numeric. `+` is excluded: `"a" + "b"` is a string.
const _NUMERIC_INDEX_OPS = new Set(['-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>', 'u-', 'u+'])

// Returns true when `key` is provably a numeric index at plan time: an integer
// literal, a local name whose val-type is VAL.NUMBER in `valTypes`, or a
// compound expression that always produces a number (arithmetic/bitwise ops).
// Mirrors the `idxNumericName` / `intIndexIR` guard in emit so that the same
// index shapes that skip `__is_str_key` at emit-time also pass here. Used by
// `_disqualifyPromotion` to gate index reads: a non-numeric key on a promoted
// Int32Array NaN-coerces to 0 (trunc_sat_f64_s(NaN) = 0) instead of returning
// undefined — the correct JS behaviour for an out-of-range or string index.
const _isNumericKey = (key, valTypes) => {
  if (key == null) return false
  if (nonNegIntLiteral(key) != null) return true           // literal integer
  if (typeof key === 'string') return valTypes?.get(key) === VAL.NUMBER
  if (!Array.isArray(key)) return false
  const op = key[0]
  if (op == null) return typeof key[1] === 'number'        // [null, n] literal
  if (_NUMERIC_INDEX_OPS.has(op)) return true              // always produces Number
  // `+` is numeric only when both operands are proven numeric.
  if (op === '+' && key.length === 3)
    return _isNumericKey(key[1], valTypes) && _isNumericKey(key[2], valTypes)
  return false
}

// Walks `node` and disqualifies every candidate name that appears in an
// unsafe context. `initSet` holds the candidate's own init-decl AST nodes
// (their LHS reference is the binding being defined, not an escape).
const _disqualifyPromotion = (node, candidates, disqualified, initSet, valTypes) => {
  if (initSet.has(node)) {
    // The init decl itself: only walk the RHS (skip the LHS `name`).
    return _disqualifyPromotion(node[2], candidates, disqualified, initSet, valTypes)
  }
  if (typeof node === 'string') {
    // Bare identifier outside any handled parent context — escape.
    if (candidates.has(node)) disqualified.add(node)
    return
  }
  if (!Array.isArray(node)) return
  const op = node[0]

  // Closure body — any candidate referenced inside is captured. Bail without
  // recursing further (we'd otherwise hit the bare-name leaf and disqualify
  // anyway, but this is explicit and avoids walking the inner closure).
  if (op === '=>') {
    for (const n of candidates.keys()) {
      if (!disqualified.has(n) && refsName(node, n, { skipArrow: false })) disqualified.add(n)
    }
    return
  }

  // Member write target `name.length = n` / `++name.length` — resize is an
  // ARRAY-only op (TYPED is fixed-size); disqualify.
  if ((ASSIGN_OPS.has(op) || op === '++' || op === '--') &&
      Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.') &&
      typeof node[1][1] === 'string' && candidates.has(node[1][1])) {
    disqualified.add(node[1][1])
    for (let i = 2; i < node.length; i++) _disqualifyPromotion(node[i], candidates, disqualified, initSet, valTypes)
    return
  }

  // Property access `name.prop` / `name?.prop`. Bare property reads only —
  // method calls reach here via the `()` handler below (which intercepts
  // before recursing into its callee).
  if ((op === '.' || op === '?.') && typeof node[1] === 'string' && candidates.has(node[1])) {
    if (!_TYPED_SAFE_PROPS.has(node[2])) disqualified.add(node[1])
    return  // node[2] is the property name (string), not an expression — done
  }

  // Method or function call. Two shapes carry the candidate:
  //   `name.method(args)` — receiver at node[1][1]; method whitelist gates.
  //   `f(…, name, …)` / `Array.isArray(name)` — name appears as a plain arg.
  if (op === '()') {
    const callee = node[1]
    // Method call on a candidate receiver.
    if (Array.isArray(callee) && (callee[0] === '.' || callee[0] === '?.') &&
        typeof callee[1] === 'string' && candidates.has(callee[1])) {
      if (!_TYPED_SAFE_METHODS.has(callee[2])) disqualified.add(callee[1])
      // `.map` is the one whitelisted method that writes CALLBACK RESULTS into the
      // typed output: `.typed:map` ToNumber-coerces them (spec for a REAL typed
      // receiver), but a plain array's map must return the callback's values
      // verbatim — `[10,20].map(s => mk(s))` yields objects. Promote across map
      // only when the callback provably yields numbers; anything else (object/
      // string/unknown call results) keeps the plain-array representation.
      else if (callee[2] === 'map' && !_numericCallbackBody(node[2])) disqualified.add(callee[1])
      // Walk method args (skip the receiver — already validated above).
      for (let i = 2; i < node.length; i++) _disqualifyPromotion(node[i], candidates, disqualified, initSet, valTypes)
      return
    }
    // Array.isArray flips true→false under promotion.
    if (callee === 'Array.isArray') {
      const raw = node[2]
      const list = raw == null ? [] : (Array.isArray(raw) && raw[0] === ',') ? raw.slice(1) : [raw]
      for (const a of list) {
        if (typeof a === 'string' && candidates.has(a)) disqualified.add(a)
        else _disqualifyPromotion(a, candidates, disqualified, initSet, valTypes)
      }
      return
    }
    // Fall through to generic recursion — `name` as a plain arg will hit the
    // bare-name leaf above and disqualify.
  }

  // Index read `name[k]` — TYPED-safe only when the key is provably numeric.
  // A string or unknown key on a promoted Int32Array would NaN-coerce to 0
  // (i32.trunc_sat_f64_s(NaN) = 0) instead of returning undefined — silently
  // wrong. Mirror the `idxNumericName` / `intIndexIR` guard in emit: disqualify
  // the candidate unless `k` is an integer literal, a VAL.NUMBER local, or an
  // expression that always produces a Number (bitwise/arithmetic ops).
  if (op === '[]' && typeof node[1] === 'string' && candidates.has(node[1])) {
    _disqualifyPromotion(node[2], candidates, disqualified, initSet, valTypes)
    if (!_isNumericKey(node[2], valTypes)) disqualified.add(node[1])
    return
  }

  // Element write: `['=', ['[]', name, k], v]` (and compound forms).
  // V1 stays read-only after init — element writes would silently truncate.
  if (ASSIGN_OPS.has(op) && Array.isArray(node[1]) && node[1][0] === '[]' &&
      typeof node[1][1] === 'string' && candidates.has(node[1][1])) {
    disqualified.add(node[1][1])
    _disqualifyPromotion(node[1][2], candidates, disqualified, initSet, valTypes)
    _disqualifyPromotion(node[2], candidates, disqualified, initSet, valTypes)
    return
  }

  // Whole-binding reassign: `name = …` / `name += …` / etc.
  if (ASSIGN_OPS.has(op) && typeof node[1] === 'string' && candidates.has(node[1])) {
    disqualified.add(node[1])
    _disqualifyPromotion(node[2], candidates, disqualified, initSet, valTypes)
    return
  }

  // Pre/post-increment on var or element.
  if (op === '++' || op === '--') {
    const t = node[1]
    if (typeof t === 'string' && candidates.has(t)) { disqualified.add(t); return }
    if (Array.isArray(t) && t[0] === '[]' && typeof t[1] === 'string' && candidates.has(t[1])) {
      disqualified.add(t[1])
      _disqualifyPromotion(t[2], candidates, disqualified, initSet, valTypes)
      return
    }
  }

  // `let`/`const` declaration — the candidate's own init lands here via the
  // initSet branch at the top. Any *other* decl that names a candidate is a
  // shadow (impossible after jz hoists, but defensive) and disqualifies.
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (typeof d === 'string' && candidates.has(d)) disqualified.add(d)
      else if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' &&
               candidates.has(d[1]) && !initSet.has(d)) {
        disqualified.add(d[1])
        _disqualifyPromotion(d[2], candidates, disqualified, initSet, valTypes)
      } else {
        _disqualifyPromotion(d, candidates, disqualified, initSet, valTypes)
      }
    }
    return
  }

  // Spread `…name` — could be in a call, a `[`, or a destructure target.
  if (op === '...' && typeof node[1] === 'string' && candidates.has(node[1])) {
    disqualified.add(node[1])
    return
  }

  // for-of / for-in iteration: receiver position is `node[2]` (a bare name
  // there would otherwise trigger escape). TYPED supports iteration, so
  // allow the receiver but walk the body for other refs.
  if (op === 'for-of' || op === 'for-in') {
    // Walk decl (node[1]), iter (node[2]), body (node[3]); receiver as bare
    // name is fine — only the body matters for further refs to the same name
    // (but body refs would shadow or escape, which other rules catch).
    for (let i = 1; i < node.length; i++) {
      const child = node[i]
      if (i === 2 && typeof child === 'string' && candidates.has(child)) continue
      _disqualifyPromotion(child, candidates, disqualified, initSet, valTypes)
    }
    return
  }

  // Generic — recurse into children. Bare-name refs at unhandled positions
  // hit the string-leaf branch above and disqualify on contact.
  for (let i = 1; i < node.length; i++) _disqualifyPromotion(node[i], candidates, disqualified, initSet, valTypes)
}

// Walk `body` to collect every `let X = [intLit, …]` candidate. Each entry
// carries the exact init-decl AST node so the disqualifier can skip the
// binding's own LHS reference (which would otherwise look like a reassign).
const _collectIntArrayCandidates = (node, candidates) => {
  if (!Array.isArray(node)) return
  const op = node[0]
  if (op === '=>') return
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
      const elems = _intArrayLitElems(d[2])
      if (elems == null) continue
      // jz hoists `let` to function scope — duplicate candidate-name collisions
      // shouldn't happen, but if they do the second wins (disqualifyPromotion
      // will mark both via the shadow rule).
      candidates.set(d[1], { initDecl: d, elems })
    }
  }
  for (let i = 1; i < node.length; i++) _collectIntArrayCandidates(node[i], candidates)
}

// Rewrite `let name = [...]` → `let name = new Int32Array([...])` for every
// validated candidate. Preserves the original element AST nodes so the
// downstream `Int32Array.from` lowering picks up its existing static-data
// segment / per-element-store fast paths.
const _rewritePromoted = (node, validated, initSet) => {
  if (!Array.isArray(node)) return { node, changed: false }
  const op = node[0]
  if (op === '=>') {
    // Closures don't reach validated bindings (we disqualified on capture).
    // Still recurse — a nested closure may itself hold a promotable.
    let changed = false
    const out = [op]
    for (let i = 1; i < node.length; i++) {
      const r = _rewritePromoted(node[i], validated, initSet)
      if (r.changed) changed = true
      out.push(r.node)
    }
    return changed ? { node: out, changed: true } : { node, changed: false }
  }
  let changed = false
  const out = [op]
  for (let i = 1; i < node.length; i++) {
    const child = node[i]
    if ((op === 'let' || op === 'const') && Array.isArray(child) && child[0] === '=' &&
        typeof child[1] === 'string' && validated.has(child[1]) && initSet.has(child)) {
      const newRhs = ['()', 'new.Int32Array', child[2]]
      out.push(['=', child[1], newRhs])
      changed = true
      continue
    }
    const r = _rewritePromoted(child, validated, initSet)
    if (r.changed) changed = true
    out.push(r.node)
  }
  return changed ? { node: out, changed: true } : { node, changed: false }
}

const promoteIntArrayLiteralsInBody = (body) => {
  const candidates = new Map()
  _collectIntArrayCandidates(body, candidates)
  if (!candidates.size) return { node: body, changed: false }
  const initSet = new Set()
  for (const { initDecl } of candidates.values()) initSet.add(initDecl)
  // valTypes from analyzeBody gives per-local VAL.* kinds, used by
  // _disqualifyPromotion to prove index keys are numeric (see _isNumericKey).
  const { valTypes } = analyzeBody(body)
  const disqualified = new Set()
  _disqualifyPromotion(body, candidates, disqualified, initSet, valTypes)
  const validated = new Set()
  for (const name of candidates.keys()) if (!disqualified.has(name)) validated.add(name)
  if (!validated.size) return { node: body, changed: false }
  return _rewritePromoted(body, validated, initSet)
}

// On the first successful promotion, pull in the typedarray module so the
// emitted `new.Int32Array` callee has a registered emitter. Calling
// `includeModule('typedarray')` on a no-op (already loaded) is cheap.
export const promoteIntArrayLiterals = () => {
  let changed = false
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    const r = promoteIntArrayLiteralsInBody(func.body)
    if (r.changed) {
      func.body = r.node
      invalidateLocalsCache(func.body)
      if (!changed) includeModule('typedarray')
      changed = true
    }
  }
  return changed
}

export const scalarizeFunctionObjectLiterals = () => {
  let changed = false
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    let guard = 0
    while (guard++ < 4) {
      const escapes = new Map(analyzeBody(func.body).escapes)
      invalidateLocalsCache(func.body)
      const r = scalarizeObjectLiterals(func.body, escapes)
      if (!r.changed) break
      func.body = r.node
      changed = true
    }
  }
  return changed
}
