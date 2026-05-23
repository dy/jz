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

import { ctx, warn } from './ctx.js'
import { callArgs, setCallArgs, some, blockStmts, stmtList, T } from './ast.js'
import { ASSIGN_OPS, isReassigned, hasControlTransfer, isBlockBody } from './ast.js'
import {
  analyzeBody, invalidateLocalsCache, analyzeFuncNamespaces,
} from './analyze.js'
import { intLiteralValue, constIntExpr, staticObjectProps, staticPropertyKey } from './static.js'
import {
  smallConstForTripCount, containsDeclOf, cloneWithSubst,
  typedElemCtor, typedElemAux, ternaryCtorOfRhs, MIXED_CTORS,
} from './type.js'
import { extractParams } from './ast.js'
import {
  collectProgramFacts, refreshProgramFacts, invalidateProgramFactsCache,
} from './program-facts.js'
import { VAL, updateGlobalRep } from './reps.js'
import { includeModule } from './autoload.js'
import { MAX_CLOSURE_ARITY, UNDEF_WAT } from './ir.js'
import narrowSignatures, { specializeBimorphicTyped, refineDynKeys, applyJsstringBoundaryCarrierStandalone, narrowBoolResults, adviseJsstringCarrier } from './narrow.js'

const LOOP_OPS = new Set(['for', 'while', 'do', 'do-while'])

// === Loop unrolling & scalarization ===

// Fixed-size typed arrays eligible for scalar replacement, mapped to the element
// store-coercion kind ('' = none, i.e. Float64Array's f64-identity). Excluded:
//   Float32Array      — store coercion is `Math.fround`, needs the `math` module pulled at plan time
//   Uint32Array       — element range [0, 2^32) exceeds what jz keeps as f64 after `x >>> 0` (i32-narrowed)
//   Uint8ClampedArray — round-half-to-even clamp
// Coerced (truthy) types are scalarized only when fully local — any escape (passed
// to a call, `.buffer`/view aliasing, etc.) keeps the real allocation, since the
// mirror/fence path can't track writes through an alias that outlives the fence.
const SCALAR_TYPED_COERCE = {
  'new.Float64Array': '',
  'new.Int32Array': 'i32',
  'new.Int16Array': 'i16', 'new.Uint16Array': 'u16',
  'new.Int8Array': 'i8', 'new.Uint8Array': 'u8',
}
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
const maxScalarTypedArrayLen = () => ctx.transform.optimize?.scalarTypedArrayLen ?? 32
const maxScalarTypedLoopUnroll = () => ctx.transform.optimize?.scalarTypedLoopUnroll ?? 16
const maxScalarTypedNestedUnroll = () => ctx.transform.optimize?.scalarTypedNestedUnroll ?? 128

const isSimpleArg = node => {
  if (typeof node === 'string' || typeof node === 'number') return true
  if (!Array.isArray(node)) return false
  if (node[0] == null) return typeof node[1] === 'number'
  if (node[0] === 'str') return typeof node[1] === 'string'
  if (node[0] === 'u-' || (node[0] === '-' && node.length === 2)) return isSimpleArg(node[1])
  if (['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>'].includes(node[0]))
    return isSimpleArg(node[1]) && isSimpleArg(node[2])
  return false
}

const loopDepth = (node, depth) => {
  if (!Array.isArray(node)) return depth
  if (node[0] === '=>') return depth
  const here = LOOP_OPS.has(node[0]) ? depth + 1 : depth
  let max = here
  for (let i = 1; i < node.length; i++) {
    const d = loopDepth(node[i], here)
    if (d > max) max = d
  }
  return max
}

const nodeSize = (node) => {
  if (!Array.isArray(node)) return 1
  let n = 1
  for (let i = 1; i < node.length; i++) n += nodeSize(node[i])
  return n
}

const collectBindings = (node, out) => {
  if (!Array.isArray(node)) return
  const op = node[0]
  if (op === '=>') return
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < node.length; i++) collectBindingTarget(node[i], out)
  }
  for (let i = 1; i < node.length; i++) collectBindings(node[i], out)
}

const collectBindingTarget = (node, out) => {
  if (typeof node === 'string') { out.add(node); return }
  if (!Array.isArray(node)) return
  if (node[0] === '=') collectBindingTarget(node[1], out)
  else if (node[0] === '...' && typeof node[1] === 'string') out.add(node[1])
  else if (node[0] === ',' || node[0] === '[]' || node[0] === '{}')
    for (let i = 1; i < node.length; i++) collectBindingTarget(node[i], out)
}

const mutatesAny = (node, names) => some(node, n => {
  const op = n[0]
  if ((op === '++' || op === '--') && typeof n[1] === 'string') return names.has(n[1])
  return ASSIGN_OPS.has(op) && typeof n[1] === 'string' && names.has(n[1])
})

const clonePlain = node => Array.isArray(node) ? node.map(clonePlain) : node

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

