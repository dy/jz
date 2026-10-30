/**
 * jzify — Transform JS AST into jz-compatible form.
 *
 * Crockford-aligned: eliminates bad parts, enforces good practices.
 * Runs before prepare() as an AST→AST pass.
 *
 * @module jzify
 */

import { JZIFY_CLASS_ERRORS as JC } from '../src/op-policy.js'
import { createAsyncLowering, assignCensus } from './async.js'
import { STD_GLOBALS } from '../src/std/index.js'
import { TYPED_CTORS, TYPED_BYTES } from '../src/std/typed.js'
import { createNames } from './names.js'
import { foldStaticExportHelpers, foldStaticBundlerHelpers, canonicalizeObjectIdioms } from './bundler.js'
import { createSwitchLowering, normalizeCaseBody } from './switch.js'
import { createClassLowering, foldPseudoClassical, foldPrototypeStores } from './classes.js'
import { hoistVars, prependDecls } from './hoist-vars.js'
import { settleVars } from './settle-vars.js'
import { createArgumentsLowering } from './arguments.js'
import { createTransform, bindGenerators } from './transform.js'
import { createGeneratorLowering, closesOnReturn } from './generators.js'
import { isResourceDecl } from './using.js'
import { collectParamNames, extractParams, isBlockBody, JZ_BLOCK_OPS, MUTATE_OPS, withLoc } from '../src/ast.js'
import { err } from '../src/ctx.js'
import { hostGlobalName } from '../src/prepare/state.js'
import { HOST_GLOBALS } from '../src/autoload.js'

