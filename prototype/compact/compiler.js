import { parse } from '../../src/parse.js'

// Compact prototype records are positional arrays. The source AST stays the
// semantic representation; this backend adds no object-shaped HIR.
const F_NAME = 0
const F_PARAMS = 1
const F_BODY = 2
const F_EXPORT = 3
const F_LOCALS = 4
const F_MUTABLES = 5

const assignmentOpcode = (op) => op === '+=' ? 0xa0 : op === '-=' ? 0xa1 : op === '*=' ? 0xa2 : op === '/=' ? 0xa3 : -1

const err = (message) => { throw new SyntaxError(`compact prototype: ${message}`) }
const opName = (node) => Array.isArray(node) ? String(node[0]) : typeof node
const reject = (node, where) => err(`${where}: unsupported ${opName(node)}`)

const list = (node) => {
  if (!node) return []
  if (Array.isArray(node) && node[0] === ';') return node.slice(1)
  return [node]
}

const bodyList = (node) => {
  if (!Array.isArray(node)) reject(node, 'body')
  if (node[0] === '{}') return node.length === 2 && Array.isArray(node[1]) && node[1][0] === ';'
    ? node[1].slice(1) : node.slice(1)
  return list(node)
}

const paramsOf = (node) => {
  if (node == null) return []
  if (typeof node === 'string') return [node]
  if (!Array.isArray(node)) reject(node, 'parameters')
  if (node[0] === '()') return paramsOf(node[1])
  if (node[0] !== ',') reject(node, 'parameters')
  const out = node.slice(1)
  for (let i = 0; i < out.length; i++) if (typeof out[i] !== 'string') reject(out[i], 'parameter')
  return out
}

const addLocal = (func, name, mutable) => {
  if (typeof name !== 'string') reject(name, 'local name')
  if (func[F_PARAMS].includes(name) || func[F_LOCALS].includes(name)) err(`duplicate local '${name}'`)
  func[F_LOCALS].push(name)
  func[F_MUTABLES].push(mutable)
}

function collectLocals(node, func) {
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
    if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string' || !Array.isArray(decl[2]) || decl[2][0] !== '=>')
      reject(node, 'top-level declaration')
    return [decl[1], paramsOf(decl[2][1]), decl[2][2], exported ? 1 : 0, [], []]
  }
  if (node[0] === 'function') {
    if (typeof node[1] !== 'string') reject(node, 'function declaration')
    if (exported) err(`exported function declaration '${node[1]}' is constructable; use an exported arrow function`)
    return [node[1], paramsOf(node[2]), node[3], 0, [], []]
  }
  reject(node, 'top level')
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

const alwaysReturns = (node) => {
  if (!Array.isArray(node)) return false
  if (node[0] === 'return') return true
  if (node[0] === 'if') return node.length > 3 && alwaysReturns(node[2]) && alwaysReturns(node[3])
  if (node[0] === '{}' || node[0] === ';') {
    const stmts = bodyList(node)
    return !!stmts.length && alwaysReturns(stmts[stmts.length - 1])
  }
  return false
}

const functionIndex = (funcs, name) => {
  for (let i = 0; i < funcs.length; i++) if (funcs[i][F_NAME] === name) return i
  return -1
}

const localIndex = (func, name) => {
  const p = func[F_PARAMS].indexOf(name)
  if (p >= 0) return p
  const l = func[F_LOCALS].indexOf(name)
  return l < 0 ? -1 : func[F_PARAMS].length + l
}

const callTarget = (funcs, func, name) => {
  if (localIndex(func, name) >= 0) err(`dynamic call through local '${name}' is unsupported`)
  const target = functionIndex(funcs, name)
  if (target < 0) err(`unknown direct function '${name}'`)
  return target
}

const forHead = (node) => {
  const head = bodyList(node)
  if (head.length !== 3) reject(node, 'for header')
  return head
}

