// Frozen whole-program authority for the compact staged prototype.
//
// Every cross-function decision is numeric after this stage. Names remain only
// for diagnostics and export spelling. Function bodies remain positional ASTs
// and are traversed directly by one disposable lowering lifetime.

import {
  F_BODY, F_EXPORT, F_LOCALS, F_MUTABLES, F_NAME, F_PARAMS,
  argsOf, bodyList, err, forHead, reject,
} from './prepare.js'
import { constantScalar, isBooleanLiteral } from './constants.js'
import {
  BIT_NONE, BIT_USHR, BUILTIN_CLZ32, BUILTIN_IMUL, BUILTIN_NONE,
  LOGIC_NONE, OP_NONE,
  arithmeticKind, assignmentKind, bitwiseAssignmentKind, bitwiseKind, builtinKind,
  comparisonKind, logicalKind,
} from './ops.js'
import { REP_F64, REP_I32, REP_U32, REP_UNKNOWN, physicalRep } from './reps.js'

export const ABI_JS = 0
export const ABI_RAW = 1
export { REP_F64, REP_I32, REP_U32 }

export const B_PARAM = 1
export const B_MUTABLE = 2

export const I_FN_NAME = 0
export const I_FN_BODY = 1
export const I_FN_BIND_START = 2
export const I_FN_PARAM_COUNT = 3
export const I_FN_LOCAL_COUNT = 4
export const I_FN_EXPORTED = 5
export const I_FN_RESULT_REP = 6
export const I_FN_EDGE_START = 7
export const I_FN_EDGE_COUNT = 8
export const I_FN_REACHABLE = 9
export const I_FN_TYPE_ID = 10
export const I_FN_WASM_ID = 11
export const I_BIND_NAME = 12
export const I_BIND_FLAGS = 13
export const I_BIND_REP = 14
export const I_EDGE_TARGET = 15
export const I_TYPE_PARAM_COUNT = 16
export const I_EXPORT_FUNC = 17
export const I_EXPORT_NAME = 18
export const I_ABI_MODE = 19
export const I_TYPE_RESULT_REP = 20
export const I_EXACT_I32_WASM_ID = 21
export const I_EXACT_I32_TYPE_ID = 22
export const I_EXACT_I32_OWNS_TYPE = 23

export const functionCount = (index) => index[I_FN_NAME].length

export const findFunctionId = (index, name) => {
  const names = index[I_FN_NAME]
  for (let i = 0; i < names.length; i++) if (names[i] === name) return i
  return -1
}

export const findBindingId = (index, funcId, name) => {
  const start = index[I_FN_BIND_START][funcId]
  const count = index[I_FN_PARAM_COUNT][funcId] + index[I_FN_LOCAL_COUNT][funcId]
  const names = index[I_BIND_NAME]
  for (let i = 0; i < count; i++) if (names[start + i] === name) return start + i
  return -1
}

export const localIndex = (index, funcId, name) => {
  const binding = findBindingId(index, funcId, name)
  return binding < 0 ? -1 : binding - index[I_FN_BIND_START][funcId]
}

export const callTargetId = (index, funcId, name) => {
  if (findBindingId(index, funcId, name) >= 0) err(`dynamic call through local '${name}' is unsupported`)
  const target = findFunctionId(index, name)
  if (target < 0) err(`unknown direct function '${name}'`)
  return target
}

const checkCall = (node, declared, assigned, index, funcId, edges) => {
  const name = node[1]
  const target = callTargetId(index, funcId, name)
  const args = argsOf(node[2])
  const expected = index[I_FN_PARAM_COUNT][target]
  if (args.length !== expected) err(`call to '${name}' has ${args.length} arguments, expected ${expected}`)
  edges.push(target)
  for (let i = 0; i < args.length; i++) checkExpr(args[i], declared, assigned, index, funcId, edges)
}

const checkBuiltinCall = (node, declared, assigned, index, funcId, edges) => {
  const builtin = builtinKind(node[1])
  if (builtin === BUILTIN_NONE) reject(node[1], 'callee')
  const args = argsOf(node[2])
  const expected = builtin === BUILTIN_IMUL ? 2 : 1
  if (args.length !== expected) {
    const name = builtin === BUILTIN_IMUL ? 'Math.imul' : builtin === BUILTIN_CLZ32 ? 'Math.clz32' : 'builtin'
    err(`${name} has ${args.length} arguments, expected ${expected}`)
  }
  for (let i = 0; i < args.length; i++) checkExpr(args[i], declared, assigned, index, funcId, edges)
}

