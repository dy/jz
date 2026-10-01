/**
 * AST transform handlers — function/class/control-flow lowering after hoisting.
 * @module jzify/transform
 */

import { rewriteChildren, withLoc, JZ_BLOCK_OPS, LABEL_BODY_OPS, ACCESSOR_GET, ACCESSOR_SET, objectLiteralEntries } from '../src/ast.js'
import { ctx, err } from '../src/ctx.js'
import { isDestructurePat } from './hoist-vars.js'
import { foldPrototypeStores } from './classes.js'
import { ERR_CLASS_NAMES } from '../err-codes.js'
import { JZIFY_CLASS_ERRORS as JC } from '../src/op-policy.js'
import { TYPED_ELEM_NAMES } from '../layout.js'

const TYPED_ARRAYS = new Set(['Float64Array','Float32Array','Float16Array','Int32Array','Uint32Array',
  'Int16Array','Uint16Array','Int8Array','Uint8Array','Uint8ClampedArray',
  'ArrayBuffer','BigInt64Array','BigUint64Array','DataView'])

// Runtime tags distinguish these constructors, including sibling Error classes.
// Keep them in prepare/emit instead of folding them by broad object shape.
const CORE_INSTANCEOF_ALLOW = new Set(['Array', 'Map', 'Set', 'ArrayBuffer', 'DataView', ...TYPED_ELEM_NAMES, 'Float16Array', 'Uint8ClampedArray', ...ERR_CLASS_NAMES])

const isProto = n => Array.isArray(n) && n[0] === '.' && Array.isArray(n[1]) && n[1][0] === '.' && n[1][2] === 'prototype'
const groupedName = node => typeof node === 'string' ? node
  : Array.isArray(node) && node[0] === '()' && node.length === 2 ? groupedName(node[1]) : null

// `spelled`: `ctor` names the constructor itself (a builtin, class, function
// or import), so its spelling tells it apart from another. Otherwise it is a
// variable holding one, and only what holds for any constructor folds.
function staticInstanceofFold(val, ctor, spelled) {
  if (typeof ctor !== 'string' || !Array.isArray(val)) return null
  if (val[0] === '()' && val.length === 2) return staticInstanceofFold(val[1], ctor, spelled)
  if (val[0] === 'new') {
    const inner = val[1]
    const cname = Array.isArray(inner) && inner[0] === '()' && inner.length > 2
      ? groupedName(inner[1]) : groupedName(inner)
    if (cname === ctor) return true
    if (cname && spelled) return cname !== 'Object' && ctor === 'Object'
  }
  if (val[0] == null && val.length === 2) {
    const v = val[1]
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null) return false
  }
  if (!spelled) return null
  // ctor === 'Array' never reaches here: CORE_INSTANCEOF_ALLOW routes it to the
  // core (which folds `[] instanceof Array` itself, via valTypeOf) before the
  // 'instanceof' handler below ever calls this function.
  if (val[0] === '[]' && val.length <= 2) return ctor === 'Object'
  if (val[0] === '{}') return ctor === 'Object'
  if (val[0] === '//') return ctor === 'RegExp' || ctor === 'Object'
  return null
}

function dedupeRedecls(stmts) {
  const declName = d => typeof d === 'string' ? d
    : Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' ? d[1] : null
  const seen = new Set(), out = []
  for (const s of stmts) {
    if (!Array.isArray(s) || (s[0] !== 'let' && s[0] !== 'const' && s[0] !== 'var')) { out.push(s); continue }
    const keep = [s[0]], reassign = []
    for (let i = 1; i < s.length; i++) {
      const d = s[i], n = declName(d)
      if (n == null) { keep.push(d); continue }
      if (seen.has(n)) { if (Array.isArray(d) && d[0] === '=') reassign.push(['=', d[1], d[2]]) }
      else { seen.add(n); keep.push(d) }
    }
    if (keep.length > 1) out.push(withLoc(keep, s))
    for (const r of reassign) out.push(r)
  }
  return out
}

// A name declared by several functions of one scope is bound to the last of
// them before any code runs (§10.2.11 FunctionDeclarationInstantiation): the
// earlier ones never become its value.
function lastDeclared(decls) {
  const nameOf = d => Array.isArray(d) && d[0] === 'const' && Array.isArray(d[1]) && d[1][0] === '=' && typeof d[1][1] === 'string' ? d[1][1] : null
  const last = new Map()
  decls.forEach((d, i) => { const n = nameOf(d); if (n != null) last.set(n, i) })
  return last.size === decls.length ? decls : decls.filter((d, i) => { const n = nameOf(d); return n == null || last.get(n) === i })
}

function functionBodyBlock(body) {
  if (Array.isArray(body) && body[0] === '{}') return body
  if (Array.isArray(body) && body[0] === ';') return withLoc(['{}', body], body)
  return withLoc(['{}', [';', body]], body)
}

const arrowParams = params => Array.isArray(params) && params[0] === '()' ? params : ['()', params]

/**
 * @param {object} opts
 * @param {ReturnType<import('./names.js').createNames>} opts.names
 * @param {Function} opts.lowerArguments
 * @param {Function} opts.transformPattern
 * @param {Function} opts.normalizeCaseBody
 * @param {Function} opts.transformSwitch
 * @param {() => Function} opts.lowerClass
 * @param {() => Function} opts.lowerObjectLiteralThis
 * @param {(name:string) => boolean} opts.shadowsBuiltin
 * @param {(name:string) => boolean} opts.isValue  its nearest declaration binds a value
 * @param {(node:Array) => any} opts.enterBuiltinScope  enter the node's builtin scope; returns the prior
 * @param {(prior:any) => void} opts.leaveBuiltinScope
 */
