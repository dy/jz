/**
 * jzify — Transform JS AST into jz-compatible form.
 *
 * Crockford-aligned: eliminates bad parts, enforces good practices.
 * Runs before prepare() as an AST→AST pass.
 *
 * @module jzify
 */

import { JZIFY_CLASS_ERRORS as JC } from '../src/op-policy.js'
import { parse } from '../src/parse.js'
import { createAsyncLowering } from './async.js'
import { STD_GLOBALS } from '../src/std/index.js'
import { createNames } from './names.js'
import { foldStaticExportHelpers, foldStaticBundlerHelpers, canonicalizeObjectIdioms } from './bundler.js'
import { createSwitchLowering, normalizeCaseBody } from './switch.js'
import { createClassLowering, foldPseudoClassical } from './classes.js'
import { hoistVars, prependDecls } from './hoist-vars.js'
import { createArgumentsLowering } from './arguments.js'
import { createTransform, bindGenerators } from './transform.js'
import { createGeneratorLowering } from './generators.js'
import { lowerIteratorParams } from './iterator-params.js'
import { collectParamNames, extractParams, isBlockBody, JZ_BLOCK_OPS } from '../src/ast.js'

const names = createNames()
const SHADOW_SENSITIVE = new Set([
  'Array', 'SharedArrayBuffer', 'URLSearchParams', 'Promise', 'queueMicrotask',
  'Function', 'Iterator', 'Symbol',
])
let builtinScopes = new WeakMap()
let activeBuiltinScope = null
// Every declared name: the shadow test filters by SHADOW_SENSITIVE, the
// class lowering asks whether a name is the module's own (declaredAtModuleScope).
const addBuiltinName = (scope, name) => {
  if (typeof name === 'string') scope.names.add(name)
}
const addPatternNames = (scope, pattern) => {
  const bound = collectParamNames([pattern])
  for (const name of bound) addBuiltinName(scope, name)
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
// The nearest declaration of `name` from the active scope is the module's own.
const atModuleScope = () => activeBuiltinScope != null && activeBuiltinScope.parent == null
const declaredAtModuleScope = (name) => {
  for (let s = activeBuiltinScope; s; s = s.parent) if (s.names.has(name)) return s.parent == null
  return false
}
// A node's builtin scope is entered around its own rewrite and left after
// it: a pair, not a wrapper taking a closure, so a walk allocates nothing
// per node (the self-compile makes a closure record for each).
const enterBuiltinScope = (node) => { const prior = activeBuiltinScope; activeBuiltinScope = builtinScopes.get(node) || prior; return prior }
const leaveBuiltinScope = (prior) => { activeBuiltinScope = prior }

// Build the lexical scope chain before rewriting. A program-wide name census
// made a parameter in one function suppress unrelated builtin lowering in
// every other function.
const buildBuiltinScopes = root => {
  const map = new WeakMap()
  const childScope = parent => ({ parent, names: new Set() })
  const declarations = (node, scope) => {
    const list = Array.isArray(node) && node[0] === ';' ? node.slice(1) : [node]
    for (let stmt of list) {
      if (!Array.isArray(stmt)) continue
      if (stmt[0] === 'export') stmt = stmt[1]
      if (!Array.isArray(stmt)) continue
      const op = stmt[0]
      if (op === 'let' || op === 'const' || op === 'var' || op === 'using') {
        for (let i = 1; i < stmt.length; i++) {
          const d = stmt[i]
          addPatternNames(scope, Array.isArray(d) && d[0] === '=' ? d[1] : d)
        }
      } else if ((op === 'function' || op === 'function*' || op === 'class') && typeof stmt[1] === 'string') {
        addBuiltinName(scope, stmt[1])
      } else if (op === 'async' && Array.isArray(stmt[1]) &&
          (stmt[1][0] === 'function' || stmt[1][0] === 'function*')) {
        addBuiltinName(scope, stmt[1][1])
      } else if (op === 'import' || op === 'from') addImportBindings(scope, stmt)
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
      const fn = childScope(scope)
      const name = op === '=>' ? null : node[1]
      const params = op === '=>' ? node[1] : node[2]
      const body = op === '=>' ? node[2] : node[3]
      addBuiltinName(fn, name)
      for (const param of extractParams(params)) addPatternNames(fn, param)
      declarations(body, fn)
      vars(body, fn)
      if (Array.isArray(params)) map.set(params, fn)
      if (Array.isArray(body)) map.set(body, fn)
      visit(params, fn, true)
      visit(body, fn, true)
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
      here = childScope(scope)
      declarations(node[1], here)
      map.set(node, here)
      for (let i = 1; i < node.length; i++) visit(node[i], here, true)
      return
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
  const program = childScope(null)
  declarations(root, program)
  vars(root, program)
  if (Array.isArray(root)) map.set(root, program)
  visit(root, program, true)
  return map
}
const { lowerArguments, transformPattern, bindTransform } = createArgumentsLowering(names,
  params => iterProto.on ? lowerIteratorParams(params, names.genTemp) : [params, []])

let lowerClass, lowerObjectLiteralThis, lowerObjectLiteralAccessors, classBrand, classStaticAccessor, resetClasses, transformSwitch
let transform, transformScope

;({ transform, transformScope } = createTransform({
  names,
  lowerArguments,
  transformPattern,
  normalizeCaseBody,
  transformSwitch: (...a) => transformSwitch(...a),
  lowerClass: () => lowerClass,
  classBrand: (name) => declaredAtModuleScope(name) ? classBrand(name) : null,
  classStaticAccessor: (name, slot) => declaredAtModuleScope(name) && classStaticAccessor(name, slot),
  lowerObjectLiteralThis: () => lowerObjectLiteralThis,
  lowerObjectLiteralAccessors: () => lowerObjectLiteralAccessors,
  shadowsBuiltin: shadowsJzifyBuiltin,
  enterBuiltinScope, leaveBuiltinScope,
}))
bindTransform(transform)

const constStrings = new Map()
;({ lowerClass, lowerObjectLiteralThis, lowerObjectLiteralAccessors, classBrand, classStaticAccessor, resetClasses } = createClassLowering({ transform, names, JC, constStrings, atModuleScope }))
const generatorNames = new Set()
// Program mints iterator objects (generators anywhere, hand-rolled `next()`
// members, `[Symbol.iterator]` methods) — gates the for-of protocol fork so
// programs without iterator producers compile byte-identically.
const iterProto = { on: false }
const genErr = (msg) => { throw new Error('jzify: ' + msg) }
const { lowerGenerator, desugarForOfGenerator, desugarForOfProtocol, unwindChain, fuseTerminal, fusedLoop, isTerminal } = createGeneratorLowering({ transform, err: genErr, generatorNames, genTemp: (t) => names.genTemp(t), iterProto, lowerArguments })
const { lowerAsync, lowerAsyncGen } = createAsyncLowering({ genTemp: (t) => names.genTemp(t), err: genErr })
bindGenerators({ lowerGenerator, desugarForOfGenerator, desugarForOfProtocol, lowerAsync, lowerAsyncGen, generatorNames, iterProto, unwindChain, fuseTerminal, fusedLoop, isTerminal })
transformSwitch = createSwitchLowering(transform, names)


const isSymbolWellKnown = (n, which) => Array.isArray(n) && n[0] === '.' && n[1] === 'Symbol' && n[2] === which
const WELL_KNOWN = { iterator: '@@iterator', dispose: '@@dispose', asyncIterator: '@@asyncIterator' }
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
function canonSymbols(node) {
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
    // a well-known symbol is a reserved prop with no slot to assign: the
    // polyfill `Symbol.dispose ||= Symbol('dispose')` is a no-op statement
    if (!shadowsJzifyBuiltin('Symbol') && (op === '||=' || op === '??=' || op === '=') &&
        Object.keys(WELL_KNOWN).some(k => isSymbolWellKnown(node[1], k))) { node.splice(0, node.length, null); return node }
    // computed key: [':', ['[]', Symbol.X], value]
    if (!shadowsJzifyBuiltin('Symbol') && op === ':' && Array.isArray(node[1]) && node[1][0] === '[]' && node[1].length === 2) {
      for (const [k, prop] of Object.entries(WELL_KNOWN))
        if (isSymbolWellKnown(node[1][1], k)) { node[1] = prop; if (prop === '@@iterator') iterProto.on = true }
    }
    // access: ['[]', obj, Symbol.X] → ['.', obj, '@@X']
    if (!shadowsJzifyBuiltin('Symbol') && op === '[]' && node.length === 3) {
      for (const [k, prop] of Object.entries(WELL_KNOWN))
        if (isSymbolWellKnown(node[2], k)) { node[0] = '.'; node[2] = prop; if (prop === '@@iterator') iterProto.on = true }
    }
    for (let i = 1; i < node.length; i++) canonSymbols(node[i])
    return node
  } finally { leaveBuiltinScope(prior) }
}

// `await import('x')` at module level with a literal specifier is a static
// import in all but syntax: hoist `import * as __dynN from 'x'` and read the
// namespace in place (`(await import('m')).default` → `__dynN.default`); the
// resolver already bundles 'x' (src/resolve.js dynImportRe). A `try` around
// the optional load stays, now around a plain assignment. Nested function
// bodies are not touched: a real runtime import there stays a reject.
function hoistModuleDynamicImports(ast) {
  if (!Array.isArray(ast)) return ast
  const hoisted = []
  const isDyn = (n) => Array.isArray(n) && n[0] === 'await' && Array.isArray(n[1]) && n[1][0] === '()' && n[1][1] === 'import'
    && Array.isArray(n[1][2]) && n[1][2][0] == null && typeof n[1][2][1] === 'string'
  const walk = (n) => {
    if (!Array.isArray(n)) return n
    if (n[0] === '=>' || n[0] === 'function' || n[0] === 'function*' || n[0] === 'class' || n[0] === 'async') return n
    const dyn = isDyn(n) ? n : n[0] === '()' && n.length === 2 && isDyn(n[1]) ? n[1] : null   // `(await import('x'))`
    if (dyn) {
      const ns = `__dyn${hoisted.length}`
      hoisted.push(['import', ['from', ['as', '*', ns], [null, dyn[1][2][1]]]])
      return ns
    }
    return n.map((c, i) => i === 0 ? c : walk(c))
  }
  const out = walk(ast)
  if (!hoisted.length) return ast
  const stmts = Array.isArray(out) && out[0] === ';' ? out.slice(1) : [out]
  return [';', ...hoisted, ...stmts]
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
 *   (jz/transform) keeps every class as per-instance closures.
 * @returns {Array} Transformed AST
 */
export default function jzify(ast, { structs = true } = {}) {
  names.reset()
  resetClasses(structs)
  activeBuiltinScope = null
  builtinScopes = buildBuiltinScopes(ast)
  // Module-scope `const K = 'str'` bindings — lets class lowering fold computed
  // member names `[K]() {}` (const guarantees the binding never changes).
  constStrings.clear()
  generatorNames.clear()
  iterProto.on = false
  iterProto.helpers = false
  ast = canonSymbols(ast)
  ast = hoistModuleDynamicImports(ast)
  ast = implicitStdImports(ast)
  if (Array.isArray(ast)) {
    const stmts = ast[0] === ';' ? ast.slice(1) : [ast]
    for (const st of stmts) {
      if (Array.isArray(st) && st[0] === 'function*' && typeof st[1] === 'string' && st[1]) generatorNames.add(st[1])
      if (Array.isArray(st) && st[0] === 'export' && Array.isArray(st[1]) && st[1][0] === 'function*' && st[1][1]) generatorNames.add(st[1][1])
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
  ast = hoistVars(ast, hoisted)
  if (hoisted.size) ast = prependDecls(ast, hoisted)
  if (Array.isArray(ast) && ast[0] === ';') ast = [';', ...foldPseudoClassical(ast.slice(1))]
  builtinScopes = buildBuiltinScopes(ast)
  let out = transformScope(ast)
  // The lowerings reference runtime helpers (`__p_new`, `__it_drain`,
  // `__usp_new`) as free names: each resolves to its std module through the
  // same implicit import as a user-visible global. A sync program references
  // none and compiles byte-identically.
  out = implicitStdImports(out)
  return foldStaticBundlerHelpers(foldStaticExportHelpers(canonicalizeObjectIdioms(out)))
}
