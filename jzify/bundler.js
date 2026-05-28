/**
 * Bundler/export helper folds and object-literal idiom canonicalization.
 * @module jzify/bundler
 */

import {
  handlerArgs, JZ_BLOCK_OPS, bindingOf, cloneNode, nodeEqual, descriptorProps,
  literalString, collectBareRefs, moduleStmts, someDeep, isZeroLiteral, paramList,
} from '../src/ast.js'

export function foldStaticExportHelpers(ast) {
  const body = moduleStmts(ast)
  if (!body) return ast

  const defPropAliases = new Set()
  for (const stmt of body) {
    const b = bindingOf(stmt)
    if (b && isObjectDefineProperty(b[1])) defPropAliases.add(b[0])
  }
  if (!defPropAliases.size) return ast

  const helperNames = new Set()
  for (const stmt of body) {
    const b = bindingOf(stmt)
    if (b && Array.isArray(b[1]) && b[1][0] === '=>' && containsDefinePropertyCall(b[1], defPropAliases))
      helperNames.add(b[0])
  }
  if (!helperNames.size) return ast

  const rewrites = new Map()
  const removable = new Set()
  for (const stmt of body) {
    const ex = staticExportCall(stmt, helperNames)
    if (!ex) continue
    for (const [key, value] of ex.props) rewrites.set(`${ex.target}.${key}`, value)
    removable.add(stmt)
  }
  if (!rewrites.size) return ast

  const rewritten = body
    .filter(stmt => !removable.has(stmt) && !isDefPropAliasAssign(stmt, defPropAliases) && !isExportHelperAssign(stmt, helperNames))
    .map(stmt => replaceStaticExportReads(stmt, rewrites))
  return rewritten.length === 0 ? null : rewritten.length === 1 ? rewritten[0] : [';', ...rewritten]
}

// Esbuild's CommonJS/ESM interop helpers alias Object reflection built-ins into
// locals (`var __create = Object.create`, `var __getOwnPropNames =
// Object.getOwnPropertyNames`, ...). jz deliberately does not expose those
// built-ins as first-class function values, but the helpers are static enough to
// lower back to the supported direct calls and module reads.
export function foldStaticBundlerHelpers(ast) {
  const body = moduleStmts(ast)
  if (!body) return ast
  const binds = body.map(bindingOf)   // [name, init] | null, index-aligned with body

  // Local aliases of Object reflection built-ins: name -> canonical built-in.
  // esbuild's interop preamble always emits these (`var __defProp =
  // Object.defineProperty`, ...); their absence proves the input is not a
  // bundle, so the fold stays a strict no-op rather than guessing.
  const aliases = new Map()
  for (const b of binds) {
    const key = b && objectBuiltinKey(b[1])
    if (key) aliases.set(b[0], key)
  }
  if (!aliases.size) return ast

  // __copyProps: an arrow driving both aliased getOwnPropertyNames + defineProperty.
  const copyHelpers = new Set()
  for (const b of binds)
    if (b && isArrow(b[1]) &&
        containsCall(b[1], c => aliases.get(c) === 'Object.getOwnPropertyNames') &&
        containsCall(b[1], c => aliases.get(c) === 'Object.defineProperty'))
      copyHelpers.add(b[0])

  // __toESM: an arrow cloning a module behind a prototype, tagging default/__esModule.
  const interopHelpers = new Set()
  for (const b of binds)
    if (b && isArrow(b[1]) &&
        containsCall(b[1], c => aliases.get(c) === 'Object.create') &&
        containsCall(b[1], c => aliases.get(c) === 'Object.getPrototypeOf') &&
        containsCall(b[1], c => copyHelpers.has(c)) &&
        someDeep(b[1], n => n === 'default') && someDeep(b[1], n => n === '__esModule'))
      interopHelpers.add(b[0])

  // Bindings produced by an interop-helper call: name -> wrapped module expression.
  const interopBindings = new Map()
  for (const b of binds)
    if (b && Array.isArray(b[1]) && b[1][0] === '()' && interopHelpers.has(b[1][1])) {
      const args = handlerArgs(b[1].slice(2))
      if (args.length) interopBindings.set(b[0], args[0])
    }

  let out = body.map(stmt => rewriteBundlerAliases(stmt, aliases, interopBindings))
  if (interopBindings.size) out = out.map(stmt => replaceInteropReads(stmt, interopBindings))
  out = out.map(stmt => rewriteBundlerAliases(stmt, aliases, interopBindings)).filter(s => s != null)

  // Drop synthetic alias/helper bindings nothing references after rewriting.
  const synthetic = n => aliases.has(n) || copyHelpers.has(n) || interopHelpers.has(n) || interopBindings.has(n)
  const live = new Set()
  for (const stmt of out) {
    const b = bindingOf(stmt)
    if (!(b && synthetic(b[0]))) collectBareRefs(stmt, live)
  }
  out = out.filter(stmt => {
    const b = bindingOf(stmt)
    return !(b && synthetic(b[0]) && !live.has(b[0]))
  })

  return out.length === 0 ? null : out.length === 1 ? out[0] : [';', ...out]
}

