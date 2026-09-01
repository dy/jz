// Per-function AST to scalar WAT lowering for the compact staged prototype.
// The ProgramIndex is read-only here. Each function body is materialized once,
// appended to the module, and then all function-local traversal state dies.

import { constantScalar, constantTruth } from './constants.js'
import { argsOf, bodyList, err, forHead, reject } from './prepare.js'
import {
  BIT_AND, BIT_NONE, BIT_NOT, BIT_OR, BIT_SHL, BIT_SHR, BIT_USHR, BIT_XOR,
  BUILTIN_CLZ32, BUILTIN_IMUL, BUILTIN_NONE,
  CMP_EQ, CMP_GE, CMP_GT, CMP_LE, CMP_LT, CMP_NE,
  LOGIC_AND, LOGIC_NONE, OP_ADD, OP_DIV, OP_MUL, OP_NONE, OP_SUB,
  arithmeticKind, assignmentKind, bitwiseAssignmentKind, bitwiseKind, builtinKind,
  comparisonKind, logicalKind,
} from './ops.js'
import {
  I_EXACT_I32_OWNS_TYPE, I_EXACT_I32_TYPE_ID, I_EXACT_I32_WASM_ID,
  I_EXPORT_FUNC, I_EXPORT_NAME,
  I_FN_BODY, I_FN_LOCAL_COUNT,
  I_FN_PARAM_COUNT, I_FN_REACHABLE, I_FN_RESULT_REP, I_FN_TYPE_ID, I_FN_WASM_ID,
  I_TYPE_PARAM_COUNT, I_TYPE_RESULT_REP,
  callTargetId, functionCount, localIndex,
} from './program-index.js'
import { REP_F64, REP_I32, REP_U32, isI32Rep, wasmType } from './reps.js'

const C_SOURCE_LABEL = 0
const C_BREAK_LABEL = 1
const C_CONTINUE_LABEL = 2
const C_IS_LOOP = 3

const arithmeticWat = (kind) => kind === OP_ADD ? 'f64.add' : kind === OP_SUB ? 'f64.sub'
  : kind === OP_MUL ? 'f64.mul' : kind === OP_DIV ? 'f64.div' : null

const comparisonWat = (kind) => kind === CMP_EQ ? 'f64.eq' : kind === CMP_NE ? 'f64.ne'
  : kind === CMP_LT ? 'f64.lt' : kind === CMP_GT ? 'f64.gt'
  : kind === CMP_LE ? 'f64.le' : kind === CMP_GE ? 'f64.ge' : null

const watLocal = (id) => `$v${id}`

const typed = (_scratch, node, rep, range) => range
  ? [node, rep, range[0], range[1]] : [node, rep]
const rawValue = (value) => value[0]
const repOf = (_scratch, value) => value[1]
const rangeOf = (_scratch, value) => value.length === 4 ? [value[2], value[3]] : null
const intrinsicRange = (rep) => rep === REP_I32 ? [-2147483648, 2147483647]
  : rep === REP_U32 ? [0, 4294967295] : null
const rangeUnion = (a, b) => !a || !b ? null : [Math.min(a[0], b[0]), Math.max(a[1], b[1])]

const acquireTemp = (scratch, type = 'f64') => {
  const pool = scratch.freeTemps[type] || (scratch.freeTemps[type] = [])
  let local
  if (pool.length) local = pool.pop()
  else {
    local = scratch.tempBase + scratch.tempTypes.length
    scratch.tempTypes.push(type)
  }
  scratch.activeTemps++
  if (scratch.activeTemps > scratch.maxTemporaryLocals) scratch.maxTemporaryLocals = scratch.activeTemps
  return local
}

const releaseTemp = (scratch, local, type = 'f64') => {
  scratch.freeTemps[type].push(local)
  scratch.activeTemps--
}

const asF64 = (value, scratch) => {
  const rep = repOf(scratch, value)
  if (rep === REP_F64) return value
  return typed(scratch,
    [rep === REP_U32 ? 'f64.convert_i32_u' : 'f64.convert_i32_s', rawValue(value)], REP_F64,
    rangeOf(scratch, value) || intrinsicRange(rep))
}

