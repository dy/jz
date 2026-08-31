// Front-end contract for the compact staged prototype.
//
// Input is the parser's positional AST. Output is a list of positional function
// records. This stage validates the supported syntax boundary, extracts names,
// and records lexical declarations. It does not infer representations, resolve
// calls, decide reachability, or emit WAT.

import { constantNumber, constantTruth, isBooleanLiteral } from './constants.js'
import {
  LOGIC_NONE, OP_ADD, OP_NONE, OP_SUB,
  arithmeticKind, assignmentKind, comparisonKind, hasScalarWatOpcode, logicalKind,
} from './ops.js'

export const F_NAME = 0
export const F_PARAMS = 1
export const F_BODY = 2
export const F_EXPORT = 3
export const F_LOCALS = 4
export const F_MUTABLES = 5

export const err = (message) => { throw new SyntaxError(`compact prototype: ${message}`) }
export const opName = (node) => Array.isArray(node) ? String(node[0]) : typeof node
export const reject = (node, where) => err(`${where}: unsupported ${opName(node)}`)

export const list = (node) => {
  if (!node) return []
  if (Array.isArray(node) && node[0] === ';') return node.slice(1)
  return [node]
}

export const bodyList = (node) => {
  if (!Array.isArray(node)) reject(node, 'body')
  if (node[0] === '{}') return node.length === 2 && Array.isArray(node[1]) && node[1][0] === ';'
    ? node[1].slice(1) : node.slice(1)
  return list(node)
}

export const argsOf = (node) => {
  if (node == null) return []
  if (Array.isArray(node) && node[0] === ',') return node.slice(1)
  return [node]
}

export const forHead = (node) => {
  const head = bodyList(node)
  if (head.length !== 3) reject(node, 'for header')
  return head
}

const paramsOf = (node) => {
  if (node == null) return []
  if (typeof node === 'string') return [node]
  if (!Array.isArray(node)) reject(node, 'parameters')
  if (node[0] === '()') return paramsOf(node[1])
  if (node[0] !== ',') reject(node, 'parameters')
  const out = node.slice(1)
  for (let i = 0; i < out.length; i++) {
    if (typeof out[i] !== 'string') reject(out[i], 'parameter')
    if (out.indexOf(out[i]) !== i) err(`duplicate parameter '${out[i]}'`)
  }
  return out
}

const addLocal = (func, name, mutable) => {
  if (typeof name !== 'string') reject(name, 'local name')
  if (func[F_PARAMS].includes(name) || func[F_LOCALS].includes(name)) err(`duplicate local '${name}'`)
  func[F_LOCALS].push(name)
  func[F_MUTABLES].push(mutable)
}

const collectLocals = (node, func) => {
  if (!Array.isArray(node)) return
  const op = node[0]
  if (op === '=>' || op === 'function') reject(node, 'nested function')
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < node.length; i++) {
      const decl = node[i]
      if (!Array.isArray(decl) || decl[0] !== '=' || decl.length !== 3) reject(decl, 'declaration')
      addLocal(func, decl[1], op === 'let' ? 1 : 0)
      collectLocals(decl[2], func)
    }
    return
  }
  for (let i = 1; i < node.length; i++) collectLocals(node[i], func)
}

const declarationOf = (node, exported) => {
  if (!Array.isArray(node)) reject(node, 'top level')
  if (node[0] === 'export') return declarationOf(node[1], true)
  if (node[0] === 'let' || node[0] === 'const') {
    if (node.length !== 2) reject(node, 'top-level declaration')
    const decl = node[1]
    if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string' ||
        !Array.isArray(decl[2]) || decl[2][0] !== '=>') reject(node, 'top-level declaration')
    return [decl[1], paramsOf(decl[2][1]), decl[2][2], exported ? 1 : 0, [], []]
  }
  if (node[0] === 'function') {
    if (typeof node[1] !== 'string') reject(node, 'function declaration')
    if (exported) err(`exported function declaration '${node[1]}' is constructable; use an exported arrow function`)
    return [node[1], paramsOf(node[2]), node[3], 0, [], []]
  }
  reject(node, 'top level')
}

const NORMAL = 'n'
const RETURN = 'r'
const BREAK = 'b:'
const CONTINUE = 'c:'