const fixedScalarTypedArray = (expr) => {
  const ctor = typedElemCtor(expr)
  if (ctor == null || !(ctor in SCALAR_TYPED_COERCE)) return null
  const args = callArgs(expr)
  if (!args || args.length !== 1) return null
  const len = constIntExpr(args[0])
  return len != null && len >= 0 && len <= maxScalarTypedArrayLen()
    ? { len, coerce: SCALAR_TYPED_COERCE[ctor] } : null
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

const mentionsName = (node, name) => {
  if (typeof node === 'string') return node === name
  if (!Array.isArray(node) || node[0] === '=>') return false
  for (let i = 1; i < node.length; i++) if (mentionsName(node[i], name)) return true
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
    let hasSafeUse = false, hasUnsafeUse = false
    for (let j = 0; j < stmts.length; j++) {
      if (j === i) continue
      if (!mentionsName(stmts[j], decl[1])) continue
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
      if (arr.mirrored && mentionsName(stmts[i], name) && !safeScalarTypedArrayUse(stmts[i], name, arr.len, arr.coerce)) unsafe.push([name, arr])
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

const fixedTypedArraysInBody = (body) => {
  const out = new Map()
  const walk = node => {
    if (!Array.isArray(node) || node[0] === '=>') return
    if (node[0] === 'let' || node[0] === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        const fixed = fixedScalarTypedArray(d[2])
        if (fixed != null) out.set(d[1], fixed)
      }
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return out
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

const forLoopBodyIndex = (stmt) =>
  Array.isArray(stmt) && stmt[0] === 'for' ? (stmt.length === 3 ? 2 : 4) : null

const withForLoopBody = (stmt, body) =>
  stmt.length === 3 ? ['for', stmt[1], body] : ['for', stmt[1], stmt[2], stmt[3], body]

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

// True iff `name` appears anywhere within `node` as a bare identifier or
// inside any expression position. Used to detect escape across a closure
// boundary (where we can't trace the use sites locally).
const _refsName = (node, name) => {
  if (typeof node === 'string') return node === name
  if (!Array.isArray(node)) return false
  for (let i = 1; i < node.length; i++) if (_refsName(node[i], name)) return true
  return false
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
      if (!disqualified.has(n) && _refsName(node, n)) disqualified.add(n)
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

// Returns { prefix, value } where prefix is the substituted body statements
// (excluding any trailing `return X`), and value is the substituted return
// expression — null if void or no trailing return value.
const inlinedBody = (func, args) => {
  const params = func.sig.params
  if (args.length !== params.length || !args.every(isSimpleArg)) return null
  const paramNames = new Set(params.map(p => p.name))
  if (mutatesAny(func.body, paramNames)) return null

  const subst = new Map()
  for (let i = 0; i < params.length; i++) subst.set(params[i].name, args[i])

  const locals = new Set()
  collectBindings(func.body, locals)
  for (const p of params) locals.delete(p.name)

  const rename = new Map()
  for (const name of locals) rename.set(name, `${T}inl${ctx.func.uniq++}_${name}`)

  const stmts = blockStmts(func.body)
  // Expression-bodied arrow `(c) => expr`: no statement block; the whole body
  // *is* the return value. Treat as zero-prefix + value.
  if (!stmts) return { prefix: [], value: cloneWithSubst(func.body, subst, rename) }
  const last = stmts.length ? stmts[stmts.length - 1] : null
  const isTrailingReturn = Array.isArray(last) && last[0] === 'return'
  const prefixSrc = isTrailingReturn ? stmts.slice(0, -1) : stmts
  const prefix = prefixSrc.map(stmt => cloneWithSubst(stmt, subst, rename))
  const value = isTrailingReturn && last.length > 1 ? cloneWithSubst(last[1], subst, rename) : null
  return { prefix, value }
}

const stmtDeclName = (stmt) => {
  if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) return null
  const decl = stmt[1]
  return Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' ? decl[1] : null
}

const refsAnyName = (node, names) => {
  if (!names?.size) return false
  if (typeof node === 'string') return names.has(node)
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (op === 'str') return false
  if (op === '.' || op === '?.') return refsAnyName(node[1], names)
  if (op === ':') return refsAnyName(node[2], names)
  for (let i = 1; i < node.length; i++) if (refsAnyName(node[i], names)) return true
  return false
}

const whileInductionVar = (cond) => {
  if (typeof cond === 'string') return cond
  if (!Array.isArray(cond)) return null
  const op = cond[0]
  if ((op === '<' || op === '<=' || op === '>' || op === '>=') && typeof cond[1] === 'string') return cond[1]
  return null
}

// When splicing an inlined kernel into a loop, hoist leading decls that do not
// reference the loop induction var (e.g. floatbeat chord tables).
const partitionInvariantPrefix = (prefix, variantNames) => {
  if (!prefix.length || !variantNames?.size) return { hoisted: [], rest: prefix }
  const hoisted = []
  let i = 0
  for (; i < prefix.length; i++) {
    const s = prefix[i]
    if (!stmtDeclName(s) || refsAnyName(s, variantNames)) break
    hoisted.push(s)
  }
  return { hoisted, rest: prefix.slice(i) }
}

const spliceInlinedShape = (prefix, valueStmt, loopVariantNames) => {
  const { hoisted, rest } = partitionInvariantPrefix(prefix, loopVariantNames)
  const splice = [...rest, valueStmt]
  return { node: ['{}', [';', ...splice]], splice, hoisted, changed: true }
}

const isCandidateCall = (node, candidates) =>
  Array.isArray(node) && node[0] === '()' && typeof node[1] === 'string' && candidates.has(node[1])

// Recursively substitute calls to expr-bodied candidates anywhere in `node`.
// Used for tiny pure-expression helpers (`isAlpha(c) => …`) that get called
// from expression contexts (if-conditions, ternary tests). For these the
// inlined body is value-only (zero prefix), so a pure substitution is safe.
const inlineInExpr = (node, candidates) => {
  if (!Array.isArray(node)) return { node, changed: false }
  if (node[0] === '=>') return { node, changed: false }
  let changed = false
  const next = [node[0]]
  for (let i = 1; i < node.length; i++) {
    const r = inlineInExpr(node[i], candidates)
    if (r.changed) changed = true
    next.push(r.node)
  }
  if (isCandidateCall(next, candidates)) {
    const args = callArgs(next)
    const shape = args && inlinedBody(candidates.get(next[1]), args)
    if (shape && shape.value !== null && shape.prefix.length === 0) {
      return { node: shape.value, changed: true }
    }
  }
  return { node: changed ? next : node, changed }
}

const inlineInStmt = (stmt, candidates, loopVariantNames = null) => {
  if (!Array.isArray(stmt)) return { node: stmt, changed: false }
  // Statement-position call: discard return value, splice prefix in place.
  if (isCandidateCall(stmt, candidates)) {
    const args = callArgs(stmt)
    const shape = args && inlinedBody(candidates.get(stmt[1]), args)
    if (shape) {
      const { hoisted, rest } = partitionInvariantPrefix(shape.prefix, loopVariantNames)
      return { node: ['{}', [';', ...rest]], changed: true, splice: rest, hoisted }
    }
  }
  // `let/const X = call(...)` with single decl: inline as prefix + decl(value).
  if ((stmt[0] === 'let' || stmt[0] === 'const') && stmt.length === 2) {
    const decl = stmt[1]
    if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' && isCandidateCall(decl[2], candidates)) {
      const args = callArgs(decl[2])
      const shape = args && inlinedBody(candidates.get(decl[2][1]), args)
      if (shape && shape.value !== null) {
        const { hoisted, rest } = partitionInvariantPrefix(shape.prefix, loopVariantNames)
        const splice = [...rest, [stmt[0], ['=', decl[1], shape.value]]]
        return { node: ['{}', [';', ...splice]], changed: true, splice, hoisted }
      }
    }
  }
  // `X = call(...)` at statement position: inline as prefix + assign(value).
  // LHS may be a name or an indexed lvalue (`out[i] = beat(...)` in fill loops).
  if (stmt[0] === '=' && isCandidateCall(stmt[2], candidates)) {
    const args = callArgs(stmt[2])
    const shape = args && inlinedBody(candidates.get(stmt[2][1]), args)
    if (shape && shape.value !== null) {
      return spliceInlinedShape(shape.prefix, ['=', stmt[1], shape.value], loopVariantNames)
    }
  }
  const op = stmt[0]
  if (op === ';') {
    let changed = false
    const next = [';']
    for (let i = 1; i < stmt.length; i++) {
      const r = inlineInStmt(stmt[i], candidates, loopVariantNames)
      changed ||= r.changed
      if (r.hoisted?.length) {
        next.push(...r.hoisted)
        changed = true
      }
      if (r.splice) next.push(...r.splice)
      else next.push(r.node)
    }
    return changed ? { node: next, changed: true } : { node: stmt, changed: false }
  }
  if (op === '{}') {
    const r = inlineInStmt(stmt[1], candidates, loopVariantNames)
    if (!r.changed) return { node: stmt, changed: false }
    // If the child was itself a candidate call (or a let/assign-of-call), it
    // already returned a `['{}', [';', ...prefix]]` shape. Re-wrapping here
    // would yield `['{}', ['{}', …]]`, which codegen rejects ("Unknown op: {}").
    if (Array.isArray(r.node) && r.node[0] === '{}') return { node: r.node, changed: true, hoisted: r.hoisted }
    return { node: ['{}', r.node], changed: true, hoisted: r.hoisted }
  }
  if (op === 'for') {
    const idx = forLoopBodyIndex(stmt)
    const vars = loopVariantNames ? new Set(loopVariantNames) : new Set()
    const r = inlineInStmt(stmt[idx], candidates, vars.size ? vars : null)
    if (!r.changed) return { node: stmt, changed: false }
    return { node: withForLoopBody(stmt, r.node), changed: true, hoisted: r.hoisted }
  }
  if (op === 'while') {
    const vars = loopVariantNames ? new Set(loopVariantNames) : new Set()
    const ind = whileInductionVar(stmt[1])
    if (ind) vars.add(ind)
    const r = inlineInStmt(stmt[2], candidates, vars.size ? vars : null)
    if (!r.changed) return { node: stmt, changed: false }
    return { node: ['while', stmt[1], r.node], changed: true, hoisted: r.hoisted }
  }
  if (op === 'if') {
    const thenR = inlineInStmt(stmt[2], candidates, loopVariantNames)
    const elseR = stmt.length > 3 ? inlineInStmt(stmt[3], candidates, loopVariantNames) : null
    if (thenR.changed || elseR?.changed) return {
      node: stmt.length > 3 ? ['if', stmt[1], thenR.node, elseR.node] : ['if', stmt[1], thenR.node],
      changed: true,
      hoisted: [...(thenR.hoisted || []), ...(elseR?.hoisted || [])],
    }
  }
  if (op === 'try' || op === 'catch' || op === 'finally') {
    let changed = false
    const next = [op]
    let hoisted = []
    for (let i = 1; i < stmt.length; i++) {
      const part = stmt[i]
      const r = Array.isArray(part) ? inlineInStmt(part, candidates, loopVariantNames) : { node: part, changed: false }
      changed ||= r.changed
      if (r.hoisted?.length) hoisted = hoisted.concat(r.hoisted)
      next.push(r.node)
    }
    return changed ? { node: next, changed: true, hoisted } : { node: stmt, changed: false }
  }
  return { node: stmt, changed: false }
}

const inlineHotInternalCalls = (programFacts, ast) => {
  const cfg = ctx.transform.optimize
  if (cfg && cfg.sourceInline === false) return false

  const fixedByFunc = new Map(ctx.func.list.map(func => [func, fixedTypedArraysInBody(func.body)]))
  const typedByFunc = new Map(ctx.func.list.map(func => [func, analyzeBody(func.body).typedElems]))
  const sitesByCallee = new Map()
  for (const cs of programFacts.callSites) {
    const list = sitesByCallee.get(cs.callee)
    if (list) list.push(cs); else sitesByCallee.set(cs.callee, [cs])
  }

  const containsNode = (root, needle, inLoop = false) => {
    if (root === needle) return inLoop
    if (!Array.isArray(root) || root[0] === '=>') return false
    const nextInLoop = inLoop || LOOP_OPS.has(root[0])
    for (let i = 1; i < root.length; i++) if (containsNode(root[i], needle, nextInLoop)) return true
    return false
  }

  const hasFixedTypedArraySites = (func, sites) => {
    const params = func.sig?.params || []
    if (!sites?.length) return false
    return sites.every(site => params.some((p, i) => {
      const arg = site.argList[i]
      return typeof arg === 'string' && fixedByFunc.get(site.callerFunc)?.has(arg)
    }))
  }
  const hasFullyFixedTypedArraySites = (func, sites) => {
    const params = func.sig?.params || []
    if (!sites?.length) return false
    let sawTypedArg = false
    for (const site of sites) {
      const typed = typedByFunc.get(site.callerFunc)
      const fixed = fixedByFunc.get(site.callerFunc)
      for (let i = 0; i < params.length; i++) {
        const arg = site.argList[i]
        if (typeof arg !== 'string' || !typed?.has(arg)) continue
        sawTypedArg = true
        if (!fixed?.has(arg)) return false
      }
    }
    return sawTypedArg
  }

  const candidates = new Map()
  // Forwarders — a candidate whose body calls one of its own parameters.
  // Inlining one replaces that parameter with the call-site argument; when the
  // argument is a known function name the resulting indirect call collapses to
  // a direct `call` (devirtualization).
  const forwarders = new Set()
  for (const func of ctx.func.list) {
    const sites = sitesByCallee.get(func.name)
    // Exported leaf/kernel with exactly one internal caller (e.g. fill→beat in
    // floatbeat): inline into the caller's loop but keep the export for external
    // one-off calls (bench beat()). Multi-caller exports stay outlined so V8 can
    // tier-up shared kernels.
    const soleCallerExport = func.exported && sites?.length === 1
    if (func.raw || !func.body || func.rest) continue
    if (func.exported && !soleCallerExport) continue
    if (programFacts.valueUsed.has(func.name) && !soleCallerExport) continue
    if (func.defaults && Object.keys(func.defaults).length) continue
    const paramNames = new Set((func.sig?.params || []).map(p => p.name))
    if (paramNames.size && some(func.body, n => {
      if (n[0] !== '()' || !Array.isArray(n[1]) || n[1][0] !== '.') return false
      const [, obj, prop] = n[1]
      return prop === 'push' && typeof obj === 'string' && paramNames.has(obj)
    })) continue
    const fixedTypedArraySite = hasFixedTypedArraySites(func, sites)
    const fullyFixedTypedArraySite = hasFullyFixedTypedArraySites(func, sites)
    const hasLoop = some(func.body, n => LOOP_OPS.has(n[0]))
    const isTinyLeaf = !hasLoop && nodeSize(func.body) <= 15
    if (!sites || sites.length < 1 || (!isTinyLeaf && !fixedTypedArraySite && sites.length > 2) || sites.length > 8) continue
    const stmts = blockStmts(func.body)
    // Expression-bodied arrow funcs (`(c) => expr`) have no block — body IS the
    // return value. Treat as a "tiny leaf" branch handled below; force hasLoop=false.
    if (some(func.body, n => n[0] === '=>')) continue
    // throw/break/continue are unsupported; return is OK if it's a single
    // trailing return (rewritten to a value at inlining time).
    if (some(func.body, n => n[0] === 'throw' || n[0] === 'break' || n[0] === 'continue')) continue
    let returnCount = 0
    some(func.body, n => { if (n[0] === 'return') returnCount++; return false })
    if (returnCount > 1) continue
    if (returnCount === 1 && stmts) {
      const last = stmts[stmts.length - 1]
      if (!Array.isArray(last) || last[0] !== 'return') continue
    }
    // Either a kernel (has a loop) or a tiny leaf (no loop, no calls, small body).
    // The leaf branch catches helpers like `isAlpha(c) => (c>=65 && c<=90) || …`
    // that get hammered from a hot caller's loop — replacing the call with its
    // body saves the per-iteration call+reinterpret overhead (tokenizer hot path).
    if (!hasLoop) {
      if (some(func.body, n => n[0] === '()' && typeof n[1] === 'string' && ctx.func.names.has(n[1]))) continue
      if (nodeSize(func.body) > 30) continue
    }
    if (some(func.body, n => n[0] === '()' && n[1] === func.name)) continue
    // Kernels with nested loops (depth ≥ 2) are typically large and the inner
    // loop carries most of the cost. Inlining them into a host that V8 can't
    // tier up (e.g. a once-called wrapper) freezes the kernel in baseline.
    // Keep them as standalone functions so V8 wasm tier-up can warm them.
    if (loopDepth(func.body, 0) >= 2 && !fullyFixedTypedArraySite) continue
    // Factory functions that allocate pointers (`new TypedArray`, `new Array`,
    // object/array literals returned) break downstream pointer-ABI specialization
    // when inlined: narrow.js can't trace the post-inline alias chain back to a
    // single ctor, so the typed-array param of a callee like processCascade(x, …)
    // stays at generic f64 ABI with __typed_idx dispatch instead of i32 + f64.load.
    // Keeping the factory as a callable function preserves the call-site type fact.
    if (some(func.body, n => n[0] === '()' && typeof n[1] === 'string' && n[1].startsWith('new.'))) continue
    if (paramNames.size && some(func.body, n => n[0] === '()' && typeof n[1] === 'string' && paramNames.has(n[1])))
      forwarders.add(func.name)
    candidates.set(func.name, func)
  }
  if (!candidates.size) return false

  // Trivial expr-bodied candidates can be substituted at any expression position
  // (if-condition, ternary, etc.). Stmt-bodied ones go through inlineInStmt's
  // statement-level path which preserves prefix ordering.
  const exprOnlyCandidates = new Map()
  for (const [name, func] of candidates) {
    if (!Array.isArray(func.body) || func.body[0] !== '{}') exprOnlyCandidates.set(name, func)
  }

  let changed = false
  const exportedCandidates = new Map()
  for (const [name, func] of candidates) {
    const sites = sitesByCallee.get(name)
    const fixedSiteExported = hasFixedTypedArraySites(func, sites) &&
      !sites.some(site => site.callerFunc?.exported && site.callerFunc.body && containsNode(site.callerFunc.body, site.node))
    // Forwarders cross into an exported caller too: the tier-up rationale that
    // keeps candidates out of exports concerns relocated loop kernels, not
    // these tiny leaves — and inlining one devirtualizes a closure dispatch.
    if (fixedSiteExported || forwarders.has(name) || sites?.length === 1) exportedCandidates.set(name, func)
  }
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    // Skip exports: they're entry points usually invoked once. Inlining a
    // hot kernel here would put the loop into a function V8's wasm tier-up
    // never warms (kernel stays in baseline). Keeping the kernel as its own
    // callable function lets V8 promote it to TurboFan after a few calls.
    // Exception: fixed-size typed-array callees should inline into the exported
    // caller so scalar replacement can cross the call boundary and remove the
    // caller's heap arrays.
    const activeCandidates = func.exported ? exportedCandidates : candidates
    if (func.exported && !activeCandidates.size) continue
    // Expression-bodied arrows (`() => expr`) have func.body as the return
    // value itself — never a `{}` block. inlineInStmt treats its argument as a
    // statement (discards the return value of any top-level candidate call),
    // which would turn `() => x()` into an empty block and lose the result.
    // Route those through inlineInExpr so the call is replaced by the inlined
    // value expression instead.
    const isExprBody = !Array.isArray(func.body) || func.body[0] !== '{}'
    const r = isExprBody
      ? inlineInExpr(func.body, activeCandidates)
      : inlineInStmt(func.body, activeCandidates)
    let body = r.changed ? r.node : func.body
    let bodyChanged = r.changed
    if (!func.exported && exprOnlyCandidates.size) {
      const e = inlineInExpr(body, exprOnlyCandidates)
      if (e.changed) { body = e.node; bodyChanged = true }
    }
    if (bodyChanged) { func.body = body; changed = true }
  }
  if (ast) {
    const r = inlineInStmt(ast, candidates)
    if (r.changed) changed = true
  }
  return changed
}

// === Inline non-escaping local lambdas ===
// `const f = (a) => …; … f(x) …` → the lambda body substituted at each call
// site. A non-escaping lambda's captured free vars are still in lexical scope at
// the call site, so splicing the body in place preserves capture-by-reference
// semantics while eliminating the closure object (no env pointer, no NaN-box, no
// call_indirect). Mirrors inlineHotInternalCalls, scoped to one function body.

// True iff `name` appears textually anywhere in `node` (descending into nested
// arrows; `.prop` / `:key` positions are literal names, not refs — skipped to
// match cloneWithSubst's structure).
const referencesName = (node, name) => {
  if (typeof node === 'string') return node === name
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (op === 'str') return false
  if (op === '.' || op === '?.') return referencesName(node[1], name)
  if (op === ':') return referencesName(node[2], name)
  for (let i = 1; i < node.length; i++) if (referencesName(node[i], name)) return true
  return false
}

// True iff every textual reference to `name` in `node` is the callee of a
// `name(...)` call (i.e. the binding never escapes — never read as a value,
// reassigned, captured by a nested lambda, or shadowed).
const onlyCalledNotReferenced = (node, name) => {
  if (typeof node === 'string') return node !== name
  if (!Array.isArray(node)) return true
  const op = node[0]
  if (op === 'str') return true
  // A nested lambda touching `name` at all (capture or shadowing param) → bail.
  if (op === '=>') return !referencesName(node[1], name) && !referencesName(node[2], name)
  if (op === '()' && node[1] === name) {
    for (let i = 2; i < node.length; i++) if (!onlyCalledNotReferenced(node[i], name)) return false
    return true
  }
  if (op === '.' || op === '?.') return onlyCalledNotReferenced(node[1], name)
  if (op === ':') return onlyCalledNotReferenced(node[2], name)
  for (let i = 1; i < node.length; i++) if (!onlyCalledNotReferenced(node[i], name)) return false
  return true
}

const bodyStmtList = body =>
  Array.isArray(body) && body[0] === '{}' ? blockStmts(body)
  : Array.isArray(body) && body[0] === ';' ? body.slice(1)
  : body == null ? [] : [body]

const removeStmts = (body, set) => {
  if (!Array.isArray(body)) return set.has(body) ? null : body
  if (body[0] === '{}') return ['{}', removeStmts(body[1], set) ?? [';']]
  if (body[0] === ';') {
    const kept = body.slice(1).filter(s => !set.has(s))
    return kept.length === 0 ? null : kept.length === 1 ? kept[0] : [';', ...kept]
  }
  return set.has(body) ? null : body
}

// Lambda body must be a guaranteed-return shape inlinedBody can splice: ≤1
// `return` (trailing, if a block), no throw/break/continue, no param mutation,
// no nested lambda.
const inlinableLambdaBody = (abody, params) => {
  if (some(abody, n => n[0] === '=>')) return false
  if (some(abody, n => n[0] === 'throw' || n[0] === 'break' || n[0] === 'continue')) return false
  let returns = 0
  some(abody, n => { if (n[0] === 'return') returns++; return false })
  if (returns > 1) return false
  if (returns === 1) {
    const stmts = blockStmts(abody)
    if (!stmts || !stmts.length) return false
    const last = stmts[stmts.length - 1]
    if (!Array.isArray(last) || last[0] !== 'return') return false
  }
  return !mutatesAny(abody, new Set(params))
}

const inlineLocalLambdasInBody = (getBody, setBody) => {
  const body = getBody()
  const stmts = bodyStmtList(body)
  if (stmts.length < 2) return false

  // Collect `const f = ARROW` (single-decl), all-plain params, inlinable body.
  const decls = new Map()
  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || stmt[0] !== 'const' || stmt.length !== 2) continue
    const d = stmt[1]
    if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
    const arrow = d[2]
    if (!Array.isArray(arrow) || arrow[0] !== '=>') continue
    const params = extractParams(arrow[1])
    if (!params.every(p => typeof p === 'string')) continue
    if (!inlinableLambdaBody(arrow[2], params)) continue
    decls.set(d[1], { stmt, arrow, params })
  }
  if (!decls.size) return false

  // Drop any candidate whose body references another (or its own) candidate —
  // single-level inlining can't resolve such chains, and a still-referenced
  // candidate's decl can't be removed.
  for (let changed = true; changed;) {
    changed = false
    for (const [name, info] of decls) {
      if ([...decls.keys()].some(c => referencesName(info.arrow[2], c))) { decls.delete(name); changed = true }
    }
  }
  // Every other reference to the name must be a `name(...)` call.
  for (const [name, info] of [...decls]) {
    if (!stmts.every(s => s === info.stmt || onlyCalledNotReferenced(s, name))) decls.delete(name)
  }
  if (!decls.size) return false

  const asFunc = info => ({ sig: { params: info.params.map(name => ({ name })) }, body: info.arrow[2] })
  const stmtCands = new Map(), exprCands = new Map()
  for (const [name, info] of decls)
    (Array.isArray(info.arrow[2]) && info.arrow[2][0] === '{}' ? stmtCands : exprCands).set(name, asFunc(info))

  let out = body, didChange = false
  if (stmtCands.size) { const r = inlineInStmt(out, stmtCands); if (r.changed) { out = r.node; didChange = true } }
  if (exprCands.size) { const r = inlineInExpr(out, exprCands); if (r.changed) { out = r.node; didChange = true } }
  if (!didChange) return false

  // Remove decls of candidates that are now fully consumed.
  const newStmts = bodyStmtList(out)
  const dead = new Set()
  for (const [name, info] of decls) {
    if (!newStmts.some(s => s !== info.stmt && referencesName(s, name))) dead.add(info.stmt)
  }
  if (dead.size) out = removeStmts(out, dead) ?? [';']

  setBody(out)
  return true
}

const inlineLocalLambdas = () => {
  let changed = false
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    if (inlineLocalLambdasInBody(() => func.body, b => { func.body = b })) changed = true
  }
  return changed
}