// Decode an f64's low 32 integer bits exactly. Values below 2^53 use Wasm's
// truncation directly. Larger finite values are already integral, so only
// exponents 53 through 83 need significand shifting; larger values, NaN, and
// infinities are all zero modulo 2^32.
const exactI32Wat = (value, bits, exponent, magnitude) => {
  const getBits = () => ['local.get', bits]
  const getExponent = () => ['local.get', exponent]
  const shifted = () => ['i32.wrap_i64', ['i64.shl',
    ['i64.or',
      ['i64.and', getBits(), ['i64.const', '0x000fffffffffffff']],
      ['i64.const', '0x0010000000000000']],
    ['i64.extend_i32_u', ['i32.sub', getExponent(), ['i32.const', 1075]]]]]
  const largeFinite = [
    'block', ['result', 'i32'],
    ['local.set', magnitude, shifted()],
    ['if', ['result', 'i32'], ['i64.lt_s', getBits(), ['i64.const', 0]],
      ['then', ['i32.sub', ['i32.const', 0], ['local.get', magnitude]]],
      ['else', ['local.get', magnitude]]],
  ]
  return [
    'block', ['result', 'i32'],
    ['local.set', bits, ['i64.reinterpret_f64', value]],
    ['local.set', exponent, ['i32.and',
      ['i32.wrap_i64', ['i64.shr_u', getBits(), ['i64.const', 52]]], ['i32.const', 2047]]],
    ['if', ['result', 'i32'], ['i32.lt_u', getExponent(), ['i32.const', 1076]],
      ['then', ['i32.wrap_i64', ['i64.trunc_sat_f64_s', ['f64.reinterpret_i64', getBits()]]]],
      ['else', ['if', ['result', 'i32'], ['i32.ge_u', getExponent(), ['i32.const', 1107]],
        ['then', ['i32.const', 0]], ['else', largeFinite]]]],
  ]
}

const exactI32Bits = (value, scratch) => {
  if (isI32Rep(repOf(scratch, value))) return value
  const raw = rawValue(value)
  if (raw[0] === 'f64.const' && typeof raw[1] === 'number')
    return typed(scratch, ['i32.const', Number.isFinite(raw[1]) ? raw[1] | 0 : 0], REP_I32)
  const range = rangeOf(scratch, value)
  if (range && range[0] >= -2147483648 && range[1] <= 2147483647)
    return typed(scratch, ['i32.trunc_sat_f64_s', raw], REP_I32)
  if (range && range[0] >= -9223372036854775808 && range[1] < 9223372036854775808)
    return typed(scratch, ['i32.wrap_i64', ['i64.trunc_sat_f64_s', raw]], REP_I32)
  if (scratch.moduleState) {
    if (scratch.moduleState.exactI32WasmId < 0) err('internal exact i32 helper has no ProgramIndex identity')
    scratch.moduleState.needsExactI32 = true
    return typed(scratch, ['call', scratch.moduleState.exactI32WasmId, raw], REP_I32)
  }

  const bits = acquireTemp(scratch, 'i64')
  const exponent = acquireTemp(scratch, 'i32')
  const magnitude = acquireTemp(scratch, 'i32')
  const out = typed(scratch, exactI32Wat(raw, watLocal(bits), watLocal(exponent), watLocal(magnitude)), REP_I32)
  releaseTemp(scratch, magnitude, 'i32')
  releaseTemp(scratch, exponent, 'i32')
  releaseTemp(scratch, bits, 'i64')
  return out
}

const exactI32Helper = (typeId) => [
  'func', ['type', typeId],
  ['param', '$v0', 'f64'], ['result', 'i32'],
  ['local', '$bits', 'i64'], ['local', '$exponent', 'i32'], ['local', '$magnitude', 'i32'],
  exactI32Wat(['local.get', '$v0'], '$bits', '$exponent', '$magnitude'),
]

const asRep = (value, rep, scratch) => {
  if (rep === REP_F64) return asF64(value, scratch)
  const out = exactI32Bits(value, scratch)
  const range = intrinsicRange(rep)
  return typed(scratch, rawValue(out), rep, range)
}

const truthyWat = (value, scratch) => isI32Rep(repOf(scratch, value))
  ? ['i32.ne', rawValue(value), ['i32.const', 0]]
  : ['f64.gt', ['f64.abs', rawValue(value)], ['f64.const', 0]]

const MASK_I32 = 1
const MASK_U32 = 2

