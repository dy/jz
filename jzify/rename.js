/**
 * Renaming a name through a tree.
 * @module jzify/rename
 */

import { withLoc, collectParamNames, extractParams } from '../src/ast.js'

// Every occurrence of a name as an identifier takes its new name: what binds it
// (a declaration, a parameter, a function's or a class's own name) and what
// reads it, in every scope of the tree alike. Renamed so, each occurrence binds
// as it did, provided the new name occurs nowhere in the tree and the tree
// reads no binding of the old name from outside it.
//
// What spells the same text and is no identifier stays: a property after `.`,
// a key before `:` (an object's, a class's, a label), an accessor's name, a
// field's, a label a `break` or `continue` names, a literal, a regex. A
// shorthand property is its key and a reference at once (`{ a }` in an object
// or a pattern): the key stays and the reference is renamed (`{ a: a2 }`).
//
// Braces hold an object or a pattern where an expression stands and statements
// where a statement stands (prepare/handlers.js decides the same way), so the
// walk carries which of the two it is in.

const FN = new Set(['function', 'function*'])
// statements whose operands from `from` on are statements too
const STMT_FROM = { if: 2, while: 2, try: 1, catch: 2, finally: 1, default: 1, case: 2, with: 2 }
// a module's own forms name bindings by a grammar of their own (`export { a as b }`)
const MODULE_FORM = new Set(['import', 'export', 'from', 'as'])

/** `node` with each identifier `map` holds under its new name. `stmt`: the node stands where a statement does. */
export function rename(node, map, stmt = true) { return withLoc(renameNode(node, map, stmt), node) }

function renameNode(node, map, stmt) {
  if (typeof node === 'string') return map.get(node) ?? node
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op == null || op === 'str' || op === '//' || op === 'break' || op === 'continue') return node
  if (MODULE_FORM.has(op)) throw Error(`rename: a module's ${op} form`)
  const expr = (n) => rename(n, map, false), st = (n) => rename(n, map, true)
  if (op === '.' || op === '?.') return [op, expr(node[1]), node[2]]
  if (op === ';') return stmt ? node.map((n, i) => i ? st(n) : n) : node.map((n, i) => i ? expr(n) : n)
  if (op === '{}') return stmt ? ['{}', ...node.slice(1).map(st)] : ['{}', ...node.slice(1).map(n => members(n, map))]
  // a label where a statement stands, a pair of an object or a class elsewhere
  if (op === ':') return [op, typeof node[1] === 'string' ? node[1] : expr(node[1]), stmt ? st(node[2]) : expr(node[2])]
  if (op === 'get' || op === 'set') return [op, typeof node[1] === 'string' ? node[1] : expr(node[1]), ...node.slice(2, -1).map(expr), st(node[node.length - 1])]
  if (FN.has(op)) return [op, expr(node[1]), expr(node[2]), st(node[3])]
  if (op === '=>') return [op, expr(node[1]), Array.isArray(node[2]) && node[2][0] === '{}' ? st(node[2]) : expr(node[2])]
  if (op === 'class') return [op, expr(node[1]), expr(node[2]), classBody(node[3], map)]
  if (op === 'for') return [op, expr(node[1]), st(node[2])]
  if (op === 'do') return [op, st(node[1]), expr(node[2])]
  if (op === 'switch') return [op, expr(node[1]), ...node.slice(2).map(st)]
  const from = STMT_FROM[op]
  if (from != null) return node.map((n, i) => i === 0 ? n : i < from ? expr(n) : st(n))
  return node.map((n, i) => i ? expr(n) : n)
}

// An object's or a pattern's members: a shorthand is its key and a reference.
const members = (n, map) => {
  if (typeof n === 'string') return map.has(n) ? [':', n, map.get(n)] : n
  if (!Array.isArray(n)) return n
  if (n[0] === ',') return withLoc([',', ...n.slice(1).map(m => members(m, map))], n)
  // `{ a = 1 }` of a pattern: the key, and the reference with its default
  if (n[0] === '=' && typeof n[1] === 'string' && map.has(n[1])) return withLoc([':', n[1], ['=', map.get(n[1]), rename(n[2], map, false)]], n)
  return rename(n, map, false)
}