const restIndexExpr = (idx, restParams) => {
  const k = constIntExpr(idx)
  if (k != null) return k >= 0 && k < restParams.length ? restParams[k] : [, undefined]

  let out = [, undefined]
  for (let i = restParams.length - 1; i >= 0; i--) {
    out = ['?:', ['==', clonePlain(idx), [, i]], restParams[i], out]
  }
  return out
}

const rewriteRestBody = (node, restName, restParams) => {
  if (typeof node === 'string') return node === restName ? { ok: false } : { ok: true, node }
  if (!Array.isArray(node)) return { ok: true, node }
  if (node[0] === 'str') return { ok: true, node: node.slice() }

  if ((node[0] === '.' || node[0] === '?.') && node[1] === restName) {
    return node[2] === 'length' ? { ok: true, node: [, restParams.length] } : { ok: false }
  }

  if (node[0] === '[]' && node[1] === restName) {
    if (!isSimpleArg(node[2])) return { ok: false }
    return { ok: true, node: restIndexExpr(node[2], restParams) }
  }

  const out = [node[0]]
  for (let i = 1; i < node.length; i++) {
    const r = rewriteRestBody(node[i], restName, restParams)
    if (!r.ok) return r
    out.push(r.node)
  }
  return { ok: true, node: out }
}