const nativeHint = (node, index, funcId, reps) => {
  if (typeof node === 'string') {
    const local = localIndex(index, funcId, node)
    const rep = local < 0 ? REP_F64 : reps[local]
    return rep === REP_I32 ? [MASK_I32, 1] : rep === REP_U32 ? [MASK_U32, 1] : [0, 0]
  }
  if (!Array.isArray(node)) return [0, 0]
  const folded = constantScalar(node)
  if (folded) {
    if (folded[1] === REP_I32) return [MASK_I32, 1]
    if (folded[1] === REP_U32) return [MASK_U32, 1]
    const value = folded[0]
    let mask = 0
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) mask |= MASK_I32
    if (Number.isInteger(value) && value >= 0 && value <= 4294967295) mask |= MASK_U32
    return [mask, 0]
  }
  const op = node[0]
  if (op === '()' && node.length === 2 || op === '+' && node.length === 2)
    return nativeHint(node[1], index, funcId, reps)
  const bitwise = bitwiseKind(op)
  if (bitwise !== BIT_NONE) return [bitwise === BIT_USHR ? MASK_U32 : MASK_I32, 1]
  if (op === '()' && typeof node[1] === 'string') {
    const rep = index[I_FN_RESULT_REP][callTargetId(index, funcId, node[1])]
    return rep === REP_I32 ? [MASK_I32, 1] : rep === REP_U32 ? [MASK_U32, 1] : [0, 0]
  }
  if (op === '()' && builtinKind(node[1]) !== BUILTIN_NONE) return [MASK_I32, 1]
  if (op === '?' && node.length === 4 || logicalKind(op) !== LOGIC_NONE && node.length === 3) {
    const a = nativeHint(node[op === '?' ? 2 : 1], index, funcId, reps)
    const b = nativeHint(node[op === '?' ? 3 : 2], index, funcId, reps)
    return [a[0] & b[0], a[1] || b[1] ? 1 : 0]
  }
  if (op === ',' && node.length > 2) return nativeHint(node[node.length - 1], index, funcId, reps)
  return [0, 0]
}

const analyzeBindings = (index, funcId) => {
  const params = index[I_FN_PARAM_COUNT][funcId]
  const count = params + index[I_FN_LOCAL_COUNT][funcId]
  const writes = Array.from({ length: count }, () => [])
  const addWrite = (name, expr, forced = 0) => {
    const local = localIndex(index, funcId, name)
    if (local >= 0) writes[local].push([expr, forced])
  }
  const visit = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) { addWrite(node[i][1], node[i][2]); visit(node[i][2]) }
      return
    }
    if (op === '=') { addWrite(node[1], node[2]); visit(node[2]); return }
    const bitwise = bitwiseAssignmentKind(op)
    if (bitwise !== BIT_NONE) {
      addWrite(node[1], node[2], bitwise === BIT_USHR ? REP_U32 : REP_I32)
      visit(node[2])
      return
    }
    if (assignmentKind(op) !== OP_NONE || op === '++' || op === '--') {
      addWrite(node[1], node.length > 2 ? node[2] : null, REP_F64)
      if (node.length > 2) visit(node[2])
      return
    }
    for (let i = 1; i < node.length; i++) visit(node[i])
  }
  visit(index[I_FN_BODY][funcId])

  const reps = new Array(count).fill(REP_F64)
  for (let pass = 0; pass < count; pass++) {
    let changed = false
    for (let local = params; local < count; local++) {
      let allowed = MASK_I32 | MASK_U32, demanded = false
      const localWrites = writes[local]
      for (let i = 0; i < localWrites.length; i++) {
        const forced = localWrites[i][1]
        if (forced === REP_F64) { allowed = 0; break }
        const hint = forced === REP_I32 ? [MASK_I32, 1] : forced === REP_U32 ? [MASK_U32, 1]
          : nativeHint(localWrites[i][0], index, funcId, reps)
        allowed &= hint[0]
        demanded ||= !!hint[1]
      }
      const rep = demanded && allowed === MASK_I32 ? REP_I32
        : demanded && allowed === MASK_U32 ? REP_U32 : REP_F64
      if (reps[local] !== rep) { reps[local] = rep; changed = true }
    }
    if (!changed) break
  }

  const ranges = new Array(count).fill(null)
  for (let local = params; local < count; local++) {
    if (isI32Rep(reps[local])) { ranges[local] = intrinsicRange(reps[local]); continue }
    let range = null, known = writes[local].length > 0
    for (let i = 0; i < writes[local].length; i++) {
      if (writes[local][i][1]) { known = false; break }
      const folded = constantScalar(writes[local][i][0])
      if (!folded || !Number.isFinite(folded[0])) { known = false; break }
      const next = [folded[0], folded[0]]
      range = range ? rangeUnion(range, next) : next
    }
    if (known) ranges[local] = range
  }
  return { reps, ranges }
}

const pushControls = (scratch, labels, breakLabel, continueLabel) => {
  if (!labels.length) labels = [null]
  for (let i = 0; i < labels.length; i++) {
    scratch.controls.push([labels[i], breakLabel, continueLabel, 1])
    if (scratch.controls.length > scratch.maxControlDepth) scratch.maxControlDepth = scratch.controls.length
  }
  return labels.length
}

const popControls = (scratch, count) => { scratch.controls.length -= count }

