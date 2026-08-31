// Per-function AST to scalar WAT lowering for the compact staged prototype.
// The ProgramIndex is read-only here. Each function body is materialized once,
// appended to the module, and then all function-local traversal state dies.

import { argsOf, bodyList, err, forHead, reject } from './prepare.js'
import {
  CMP_EQ, CMP_GE, CMP_GT, CMP_LE, CMP_LT, CMP_NE, OP_ADD, OP_DIV, OP_MUL, OP_NONE, OP_SUB,
  arithmeticKind, assignmentKind, comparisonKind,
} from './ops.js'
import {
  I_EXPORT_FUNC, I_EXPORT_NAME, I_FN_BODY, I_FN_LOCAL_COUNT, I_FN_PARAM_COUNT,
  I_FN_REACHABLE, I_FN_TYPE_ID, I_FN_WASM_ID, I_TYPE_PARAM_COUNT,
  callTargetId, functionCount, localIndex,
} from './program-index.js'

const constantNumber = (node) => {
  if (!Array.isArray(node)) return undefined
  if (node[0] == null && node.length === 2 && typeof node[1] === 'number') return node[1]
  if (node[0] === '()' && node.length === 2) return constantNumber(node[1])
  const op = node[0]
  const a = constantNumber(node[1])
  if (a === undefined) return undefined
  if (node.length === 2) return op === '+' ? +a : op === '-' ? -a : undefined
  if (node.length !== 3) return undefined
  const b = constantNumber(node[2])
  if (b === undefined) return undefined
  return op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : undefined
}

const arithmeticWat = (kind) => kind === OP_ADD ? 'f64.add' : kind === OP_SUB ? 'f64.sub'
  : kind === OP_MUL ? 'f64.mul' : kind === OP_DIV ? 'f64.div' : null

const comparisonWat = (kind) => kind === CMP_EQ ? 'f64.eq' : kind === CMP_NE ? 'f64.ne'
  : kind === CMP_LT ? 'f64.lt' : kind === CMP_GT ? 'f64.gt'
  : kind === CMP_LE ? 'f64.le' : kind === CMP_GE ? 'f64.ge' : null

function emitCondition(node, index, funcId, scratch) {
  if (Array.isArray(node)) {
    if (node[0] === '()' && node.length === 2) return emitCondition(node[1], index, funcId, scratch)
    const cmp = comparisonWat(comparisonKind(node[0]))
    if (cmp) return [cmp, emitExpr(node[1], index, funcId, scratch), emitExpr(node[2], index, funcId, scratch)]
    if (node[0] === '!' && node.length === 2) return ['i32.eqz', emitCondition(node[1], index, funcId, scratch)]
  }
  return ['f64.gt', ['f64.abs', emitExpr(node, index, funcId, scratch)], ['f64.const', 0]]
}

function emitExpr(node, index, funcId, scratch) {
  if (typeof node === 'string') {
    const local = localIndex(index, funcId, node)
    if (local < 0) err(`'${node}' is not a numeric local`)
    return ['local.get', local]
  }
  if (!Array.isArray(node)) reject(node, 'expression')
  const folded = constantNumber(node)
  if (folded !== undefined) return ['f64.const', folded]
  const op = node[0]
  if (op === '()' && node.length === 2) return emitExpr(node[1], index, funcId, scratch)
  if (op === '+' && node.length === 2) return emitExpr(node[1], index, funcId, scratch)
  if (op === '-' && node.length === 2) return ['f64.neg', emitExpr(node[1], index, funcId, scratch)]
  const binary = arithmeticWat(arithmeticKind(op))
  if (binary && node.length === 3) return [binary, emitExpr(node[1], index, funcId, scratch), emitExpr(node[2], index, funcId, scratch)]
  if (op === '?' && node.length === 4) return [
    'if', ['result', 'f64'], emitCondition(node[1], index, funcId, scratch),
    ['then', emitExpr(node[2], index, funcId, scratch)],
    ['else', emitExpr(node[3], index, funcId, scratch)],
  ]
  if (op === '()' && typeof node[1] === 'string') {
    const target = callTargetId(index, funcId, node[1])
    const wasmId = index[I_FN_WASM_ID][target]
    if (wasmId < 0) err(`internal unreachable call target '${node[1]}'`)
    const args = argsOf(node[2])
    const call = ['call', wasmId]
    for (let i = 0; i < args.length; i++) call.push(emitExpr(args[i], index, funcId, scratch))
    return call
  }
  if (comparisonKind(op) !== OP_NONE) err(`comparison '${op}' is supported only as a condition`)
  reject(node, 'expression')
}