function checkExpr(node, declared, assigned, func, funcs) {
  if (typeof node === 'string') {
    const idx = localIndex(func, node)
    if (idx < 0) err(`'${node}' is not a numeric local`)
    if (!declared[idx] || !assigned[idx]) err(`'${node}' may be read before its declaration`)
    return
  }
  if (!Array.isArray(node)) reject(node, 'expression')
  if (node[0] == null && node.length === 2 && typeof node[1] === 'number') return
  const op = node[0]
  if (op === '()' && node.length === 2) { checkExpr(node[1], declared, assigned, func, funcs); return }
  if (op === '()' && typeof node[1] === 'string') {
    const target = callTarget(funcs, func, node[1])
    const args = argsOf(node[2])
    if (args.length !== funcs[target][F_PARAMS].length) err(`call to '${node[1]}' has ${args.length} arguments, expected ${funcs[target][F_PARAMS].length}`)
    for (let i = 0; i < args.length; i++) checkExpr(args[i], declared, assigned, func, funcs)
    return
  }
  if (op === '?' && node.length === 4) {
    checkExpr(node[1], declared, assigned, func, funcs)
    checkExpr(node[2], declared, assigned, func, funcs)
    checkExpr(node[3], declared, assigned, func, funcs)
    return
  }
  if ((op === '+' || op === '-' || op === '*' || op === '/' || op === '==' || op === '===' ||
      op === '!=' || op === '!==' || op === '<' || op === '>' || op === '<=' || op === '>=') &&
      (node.length === 2 || node.length === 3)) {
    checkExpr(node[1], declared, assigned, func, funcs)
    if (node.length === 3) checkExpr(node[2], declared, assigned, func, funcs)
    return
  }
  if (op === '!' && node.length === 2) { checkExpr(node[1], declared, assigned, func, funcs); return }
  reject(node, 'expression')
}

const checkAssignTarget = (name, declared, assigned, func, read) => {
  const idx = localIndex(func, name)
  if (idx < 0 || !declared[idx]) err(`assignment to undeclared local '${name}'`)
  const local = idx - func[F_PARAMS].length
  if (local >= 0 && !func[F_MUTABLES][local]) err(`assignment to const local '${name}' is unsupported`)
  if (read && !assigned[idx]) err(`'${name}' may be updated before initialization`)
  return idx
}

function checkStmt(node, declared, assigned, func, funcs) {
  if (node == null) return
  if (!Array.isArray(node)) reject(node, 'statement')
  const op = node[0]
  if (op === '{}' || op === ';') {
    const scoped = op === '{}'
    const savedDeclared = scoped ? declared.slice() : null
    const savedAssigned = scoped ? assigned.slice() : null
    const stmts = bodyList(node)
    for (let i = 0; i < stmts.length; i++) checkStmt(stmts[i], declared, assigned, func, funcs)
    if (scoped) for (let i = 0; i < declared.length; i++) {
      declared[i] = savedDeclared[i]
      assigned[i] = savedAssigned[i]
    }
    return
  }
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < node.length; i++) {
      const name = node[i][1]
      const idx = localIndex(func, name)
      if (idx < 0 || declared[idx]) err(`duplicate declaration '${name}'`)
      declared[idx] = true
      checkExpr(node[i][2], declared, assigned, func, funcs)
      assigned[idx] = true
    }
    return
  }
  if (op === '=') {
    const idx = checkAssignTarget(node[1], declared, assigned, func, false)
    checkExpr(node[2], declared, assigned, func, funcs)
    assigned[idx] = true
    return
  }
  if (assignmentOpcode(op) >= 0) {
    checkAssignTarget(node[1], declared, assigned, func, true)
    checkExpr(node[2], declared, assigned, func, funcs)
    return
  }
  if (op === '++' || op === '--') { checkAssignTarget(node[1], declared, assigned, func, true); return }
  if (op === 'return') { checkExpr(node[1], declared, assigned, func, funcs); return }
  if (op === 'if') {
    checkExpr(node[1], declared, assigned, func, funcs)
    const d = declared.slice(), a = assigned.slice()
    checkStmt(node[2], d, a, func, funcs)
    if (node.length > 3 && node[3] != null) checkStmt(node[3], declared.slice(), assigned.slice(), func, funcs)
    return
  }
  if (op === 'while') {
    checkExpr(node[1], declared, assigned, func, funcs)
    checkStmt(node[2], declared.slice(), assigned.slice(), func, funcs)
    return
  }
  if (op === 'for') {
    const head = forHead(node[1])
    const d = declared.slice(), a = assigned.slice()
    checkStmt(head[0], d, a, func, funcs)
    checkExpr(head[1], d, a, func, funcs)
    checkStmt(node[2], d, a, func, funcs)
    checkStmt(head[2], d, a, func, funcs)
    return
  }
  if (op === '()') { checkExpr(node, declared, assigned, func, funcs); return }
  reject(node, 'statement')
}