const controlTarget = (node, scratch) => {
  const label = node[1]
  for (let i = scratch.controls.length - 1; i >= 0; i--) {
    const control = scratch.controls[i]
    if (label != null ? control[C_SOURCE_LABEL] === label : control[C_IS_LOOP]) {
      if (node[0] === 'continue') {
        if (!control[C_CONTINUE_LABEL]) err(`continue target '${label}' is not a loop`)
        return control[C_CONTINUE_LABEL]
      }
      return control[C_BREAK_LABEL]
    }
  }
  if (label != null) err(`unknown ${node[0]} label '${label}'`)
  err(`${node[0]} is not inside a loop`)
}

const iterationTarget = (node) => {
  while (Array.isArray(node) && node[0] === ':') node = node[2]
  return Array.isArray(node) && (node[0] === 'while' || node[0] === 'for' || node[0] === 'do')
}

function emitCondition(node, index, funcId, scratch) {
  const folded = constantTruth(node)
  if (folded !== undefined) return ['i32.const', folded]
  if (Array.isArray(node)) {
    if (node[0] === '()' && node.length === 2) return emitCondition(node[1], index, funcId, scratch)
    const cmp = comparisonWat(comparisonKind(node[0]))
    if (cmp) return [cmp,
      rawValue(asF64(emitExpr(node[1], index, funcId, scratch), scratch)),
      rawValue(asF64(emitExpr(node[2], index, funcId, scratch), scratch))]
    if (node[0] === '!' && node.length === 2) return ['i32.eqz', emitCondition(node[1], index, funcId, scratch)]
    if (logicalKind(node[0]) !== LOGIC_NONE && node.length === 3) return logicalKind(node[0]) === LOGIC_AND
      ? ['if', ['result', 'i32'], emitCondition(node[1], index, funcId, scratch),
        ['then', emitCondition(node[2], index, funcId, scratch)], ['else', ['i32.const', 0]]]
      : ['if', ['result', 'i32'], emitCondition(node[1], index, funcId, scratch),
        ['then', ['i32.const', 1]], ['else', emitCondition(node[2], index, funcId, scratch)]]
  }
  return truthyWat(emitExpr(node, index, funcId, scratch), scratch)
}

const localValue = (local, scratch) => typed(scratch, ['local.get', watLocal(local)],
  scratch.bindingReps[local], scratch.bindingRanges[local])

const emitUpdateExpr = (node, index, funcId, scratch) => {
  const local = localIndex(index, funcId, node[1])
  if (local < 0) err(`update of unknown local '${node[1]}'`)
  if (scratch.bindingReps[local] !== REP_F64) err(`internal update representation for '${node[1]}' is not f64`)
  const opcode = node[0] === '++' ? 'f64.add' : 'f64.sub'
  const updated = [opcode, rawValue(localValue(local, scratch)), ['f64.const', 1]]
  if (node.length === 2) return typed(scratch, ['local.tee', watLocal(local), updated], REP_F64)
  const old = acquireTemp(scratch)
  const block = typed(scratch, ['block', ['result', 'f64'],
    ['local.set', watLocal(old), rawValue(localValue(local, scratch))],
    ['local.set', watLocal(local), updated],
    ['local.get', watLocal(old)]], REP_F64)
  releaseTemp(scratch, old)
  return block
}

const emitLogical = (node, index, funcId, scratch) => {
  const left = emitExpr(node[1], index, funcId, scratch)
  const type = wasmType(repOf(scratch, left))
  const temp = acquireTemp(scratch, type)
  const right = emitExpr(node[2], index, funcId, scratch)
  const rep = repOf(scratch, left) === repOf(scratch, right) ? repOf(scratch, left) : REP_F64
  const leftRead = () => typed(scratch, ['local.get', watLocal(temp)],
    repOf(scratch, left), rangeOf(scratch, left))
  const condition = truthyWat(leftRead(), scratch)
  const branch = logicalKind(node[0]) === LOGIC_AND
    ? ['if', ['result', wasmType(rep)], condition,
      ['then', rawValue(asRep(right, rep, scratch))],
      ['else', rawValue(asRep(leftRead(), rep, scratch))]]
    : ['if', ['result', wasmType(rep)], condition,
      ['then', rawValue(asRep(leftRead(), rep, scratch))],
      ['else', rawValue(asRep(right, rep, scratch))]]
  const out = typed(scratch, ['block', ['result', wasmType(rep)],
    ['local.set', watLocal(temp), rawValue(left)], branch], rep,
  rangeUnion(rangeOf(scratch, left), rangeOf(scratch, right)) || intrinsicRange(rep))
  releaseTemp(scratch, temp, type)
  return out
}

const foldedValue = (folded, scratch) => {
  const value = folded[0], rep = folded[1]
  if (rep === REP_F64) return typed(scratch, ['f64.const', value], REP_F64,
    Number.isFinite(value) ? [value, value] : null)
  return typed(scratch, ['i32.const', value | 0], rep, [value, value])
}