const specializeFixedRestCalls = (programFacts) => {
  const sitesByKey = new Map()
  for (const site of programFacts.callSites) {
    const func = ctx.func.map.get(site.callee)
    if (!func?.rest || func.exported || func.raw || !func.body) continue
    if (programFacts.valueUsed.has(func.name)) continue
    if (func.defaults && Object.keys(func.defaults).length) continue
    if (site.argList.some(a => Array.isArray(a) && a[0] === '...')) continue

    const fixedN = func.sig.params.length - 1
    const restN = Math.max(0, site.argList.length - fixedN)
    const key = `${func.name}/${restN}`
    const list = sitesByKey.get(key)
    if (list) list.push(site); else sitesByKey.set(key, [site])
  }

  let changed = false
  for (const [key, sites] of sitesByKey) {
    const [name, restNText] = key.split('/')
    const func = ctx.func.map.get(name)
    const restN = Number(restNText)
    const fixedParams = func.sig.params.slice(0, -1).map(p => ({ ...p }))
    const restName = func.rest
    const restParams = Array.from({ length: restN }, (_, i) => `${restName}${T}r${restN}_${i}`)
    const rewritten = rewriteRestBody(func.body, restName, restParams)
    if (!rewritten.ok) continue

    const cloneName = `${name}${T}rest${restN}`
    if (!ctx.func.map.has(cloneName)) {
      const restSigParams = restParams.map(name => ({ name, type: 'f64' }))
      const clone = {
        ...func,
        name: cloneName,
        exported: false,
        rest: null,
        sig: {
          ...func.sig,
          params: [...fixedParams, ...restSigParams],
          results: [...func.sig.results],
        },
        body: rewritten.node,
      }
      delete clone.defaults
      ctx.func.list.push(clone)
      ctx.func.names.add(cloneName)
      ctx.func.map.set(cloneName, clone)
    }

    const fixedN = func.sig.params.length - 1
    for (const site of sites) {
      site.node[1] = cloneName
      setCallArgs(site.node, site.argList.slice(0, fixedN + restN))
      changed = true
    }
  }
  return changed
}

// `scanGlobalValueFacts` was deleted — prepare's depth-0 catch (calling
// `recordGlobalRep` from src/infer.js) is the authoritative pass and a
// strict superset of what this top-level walker observed.

