// Per-function AST to scalar WAT lowering for the compact staged prototype.
// The ProgramIndex is read-only here. Each function body is materialized once,
// appended to the module, and then all function-local traversal state dies.

import { constantNumber, constantTruth } from './constants.js'
import { argsOf, bodyList, err, forHead, reject } from './prepare.js'
import {
  CMP_EQ, CMP_GE, CMP_GT, CMP_LE, CMP_LT, CMP_NE,
  LOGIC_AND, LOGIC_NONE, OP_ADD, OP_DIV, OP_MUL, OP_NONE, OP_SUB,
  arithmeticKind, assignmentKind, comparisonKind, logicalKind,
} from './ops.js'
import {
  I_EXPORT_FUNC, I_EXPORT_NAME, I_FN_BODY, I_FN_LOCAL_COUNT, I_FN_PARAM_COUNT,
  I_FN_REACHABLE, I_FN_TYPE_ID, I_FN_WASM_ID, I_TYPE_PARAM_COUNT,
  callTargetId, functionCount, localIndex,
} from './program-index.js'

const C_SOURCE_LABEL = 0
const C_BREAK_LABEL = 1
const C_CONTINUE_LABEL = 2
const C_IS_LOOP = 3

const arithmeticWat = (kind) => kind === OP_ADD ? 'f64.add' : kind === OP_SUB ? 'f64.sub'
  : kind === OP_MUL ? 'f64.mul' : kind === OP_DIV ? 'f64.div' : null

const comparisonWat = (kind) => kind === CMP_EQ ? 'f64.eq' : kind === CMP_NE ? 'f64.ne'
  : kind === CMP_LT ? 'f64.lt' : kind === CMP_GT ? 'f64.gt'
  : kind === CMP_LE ? 'f64.le' : kind === CMP_GE ? 'f64.ge' : null

const truthyWat = (value) => ['f64.gt', ['f64.abs', value], ['f64.const', 0]]
const watLocal = (id) => `$v${id}`

const acquireTemp = (scratch) => {
  if (scratch.freeTemps.length) return scratch.freeTemps.pop()
  const local = scratch.tempBase + scratch.tempCount++
  if (scratch.tempCount > scratch.maxTemporaryLocals) scratch.maxTemporaryLocals = scratch.tempCount
  return local
}

const releaseTemp = (scratch, local) => { scratch.freeTemps.push(local) }

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
    if (cmp) return [cmp, emitExpr(node[1], index, funcId, scratch), emitExpr(node[2], index, funcId, scratch)]
    if (node[0] === '!' && node.length === 2) return ['i32.eqz', emitCondition(node[1], index, funcId, scratch)]
    if (logicalKind(node[0]) !== LOGIC_NONE && node.length === 3) return logicalKind(node[0]) === LOGIC_AND
      ? ['if', ['result', 'i32'], emitCondition(node[1], index, funcId, scratch),
        ['then', emitCondition(node[2], index, funcId, scratch)], ['else', ['i32.const', 0]]]
      : ['if', ['result', 'i32'], emitCondition(node[1], index, funcId, scratch),
        ['then', ['i32.const', 1]], ['else', emitCondition(node[2], index, funcId, scratch)]]
  }
  return truthyWat(emitExpr(node, index, funcId, scratch))
}

const emitUpdateExpr = (node, index, funcId, scratch) => {
  const local = localIndex(index, funcId, node[1])
  if (local < 0) err(`update of unknown local '${node[1]}'`)
  const opcode = node[0] === '++' ? 'f64.add' : 'f64.sub'
  const updated = [opcode, ['local.get', watLocal(local)], ['f64.const', 1]]
  if (node.length === 2) return ['local.tee', watLocal(local), updated]
  const old = acquireTemp(scratch)
  const block = ['block', ['result', 'f64'],
    ['local.set', watLocal(old), ['local.get', watLocal(local)]],
    ['local.set', watLocal(local), updated],
    ['local.get', watLocal(old)]]
  releaseTemp(scratch, old)
  return block
}

const emitLogical = (node, index, funcId, scratch) => {
  const temp = acquireTemp(scratch)
  const left = emitExpr(node[1], index, funcId, scratch)
  const right = emitExpr(node[2], index, funcId, scratch)
  const condition = truthyWat(['local.get', watLocal(temp)])
  const branch = logicalKind(node[0]) === LOGIC_AND
    ? ['if', ['result', 'f64'], condition,
      ['then', right], ['else', ['local.get', watLocal(temp)]]]
    : ['if', ['result', 'f64'], condition,
      ['then', ['local.get', watLocal(temp)]], ['else', right]]
  releaseTemp(scratch, temp)
  return ['block', ['result', 'f64'], ['local.set', watLocal(temp), left], branch]
}

