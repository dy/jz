/**
 * Pre-emit compile planning: bridges prepare (AST shape) and emit (wasm bytes).
 *
 * # Stage contract
 *   IN:  populated `ctx` from prepare.js (functions, schemas, scopes, modules)
 *        plus the prepared AST.
 *   OUT: returns a `programFacts` object; mutates `ctx` so each function has
 *        narrowed signatures, finalized global reps, and per-call decisions.
 *
 * # Pipeline (top-level `plan(ast)`)
 *   1. unboxConstTypedGlobals — finalize global storage. (Global value facts
 *      themselves are seeded by prepare via `infer.recordGlobalRep`.)
 *   2. collectProgramFacts — sweep arrow bodies for typed-elem usage, key sets,
 *      loop depth, control-transfer shapes; rerun if hot inlining changes the AST.
 *   3. materializeAutoBoxSchemas / resolveClosureWidth — settle layout decisions.
 *   4. Whole-program narrowing (skipped on simple programs):
 *        - narrowSignatures — pick a specialization per function from call sites
 *        - specializeBimorphicTyped — split typed-elem hot paths into two variants
 *          when callers diverge between two ctors
 *        - refineDynKeys — tighten dynamic property-key sets
 *
 * No bytes are emitted here; emit.js consumes the planned ctx + programFacts.
 *
 * @module plan
 */

import { ctx, warn } from '../../ctx.js'
import { callArgs, setCallArgs, some, blockStmts, stmtList, T, refsName, refsAny, REFS_IN_EXPR } from '../../ast.js'
import { ASSIGN_OPS, isReassigned, hasControlTransfer, isBlockBody } from '../../ast.js'
import {
  analyzeBody, invalidateLocalsCache, analyzeFuncNamespaces,
} from '../analyze.js'
import { intLiteralValue, constIntExpr, staticObjectProps, staticPropertyKey } from '../../static.js'
import {
  smallConstForTripCount, containsDeclOf, cloneWithSubst,
  typedElemCtor, typedElemAux, ternaryCtorOfRhs, MIXED_CTORS,
} from '../../type.js'
import { extractParams } from '../../ast.js'
import {
  collectProgramFacts, refreshProgramFacts, invalidateProgramFactsCache,
} from '../program-facts.js'
import { VAL, updateGlobalRep } from '../../reps.js'
import { includeModule } from '../../autoload.js'
import { MAX_CLOSURE_ARITY, UNDEF_WAT } from '../../ir.js'
import narrowSignatures, { specializeBimorphicTyped, refineDynKeys, applyJsstringBoundaryCarrierStandalone, narrowBoolResults, adviseJsstringCarrier } from '../narrow.js'
import { PASS_NAMES } from '../../optimize/index.js'

