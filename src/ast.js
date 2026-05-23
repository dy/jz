/**
 * Shared Jessie/subscript AST shape helpers and walks.
 *
 * Cycle-free: no ctx/analyze/ir imports. Shared with abi/* and ir.js.
 *
 * @module ast
 */

/** Template placeholder in prepared AST (prepare.js). */
export const T = '\uE000'

// === Numeric range (shared by analyze + ir) ===

export const I32_MIN = -2147483648
export const I32_MAX = 2147483647
export const isI32 = (v) => Number.isInteger(v) && v >= I32_MIN && v <= I32_MAX && !Object.is(v, -0)

// === Statement / block-body classification ===

/** Statement operators — distinguish block bodies from object literals. */
export const STMT_OPS = new Set([';', 'let', 'const', 'return', 'if', 'for', 'for-in', 'while', 'break', 'continue', 'switch',
  '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '>>=', '<<=', '>>>=', '||=', '&&=', '??=',
  'throw', 'try', 'catch', 'finally', '++', '--', '()'])

/** jzify superset: pre-lowered JS shapes before prepare strips them. */
export const JZ_BLOCK_OPS = new Set([...STMT_OPS, 'var', 'for-of', 'do', 'function', 'class', 'import', 'export', 'label', 'case', 'default'])

/** Valid labeled-statement bodies in jzify. */
export const LABEL_BODY_OPS = new Set([';', 'if', 'for', 'for-in', 'for-of', 'while', 'do', 'switch', 'try', 'throw'])

/** Distinguish a function block body `{ … }` from an expression object literal `({a:1})`. */
export const isBlockBody = (body) =>
  Array.isArray(body) && body[0] === '{}' && (body.length === 1 || STMT_OPS.has(body[1]?.[0]))

// === AST node classifiers ===

export const isLiteralStr = idx => Array.isArray(idx) && idx[0] === 'str' && typeof idx[1] === 'string'
export const isFuncRef = (node, funcNames) => typeof node === 'string' && funcNames.has(node)

// === Assignment / reassignment ===

/** Assignment operators — shared across analyze, plan, emit, abi. */
export const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '>>=', '<<=', '>>>=', '||=', '&&=', '??='])

/** Detect whether `name` is written to (=, +=, ++, --, etc.) anywhere within `body`. */
export function isReassigned(body, name) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (ASSIGN_OPS.has(op) && body[1] === name) return true
  if ((op === '++' || op === '--') && body[1] === name) return true
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < body.length; i++) {
      const d = body[i]
      if (Array.isArray(d) && d[0] === '=' && d[2] != null && isReassigned(d[2], name)) return true
    }
    return false
  }
  for (let i = 1; i < body.length; i++) if (isReassigned(body[i], name)) return true
  return false
}

/** Normalize a call's raw arg slot: null → [], comma-group → elems, else singleton. */
export function commaList(raw) {
  if (raw == null) return []
  return Array.isArray(raw) && raw[0] === ',' ? raw.slice(1) : [raw]
}

/** Args of a `['()', callee, raw]` node, or null when `node` is not a call. */
export function callArgs(node) {
  if (!Array.isArray(node) || node[0] !== '()') return null
  return commaList(node[2])
}

/** Write normalized args back onto a call node. */
export function setCallArgs(node, args) {
  node[2] = args.length === 0 ? null : args.length === 1 ? args[0] : [',', ...args]
}

/** Unwrap handler/rest `args` when the sole element is a comma-group. */
export function spreadArgs(args) {
  if (args.length === 1 && Array.isArray(args[0]) && args[0][0] === ',') return args[0].slice(1)
  return args
}

export const isSeq = node => Array.isArray(node) && node[0] === ';'

/** Statement list inside a block `{…}`; null when `body` is not a block. */
export function blockStmts(body) {
  if (!Array.isArray(body) || body[0] !== '{}') return null
  const inner = body[1]
  if (!Array.isArray(inner)) return inner == null ? [] : [inner]
  return inner[0] === ';' ? inner.slice(1) : [inner]
}

/** Flatten a block/seq/single-stmt body into a statement array. */
export function stmtList(body) {
  if (!Array.isArray(body)) return body == null ? [] : [body]
  if (body[0] === '{}') return stmtList(body[1])
  if (body[0] === ';') return body.slice(1)
  return [body]
}

/** Handler/rest args with comma unwrap and null drop (jzify/prepare). */
export function handlerArgs(args) {
  return spreadArgs(args).filter(a => a != null)
}

/** Early-exit walk; skips into `=>` bodies by default. */
export function some(node, pred, { skipArrow = true } = {}) {
  if (!Array.isArray(node)) return false
  if (pred(node)) return true
  if (skipArrow && node[0] === '=>') return false
  for (let i = 1; i < node.length; i++) if (some(node[i], pred, { skipArrow })) return true
  return false
}

const CONTROL_TRANSFER = new Set(['return', 'throw', 'break', 'continue'])

/** Does `body` contain return/throw/break/continue (not inside nested `=>`)? */
export function hasControlTransfer(body) {
  if (!Array.isArray(body)) return false
  if (CONTROL_TRANSFER.has(body[0])) return true
  if (body[0] === '=>') return false
  for (let i = 1; i < body.length; i++) if (hasControlTransfer(body[i])) return true
  return false
}

/** Does `body` contain a `continue` that targets THIS loop? */
export function hasOwnContinue(body) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'continue') return true
  if (op === 'for' || op === 'while' || op === 'do') return false
  for (let i = 1; i < body.length; i++) if (hasOwnContinue(body[i])) return true
  return false
}

export function hasOwnBreakOrContinue(body) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'break' || op === 'continue') return true
  if (op === 'for' || op === 'while' || op === 'do' || op === '=>') return false
  for (let i = 1; i < body.length; i++) if (hasOwnBreakOrContinue(body[i])) return true
  return false
}

// === Arrow param normalization ===


export function extractParams(rawParams) {
  let p = rawParams
  if (Array.isArray(p) && p[0] === '()') p = p[1]
  return p == null ? [] : Array.isArray(p) ? (p[0] === ',' ? p.slice(1) : [p]) : [p]
}

export function classifyParam(r) {
  if (Array.isArray(r) && r[0] === '...') return { kind: 'rest', name: r[1] }
  if (Array.isArray(r) && r[0] === '=') {
    if (typeof r[1] === 'string') return { kind: 'default', name: r[1], defValue: r[2] }
    return { kind: 'destruct-default', pattern: r[1], defValue: r[2] }
  }
  if (Array.isArray(r) && (r[0] === '[]' || r[0] === '{}')) return { kind: 'destruct', pattern: r }
  return { kind: 'plain', name: r }
}

export function collectParamNames(raw, out = new Set()) {
  for (const r of raw) {
    if (typeof r === 'string') out.add(r)
    else if (Array.isArray(r)) {
      if (r[0] === '=' && typeof r[1] === 'string') out.add(r[1])
      else if (r[0] === '...' && typeof r[1] === 'string') out.add(r[1])
      else if (r[0] === '=' && Array.isArray(r[1])) collectParamNames([r[1]], out)
      else if (r[0] === '[]' || r[0] === '{}' || r[0] === ',') collectParamNames(r.slice(1), out)
    }
  }
  return out
}