const names = createNames()
const SHADOW_SENSITIVE = new Set([
  'Array', 'Map', 'Set', 'SharedArrayBuffer', 'URLSearchParams', 'Promise', 'queueMicrotask',
  'Function', 'Iterator', 'Symbol',
])
let builtinScopes = new WeakMap()
let activeBuiltinScope = null
// Every declared name: the shadow test filters by SHADOW_SENSITIVE, the
// class lowering also resolves the nearest lexical declaration scope.
const addBuiltinName = (scope, name) => {
  if (typeof name === 'string') scope.names.add(name)
}
// A variable or parameter binds a value; a class, function or import names itself.
const addPatternNames = (scope, pattern) => {
  const bound = collectParamNames([pattern])
  for (const name of bound) { addBuiltinName(scope, name); scope.values.add(name) }
}
// A declarator whose value is a class or function literal names it, as a
// declaration does (`const g = function* () {}`; a `var` is hoisted apart
// from its value by then).
const addDeclarator = (scope, d) => {
  if (!Array.isArray(d) || d[0] !== '=') return addPatternNames(scope, d)
  addPatternNames(scope, d[1])
  if (typeof d[1] !== 'string' || !Array.isArray(d[2])) return
  const lit = d[2][0] === 'async' && Array.isArray(d[2][1]) ? d[2][1][0] : d[2][0]
  if (lit === 'class' || lit === 'function' || lit === 'function*' || lit === '=>') scope.values.delete(d[1])
  const init = d[2]
  scope.inits.set(d[1], init)
  if (callableNonCtor(init)) scope.nonCtors.add(d[1])
  else if (init[0] === '{}') {
    // an object literal's members that are such functions (`{ m() {}, f: () => 1 }`)
    const keys = new Set()
    for (const p of init[1]?.[0] === ',' ? init[1].slice(1) : [init[1]])
      if (Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string' && callableNonCtor(p[2])) keys.add(p[1])
    if (keys.size) scope.nonCtorMembers.set(d[1], keys)
  }
  else if (init[0] === 'class') addClassMembers(scope, d[1], init[3])
}
// A class's methods and arrow fields: its own members (`static`) and its
// instances' (inherited ones are not followed).
// A key any other member of the same name holds stays unknown, and an instance
// is the class's own only where its constructor returns no other object.
const addClassMembers = (scope, name, body) => {
  const own = new Set(), proto = new Set(), other = new Set()
  let instance = true
  for (const m of Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]) {
    if (!Array.isArray(m)) continue
    const stat = m[0] === 'static', e = stat ? m[1] : m
    if (!Array.isArray(e)) continue
    const fieldStatic = e[0] === '=' && Array.isArray(e[1]) && e[1][0] === 'static'
    const key = e[0] === ':' ? e[1] : e[0] === '=' ? (fieldStatic ? e[1][1] : e[1]) : e[0] === 'get' || e[0] === 'set' ? e[1] : null
    if (key === 'constructor' && e[0] === ':' && Array.isArray(e[2]) && returnsValue(e[2][3])) instance = false
    if (typeof key !== 'string' || key === 'constructor') continue
    if (e[0] !== 'get' && e[0] !== 'set' && callableNonCtor(e[2])) (stat || fieldStatic ? own : proto).add(key)
    else other.add(key)
  }
  for (const k of other) { own.delete(k); proto.delete(k) }
  if (own.size) scope.nonCtorMembers.set(name, own)
  if (proto.size && instance) scope.protoNonCtors.set(name, proto)
}
// A function body's `return` of a value, nested functions aside.
const returnsValue = (n) => {
  if (!Array.isArray(n) || n[0] === '=>' || n[0] === 'function' || n[0] === 'function*' || n[0] === 'class') return false
  if (n[0] === 'return' && n[1] != null) return true
  for (let i = 1; i < n.length; i++) if (returnsValue(n[i])) return true
  return false
}
// A function that is no constructor (ECMA-262 10.2.4 MakeConstructor runs for
// function declarations, expressions and classes alone): an arrow, a method
// (an object literal's or a class's shorthand, parsed with no name), an async
// function or a generator of any form. `new` of one throws a TypeError.
const callableNonCtor = (n) => {
  while (Array.isArray(n) && n[0] === '()' && n.length === 2) n = n[1]
  return Array.isArray(n) && (n[0] === '=>' || n[0] === 'async' || n[0] === 'function*' || n[0] === 'function' && n[1] === null)
}
const addImportBindings = (scope, node) => {
  if (typeof node === 'string') { addBuiltinName(scope, node); return }
  if (!Array.isArray(node)) return
  if (node[0] === 'as') { addBuiltinName(scope, node[2]); return }
  if (node[0] === 'import' || node[0] === 'from') { addImportBindings(scope, node[1]); return }
  if (node[0] === '{}' || node[0] === ',')
    for (let i = 1; i < node.length; i++) addImportBindings(scope, node[i])
}
const scopeHasBuiltin = (scope, name) => {
  for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true
  return false
}
const shadowsJzifyBuiltin = name => SHADOW_SENSITIVE.has(name) && scopeHasBuiltin(activeBuiltinScope, name)
const classBindingScope = name => { for (let s = activeBuiltinScope; s; s = s.parent) if (s.names.has(name)) return s; return null }
const atModuleScope = () => activeBuiltinScope != null && activeBuiltinScope.parent == null
// The nearest declaration of `name` from the active scope is a class.
const declaredClass = (name) => {
  for (let s = activeBuiltinScope; s; s = s.parent) if (s.names.has(name)) return s.classes.has(name)
  return false
}
// `new` of a callee that is no constructor: a function literal of such a form,
// a name whose nearest declaration binds one, or an object literal's member of
// one, where nothing in the module assigns the name or writes the member.
// A binding's value (`const M = o.m`, `let B = A.bind(null)`, `const c = new
// C()`), which nothing reassigns, resolves from that declaration's scope
// (`from`); a bound function is a constructor only of a constructor
// (ECMA-262 10.4.1.3 BoundFunctionCreate).
const declaredNonCtor = (callee, from = activeBuiltinScope, depth = 0) => {
  while (Array.isArray(callee) && callee[0] === '()' && callee.length === 2) callee = callee[1]
  if (callableNonCtor(callee)) return true
  if (depth > 8 || !Array.isArray(callee) && typeof callee !== 'string') return false
  if (callee[0] === '()') return Array.isArray(callee[1]) && callee[1][0] === '.' && callee[1][2] === 'bind' && declaredNonCtor(callee[1][1], from, depth + 1)
  const member = Array.isArray(callee) && callee[0] === '.' && typeof callee[1] === 'string' && typeof callee[2] === 'string'
  const name = member ? callee[1] : callee
  if (typeof name !== 'string' || census.names.has(name) || member && census.props.has(callee[2])) return false
  for (let s = from; s; s = s.parent) if (s.names.has(name)) {
    const value = s.inits.get(name)
    if (!member) return s.nonCtors.has(name) || value !== undefined && declaredNonCtor(value, s, depth + 1)
    if (s.nonCtorMembers.get(name)?.has(callee[2])) return true
    // an instance of a class whose constructor returns no other object
    const made = Array.isArray(value) && value[0] === 'new' ? (Array.isArray(value[1]) && value[1][0] === '()' ? value[1][1] : value[1]) : null
    if (typeof made !== 'string' || census.names.has(made)) return false
    for (let c = s; c; c = c.parent) if (c.names.has(made)) return c.protoNonCtors.get(made)?.has(callee[2]) === true
    return false
  }
  return false
}
// The nearest declaration of `name` binds an ordinary function (a declaration,
// a `function` expression), which nothing in the module reassigns: `new` of
// one calls it, so jz models none of its instances.
const declaredFunction = (name) => {
  if (census.names.has(name)) return false
  for (let s = activeBuiltinScope; s; s = s.parent) if (s.names.has(name)) {
    if (s.fns.has(name)) return true
    const value = s.inits.get(name)
    return Array.isArray(value) && value[0] === 'function' && value[1] !== null
  }
  return false
}
// The nearest declaration of `name` binds a value (`var OBJECT = Object`, a
// parameter): its spelling names no constructor.
const declaredValue = (name) => {
  for (let s = activeBuiltinScope; s; s = s.parent) if (s.names.has(name)) return s.values.has(name) && !s.classes.has(name)
  return false
}
// Whether `n`, read in scope `from`, is a value the program makes: a class, a
// function, an import, a builtin the target resolves (`Function`, `Map`), a
// const holding one, or one chosen among them (`const K = cond ? A : B`). A
// parameter, a variable or a host global may hold the host's.
const programCallable = (n, from = activeBuiltinScope, depth = 0) => {
  while (Array.isArray(n) && n[0] === '()' && n.length === 2) n = n[1]
  if (depth > 8) return false
  if (typeof n === 'string') {
    for (let s = from; s; s = s.parent) if (s.names.has(n)) {
      if (!s.values.has(n) || s.classes.has(n)) return true
      return s.consts.has(n) && programCallable(s.consts.get(n), s, depth + 1)
    }
    return !hostGlobalName(n) && !HOST_GLOBALS.has(n)
  }
  if (!Array.isArray(n)) return false
  if (n[0] === '?' || n[0] === '?:') return programCallable(n[2], from, depth + 1) && programCallable(n[3], from, depth + 1)
  if (n[0] === '||' || n[0] === '??' || n[0] === '&&') return programCallable(n[1], from, depth + 1) && programCallable(n[2], from, depth + 1)
  const lit = n[0] === 'async' && Array.isArray(n[1]) ? n[1][0] : n[0]
  return lit === '=>' || lit === 'function' || lit === 'function*' || lit === 'class'
}
// A node's builtin scope is entered around its own rewrite and left after
// it: a pair, not a wrapper taking a closure, so a walk allocates nothing
// per node (the self-compile makes a closure record for each).
const enterBuiltinScope = (node) => { const prior = activeBuiltinScope; activeBuiltinScope = builtinScopes.get(node) || prior; return prior }
const leaveBuiltinScope = (prior) => { activeBuiltinScope = prior }
// Named function expressions own an immutable self binding. Declarations and
// parameters in nearer scopes shadow it, including inside nested closures.
const functionNameWrite = name => {
  for (let s = activeBuiltinScope; s; s = s.parent)
    if (s.names.has(name)) return s.self === name ? !!activeBuiltinScope.strict : undefined
}

