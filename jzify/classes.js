/**
 * Class and object-method `this` lowering.
 * @module jzify/classes
 */

import { extractParams as paramList, objectLiteralEntries, ACCESSOR_GET, ACCESSOR_SET } from '../src/ast.js'
import { ctx, err } from '../src/ctx.js'

export function createClassLowering({ transform, names, JC, constStrings }) {
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
// Accessors lower to method slots: `get x() {…}` → `x__get: () => …`,
// `set x(v) {…}` → `x__set: (v) => …`, on the instance (or the class for a
// static pair). The name is recorded in `ctx.transform.accessorNames`; the
// emitter turns `o.x` reads and `o.x = v` writes on OBJECT/unknown receivers
// into slot calls (module/core.js, src/compile/emit-assign.js) – a proven
// schema resolves statically, an unknown receiver probes for the slot first.
// A receiver of any other kind (array, string, typed array) is untouched, so
// `.length` on those keeps its lowering.
//
// Out of scope (rejected with a clear message): full `super.foo` property
// semantics, non-constant computed member names. Private `#name` members are
// kept as the literal key string `#name` (jz allows it).
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

// Two pre-class-era idioms in a class body, normalized before the lowering:
//  - `this.m = function (…) { … this … }` installs a method on the instance;
//    its `this` is that instance whenever it is called as `obj.m()`, the one
//    way such a method is called – an arrow, so the `this` rename and the
//    super lowering see it as a method body (a function expression anywhere
//    else keeps its own dynamic `this` and is rejected downstream);
//  - `Base.prototype.m.call(this, …args)` in a class extending `Base` is the
//    explicit form of `super.m(…args)`.
function normalizeClassIdioms(node, base) {
  if (!Array.isArray(node)) return node
  if (node[0] === 'class') return node
  if (node[0] === '=' && Array.isArray(node[1]) && node[1][0] === '.' && node[1][1] === 'this'
      && Array.isArray(node[2]) && node[2][0] === 'function' && !node[2][1])
    return ['=', node[1], ['=>', arrowParams(node[2][2] ?? null), block(normalizeClassIdioms(node[2][3], base))]]
  if (node[0] === 'function') return node
  if (base != null && node[0] === '()' && Array.isArray(node[1]) && node[1][0] === '.' && node[1][2] === 'call') {
    const args = node[2] === 'this' ? [] : Array.isArray(node[2]) && node[2][0] === ',' && node[2][1] === 'this' ? node[2].slice(2) : null
    const m = node[1][1]   // ['.', ['.', Base, 'prototype'], name]
    if (args && Array.isArray(m) && m[0] === '.' && Array.isArray(m[1]) && m[1][0] === '.' && m[1][1] === base && m[1][2] === 'prototype' && typeof m[2] === 'string') {
      const rest = args.map(n => normalizeClassIdioms(n, base))
      return ['()', ['.', 'super', m[2]], rest.length === 0 ? null : rest.length === 1 ? rest[0] : [',', ...rest]]
    }
  }
  return node.map((n, i) => i === 0 ? n : normalizeClassIdioms(n, base))
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

function constStringKey(node, constStrings) {
  if (typeof node === 'string') return node
  const lit = literalStringKey(node)
  if (lit != null) return lit
  if (Array.isArray(node) && node[0] === '[]') {
    const inner = literalStringKey(node[1])
    if (inner != null) return inner
    // [K] where K is a module-scope `const K = 'name'` — fold the binding
    // (collected by jzify's entry prepass; const guarantees no reassignment).
    if (typeof node[1] === 'string') return constStrings?.get(node[1]) ?? null
  }
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

// Object-literal accessors take the same slots as class accessors; the entry
// list is rewritten in place so the `this` lowering below sees plain methods.
function lowerObjectLiteralAccessors(args) {
  const props = objectLiteralEntries(args)
  if (!props.some(p => Array.isArray(p) && (p[0] === 'get' || p[0] === 'set'))) return null
  const out = props.map(p => {
    if (!Array.isArray(p) || (p[0] !== 'get' && p[0] !== 'set')) return p
    const [slot, params, body] = accessorMethod(p, constStrings)
    // a statement-shaped body is what the `this` lowering recognizes as a method
    return [':', slot, ['=>', params, isStatementBody(body) ? body : [';', body]]]
  })
  return out.length === 1 ? [out[0]] : [[',', ...out]]
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

// Route through the shared compiler error channel (uniform Error shape + stack
// cleanup for dependents). jzify runs pre-emit, so err()'s location/function
// enrichment guards simply no-op; the `jzify:` prefix marks the phase.
function jzifyError(msg) { err(`jzify: ${msg}`) }

// `get x()` / `set x(v)` → the slot name the emitter dispatches through, and
// the program-wide record the emitter consults. A derived class installs its
// accessor on the base instance as a dynamic property (`self.x__get = …`
// after the base factory), so `x` may reach a receiver whose schema does not
// list it: those names are the `dynamicAccessorNames` the emitter probes for;
// every other accessor is a literal slot, visible in the schema or absent.
const accessorSlot = (kind, key) => key + (kind === 'get' ? ACCESSOR_GET : ACCESSOR_SET)
const recordAccessor = (key, dynamic) => {
  (ctx.transform.accessorNames ??= new Set()).add(key)
  if (dynamic) (ctx.transform.dynamicAccessorNames ??= new Set()).add(key)
}
// [kind, key, params, body] → [slot, params, body] (a method entry)
function accessorMethod(it, constStrings, dynamic) {
  const key = typeof it[1] === 'string' ? it[1] : constStringKey(it[1], constStrings)
  if (key == null) jzifyError(JC.computedMember)
  recordAccessor(key, dynamic)
  return [accessorSlot(it[0], key), arrowParams(it[2] ?? null), it[3]]
}

function lowerClass(name, heritage, body) {
  let ctorParams = null, ctorBody = null
  const methods = [], fields = [], statics = []
  const items = classBodyItems(normalizeClassIdioms(body, typeof heritage === 'string' ? heritage : null))
  for (let ix = 0; ix < items.length; ix++) {
    const it = items[ix]
    if (typeof it === 'string') { fields.push([it, null]); continue }   // bare `x;`
    if (!Array.isArray(it)) continue
    // `static get x() {…}` parses as a static field `get` followed by the
    // method `x`: the pair is a static accessor
    if (it[0] === 'static' && (it[1] === 'get' || it[1] === 'set') && it.length === 2) {
      const next = items[ix + 1]
      if (Array.isArray(next) && next[0] === ':' && Array.isArray(next[2]) && next[2][0] === '=>') {
        const key = constStringKey(next[1], constStrings)
        if (key == null) jzifyError(JC.computedStaticMember)
        recordAccessor(key, true)
        statics.push([accessorSlot(it[1], key), next[2], true])
        ix++
        continue
      }
    }
    if (it[0] === 'get' || it[0] === 'set') { methods.push(accessorMethod(it, constStrings, heritage != null)); continue }
    const bareFieldName = constStringKey(it, constStrings)
    if (bareFieldName != null) { fields.push([bareFieldName, null]); continue }
    if (it[0] === ':' && Array.isArray(it[2]) && it[2][0] === '=>') {
      const key = constStringKey(it[1], constStrings)
      if (key == null) jzifyError(JC.computedMember)
      if (key === 'constructor' && typeof it[1] === 'string') { ctorParams = it[2][1]; ctorBody = it[2][2] }
      else methods.push([key, it[2][1], it[2][2]])
      continue
    }
    // async method `async m() {}` – an async arrow over the same self
    if (it[0] === ':' && Array.isArray(it[2]) && it[2][0] === 'async' && Array.isArray(it[2][1]) && it[2][1][0] === '=>') {
      const key = constStringKey(it[1], constStrings)
      if (key == null) jzifyError(JC.computedMember)
      methods.push([key, it[2][1][1], it[2][1][2], 'async'])
      continue
    }
    // Generator method `*g() {}` — value is a function* expression (parser emits
    // [':', key, ['function*', null, rawParams, body]]); lowers to the factory
    // arrow via the standard generator lowering, `this` renamed like any method.
    if (it[0] === ':' && Array.isArray(it[2]) && it[2][0] === 'function*') {
      const key = constStringKey(it[1], constStrings)
      if (key == null) jzifyError(JC.computedMember)
      if (key === 'constructor' && typeof it[1] === 'string') jzifyError('`constructor` cannot be a generator')
      methods.push([key, it[2][2], it[2][3], 'gen'])
      continue
    }
    if (it[0] === '=') {
      const lhs = it[1]
      if (Array.isArray(lhs) && lhs[0] === 'static') {
        const key = constStringKey(lhs[1], constStrings)
        if (key == null) jzifyError(JC.computedStaticField)
        statics.push([key, it[2]])
        continue
      }
      const key = constStringKey(lhs, constStrings)
      if (key == null) jzifyError(JC.computedField)
      fields.push([key, it[2]])
      continue
    }
    if (it[0] === 'static') {
      const key = constStringKey(it[1], constStrings)
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
      const key = constStringKey(it[1][1], constStrings)
      if (key == null) jzifyError(JC.computedStaticMember)
      statics.push([key, it[1][2], true])
      continue
    }
    if (it[0] === 'static' && Array.isArray(it[1]) && it[1][0] === ':' && Array.isArray(it[1][2]) && it[1][2][0] === 'function*') {
      const key = constStringKey(it[1][1], constStrings)
      if (key == null) jzifyError(JC.computedStaticMember)
      statics.push([key, it[1][2], 'gen'])
      continue
    }
    if (it[0] === 'static' && Array.isArray(it[1]) && it[1][0] === '{}') {
      // static initialization block — runs in class-init order, `this` = class
      statics.push([null, it[1], 'block'])
      continue
    }
    if (it[0] === 'static') jzifyError(JC.staticMember)
    jzifyError(`unsupported class member shape (jz recognizes fields, methods, and static fields/methods/blocks only): ${JSON.stringify(it).slice(0, 60)}`)
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
  const methodValue = (mparams, mbody, kind, to) => kind === 'gen'
    ? transform(['function*', null, mparams, renameThis(mbody, to)])
    : kind === 'async'
      ? transform(['async', ['=>', mparams ?? ['()', null], block(renameThis(mbody, to))]])
      : transform(['=>', mparams ?? ['()', null], block(renameThis(mbody, to))])
  for (const [mname, mparams, mbody, kind] of methods)
    litProps.push([':', mname, methodValue(mparams, mbody, kind, self)])
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
    for (const [mname, mparams, mbody, kind] of methods)
      stmts.push(['=', ['.', self, mname], methodValue(mparams, rewriteSuperMethodCalls(mbody, superMethodVars), kind, self)])
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
  for (const [sname, value, kind] of statics) {
    if (kind === 'block') {
      let b = transform(renameThis(value, cls))
      if (Array.isArray(b) && b[0] === '{}') b = b[1]
      if (Array.isArray(b) && b[0] === ';') staticStmts.push(...b.slice(1).filter(x => x != null))
      else if (b != null) staticStmts.push(b)
      continue
    }
    const rhs = kind === 'gen'
      ? transform(['function*', null, value[2], renameThis(value[3], cls)])
      : kind
        ? transform(['=>', value[1], block(renameThis(value[2], cls))])
        : value == null ? UNDEF : transform(renameThis(value, cls))
    staticStmts.push(['=', ['.', cls, sname], rhs])
  }
  staticStmts.push(['return', cls])
  return ['()', ['()', ['=>', null, ['{}', [';', ...staticStmts]]]], null]
}

  return { lowerClass, lowerObjectLiteralThis, lowerObjectLiteralAccessors }
}

// ── Pseudo-classical fold ────────────────────────────────────────────────────
// `function P(x) { this.x = x }` + `P.prototype.m = function (…) {…}` siblings
// fold into the class lowering (`class P { constructor(x){…} m(…){…} }`) — the
// single biggest `this`-blocker in pre-class npm code. Method-by-method
// prototype assignments with FUNCTION values only: an arrow RHS keeps lexical
// `this` (folding it would rebind), and a whole-`prototype = {…}` replacement
// is a different idiom — both stay untouched (and reject on `this` as before).
// The ctor must not be reassigned at top level (conservative fail-closed).
export function foldPseudoClassical(stmts) {
  const protoAssign = (st) => {
    // ['=', ['.', ['.', NAME, 'prototype'], m], ['function', '', params, body]]
    if (!Array.isArray(st) || st[0] !== '=' || !Array.isArray(st[1])) return null
    const lhs = st[1]
    if (lhs[0] !== '.' || typeof lhs[2] !== 'string') return null
    const base = lhs[1]
    if (!Array.isArray(base) || base[0] !== '.' || base[2] !== 'prototype' || typeof base[1] !== 'string') return null
    const rhs = st[2]
    if (!Array.isArray(rhs) || rhs[0] !== 'function') return null
    return { ctor: base[1], methods: [{ method: lhs[2], params: rhs[2], body: rhs[3] }] }
  }
  // Object.assign(NAME.prototype, { m: function (…) {…}, … }) — the batch
  // idiom. Whole-or-nothing: any non-function prop value (arrow = lexical
  // this, data prop = prototype state) skips the fold for this statement.
  const protoAssignBatch = (st) => {
    if (!Array.isArray(st) || st[0] !== '()' || !Array.isArray(st[1])) return null
    if (st[1][0] !== '.' || st[1][1] !== 'Object' || st[1][2] !== 'assign') return null
    const args = Array.isArray(st[2]) && st[2][0] === ',' ? st[2].slice(1) : [st[2]]
    if (args.length !== 2) return null
    const [proto, lit] = args
    if (!Array.isArray(proto) || proto[0] !== '.' || proto[2] !== 'prototype' || typeof proto[1] !== 'string') return null
    if (!Array.isArray(lit) || lit[0] !== '{}') return null
    const props = Array.isArray(lit[1]) && lit[1][0] === ',' ? lit[1].slice(1) : lit[1] === undefined ? [] : [lit[1]]
    const methods = []
    for (const pr of props) {
      if (!Array.isArray(pr) || pr[0] !== ':' || typeof pr[1] !== 'string') return null
      if (!Array.isArray(pr[2]) || pr[2][0] !== 'function') return null
      methods.push({ method: pr[1], params: pr[2][2], body: pr[2][3] })
    }
    return methods.length ? { ctor: proto[1], methods } : null
  }
  const matchProto = (st) => protoAssign(st) ?? protoAssignBatch(st)
  const methods = new Map()   // ctorName → [{method, params, body}]
  for (const st of stmts) {
    const pa = matchProto(st)
    if (pa) { const l = methods.get(pa.ctor); l ? l.push(...pa.methods) : methods.set(pa.ctor, [...pa.methods]) }
  }
  if (!methods.size) return stmts

  const reassigned = (name) => stmts.some(st =>
    Array.isArray(st) && st[0] === '=' && st[1] === name)
  const wholeProtoReplaced = (name) => stmts.some(st =>
    Array.isArray(st) && st[0] === '=' && Array.isArray(st[1]) &&
    st[1][0] === '.' && st[1][1] === name && st[1][2] === 'prototype')
  // Decide up front — prototype assignments may appear BEFORE the constructor
  // declaration (function decls hoist in JS), so consumption can't depend on
  // visit order.
  const foldable = new Set([...methods.keys()].filter(name =>
    stmts.some(st => Array.isArray(st) && st[0] === 'function' && st[1] === name) &&
    !reassigned(name) && !wholeProtoReplaced(name)))
  if (!foldable.size) return stmts

  const out = []
  for (const st of stmts) {
    if (Array.isArray(st) && st[0] === 'function' && typeof st[1] === 'string' && foldable.has(st[1])) {
      const ms = methods.get(st[1])
      out.push(['class', st[1], null, [';',
        [':', 'constructor', ['=>', ['()', st[2] ?? null], st[3]]],
        ...ms.map(m => [':', m.method, ['=>', ['()', m.params ?? null], m.body]]),
      ]])
      continue
    }
    const pa = matchProto(st)
    if (pa && foldable.has(pa.ctor)) continue   // consumed by the fold
    out.push(st)
  }
  return out
}