import {
  optimizing, LOOP_OPS, isSimpleArg, loopDepth, nodeSize, collectBindings, mutatesAny, clonePlain,
  SCALAR_TYPED_COERCE, maxScalarTypedArrayLen, fixedScalarTypedArray, fixedTypedArraysInBody,
  forLoopBodyIndex, withForLoopBody,
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

const safeScalarArrayUse = (node, name, len, parentOp = null) => {
  if (typeof node === 'string') return node !== name
  if (!Array.isArray(node)) return true
  const op = node[0]
  if (ASSIGN_TARGET_OPS.has(op) && node[1] === name) return false
  if ((op === 'let' || op === 'const') && node.slice(1).some(d => d === name || (Array.isArray(d) && d[1] === name))) return false
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
  if ((op === 'let' || op === 'const') && node.slice(1).some(d => d === name || (Array.isArray(d) && d[1] === name))) return false
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
  if ((op === 'let' || op === 'const') && node.slice(1).some(d => d === name || (Array.isArray(d) && d[1] === name))) return false
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
    let hasSafeUse = false, hasUnsafeUse = false
    for (let j = 0; j < stmts.length; j++) {
      if (j === i) continue
      if (!refsName(stmts[j], decl[1])) continue
      const safe = safeScalarTypedArrayUse(stmts[j], decl[1], len, coerce)
      hasSafeUse ||= safe
      hasUnsafeUse ||= !safe
    }
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

const scalarizeFunctionTypedArrays = (programFacts) => {
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

const scalarizeFunctionArrayLiterals = () => {
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

// Nested int row literal: `[[1,2],[3]]` → { flat, starts, lens }.
const parseNestedIntRowLit = (expr) => {
  if (!Array.isArray(expr) || expr[0] !== '[') return null
  let rows = expr.slice(1)
  if (rows.length === 1 && Array.isArray(rows[0]) && rows[0][0] === ',') rows = rows[0].slice(1)
  if (!rows.length) return null
  const flat = [], starts = [], lens = []
  for (const row of rows) {
    if (!Array.isArray(row) || row[0] !== '[') return null
    starts.push(flat.length)
    let elems = row.slice(1)
    if (elems.length === 1 && Array.isArray(elems[0]) && elems[0][0] === ',') elems = elems[0].slice(1)
    let rowLen = 0
    for (const el of elems) {
      const v = constIntExpr(el)
      if (v == null) return null
      flat.push(v)
      rowLen++
    }
    lens.push(rowLen)
  }
  return { flat, starts, lens }
}

const intRowLitIR = nums => ['[', ...nums.map(n => [null, n])]

const wrapStmtList = (stmts, orig) => {
  if (Array.isArray(orig) && orig[0] === ';') return [';', ...stmts]
  if (Array.isArray(orig) && orig[0] === '{}') return ['{}', [';', ...stmts]]
  return [';', ...stmts]
}

// `row[ci].length` on nested static int-row tables → `rowlen[ci]`.
// General: `const rows = [[…],…]; const row = rows[idx]; … row.length`.
const bindNestedRowLengths = () => {
  let changed = false
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    const r = bindNestedRowLengthsInBody(func.body)
    if (r.changed) { func.body = r.node; changed = true }
  }
  return changed
}

const bindNestedRowLengthsInBody = (body) => {
  if (Array.isArray(body) && body[0] === '=>') {
    const inner = bindNestedRowLengthsInBody(body[2])
    if (!inner.changed) return { node: body, changed: false }
    return { node: [body[0], body[1], inner.node], changed: true }
  }

  const direct = bindNestedRowLengthsSeq(body)
  if (direct.changed) return direct

  const stmts = stmtList(body)
  if (!stmts?.length) return { node: body, changed: false }

  let changed = false
  const out = []
  for (const stmt of stmts) {
    if (Array.isArray(stmt) && stmt[0] === 'while') {
      const r = bindNestedRowLengthsInBody(stmt[2])
      if (r.changed) { changed = true; out.push(['while', stmt[1], r.node]); continue }
    }
    if (Array.isArray(stmt) && stmt[0] === 'for') {
      const idx = forLoopBodyIndex(stmt)
      const r = bindNestedRowLengthsInBody(stmt[idx])
      if (r.changed) { changed = true; out.push(withForLoopBody(stmt, r.node)); continue }
    }
    if (Array.isArray(stmt) && stmt[0] === 'if') {
      const thenR = bindNestedRowLengthsInBody(stmt[2])
      const elseR = stmt.length > 3 ? bindNestedRowLengthsInBody(stmt[3]) : null
      if (thenR.changed || elseR?.changed) {
        changed = true
        out.push(stmt.length > 3 ? ['if', stmt[1], thenR.node, elseR.node] : ['if', stmt[1], thenR.node])
        continue
      }
    }
    out.push(stmt)
  }
  return changed ? { node: wrapStmtList(out, body), changed: true } : { node: body, changed: false }
}

const bindNestedRowLengthsSeq = (body) => {
  const stmts = stmtList(body)
  if (!stmts) return { node: body, changed: false }

  const progRows = new Map()
  const rowAliases = new Map()

  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) continue
    const decl = stmt[1]
    if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
    const parsed = parseNestedIntRowLit(decl[2])
    if (parsed) progRows.set(decl[1], parsed)
  }

  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) continue
    const decl = stmt[1]
    if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
    const rhs = decl[2]
    if (!Array.isArray(rhs) || rhs[0] !== '[]' || typeof rhs[1] !== 'string') continue
    const rows = progRows.get(rhs[1])
    if (!rows) continue
    rowAliases.set(decl[1], { prog: rhs[1], rowExpr: rhs[2], lens: rows.lens })
  }

  if (!rowAliases.size) return { node: body, changed: false }

  const needsLen = (node) => {
    if (!Array.isArray(node)) return false
    const op = node[0]
    if (op === '.' && typeof node[1] === 'string' && rowAliases.has(node[1]) && node[2] === 'length') return true
    if (op === '[]' && typeof node[1] === 'string' && rowAliases.has(node[1])) {
      const idx = node[2]
      if (Array.isArray(idx) && idx[0] === '%' && Array.isArray(idx[2])
          && idx[2][0] === '.' && idx[2][1] === node[1] && idx[2][2] === 'length') return true
    }
    for (let i = 1; i < node.length; i++) if (needsLen(node[i])) return true
    return false
  }
  if (!stmts.some(s => needsLen(s))) return { node: body, changed: false }

  const rowIndexExpr = (rowExpr, progName) =>
    (Array.isArray(rowExpr) && rowExpr[0] === '[]' && rowExpr[1] === progName)
      ? clonePlain(rowExpr[2]) : clonePlain(rowExpr)

  const lensSyms = new Map()
  for (const alias of rowAliases.values()) {
    if (lensSyms.has(alias.prog)) continue
    const id = ctx.func.uniq++
    lensSyms.set(alias.prog, { name: `${T}rowlen${id}`, lens: alias.lens })
  }

  const rewrite = (node) => {
    if (!Array.isArray(node)) return node
    const op = node[0]
    if (op === '=>') {
      const inner = rewrite(node[2])
      return inner === node[2] ? node : [node[0], node[1], inner]
    }
    if (op === '.' && typeof node[1] === 'string' && rowAliases.has(node[1]) && node[2] === 'length') {
      const { rowExpr, prog } = rowAliases.get(node[1])
      return ['[]', lensSyms.get(prog).name, rowIndexExpr(rowExpr, prog)]
    }
    if (op === '[]' && typeof node[1] === 'string' && rowAliases.has(node[1])) {
      const alias = rowAliases.get(node[1])
      const idx = node[2]
      if (Array.isArray(idx) && idx[0] === '%' && Array.isArray(idx[2])
          && idx[2][0] === '.' && idx[2][1] === node[1] && idx[2][2] === 'length') {
        const tab = lensSyms.get(alias.prog)
        return ['%', rewrite(idx[1]), ['[]', tab.name, rowIndexExpr(alias.rowExpr, alias.prog)]]
      }
    }
    return node.map((part, i) => i === 0 ? part : rewrite(part))
  }

  const prologue = [...lensSyms.values()].map(tab =>
    ['const', ['=', tab.name, intRowLitIR(tab.lens)]])

  const out = [...prologue]
  for (const stmt of stmts) out.push(rewrite(stmt))
  return { node: wrapStmtList(out, body), changed: true }
}