// Build the lexical scope chain before rewriting. A program-wide name census
// made a parameter in one function suppress unrelated builtin lowering in
// every other function. The builder scopes nodes into `map`.
const scopeBuilder = (map) => {
  const childScope = parent => ({ parent, names: new Set(), values: new Set(), classes: new Set(), fns: new Set(), consts: new Map(), inits: new Map(), nonCtors: new Set(), nonCtorMembers: new Map(), protoNonCtors: new Map(), strict: parent?.strict ?? false, self: null })
  const functionDecls = new WeakSet()
  const strictBody = body => {
    if (Array.isArray(body) && body[0] === '{}') body = body[1]
    const list = Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]
    for (const n of list) {
      if (!Array.isArray(n) || n[0] != null || typeof n[1] !== 'string') break
      if (n[1] === 'use strict') return true
    }
    return false
  }
  const declarations = (node, scope) => {
    const list = Array.isArray(node) && node[0] === ';' ? node.slice(1) : [node]
    for (let stmt of list) {
      if (!Array.isArray(stmt)) continue
      if (stmt[0] === 'export') stmt = stmt[1]
      // `export default class C {}` / `function f() {}` declares its name as well
      if (Array.isArray(stmt) && stmt[0] === 'default') stmt = stmt[1]
      if (!Array.isArray(stmt)) continue
      const op = stmt[0]
      if (op === 'let' || op === 'const' || op === 'var' || op === 'using' || op === 'await using') {
        for (let i = 1; i < stmt.length; i++) {
          const d = stmt[i]
          addDeclarator(scope, d)
          // a class expression's binding names a class too (`const C = class {}`)
          if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && Array.isArray(d[2]) && d[2][0] === 'class') scope.classes.add(d[1])
          // a const's value, which `programCallable` reads
          if (op === 'const' && Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') scope.consts.set(d[1], d[2])
        }
      } else if ((op === 'function' || op === 'function*' || op === 'class') && typeof stmt[1] === 'string') {
        addBuiltinName(scope, stmt[1])
        if (op === 'class') { scope.classes.add(stmt[1]); addClassMembers(scope, stmt[1], stmt[3]) }
        if (op === 'function*') scope.nonCtors.add(stmt[1])
        if (op === 'function') scope.fns.add(stmt[1])
        functionDecls.add(stmt)
      } else if (op === 'async' && Array.isArray(stmt[1]) &&
          (stmt[1][0] === 'function' || stmt[1][0] === 'function*')) {
        addBuiltinName(scope, stmt[1][1])
        scope.nonCtors.add(stmt[1][1])
        functionDecls.add(stmt[1])
      } else if (op === 'import' || op === 'from' ||
          op === ',' && Array.isArray(stmt[1]) && stmt[1][0] === 'import') addImportBindings(scope, stmt)
    }
  }
  const vars = (node, scope) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'function' || op === 'function*' || op === '=>') return
    if (op === 'var') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        addPatternNames(scope, Array.isArray(d) && d[0] === '=' ? d[1] : d)
      }
    }
    for (let i = 1; i < node.length; i++) vars(node[i], scope)
  }
  const visit = (node, scope, reuseSequence = false) => {
    if (!Array.isArray(node)) return
    let here = scope
    const op = node[0]
    if (op === 'function' || op === 'function*' || op === '=>') {
      const name = op === '=>' ? null : node[1]
      const params = op === '=>' ? node[1] : node[2]
      const body = op === '=>' ? node[2] : node[3]
      let outer = scope
      if (name && !functionDecls.has(node)) {
        outer = childScope(scope)
        outer.self = name
        addBuiltinName(outer, name)
      }
      const fn = childScope(outer)
      fn.strict ||= strictBody(body)
      for (const param of extractParams(params)) addPatternNames(fn, param)
      const local = childScope(fn)
      declarations(body, local)
      vars(body, local)
      if (Array.isArray(params)) map.set(params, fn)
      if (Array.isArray(body)) map.set(body, local)
      visit(params, fn, true)
      visit(body, local, true)
      return
    }
    if (op === ';') {
      if (!reuseSequence) here = childScope(scope)
      declarations(node, here)
      map.set(node, here)
      for (let i = 1; i < node.length; i++) visit(node[i], here)
      return
    }
    if (op === '{}' && (isBlockBody(node) || JZ_BLOCK_OPS.has(node[1]?.[0]))) {
      if (!reuseSequence) here = childScope(scope)
      declarations(node[1], here)
      map.set(node, here)
      for (let i = 1; i < node.length; i++) visit(node[i], here, true)
      return
    }
    if (op === 'class') {
      here = childScope(scope)
      here.strict = true
    }
    if (op === 'catch') {
      here = childScope(scope)
      addPatternNames(here, node[1])
      declarations(node[2], here)
      map.set(node, here)
      visit(node[2], here, true)
      return
    }
    if (op === 'for' && Array.isArray(node[1])) {
      const head = node[1]
      const decl = head[0] === ';' ? head[1]
        : head[0] === 'of' || head[0] === 'in' ? head[1] : head
      if (Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const')) {
        here = childScope(scope)
        declarations(decl, here)
      }
    } else if (op === 'switch') {
      here = childScope(scope)
      for (let i = 2; i < node.length; i++) {
        const c = node[i]
        if (Array.isArray(c)) declarations(c[0] === 'case' ? c[2] : c[1], here)
      }
    }
    if (here !== scope) map.set(node, here)
    for (let i = 1; i < node.length; i++) visit(node[i], here)
  }
  return { childScope, strictBody, declarations, vars, visit }
}
const buildBuiltinScopes = root => {
  const map = new WeakMap(), { childScope, strictBody, declarations, vars, visit } = scopeBuilder(map)
  const program = childScope(null)
  program.strict = strictBody(root)
  declarations(root, program)
  vars(root, program)
  if (Array.isArray(root)) map.set(root, program)
  visit(root, program, true)
  return map
}
// A generator or async body lowers to a machine whose states share one scope:
// resolveLocals (jzify/generators.js) hoists each binding of its blocks there,
// spelled apart. Its states lower in that scope, a child of the function's
// own (the first of `owners` scoped) with every binding the machine hoists,
// the nodes the machine copied scoped under it (`copies`; a body not yet
// spelled apart declares its names as written, and scopes nothing).
const enterMachineScope = (owners, stmts, copies = true) => {
  const { childScope, declarations, vars, visit } = scopeBuilder(builtinScopes)
  let parent = activeBuiltinScope
  for (const n of owners) if (Array.isArray(n) && builtinScopes.has(n)) { parent = builtinScopes.get(n); break }
  const machine = childScope(parent)
  // every binding outside the body's nested functions: a list's or a block's
  // declarations, a declaration standing alone (a for head's), a catch's
  const hoist = (n) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === 'function' || op === 'function*' || op === '=>' || op === 'class') return
    if (op === ';') declarations(n, machine)
    else if (op === '{}' && (isBlockBody(n) || JZ_BLOCK_OPS.has(n[1]?.[0]))) declarations(n[1], machine)
    else if (op === 'let' || op === 'const' || op === 'using' || op === 'await using') declarations(n, machine)
    else if (op === 'catch') addPatternNames(machine, n[1])
    for (let i = 1; i < n.length; i++) hoist(n[i])
  }
  const list = [';', ...stmts]
  hoist(list)
  vars(list, machine)
  if (copies) for (const st of stmts) visit(st, machine)
  const prior = activeBuiltinScope
  activeBuiltinScope = machine
  return prior
}
const { lowerArguments, transformPattern, bindTransform } = createArgumentsLowering(names)

