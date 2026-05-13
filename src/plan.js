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
 *   1. scanGlobalValueFacts / unboxConstTypedGlobals — finalize global storage.
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

import { ctx } from './ctx.js'
import { T, VAL, ASSIGN_OPS, analyzeBody, invalidateLocalsCache, staticObjectProps, staticPropertyKey, valTypeOf, typedElemCtor, typedElemAux, updateGlobalRep, collectProgramFacts, extractParams } from './analyze.js'
import { MAX_CLOSURE_ARITY } from './ir.js'
import narrowSignatures, { specializeBimorphicTyped, refineDynKeys } from './narrow.js'

const CONTROL_TRANSFER = new Set(['return', 'throw', 'break', 'continue'])
const LOOP_OPS = new Set(['for', 'while', 'do', 'do-while'])
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

const isSeq = node => Array.isArray(node) && node[0] === ';'
const blockStmts = body => {
  if (!Array.isArray(body) || body[0] !== '{}') return null
  const inner = body[1]
  if (!Array.isArray(inner)) return inner == null ? [] : [inner]
  return inner[0] === ';' ? inner.slice(1) : [inner]
}

const callArgs = node => {
  if (!Array.isArray(node) || node[0] !== '()') return null
  const raw = node[2]
  return raw == null ? [] : (Array.isArray(raw) && raw[0] === ',') ? raw.slice(1) : [raw]
}

const isSimpleArg = node => {
  if (typeof node === 'string' || typeof node === 'number') return true
  if (!Array.isArray(node)) return false
  if (node[0] == null) return typeof node[1] === 'number'
  if (node[0] === 'str') return typeof node[1] === 'string'
  if (node[0] === 'u-' || (node[0] === '-' && node.length === 2)) return isSimpleArg(node[1])
  if (['+', '-', '*', '%', '&', '|', '^', '<<', '>>', '>>>'].includes(node[0]))
    return isSimpleArg(node[1]) && isSimpleArg(node[2])
  return false
}