// `for (i < rowlen[ci])` inner loops — full unroll when lens are uniform;
// min-length loop + one guarded tail when they vary (mixed static row lengths).
const MAX_ROWLEN_PAD_UNROLL = 8

const parseFlatIntRowLit = (expr) => {
  if (!Array.isArray(expr) || expr[0] !== '[') return null
  let elems = expr.slice(1)
  if (elems.length === 1 && Array.isArray(elems[0]) && elems[0][0] === ',') elems = elems[0].slice(1)
  const lens = []
  for (const el of elems) {
    const v = constIntExpr(el)
    if (v == null || v < 0) return null
    lens.push(v)
  }
  return lens.length ? lens : null
}

const collectRowLenTables = (stmts) => {
  const tables = new Map()
  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) continue
    const decl = stmt[1]
    if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
    const lens = parseFlatIntRowLit(decl[2])
    if (lens) tables.set(decl[1], { lens, min: Math.min(...lens), max: Math.max(...lens) })
  }
  return tables
}

const parseRowLenBound = (expr) => {
  if (Array.isArray(expr) && expr[0] === '[]' && typeof expr[1] === 'string') {
    return { rowlen: expr[1], ci: expr[2] }
  }
  if (typeof expr === 'string') return { lenVar: expr }
  return null
}

const rowLenBoundFromHoist = (init, lenVar) => {
  const scan = (node) => {
    if (!Array.isArray(node)) return null
    if (node[0] === 'let' && node.length === 2) {
      const decl = node[1]
      if (Array.isArray(decl) && decl[0] === '=' && decl[1] === lenVar) {
        const rhs = decl[2]
        if (Array.isArray(rhs) && (rhs[0] === '|' || rhs[0] === '>>>' || rhs[0] === '&') && rhs.length === 3) {
          const inner = parseRowLenBound(rhs[1])
          if (inner?.rowlen) return inner
        }
        return parseRowLenBound(rhs)
      }
    }
    if (node[0] === ';') {
      for (let i = 1; i < node.length; i++) {
        const r = scan(node[i])
        if (r) return r
      }
    }
    return null
  }
  return scan(init)
}

