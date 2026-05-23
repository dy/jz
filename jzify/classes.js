/**
 * Class and object-method `this` lowering.
 * @module jzify/classes
 */

import { extractParams as paramList, objectLiteralEntries } from '../src/ast.js'

export function createClassLowering({ transform, names, JC }) {
// === class lowering ===
//
// A class is lowered to a factory arrow. Instance state is a plain object;
// methods are per-instance arrows capturing it (so `obj.m()` keeps working
// without a separate `this` argument); `this` is renamed to that object;
// `new C(a)` is already turned into `C(a)` by the `new` handler.
//
//   class Point { x = 0; y; constructor(a,b){ this.x = a; this.y = b }
//                 dist(){ return Math.hypot(this.x, this.y) } }
//   →
//   let Point = (a, b) => {
//     let selfN = { x: undefined, y: undefined,
//                         dist: () => Math.hypot(selfN.x, selfN.y) }
//     selfN.x = 0          // field initializers, in declaration order
//     selfN.x = a          // then the constructor body
//     selfN.y = b
//     return selfN
//   }
//
// Simple inheritance is lowered too: `class D extends B` builds the instance
// from `B`'s factory — forwarding `super(...)` args, or the derived ctor params
// when the derived constructor is implicit — then applies D's own fields and
// methods over it.
//
// Out of scope (rejected with a clear message): full `super.foo` property
// semantics, getters/setters, non-constant computed member names. Private
// `#name` members are kept as the literal key string `#name` (jz allows it).
const DEFAULT_DERIVED_CTOR_ARITY = 8

const arrowParams = params => Array.isArray(params) && params[0] === '()' ? params : ['()', params]
const block = b => Array.isArray(b) && b[0] === '{}' ? b : ['{}', b]

const classBodyItems = (body) =>
  body == null ? [] : Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]

// Rename `this` → `to`, not crossing into a nested `function`/`class` (those
// rebind `this`); arrows inherit `this`, so they are crossed. Property *names*
// (`obj.this`, `{this: …}` value-side only) are left alone.
function renameThis(node, to) {
  if (node === 'this') return to
  if (!Array.isArray(node)) return node
  if (node[0] === 'function' || node[0] === 'class') return node
  if (node[0] === '.' || node[0] === '?.') return [node[0], renameThis(node[1], to), node[2]]
  if (node[0] === ':') return [node[0], node[1], renameThis(node[2], to)]
  return node.map(n => renameThis(n, to))
}

function usesThis(node) {
  if (node === 'this') return true
  if (!Array.isArray(node)) return false
  if (node[0] === 'function' || node[0] === 'class') return false
  if (node[0] === '.' || node[0] === '?.') return usesThis(node[1])
  if (node[0] === ':') return usesThis(node[2])
  return node.some(usesThis)
}

function hasSuperProp(node) {
  if (!Array.isArray(node)) return false
  if ((node[0] === '.' || node[0] === '?.') && node[1] === 'super') return true
  if (node[0] === '[]' && node[1] === 'super') return true
  return node.some(hasSuperProp)
}

function isSuperCall(node) {
  return Array.isArray(node) && node[0] === '()' && node[1] === 'super'
}

function literalStringKey(node) {
  return Array.isArray(node) && node[0] == null && typeof node[1] === 'string' ? node[1] : null
}

function constStringKey(node) {
  if (typeof node === 'string') return node
  const lit = literalStringKey(node)
  if (lit != null) return lit
  if (Array.isArray(node) && node[0] === '[]') return literalStringKey(node[1])
  return null
}

function superMethodName(callee) {
  if (!Array.isArray(callee)) return null
  if ((callee[0] === '.' || callee[0] === '?.') && callee[1] === 'super') return callee[2]
  if (callee[0] === '[]' && callee[1] === 'super') return literalStringKey(callee[2])
  return null
}

function collectSuperMethodCalls(node, out = new Set()) {
  if (!Array.isArray(node)) return out
  if (node[0] === 'function' || node[0] === 'class') return out
  if (node[0] === '()') {
    const name = superMethodName(node[1])
    if (name) out.add(name)
  }
  for (const n of node) collectSuperMethodCalls(n, out)
  return out
}

function rewriteSuperMethodCalls(node, baseMethodVars) {
  if (!Array.isArray(node)) return node
  if (node[0] === 'function' || node[0] === 'class') return node
  if (node[0] === '()') {
    const name = superMethodName(node[1])
    if (name) {
      const fn = baseMethodVars.get(name)
      if (!fn) jzifyError(`super.${name} is not available on the base class`)
      return ['()', fn, ...node.slice(2).map(n => rewriteSuperMethodCalls(n, baseMethodVars))]
    }
  }
  return node.map(n => rewriteSuperMethodCalls(n, baseMethodVars))
}