const emitSet = (name, value, index, funcId, scratch) => {
  const local = localIndex(index, funcId, name)
  if (local < 0) err(`assignment to unknown local '${name}'`)
  return ['local.set', local, emitExpr(value, index, funcId, scratch)]
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
    out.push(['local.set', local, [assignment, ['local.get', local], emitExpr(node[2], index, funcId, scratch)]])
    return
  }
  if (op === '++' || op === '--') {
    const local = localIndex(index, funcId, node[1])
    if (local < 0) err(`update of unknown local '${node[1]}'`)
    out.push(['local.set', local, [op === '++' ? 'f64.add' : 'f64.sub', ['local.get', local], ['f64.const', 1]]])
    return
  }
  if (op === 'return') { out.push(['return', emitExpr(node[1], index, funcId, scratch)]); return }
  if (op === 'if') {
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
  if (op === 'while') {
    const id = scratch[0]++
    const loopName = `$loop${id}`, breakName = `$break${id}`
    const loop = ['loop', loopName, ['br_if', breakName, ['i32.eqz', emitCondition(node[1], index, funcId, scratch)]]]
    appendStmt(loop, node[2], index, funcId, scratch)
    loop.push(['br', loopName])
    out.push(['block', breakName, loop])
    return
  }
  if (op === 'for') {
    const head = forHead(node[1])
    appendStmt(out, head[0], index, funcId, scratch)
    const id = scratch[0]++
    const loopName = `$loop${id}`, breakName = `$break${id}`
    const loop = ['loop', loopName, ['br_if', breakName, ['i32.eqz', emitCondition(head[1], index, funcId, scratch)]]]
    appendStmt(loop, node[2], index, funcId, scratch)
    appendStmt(loop, head[2], index, funcId, scratch)
    loop.push(['br', loopName])
    out.push(['block', breakName, loop])
    return
  }
  if (op === '()') { out.push(['drop', emitExpr(node, index, funcId, scratch)]); return }
  reject(node, 'statement')
}

const treeNodeCount = (node) => {
  if (!Array.isArray(node)) return 1
  let count = 1
  for (let i = 1; i < node.length; i++) count += treeNodeCount(node[i])
  return count
}

export function lowerFunction(index, funcId, metrics) {
  const scratch = [0]
  const fn = ['func', ['type', index[I_FN_TYPE_ID][funcId]]]
  const locals = index[I_FN_LOCAL_COUNT][funcId]
  if (locals) {
    const decl = ['local']
    for (let i = 0; i < locals; i++) decl.push('f64')
    fn.push(decl)
  }
  const body = index[I_FN_BODY][funcId]
  if (Array.isArray(body) && body[0] !== '{}' && body[0] !== ';' && body[0] !== 'return') {
    fn.push(emitExpr(body, index, funcId, scratch))
  } else {
    appendStmt(fn, body, index, funcId, scratch)
    fn.push(['unreachable'])
  }
  if (metrics) {
    metrics.functionCount = (metrics.functionCount || 0) + 1
    metrics.maxScratchSlots = Math.max(metrics.maxScratchSlots || 0, scratch.length)
    metrics.maxLoopLabels = Math.max(metrics.maxLoopLabels || 0, scratch[0])
    metrics.maxFunctionWatNodes = Math.max(metrics.maxFunctionWatNodes || 0, treeNodeCount(fn))
  }
  return fn
}

export function lowerProgram(index, metrics) {
  const module = ['module']
  const types = index[I_TYPE_PARAM_COUNT]
  for (let typeId = 0; typeId < types.length; typeId++) {
    const signature = ['func']
    for (let i = 0; i < types[typeId]; i++) signature.push(['param', 'f64'])
    signature.push(['result', 'f64'])
    module.push(['type', signature])
  }
  for (let funcId = 0; funcId < functionCount(index); funcId++) {
    if (index[I_FN_REACHABLE][funcId]) module.push(lowerFunction(index, funcId, metrics))
  }
  const exportFuncs = index[I_EXPORT_FUNC]
  const exportNames = index[I_EXPORT_NAME]
  for (let i = 0; i < exportFuncs.length; i++) {
    const wasmId = index[I_FN_WASM_ID][exportFuncs[i]]
    module.push(['export', `"${exportNames[i]}"`, ['func', wasmId]])
  }
  return module
}