const parseForIncStep = (step, idx) => {
  if (Array.isArray(step) && step[0] === '++' && step[1] === idx) return true
  // `i++` in a for-head step preps to ['-', ['++', i], 1].
  return Array.isArray(step) && step[0] === '-' && Array.isArray(step[1])
    && step[1][0] === '++' && step[1][1] === idx && constIntExpr(step[2]) === 1
}

const parseRowLenForTrip = (init, cond, step) => {
  let idx = null
  if (Array.isArray(init) && init[0] === 'let' && init.length === 2) {
    const decl = init[1]
    if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' && constIntExpr(decl[2]) === 0)
      idx = decl[1]
  } else if (Array.isArray(init) && init[0] === ';') {
    for (let i = 1; i < init.length; i++) {
      const s = init[i]
      if (Array.isArray(s) && s[0] === 'let' && s.length === 2) {
        const decl = s[1]
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' && constIntExpr(decl[2]) === 0) {
          idx = decl[1]
          break
        }
      }
    }
  }
  if (!idx) return null
  if (!Array.isArray(cond) || cond[0] !== '<' || cond[1] !== idx) return null
  if (!parseForIncStep(step, idx)) return null

  let bound = parseRowLenBound(cond[2])
  if (bound?.lenVar) {
    const resolved = rowLenBoundFromHoist(init, bound.lenVar)
    if (!resolved) return null
    bound = resolved
  }
  if (!bound?.rowlen) return null
  return { idx, rowlen: bound.rowlen, ci: bound.ci }
}

const tryUnrollRowLenFor = (forNode, tables) => {
  if (!Array.isArray(forNode) || forNode[0] !== 'for' || forNode.length !== 5) return null
  const trip = parseRowLenForTrip(forNode[1], forNode[2], forNode[3])
  if (!trip) return null
  const tab = tables.get(trip.rowlen)
  if (!tab || tab.max > MAX_ROWLEN_PAD_UNROLL || tab.max < 2) return null
  const body = forNode[4]
  const step = forNode[3]
  if (hasControlTransfer(body) || containsDeclOf(body, trip.idx) || isReassigned(body, trip.idx)) return null

  const bound = ['[]', trip.rowlen, clonePlain(trip.ci)]
  const idxInit = ['let', ['=', trip.idx, [null, 0]]]
  const out = []

  if (tab.min === tab.max) {
    for (let k = 0; k < tab.max; k++) {
      out.push(cloneWithSubst(body, new Map([[trip.idx, [null, k]]]), new Map()))
    }
  } else {
    // Variable row lengths (e.g. waltz 5/4/4/5): keep a short loop for the
    // common prefix, peel one guarded tail iteration for the longest row.
    out.push(['for', idxInit, ['<', trip.idx, [null, tab.min]], step, body])
    const tail = cloneWithSubst(body, new Map([[trip.idx, [null, tab.min]]]), new Map())
    out.push(['if', ['<', [null, tab.min], clonePlain(bound)], tail])
  }
  return out.length === 1 ? out[0] : [';', ...out]
}

const unrollRowLenPadLoopsSeq = (body, outerTables = null) => {
  const stmts = stmtList(body)
  if (!stmts) return { node: body, changed: false }

  const tables = new Map(outerTables)
  for (const [name, tab] of collectRowLenTables(stmts)) tables.set(name, tab)

  let changed = false
  const out = []
  for (const stmt of stmts) {
    if (Array.isArray(stmt) && stmt[0] === 'for' && stmt.length === 5) {
      const unrolled = tryUnrollRowLenFor(stmt, tables)
      if (unrolled) { changed = true; out.push(unrolled); continue }
    }
    if (Array.isArray(stmt) && stmt[0] === 'while') {
      const r = unrollRowLenPadLoopsInBody(stmt[2], tables)
      if (r.changed) { changed = true; out.push(['while', stmt[1], r.node]); continue }
    }
    if (Array.isArray(stmt) && stmt[0] === 'for') {
      const idx = forLoopBodyIndex(stmt)
      if (idx != null) {
        const r = unrollRowLenPadLoopsInBody(stmt[idx], tables)
        if (r.changed) { changed = true; out.push(withForLoopBody(stmt, r.node)); continue }
      }
    }
    if (Array.isArray(stmt) && stmt[0] === 'if') {
      const thenR = unrollRowLenPadLoopsInBody(stmt[2], tables)
      const elseR = stmt.length > 3 ? unrollRowLenPadLoopsInBody(stmt[3], tables) : null
      if (thenR.changed || elseR?.changed) {
        changed = true
        out.push(stmt.length > 3 ? ['if', stmt[1], thenR.node, elseR.node] : ['if', stmt[1], thenR.node])
        continue
      }
    }
    out.push(stmt)
  }
  return changed ? { node: wrapStmtList(out, body), changed: true } : { node: body, changed: false }
}