const addCompletion = (out, value) => { if (!out.includes(value)) out.push(value) }
const mergeCompletions = (out, values) => { for (let i = 0; i < values.length; i++) addCompletion(out, values[i]); return out }

const sequenceCompletion = (nodes) => {
  let out = [NORMAL]
  for (let i = 0; i < nodes.length && out.includes(NORMAL); i++) {
    const next = []
    for (let j = 0; j < out.length; j++) if (out[j] !== NORMAL) addCompletion(next, out[j])
    out = mergeCompletions(next, statementCompletion(nodes[i]))
  }
  return out
}

const loopCompletion = (node, labels) => {
  const op = node[0]
  const condition = op === 'while' ? node[1] : op === 'for' ? forHead(node[1])[1] : node[2]
  const truth = condition == null ? 1 : constantTruth(condition)
  if (op !== 'do' && truth === 0) return [NORMAL]
  const body = op === 'while' ? node[2] : op === 'for' ? node[2] : node[1]
  const completions = statementCompletion(body)
  const out = []
  let exits = false, repeats = false
  for (let i = 0; i < completions.length; i++) {
    const value = completions[i]
    const label = value.slice(2)
    if (value === NORMAL || value === CONTINUE || value.startsWith(CONTINUE) && labels.includes(label)) repeats = true
    else if (value === BREAK || value.startsWith(BREAK) && labels.includes(label)) exits = true
    else addCompletion(out, value)
  }
  if (op !== 'do' && truth !== 1 || op === 'do' && repeats && truth !== 1 || exits) addCompletion(out, NORMAL)
  return out
}

function statementCompletion(node) {
  if (node == null) return [NORMAL]
  if (!Array.isArray(node)) return [NORMAL]
  const op = node[0]
  if (op === '{}' || op === ';') return sequenceCompletion(bodyList(node))
  if (op === 'return') return [RETURN]
  if (op === 'break') return [BREAK + (node[1] ?? '')]
  if (op === 'continue') return [CONTINUE + (node[1] ?? '')]
  if (op === 'if') {
    const truth = constantTruth(node[1])
    if (truth === 1) return statementCompletion(node[2])
    if (truth === 0) return node.length > 3 && node[3] != null ? statementCompletion(node[3]) : [NORMAL]
    const out = statementCompletion(node[2]).slice()
    return mergeCompletions(out, node.length > 3 && node[3] != null ? statementCompletion(node[3]) : [NORMAL])
  }
  if (op === 'while' || op === 'for' || op === 'do') return loopCompletion(node, [])
  if (op === ':') {
    const labels = []
    let target = node
    while (target[0] === ':') { labels.push(target[1]); target = target[2] }
    if (Array.isArray(target) && (target[0] === 'while' || target[0] === 'for' || target[0] === 'do'))
      return loopCompletion(target, labels)
    const values = statementCompletion(node[2]), out = []
    for (let i = 0; i < values.length; i++) addCompletion(out, values[i] === BREAK + node[1] ? NORMAL : values[i])
    return out
  }
  return [NORMAL]
}

const mayFallThrough = (node) => statementCompletion(node).includes(NORMAL)

const validateExportName = (name) => {
  for (let i = 0; i < name.length; i++) if (name.charCodeAt(i) > 127) err(`non-ASCII export name '${name}'`)
}

const validateCondition = (node) => {
  if (node == null) return
  if (Array.isArray(node)) {
    if (node[0] === '()' && node.length === 2) { validateCondition(node[1]); return }
    if (isBooleanLiteral(node)) return
    if (comparisonKind(node[0]) !== OP_NONE && node.length === 3) {
      validateExpr(node[1])
      validateExpr(node[2])
      return
    }
    if (node[0] === '!' && node.length === 2) { validateCondition(node[1]); return }
    if (logicalKind(node[0]) !== LOGIC_NONE && node.length === 3) {
      validateCondition(node[1])
      validateCondition(node[2])
      return
    }
  }
  validateExpr(node)
}