const arithmeticRange = (op, a, b, scratch) => {
  const ar = rangeOf(scratch, a), br = rangeOf(scratch, b)
  if (!ar || !br) return null
  let values
  if (op === 'f64.add') values = [ar[0] + br[0], ar[1] + br[1]]
  else if (op === 'f64.sub') values = [ar[0] - br[1], ar[1] - br[0]]
  else if (op === 'f64.mul') values = [ar[0] * br[0], ar[0] * br[1], ar[1] * br[0], ar[1] * br[1]]
  else if (op === 'f64.div' && !(br[0] <= 0 && br[1] >= 0))
    values = [ar[0] / br[0], ar[0] / br[1], ar[1] / br[0], ar[1] / br[1]]
  else return null
  const lo = Math.min(...values), hi = Math.max(...values)
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null
}

const emitBitwise = (node, index, funcId, scratch) => {
  const kind = bitwiseKind(node[0])
  const a = exactI32Bits(emitExpr(node[1], index, funcId, scratch), scratch)
  if (kind === BIT_NOT) return typed(scratch, ['i32.xor', rawValue(a), ['i32.const', -1]], REP_I32,
    intrinsicRange(REP_I32))
  const foldedRight = constantScalar(node[2])
  if (foldedRight) {
    const bits = foldedRight[0] | 0
    const shift = foldedRight[0] >>> 0 & 31
    const identity = ((kind === BIT_OR || kind === BIT_XOR) && bits === 0) ||
      (kind === BIT_AND && bits === -1) ||
      ((kind === BIT_SHL || kind === BIT_SHR || kind === BIT_USHR) && shift === 0)
    if (identity) {
      const rep = kind === BIT_USHR ? REP_U32 : REP_I32
      return typed(scratch, rawValue(a), rep, intrinsicRange(rep))
    }
  }
  const b = exactI32Bits(emitExpr(node[2], index, funcId, scratch), scratch)
  const opcode = kind === BIT_AND ? 'i32.and' : kind === BIT_OR ? 'i32.or'
    : kind === BIT_XOR ? 'i32.xor' : kind === BIT_SHL ? 'i32.shl'
    : kind === BIT_SHR ? 'i32.shr_s' : kind === BIT_USHR ? 'i32.shr_u' : null
  if (!opcode) reject(node, 'expression')
  const rep = kind === BIT_USHR ? REP_U32 : REP_I32
  return typed(scratch, [opcode, rawValue(a), rawValue(b)], rep, intrinsicRange(rep))
}

const emitBuiltin = (node, index, funcId, scratch) => {
  const kind = builtinKind(node[1])
  const args = argsOf(node[2])
  if (kind === BUILTIN_IMUL) return typed(scratch, ['i32.mul',
    rawValue(exactI32Bits(emitExpr(args[0], index, funcId, scratch), scratch)),
    rawValue(exactI32Bits(emitExpr(args[1], index, funcId, scratch), scratch))], REP_I32,
  intrinsicRange(REP_I32))
  if (kind === BUILTIN_CLZ32) return typed(scratch, ['i32.clz',
    rawValue(exactI32Bits(emitExpr(args[0], index, funcId, scratch), scratch))], REP_I32, [0, 32])
  reject(node[1], 'callee')
}