function checkExpr(node, declared, assigned, index, funcId, edges) {
  if (typeof node === 'string') {
    const idx = localIndex(index, funcId, node)
    if (idx < 0) err(`'${node}' is not a numeric local`)
    if (!declared[idx] || !assigned[idx]) err(`'${node}' may be read before its declaration`)
    return
  }
  if (!Array.isArray(node)) reject(node, 'expression')
  if (node[0] == null && node.length === 2 && typeof node[1] === 'number') return
  if (isBooleanLiteral(node)) return
  const op = node[0]
  if (op === '()' && node.length === 2) { checkExpr(node[1], declared, assigned, index, funcId, edges); return }
  if (op === '()' && typeof node[1] === 'string') { checkCall(node, declared, assigned, index, funcId, edges); return }
  if (op === '()') { checkBuiltinCall(node, declared, assigned, index, funcId, edges); return }
  if (op === '?' && node.length === 4) {
    checkExpr(node[1], declared, assigned, index, funcId, edges)
    checkExpr(node[2], declared, assigned, index, funcId, edges)
    checkExpr(node[3], declared, assigned, index, funcId, edges)
    return
  }
  if (op === '++' || op === '--') { checkAssignTarget(node[1], declared, assigned, index, funcId, true); return }
  if (op === ',' && node.length > 2) {
    for (let i = 1; i < node.length; i++) checkExpr(node[i], declared, assigned, index, funcId, edges)
    return
  }
  if (logicalKind(op) !== LOGIC_NONE && node.length === 3) {
    checkExpr(node[1], declared, assigned, index, funcId, edges)
    checkExpr(node[2], declared, assigned, index, funcId, edges)
    return
  }
  if (bitwiseKind(op) !== BIT_NONE && (node.length === 3 || op === '~' && node.length === 2)) {
    checkExpr(node[1], declared, assigned, index, funcId, edges)
    if (node.length === 3) checkExpr(node[2], declared, assigned, index, funcId, edges)
    return
  }
  if ((arithmeticKind(op) !== OP_NONE || comparisonKind(op) !== OP_NONE) &&
      (node.length === 2 || node.length === 3)) {
    checkExpr(node[1], declared, assigned, index, funcId, edges)
    if (node.length === 3) checkExpr(node[2], declared, assigned, index, funcId, edges)
    return
  }
  if (op === '!' && node.length === 2) { checkExpr(node[1], declared, assigned, index, funcId, edges); return }
  reject(node, 'expression')
}

const checkAssignTarget = (name, declared, assigned, index, funcId, read) => {
  const binding = findBindingId(index, funcId, name)
  const local = binding < 0 ? -1 : binding - index[I_FN_BIND_START][funcId]
  if (local < 0 || !declared[local]) err(`assignment to undeclared local '${name}'`)
  if (!(index[I_BIND_FLAGS][binding] & B_MUTABLE)) err(`assignment to const local '${name}' is unsupported`)
  if (read && !assigned[local]) err(`'${name}' may be updated before initialization`)
  return local
}

const isLoopStmt = (node) => Array.isArray(node) && (node[0] === 'while' || node[0] === 'for' || node[0] === 'do')

const checkControlTarget = (node, controls) => {
  const label = node[1]
  for (let i = controls.length - 1; i >= 0; i--) {
    const control = controls[i]
    if (label != null ? control[0] === label : control[1]) {
      if (node[0] === 'continue' && !control[1]) err(`continue target '${label}' is not a loop`)
      return
    }
  }
  if (label != null) err(`unknown ${node[0]} label '${label}'`)
  err(`${node[0]} is not inside a loop`)
}