let lowerClass, lowerObjectLiteralThis, lowerObjectLiteralAccessors, classBrand, classStaticAccessor, resetClasses, transformSwitch
let transform, transformScope, transformParams

;({ transform, transformScope, transformParams } = createTransform({
  names,
  lowerArguments,
  transformPattern,
  normalizeCaseBody,
  transformSwitch: (...a) => transformSwitch(...a),
  lowerClass: () => lowerClass,
  classBrand: (name) => classBrand(name),
  classStaticAccessor: (name, slot) => classStaticAccessor(name, slot),
  isClass: declaredClass,
  ordinaryFunction: (name) => declaredFunction(name),
  isValue: declaredValue,
  programCallable: (name) => programCallable(name),
  nonConstructor: (callee) => declaredNonCtor(callee),
  assigned: (name) => census.names.has(name),
  lowerObjectLiteralThis: () => lowerObjectLiteralThis,
  lowerObjectLiteralAccessors: () => lowerObjectLiteralAccessors,
  shadowsBuiltin: shadowsJzifyBuiltin,
  isBound: (name) => scopeHasBuiltin(activeBuiltinScope, name),
  enterBuiltinScope, leaveBuiltinScope,
}))
bindTransform(transform)

const constStrings = new Map()
;({ lowerClass, lowerObjectLiteralThis, lowerObjectLiteralAccessors, classBrand, classStaticAccessor, resetClasses } = createClassLowering({ transform, names, JC, constStrings, atModuleScope, lowerArguments, shadowsBuiltin: shadowsJzifyBuiltin, classBindingScope, readsConstructor: () => ctorUse.on, inherits: (name) => inherits(name), storedOn: (name) => census.receivers.has(name) }))
const generatorNames = new Set()
// the ones whose return() runs code (closesOnReturn): loops over them close
const generatorCloses = new Set()
// A call of `name` calls the module's generator declaration: no nearer scope
// binds the name, and nothing in the module assigns it another value.
const isGenerator = (name) => generatorNames.has(name) && !classBindingScope(name)?.parent && !census.names.has(name)
// Program mints iterator objects (generators anywhere, hand-rolled `next()`
// members, `[Symbol.iterator]` methods) — gates the for-of protocol fork so
// programs without iterator producers compile byte-identically.
// Iterator producers gate the protocol lowerings (a for-of that probes for a
// provider, decorated iterators). `program` spans the compile's whole graph
// (`witness`): a module iterates what another one mints. `std` marks the
// compiler's own `jz:` modules, whose member calls the iterator rewrite leaves.
const iterProto = { on: false, helpers: false, program: false, programHelpers: false, std: false }
// Whether the program reads a `constructor` member (`new this.constructor(…)`,
// `a.constructor === C`): its classes then carry the member (classes.js).
const ctorUse = { on: false, program: false }
// The classes the program derives (`class B extends A`, in any module), by
// the name the heritage spells: their statics that read the receiver are
// functions of it, each derived class calling them with itself (classes.js).
// A heritage naming anything but a class its scope declares (an import, a
// variable, an expression) may be any class; one naming a global (`Error`,
// `Map`) is none of the program's.
const heritage = { names: new Set(), any: false }, programHeritage = { names: new Set(), any: false }
const inherits = (name) => heritage.any || heritage.names.has(name)
const genErr = (msg) => err('jzify: ' + msg)
// What the module assigns and the program writes by key (async.js
// assignCensus): a suspension's hoisting reads what another activation may
// change first. The program's keys come from every module the witness reads.
let census = { names: new Map(), props: new Set(), receivers: new Set() }, programProps = new Set(), witnessed = new WeakSet()
const { lowerAsync, lowerAsyncGen, hoistSuspensions, hoistExpr, enterBody, leaveBody } = createAsyncLowering({ genTemp: (t) => names.genTemp(t), err: genErr, censusOf: () => census })
const { lowerGenerator, desugarForOfGenerator, desugarForOfProtocol, unwindChain, fuseTerminal, fusedLoop, bindTo, isTerminal } = createGeneratorLowering({ transform, transformParams, err: genErr, isGenerator, generatorCloses, genTemp: (t) => names.genTemp(t), iterProto, lowerArguments, hoistSuspensions, hoistExpr, enterBody, leaveBody, enterMachineScope, leaveBuiltinScope })
bindGenerators({ lowerGenerator, desugarForOfGenerator, desugarForOfProtocol, lowerAsync, lowerAsyncGen, isGenerator, iterProto, unwindChain, fuseTerminal, fusedLoop, bindTo, isTerminal })
transformSwitch = createSwitchLowering(transform, names)