function emitExpr(node, index, funcId, scratch) {
  if (typeof node === 'string') {
    const local = localIndex(index, funcId, node)
    if (local < 0) err(`'${node}' is not a numeric local`)
    return localValue(local, scratch)
  }
  if (!Array.isArray(node)) reject(node, 'expression')
  const folded = constantScalar(node)
  if (folded) return foldedValue(folded, scratch)
  const op = node[0]
  if (op === '()' && node.length === 2) return emitExpr(node[1], index, funcId, scratch)
  if (op === '+' && node.length === 2) return emitExpr(node[1], index, funcId, scratch)
  if (op === '-' && node.length === 2) {
    const value = asF64(emitExpr(node[1], index, funcId, scratch), scratch)
    const range = rangeOf(scratch, value)
    return typed(scratch, ['f64.neg', rawValue(value)], REP_F64,
      range ? [-range[1], -range[0]] : null)
  }
  if (op === '++' || op === '--') return emitUpdateExpr(node, index, funcId, scratch)
  if (op === ',' && node.length > 2) {
    const values = new Array(node.length - 1)
    for (let i = 1; i < node.length; i++) values[i - 1] = emitExpr(node[i], index, funcId, scratch)
    const last = values[values.length - 1]
    const block = ['block', ['result', wasmType(repOf(scratch, last))]]
    for (let i = 0; i < values.length - 1; i++) block.push(['drop', rawValue(values[i])])
    block.push(rawValue(last))
    return typed(scratch, block, repOf(scratch, last), rangeOf(scratch, last))
  }
  if (logicalKind(op) !== LOGIC_NONE && node.length === 3) return emitLogical(node, index, funcId, scratch)
  if (bitwiseKind(op) !== BIT_NONE) return emitBitwise(node, index, funcId, scratch)
  const binary = arithmeticWat(arithmeticKind(op))
  if (binary && node.length === 3) {
    const a = asF64(emitExpr(node[1], index, funcId, scratch), scratch)
    const b = asF64(emitExpr(node[2], index, funcId, scratch), scratch)
    return typed(scratch, [binary, rawValue(a), rawValue(b)], REP_F64,
      arithmeticRange(binary, a, b, scratch))
  }
  if (op === '?' && node.length === 4) {
    const a = emitExpr(node[2], index, funcId, scratch)
    const b = emitExpr(node[3], index, funcId, scratch)
    const rep = repOf(scratch, a) === repOf(scratch, b) ? repOf(scratch, a) : REP_F64
    return typed(scratch, [
      'if', ['result', wasmType(rep)], emitCondition(node[1], index, funcId, scratch),
      ['then', rawValue(asRep(a, rep, scratch))],
      ['else', rawValue(asRep(b, rep, scratch))],
    ], rep, rangeUnion(rangeOf(scratch, a), rangeOf(scratch, b)) || intrinsicRange(rep))
  }
  if (op === '()' && typeof node[1] === 'string') {
    const target = callTargetId(index, funcId, node[1])
    const wasmId = index[I_FN_WASM_ID][target]
    if (wasmId < 0) err(`internal unreachable call target '${node[1]}'`)
    const args = argsOf(node[2])
    const call = ['call', wasmId]
    for (let i = 0; i < args.length; i++)
      call.push(rawValue(asF64(emitExpr(args[i], index, funcId, scratch), scratch)))
    const rep = index[I_FN_RESULT_REP][target]
    return typed(scratch, call, rep, intrinsicRange(rep))
  }
  if (op === '()' && builtinKind(node[1]) !== BUILTIN_NONE) return emitBuiltin(node, index, funcId, scratch)
  if (comparisonKind(op) !== OP_NONE) err(`comparison '${op}' is supported only as a condition`)
  reject(node, 'expression')
}

const emitSet = (name, value, index, funcId, scratch) => {
  const local = localIndex(index, funcId, name)
  if (local < 0) err(`assignment to unknown local '${name}'`)
  return ['local.set', watLocal(local), rawValue(asRep(
    emitExpr(value, index, funcId, scratch), scratch.bindingReps[local], scratch))]
}

const needsContinueBlock = (node, labels, nested = 0) => {
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (op === 'continue') return node[1] != null ? labels.includes(node[1]) : nested === 0
  if (op === 'while' || op === 'for' || op === 'do') {
    const body = op === 'while' ? node[2] : op === 'for' ? node[2] : node[1]
    return needsContinueBlock(body, labels, nested + 1)
  }
  for (let i = 1; i < node.length; i++) if (needsContinueBlock(node[i], labels, nested)) return true
  return false
}

const appendLoop = (out, node, labels, index, funcId, scratch) => {
  const op = node[0]
  if (op === 'while' && constantTruth(node[1]) === 0) return
  const head = op === 'for' ? forHead(node[1]) : null
  if (head) {
    appendStmt(out, head[0], index, funcId, scratch)
    if (head[1] != null && constantTruth(head[1]) === 0) return
  }

  const id = scratch.labelUid++
  const loopLabel = `$loop${id}`, breakLabel = `$break${id}`
  const bodyNode = op === 'while' ? node[2] : op === 'for' ? node[2] : node[1]
  const hasContinue = op !== 'while' && needsContinueBlock(bodyNode, labels)
  const continueLabel = hasContinue ? `$continue${id}` : loopLabel
  const loop = ['loop', loopLabel]
  if (op === 'while') loop.push(['br_if', breakLabel, ['i32.eqz', emitCondition(node[1], index, funcId, scratch)]])
  else if (op === 'for' && head[1] != null) loop.push(['br_if', breakLabel, ['i32.eqz', emitCondition(head[1], index, funcId, scratch)]])

  const controlCount = pushControls(scratch, labels, breakLabel, continueLabel)
  if (!hasContinue) appendStmt(loop, bodyNode, index, funcId, scratch)
  else {
    const body = ['block', continueLabel]
    appendStmt(body, bodyNode, index, funcId, scratch)
    loop.push(body)
  }
  popControls(scratch, controlCount)

  if (op === 'for') appendStmt(loop, head[2], index, funcId, scratch)
  if (op === 'do') loop.push(['br_if', loopLabel, emitCondition(node[2], index, funcId, scratch)])
  else loop.push(['br', loopLabel])
  out.push(['block', breakLabel, loop])
}