function emitExpr(node, index, funcId, scratch) {
  if (typeof node === 'string') {
    const local = localIndex(index, funcId, node)
    if (local < 0) err(`'${node}' is not a numeric local`)
    return ['local.get', watLocal(local)]
  }
  if (!Array.isArray(node)) reject(node, 'expression')
  const folded = constantNumber(node)
  if (folded !== undefined) return ['f64.const', folded]
  const op = node[0]
  if (op === '()' && node.length === 2) return emitExpr(node[1], index, funcId, scratch)
  if (op === '+' && node.length === 2) return emitExpr(node[1], index, funcId, scratch)
  if (op === '-' && node.length === 2) return ['f64.neg', emitExpr(node[1], index, funcId, scratch)]
  if (op === '++' || op === '--') return emitUpdateExpr(node, index, funcId, scratch)
  if (op === ',' && node.length > 2) {
    const block = ['block', ['result', 'f64']]
    for (let i = 1; i < node.length - 1; i++) block.push(['drop', emitExpr(node[i], index, funcId, scratch)])
    block.push(emitExpr(node[node.length - 1], index, funcId, scratch))
    return block
  }
  if (logicalKind(op) !== LOGIC_NONE && node.length === 3) return emitLogical(node, index, funcId, scratch)
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
  return ['local.set', watLocal(local), emitExpr(value, index, funcId, scratch)]
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
    out.push(['local.set', watLocal(local), [assignment, ['local.get', watLocal(local)], emitExpr(node[2], index, funcId, scratch)]])
    return
  }
  if (op === '++' || op === '--') {
    const local = localIndex(index, funcId, node[1])
    if (local < 0) err(`update of unknown local '${node[1]}'`)
    out.push(['local.set', watLocal(local), [op === '++' ? 'f64.add' : 'f64.sub', ['local.get', watLocal(local)], ['f64.const', 1]]])
    return
  }
  if (op === 'return') { out.push(['return', emitExpr(node[1], index, funcId, scratch)]); return }
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
  if (op === '()' || op === ',' || logicalKind(op) !== LOGIC_NONE) {
    out.push(['drop', emitExpr(node, index, funcId, scratch)])
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

export function lowerFunction(index, funcId, metrics) {
  const sourceLocals = index[I_FN_LOCAL_COUNT][funcId]
  const scratch = {
    labelUid: 0,
    controls: [],
    tempBase: index[I_FN_PARAM_COUNT][funcId] + sourceLocals,
    tempCount: 0,
    freeTemps: [],
    maxTemporaryLocals: 0,
    maxControlDepth: 0,
  }
  const instructions = []
  const body = index[I_FN_BODY][funcId]
  if (Array.isArray(body) && body[0] !== '{}' && body[0] !== ';' && body[0] !== 'return') {
    instructions.push(emitExpr(body, index, funcId, scratch))
  } else {
    appendStmt(instructions, body, index, funcId, scratch)
    instructions.push(['unreachable'])
  }

  const fn = ['func', ['type', index[I_FN_TYPE_ID][funcId]]]
  const params = index[I_FN_PARAM_COUNT][funcId]
  for (let i = 0; i < params; i++) fn.push(['param', watLocal(i), 'f64'])
  fn.push(['result', 'f64'])
  const locals = sourceLocals + scratch.tempCount
  for (let i = 0; i < locals; i++) fn.push(['local', watLocal(params + i), 'f64'])
  for (let i = 0; i < instructions.length; i++) fn.push(instructions[i])

  if (metrics) {
    metrics.functionCount = (metrics.functionCount || 0) + 1
    const slots = 1 + scratch.maxTemporaryLocals + scratch.maxControlDepth * 4
    metrics.maxScratchSlots = Math.max(metrics.maxScratchSlots || 0, slots)
    metrics.maxLoopLabels = Math.max(metrics.maxLoopLabels || 0, scratch.labelUid)
    metrics.maxControlDepth = Math.max(metrics.maxControlDepth || 0, scratch.maxControlDepth)
    metrics.maxTemporaryLocals = Math.max(metrics.maxTemporaryLocals || 0, scratch.maxTemporaryLocals)
    metrics.maxFunctionWatNodes = Math.max(metrics.maxFunctionWatNodes || 0, treeNodeCount(fn))
  }
  return fn
}

export function lowerProgram(index, metrics) {
  const module = ['module']
  const types = index[I_TYPE_PARAM_COUNT]
  for (let typeId = 0; typeId < types.length; typeId++) {
    const signature = ['func']
    for (let i = 0; i < types[typeId]; i++) signature.push(['param', watLocal(i), 'f64'])
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