function checkStmt(node, declared, assigned, index, funcId, edges, controls) {
  if (node == null) return
  if (!Array.isArray(node)) reject(node, 'statement')
  const op = node[0]
  if (op === '{}' || op === ';') {
    const scoped = op === '{}'
    const savedDeclared = scoped ? declared.slice() : null
    const savedAssigned = scoped ? assigned.slice() : null
    const stmts = bodyList(node)
    for (let i = 0; i < stmts.length; i++) checkStmt(stmts[i], declared, assigned, index, funcId, edges, controls)
    if (scoped) for (let i = 0; i < declared.length; i++) {
      declared[i] = savedDeclared[i]
      assigned[i] = savedAssigned[i]
    }
    return
  }
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < node.length; i++) {
      const name = node[i][1]
      const local = localIndex(index, funcId, name)
      if (local < 0 || declared[local]) err(`duplicate declaration '${name}'`)
      declared[local] = true
      checkExpr(node[i][2], declared, assigned, index, funcId, edges)
      assigned[local] = true
    }
    return
  }
  if (op === '=') {
    const local = checkAssignTarget(node[1], declared, assigned, index, funcId, false)
    checkExpr(node[2], declared, assigned, index, funcId, edges)
    assigned[local] = true
    return
  }
  if (assignmentKind(op) !== OP_NONE || bitwiseAssignmentKind(op) !== BIT_NONE) {
    checkAssignTarget(node[1], declared, assigned, index, funcId, true)
    checkExpr(node[2], declared, assigned, index, funcId, edges)
    return
  }
  if (op === '++' || op === '--') { checkAssignTarget(node[1], declared, assigned, index, funcId, true); return }
  if (op === 'return') { checkExpr(node[1], declared, assigned, index, funcId, edges); return }
  if (op === 'if') {
    checkExpr(node[1], declared, assigned, index, funcId, edges)
    checkStmt(node[2], declared.slice(), assigned.slice(), index, funcId, edges, controls)
    if (node.length > 3 && node[3] != null) checkStmt(node[3], declared.slice(), assigned.slice(), index, funcId, edges, controls)
    return
  }
  if (op === 'while') {
    checkExpr(node[1], declared, assigned, index, funcId, edges)
    controls.push([null, 1])
    checkStmt(node[2], declared.slice(), assigned.slice(), index, funcId, edges, controls)
    controls.pop()
    return
  }
  if (op === 'do') {
    const d = declared.slice(), a = assigned.slice()
    controls.push([null, 1])
    checkStmt(node[1], d, a, index, funcId, edges, controls)
    controls.pop()
    checkExpr(node[2], d, a, index, funcId, edges)
    return
  }
  if (op === 'for') {
    const head = forHead(node[1])
    const d = declared.slice(), a = assigned.slice()
    checkStmt(head[0], d, a, index, funcId, edges, controls)
    if (head[1] != null) checkExpr(head[1], d, a, index, funcId, edges)
    controls.push([null, 1])
    checkStmt(node[2], d, a, index, funcId, edges, controls)
    controls.pop()
    checkStmt(head[2], d, a, index, funcId, edges, controls)
    return
  }
  if (op === ':') {
    for (let i = controls.length - 1; i >= 0; i--) if (controls[i][0] === node[1]) err(`duplicate label '${node[1]}'`)
    controls.push([node[1], isLoopStmt(node[2]) ? 1 : 0])
    checkStmt(node[2], declared, assigned, index, funcId, edges, controls)
    controls.pop()
    return
  }
  if (op === 'break' || op === 'continue') { checkControlTarget(node, controls); return }
  if (op === '()' || op === ',' || logicalKind(op) !== LOGIC_NONE || bitwiseKind(op) !== BIT_NONE) {
    checkExpr(node, declared, assigned, index, funcId, edges)
    return
  }
  reject(node, 'statement')
}

const checkFunction = (index, funcId, edges) => {
  const params = index[I_FN_PARAM_COUNT][funcId]
  const count = params + index[I_FN_LOCAL_COUNT][funcId]
  const declared = new Array(count).fill(false)
  const assigned = new Array(count).fill(false)
  for (let i = 0; i < params; i++) declared[i] = assigned[i] = true
  const body = index[I_FN_BODY][funcId]
  if (Array.isArray(body) && body[0] === '{}') {
    const stmts = bodyList(body)
    const controls = []
    for (let i = 0; i < stmts.length; i++) checkStmt(stmts[i], declared, assigned, index, funcId, edges, controls)
  } else if (Array.isArray(body) && (body[0] === ';' || body[0] === 'return')) {
    checkStmt(body, declared, assigned, index, funcId, edges, [])
  } else {
    checkExpr(body, declared, assigned, index, funcId, edges)
  }
}

const normalizedExportParams = (func) => {
  if (!func[F_EXPORT] || !func[F_PARAMS].length) return true
  const stmts = bodyList(func[F_BODY])
  if (stmts.length < func[F_PARAMS].length) return false
  for (let i = 0; i < func[F_PARAMS].length; i++) {
    const name = func[F_PARAMS][i]
    const stmt = stmts[i]
    if (!Array.isArray(stmt) || stmt[0] !== '=' || stmt[1] !== name ||
        !Array.isArray(stmt[2]) || stmt[2][0] !== '+' || stmt[2].length !== 2 || stmt[2][1] !== name) return false
  }
  return true
}