const appendLabeled = (out, node, index, funcId, scratch) => {
  if (iterationTarget(node)) {
    const labels = []
    while (node[0] === ':') { labels.push(node[1]); node = node[2] }
    appendLoop(out, node, labels, index, funcId, scratch)
    return
  }
  const id = scratch.labelUid++
  const breakLabel = `$break${id}`
  const control = [node[1], breakLabel, null, 0]
  scratch.controls.push(control)
  if (scratch.controls.length > scratch.maxControlDepth) scratch.maxControlDepth = scratch.controls.length
  const block = ['block', breakLabel]
  appendStmt(block, node[2], index, funcId, scratch)
  scratch.controls.pop()
  out.push(block)
}

const appendStmt = (out, node, index, funcId, scratch) => {
  if (node == null) return
  if (!Array.isArray(node)) reject(node, 'statement')
  const op = node[0]
  if (op === '{}' || op === ';') {
    const stmts = bodyList(node)
    for (let i = 0; i < stmts.length; i++) appendStmt(out, stmts[i], index, funcId, scratch)
    return
  }
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < node.length; i++) out.push(emitSet(node[i][1], node[i][2], index, funcId, scratch))
    return
  }
  if (op === '=') { out.push(emitSet(node[1], node[2], index, funcId, scratch)); return }
  const assignment = arithmeticWat(assignmentKind(op))
  if (assignment) {
    const local = localIndex(index, funcId, node[1])
    if (local < 0) err(`assignment to unknown local '${node[1]}'`)
    if (scratch.bindingReps[local] !== REP_F64) err(`internal assignment representation for '${node[1]}' is not f64`)
    out.push(['local.set', watLocal(local), [assignment,
      rawValue(asF64(localValue(local, scratch), scratch)),
      rawValue(asF64(emitExpr(node[2], index, funcId, scratch), scratch))]])
    return
  }
  const bitwiseAssignment = bitwiseAssignmentKind(op)
  if (bitwiseAssignment !== BIT_NONE) {
    const local = localIndex(index, funcId, node[1])
    if (local < 0) err(`assignment to unknown local '${node[1]}'`)
    const expr = [op.slice(0, -1), node[1], node[2]]
    out.push(['local.set', watLocal(local), rawValue(asRep(
      emitBitwise(expr, index, funcId, scratch), scratch.bindingReps[local], scratch))])
    return
  }
  if (op === '++' || op === '--') {
    const local = localIndex(index, funcId, node[1])
    if (local < 0) err(`update of unknown local '${node[1]}'`)
    if (scratch.bindingReps[local] !== REP_F64) err(`internal update representation for '${node[1]}' is not f64`)
    out.push(['local.set', watLocal(local), [op === '++' ? 'f64.add' : 'f64.sub',
      rawValue(localValue(local, scratch)), ['f64.const', 1]]])
    return
  }
  if (op === 'return') {
    out.push(['return', rawValue(asRep(
      emitExpr(node[1], index, funcId, scratch), index[I_FN_RESULT_REP][funcId], scratch))])
    return
  }
  if (op === 'if') {
    const folded = constantTruth(node[1])
    if (folded !== undefined) {
      const selected = folded ? node[2] : node.length > 3 ? node[3] : null
      appendStmt(out, selected, index, funcId, scratch)
      return
    }
    const thenBody = ['then']
    appendStmt(thenBody, node[2], index, funcId, scratch)
    const wat = ['if', emitCondition(node[1], index, funcId, scratch), thenBody]
    if (node.length > 3 && node[3] != null) {
      const elseBody = ['else']
      appendStmt(elseBody, node[3], index, funcId, scratch)
      wat.push(elseBody)
    }
    out.push(wat)
    return
  }
  if (op === 'while' || op === 'for' || op === 'do') { appendLoop(out, node, [], index, funcId, scratch); return }
  if (op === ':') { appendLabeled(out, node, index, funcId, scratch); return }
  if (op === 'break' || op === 'continue') { out.push(['br', controlTarget(node, scratch)]); return }
  if (op === '()' || op === ',' || logicalKind(op) !== LOGIC_NONE || bitwiseKind(op) !== BIT_NONE) {
    out.push(['drop', rawValue(emitExpr(node, index, funcId, scratch))])
    return
  }
  reject(node, 'statement')
}

const treeNodeCount = (node) => {
  if (!Array.isArray(node)) return 1
  let count = 1
  for (let i = 1; i < node.length; i++) count += treeNodeCount(node[i])
  return count
}