const scanBody = (node, fn) => {
  if (!Array.isArray(node)) return false
  if (fn(node)) return true
  if (node[0] === '=>') return false
  for (let i = 1; i < node.length; i++) if (scanBody(node[i], fn)) return true
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

const mutatesAny = (node, names) => scanBody(node, n => {
  const op = n[0]
  if ((op === '++' || op === '--') && typeof n[1] === 'string') return names.has(n[1])
  return ASSIGN_OPS.has(op) && typeof n[1] === 'string' && names.has(n[1])
})

const clonePlain = node => Array.isArray(node) ? node.map(clonePlain) : node

const intLit = node => {
  if (typeof node === 'number' && Number.isInteger(node)) return node
  if (Array.isArray(node) && node[0] == null && Number.isInteger(node[1])) return node[1]
  return null
}

const constIntExpr = (node) => {
  const lit = intLit(node)
  if (lit != null) return lit
  if (typeof node === 'string') return ctx.scope.constInts?.get(node) ?? null
  if (!Array.isArray(node)) return null
  const op = node[0]
  if (op === 'u-') {
    const v = constIntExpr(node[1])
    return v == null ? null : -v
  }
  if (node.length !== 3) return null
  const a = constIntExpr(node[1]), b = constIntExpr(node[2])
  if (a == null || b == null) return null
  if (op === '+') return a + b
  if (op === '-') return a - b
  if (op === '*') return a * b
  if (op === '<<') return a << b
  return null
}

const setCallArgs = (node, args) => {
  node[2] = args.length === 0 ? null : args.length === 1 ? args[0] : [',', ...args]
}

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

const safeScalarArrayUse = (node, name, parentOp = null) => {
  if (typeof node === 'string') return node !== name
  if (!Array.isArray(node)) return true
  const op = node[0]
  if (ASSIGN_TARGET_OPS.has(op) && node[1] === name) return false
  if ((op === 'let' || op === 'const') && node.slice(1).some(d => d === name || (Array.isArray(d) && d[1] === name))) return false
  if ((op === '.' || op === '?.') && node[1] === name) return node[2] === 'length'
  if (op === '[]' && node[1] === name) return intLit(node[2]) != null
  if (op === '...' && node[1] === name) return parentOp === '['
  for (let i = 1; i < node.length; i++) {
    if (!safeScalarArrayUse(node[i], name, op)) return false
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
    const idx = intLit(node[2])
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

const stmtList = (body) => {
  if (!Array.isArray(body)) return body == null ? [] : [body]
  if (body[0] === '{}') return stmtList(body[1])
  if (body[0] === ';') return body.slice(1)
  return [body]
}

const hasControlTransfer = node => scanBody(node, n => CONTROL_TRANSFER.has(n[0]))

const containsDeclOf = (body, name) => scanBody(body, n => {
  if (n[0] !== 'let' && n[0] !== 'const') return false
  for (let i = 1; i < n.length; i++) {
    const d = n[i]
    if (d === name) return true
    if (Array.isArray(d) && d[0] === '=' && d[1] === name) return true
  }
  return false
})

const isReassigned = (body, name) => scanBody(body, n =>
  (ASSIGN_OPS.has(n[0]) && n[1] === name) || ((n[0] === '++' || n[0] === '--') && n[1] === name))

const containsTypedArrayAccess = (body, names) => scanBody(body, n => n[0] === '[]' && typeof n[1] === 'string' && names.has(n[1]))

function smallScalarTypedForTrip(init, cond, step) {
  if (!Array.isArray(init) || init[0] !== 'let' || init.length !== 2) return null
  const decl = init[1]
  if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') return null
  const name = decl[1]
  if (constIntExpr(decl[2]) !== 0) return null
  if (!Array.isArray(cond) || cond[0] !== '<' || cond[1] !== name) return null
  const end = constIntExpr(cond[2])
  if (end == null || end < 0 || end > maxScalarTypedLoopUnroll()) return null
  const stepOk = Array.isArray(step) && ((step[0] === '++' && step[1] === name) ||
    (step[0] === '-' && Array.isArray(step[1]) && step[1][0] === '++' && step[1][1] === name && constIntExpr(step[2]) === 1))
  return stepOk ? { name, end } : null
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
  if (scanBody(func.body, n => n[0] === 'return' || n[0] === 'throw')) return new Map()
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
      ok = safeScalarArrayUse(stmts[j], decl[1])
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
  if (node[0] === '=>') return { node, changed: false }
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
  if (node[0] === '=>') return { node, changed: false }
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

const cloneWithSubst = (node, subst, rename) => {
  if (typeof node === 'string') {
    if (subst.has(node)) return clonePlain(subst.get(node))
    return rename.get(node) || node
  }
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op === 'str') return node.slice()
  if (op === '.' || op === '?.') return [op, cloneWithSubst(node[1], subst, rename), node[2]]
  if (op === ':') return [op, node[1], cloneWithSubst(node[2], subst, rename)]
  return node.map((part, i) => i === 0 ? part : cloneWithSubst(part, subst, rename))
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

const inlineInStmt = (stmt, candidates) => {
  if (!Array.isArray(stmt)) return { node: stmt, changed: false }
  // Statement-position call: discard return value, splice prefix in place.
  if (isCandidateCall(stmt, candidates)) {
    const args = callArgs(stmt)
    const shape = args && inlinedBody(candidates.get(stmt[1]), args)
    if (shape) return { node: ['{}', [';', ...shape.prefix]], changed: true, splice: shape.prefix }
  }
  // `let/const X = call(...)` with single decl: inline as prefix + decl(value).
  if ((stmt[0] === 'let' || stmt[0] === 'const') && stmt.length === 2) {
    const decl = stmt[1]
    if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' && isCandidateCall(decl[2], candidates)) {
      const args = callArgs(decl[2])
      const shape = args && inlinedBody(candidates.get(decl[2][1]), args)
      if (shape && shape.value !== null) {
        const splice = [...shape.prefix, [stmt[0], ['=', decl[1], shape.value]]]
        return { node: ['{}', [';', ...splice]], changed: true, splice }
      }
    }
  }
  // `X = call(...)` at statement position: inline as prefix + assign(value).
  if (stmt[0] === '=' && typeof stmt[1] === 'string' && isCandidateCall(stmt[2], candidates)) {
    const args = callArgs(stmt[2])
    const shape = args && inlinedBody(candidates.get(stmt[2][1]), args)
    if (shape && shape.value !== null) {
      const splice = [...shape.prefix, ['=', stmt[1], shape.value]]
      return { node: ['{}', [';', ...splice]], changed: true, splice }
    }
  }
  const op = stmt[0]
  if (op === ';') {
    let changed = false
    const next = [';']
    for (let i = 1; i < stmt.length; i++) {
      const r = inlineInStmt(stmt[i], candidates)
      changed ||= r.changed
      if (r.splice) next.push(...r.splice)
      else next.push(r.node)
    }
    return changed ? { node: next, changed } : { node: stmt, changed: false }
  }
  if (op === '{}') {
    const r = inlineInStmt(stmt[1], candidates)
    if (!r.changed) return { node: stmt, changed: false }
    // If the child was itself a candidate call (or a let/assign-of-call), it
    // already returned a `['{}', [';', ...prefix]]` shape. Re-wrapping here
    // would yield `['{}', ['{}', …]]`, which codegen rejects ("Unknown op: {}").
    if (Array.isArray(r.node) && r.node[0] === '{}') return { node: r.node, changed: true }
    return { node: ['{}', r.node], changed: true }
  }
  if (op === 'for') {
    const r = inlineInStmt(stmt[4], candidates)
    return r.changed ? { node: ['for', stmt[1], stmt[2], stmt[3], r.node], changed: true } : { node: stmt, changed: false }
  }
  if (op === 'while') {
    const r = inlineInStmt(stmt[2], candidates)
    return r.changed ? { node: ['while', stmt[1], r.node], changed: true } : { node: stmt, changed: false }
  }
  if (op === 'if') {
    const thenR = inlineInStmt(stmt[2], candidates)
    const elseR = stmt.length > 3 ? inlineInStmt(stmt[3], candidates) : null
    if (thenR.changed || elseR?.changed) return {
      node: stmt.length > 3 ? ['if', stmt[1], thenR.node, elseR.node] : ['if', stmt[1], thenR.node],
      changed: true,
    }
  }
  if (op === 'try' || op === 'catch' || op === 'finally') {
    let changed = false
    const next = [op]
    for (let i = 1; i < stmt.length; i++) {
      const part = stmt[i]
      const r = Array.isArray(part) ? inlineInStmt(part, candidates) : { node: part, changed: false }
      changed ||= r.changed
      next.push(r.node)
    }
    return changed ? { node: next, changed: true } : { node: stmt, changed: false }
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
  for (const func of ctx.func.list) {
    if (func.exported || func.raw || !func.body || func.rest || programFacts.valueUsed.has(func.name)) continue
    if (func.defaults && Object.keys(func.defaults).length) continue
    const sites = sitesByCallee.get(func.name)
    const fixedTypedArraySite = hasFixedTypedArraySites(func, sites)
    const fullyFixedTypedArraySite = hasFullyFixedTypedArraySites(func, sites)
    if (!sites || sites.length < 1 || (!fixedTypedArraySite && sites.length > 2) || sites.length > 8) continue
    const stmts = blockStmts(func.body)
    // Expression-bodied arrow funcs (`(c) => expr`) have no block — body IS the
    // return value. Treat as a "tiny leaf" branch handled below; force hasLoop=false.
    if (scanBody(func.body, n => n[0] === '=>')) continue
    // throw/break/continue are unsupported; return is OK if it's a single
    // trailing return (rewritten to a value at inlining time).
    if (scanBody(func.body, n => n[0] === 'throw' || n[0] === 'break' || n[0] === 'continue')) continue
    let returnCount = 0
    scanBody(func.body, n => { if (n[0] === 'return') returnCount++; return false })
    if (returnCount > 1) continue
    if (returnCount === 1 && stmts) {
      const last = stmts[stmts.length - 1]
      if (!Array.isArray(last) || last[0] !== 'return') continue
    }
    // Either a kernel (has a loop) or a tiny leaf (no loop, no calls, small body).
    // The leaf branch catches helpers like `isAlpha(c) => (c>=65 && c<=90) || …`
    // that get hammered from a hot caller's loop — replacing the call with its
    // body saves the per-iteration call+reinterpret overhead (tokenizer hot path).
    const hasLoop = scanBody(func.body, n => LOOP_OPS.has(n[0]))
    if (!hasLoop) {
      if (scanBody(func.body, n => n[0] === '()')) continue
      if (nodeSize(func.body) > 30) continue
    }
    if (scanBody(func.body, n => n[0] === '()' && n[1] === func.name)) continue
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
    if (scanBody(func.body, n => n[0] === '()' && typeof n[1] === 'string' && n[1].startsWith('new.'))) continue
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
    if (hasFixedTypedArraySites(func, sites) &&
        !sites.some(site => site.callerFunc?.exported && site.callerFunc.body && containsNode(site.callerFunc.body, site.node))) {
      exportedCandidates.set(name, func)
    }
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
    const r = inlineInStmt(func.body, activeCandidates)
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
  if (scanBody(abody, n => n[0] === '=>')) return false
  if (scanBody(abody, n => n[0] === 'throw' || n[0] === 'break' || n[0] === 'continue')) return false
  let returns = 0
  scanBody(abody, n => { if (n[0] === 'return') returns++; return false })
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
  const k = intLit(idx)
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

const scanGlobalValueFacts = (root) => {
  if (!root) return
  const stmts = Array.isArray(root) && root[0] === ';' ? root.slice(1) : [root]
  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'const' && stmt[0] !== 'let')) continue
    for (const decl of stmt.slice(1)) {
      if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
      const vt = valTypeOf(decl[2])
      if (vt) {
        if (!ctx.scope.globalValTypes) ctx.scope.globalValTypes = new Map()
        ctx.scope.globalValTypes.set(decl[1], vt)
        if (vt === VAL.REGEX && ctx.runtime.regex) ctx.runtime.regex.vars.set(decl[1], decl[2])
      }
      const ctor = typedElemCtor(decl[2])
      if (ctor) {
        if (!ctx.scope.globalTypedElem) ctx.scope.globalTypedElem = new Map()
        ctx.scope.globalTypedElem.set(decl[1], ctor)
      }
    }
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

export default function plan(ast) {
  scanGlobalValueFacts(ast)
  unboxConstTypedGlobals()

  let programFacts = collectProgramFacts(ast)
  // The call-inlining family (`inlineHotInternalCalls` self-gates on `sourceInline`)
  // is a pure speed optimization — the un-inlined calls emit correctly. Scalar
  // replacement (`scalarize*`) is *not* gated on `sourceInline`: callers turn it on
  // independently via `optimize: { sourceInline: false }` to test heap elision alone.
  if (inlineHotInternalCalls(programFacts, ast)) programFacts = collectProgramFacts(ast)
  if (inlineLocalLambdas()) programFacts = collectProgramFacts(ast)
  if (specializeFixedRestCalls(programFacts)) programFacts = collectProgramFacts(ast)
  if (scalarizeFunctionArrayLiterals()) programFacts = collectProgramFacts(ast)
  if (scalarizeFunctionObjectLiterals()) programFacts = collectProgramFacts(ast)
  if (scalarizeFunctionTypedArrays(programFacts)) programFacts = collectProgramFacts(ast)
  ctx.types.dynKeyVars = programFacts.dynVars
  ctx.types.anyDynKey = programFacts.anyDyn

  materializeAutoBoxSchemas(programFacts)
  resolveClosureWidth(programFacts)
  if (canSkipWholeProgramNarrowing(programFacts)) return programFacts

  narrowSignatures(programFacts, ast)
  specializeBimorphicTyped(programFacts)
  refineDynKeys(programFacts)

  return programFacts
}