const checkFunctionFlow = (func, funcs) => {
  const count = func[F_PARAMS].length + func[F_LOCALS].length
  const declared = new Array(count).fill(false)
  const assigned = new Array(count).fill(false)
  for (let i = 0; i < func[F_PARAMS].length; i++) declared[i] = assigned[i] = true
  const body = func[F_BODY]
  if (Array.isArray(body) && body[0] === '{}') {
    const stmts = bodyList(body)
    for (let i = 0; i < stmts.length; i++) checkStmt(stmts[i], declared, assigned, func, funcs)
  } else if (Array.isArray(body) && (body[0] === ';' || body[0] === 'return')) checkStmt(body, declared, assigned, func, funcs)
  else checkExpr(body, declared, assigned, func, funcs)
}

const uleb = (out, value) => {
  value >>>= 0
  do {
    let byte = value & 127
    value >>>= 7
    if (value) byte |= 128
    out.push(byte)
  } while (value)
}

const f64 = (out, value) => {
  if (typeof value !== 'number') err('only number literals are supported')
  const buf = new ArrayBuffer(8)
  new DataView(buf).setFloat64(0, value, true)
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < 8; i++) out.push(bytes[i])
}

const ascii = (out, value) => {
  uleb(out, value.length)
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c > 127) err(`non-ASCII export name '${value}'`)
    out.push(c)
  }
}

const section = (module, id, payload) => {
  if (!payload.length) return
  module.push(id)
  uleb(module, payload.length)
  for (let i = 0; i < payload.length; i++) module.push(payload[i])
}

const argsOf = (node) => {
  if (node == null) return []
  if (Array.isArray(node) && node[0] === ',') return node.slice(1)
  return [node]
}

function emitCondition(node, out, func, funcs) {
  if (Array.isArray(node)) {
    const cmp = node[0]
    if (cmp === '()' && node.length === 2) { emitCondition(node[1], out, func, funcs); return }
    const opcode = cmp === '==' || cmp === '===' ? 0x61
      : cmp === '!=' || cmp === '!==' ? 0x62
      : cmp === '<' ? 0x63 : cmp === '>' ? 0x64
      : cmp === '<=' ? 0x65 : cmp === '>=' ? 0x66 : -1
    if (opcode >= 0) {
      emitExpr(node[1], out, func, funcs)
      emitExpr(node[2], out, func, funcs)
      out.push(opcode)
      return
    }
    if (cmp === '!' && node.length === 2) {
      emitCondition(node[1], out, func, funcs)
      out.push(0x45)
      return
    }
  }
  emitExpr(node, out, func, funcs)
  out.push(0x99, 0x44); f64(out, 0)
  out.push(0x64) // abs(x) > 0: NaN and +/-0 are false
}

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