// Flow-insensitive type inference for module-level `let` bindings whose
// initial RHS doesn't pin a type (most often `let mem;` followed later by
// `mem = new TypedArray(...)` inside an init function). Without this the
// read site has to runtime-check the NaN-box tag on every access — game-of-life's
// inner step does that 9× per cell, blowing up the hot loop. We union RHS types
// across every assignment (initial decl + every `name = …` in any function);
// if every observed RHS is either a typed-array ctor of the same kind, a known
// VAL.TYPED binding of the same ctor, or null/undefined, the binding is
// monomorphically VAL.TYPED. Anything else (literal number, non-typed call,
// mixed ctors) clears the candidacy, keeping the read site polymorphic.
const inferModuleLetTypes = (ast) => {
  if (!ctx.scope.userGlobals) return
  // candidates: name → { ctor: string|null, valid: true } | { valid: false }
  // valid=true with ctor=null means "still no positive evidence"; we promote
  // only when ctor is non-null at the end. Assignments to nullish (undef/null)
  // don't change ctor — they're consistent with any typed-array value.
  const seen = new Map()
  for (const name of ctx.scope.userGlobals) seen.set(name, { ctor: null, valid: true })

  const isNullishLit = (e) => e == null || e === 'undefined' || e === 'null'
    || (Array.isArray(e) && e[0] == null && (e[1] === undefined || e[1] === null))

  const observe = (name, rhs) => {
    const c = seen.get(name)
    if (!c || !c.valid) return
    if (isNullishLit(rhs)) return
    // Resolve typed-array ctor from `new TypedArrayCtor(...)`, ternary of typed,
    // or a reference to a name we already know is typed.
    let ctor = typedElemCtor(rhs) ?? ternaryCtorOfRhs(rhs)
    if (ctor === MIXED_CTORS) { c.valid = false; return }
    if (!ctor && typeof rhs === 'string') {
      if (ctx.scope.globalValTypes?.get(rhs) === VAL.TYPED)
        ctor = ctx.scope.globalTypedElem?.get(rhs) ?? null
    }
    if (!ctor) { c.valid = false; return }
    if (c.ctor && c.ctor !== ctor) { c.valid = false; return }
    c.ctor = ctor
  }

  const walk = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=' && typeof node[1] === 'string' && seen.has(node[1])) observe(node[1], node[2])
    if ((op === 'let' || op === 'const') && node.length > 1) {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && seen.has(d[1]))
          observe(d[1], d[2])
      }
    }
    // Compound-assigns (`+=`, etc.) to a typed-array binding can't preserve
    // the typed-array kind — invalidate.
    if (ASSIGN_OPS.has(op) && op !== '=' && typeof node[1] === 'string' && seen.has(node[1])) {
      const c = seen.get(node[1])
      if (c) c.valid = false
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(ast)
  for (const f of ctx.func.list) if (f.body && !f.raw) walk(f.body)

  for (const [name, c] of seen) {
    if (!c.valid || !c.ctor) continue
    if (ctx.scope.globalValTypes?.get(name) === VAL.TYPED) continue
    ;(ctx.scope.globalValTypes ||= new Map()).set(name, VAL.TYPED)
    ;(ctx.scope.globalTypedElem ||= new Map()).set(name, c.ctor)
  }
}

const unboxConstTypedGlobals = () => {
  if (!ctx.scope.globalTypedElem || !ctx.scope.consts) return
  for (const [name, ctor] of ctx.scope.globalTypedElem) {
    if (!ctx.scope.consts.has(name)) continue
    if (ctx.scope.globalValTypes?.get(name) !== VAL.TYPED) continue
    const aux = typedElemAux(ctor)
    if (aux == null) continue
    const decl = ctx.scope.globals.get(name)
    if (typeof decl !== 'string' || !decl.includes('mut f64')) continue
    ctx.scope.globals.set(name, `(global $${name} (mut i32) (i32.const 0))`)
    ctx.scope.globalTypes.set(name, 'i32')
    updateGlobalRep(name, { ptrKind: VAL.TYPED, ptrAux: aux })
  }
}

// Integer-global type inference — narrow purpose-focused numeric module globals
// (counters, sizes, strides, indices: `N`, `width`, `offset`, …) from f64 to i32.
//
// Principle: in purpose-focused code an integer-initialized numeric global is an
// integer unless an assignment *proves* it fractional. Sizes/strides/indices are
// the overwhelming majority; demanding the user annotate them (asm.js `x | 0`)
// defeats clean code. So we assume i32 and demote only on positive proof of a
// fraction — a non-integer literal, `/` or `**`, a float-valued `Math.*`, or a
// reference to an already-fractional value. (jz already truncates fractional
// array indices, so a stray fraction in an integer slot is a pre-existing bug,
// not one this introduces; a future advisory can flag it.)
//
// The payoff cascades: an i32 `width` makes `mem[y*width+x]` a fully-i32 index
// (the per-access `trunc_sat` and the index-counter widen both vanish), and an
// i32 `N` makes the loop guard `i < N` pure-i32 (no per-iteration convert),
// unlocking SIMD — all from idiomatic source, no hints.
const FRACTIONAL_MATH = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'sqrt', 'cbrt', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p',
  'pow', 'hypot', 'random', 'fround',
])
const INT_COERCE_OPS = new Set(['&', '|', '^', '<<', '>>', '>>>', '~'])
const COMPARE_OPS = new Set(['<', '>', '<=', '>=', '==', '===', '!=', '!==', '!', 'in', 'instanceof'])
const FRAC_COMPOUND = new Set(['/=', '**='])
const INT_COMPOUND = new Set(['&=', '|=', '^=', '<<=', '>>=', '>>>='])

const inferModuleIntGlobals = (ast) => {
  if (!ctx.scope.userGlobals?.size) return
  // Candidates: mutable f64 scalar globals with positive numeric-initializer
  // evidence and not a function. (const-folded / typed-pointer globals already
  // carry a non-`(mut f64)` decl, so they're excluded.)
  const candidates = new Set()
  for (const name of ctx.scope.userGlobals) {
    const decl = ctx.scope.globals.get(name)
    if (typeof decl !== 'string' || !decl.includes('(mut f64)')) continue
    if (ctx.scope.globalValTypes?.get(name) !== VAL.NUMBER) continue
    if (ctx.func.names?.has(name)) continue
    candidates.add(name)
  }
  if (!candidates.size) return

  const fractional = new Set()
  const refIsFractional = (ref) => {
    if (candidates.has(ref)) return fractional.has(ref)
    const gt = ctx.scope.globalTypes?.get(ref)
    if (gt === 'i32') return false
    if (gt === 'f64') {
      const vt = ctx.scope.globalValTypes?.get(ref)
      return vt === VAL.NUMBER || vt == null  // a fractional f64 number; pointers aren't
    }
    return false  // param / local / unknown numeric → assume integer
  }
  // Does `e` provably evaluate to a non-integer? Integer-coercing ops (bitwise,
  // shifts) and comparisons launder any fraction; only the *value*-bearing
  // branches of ternary/logical ops carry it.
  const producesFraction = (e) => {
    if (e == null) return false
    if (typeof e === 'number') return !Number.isInteger(e)
    if (typeof e === 'string') return refIsFractional(e)
    if (!Array.isArray(e)) return false
    const op = e[0]
    if (op == null) return typeof e[1] === 'number' && !Number.isInteger(e[1])
    if (op === '/' || op === '**') return true
    if (INT_COERCE_OPS.has(op) || COMPARE_OPS.has(op)) return false
    if (op === '?:') return producesFraction(e[2]) || producesFraction(e[3])
    if (op === '&&' || op === '||' || op === '??') return producesFraction(e[1]) || producesFraction(e[2])
    if (op === '()') {
      const callee = e[1]
      if (Array.isArray(callee) && callee[0] === '?') return producesFraction(callee[2]) || producesFraction(callee[3])
      if (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'Math' && FRACTIONAL_MATH.has(callee[2])) return true
      return false  // unknown call → assume integer
    }
    for (let i = 1; i < e.length; i++) if (producesFraction(e[i])) return true
    return false
  }

  // A numeric-initialized global later assigned a provably non-numeric value
  // (string/object/array/arrow/`new`/boolean literal) must stay the f64 NaN-box
  // carrier — narrowing it to i32 would corrupt the boxed value. Disqualify it.
  const looksNonNumeric = (e) => {
    if (!Array.isArray(e)) return false
    const op = e[0]
    if (op == null) { const v = e[1]; return typeof v === 'string' || typeof v === 'boolean' }
    // `[` is prepare's array-literal form; `[]` length-2 is the raw (pre-prepare) one.
    return op === '{}' || op === '[' || (op === '[]' && e.length === 2) || op === '=>' || op === 'new' || op === 'str' || op === '`'
  }

  // Collect every assignment RHS (init + reassignments, program-wide).
  const rhsByName = new Map()
  for (const name of candidates) rhsByName.set(name, [])
  const record = (name, rhs) => {
    if (!candidates.has(name)) return
    if (looksNonNumeric(rhs)) { candidates.delete(name); rhsByName.delete(name); return }
    rhsByName.get(name)?.push(rhs)
  }
  const walk = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=' && typeof node[1] === 'string') record(node[1], node[2])
    else if ((op === 'let' || op === 'const') && node.length > 1) {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') record(d[1], d[2])
      }
    } else if (ASSIGN_OPS.has(op) && op !== '=' && typeof node[1] === 'string' && candidates.has(node[1])) {
      if (FRAC_COMPOUND.has(op)) fractional.add(node[1])         // `/=`, `**=` → fractional outright
      else if (!INT_COMPOUND.has(op)) record(node[1], node[2])   // `+= -= *= %= ||= &&= ??=` → as their rhs
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(ast)
  for (const f of ctx.func.list) if (f.body && !f.raw) walk(f.body)

  // Fixpoint: demote any candidate with a provably-fractional assignment; repeat
  // so fractionality propagates through globals that reference each other.
  let changed = true
  while (changed) {
    changed = false
    for (const name of candidates) {
      if (fractional.has(name)) continue
      if (rhsByName.get(name).some(producesFraction)) { fractional.add(name); changed = true }
    }
  }

  for (const name of candidates) {
    if (fractional.has(name)) continue
    ctx.scope.globals.set(name, `(global $${name} (mut i32) (i32.const 0))`)
    ctx.scope.globalTypes.set(name, 'i32')
  }
}