export function lowerFunction(index, funcId, metrics, moduleState) {
  const sourceLocals = index[I_FN_LOCAL_COUNT][funcId]
  const bindingAnalysis = analyzeBindings(index, funcId)
  const scratch = {
    labelUid: 0,
    controls: [],
    tempBase: index[I_FN_PARAM_COUNT][funcId] + sourceLocals,
    tempTypes: [],
    freeTemps: { f64: [], i32: [], i64: [] },
    activeTemps: 0,
    maxTemporaryLocals: 0,
    maxControlDepth: 0,
    bindingReps: bindingAnalysis.reps,
    bindingRanges: bindingAnalysis.ranges,
    moduleState,
  }
  const instructions = []
  const body = index[I_FN_BODY][funcId]
  if (Array.isArray(body) && body[0] !== '{}' && body[0] !== ';' && body[0] !== 'return') {
    instructions.push(rawValue(asRep(
      emitExpr(body, index, funcId, scratch), index[I_FN_RESULT_REP][funcId], scratch)))
  } else {
    appendStmt(instructions, body, index, funcId, scratch)
    instructions.push(['unreachable'])
  }
  if (scratch.activeTemps !== 0) err(`internal temporary lifetime leak in function ${funcId}`)

  const fn = ['func', ['type', index[I_FN_TYPE_ID][funcId]]]
  const params = index[I_FN_PARAM_COUNT][funcId]
  for (let i = 0; i < params; i++) fn.push(['param', watLocal(i), 'f64'])
  fn.push(['result', wasmType(index[I_FN_RESULT_REP][funcId])])
  for (let i = 0; i < sourceLocals; i++)
    fn.push(['local', watLocal(params + i), wasmType(scratch.bindingReps[params + i])])
  for (let i = 0; i < scratch.tempTypes.length; i++)
    fn.push(['local', watLocal(scratch.tempBase + i), scratch.tempTypes[i]])
  for (let i = 0; i < instructions.length; i++) fn.push(instructions[i])

  if (metrics) {
    metrics.functionCount = (metrics.functionCount || 0) + 1
    const slots = 1 + scratch.maxTemporaryLocals + scratch.maxControlDepth * 4
    metrics.maxScratchSlots = Math.max(metrics.maxScratchSlots || 0, slots)
    metrics.maxLoopLabels = Math.max(metrics.maxLoopLabels || 0, scratch.labelUid)
    metrics.maxControlDepth = Math.max(metrics.maxControlDepth || 0, scratch.maxControlDepth)
    metrics.maxTemporaryLocals = Math.max(metrics.maxTemporaryLocals || 0, scratch.maxTemporaryLocals)
    metrics.maxRepresentationFacts = Math.max(metrics.maxRepresentationFacts || 0,
      scratch.bindingReps.reduce((n, rep) => n + (isI32Rep(rep) ? 1 : 0), 0))
    metrics.maxRangeFacts = Math.max(metrics.maxRangeFacts || 0,
      scratch.bindingRanges.reduce((n, range) => n + (range ? 1 : 0), 0))
    metrics.maxFunctionWatNodes = Math.max(metrics.maxFunctionWatNodes || 0, treeNodeCount(fn))
  }
  return fn
}

export function lowerProgram(index, metrics) {
  const moduleState = { exactI32WasmId: index[I_EXACT_I32_WASM_ID], needsExactI32: false }
  const functions = []
  for (let funcId = 0; funcId < functionCount(index); funcId++) {
    if (index[I_FN_REACHABLE][funcId]) functions.push(lowerFunction(index, funcId, metrics, moduleState))
  }

  const module = ['module']
  const types = index[I_TYPE_PARAM_COUNT]
  const results = index[I_TYPE_RESULT_REP]
  const typeCount = types.length - (!moduleState.needsExactI32 && index[I_EXACT_I32_OWNS_TYPE] ? 1 : 0)
  for (let typeId = 0; typeId < typeCount; typeId++) {
    const signature = ['func']
    for (let i = 0; i < types[typeId]; i++) signature.push(['param', watLocal(i), 'f64'])
    signature.push(['result', wasmType(results[typeId])])
    module.push(['type', signature])
  }
  for (let i = 0; i < functions.length; i++) module.push(functions[i])
  if (moduleState.needsExactI32) {
    module.push(exactI32Helper(index[I_EXACT_I32_TYPE_ID]))
    if (metrics) metrics.exactI32HelperCount = 1
  }
  const exportFuncs = index[I_EXPORT_FUNC]
  const exportNames = index[I_EXPORT_NAME]
  for (let i = 0; i < exportFuncs.length; i++) {
    const wasmId = index[I_FN_WASM_ID][exportFuncs[i]]
    module.push(['export', `"${exportNames[i]}"`, ['func', wasmId]])
  }
  return module
}