const abiMode = (options) => {
  const abi = options?.abi ?? 'js'
  if (abi === 'js') return ABI_JS
  if (abi === 'raw') return ABI_RAW
  err(`unknown ABI '${abi}'`)
}

const markReachable = (index) => {
  const reachable = index[I_FN_REACHABLE]
  const stack = []
  const roots = index[I_EXPORT_FUNC]
  for (let i = 0; i < roots.length; i++) stack.push(roots[i])
  while (stack.length) {
    const funcId = stack.pop()
    if (reachable[funcId]) continue
    reachable[funcId] = 1
    const start = index[I_FN_EDGE_START][funcId]
    const count = index[I_FN_EDGE_COUNT][funcId]
    for (let i = 0; i < count; i++) stack.push(index[I_EDGE_TARGET][start + i])
  }
}

const expressionResultRep = (node, index, funcId) => {
  if (!Array.isArray(node)) return REP_F64
  const folded = constantScalar(node)
  if (folded) return folded[1]
  const op = node[0]
  if (op === '()' && node.length === 2) return expressionResultRep(node[1], index, funcId)
  if (op === '+' && node.length === 2) return expressionResultRep(node[1], index, funcId)
  const bitwise = bitwiseKind(op)
  if (bitwise !== BIT_NONE) return bitwise === BIT_USHR ? REP_U32 : REP_I32
  if (op === '()' && typeof node[1] === 'string') {
    const target = callTargetId(index, funcId, node[1])
    return index[I_FN_RESULT_REP][target]
  }
  if (op === '()' && builtinKind(node[1]) !== BUILTIN_NONE) return REP_I32
  if (op === '?' && node.length === 4 || logicalKind(op) !== LOGIC_NONE && node.length === 3) {
    const a = expressionResultRep(node[op === '?' ? 2 : 1], index, funcId)
    const b = expressionResultRep(node[op === '?' ? 3 : 2], index, funcId)
    return a === REP_UNKNOWN || b === REP_UNKNOWN ? REP_UNKNOWN : a === b ? a : REP_F64
  }
  if (op === ',' && node.length > 2) return expressionResultRep(node[node.length - 1], index, funcId)
  return REP_F64
}

const functionResultRep = (index, funcId) => {
  if (index[I_FN_EXPORTED][funcId]) return REP_F64
  const body = index[I_FN_BODY][funcId]
  if (!Array.isArray(body) || body[0] !== '{}' && body[0] !== ';' && body[0] !== 'return')
    return expressionResultRep(body, index, funcId)
  const returns = []
  const visit = (node) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'return') { returns.push(node[1]); return }
    for (let i = 1; i < node.length; i++) visit(node[i])
  }
  visit(body)
  if (!returns.length) return REP_F64
  let rep = expressionResultRep(returns[0], index, funcId)
  for (let i = 1; i < returns.length; i++) {
    const next = expressionResultRep(returns[i], index, funcId)
    if (rep === REP_UNKNOWN || next === REP_UNKNOWN) rep = REP_UNKNOWN
    else if (rep !== next) return REP_F64
  }
  return rep
}

const inferResultReps = (index) => {
  const reps = index[I_FN_RESULT_REP]
  for (let funcId = 0; funcId < functionCount(index); funcId++)
    reps[funcId] = index[I_FN_EXPORTED][funcId] || !index[I_FN_REACHABLE][funcId] ? REP_F64 : REP_UNKNOWN
  for (let pass = 0; pass < functionCount(index); pass++) {
    let changed = false
    for (let funcId = 0; funcId < functionCount(index); funcId++) {
      if (!index[I_FN_REACHABLE][funcId] || index[I_FN_EXPORTED][funcId]) continue
      const rep = functionResultRep(index, funcId)
      if (rep !== REP_UNKNOWN && reps[funcId] !== rep) { reps[funcId] = rep; changed = true }
    }
    if (!changed) break
  }
  for (let funcId = 0; funcId < functionCount(index); funcId++) if (reps[funcId] === REP_UNKNOWN) reps[funcId] = REP_F64
}