const isArrow = node => Array.isArray(node) && node[0] === '=>'

const OBJECT_BUILTINS = new Set(['create', 'getPrototypeOf', 'getOwnPropertyNames', 'getOwnPropertyDescriptor', 'defineProperty'])

// Canonical name of the Object reflection built-in `node` references, or null.
function objectBuiltinKey(node) {
  if (!Array.isArray(node) || node[0] !== '.') return null
  if (node[1] === 'Object' && OBJECT_BUILTINS.has(node[2])) return 'Object.' + node[2]
  return isObjectHasOwnPropertyRef(node) ? 'Object.prototype.hasOwnProperty' : null
}

// Does `node` contain a `()` call whose string callee satisfies `ok`?
const containsCall = (node, ok) =>
  someDeep(node, n => Array.isArray(n) && n[0] === '()' && typeof n[1] === 'string' && ok(n[1]))

function rewriteBundlerAliases(node, aliases, interopBindings) {
  if (!Array.isArray(node)) return node
  const rec = n => rewriteBundlerAliases(n, aliases, interopBindings)

  if (node[0] === ';') {
    const out = [';']
    for (let i = 1; i < node.length; i++) {
      const child = rec(node[i])
      if (child != null) out.push(child)
    }
    return out.length === 1 ? null : out.length === 2 ? out[1] : out
  }
  if (node[0] === '{}' && node.length === 2) {
    const wasBlock = Array.isArray(node[1]) && JZ_BLOCK_OPS.has(node[1][0])
    const inner = rec(node[1])
    if (!wasBlock || inner == null) return ['{}', inner]
    const stayed = Array.isArray(inner) && JZ_BLOCK_OPS.has(inner[0])
    return ['{}', stayed ? inner : [';', inner]]
  }

  if (node[0] === '()') {
    const callee = node[1]
    const args = handlerArgs(node.slice(2))

    if (typeof callee === 'string') {
      const key = aliases.get(callee)
      if (key === 'Object.defineProperty') {
        const define = staticDefineProperty(args)
        if (define !== undefined) return define
      }
      if (key === 'Object.getOwnPropertyNames' || key === 'Object.create') {
        if (key === 'Object.create' && isGetPrototypeOfCall(args[0], aliases)) return ['{}', null]
        return ['()', key, ...args.map(rec)]
      }
    }
    // `__hasOwnProp.call(o, k)` -> `o.hasOwnProperty(k)`.
    if (Array.isArray(callee) && callee[0] === '.' && callee[2] === 'call' && args.length >= 2 &&
        typeof callee[1] === 'string' && aliases.get(callee[1]) === 'Object.prototype.hasOwnProperty')
      return ['()', ['.', rec(args[0]), 'hasOwnProperty'], rec(args[1])]
    // `(0, fn)(...)` comma-call resolving to an interop module read.
    const seqCall = commaZeroCall(callee, interopBindings)
    if (seqCall) return ['()', seqCall, ...args.map(rec)]
  }

  if (node[0] === '.' || node[0] === '?.') return [node[0], rec(node[1]), node[2]]
  if (node[0] === ':') return [node[0], node[1], rec(node[2])]
  return node.map((part, i) => i === 0 ? part : rec(part))
}

function replaceInteropReads(node, bindings) {
  if (typeof node === 'string' && bindings.has(node)) return cloneNode(bindings.get(node))
  if (!Array.isArray(node)) return node
  if (node[0] === '=' && typeof node[1] === 'string') return ['=', node[1], replaceInteropReads(node[2], bindings)]
  if (node[0] === 'let' || node[0] === 'const' || node[0] === 'var')
    return [node[0], ...node.slice(1).map(decl =>
      Array.isArray(decl) && decl[0] === '=' ? ['=', decl[1], replaceInteropReads(decl[2], bindings)] : decl)]
  if ((node[0] === '.' || node[0] === '?.') && typeof node[1] === 'string' && typeof node[2] === 'string' && bindings.has(node[1])) {
    const mod = cloneNode(bindings.get(node[1]))
    return node[2] === 'default' ? mod : [node[0], mod, node[2]]
  }
  if (node[0] === ':') return [node[0], node[1], replaceInteropReads(node[2], bindings)]
  return node.map((part, i) => i === 0 ? part : replaceInteropReads(part, bindings))
}