function validateExpr(node) {
  if (typeof node === 'string') return
  if (!Array.isArray(node)) reject(node, 'expression')
  if (node[0] == null && node.length === 2 && typeof node[1] === 'number') return
  const op = node[0]
  if (op === '()' && node.length === 2) { validateExpr(node[1]); return }
  if (op === '()' && typeof node[1] === 'string') {
    const args = argsOf(node[2])
    for (let i = 0; i < args.length; i++) validateExpr(args[i])
    return
  }
  if (op === '?' && node.length === 4) {
    validateCondition(node[1])
    validateExpr(node[2])
    validateExpr(node[3])
    return
  }
  if ((op === '++' || op === '--') && (node.length === 2 || node.length === 3)) {
    if (typeof node[1] !== 'string') reject(node[1], 'update target')
    return
  }
  if (op === ',' && node.length > 2) {
    for (let i = 1; i < node.length; i++) validateExpr(node[i])
    return
  }
  if (logicalKind(op) !== LOGIC_NONE && node.length === 3) {
    validateExpr(node[1])
    validateExpr(node[2])
    return
  }
  const arithmetic = arithmeticKind(op)
  if (arithmetic !== OP_NONE && (node.length === 2 || node.length === 3)) {
    if (node.length === 2 && arithmetic !== OP_ADD && arithmetic !== OP_SUB) reject(node, 'expression')
    validateExpr(node[1])
    if (node.length === 3) validateExpr(node[2])
    if (!hasScalarWatOpcode(arithmetic) && constantNumber(node) === undefined) reject(node, 'expression')
    return
  }
  if (comparisonKind(op) !== OP_NONE) err(`comparison '${op}' is supported only as a condition`)
  reject(node, 'expression')
}

const validateStmt = (node) => {
  if (node == null) return
  if (!Array.isArray(node)) reject(node, 'statement')
  const op = node[0]
  if (op === '{}' || op === ';') {
    const stmts = bodyList(node)
    for (let i = 0; i < stmts.length; i++) validateStmt(stmts[i])
    return
  }
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < node.length; i++) validateExpr(node[i][2])
    return
  }
  if (op === '=' || assignmentKind(op) !== OP_NONE) {
    if (typeof node[1] !== 'string') reject(node[1], 'assignment target')
    validateExpr(node[2])
    return
  }
  if (op === '++' || op === '--') {
    if (typeof node[1] !== 'string') reject(node[1], 'update target')
    return
  }
  if (op === 'return') { validateExpr(node[1]); return }
  if (op === 'if') {
    validateCondition(node[1])
    validateStmt(node[2])
    if (node.length > 3 && node[3] != null) validateStmt(node[3])
    return
  }
  if (op === 'while') {
    validateCondition(node[1])
    validateStmt(node[2])
    return
  }
  if (op === 'do') {
    validateStmt(node[1])
    validateCondition(node[2])
    return
  }
  if (op === 'for') {
    const head = forHead(node[1])
    validateStmt(head[0])
    validateCondition(head[1])
    validateStmt(node[2])
    validateStmt(head[2])
    return
  }
  if (op === ':') {
    if (typeof node[1] !== 'string' || node.length !== 3) reject(node, 'label')
    validateStmt(node[2])
    return
  }
  if (op === 'break' || op === 'continue') {
    if (node.length > 2 || node.length === 2 && typeof node[1] !== 'string') reject(node, op)
    return
  }
  if (op === '()' || op === ',' || logicalKind(op) !== LOGIC_NONE) { validateExpr(node); return }
  reject(node, 'statement')
}

const validateBody = (body) => {
  if (Array.isArray(body) && (body[0] === '{}' || body[0] === ';' || body[0] === 'return')) validateStmt(body)
  else validateExpr(body)
}

export function prepareCompactAst(ast) {
  const top = list(ast)
  const funcs = []
  for (let i = 0; i < top.length; i++) {
    const func = declarationOf(top[i], false)
    for (let j = 0; j < funcs.length; j++) if (funcs[j][F_NAME] === func[F_NAME]) err(`duplicate function '${func[F_NAME]}'`)
    collectLocals(func[F_BODY], func)
    validateBody(func[F_BODY])
    const body = func[F_BODY]
    if (Array.isArray(body) && (body[0] === '{}' || body[0] === ';' || body[0] === 'return') && mayFallThrough(body))
      err(`function '${func[F_NAME]}' does not return a number on every supported path`)
    if (func[F_EXPORT]) validateExportName(func[F_NAME])
    funcs.push(func)
  }
  return funcs
}