const unrollRowLenPadLoopsInBody = (body, outerTables = null) => {
  if (Array.isArray(body) && body[0] === '=>') {
    const inner = unrollRowLenPadLoopsInBody(body[2], outerTables)
    if (!inner.changed) return { node: body, changed: false }
    return { node: [body[0], body[1], inner.node], changed: true }
  }
  return unrollRowLenPadLoopsSeq(body, outerTables)
}

const unrollRowLenPadLoops = () => {
  let changed = false
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    const r = unrollRowLenPadLoopsInBody(func.body)
    if (r.changed) { func.body = r.node; changed = true }
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

// Walks `node` and disqualifies every candidate name that appears in an
// unsafe context. `initSet` holds the candidate's own init-decl AST nodes
// (their LHS reference is the binding being defined, not an escape).
const _disqualifyPromotion = (node, candidates, disqualified, initSet) => {
  if (initSet.has(node)) {
    // The init decl itself: only walk the RHS (skip the LHS `name`).
    return _disqualifyPromotion(node[2], candidates, disqualified, initSet)
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
      // Walk method args (skip the receiver — already validated above).
      for (let i = 2; i < node.length; i++) _disqualifyPromotion(node[i], candidates, disqualified, initSet)
      return
    }
    // Array.isArray flips true→false under promotion.
    if (callee === 'Array.isArray') {
      const raw = node[2]
      const list = raw == null ? [] : (Array.isArray(raw) && raw[0] === ',') ? raw.slice(1) : [raw]
      for (const a of list) {
        if (typeof a === 'string' && candidates.has(a)) disqualified.add(a)
        else _disqualifyPromotion(a, candidates, disqualified, initSet)
      }
      return
    }
    // Fall through to generic recursion — `name` as a plain arg will hit the
    // bare-name leaf above and disqualify.
  }

  // Index read `name[k]` — read access is TYPED-safe. Walk the key in case
  // it contains references to other candidate names.
  if (op === '[]' && typeof node[1] === 'string' && candidates.has(node[1])) {
    _disqualifyPromotion(node[2], candidates, disqualified, initSet)
    return
  }

  // Element write: `['=', ['[]', name, k], v]` (and compound forms).
  // V1 stays read-only after init — element writes would silently truncate.
  if (ASSIGN_OPS.has(op) && Array.isArray(node[1]) && node[1][0] === '[]' &&
      typeof node[1][1] === 'string' && candidates.has(node[1][1])) {
    disqualified.add(node[1][1])
    _disqualifyPromotion(node[1][2], candidates, disqualified, initSet)
    _disqualifyPromotion(node[2], candidates, disqualified, initSet)
    return
  }

  // Whole-binding reassign: `name = …` / `name += …` / etc.
  if (ASSIGN_OPS.has(op) && typeof node[1] === 'string' && candidates.has(node[1])) {
    disqualified.add(node[1])
    _disqualifyPromotion(node[2], candidates, disqualified, initSet)
    return
  }

  // Pre/post-increment on var or element.
  if (op === '++' || op === '--') {
    const t = node[1]
    if (typeof t === 'string' && candidates.has(t)) { disqualified.add(t); return }
    if (Array.isArray(t) && t[0] === '[]' && typeof t[1] === 'string' && candidates.has(t[1])) {
      disqualified.add(t[1])
      _disqualifyPromotion(t[2], candidates, disqualified, initSet)
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
        _disqualifyPromotion(d[2], candidates, disqualified, initSet)
      } else {
        _disqualifyPromotion(d, candidates, disqualified, initSet)
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
      _disqualifyPromotion(child, candidates, disqualified, initSet)
    }
    return
  }

  // Generic — recurse into children. Bare-name refs at unhandled positions
  // hit the string-leaf branch above and disqualify on contact.
  for (let i = 1; i < node.length; i++) _disqualifyPromotion(node[i], candidates, disqualified, initSet)
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
  const disqualified = new Set()
  _disqualifyPromotion(body, candidates, disqualified, initSet)
  const validated = new Set()
  for (const name of candidates.keys()) if (!disqualified.has(name)) validated.add(name)
  if (!validated.size) return { node: body, changed: false }
  return _rewritePromoted(body, validated, initSet)
}