let _gen = null
export const bindGenerators = (g) => { _gen = g }

export function createTransform(opts) {
  const { names, lowerArguments, transformPattern, normalizeCaseBody, transformSwitch } = opts
  // A class lowered to a schema and shared method functions (jzify/classes.js)
  // hoists those functions to the module's statement list; the class value
  // itself stays where the class was.
  const classHoists = []
  const lowerClass = (name, heritage, body, trailers) => opts.lowerClass()(name, heritage, body, classHoists, trailers)
  /** A class declaration's statements: its hoisted functions, the binding, then its static members. */
  const lowerClassDecl = (name, heritage, body) => {
    const trailers = []
    const value = lowerClass(name, heritage, body, trailers)
    return [';', ...classHoists.splice(0), ['let', ['=', name, value]], ...trailers]
  }
  const lowerObjectLiteralThis = (...a) => opts.lowerObjectLiteralThis()(...a)
  const shadowsBuiltin = opts.shadowsBuiltin
  const { enterBuiltinScope, leaveBuiltinScope } = opts

  // transformScopeInner recurses while its parent still reads operands, so
  // retain one reusable tail array per active depth rather than allocating a
  // rest-destructure array at every AST node.
  const scopeArgPool = []
  let scopeArgDepth = 0
  const takeScopeArgs = (node) => {
    let args = scopeArgPool[scopeArgDepth]
    if (!args) scopeArgPool[scopeArgDepth] = args = []
    scopeArgDepth++
    args.length = node.length - 1
    for (let i = 1; i < node.length; i++) args[i - 1] = node[i]
    return args
  }
  const releaseScopeArgs = (args) => {
    args.length = 0
    scopeArgDepth--
  }

  const methodOverrideHasOwn = (a, b) => {
    const proto = isProto(a) ? a : isProto(b) ? b : null
    if (!proto) return null
    const other = proto === a ? b : a
    if (!Array.isArray(other) || other[0] !== '.' || other[2] !== proto[2]) return null
    return ['()', ['.', transform(other[1]), 'hasOwnProperty'], [null, proto[2]]]
  }

  // Function nesting depth: a class's shared functions hoist to the module's
  // statement list, the list at depth 0.
  let fnDepth = 0
  const inFunction = (fn) => { fnDepth++; try { return fn() } finally { fnDepth-- } }
  // Parameter defaults are expressions of the function's scope: a method
  // shorthand, a `function` expression or a class in a default value lowers
  // as one in the body does. Pattern targets stay as they are.
  const transformParams = (params) => inFunction(() =>
    Array.isArray(params) && params[0] === '()' ? ['()', transformPattern(params[1])] : transformPattern(params))
  // A function body stands where its source did: the position a fault in the function falls back to (ctx.js here).
  function wrapArrowBody(body) { return withLoc(arrowBodyBlock(body), body) }
  function arrowBodyBlock(body) {
    const t = inFunction(() => transformScope(body))
    if (!Array.isArray(t)) return ['{}', [';', t]]
    if (t[0] === ';') return ['{}', t]
    if (t[0] !== '{}') return ['{}', [';', t]]
    if (t.length === 2 && !(Array.isArray(t[1]) && t[1][0] === ';')) return ['{}', [';', t[1]]]
    return t
  }

  // Whether an identifier token appears anywhere in `node` outside literals and
  // property keys (a conservative free-variable test: any mention keeps the binding).
  function mentions(node, name) {
    if (node === name) return true
    if (!Array.isArray(node) || node[0] == null) return false
    if (node[0] === '.' || node[0] === '?.') return mentions(node[1], name)
    if (node[0] === ':') return mentions(node[2], name)
    for (let i = 1; i < node.length; i++) if (mentions(node[i], name)) return true
    return false
  }

  const namedFunction = (name, value) => ['()', ['()', ['=>', null, ['{}', [';',
    ['let', name], ['=', name, value], ['return', name]
  ]]]], null]

  // A declared function's binding (`const name = value`) stands where the declaration `fn` does.
  const bindFn = (name, value, fn) => withLoc(['const', withLoc(['=', name, withLoc(value, fn)], fn)], fn)
  function hoistFnDecl(name, params, body, fn) {
    const [p2, b2] = lowerArguments(params, functionBodyBlock(body))
    const decl = bindFn(name, ['=>', transformParams(p2), withLoc(wrapArrowBody(b2), fn)], fn)
    decl._hoisted = true
    return decl
  }

  // `using x = res` (ERM): bind, resolve [Symbol.dispose] up front (TypeError
  // if absent on a non-null resource — spec checks at binding), then wrap the
  // REST of the scope in try/finally calling it. Multiple resources nest —
  // LIFO disposal falls out of the nesting. Divergence (documented): if both
  // the body and a dispose throw, the dispose error propagates (no
  // SuppressedError aggregation).
  function lowerUsing(declarators, remaining) {
    const NULL = [null, null]
    const dispose = (name) => ['if', ['!=', name, NULL], ['()', ['.', name, '@@dispose'], null]]
    let inner = remaining.length ? transformScope([';', ...remaining]) : null
    for (let k = declarators.length - 1; k >= 0; k--) {
      const [, name, init] = declarators[k]
      inner = [';',
        ['let', ['=', name, transform(init)]],
        ['if', ['&&', ['!=', name, NULL], ['==', ['.', name, '@@dispose'], NULL]],
          ['throw', [null, 'using: value has no [Symbol.dispose]() method']]],
        ['try', inner ?? ['{}', null], ['finally', dispose(name)]],
      ]
    }
    return inner
  }

  // A control body is a statement position even when it contains only one
  // labelled statement. Object-property colons use the expression path.
  function transformStatement(node) {
    if (Array.isArray(node) && node[0] === ':' && typeof node[1] === 'string')
      return withLoc(['label', node[1], transformStatement(node[2])], node)
    if (Array.isArray(node) && node[0] === '{}' && node.length === 2 && node[1]?.[0] === ':')
      return transform(withLoc(['{}', [';', node[1]]], node))
    return transform(node)
  }

  // A node is the current position while it lowers (ctx.js), and what it lowers to stands at its place.
  function transformScope(node) {
    const prior = enterBuiltinScope(node), outer = ctx.error.loc
    if (Array.isArray(node) && node.loc != null) ctx.error.loc = node.loc
    try { return withLoc(transformScopeInner(node), node) } finally { leaveBuiltinScope(prior); ctx.error.loc = outer }
  }

  function transformScopeInner(node) {
    if (!Array.isArray(node)) return transform(node)

    const op = node[0]
    const args = takeScopeArgs(node)
    try {
    if (op === 'function' && args[0]) return hoistFnDecl(args[0], args[1], args[2], node)
    if (op === 'function*' && args[0] && _gen)
      return bindFn(args[0], _gen.lowerGenerator(args[1], args[2]), node)
    if (op === 'async' && Array.isArray(args[0]) && args[0][0] === 'function' && args[0][1] && _gen?.lowerAsync)
      return bindFn(args[0][1], transform(_gen.lowerAsync(args[0][2], args[0][3])), node)
    if (op === 'async' && Array.isArray(args[0]) && args[0][0] === 'function*' && args[0][1] && _gen?.lowerAsyncGen)
      return bindFn(args[0][1], transform(_gen.lowerAsyncGen(args[0][2], args[0][3])), node)
    if (op === 'class' && args[0]) return lowerClassDecl(...args)
    if (op === 'using') return lowerUsing(args, [])

    if (op === ';') {
      const hoisted = [], rest = []
      // a function's statements fold their classes' prototype stores as the module's do (jzify/index.js)
      const stmts = fnDepth > 0 ? foldPrototypeStores(args) : args
      for (let i = 0; i < stmts.length; i++) {
        const stmt = stmts[i]
        if (Array.isArray(stmt) && stmt[0] === 'function' && stmt[1]) {
          hoisted.push(hoistFnDecl(stmt[1], stmt[2], stmt[3], stmt))
          continue
        }
        if (Array.isArray(stmt) && stmt[0] === 'function*' && stmt[1] && _gen) {
          hoisted.push(bindFn(stmt[1], _gen.lowerGenerator(stmt[2], stmt[3]), stmt))
          continue
        }
        // async function DECLARATION — hoists like any function declaration.
        if (Array.isArray(stmt) && stmt[0] === 'async' && Array.isArray(stmt[1]) &&
            stmt[1][0] === 'function' && stmt[1][1] && _gen?.lowerAsync) {
          hoisted.push(bindFn(stmt[1][1], transform(_gen.lowerAsync(stmt[1][2], stmt[1][3])), stmt))
          continue
        }
        // async GENERATOR declaration — same hoisting, tagged-yield machine.
        if (Array.isArray(stmt) && stmt[0] === 'async' && Array.isArray(stmt[1]) &&
            stmt[1][0] === 'function*' && stmt[1][1] && _gen?.lowerAsyncGen) {
          hoisted.push(bindFn(stmt[1][1], transform(_gen.lowerAsyncGen(stmt[1][2], stmt[1][3])), stmt))
          continue
        }
        if (Array.isArray(stmt) && stmt[0] === 'class' && stmt[1]) {
          rest.push(...lowerClassDecl(stmt[1], stmt[2], stmt[3]).slice(1))
          continue
        }
        // `using` consumes the REST of the scope into its try body (disposal
        // runs at scope exit however the scope exits).
        if (Array.isArray(stmt) && stmt[0] === 'using') {
          rest.push(lowerUsing(stmt.slice(1), stmts.slice(i + 1)))
          break
        }
        // Labeled BLOCK in statement position (`lbl: { … }`): unambiguous here —
        // a ':' STATEMENT can't be an object prop. '{}' stays out of
        // LABEL_BODY_OPS (the expression-context disambiguator), so literal
        // props `k: {…}` never label.
        if (Array.isArray(stmt) && stmt[0] === ':' && typeof stmt[1] === 'string' &&
            Array.isArray(stmt[2]) && stmt[2][0] === '{}') {
          rest.push(['label', stmt[1], transformStatement(stmt[2])])
          continue
        }
        const t = transform(stmt)
        if (fnDepth === 0) rest.push(...classHoists.splice(0))   // a class expression's shared functions
        if (t == null) continue
        if (Array.isArray(t) && t[0] === 'const' && t._hoisted) {
          hoisted.push(t)
        } else if (Array.isArray(t) && t[0] === ';') {
          for (const s of t.slice(1)) {
            if (s != null) {
              if (Array.isArray(s) && s[0] === 'const' && s._hoisted) hoisted.push(s)
              else rest.push(s)
            }
          }
        } else {
          rest.push(t)
        }
      }
      // ES hoists every import binding above any function body. jzify mirrors
      // that by floating imports ahead of hoisted function decls. A combo import
      // `import d, { n } from 'm'` parses as `[',', ['import',…], ['from',…]]`, so
      // match the comma-wrapped form too — otherwise its bindings land after the
      // hoisted functions that reference them ("X is not in scope").
      const isImportStmt = s => Array.isArray(s) &&
        (s[0] === 'import' || (s[0] === ',' && Array.isArray(s[1]) && s[1][0] === 'import'))
      const imports = rest.filter(isImportStmt)
      const nonImports = rest.filter(s => !isImportStmt(s))
      const all = dedupeRedecls([...imports, ...lastDeclared(hoisted), ...nonImports])
      return all.length === 0 ? null : all.length === 1 ? all[0] : [';', ...all]
    }

    const t = transform(node)
    return classHoists.length && fnDepth === 0 ? [';', ...classHoists.splice(0), t] : t
    } finally {
      releaseScopeArgs(args)
    }
  }

  // Promise statics → the injected plain-jz runtime helpers.
  const P_STATIC = {
    resolve: '__p_resolve', reject: '__p_reject', all: '__p_all', race: '__p_race',
    allSettled: '__p_allSettled', any: '__p_any', try: '__p_try', withResolvers: '__p_withResolvers',
  }

  // Spread of a possibly-iterator value (iterator-minting programs only):
  // `...E` → `...__drain(E)` — pass-through for arrays/strings, materializes
  // machines/@@iterator providers. Array literals skip (statically safe).
  const wrapSpreadDrain = (e) => {
    if (!_gen?.iterProto?.on) return null
    const v = e[1]
    if (Array.isArray(v) && (v[0] === '[]' || v[0] == null)) return null
    return ['...', ['()', '__it_drain', transform(v)]]
  }
  const wrapArg = (a) => (Array.isArray(a) && a[0] === '...' && wrapSpreadDrain(a)) || transform(a)

  const handlers = {
    // async function/arrow → (a, b) => __async_run((function* (a, b) …)(a, b))
    'async'(inner) {
      if (!_gen?.lowerAsync || !Array.isArray(inner)) return
      if (inner[0] === 'function*' || inner[0] === 'function') {
        const [, name, params, body] = inner
        const value = transform(inner[0] === 'function*'
          ? _gen.lowerAsyncGen(params, body) : _gen.lowerAsync(params, body))
        return name && (mentions(body, name) || mentions(params, name)) ? namedFunction(name, value) : value
      }
      if (inner[0] === '=>') {
        const params = Array.isArray(inner[1]) && inner[1][0] === '()' ? inner[1][1] : inner[1]
        // A CONCISE arrow body (`async () => expr`, no braces) is an implicit
        // return of `expr` — but the machine factory below is a real `function*`,
        // whose body is always statement-shaped (real generators have no concise
        // form). A block body (`{ … }`, always parsed with a leading '{}' node —
        // even a parenthesized object literal `({x:1})` parses as `['()', obj]`,
        // never bare '{}') passes through untouched; anything else gets wrapped
        // into an explicit `return`, the same shape a single-statement function
        // body already carries (prepare/parse strip its '{}' too — see async.js's
        // header). Without this, the bare expression spliced straight into the
        // state machine runs as a discarded expression-statement: the settled
        // value is silently lost (concise-body heap/number resolves undefined).
        const body = Array.isArray(inner[2]) && inner[2][0] === '{}' ? inner[2] : ['return', inner[2]]
        return transform(_gen.lowerAsync(params, body))
      }
      // `async function () {}()` — the parser binds the CALL inside the async
      // wrapper; lower the callee, keep the call.
      if (inner[0] === '()' && Array.isArray(inner[1]) && (inner[1][0] === 'function' || inner[1][0] === '=>'))
        return transform(['()', ['async', inner[1]], ...inner.slice(2)])
    },

    '()'(callee, ...rest) {
      // an `import()` of a literal specifier hoisted (index.js hoistDynamicImports);
      // a specifier computed at run time names no module of the graph
      if (callee === 'import' && !shadowsBuiltin('import'))
        err('jzify: import() takes one string literal – jz resolves the module graph at compile time, so a specifier computed at run time names no module (and import options are unsupported); write `import(\'./x.js\')`')
      // Promise API rides the async runtime (`jz:async`): new Promise(fn)
      // arrives here as a plain call (the `new` handler unwraps unknown
      // ctors), statics by name.
      if (_gen) {
        if (callee === 'Promise' && !shadowsBuiltin('Promise') && rest.length) {
          return ['()', '__p_exec', ...rest.map(a => a == null ? a : transform(a))]
        }
        if (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'Promise' &&
            !shadowsBuiltin('Promise') && P_STATIC[callee[2]]) {
          return ['()', P_STATIC[callee[2]], ...rest.map(a => a == null ? a : transform(a))]
        }
        // queueMicrotask(fn) IS the runtime's job queue: push onto __mt, drained
        // at the same host boundaries promise jobs are. Evaluates to undefined
        // per spec (push's return length is discarded by the comma).
        if (callee === 'queueMicrotask' && !shadowsBuiltin('queueMicrotask') && rest.length) {
          return [',', ['()', ['.', '__mt', 'push'], ...rest.map(a => a == null ? a : transform(a))], 'undefined']
        }
      }
      // `Object.defineProperties(o, { k: d, … })` with a literal map is each
      // property's `Object.defineProperty(o, 'k', d)` in order, and `o`.
      if (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'Object' && callee[2] === 'defineProperties' && !shadowsBuiltin('Object')) {
        const a = rest.length === 1 && Array.isArray(rest[0]) && rest[0][0] === ',' ? rest[0].slice(1) : rest
        const entries = a.length === 2 && Array.isArray(a[1]) && a[1][0] === '{}' ? objectLiteralEntries(a[1].slice(1)) : null
        if (entries && entries.every(e => Array.isArray(e) && e[0] === ':' && typeof e[1] === 'string')) {
          const t = names.genTemp('dps')
          return transform(['()', ['=>', ['()', t], ['{}', [';',
            ...entries.map(e => ['()', ['.', 'Object', 'defineProperty'], [',', t, [null, e[1]], e[2]]]),
            ['return', t]]]], a[0]])
        }
        err('jzify: `Object.defineProperties(o, map)` lowers to one `Object.defineProperty` per key, so `map` must be an object literal with literal keys – spell the calls out otherwise')
      }
      // URLSearchParams rides the jz-source std module `jz:usp` (src/std/usp.js);
      // `new URLSearchParams(x)` unwraps to this same call via the `new` handler.
      if (callee === 'URLSearchParams' && !shadowsBuiltin('URLSearchParams') && _gen) {
        return ['()', '__usp_new', ...rest.map(a => a == null ? a : transform(a))]
      }
      // Terminal iterator helper (toArray/reduce/forEach/some/every/find) on a
      // chain rooted at a known generator call → fused IIFE loop.
      if (_gen && Array.isArray(callee) && callee[0] === '.') {
        const chain = _gen.unwindChain(['()', callee, ...rest])
        if (chain && chain.stages.length && _gen.isTerminal(chain.stages[chain.stages.length - 1].h)) {
          const fused = _gen.fuseTerminal(chain, names.genTemp)
          if (fused) return transform(fused)
        }
      }
      // `E[Symbol.iterator]()` is the iterator over E (`__it_from`): an
      // indexed value's own (an array, a string, a typed array, a collection's
      // snapshot view), a provider's `@@iterator` result, a machine itself.
      // The protocol desugars' own probe calls stay member calls (`probe`:
      // the member was found), and so do the runtime's (`jz:` modules), where
      // __it_from is defined.
      if (_gen && !_gen.iterProto?.std && Array.isArray(callee) && callee[0] === '.' && callee[2] === '@@iterator' &&
          !callee.probe && rest.every(a => a == null))
        return ['()', '__it_from', transform(callee[1])]
      // Array.from over iterator values (iterator-minting programs only):
      // protocol values materialize via __it_arr; arrays copy; array-likes
      // build by length. `Array.from(x, fn)` maps the materialized array.
      if (_gen?.iterProto?.on && Array.isArray(callee) && callee[0] === '.' &&
          callee[1] === 'Array' && !shadowsBuiltin('Array') && callee[2] === 'from' && rest.length === 1) {
        const args = Array.isArray(rest[0]) && rest[0][0] === ',' ? rest[0].slice(1) : [rest[0]]
        const drained = ['()', '__it_arr', transform(args[0])]
        if (args.length >= 2) return ['()', ['.', drained, 'map'], transform(args[1])]
        return drained
      }
      // spread ARG of a possibly-iterator value → __drain (iterator programs only)
      if (_gen?.iterProto?.on && rest.length === 1 && Array.isArray(rest[0])) {
        const args = rest[0]
        if (args[0] === ',' && args.slice(1).some(x => Array.isArray(x) && x[0] === '...'))
          return ['()', transform(callee), [',', ...args.slice(1).map(wrapArg)]]
        if (args[0] === '...') {
          const w = wrapSpreadDrain(args)
          if (w) return ['()', transform(callee), w]
        }
      }
      if (Array.isArray(callee) && callee[0] === '()' && Array.isArray(callee[1]) && callee[1][0] === 'function' && callee[1][1]) {
        const [, name, params, body] = callee[1]
        const [p2, b2] = lowerArguments(params, functionBodyBlock(body))
        // `(function name(){…})(args)` — the named binding must be lowered as a
        // self-contained EXPRESSION (it can sit in concise-arrow-body / argument
        // position), so wrap the `let name = arrow; name(args)` in a block IIFE
        // rather than emitting a bare `;`-sequence. A statement-sequence in
        // expression position never reaches the `'=>'` handler's block-wrap (that
        // runs before this transform), and emit miscompiles a `let`-closure decl in
        // a concise `;`-body. Mirrors the bare-`function name` lowering below.
        return ['()', ['=>', null, ['{}', [';',
          ['let', ['=', name, ['=>', transformParams(arrowParams(p2)), wrapArrowBody(b2)]]],
          ['return', ['()', name, ...rest.map(transform)]],
        ]]], null]
      }
    },

    'function'(name, params, body) {
      const [p2, b2] = lowerArguments(params, functionBodyBlock(body))
      const arrow = ['=>', transformParams(p2), wrapArrowBody(b2)]
      // The name of a named function expression binds only inside its body. A
      // body that never mentions it (`fn.coefs = function coefs () {}`, named
      // for stack traces) is the plain arrow, which keeps the property lift.
      if (name && !mentions(body, name) && !mentions(params, name)) return arrow
      if (name) {
        return namedFunction(name, arrow)
      }
      return arrow
    },

    '=>'(params, body) {
      let b = body
      if (Array.isArray(b) && b[0] === '{}' && b.length === 2) {
        const inner = b[1]
        if (inner != null && !(Array.isArray(inner) && inner[0] === ';')) {
          b = ['{}', [';', inner]]
        }
      }
      const [p2, b2] = lowerArguments(params, b)
      return ['=>', transformParams(p2), inFunction(() => transform(b2))]
    },

    'class'(name, heritage, body) { return lowerClass(name, heritage, body) },

    'var'(...args) {
      return ['let', ...args.map(transform)]
    },

    'function*'(name, params, body) {
      // Expression form (`let g = function* () {…}`). Named statement forms are
      // hoisted in transformScope like plain function declarations.
      if (!_gen) return
      const prior = enterBuiltinScope(body)
      let value
      try { value = _gen.lowerGenerator(params, body) } finally { leaveBuiltinScope(prior) }
      return name && (mentions(body, name) || mentions(params, name)) ? namedFunction(name, value) : value
    },

    '[]'(payload, idx) {
      // 2-arg form is INDEXING (obj[key]) — not ours. The 1-arg form is the
      // array LITERAL: rewrite a spread of a generator / helper chain into a
      // spread of the FUSED toArray (a plain array) — the existing
      // array-spread machinery takes it from there. In an iterator-minting
      // program, any OTHER spread of a non-literal wraps in __drain (returns
      // the value untouched unless it's an iterator — then materializes it).
      if (!_gen || idx !== undefined) return
      const rewrite = (e) => {
        if (!Array.isArray(e) || e[0] !== '...') return null
        if (Array.isArray(e[1])) {
          const chain = _gen.unwindChain(e[1])
          if (chain && (!chain.stages.length || !_gen.isTerminal(chain.stages[chain.stages.length - 1].h))) {
            const fused = _gen.fuseTerminal({ root: chain.root, stages: [...chain.stages, { h: 'toArray', args: [] }] }, names.genTemp)
            if (fused) return ['...', transform(fused)]
          }
        }
        return wrapSpreadDrain(e)
      }
      if (payload === undefined) return
      if (Array.isArray(payload) && payload[0] === ',') {
        // Keep the completed walk even when no spread rewrites: falling back
        // to the generic walk would lower every nested literal a second time.
        return ['[]', rewriteChildren(payload, e => rewrite(e) ?? transform(e))]
      }
      const one = rewrite(payload)
      if (one) return ['[]', one]
    },

    ':'(label, body) {
      if (typeof label === 'string' && Array.isArray(body) && LABEL_BODY_OPS.has(body[0]))
        return ['label', label, transformStatement(body)]
    },

    '='(lhs, rhs) {
      if (isDestructurePat(lhs)) return ['=', transformPattern(lhs), transform(rhs)]
      // a store the prototype fold left (classes.js foldPrototypeStores): a class, lowered either way, has no prototype to take it
      if (Array.isArray(lhs) && (lhs[0] === '.' || lhs[0] === '[]') && Array.isArray(lhs[1]) && lhs[1][0] === '.' && lhs[1][2] === 'prototype'
          && typeof lhs[1][1] === 'string' && opts.isClass(lhs[1][1]))
        err('jzify: ' + JC.prototypeStore)
      // a static accessor of a class of this module: the slot function on the class (classes.js)
      if (Array.isArray(lhs) && lhs[0] === '.' && typeof lhs[1] === 'string' && typeof lhs[2] === 'string' && opts.classStaticAccessor(lhs[1], lhs[2] + ACCESSOR_SET))
        return ['()', ['.', lhs[1], lhs[2] + ACCESSOR_SET], transform(rhs)]
    },

    '.'(obj, prop) {
      if (typeof obj === 'string' && typeof prop === 'string' && opts.classStaticAccessor(obj, prop + ACCESSOR_GET))
        return ['()', ['.', obj, prop + ACCESSOR_GET], null]
    },

    'switch'(disc, ...cases) {
      const clean = cases.map(c => {
        if (c[0] === 'case') return ['case', c[1], normalizeCaseBody(c[2])]
        if (c[0] === 'default') return ['default', normalizeCaseBody(c[1])]
        return c
      })
      return transformSwitch(disc, clean)
    },

    '=='(a, b) { const own = methodOverrideHasOwn(a, b); if (own) return ['!', own]; return isProto(a) || isProto(b) ? 1 : ['==', transform(a), transform(b)] },
    '!='(a, b) { const own = methodOverrideHasOwn(a, b); if (own) return own; return isProto(a) || isProto(b) ? 0 : ['!=', transform(a), transform(b)] },
    '==='(a, b) { const own = methodOverrideHasOwn(a, b); if (own) return ['!', own]; if (isProto(a) || isProto(b)) return 1 },
    '!=='(a, b) { const own = methodOverrideHasOwn(a, b); if (own) return own; if (isProto(a) || isProto(b)) return 0 },

    'new'(ctor, ...cargs) {
      const name = Array.isArray(ctor) && ctor[0] === '()' && ctor.length > 2
        ? groupedName(ctor[1]) : groupedName(ctor)
      // Preserve `new` for native constructors the compiler resolves under its own
      // `new` handler (prepare/index.js): typed arrays/Array/RegExp need the `new`
      // form, and `new URL(rel, import.meta.url)` lowers to a static href string there.
      // User classes (lowered to factory arrows by jzify) become plain calls below.
      if (typeof name === 'string' && (TYPED_ARRAYS.has(name) || name === 'Array' ||
          name === 'SharedArrayBuffer' || name === 'RegExp' || name === 'URL'))
        return ['new', transform(ctor), ...cargs.map(transform)]
      // paren-less `new URLSearchParams` (ctor arrives as a bare string —
      // the call-node form unwraps through the '()' handler below)
      if (name === 'URLSearchParams' && !shadowsBuiltin('URLSearchParams') && typeof ctor === 'string' && _gen) {
        return ['()', '__usp_new']
      }
      if (Array.isArray(ctor) && ctor[0] === '()') return transform(ctor)
      return ['()', transform(ctor), ...(cargs.length ? cargs.map(transform) : [null])]
    },

    'instanceof'(val, ctor) {
      const rawName = groupedName(ctor)
      // A known user class keeps its identity even when named like a builtin.
      const brand = typeof rawName === 'string' ? opts.classBrand(rawName) : null
      if (brand) return ['instanceof', transform(val), brand]
      // Other shadowed values have no builtin prototype authority.
      if (typeof rawName === 'string' && shadowsBuiltin(rawName))
        return ['instanceof', transform(val), transform(ctor)]
      // promise-shape probe — promises are fixed-shape objects, no ctor chain
      if (ctor === 'Promise' && _gen) {
        const t0 = transform(val)
        return ['&&', ['!=', t0, [null, null]], ['==', ['.', t0, '__p'], [null, 1]]]
      }
      // iterator-shape probe — anything driving the protocol (a callable next)
      // is an Iterator to jz; arrays/strings probe false (no `next` prop).
      if (ctor === 'Iterator' && _gen) {
        const t0 = transform(val)
        return ['&&', ['===', ['typeof', t0], [null, 'object']], ['!=', ['.', t0, 'next'], [null, null]]]
      }
      // Every representable callable reports typeof 'function'.
      if (ctor === 'Function') {
        const t0 = transform(val)
        return ['===', ['typeof', t0], [null, 'function']]
      }
      const t = transform(val)
      const name = rawName
      // Array/Map/Set/TypedArray/ArrayBuffer/Error-family: hand off to the sound
      // core machinery instead of guessing here (see CORE_INSTANCEOF_ALLOW above)
      // — same op, same RHS, same answer as strict mode.
      if (name === 'Object' || name === 'SharedArrayBuffer' || typeof name === 'string' && CORE_INSTANCEOF_ALLOW.has(name))
        return ['instanceof', t, name]
      const spelled = !(typeof name === 'string' && opts.isValue(name))
      const fold = spelled && name === 'RegExp' ? staticInstanceofFold(val, name, spelled) : null
      if (fold != null) return [',', t, [null, fold]]
      // Prepare owns namespace aliases and rejects unsupported constructor values.
      return ['instanceof', t, transform(ctor)]
    },

    'if'(cond, then, els) {
      const out = ['if', transform(cond), transformStatement(then)]
      if (els != null) out.push(transformStatement(els))
      return out
    },
    'while'(cond, body) { return ['while', transform(cond), transformStatement(body)] },
    'try'(body, ...clauses) {
      return ['try', transformStatement(body), ...clauses.map(c => c[0] === 'catch'
        ? ['catch', transform(c[1]), transformStatement(c[2])]
        : ['finally', transformStatement(c[1])])]
    },

    'do'(body, cond) {
      const flag = names.doFlag()
      return [';',
        ['let', ['=', flag, [null, true]]],
        ['while', ['||', flag, transform(cond)], ['{}', [';', ['=', flag, [null, false]], transformStatement(body)]]]]
    },

    // The classic for-head `[';', init, cond, step]` is a fixed 3-slot structure,
    // NOT a statement sequence. Transform each slot individually and keep null slots
    // in place. Without this handler, `for` falls to the generic recurse, the head
    // hits the `;` handler (transformScope), and an empty `init` (null) is dropped as
    // an empty statement — shifting cond→init/step→cond and miscompiling the loop
    // (`for (; i < n; i++)` ran zero/garbage iterations). for-of/for-in heads aren't
    // `;`-lists, so they pass through transform unchanged.
    'for'(head, body) {
      // for-of over a KNOWN generator call → while-next desugar (the generator
      // object is plain closures + a fixed-shape result record).
      if (_gen && Array.isArray(head) && head[0] === 'of' &&
          Array.isArray(head[2]) && head[2][0] === '()' &&
          typeof head[2][1] === 'string' && _gen.generatorNames.has(head[2][1]))
        return transform(_gen.desugarForOfGenerator(head[1], transform(head[2]), body, names.genTemp))
      // for-of over an iterator-HELPER CHAIN rooted at a known generator call
      // → one fused while-next loop (map/filter/take/drop compose in place).
      if (_gen && Array.isArray(head) && head[0] === 'of' && Array.isArray(head[2])) {
        const chain = _gen.unwindChain(head[2])
        if (chain && chain.stages.length && chain.stages.every(st => !_gen.isTerminal(st.h))) {
          const name = Array.isArray(head[1]) ? head[1][1] : head[1]
          const bodyStmts = Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]
          const x = names.genTemp('gx')
          const fused = _gen.fusedLoop(chain.root, chain.stages, names.genTemp, x,
            () => [['let', ['=', name, x]], ...bodyStmts])
          return transform(fused)
        }
      }
      // 'of-idx' — the protocol fork's array arm: plain indexed for-of, no re-fork.
      if (Array.isArray(head) && head[0] === 'of-idx') {
        const t = transform(['of', head[1], head[2]])
        return ['for', t, transformStatement(body)]
      }
      // for-of over an UNKNOWN source in an iterator-minting program → runtime
      // protocol fork (probe once, drive next() lazily, else indexed path).
      if (_gen && _gen.iterProto?.on && Array.isArray(head) && head[0] === 'of')
        return transform(_gen.desugarForOfProtocol(head[1], head[2], body, names.genTemp))
      if (Array.isArray(head) && head[0] === ';' && Array.isArray(head[1]) && head[1][0] === 'using')
        return lowerUsing(head[1].slice(1), [['for', [';', null, head[2], head[3]], body]])
      if (Array.isArray(head) && head[0] === ';')
        return ['for', [';', ...head.slice(1).map(s => s == null ? s : transform(s))], transformStatement(body)]
      // for-in with a DESTRUCTURING decl head (`for (let [x, y = d] in o)` —
      // the KEY STRING destructures): bind the key to a temp and let the
      // ordinary let-pattern lowering handle it at the body top. Patterns are
      // jzify's job — prepare's for-in lowering synthesizes a raw
      // `let PATTERN = key` that nothing downstream destructures ('x' is not
      // in scope; test262 for-in scope-body-lex-*).
      if (Array.isArray(head) && head[0] === 'in') {
        const decl = head[1]
        const isDecl = Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const')
        const pat = isDecl ? decl[1] : null
        if (pat && isDestructurePat(pat)) {
          const t = names.genTemp('fkp')
          const bodyStmts = Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]
          return transform(['for', ['in', [decl[0], t], head[2]],
            [';', [decl[0], ['=', pat, t]], ...bodyStmts]])
        }
      }
      return ['for', transform(head), transformStatement(body)]
    },

    // A bare statement sequence is a block scope too. `parse` only wraps
    // function/arrow bodies in `{}`; loop/conditional bodies arrive as a raw
    // `;`. Route them through transformScope so `function` declarations nested
    // in a loop/if body get hoisted (→ block-top `const f = arrow`) instead of
    // falling to the discard-IIFE path, which would scope the name inside the
    // IIFE and leave later `f()` references dangling.
    ';'(...args) { return transformScope([';', ...args]) },

    '{}'(...args) {
      const withAccessors = opts.lowerObjectLiteralAccessors?.()(args)
      if (withAccessors) args = withAccessors
      const loweredObject = lowerObjectLiteralThis(args)
      if (loweredObject) return loweredObject

      return ['{}', ...args.map((a, i) => {
        const t = transformScope(a) ?? a
        if (i !== 0 || a == null) return t
        const blockIn = Array.isArray(a) && JZ_BLOCK_OPS.has(a[0])
        if (!blockIn || t == null) return t
        return Array.isArray(t) && t[0] === ';' ? t : [';', t]
      })]
    },

    'export'(inner) {
      if (Array.isArray(inner) && inner[0] === 'function' && inner[1]) {
        return ['export', hoistFnDecl(inner[1], inner[2], inner[3], inner)]
      }
      // `export function* g` / `export async function f` / `export async function* g`:
      // the same const bindings the statement-level hoist makes, exported
      if (Array.isArray(inner) && inner[0] === 'function*' && inner[1] && _gen)
        return ['export', bindFn(inner[1], _gen.lowerGenerator(inner[2], inner[3]), inner)]
      if (Array.isArray(inner) && inner[0] === 'async' && Array.isArray(inner[1]) && inner[1][1]) {
        const fn = inner[1]
        if (fn[0] === 'function' && _gen?.lowerAsync)
          return ['export', bindFn(fn[1], transform(_gen.lowerAsync(fn[2], fn[3])), inner)]
        if (fn[0] === 'function*' && _gen?.lowerAsyncGen)
          return ['export', bindFn(fn[1], transform(_gen.lowerAsyncGen(fn[2], fn[3])), inner)]
      }
      if (Array.isArray(inner) && inner[0] === 'class' && inner[1]) {
        const decl = lowerClassDecl(inner[1], inner[2], inner[3])
        return [';', ...decl.slice(1).map(s => Array.isArray(s) && s[0] === 'let' && s[1][1] === inner[1] ? ['export', s] : s)]
      }
      if (Array.isArray(inner) && inner[0] === 'default' && Array.isArray(inner[1]) && inner[1][0] === 'function' && inner[1][1]) {
        // Route a named default-export function through the named-export path: a bare
        // `const NAME` lifted in a bundled module loses its recursive self-reference
        // (the default-alias resolver renames the func but not in-body call sites),
        // so the function is dropped. Exporting NAME as a named binding makes prepare
        // mangle it and resolve self-calls correctly; alias `default` to it.
        const decl = hoistFnDecl(inner[1][1], inner[1][2], inner[1][3], inner[1])
        return [';', ['export', decl], ['export', ['{}', ['as', inner[1][1], 'default']]]]
      }
      if (Array.isArray(inner) && inner[0] === 'default' && Array.isArray(inner[1]) && inner[1][0] === 'class' && inner[1][1]) {
        return [';', ...lowerClassDecl(inner[1][1], inner[1][2], inner[1][3]).slice(1), ['export', ['default', inner[1][1]]]]
      }
      return ['export', transform(inner)]
    },
  }

  function transform(node) {
    const prior = enterBuiltinScope(node), outer = ctx.error.loc
    if (Array.isArray(node) && node.loc != null) ctx.error.loc = node.loc
    try { return withLoc(transformInner(node), node) } finally { leaveBuiltinScope(prior); ctx.error.loc = outer }
  }

  function transformInner(node) {
    if (node == null || typeof node !== 'object' || !Array.isArray(node)) return node
    const op = node[0]
    if (op == null) return node
    const h = handlers[op]
    let result
    if (h) {
      switch (node.length) {
        case 1: result = h(); break
        case 2: result = h(node[1]); break
        case 3: result = h(node[1], node[2]); break
        case 4: result = h(node[1], node[2], node[3]); break
        case 5: result = h(node[1], node[2], node[3], node[4]); break
        default: result = h(...node.slice(1))
      }
      if (result != null) return result
    }
    return rewriteChildren(node, transform)
  }

  return { transform, transformScope, transformParams }
}