/**
 * Function-namespace scalar replacement + devirtualization.
 *
 * A property of a user function compiles, by default, as a dynamic object: each
 * `f.prop` write is a `__dyn_set` into a closure-keyed hash side-table, each
 * read a `__dyn_get`. But a function's property table can never be observed by
 * the host (the host receives only the callable; the table lives in jz linear
 * memory), so jz sees every `f.prop` site — the slot is a closed, fully-known
 * cell. Per property of a non-escaping namespace:
 *
 *   - reassigned (`multiProp`) slot → dissolve into a plain f64 module global:
 *     `__dyn_get/__dyn_set` → `global.get/global.set`. The indirect call stays
 *     (a genuinely reassigned function pointer needs `call_indirect`). Pure
 *     storage relocation: the global inits to `UNDEF_WAT`, exactly mirroring
 *     "key never set → __dyn_get yields undefined".
 *   - written once to its lifted `$f$prop` function and only ever *called*
 *     (never read as a value) → the `__dyn_set` is dead: emit already lowers
 *     `f.prop()` to a direct `call $f$prop`. Drop the write entirely.
 *
 * Disqualified namespaces (`f` escapes as a bare value / is computed-indexed —
 * an alias could reach the table) keep the dynamic path. Together these can
 * eliminate the `__dyn_*` machinery from a namespace-only program outright.
 */
const flattenFuncNamespaces = (ast) => {
  const names = ctx.func.names
  if (!names?.size) return false
  // Cheap structural gate: a flattenable namespace exists only if some lifted
  // `f$prop` name's `f` is itself a function (prepare lifts every `f.prop =
  // arrow` — multiProp slots included). The base `f` may itself carry a module
  // prefix (`mod$f`), so scan every `$` boundary, not just the first; a
  // populated `multiProp` registry is itself a direct namespace witness.
  let hasNs = ctx.func.multiProp.size > 0
  if (!hasNs) outer: for (const n of names) {
    for (let i = n.indexOf('$'); i > 0; i = n.indexOf('$', i + 1))
      if (names.has(n.slice(0, i))) { hasNs = true; break outer }
  }
  if (!hasNs) return false
  const ns = analyzeFuncNamespaces(ast)
  if (!ns.size) return false
  // f → Map<prop, decision>; decision is { global } (SROA) or { drop } (dead
  // write to an only-called single-write slot).
  const flat = new Map()
  for (const [f, info] of ns) {
    if (info.disq) continue
    let decide
    const plan = (prop, d) => { if (!decide) flat.set(f, decide = new Map()); decide.set(prop, d) }
    for (const prop of info.props) {
      if (ctx.func.multiProp.has(`${f}.${prop}`)) { plan(prop, { global: `${f}${T}${prop}` }); continue }
      const w = info.writes.get(prop)
      // Single write of the lifted `$f$prop`, never read as a value → drop it.
      if (w && w.length === 1 && w[0].atInit && w[0].rhs === `${f}$${prop}` && !info.valRead.has(prop))
        plan(prop, { drop: true })
    }
  }
  if (!flat.size) return false
  for (const decide of flat.values())
    for (const d of decide.values())
      if (d.global && !ctx.scope.globals.has(d.global)) {
        ctx.scope.globals.set(d.global, `(global $${d.global} (mut f64) ${UNDEF_WAT})`)
        ctx.scope.globalTypes.set(d.global, 'f64')
      }
  const decisionFor = (obj, prop) =>
    typeof obj === 'string' && typeof prop === 'string' && flat.has(obj)
      ? flat.get(obj).get(prop) : undefined
  const isEmptySeq = (n) => Array.isArray(n) && n.length === 1 && n[0] === ';'
  const rewrite = (node) => {
    if (!Array.isArray(node)) return node
    const op = node[0]
    if (op === '.' || op === '?.') {
      const d = decisionFor(node[1], node[2])
      if (d?.global) return d.global  // drop-decisions leave reads/calls alone
    }
    if (op === '=' && Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.')) {
      const d = decisionFor(node[1][1], node[1][2])
      if (d?.global) return ['=', d.global, rewrite(node[2])]
      if (d?.drop) return [';']  // dead write — emit nothing
    }
    const out = [op]
    // Filter dropped writes out of statement sequences (an empty `[';']` left in
    // a body would lower to an unrenderable node).
    for (let i = 1; i < node.length; i++) {
      const c = rewrite(node[i])
      if (op === ';' && isEmptySeq(c)) continue
      out.push(c)
    }
    return out
  }
  const newAst = rewrite(ast)
  ast.length = 0
  for (let i = 0; i < newAst.length; i++) ast.push(newAst[i])
  invalidateProgramFactsCache(ast)
  for (const fn of ctx.func.list)
    if (fn.body && !fn.raw) fn.body = rewrite(fn.body)
  // The defining `f.prop = …` writes live in moduleInits for bundled programs —
  // rewrite them too, or reads would resolve to an unwritten global.
  if (ctx.module.moduleInits)
    for (let i = 0; i < ctx.module.moduleInits.length; i++)
      ctx.module.moduleInits[i] = rewrite(ctx.module.moduleInits[i])
  return true
}

/**
 * Closure devirtualization.
 *
 * `flattenFuncNamespaces` dissolves a reassigned `f.prop` function slot into a
 * module global, but the call through it stays a `call_indirect` on a
 * `global.get`, dispatched via an ABI-adapting trampoline. When that global is
 * written *only* by unconditional module-init assignments it holds, for the
 * entire post-init program, one statically-known function — so every call
 * through it collapses to a direct `call`: no table lookup, no trampoline, no
 * 8-wide padding ABI, no closure type guard.
 *
 * A global G qualifies iff:
 *   1. every assignment to G is an unconditional module-init statement — none in
 *      a function body, none nested inside init control flow;
 *   2. G's final init value resolves (through global aliases) to a top-level
 *      function F;
 *   3. G is never *called* by module-init code, nor by any function reachable
 *      from it — so every call site runs strictly post-init, where G ≡ F.
 * Devirt then only swaps an indirect call for a direct call to the very same
 * callee: it cannot change behavior, only drop dispatch overhead. The result is
 * recorded in `ctx.func.globalDevirt` (`Map<global, fn>`) and consumed by emit.
 */