const WELL_KNOWN = new Map([['iterator', '@@iterator'], ['dispose', '@@dispose'], ['asyncDispose', '@@asyncDispose'], ['asyncIterator', '@@asyncIterator']])
const symbolProp = n => Array.isArray(n) && n[0] === '.' && n[1] === 'Symbol' && WELL_KNOWN.get(n[2])
// Iterator-helper method names (ES2025) — a CALL of one of these on any
// receiver, in a program that mints iterators, gates decorated generator
// objects (__it_mk). Fusable chains still fuse; this covers value positions.
const ITER_HELPER_NAMES = new Set(['map', 'filter', 'take', 'drop', 'flatMap',
  'toArray', 'reduce', 'forEach', 'some', 'every', 'find'])
// Entry walk, two jobs in one pass:
// 1. Canonicalize well-known-symbol shapes to reserved literal props. A
//    fixed-shape object has no symbol slots, so `[Symbol.iterator]` becomes
//    the '@@iterator' prop in BOTH key position (computed member/method) and
//    access position (`x[Symbol.iterator]`).
// 2. Detect iterator producers for the protocol-fork gate, and helper-method
//    use / `instanceof Iterator` for the decorated-iterator gate.
function canonSymbols(node, bindings = false) {
  if (!Array.isArray(node)) return node
  const prior = enterBuiltinScope(node)
  try {
    const [op] = node
    if (op === 'function*') iterProto.on = true
    if (op === ':' && (node[1] === 'next' || node[1] === '@@iterator') &&
        Array.isArray(node[2]) && (node[2][0] === '=>' || node[2][0] === 'function' || node[2][0] === 'function*'))
      iterProto.on = true
    if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' && ITER_HELPER_NAMES.has(node[1][2]))
      iterProto.helpers = true
    if (op === 'instanceof' && node[2] === 'Iterator' && !shadowsJzifyBuiltin('Iterator')) iterProto.helpers = true
    if ((op === '.' || op === '?.') && node[2] === 'constructor') ctorUse.on = true
    if (op === 'class' && node[2] != null) {
      if (typeof node[2] !== 'string') heritage.any = true
      else if (declaredClass(node[2])) heritage.names.add(node[2])
      else if (classBindingScope(node[2])) heritage.any = true
    }
    // a well-known symbol is a reserved prop with no slot to assign: the
    // polyfill `Symbol.dispose ||= Symbol('dispose')` is a no-op statement
    if (!shadowsJzifyBuiltin('Symbol') && (op === '||=' || op === '??=' || op === '=') &&
        symbolProp(node[1])) { node.splice(0, node.length, null); return node }
    // Computed data, method and accessor keys share the same symbol name.
    if (!shadowsJzifyBuiltin('Symbol') && (op === ':' || op === 'get' || op === 'set') && Array.isArray(node[1]) && node[1][0] === '[]' && node[1].length === 2) {
      const prop = symbolProp(node[1][1])
      if (prop) { node[1] = prop; if (prop === '@@iterator') iterProto.on = true }
    }
    // access: ['[]', obj, Symbol.X] → ['.', obj, '@@X']
    if (!shadowsJzifyBuiltin('Symbol') && op === '[]' && node.length === 3) {
      const prop = symbolProp(node[2])
      if (prop) { node[0] = '.'; node[2] = prop; if (prop === '@@iterator') iterProto.on = true }
    }
    // membership: ['in', Symbol.X, obj] → ['in', '@@X', obj]
    if (!shadowsJzifyBuiltin('Symbol') && op === 'in' && node.length === 3) {
      const prop = symbolProp(node[1])
      if (prop) node[1] = [, prop]
    }
    for (let i = 1; i < node.length; i++) canonSymbols(node[i], bindings)
    // Do this before lowerings copy function bodies: the source scope census
    // owns immutable self bindings, including those in async/generator bodies.
    if (bindings && MUTATE_OPS.has(op) && typeof node[1] === 'string') {
      const strict = functionNameWrite(node[1])
      if (strict !== undefined) {
        const temp = names.genTemp('self'), value = node.slice()
        value[1] = temp
        const reject = ['throw', ['new', ['()', 'TypeError', [null, 'Assignment to an immutable function name']]]]
        let result = ['return', value]
        if (strict) {
          const logical = op === '&&=' || op === '||=' || op === '??='
          result = logical
            ? ['return', [op.slice(0, -1), temp, ['()', ['=>', null, ['{}', [';', value, reject]]], null]]]
            : [';', value, reject]
        }
        node.splice(0, node.length, '()', ['=>', null, ['{}', [';',
          ['let', ['=', temp, node[1]]], result,
        ]]], null)
      }
    }
    return node
  } finally { leaveBuiltinScope(prior) }
}