function splitCtorSuper(body) {
  if (body == null) return { args: null, body }
  if (isSuperCall(body)) return { args: body.slice(2), body: null }
  if (Array.isArray(body) && body[0] === '{}') {
    const inner = splitCtorSuper(body[1])
    return { args: inner.args, body: ['{}', inner.body] }
  }
  if (Array.isArray(body) && body[0] === ';') {
    const out = [';']
    let args = null
    for (const stmt of body.slice(1)) {
      if (args == null && isSuperCall(stmt)) { args = stmt.slice(2); continue }
      out.push(stmt)
    }
    return { args, body: out.length === 1 ? null : out.length === 2 ? out[1] : out }
  }
  return { args: null, body }
}

// Object shorthand methods and arrow-valued properties both parse as `=>`.
// Stay conservative: only statement-shaped bodies are receiver methods here;
// expression-bodied arrows keep their lexical `this` and remain unsupported.
const OBJ_METHOD_BODY_OPS = new Set([';', 'return', 'if', 'for', 'for-in', 'for-of',
  'while', 'do', 'switch', 'throw', 'try', 'break', 'continue'])

function objectLiteralEntries(args) {
  const raw = args.length === 1 && Array.isArray(args[0]) && args[0][0] === ',' ? args[0].slice(1) : args
  return raw.filter(p => p != null)
}

function isStatementBody(body) {
  return Array.isArray(body) && OBJ_METHOD_BODY_OPS.has(body[0])
}

function objectMethodUsesThis(prop) {
  if (!Array.isArray(prop) || prop[0] !== ':' || typeof prop[1] !== 'string') return false
  const value = prop[2]
  if (!Array.isArray(value)) return false
  if (value[0] === '=>' && isStatementBody(value[2])) return usesThis(value[2])
  return false
}