function emitExpr(node, out, func, funcs) {
  if (typeof node === 'string') {
    const idx = localIndex(func, node)
    if (idx < 0) err(`'${node}' is not a numeric local`)
    out.push(0x20); uleb(out, idx)
    return
  }
  if (!Array.isArray(node)) reject(node, 'expression')
  const folded = constantNumber(node)
  if (folded !== undefined) { out.push(0x44); f64(out, folded); return }
  const op = node[0]
  if (op === '()' && node.length === 2) { emitExpr(node[1], out, func, funcs); return }
  if (op === '+' && node.length === 2) { emitExpr(node[1], out, func, funcs); return }
  if (op === '-' && node.length === 2) { emitExpr(node[1], out, func, funcs); out.push(0x9a); return }
  const bin = op === '+' ? 0xa0 : op === '-' ? 0xa1 : op === '*' ? 0xa2 : op === '/' ? 0xa3 : -1
  if (bin >= 0 && node.length === 3) {
    emitExpr(node[1], out, func, funcs)
    emitExpr(node[2], out, func, funcs)
    out.push(bin)
    return
  }
  if (op === '?') {
    emitCondition(node[1], out, func, funcs)
    out.push(0x04, 0x7c) // if (result f64)
    emitExpr(node[2], out, func, funcs)
    out.push(0x05)
    emitExpr(node[3], out, func, funcs)
    out.push(0x0b)
    return
  }
  if (op === '()' && typeof node[1] === 'string') {
    const target = callTarget(funcs, func, node[1])
    const args = argsOf(node[2])
    if (args.length !== funcs[target][F_PARAMS].length) err(`call to '${node[1]}' has ${args.length} arguments, expected ${funcs[target][F_PARAMS].length}`)
    for (let i = 0; i < args.length; i++) emitExpr(args[i], out, func, funcs)
    out.push(0x10); uleb(out, target)
    return
  }
  if (op === '==' || op === '===' || op === '!=' || op === '!==' || op === '<' || op === '>' || op === '<=' || op === '>=')
    err(`comparison '${op}' is supported only as a condition`)
  reject(node, 'expression')
}

const emitSet = (name, value, out, func, funcs) => {
  const idx = localIndex(func, name)
  if (idx < 0) err(`assignment to unknown local '${name}'`)
  emitExpr(value, out, func, funcs)
  out.push(0x21); uleb(out, idx)
}

function emitStmt(node, out, func, funcs) {
  if (node == null) return
  if (!Array.isArray(node)) reject(node, 'statement')
  const op = node[0]
  if (op === '{}' || op === ';') {
    const stmts = bodyList(node)
    for (let i = 0; i < stmts.length; i++) emitStmt(stmts[i], out, func, funcs)
    return
  }
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < node.length; i++) emitSet(node[i][1], node[i][2], out, func, funcs)
    return
  }
  if (op === '=') { emitSet(node[1], node[2], out, func, funcs); return }
  const assignment = assignmentOpcode(op)
  if (assignment >= 0) {
    const idx = localIndex(func, node[1])
    if (idx < 0) err(`assignment to unknown local '${node[1]}'`)
    out.push(0x20); uleb(out, idx)
    emitExpr(node[2], out, func, funcs)
    out.push(assignment)
    out.push(0x21); uleb(out, idx)
    return
  }
  if (op === '++' || op === '--') {
    const idx = localIndex(func, node[1])
    if (idx < 0) err(`update of unknown local '${node[1]}'`)
    out.push(0x20); uleb(out, idx)
    out.push(0x44); f64(out, 1)
    out.push(op === '++' ? 0xa0 : 0xa1)
    out.push(0x21); uleb(out, idx)
    return
  }
  if (op === 'return') {
    emitExpr(node[1], out, func, funcs)
    out.push(0x0f)
    return
  }
  if (op === 'if') {
    emitCondition(node[1], out, func, funcs)
    out.push(0x04, 0x40)
    emitStmt(node[2], out, func, funcs)
    if (node.length > 3 && node[3] != null) { out.push(0x05); emitStmt(node[3], out, func, funcs) }
    out.push(0x0b)
    return
  }
  if (op === 'while') {
    out.push(0x02, 0x40, 0x03, 0x40)
    emitCondition(node[1], out, func, funcs)
    out.push(0x45, 0x0d); uleb(out, 1)
    emitStmt(node[2], out, func, funcs)
    out.push(0x0c); uleb(out, 0)
    out.push(0x0b, 0x0b)
    return
  }
  if (op === 'for') {
    const head = forHead(node[1])
    emitStmt(head[0], out, func, funcs)
    out.push(0x02, 0x40, 0x03, 0x40)
    emitCondition(head[1], out, func, funcs)
    out.push(0x45, 0x0d); uleb(out, 1)
    emitStmt(node[2], out, func, funcs)
    emitStmt(head[2], out, func, funcs)
    out.push(0x0c); uleb(out, 0)
    out.push(0x0b, 0x0b)
    return
  }
  if (op === '()') { emitExpr(node, out, func, funcs); out.push(0x1a); return }
  reject(node, 'statement')
}