const devirtGlobalCalls = (ast) => {
  const fnNames = ctx.func.names
  if (!fnNames?.size || !ctx.scope.globals?.size) return

  // Module-init statement stream, in execution order: moduleInits run first in
  // `$__start`, then the main module's top-level.
  const initStmts = []
  const flatten = (n) => {
    if (Array.isArray(n) && n[0] === ';') for (let i = 1; i < n.length; i++) flatten(n[i])
    else if (n != null) initStmts.push(n)
  }
  for (const mi of ctx.module.moduleInits || []) flatten(mi)
  flatten(ast)

  const isGlobal = (s) => typeof s === 'string' && ctx.scope.globals.has(s)
  // `[target, rhs]` pairs for a `=` / `let` / `const` node assigning a global.
  const writesOf = (node) => {
    if (!Array.isArray(node)) return []
    if (node[0] === '=' && isGlobal(node[1])) return [[node[1], node[2]]]
    if (node[0] === 'let' || node[0] === 'const') {
      const out = []
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && isGlobal(d[1])) out.push([d[1], d[2]])
      }
      return out
    }
    return []
  }

  // Poison a global assigned anywhere but an unconditional init statement — in a
  // function body, or nested in init control flow. Its value is then not a
  // fixed post-init constant.
  const poison = new Set()
  const scanWrites = (node, topInit) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'let' || op === 'const') {
      // A declarator `=` is part of the declaration, not a nested assignment —
      // poison only when the declaration itself is non-top-level.
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=') {
          if (!topInit && isGlobal(d[1])) poison.add(d[1])
          scanWrites(d[2], false)
        } else scanWrites(d, false)
      }
      return
    }
    if (op === '=') {
      if (!topInit && isGlobal(node[1])) poison.add(node[1])
      scanWrites(node[1], false)
      scanWrites(node[2], false)
      return
    }
    for (let i = 1; i < node.length; i++) scanWrites(node[i], false)
  }
  for (const stmt of initStmts) scanWrites(stmt, true)
  for (const fn of ctx.func.map.values())
    if (fn.body && !fn.raw) scanWrites(fn.body, false)

  // Resolve each global's value by a linear pass over init in execution order.
  const env = new Map()
  const evalFn = (rhs) =>
    typeof rhs !== 'string' ? null
      : fnNames.has(rhs) ? rhs
      : env.has(rhs) ? env.get(rhs)
      : null
  for (const stmt of initStmts)
    for (const [g, rhs] of writesOf(stmt)) env.set(g, evalFn(rhs))

  const devirt = new Map()
  for (const [g, fn] of env)
    if (fn && fnNames.has(fn) && !poison.has(g)) devirt.set(g, fn)
  if (!devirt.size) return

  // Condition 3: a call through G that runs *during* init would see an
  // intermediate value. Drop any candidate G called by init code, or by a
  // function reachable from it.
  //
  // `walkStraightLine` follows only straight-line execution: a nested `=>`
  // literal is a closure *constructed* here, not run here, so its body is
  // skipped — an IIFE callee `(=> …)()` is the one exception, its body does
  // run. This is what keeps operator-registration init (`binary('+', 11)`
  // builds, but does not invoke, a parselet closure) from dragging the parser
  // into the init-reachable set, and keeps a wrapper body's `space()` call —
  // which fires at parse time — from counting as an init call. (Soundness
  // rests on a closure constructed during init not also being invoked during
  // init: true of function-slot wrappers, which are registered then called at
  // use time.)
  const walkStraightLine = (node, onCall) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '()') {
      onCall(node[1])
      if (Array.isArray(node[1]) && node[1][0] === '=>') walkStraightLine(node[1][2], onCall)
      for (let i = 2; i < node.length; i++) walkStraightLine(node[i], onCall)
      return
    }
    if (op === '=>' || op === 'function') return
    for (let i = 1; i < node.length; i++) walkStraightLine(node[i], onCall)
  }
  const reachable = new Set()
  const queue = []
  const seedCalls = (node) => walkStraightLine(node, (c) => {
    if (typeof c === 'string' && fnNames.has(c)) queue.push(c)
  })
  for (const s of initStmts) seedCalls(s)
  while (queue.length) {
    const f = queue.pop()
    if (reachable.has(f)) continue
    reachable.add(f)
    const fn = ctx.func.map.get(f)
    if (fn?.body && !fn.raw) seedCalls(fn.body)
  }
  const calledInInit = new Set()
  const collectCalled = (node) => walkStraightLine(node, (c) => {
    if (devirt.has(c)) calledInInit.add(c)
  })
  for (const s of initStmts) collectCalled(s)
  for (const f of reachable) { const fn = ctx.func.map.get(f); if (fn?.body) collectCalled(fn.body) }
  for (const g of calledInInit) devirt.delete(g)

  if (devirt.size) ctx.func.globalDevirt = devirt
}

const materializeAutoBoxSchemas = (programFacts) => {
  if (!ctx.schema.register) return
  for (const [name, props] of programFacts.propMap) {
    if (ctx.schema.vars.has(name)) {
      const existing = ctx.schema.resolve(name)
      const newProps = [...props].filter(prop => !existing.includes(prop))
      if (newProps.length) {
        const merged = [...existing, ...newProps]
        const mergedId = ctx.schema.register(merged)
        ctx.schema.vars.set(name, mergedId)
      }
      continue
    }
    const valueProps = [...props].filter(prop => !ctx.func.names.has(`${name}$${prop}`))
    if (!valueProps.length) continue
    const allProps = [...props]
    const schema = ['__inner__', ...allProps]
    const schemaId = ctx.schema.register(schema)
    ctx.schema.vars.set(name, schemaId)
    if (ctx.func.names.has(name) && !ctx.scope.globals.has(name))
      ctx.scope.globals.set(name, `(global $${name} (mut f64) (f64.const 0))`)
    if (!ctx.schema.autoBox) ctx.schema.autoBox = new Map()
    ctx.schema.autoBox.set(name, { schemaId, schema })
  }
}

const resolveClosureWidth = (programFacts) => {
  if (!ctx.closure.make) return
  const { hasSpread, hasRest, maxCall, maxDef, valueUsed } = programFacts
  const floor = ctx.closure.floor ?? 0
  // A top-level function used as a first-class value gets a boundary trampoline
  // that forwards $__a0..$__a{arity-1} into it (emit.js). The uniform closure
  // ABI must therefore be at least as wide as any table-resident function's
  // fixed arity — maxDef only counts surviving `=>` literals, so lifted/hoisted
  // function definitions slip past it (their bodies are walked, their param
  // lists aren't). Without this, e.g. an arity-3 function used only via a
  // 1-arg indirect call emits `(local.get $__a2)` against a 2-param trampoline.
  let maxValueArity = 0
  if (valueUsed) for (const name of valueUsed) {
    const n = ctx.func.map.get(name)?.sig?.params?.length ?? 0
    if (n > maxValueArity) maxValueArity = n
  }
  ctx.closure.width = (hasSpread && hasRest)
    ? MAX_CLOSURE_ARITY
    : Math.min(MAX_CLOSURE_ARITY, Math.max(maxCall, maxDef + (hasRest ? 1 : 0), maxValueArity, floor))
}

const canSkipWholeProgramNarrowing = (programFacts) =>
  programFacts.callSites.length === 0 &&
  programFacts.valueUsed.size === 0 &&
  !programFacts.anyDyn &&
  programFacts.propMap.size === 0 &&
  !programFacts.hasSchemaLiterals &&
  !ctx.closure.make

const HEAP_LOOP_OPS = new Set(['for', 'for-in', 'for-of', 'while', 'do', 'do-while'])
const HEAP_VALS = new Set([
  VAL.ARRAY, VAL.STRING, VAL.OBJECT, VAL.HASH, VAL.SET, VAL.MAP,
  VAL.CLOSURE, VAL.TYPED, VAL.REGEX, VAL.BUFFER,
])

function returnsHeap(func) {
  if (func.sig.ptrKind != null) return true
  return func.valResult != null && HEAP_VALS.has(func.valResult)
}

function isHeapAlloc(node) {
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (op === '{}') {
    // `['{}', [';', …]]` is a block body, not an object literal.
    if (node.length === 2 && Array.isArray(node[1]) && node[1][0] === ';') return false
    return node.length > 1
  }
  if (op === '[]') return node.length === 2
  if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.') {
    const method = node[1][2]
    if (method === 'push' || method === 'concat') return true
  }
  return false
}

function containsHeapAlloc(node) {
  if (!Array.isArray(node)) return false
  if (isHeapAlloc(node)) return true
  for (let i = 1; i < node.length; i++)
    if (containsHeapAlloc(node[i])) return true
  return false
}

function heapLoopBody(node) {
  if (!Array.isArray(node) || !HEAP_LOOP_OPS.has(node[0])) return null
  return node[node.length - 1]
}