// A class's members: a field's name is no identifier (`x = 1`, `x`, `static x = 1`).
const classBody = (body, map) => {
  if (!Array.isArray(body)) return body
  if (body[0] === ';') return withLoc([';', ...body.slice(1).map(m => classMember(m, map))], body)
  return classMember(body, map)
}
const classMember = (m, map) => {
  if (!Array.isArray(m)) return m
  const key = (k) => typeof k === 'string' ? k : rename(k, map, false)
  if (m[0] === 'static') return withLoc(['static', Array.isArray(m[1]) && m[1][0] === '{}' ? rename(m[1], map, true) : classMember(m[1], map)], m)
  if (m[0] === '=') return withLoc(['=', Array.isArray(m[1]) && m[1][0] === 'static' ? ['static', key(m[1][1])] : key(m[1]), rename(m[2], map, false)], m)
  return rename(m, map, false)
}

/** How many times `name` stands as an identifier in the tree (a shorthand property counts once). */
export const occurs = (node, name, stmt = true) => {
  let n = 0
  const seen = { get: (k) => { if (k === name) n++ }, has: (k) => { if (k === name) n++; return false } }
  renameNode(node, seen, stmt)
  return n
}

// A name is free in a tree where an occurrence of it binds to nothing the tree declares:
// asked of the tree with the name's identifiers marked (the walk above tells an identifier
// from a property, a key or a label), where what is left to know is what declares.
const MARK = '\u0000free'
const bindsMark = (pattern) => collectParamNames([pattern]).has(MARK)
const takes = (params) => collectParamNames(extractParams(params)).has(MARK)
const declaresMark = (s) => Array.isArray(s) && (
  (s[0] === 'let' || s[0] === 'const' || s[0] === 'var') && s.some((d, i) => i > 0 && bindsMark(d)) ||
  (FN.has(s[0]) || s[0] === 'class') && s[1] === MARK || s[0] === 'async' && declaresMark(s[1]))
const freeMark = (n) => {
  if (n === MARK) return true
  if (!Array.isArray(n)) return false
  const op = n[0]
  if (FN.has(op)) return n[1] !== MARK && !takes(n[2]) && (freeMark(n[2]) || freeMark(n[3]))
  if (op === '=>') return !takes(n[1]) && (freeMark(n[1]) || freeMark(n[2]))
  if (op === 'class' && n[1] === MARK) return false
  if (op === 'catch' && n[1] != null && bindsMark(n[1])) return false
  // a list's declaration binds the name through the list; a loop's head through its body
  if ((op === ';' || op === '{}') && n.some((s, i) => i > 0 && (declaresMark(s) || Array.isArray(s) && s[0] === ';' && s.some((d, k) => k > 0 && declaresMark(d))))) return false
  if (op === 'for' && Array.isArray(n[1]) && n[1].some((h, i) => i > 0 && declaresMark(h))) return false
  return n.some((c, i) => i > 0 && freeMark(c))
}
const bindsIn = (n) => Array.isArray(n) && (
  FN.has(n[0]) && (n[1] === MARK || takes(n[2])) || n[0] === '=>' && takes(n[1]) || n[0] === 'class' && n[1] === MARK ||
  n[0] === 'catch' && n[1] != null && bindsMark(n[1]) || declaresMark(n) || n.some((c, i) => i > 0 && bindsIn(c)))
/** Whether the tree binds `name` anywhere in it: a declaration, a parameter, a function's or a class's own name, a catch's. */
export const binds = (node, name, stmt = true) => bindsIn(renameNode(node, new Map([[name, MARK]]), stmt))

/** Whether the tree reads or writes a binding of `name` that it does not declare. */
export const free = (node, name, stmt = true) => freeMark(renameNode(node, new Map([[name, MARK]]), stmt))

/** Whether `name` is spelled anywhere in the tree, as an identifier or as any other text of a node. */
export const spells = (node, name) => node === name || Array.isArray(node) && node.some((n, i) => i > 0 && spells(n, name))