// A typed-array constructor named as a value (`{ Float32Array }`, an argument,
// `=== Float32Array`) is the function `jz:typed` makes of it. `new`,
// `instanceof` and a static member name the constructor itself, where the
// compiler resolves it; `Float32Array.BYTES_PER_ELEMENT` is its number.
// `E.constructor` asks `__ctor` of the same module, which answers a typed
// array's function and reads any other value's member; `this.constructor` is
// the member a class's instance carries (classes.js).
function typedCtorValues(node) {
  if (!Array.isArray(node) || node[0] == null || node[0] === 'str') return node
  const prior = enterBuiltinScope(node)
  try {
    const op = node[0]
    const named = (n) => typeof n === 'string' && TYPED_CTORS.has(n) && !scopeHasBuiltin(activeBuiltinScope, n)
    if (op === '.' && named(node[1]) && node[2] === 'BYTES_PER_ELEMENT') { node.splice(0, node.length, null, TYPED_BYTES[node[1]]); return node }
    // a shorthand property `{ Float32Array }` keeps its name
    if (op === '{}' || op === ',') for (let i = 1; i < node.length; i++) if (op === '{}' ? named(node[i]) : node.shorthand && named(node[i])) node[i] = [':', node[i], '__' + node[i]]
    if (op === '{}' && Array.isArray(node[1]) && node[1][0] === ',') node[1].shorthand = true
    const target = MUTATE_OPS.has(op) || op === 'delete'
    // `x.constructor === Object` is a shape test the bundler folds (bundler.js), not a read of the constructor
    const compared = (op === '===' || op === '!==' || op === '==' || op === '!=') && (node[1] === 'Object' || node[2] === 'Object' || node[1] === 'Array' || node[2] === 'Array' || node[1] === 'Function' || node[2] === 'Function')
    for (let i = 1; i < node.length; i++) {
      const c = node[i]
      if (typeof c === 'string') {
        if (named(c) && !(op === 'new' || op === 'instanceof' && i === 2 || op === '.' || op === '?.' || op === '()' && i === 1 || op === ':' && i === 1)) node[i] = '__' + c
        continue
      }
      typedCtorValues(c)
      if (Array.isArray(c) && c[0] === '.' && c[2] === 'constructor' && c[1] !== 'this' && c[1] !== 'super' && !(target && i === 1) && !compared)
        node[i] = ['()', '__ctor', c[1]]
    }
    return node
  } finally { leaveBuiltinScope(prior) }
}

// `import('x')` with a literal specifier: 'x' joins the compile-time graph (the
// resolver bundles it too, src/resolve.js dynImportRe) under a namespace import
// hoisted to the module's top. Awaited at module level it is a static import
// in all but syntax (top-level await is otherwise unsupported): the namespace
// reads in place, `(await import('m')).default` → `__dynN.default`, and a `try`
// around the optional load stays around a plain assignment. Anywhere else the
// import is lazy and the call is the promise of the namespace object, read in
// a job: a module only such imports reach evaluates at the first read
// (prepare/module-eval.js). A computed specifier stays a reject (transform.js).
const isImportCall = (n) => Array.isArray(n) && n[0] === '()' && n[1] === 'import' && Array.isArray(n[2]) && n[2][0] == null && typeof n[2][1] === 'string'
const isAwaitedImport = (n) => Array.isArray(n) && n[0] === 'await' && isImportCall(n[1])
function hoistDynamicImports(ast) {
  if (!Array.isArray(ast)) return ast
  const hoisted = [], lazy = new Map()
  const hoist = (spec, at, flag) => {
    const ns = names.genTemp('dyn'), st = ['import', ['from', ['as', '*', ns], [null, spec]], ...flag]
    if (at.loc != null) st.loc = at.loc
    hoisted.push(st)
    return ns
  }
  const walk = (n, top) => {
    if (!Array.isArray(n)) return n
    if (n[0] === '=>' || n[0] === 'function' || n[0] === 'function*' || n[0] === 'class' || n[0] === 'async') top = false
    const dyn = !top ? null : isAwaitedImport(n) ? n : n[0] === '()' && n.length === 2 && isAwaitedImport(n[1]) ? n[1] : null   // `(await import('x'))`
    if (dyn) return hoist(dyn[1][2][1], dyn[1], [])
    if (isImportCall(n)) {
      const spec = n[2][1]
      if (!lazy.has(spec)) lazy.set(spec, hoist(spec, n, ['lazy']))
      return ['()', ['.', ['()', ['.', 'Promise', 'resolve'], null], 'then'], ['=>', ['()', null], lazy.get(spec)]]
    }
    for (let i = 1; i < n.length; i++) n[i] = walk(n[i], top)
    return n
  }
  const out = walk(ast, true)
  if (!hoisted.length) return ast
  const stmts = Array.isArray(out) && out[0] === ';' ? out.slice(1) : [out]
  return [';', ...hoisted, ...stmts]
}
/** The literal specifiers of the module's `import()` calls, awaited at its top or not. */
const dynamicImportsOf = (ast) => {
  const out = []
  const walk = (n) => { if (!Array.isArray(n)) return; if (isImportCall(n)) out.push(n[2][1]); for (let i = 1; i < n.length; i++) walk(n[i]) }
  walk(ast)
  return out
}