function heapLoopAllocSites(body) {
  const sites = []
  const walk = (node) => {
    if (!Array.isArray(node)) return
    if (HEAP_LOOP_OPS.has(node[0])) {
      const lb = heapLoopBody(node)
      if (lb && containsHeapAlloc(lb))
        sites.push({ loc: node.loc ?? lb.loc })
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return sites
}

function bodyHeapAllocates(body) {
  return body != null && containsHeapAlloc(body)
}

/** Mirrors `applyArenaRewind` eligibility in src/assemble.js (AST-level). */
function isArenaRewindable(func) {
  if (func.raw) return false
  if (func.sig.params.length !== 0) return false
  if (func.sig.results.length !== 1) return false
  if (func.sig.ptrKind != null) return false
  if (returnsHeap(func)) return false
  if (func.sig.results[0] === 'f64' && func.valResult !== VAL.NUMBER && func.valResult != null)
    return false
  if (func.sig.results[0] !== 'f64' && func.sig.results[0] !== 'i32') return false
  return bodyHeapAllocates(func.body)
}

function exportedFuncNames() {
  const names = new Set()
  for (const [key, val] of Object.entries(ctx.func.exports)) {
    const name = val === true ? key : (typeof val === 'string' ? val : null)
    if (name) names.add(name)
  }
  return names
}

/** Bump-allocator growth advisories — no-op without an `opts.warnings` sink. */
function adviseHeapGrowth() {
  if (!ctx.warnings) return
  if (ctx.transform.alloc === false) return

  const exported = exportedFuncNames()

  for (const func of ctx.func.list) {
    if (func.raw || !func.body) continue

    const fn = func.name
    const isExport = exported.has(fn)

    if (isExport && returnsHeap(func)) {
      warn('heap-return',
        `export '${fn}' returns a heap value — repeated calls grow linear memory; call memory.reset() between batches from the host`,
        { fn, loc: func.body.loc })
      continue
    }

    const loopSites = heapLoopAllocSites(func.body)
    for (const site of loopSites) {
      warn('heap-loop',
        `${isExport ? `export '${fn}'` : `'${fn}'`} allocates heap values inside a loop — peak memory grows with trip count; call memory.reset() between batches from the host`,
        { fn, loc: site.loc })
    }

    if (isExport && !returnsHeap(func) && bodyHeapAllocates(func.body)
        && !isArenaRewindable(func) && loopSites.length === 0) {
      const code = func.sig.params.length > 0 ? 'arena-rewind-skipped' : 'heap-per-call'
      const detail = func.sig.params.length > 0
        ? `export '${fn}' allocates heap values but cannot rewind per call (parameters or returned pointers prevent arena rewind)`
        : `export '${fn}' allocates heap values — jz does not reclaim between calls`
      warn(code,
        `${detail}; call memory.reset() between batches from the host`,
        { fn, loc: func.body.loc })
    }
  }
}

const SET_MAP_ITER_OPS = new Set(['for-in', 'for-of'])
const SET_MAP_METHODS = new Set(['keys', 'values', 'entries', 'forEach'])
const SET_MAP_SLOT_ORDER = 'uses slot order, not insertion order — results may differ from JavaScript'

function newSetMapKind(node) {
  if (!Array.isArray(node)) return null
  if (node[0] === 'new') {
    const ctor = node[1]
    const name = typeof ctor === 'string' ? ctor
      : Array.isArray(ctor) && ctor[0] === '()' && typeof ctor[1] === 'string' ? ctor[1]
      : null
    if (name === 'Set') return 'set'
    if (name === 'Map') return 'map'
  }
  if (node[0] === '()' && typeof node[1] === 'string') {
    if (node[1] === 'new.Set') return 'set'
    if (node[1] === 'new.Map') return 'map'
  }
  return null
}

function collectSetMapBindings(body) {
  const bindings = new Map()
  const walk = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        const kind = newSetMapKind(d[2])
        if (kind) bindings.set(d[1], kind)
      }
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return bindings
}

function exprSetMapKind(expr, bindings) {
  const direct = newSetMapKind(expr)
  if (direct) return direct
  return typeof expr === 'string' ? bindings.get(expr) || null : null
}

function isJsonStringifyCall(node) {
  if (!Array.isArray(node) || node[0] !== '()') return false
  const callee = node[1]
  if (callee === 'JSON.stringify') return true
  return Array.isArray(callee) && callee[0] === '.' && callee[1] === 'JSON' && callee[2] === 'stringify'
}

function adviseSetMapIterationOrder() {
  if (!ctx.warnings) return

  for (const func of ctx.func.list) {
    if (func.raw || !func.body) continue
    const fn = func.name
    const bindings = collectSetMapBindings(func.body)

    const warnOrder = (msg, loc) => warn('set-map-order', msg, { fn, loc })
    const label = (kind) => kind === 'set' ? 'Set' : 'Map'

    const walk = (node) => {
      if (!Array.isArray(node)) return
      const op = node[0]

      if (SET_MAP_ITER_OPS.has(op)) {
        const kind = exprSetMapKind(node[2], bindings)
        if (kind) warnOrder(`${label(kind)} iteration ${SET_MAP_SLOT_ORDER}`, node.loc ?? node[2]?.loc)
      }

      if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.') {
        const [, recv, method] = node[1]
        const kind = SET_MAP_METHODS.has(method) ? exprSetMapKind(recv, bindings) : null
        if (kind) warnOrder(`${label(kind)}.${method}() ${SET_MAP_SLOT_ORDER}`, node.loc ?? recv?.loc)
      }

      if (isJsonStringifyCall(node)) {
        const kind = exprSetMapKind(node[2], bindings)
        if (kind) warnOrder(`JSON.stringify on a ${kind} serializes entries in slot order, not insertion order — output may differ from JavaScript`, node.loc)
      }

      if (op === '...') {
        const kind = exprSetMapKind(node[1], bindings)
        if (kind) warnOrder(`spread over a ${kind} follows slot order, not insertion order — element order may differ from JavaScript`, node.loc)
      }

      for (let i = 1; i < node.length; i++) walk(node[i])
    }
    walk(func.body)
  }
}

function forInductionVar(step) {
  if (!Array.isArray(step)) return null
  if (step[0] === '++' || step[0] === '--') return typeof step[1] === 'string' ? step[1] : null
  if (step[0] === '-' && Array.isArray(step[1]) && step[1][0] === '++')
    return typeof step[1][1] === 'string' ? step[1][1] : null
  if ((step[0] === '+=' || step[0] === '-=') && step[2]?.[0] == null && step[2]?.[1] === 1)
    return typeof step[1] === 'string' ? step[1] : null
  return null
}

function indexStrideOnVar(indexExpr, iv) {
  if (!Array.isArray(indexExpr)) return 1
  const op = indexExpr[0]
  if (indexExpr === iv) return 1
  if (op === '[]' && indexExpr[2] === iv) return 1
  if (op === '*' && ((indexExpr[1] === iv && intLiteralValue(indexExpr[2]) > 1)
    || (indexExpr[2] === iv && intLiteralValue(indexExpr[1]) > 1)))
    return intLiteralValue(indexExpr[1] === iv ? indexExpr[2] : indexExpr[1])
  if (op === '+') {
    for (let i = 1; i < indexExpr.length; i++) {
      const s = indexStrideOnVar(indexExpr[i], iv)
      if (s > 1) return s
    }
  }
  return 1
}

const SIMD_REDUCE_OPS = new Set(['+=', '|=', '&=', '^=', '-=', '*=', '/=', '%='])

function simdLoopIssues(body, iv) {
  let indexed = false, carried = false, maxStride = 1
  const walk = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return
    if (op === '[]' && node.length === 3) {
      const idx = node[2]
      if (idx === iv || (Array.isArray(idx) && referencesName(idx, iv))) indexed = true
      const stride = indexStrideOnVar(idx, iv)
      if (stride > maxStride) maxStride = stride
    }
    if (SIMD_REDUCE_OPS.has(op) && typeof node[1] === 'string' && node[1] !== iv) carried = true
    if (op === '=' && typeof node[1] === 'string' && node[1] !== iv) {
      const rhs = node[2]
      if (rhs === node[1] || (Array.isArray(rhs) && referencesName(rhs, node[1]))) carried = true
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return { indexed, carried, maxStride }
}

function adviseSimdLoops() {
  if (!ctx.warnings) return
  if (ctx.transform.optimize?.vectorizeLaneLocal === false) return

  for (const func of ctx.func.list) {
    if (func.raw || !func.body) continue
    const fn = func.name

    const walk = (node) => {
      if (!Array.isArray(node)) return
      if (node[0] === 'for' && node.length >= 5) {
        const [, , , step, body] = node
        const iv = forInductionVar(step)
        if (iv) {
          const { indexed, carried, maxStride } = simdLoopIssues(body, iv)
          if (indexed && carried) {
            warn('simd-loop-carried',
              `'${fn}' loop carries a scalar updated each iteration — SIMD vectorization skipped; split the reduction or use a separate accumulator`,
              { fn, loc: node.loc })
          }
          if (indexed && maxStride > 1) {
            warn('simd-aos-stride',
              `'${fn}' indexed access stride ${maxStride} on loop counter — split into one typed array per field for SIMD (array-of-structures blocks vectorization)`,
              { fn, loc: node.loc })
          }
        }
      }
      for (let i = 1; i < node.length; i++) walk(node[i])
    }
    walk(func.body)
  }
}

/** Compile-time advisories at end of plan — extensible home for soft warnings. */
function adviseProgram(programFacts) {
  adviseHeapGrowth()
  adviseSetMapIterationOrder()
  if (programFacts) adviseJsstringCarrier(programFacts.paramReps, programFacts.valueUsed)
  adviseSimdLoops()
}

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
  // replacement (`scalarize*`) is *not* gated on `sourceInline`: callers turn it on
  // independently via `optimize: { sourceInline: false }` to test heap elision alone.
  if (inlineHotInternalCalls(programFacts, ast)) programFacts = refreshProgramFacts(ast, programFacts)
  if (bindNestedRowLengths()) programFacts = refreshProgramFacts(ast, programFacts)
  if (unrollRowLenPadLoops()) programFacts = refreshProgramFacts(ast, programFacts)
  if (inlineLocalLambdas()) programFacts = refreshProgramFacts(ast, programFacts)
  if (specializeFixedRestCalls(programFacts)) programFacts = refreshProgramFacts(ast, programFacts)
  if (scalarizeFunctionArrayLiterals()) programFacts = refreshProgramFacts(ast, programFacts)
  if (scalarizeFunctionObjectLiterals()) programFacts = refreshProgramFacts(ast, programFacts)
  // Promotion runs AFTER literal scalarization (those that fully reduce to scalars
  // are gone) and BEFORE typed-array scalarization (so a freshly-promoted array's
  // fixed-length-typed-of-known-size variant could still participate in loop
  // unrolling — currently it can't, since promotion produces the `[...]`-arg
  // form rather than `new Int32Array(N)`, but the ordering keeps the door open).
  if (promoteIntArrayLiterals()) programFacts = refreshProgramFacts(ast, programFacts)
  if (scalarizeFunctionTypedArrays(programFacts)) programFacts = refreshProgramFacts(ast, programFacts)
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