// On the first successful promotion, pull in the typedarray module so the
// emitted `new.Int32Array` callee has a registered emitter. Calling
// `includeModule('typedarray')` on a no-op (already loaded) is cheap.
const promoteIntArrayLiterals = () => {
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

const scalarizeFunctionObjectLiterals = () => {
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

import { adviseProgram } from './advise.js'
import {
  inferModuleLetTypes, unboxConstTypedGlobals, inferModuleIntGlobals,
  flattenFuncNamespaces, devirtGlobalCalls,
  materializeAutoBoxSchemas, resolveClosureWidth, canSkipWholeProgramNarrowing,
} from './scope.js'
import { inlineHotInternalCalls, inlineLocalLambdas, specializeFixedRestCalls } from './inline.js'

export default function plan(ast) {
  inferModuleLetTypes(ast)
  unboxConstTypedGlobals()
  inferModuleIntGlobals(ast)

  let programFacts = collectProgramFacts(ast)
  // Function-namespace SROA — dissolve reassigned `f.prop` slots into module
  // globals before inlining/narrowing, so all downstream passes see plain
  // globals instead of the dynamic property machinery.
  if (flattenFuncNamespaces(ast)) programFacts = refreshProgramFacts(ast, programFacts)
  // Devirtualize calls through init-constant function globals (closure
  // devirtualization) — must follow the SROA above, which creates the globals.
  devirtGlobalCalls(ast)
  if (bindNestedRowLengths()) programFacts = refreshProgramFacts(ast, programFacts)
  if (unrollRowLenPadLoops()) programFacts = refreshProgramFacts(ast, programFacts)
  // The call-inlining family (`inlineHotInternalCalls` self-gates on `sourceInline`)
  // is a pure speed optimization — the un-inlined calls emit correctly. Scalar
  // replacement (`scalarize*`) and array promotion gate on `optimizing()`: off only
  // under a fully-disabled optimizer, on for every enabled preset (incl. the
  // `optimize:{sourceInline:false}` heap-elision-test form, which is level-2 based).
  if (inlineHotInternalCalls(programFacts, ast)) programFacts = refreshProgramFacts(ast, programFacts)
  if (bindNestedRowLengths()) programFacts = refreshProgramFacts(ast, programFacts)
  if (unrollRowLenPadLoops()) programFacts = refreshProgramFacts(ast, programFacts)
  if (inlineLocalLambdas()) programFacts = refreshProgramFacts(ast, programFacts)
  if (specializeFixedRestCalls(programFacts)) programFacts = refreshProgramFacts(ast, programFacts)
  if (optimizing()) {
    if (scalarizeFunctionArrayLiterals()) programFacts = refreshProgramFacts(ast, programFacts)
    if (scalarizeFunctionObjectLiterals()) programFacts = refreshProgramFacts(ast, programFacts)
    // Promotion runs AFTER literal scalarization (those that fully reduce to scalars
    // are gone) and BEFORE typed-array scalarization (so a freshly-promoted array's
    // fixed-length-typed-of-known-size variant could still participate in loop
    // unrolling — currently it can't, since promotion produces the `[...]`-arg
    // form rather than `new Int32Array(N)`, but the ordering keeps the door open).
    if (promoteIntArrayLiterals()) programFacts = refreshProgramFacts(ast, programFacts)
    if (scalarizeFunctionTypedArrays(programFacts)) programFacts = refreshProgramFacts(ast, programFacts)
  }
  ctx.types.dynKeyVars = programFacts.dynVars
  ctx.types.anyDynKey = programFacts.anyDyn

  materializeAutoBoxSchemas(programFacts)
  resolveClosureWidth(programFacts)
  if (canSkipWholeProgramNarrowing(programFacts)) {
    // Phase J (jsstring boundary opt-in) is body-local and call-site-independent;
    // run it even when the rest of narrowing is skipped so simple `export let
    // f = (s) => s.length` still flips to externref. Likewise the boolean-result
    // fact, so `export let f = (a) => a > 2` boxes its boundary atom.
    applyJsstringBoundaryCarrierStandalone(programFacts)
    narrowBoolResults()
    adviseProgram(programFacts)
    return programFacts
  }

  narrowSignatures(programFacts, ast)
  specializeBimorphicTyped(programFacts)
  refineDynKeys(programFacts)

  adviseProgram(programFacts)
  return programFacts
}