const mayNeedExactI32 = (node) => {
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (bitwiseKind(op) !== BIT_NONE && !constantScalar(node)) return true
  if (bitwiseAssignmentKind(op) !== BIT_NONE) return true
  if (op === '()' && builtinKind(node[1]) !== BUILTIN_NONE && !constantScalar(node)) return true
  for (let i = 1; i < node.length; i++) if (mayNeedExactI32(node[i])) return true
  return false
}

const assignFinalIds = (index) => {
  const typeParams = index[I_TYPE_PARAM_COUNT]
  const typeResults = index[I_TYPE_RESULT_REP]
  let wasmId = 0
  for (let funcId = 0; funcId < functionCount(index); funcId++) {
    if (!index[I_FN_REACHABLE][funcId]) continue
    const arity = index[I_FN_PARAM_COUNT][funcId]
    const result = physicalRep(index[I_FN_RESULT_REP][funcId])
    let typeId = -1
    for (let i = 0; i < typeParams.length; i++) if (typeParams[i] === arity && typeResults[i] === result) { typeId = i; break }
    if (typeId < 0) { typeId = typeParams.length; typeParams.push(arity); typeResults.push(result) }
    index[I_FN_TYPE_ID][funcId] = typeId
    index[I_FN_WASM_ID][funcId] = wasmId++
  }
  let needsExactI32 = false
  for (let funcId = 0; funcId < functionCount(index); funcId++)
    if (index[I_FN_REACHABLE][funcId] && mayNeedExactI32(index[I_FN_BODY][funcId])) { needsExactI32 = true; break }
  if (!needsExactI32) return
  let typeId = -1
  for (let i = 0; i < typeParams.length; i++)
    if (typeParams[i] === 1 && typeResults[i] === REP_I32) { typeId = i; break }
  if (typeId < 0) {
    typeId = typeParams.length
    typeParams.push(1)
    typeResults.push(REP_I32)
    index[I_EXACT_I32_OWNS_TYPE] = 1
  }
  index[I_EXACT_I32_TYPE_ID] = typeId
  index[I_EXACT_I32_WASM_ID] = wasmId
}

export function buildProgramIndex(funcs, options) {
  const count = funcs.length
  const abi = abiMode(options)
  const index = [
    new Array(count), new Array(count), new Array(count), new Array(count), new Array(count),
    new Array(count), new Array(count), new Array(count), new Array(count), new Array(count).fill(0),
    new Array(count).fill(-1), new Array(count).fill(-1), [], [], [], [], [], [], [], abi, [], -1, -1, 0,
  ]

  for (let funcId = 0; funcId < count; funcId++) {
    const func = funcs[funcId]
    index[I_FN_NAME][funcId] = func[F_NAME]
    index[I_FN_BODY][funcId] = func[F_BODY]
    index[I_FN_BIND_START][funcId] = index[I_BIND_NAME].length
    index[I_FN_PARAM_COUNT][funcId] = func[F_PARAMS].length
    index[I_FN_LOCAL_COUNT][funcId] = func[F_LOCALS].length
    index[I_FN_EXPORTED][funcId] = func[F_EXPORT]
    index[I_FN_RESULT_REP][funcId] = REP_F64
    if (abi === ABI_JS && !normalizedExportParams(func))
      err(`export '${func[F_NAME]}' must normalize each parameter with a leading 'p = +p'`)
    for (let i = 0; i < func[F_PARAMS].length; i++) {
      index[I_BIND_NAME].push(func[F_PARAMS][i])
      index[I_BIND_FLAGS].push(B_PARAM | B_MUTABLE)
      index[I_BIND_REP].push(REP_F64)
    }
    for (let i = 0; i < func[F_LOCALS].length; i++) {
      index[I_BIND_NAME].push(func[F_LOCALS][i])
      index[I_BIND_FLAGS].push(func[F_MUTABLES][i] ? B_MUTABLE : 0)
      index[I_BIND_REP].push(REP_F64)
    }
    if (func[F_EXPORT]) {
      index[I_EXPORT_FUNC].push(funcId)
      index[I_EXPORT_NAME].push(func[F_NAME])
    }
  }

  const edges = index[I_EDGE_TARGET]
  for (let funcId = 0; funcId < count; funcId++) {
    index[I_FN_EDGE_START][funcId] = edges.length
    checkFunction(index, funcId, edges)
    index[I_FN_EDGE_COUNT][funcId] = edges.length - index[I_FN_EDGE_START][funcId]
  }

  markReachable(index)
  inferResultReps(index)
  assignFinalIds(index)
  return index
}