function isGetPrototypeOfCall(node, aliases) {
  if (!Array.isArray(node) || node[0] !== '()') return false
  const callee = node[1]
  return (typeof callee === 'string' && aliases.get(callee) === 'Object.getPrototypeOf') ||
    objectBuiltinKey(callee) === 'Object.getPrototypeOf'
}

function commaZeroCall(callee, bindings) {
  if (!Array.isArray(callee) || callee[0] !== '()' || !Array.isArray(callee[1]) || callee[1][0] !== ',') return null
  const parts = callee[1].slice(1)
  if (parts.length !== 2 || !isZeroLiteral(parts[0])) return null
  const fn = replaceInteropReads(parts[1], bindings)
  return fn === parts[1] ? null : fn
}

// `defProp(obj, "key", descriptor)` -> `obj.key = value`; null drops `__esModule`.
function staticDefineProperty(args) {
  if (args.length < 3) return undefined
  const [obj, keyExpr, desc] = args
  const key = literalString(keyExpr)
  const props = descriptorProps(desc)
  if (typeof key !== 'string' || !props) return undefined
  if (key === '__esModule') return null
  const prop = name => props.find(p => Array.isArray(p) && p[0] === ':' && p[1] === name)?.[2]
  const value = prop('value')
  if (value !== undefined) return ['=', ['.', obj, key], value]
  const got = getterReturnExpr(prop('get'))
  return got !== null ? ['=', ['.', obj, key], got] : undefined
}

function isObjectDefineProperty(node) {
  return Array.isArray(node) && node[0] === '.' && node[1] === 'Object' && node[2] === 'defineProperty'
}

/** Unwrap an esbuild module binding to `[name, init]`. After hoistVars, a binding
 *  reaches this pass either split into a bare `['=', name, init]` (RHS hoisted out
 *  as a separate `let name;`) or kept as a single `['let', ['=', name, init]]` decl
 *  (arrow RHS — see the `;` handler in hoistVars). The fold keys on name/init,
 *  so it must see through both shapes. */
function isDefPropAliasAssign(stmt, aliases) {
  const b = bindingOf(stmt)
  return b != null && aliases.has(b[0]) && isObjectDefineProperty(b[1])
}

function isExportHelperAssign(stmt, helpers) {
  const b = bindingOf(stmt)
  return b != null && helpers.has(b[0])
}

function containsDefinePropertyCall(node, aliases) {
  if (!Array.isArray(node)) return false
  if (node[0] === '()' && (aliases.has(node[1]) || isObjectDefineProperty(node[1]))) return true
  for (let i = 1; i < node.length; i++) if (containsDefinePropertyCall(node[i], aliases)) return true
  return false
}

function staticExportCall(stmt, helpers) {
  if (!Array.isArray(stmt) || stmt[0] !== '()' || !helpers.has(stmt[1])) return null
  const args = handlerArgs(stmt.slice(2))
  if (args.length !== 2 || typeof args[0] !== 'string') return null
  const props = descriptorProps(args[1])
  if (!props) return null
  const out = []
  for (const prop of props) {
    if (!Array.isArray(prop) || prop[0] !== ':' || typeof prop[1] !== 'string') return null
    const value = getterReturnExpr(prop[2])
    if (!value) return null
    out.push([prop[1], value])
  }
  return { target: args[0], props: out }
}

function getterReturnExpr(node) {
  if (!Array.isArray(node) || node[0] !== '=>') return null
  const params = paramList(node[1])
  if (params.length !== 0) return null
  const body = node[2]
  if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === 'return') return body[1][1]
  if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === ';' &&
      Array.isArray(body[1][1]) && body[1][1][0] === 'return') return body[1][1][1]
  if (Array.isArray(body) && body[0] === 'return') return body[1]
  return body
}

function replaceStaticExportReads(node, rewrites) {
  if (node == null || typeof node !== 'object' || !Array.isArray(node)) return node
  if ((node[0] === '.' || node[0] === '?.') && typeof node[1] === 'string' && typeof node[2] === 'string') {
    const value = rewrites.get(`${node[1]}.${node[2]}`)
    if (value) return cloneNode(value)
  }
  if (node[0] === ':') return [node[0], node[1], replaceStaticExportReads(node[2], rewrites)]
  return node.map((part, i) => i === 0 ? part : replaceStaticExportReads(part, rewrites))
}