function lowerObjectLiteralThis(args) {
  const props = objectLiteralEntries(args)
  if (props.length === 0 || !props.some(objectMethodUsesThis)) return null
  if (!props.every(p => Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string')) return null

  const self = names.objThis()
  const litProps = props.map(p => {
    const value = p[2]
    if (objectMethodUsesThis(p)) {
      return [':', p[1], transform(['=>', value[1], block(renameThis(value[2], self))])]
    }
    return [':', p[1], transform(value)]
  })
  const lit = ['{}', litProps.length === 1 ? litProps[0] : [',', ...litProps]]
  return ['()', ['()', ['=>', null, ['{}', [';',
    ['let', ['=', self, lit]],
    ['return', self]
  ]]]], null]
}

function jzifyError(msg) { throw new Error(`jzify: ${msg}`) }

function lowerClass(name, heritage, body) {
  let ctorParams = null, ctorBody = null
  const methods = [], fields = [], statics = []
  for (const it of classBodyItems(body)) {
    if (typeof it === 'string') { fields.push([it, null]); continue }   // bare `x;`
    if (!Array.isArray(it)) continue
    const bareFieldName = constStringKey(it)
    if (bareFieldName != null) { fields.push([bareFieldName, null]); continue }
    if (it[0] === ':' && Array.isArray(it[2]) && it[2][0] === '=>') {
      const key = constStringKey(it[1])
      if (key == null) jzifyError(JC.computedMember)
      if (key === 'constructor') { ctorParams = it[2][1]; ctorBody = it[2][2] }
      else methods.push([key, it[2][1], it[2][2]])
      continue
    }
    if (it[0] === '=') {
      const lhs = it[1]
      if (Array.isArray(lhs) && lhs[0] === 'static') {
        const key = constStringKey(lhs[1])
        if (key == null) jzifyError(JC.computedStaticField)
        statics.push([key, it[2]])
        continue
      }
      const key = constStringKey(lhs)
      if (key == null) jzifyError(JC.computedField)
      fields.push([key, it[2]])
      continue
    }
    if (it[0] === 'static') {
      const key = constStringKey(it[1])
      if (key != null) {
        statics.push([key, null])
        continue
      }
    }
    if (it[0] === 'static' && typeof it[1] === 'string') {
      statics.push([it[1], null])
      continue
    }
    if (it[0] === 'static' && Array.isArray(it[1]) && it[1][0] === ':' && Array.isArray(it[1][2]) && it[1][2][0] === '=>') {
      const key = constStringKey(it[1][1])
      if (key == null) jzifyError(JC.computedStaticMember)
      statics.push([key, it[1][2], true])
      continue
    }
    if (it[0] === 'get' || it[0] === 'set') jzifyError(JC.accessor)
    if (it[0] === 'static') jzifyError(JC.staticMember)
    jzifyError(`unsupported class member ${JSON.stringify(it).slice(0, 60)}`)
  }
  const superMethods = heritage == null ? new Set() : new Set([
    ...collectSuperMethodCalls(ctorBody),
    ...fields.flatMap(([, init]) => init == null ? [] : [...collectSuperMethodCalls(init)]),
    ...methods.flatMap(([, , mbody]) => [...collectSuperMethodCalls(mbody)])
  ])
  if (heritage != null) {
    const dummySuperVars = new Map([...superMethods].map((k, i) => [k, names.classSuper(i)]))
    const unsupportedSuperProp = node => node != null && hasSuperProp(rewriteSuperMethodCalls(node, dummySuperVars))
    if (
      unsupportedSuperProp(ctorBody) ||
      fields.some(([, init]) => unsupportedSuperProp(init)) ||
      methods.some(([, , mbody]) => unsupportedSuperProp(mbody))
    )
      jzifyError(JC.superProp)
  }
  const self = names.classSelf()
  const UNDEF = []                                  // jessie's node for `undefined`
  // Object literal: every declared field (its initializer inline when it doesn't
  // touch `this`, else `undefined` and assigned below), every method as its
  // self-capturing arrow. Declaring all fields up front fixes the object shape.
  const litProps = [], deferred = []
  for (const [fname, init] of fields) {
    if (init != null && !usesThis(init)) litProps.push([':', fname, transform(init)])
    else { litProps.push([':', fname, UNDEF]); if (init != null) deferred.push([fname, init]) }
  }
  for (const [mname, mparams, mbody] of methods)
    litProps.push([':', mname, transform(['=>', mparams ?? ['()', null], block(renameThis(mbody, self))])])
  const lit = ['{}', litProps.length === 0 ? null : litProps.length === 1 ? litProps[0] : [',', ...litProps]]
  let params = ctorParams ?? ['()', null]
  const dynamicBase = heritage != null && typeof heritage !== 'string'
  const baseRef = heritage == null ? null : dynamicBase ? names.classBase() : heritage
  const stmts = []
  if (heritage != null) {
    const split = splitCtorSuper(ctorBody)
    ctorBody = split.body
    const defaultArgs = ctorParams == null
      ? Array.from({ length: DEFAULT_DERIVED_CTOR_ARITY }, (_, i) => names.classSuperArg(i))
      : null
    const baseArgs = split.args ?? (defaultArgs ? [defaultArgs.length === 1 ? defaultArgs[0] : [',', ...defaultArgs]] : paramList(ctorParams))
    stmts.push(['let', ['=', self, ['()', baseRef, ...baseArgs.map(transform)]]])
    const superMethodVars = new Map()
    let superIdx = 0
    for (const mname of superMethods) {
      const v = names.classSuper(superIdx++)
      superMethodVars.set(mname, v)
      stmts.push(['let', ['=', v, ['.', self, mname]]])
    }
    for (const [fname, init] of fields)
      stmts.push(['=', ['.', self, fname], init != null ? transform(renameThis(rewriteSuperMethodCalls(init, superMethodVars), self)) : UNDEF])
    for (const [mname, mparams, mbody] of methods)
      stmts.push(['=', ['.', self, mname], transform(['=>', mparams ?? ['()', null], block(renameThis(rewriteSuperMethodCalls(mbody, superMethodVars), self))])])
    ctorBody = rewriteSuperMethodCalls(ctorBody, superMethodVars)
    if (defaultArgs) params = ['()', defaultArgs.length === 1 ? defaultArgs[0] : [',', ...defaultArgs]]
  } else {
    stmts.push(['let', ['=', self, lit]])
  }
  // `this`-dependent field initializers run, in declaration order, before the ctor.
  if (heritage == null) {
    for (const [fname, init] of deferred)
      stmts.push(['=', ['.', self, fname], transform(renameThis(init, self))])
  }
  if (ctorBody != null) {
    let cb = transform(renameThis(ctorBody, self))
    if (Array.isArray(cb) && cb[0] === '{}') cb = cb[1]
    if (Array.isArray(cb) && cb[0] === ';') stmts.push(...cb.slice(1).filter(s => s != null))
    else if (cb != null) stmts.push(cb)
  }
  stmts.push(['return', self])
  const factory = ['=>', arrowParams(params), ['{}', [';', ...stmts]]]
  if (!dynamicBase && statics.length === 0) return factory

  const cls = name || names.classStatic()
  const staticStmts = []
  if (dynamicBase) staticStmts.push(['let', ['=', baseRef, transform(heritage)]])
  staticStmts.push(['let', ['=', cls, factory]])
  for (const [sname, value, isMethod] of statics) {
    const rhs = isMethod
      ? transform(['=>', value[1], block(renameThis(value[2], cls))])
      : value == null ? UNDEF : transform(renameThis(value, cls))
    staticStmts.push(['=', ['.', cls, sname], rhs])
  }
  staticStmts.push(['return', cls])
  return ['()', ['()', ['=>', null, ['{}', [';', ...staticStmts]]]], null]
}

// Array(a, b, …) / new Array(a, b, …) → array literal [a, b, …]; Array() → [].
// The single-argument Array(n) is a length constructor (n holes), not a
// literal — return null there so the caller keeps it as a constructor call.
function lowerArrayConstructor(arg) {
  if (arg == null) return ['[]', null]
  if (Array.isArray(arg) && arg[0] === ',' && arg.length > 2)
    return ['[]', [',', ...arg.slice(1).map(transform)]]
  return null
}

  return { lowerClass, lowerObjectLiteralThis, lowerArrayConstructor }
}