// The module's imports in source order, each specifier with the local names
// it binds (`import D from`, `import { a, b as c } from`; a namespace or bare
// import binds none): the class lowering resolves a base class or an
// `instanceof` operand imported from another module through them.
function importsOf(ast) {
  const stmts = Array.isArray(ast) && ast[0] === ';' ? ast.slice(1) : [ast]
  const list = []
  const add = (spec, src, names = new Map()) => {
    if (!Array.isArray(src) || src[0] != null || typeof src[1] !== 'string') return
    if (typeof spec === 'string') names.set(spec, 'default')
    else if (Array.isArray(spec) && spec[0] === '{}')
      for (const it of (Array.isArray(spec[1]) && spec[1][0] === ',' ? spec[1].slice(1) : [spec[1]]))
        if (typeof it === 'string') names.set(it, it); else if (Array.isArray(it) && it[0] === 'as') names.set(it[2], it[1])
    list.push({ spec: src[1], names })
  }
  for (const st of stmts) {
    if (!Array.isArray(st)) continue
    if (st[0] === 'import') { if (Array.isArray(st[1]) && st[1][0] === 'from') add(st[1][1], st[1][2]); else add(null, st[1]) }
    else if (st[0] === ',' && st.length === 3 && Array.isArray(st[1]) && st[1][0] === 'import' && typeof st[1][1] === 'string' && Array.isArray(st[2]) && st[2][0] === 'from')
      add(st[2][1], st[2][2], new Map([[st[1][1], 'default']]))
  }
  return list
}