const emitBody = (func, funcs) => {
  const out = []
  if (func[F_LOCALS].length) {
    uleb(out, 1)
    uleb(out, func[F_LOCALS].length)
    out.push(0x7c)
  } else uleb(out, 0)
  const body = func[F_BODY]
  if (Array.isArray(body) && body[0] !== '{}' && body[0] !== ';' && body[0] !== 'return') emitExpr(body, out, func, funcs)
  else { emitStmt(body, out, func, funcs); out.push(0x00) }
  out.push(0x0b)
  return out
}

export function compileCompactAst(ast) {
  const top = list(ast)
  const funcs = []
  for (let i = 0; i < top.length; i++) {
    const func = declarationOf(top[i], false)
    if (functionIndex(funcs, func[F_NAME]) >= 0) err(`duplicate function '${func[F_NAME]}'`)
    funcs.push(func)
  }
  if (!funcs.length) err('module has no functions')
  let exports = 0
  for (let i = 0; i < funcs.length; i++) {
    const func = funcs[i]
    collectLocals(func[F_BODY], func)
    if (!normalizedExportParams(func)) err(`export '${func[F_NAME]}' must normalize each parameter with a leading 'p = +p'`)
    const body = func[F_BODY]
    if (Array.isArray(body) && (body[0] === '{}' || body[0] === ';' || body[0] === 'return') && !alwaysReturns(body))
      err(`function '${func[F_NAME]}' does not return a number on every supported path`)
    exports += func[F_EXPORT]
  }
  for (let i = 0; i < funcs.length; i++) checkFunctionFlow(funcs[i], funcs)
  if (!exports) err('module has no exported function')

  const types = []
  const funcTypes = []
  for (let i = 0; i < funcs.length; i++) {
    const count = funcs[i][F_PARAMS].length
    let type = types.indexOf(count)
    if (type < 0) { type = types.length; types.push(count) }
    funcTypes.push(type)
  }

  const module = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
  const typeSec = []
  uleb(typeSec, types.length)
  for (let i = 0; i < types.length; i++) {
    typeSec.push(0x60)
    uleb(typeSec, types[i])
    for (let j = 0; j < types[i]; j++) typeSec.push(0x7c)
    typeSec.push(1, 0x7c)
  }
  section(module, 1, typeSec)

  const funcSec = []
  uleb(funcSec, funcs.length)
  for (let i = 0; i < funcs.length; i++) uleb(funcSec, funcTypes[i])
  section(module, 3, funcSec)

  const exportSec = []
  uleb(exportSec, exports)
  for (let i = 0; i < funcs.length; i++) if (funcs[i][F_EXPORT]) {
    ascii(exportSec, funcs[i][F_NAME])
    exportSec.push(0)
    uleb(exportSec, i)
  }
  section(module, 7, exportSec)

  const codeSec = []
  uleb(codeSec, funcs.length)
  for (let i = 0; i < funcs.length; i++) {
    const body = emitBody(funcs[i], funcs)
    uleb(codeSec, body.length)
    for (let j = 0; j < body.length; j++) codeSec.push(body[j])
  }
  section(module, 10, codeSec)
  return new Uint8Array(module)
}

export default function compileCompact(source) {
  return compileCompactAst(parse(source))
}