export function canonicalizeObjectIdioms(node) {
  if (node == null || typeof node !== 'object' || !Array.isArray(node)) return node

  const out = node.map((part, i) => i === 0 ? part : canonicalizeObjectIdioms(part))

  const toStringCall = objectPrototypeToStringCall(out)
  if (toStringCall) return ['()', '__object_toString', toStringCall.obj]

  const hasOwnCall = objectHasOwnPropertyCall(out)
  if (hasOwnCall) return ['()', ['.', hasOwnCall.obj, 'hasOwnProperty'], hasOwnCall.key]

  const mapString = arrayMapStringCallback(out)
  if (mapString) return mapString

  if (out[0] === '&&') {
    const leftCtor = constructorIsObject(out[1])
    const rightKeys = objectKeysLengthZero(out[2])
    if (leftCtor && rightKeys && nodeEqual(leftCtor.obj, rightKeys.obj)) return out[2]

    const leftKeys = objectKeysLengthZero(out[1])
    const rightCtor = constructorIsObject(out[2])
    if (leftKeys && rightCtor && nodeEqual(leftKeys.obj, rightCtor.obj)) return out[1]
  }

  return out
}

function arrayMapStringCallback(node) {
  if (!Array.isArray(node) || node[0] !== '()') return null
  const callee = node[1]
  if (!Array.isArray(callee) || callee[0] !== '.' || callee[2] !== 'map') return null
  const args = handlerArgs(node.slice(2))
  if (args.length !== 1 || args[0] !== 'String') return null
  return ['()', callee, ['=>', 'value', ['()', 'String', 'value']]]
}

function objectHasOwnPropertyCall(node) {
  if (!Array.isArray(node) || node[0] !== '()') return null
  const callee = node[1]
  if (!Array.isArray(callee) || callee[0] !== '.' || callee[2] !== 'call') return null
  if (!isObjectHasOwnPropertyRef(callee[1])) return null
  const args = handlerArgs(node.slice(2))
  if (args.length < 2) return null
  return { obj: args[0], key: args[1] }
}

function objectPrototypeToStringCall(node) {
  if (!Array.isArray(node) || node[0] !== '()') return null
  const callee = node[1]
  if (!Array.isArray(callee) || callee[0] !== '.' || callee[2] !== 'call') return null
  if (!isObjectPrototypeToStringRef(callee[1])) return null
  const args = handlerArgs(node.slice(2))
  if (args.length < 1) return null
  return { obj: args[0] }
}

function isObjectHasOwnPropertyRef(node) {
  if (!Array.isArray(node) || node[0] !== '.' || node[2] !== 'hasOwnProperty') return false
  if (node[1] === 'Object') return true
  return Array.isArray(node[1]) && node[1][0] === '.' && node[1][1] === 'Object' && node[1][2] === 'prototype'
}

function isObjectPrototypeToStringRef(node) {
  return Array.isArray(node) && node[0] === '.' && node[2] === 'toString' &&
    Array.isArray(node[1]) && node[1][0] === '.' && node[1][1] === 'Object' && node[1][2] === 'prototype'
}

function constructorIsObject(node) {
  if (!Array.isArray(node) || (node[0] !== '===' && node[0] !== '==')) return null
  const left = constructorReceiver(node[1])
  if (left && node[2] === 'Object') return { obj: left }
  const right = constructorReceiver(node[2])
  if (right && node[1] === 'Object') return { obj: right }
  return null
}

function constructorReceiver(node) {
  return Array.isArray(node) && node[0] === '.' && node[2] === 'constructor' ? node[1] : null
}

function objectKeysLengthZero(node) {
  if (!Array.isArray(node) || (node[0] !== '===' && node[0] !== '==')) return null
  const left = objectKeysLengthReceiver(node[1])
  if (left && isZeroLiteral(node[2])) return { obj: left }
  const right = objectKeysLengthReceiver(node[2])
  if (right && isZeroLiteral(node[1])) return { obj: right }
  return null
}

function objectKeysLengthReceiver(node) {
  if (!Array.isArray(node) || node[0] !== '.' || node[2] !== 'length') return null
  const call = node[1]
  if (!Array.isArray(call) || call[0] !== '()') return null
  const callee = call[1]
  if (!Array.isArray(callee) || callee[0] !== '.' || callee[1] !== 'Object' || callee[2] !== 'keys') return null
  const args = handlerArgs(call.slice(2))
  return args.length === 1 ? args[0] : null
}
