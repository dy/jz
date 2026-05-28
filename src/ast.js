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

/** Statement-only ops: heads that can never be a concise arrow *value* body.
 *  A concise-body arrow with one of these can only have come from method/function
 *  shorthand the parser unwrapped (`m(){ if … }` → `['=>', p, ['if', …]]`), so it
 *  must be re-blocked. Excludes `function`/`class` (those ARE expression bodies,
 *  e.g. `() => function(){}`), assignment/update/call, and switch-internal
 *  `case`/`default`. */
export const STMT_ONLY_OPS = new Set([';', 'if', 'for', 'for-in', 'for-of', 'while', 'do', 'switch',
  'return', 'break', 'continue', 'throw', 'try', 'let', 'const', 'var', 'label'])

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

/** Options for {@link refsName} / {@link refsAny}. */
// skipArrow (default true): stop at `=>` boundaries — matches `some()`.
// skipStr: don't descend into `str` literal nodes.
// skipBindingPositions: on `.`/`?.` recurse only the receiver; on `:` only the value.

/** Expression-position name refs: descends into `=>`, skips literal keys and `str`. */
export const REFS_IN_EXPR = { skipArrow: false, skipStr: true, skipBindingPositions: true }

/** True if bare identifier `name` appears anywhere in `node`. */
export function refsName(node, name, opts = {}) {
  const skipArrow = opts.skipArrow !== false
  if (typeof node === 'string') return node === name
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (skipArrow && op === '=>') return false
  if (opts.skipStr && op === 'str') return false
  if (opts.skipBindingPositions) {
    if (op === '.' || op === '?.') return refsName(node[1], name, opts)
    if (op === ':') return refsName(node[2], name, opts)
  }
  for (let i = 1; i < node.length; i++) if (refsName(node[i], name, opts)) return true
  return false
}

/** True if any name in `names` (Set) appears in `node`. Same options as refsName. */
export function refsAny(node, names, opts = {}) {
  if (!names?.size) return false
  if (typeof node === 'string') return names.has(node)
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (opts.skipArrow !== false && op === '=>') return false
  if (opts.skipStr && op === 'str') return false
  if (opts.skipBindingPositions) {
    if (op === '.' || op === '?.') return refsAny(node[1], names, opts)
    if (op === ':') return refsAny(node[2], names, opts)
  }
  for (let i = 1; i < node.length; i++) if (refsAny(node[i], names, opts)) return true
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

// === Return-path queries (narrowing) ===

const collectReturnExprs = (node, out) => {
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  if (op === '=>') return
  if (op === 'return') { if (args[0] != null) out.push(args[0]); return }
  for (const a of args) collectReturnExprs(a, out)
}

export const alwaysReturns = (n) => {
  if (!Array.isArray(n)) return false
  const op = n[0]
  if (op === '=>') return false
  if (op === 'return' || op === 'throw') return true
  if (op === '{}' || op === ';') return alwaysReturns(n[n.length - 1])
  if (op === 'if') return n.length >= 4 && alwaysReturns(n[2]) && alwaysReturns(n[3])
  return false
}

export const hasBareReturn = (n) => {
  if (!Array.isArray(n)) return false
  if (n[0] === '=>') return false
  if (n[0] === 'return' && n[1] == null) return true
  return n.some(hasBareReturn)
}

export const returnExprs = (body) => {
  if (isBlockBody(body)) {
    const out = []
    collectReturnExprs(body, out)
    return out
  }
  return [body]
}

// === Clone / compare / module body / bare refs ===

/** Deep-clone an AST node (arrays only; primitives pass through). */
export function cloneNode(node) {
  if (node == null || typeof node !== 'object') return node
  if (!Array.isArray(node)) return node
  return node.map(cloneNode)
}

/** Structural equality via JSON (AST nodes are JSON-serializable). */
export function nodeEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Property entries of an object-literal AST node (`['{}', …]`). */
export function descriptorProps(node) {
  if (!Array.isArray(node) || node[0] !== '{}') return null
  const body = node[1]
  if (body == null) return []
  if (Array.isArray(body) && body[0] === ',') return body.slice(1)
  return [body]
}

/** Comma-unwrapped entries from an object-literal constructor arg list. */
export function objectLiteralEntries(args) {
  const raw = args.length === 1 && Array.isArray(args[0]) && args[0][0] === ',' ? args[0].slice(1) : args
  return raw.filter(p => p != null)
}

/** String literal node → string, or null. */
export function literalString(node) {
  return Array.isArray(node) && node[0] == null && typeof node[1] === 'string' ? node[1] : null
}

/** Zero numeric literal node. */
export function isZeroLiteral(node) {
  return Array.isArray(node) && node[0] == null && node[1] === 0
}

/** Top-level module statements; null when `ast` is not module-shaped. */
export function moduleStmts(ast) {
  if (!Array.isArray(ast)) return null
  return ast[0] === ';' ? ast.slice(1).filter(Boolean) : [ast]
}

/** Unwrap esbuild module binding to `[name, init]`, or null. */
export function bindingOf(stmt) {
  if (!Array.isArray(stmt)) return null
  if (stmt[0] === '=' && typeof stmt[1] === 'string') return [stmt[1], stmt[2]]
  if ((stmt[0] === 'let' || stmt[0] === 'const' || stmt[0] === 'var') && stmt.length === 2 &&
      Array.isArray(stmt[1]) && stmt[1][0] === '=' && typeof stmt[1][1] === 'string')
    return [stmt[1][1], stmt[1][2]]
  return null
}

/** Identifier refs in value positions (skip decl names, member keys, object keys). */
export function collectBareRefs(node, out) {
  if (typeof node === 'string') return void out.add(node)
  if (!Array.isArray(node)) return
  if (node[0] === 'let' || node[0] === 'const' || node[0] === 'var') {
    for (let i = 1; i < node.length; i++)
      if (Array.isArray(node[i]) && node[i][0] === '=') collectBareRefs(node[i][2], out)
  } else if ((node[0] === '.' || node[0] === '?.') && typeof node[2] === 'string') {
    collectBareRefs(node[1], out)
  } else if (node[0] === ':') {
    collectBareRefs(node[2], out)
  } else {
    for (let i = 1; i < node.length; i++) collectBareRefs(node[i], out)
  }
}

/** Deep walk: `pred` on every node including bare identifiers; descends into arrows. */
export function someDeep(node, pred) {
  if (pred(node)) return true
  if (!Array.isArray(node)) return false
  for (let i = 1; i < node.length; i++) if (someDeep(node[i], pred)) return true
  return false
}

/** Alias for {@link extractParams}. */
export const paramList = extractParams