// A module referencing a standard-module global (`Event`, `EventTarget`) it
// does not declare at top level gets the import implicitly:
// `import { Event, EventTarget } from 'jz:events'` (src/std). The bundler
// prepares a specifier once, so every module shares one class identity.
function implicitStdImports(ast) {
  if (!Array.isArray(ast)) return ast
  const stmts = ast[0] === ';' ? ast.slice(1) : [ast]
  const declared = new Set()
  const bindImport = (spec) => {
    if (typeof spec === 'string') declared.add(spec)
    else if (Array.isArray(spec) && spec[0] === 'as') declared.add(spec[2])
    else if (Array.isArray(spec) && spec[0] === '{}')
      for (const it of (Array.isArray(spec[1]) && spec[1][0] === ',' ? spec[1].slice(1) : [spec[1]]))
        if (typeof it === 'string') declared.add(it); else if (Array.isArray(it) && it[0] === 'as') declared.add(it[2])
  }
  const declare = (st) => {
    if (!Array.isArray(st)) return
    if (st[0] === 'export' || st[0] === 'default' || st[0] === 'async') return declare(st[1])
    if (st[0] === 'import' && Array.isArray(st[1]) && st[1][0] === 'from') return bindImport(st[1][1])
    if ((st[0] === 'class' || st[0] === 'function' || st[0] === 'function*') && typeof st[1] === 'string') declared.add(st[1])
    if (st[0] === 'const' || st[0] === 'let' || st[0] === 'var')
      for (let i = 1; i < st.length; i++) { const d = st[i]; if (typeof d === 'string') declared.add(d); else if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') declared.add(d[1]) }
  }
  for (const st of stmts) declare(st)
  const used = new Set()
  const ref = (n) => { if (STD_GLOBALS[n] && !declared.has(n)) used.add(n) }
  // `globalThis.Event` is the same global (feature probes: `globalThis.DOMException || Error`)
  const viaGlobalThis = (n) => Array.isArray(n) && (n[0] === '.' || n[0] === '?.') && n[1] === 'globalThis'
    && typeof n[2] === 'string' && STD_GLOBALS[n[2]] && !declared.has(n[2]) && !declared.has('globalThis')
  const walk = (n) => {
    if (typeof n === 'string') return ref(n)
    if (!Array.isArray(n) || n[0] === 'str' || n[0] == null) return
    // property names are literal keys: `o.Event`, `{ Event: v }`, `import { Event as E }`
    if (n[0] === '.' || n[0] === '?.') return walk(n[1])
    if (n[0] === ':') return walk(n[2])
    for (let i = 1; i < n.length; i++) {
      if (viaGlobalThis(n[i])) n[i] = n[i][2]
      walk(n[i])
    }
  }
  walk(ast)
  if (!used.size) return ast
  const byModule = new Map()
  for (const nm of used) { const mod = STD_GLOBALS[nm]; (byModule.get(mod) ?? byModule.set(mod, []).get(mod)).push(nm) }
  const imports = [...byModule].map(([mod, names]) => ['import', ['from', ['{}', names.length === 1 ? names[0] : [',', ...names]], [null, mod]]])
  return [';', ...imports, ...stmts]
}

/**
 * Transform AST in-place. Returns transformed AST.
 * @param {Array} ast - subscript/jessie parsed AST
 * @param {object} [opts]
 * @param {boolean} [opts.structs=true] - lower a module-scope class to a schema
 *   and functions of the receiver (jzify/classes.js lowerStruct). The dispatch
 *   is the compiler's (its class registry), so source that must stand alone
 *   (the source-level lowering) keeps every class as per-instance closures.
 * @returns {Array} Transformed AST
 */
// An `await using` declaration (parsed `['await', ['using', …]]`) is a
// resource declaration of its own, `['await using', …]` (jzify/using.js).
// `for (using x of src) body` takes each value in a constant of its own and
// declares the resource in the iteration's block, `for (const t of src)
// { using x = t; body }`, which the using lowering disposes as each
// iteration leaves (a for await's, and an `await using`'s, too).
const awaitUsing = (n) => Array.isArray(n) && n[0] === 'await' && Array.isArray(n[1]) && n[1][0] === 'using' ? withLoc(['await using', ...n[1].slice(1)], n) : n
const forUsing = (n) => {
  if (!Array.isArray(n) || n[0] == null) return n
  let out = awaitUsing(n)
  for (let i = 1; i < out.length; i++) {
    const c = forUsing(out[i])
    if (c !== out[i]) { if (out === n) out = withLoc(n.slice(), n); out[i] = c }
  }
  const lhs = out[0] === 'for' || out[0] === 'for await' ? Array.isArray(out[1]) && out[1][0] === 'of' && out[1][1] : null
  if (!isResourceDecl(lhs)) return out
  const t = names.genTemp('us')
  return withLoc([out[0], ['of', ['const', t], out[1][2]], ['{}', [';', withLoc([lhs[0], ['=', lhs[1], t]], out[1]), ...(out[2] == null ? [] : [out[2]])]]], n)
}

export default function jzify(ast, { structs = true, importedBinding = null, std = false } = {}) {
  const entry = ast
  names.reset()
  ast = forUsing(ast)
  activeBuiltinScope = null
  builtinScopes = buildBuiltinScopes(ast)
  // Module-scope `const K = 'str'` bindings — lets class lowering fold computed
  // member names `[K]() {}` (const guarantees the binding never changes).
  constStrings.clear()
  generatorNames.clear()
  generatorCloses.clear()
  iterProto.on = iterProto.program
  iterProto.helpers = iterProto.programHelpers
  iterProto.std = std
  ctorUse.on = ctorUse.program
  heritage.names = new Set(programHeritage.names); heritage.any = programHeritage.any
  ast = canonSymbols(ast, true)
  if (!std) ast = typedCtorValues(ast)
  ast = hoistDynamicImports(ast)
  ast = implicitStdImports(ast)
  resetClasses(structs, importedBinding ? { list: importsOf(ast), importedBinding } : null)
  if (Array.isArray(ast)) {
    const stmts = ast[0] === ';' ? ast.slice(1) : [ast]
    for (const st of stmts) {
      const gen = Array.isArray(st) && st[0] === 'export' ? st[1] : st
      if (Array.isArray(gen) && gen[0] === 'function*' && typeof gen[1] === 'string' && gen[1]) {
        generatorNames.add(gen[1])
        if (closesOnReturn(gen[3])) generatorCloses.add(gen[1])
      }
      if (!Array.isArray(st) || st[0] !== 'const') continue
      for (let i = 1; i < st.length; i++) {
        const d = st[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' &&
            Array.isArray(d[2]) && d[2][0] == null && typeof d[2][1] === 'string')
          constStrings.set(d[1], d[2][1])
      }
    }
  }
  const hoisted = new Set()
  ast = settleVars(ast)
  ast = hoistVars(ast, hoisted)
  if (hoisted.size) ast = prependDecls(ast, hoisted)
  if (Array.isArray(ast) && ast[0] === ';') ast = [';', ...foldPseudoClassical(ast.slice(1))]
  if (Array.isArray(ast)) { const stmts = foldPrototypeStores(ast[0] === ';' ? ast.slice(1) : [ast]); ast = stmts.length === 1 ? stmts[0] : [';', ...stmts] }
  builtinScopes = buildBuiltinScopes(ast)
  census = assignCensus(ast, true)
  if (witnessed.has(entry)) for (const key of programProps) census.props.add(key)
  let out = transformScope(ast)
  // The lowerings reference runtime helpers (`__p_new`, `__it_drain`,
  // `__usp_new`) as free names: each resolves to its std module through the
  // same implicit import as a user-visible global. A sync program references
  // none and compiles byte-identically.
  out = implicitStdImports(out)
  return foldStaticBundlerHelpers(foldStaticExportHelpers(canonicalizeObjectIdioms(out)))
}
/** The module's imports before it is transformed (the implicit standard ones
 *  included): prepare brings each bundled one in, in this order, ahead of the
 *  module's own lowering, so a class extending an imported class finds its
 *  base lowered without the lowering re-entering itself. */
jzify.imports = (ast) => importsOf(implicitStdImports(ast))
/** The specifiers the module's `import()` calls name: modules of the graph
 *  that only a lazy namespace import reaches (prepare/module-eval.js). */
jzify.dynamicImports = dynamicImportsOf
// Prepare resolves namespace aliases after this same graph-wide witness.
jzify.iteratorProtocol = () => iterProto.program
/** The program's iterator producers, read off every module's parsed AST
 *  before any is lowered: each module then lowers for-of and spreads under
 *  the graph's producers, not its own. Resets the witness per compile. */
jzify.witness = (asts) => {
  // an empty module's tree is no object: nothing to witness
  witnessed = new WeakSet(asts.filter(ast => ast !== null && typeof ast === 'object'))
  programProps = new Set()
  for (const ast of asts) assignCensus(ast, true, new Map(), programProps)
  iterProto.program = false
  iterProto.programHelpers = false
  ctorUse.program = false
  programHeritage.names = new Set(); programHeritage.any = false
  for (const ast of asts) {
    activeBuiltinScope = null
    builtinScopes = buildBuiltinScopes(ast)
    iterProto.on = false
    iterProto.helpers = false
    ctorUse.on = false
    heritage.names = programHeritage.names; heritage.any = false
    canonSymbols(ast)
    iterProto.program ||= iterProto.on
    iterProto.programHelpers ||= iterProto.helpers
    ctorUse.program ||= ctorUse.on
    programHeritage.any ||= heritage.any
  }
}
