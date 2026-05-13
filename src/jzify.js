/**
 * jzify — Transform JS AST into jz-compatible form.
 *
 * Crockford-aligned: eliminates bad parts, enforces good practices.
 * Runs before prepare() as an AST→AST pass.
 *
 * Transforms:
 *   function name(args) { body } → const name = (args) => { body }
 *   var → let
 *   switch → if/else chain
 *   new X(args) → X(args) (for known safe constructors)
 *   == → ===, != → !==
 *
 * Hoisting: function declarations are collected and moved to the top
 * of their scope (module or block), preserving semantics.
 *
 * @module jzify
 */

/**
 * Transform AST in-place. Returns transformed AST.
 * @param {Array} ast - subscript/jessie parsed AST
 * @returns {Array} Transformed AST
 */
export default function jzify(ast) {
  swIdx = 0
  argsIdx = 0
  doIdx = 0
  classIdx = 0
  // Hoist module-level vars: any `var x` inside nested blocks bubbles up.
  const names = new Set()
  ast = hoistVars(ast, names)
  if (names.size) ast = prependDecls(ast, names)
  return foldStaticExportHelpers(canonicalizeObjectIdioms(transformScope(ast)))
}

/**
 * Walk function/script body, replacing `var` declarations with assignments and
 * collecting names. Does not cross function/arrow boundaries — nested functions
 * get their own hoist pass when wrapArrowBody processes them.
 *
 *   ['var', 'x']                              → null (bare decl, no-op)
 *   ['var', ['=', x, init]]                   → ['=', x, init]
 *   ['var', ['=', x, 1], ['=', y, 2]]         → [',', ['=', x, 1], ['=', y, 2]]
 *   ['var', 'x', 'y']                         → null
 *   ['in', ['var', x], obj]                   → ['in', x, obj]   (for-in head)
 */
function hoistVars(node, names) {
  if (node == null || !Array.isArray(node)) return node
  const op = node[0]
  // Nested function/arrow: hoist within its own scope, prepend let-decl, return new node.
  if (op === 'function') {
    const inner = new Set()
    let body = hoistVars(node[3], inner)
    if (inner.size) body = prependDecls(body, inner)
    return ['function', node[1], node[2], body]
  }
  if (op === '=>') {
    const inner = new Set()
    let body = hoistVars(node[2], inner)
    if (inner.size) body = prependDecls(body, inner)
    return ['=>', node[1], body]
  }
  if (op === 'in' || op === 'of') {
    let lhs = node[1]
    if (Array.isArray(lhs) && lhs[0] === 'var' && typeof lhs[1] === 'string' && lhs.length === 2) {
      names.add(lhs[1])
      lhs = lhs[1]
    } else {
      lhs = hoistVars(lhs, names)
    }
    return [op, lhs, hoistVars(node[2], names)]
  }
  if (op === '=' && Array.isArray(node[1]) && node[1][0] === 'var' && typeof node[1][1] === 'string' && node[1].length === 2) {
    names.add(node[1][1])
    return ['=', node[1][1], hoistVars(node[2], names)]
  }
  // For-head `;` is positional (init; cond; update), not a statement sequence.
  // Recurse into each slot but never filter nulls — empty slots are valid.
  if (op === 'for') {
    const head = node[1]
    let h2
    const normalizedHead = normalizeForDeclHead(head, names)
    if (normalizedHead) {
      h2 = normalizedHead
    } else if (Array.isArray(head) && head[0] === 'var' && Array.isArray(head[1]) &&
        (head[1][0] === 'in' || head[1][0] === 'of') && typeof head[1][1] === 'string') {
      names.add(head[1][1])
      h2 = [head[1][0], head[1][1], hoistVars(head[1][2], names)]
    } else if (Array.isArray(head) && head[0] === ';') {
      h2 = [';']
      for (let i = 1; i < head.length; i++) h2.push(hoistVars(head[i], names))
    } else {
      h2 = hoistVars(head, names)
    }
    return ['for', h2, hoistVars(node[2], names)]
  }
  if (op === 'var') {
    const decls = []
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (typeof d === 'string') { names.add(d); continue }
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
        names.add(d[1])
        decls.push(['=', d[1], hoistVars(d[2], names)])
      }
    }
    if (decls.length === 0) return null
    if (decls.length === 1) return decls[0]
    return [',', ...decls]
  }
  // Filter null returns from `;` sequences (bare-var no-ops). `{}` is left
  // to recurse normally — it may be either a block or an object literal,
  // and we don't want to clobber `['{}', null]` (empty object literal).
  if (op === ';') {
    const out = [op]
    for (let i = 1; i < node.length; i++) {
      const c = hoistVars(node[i], names)
      if (c != null) out.push(c)
    }
    if (out.length === 1) return null
    if (out.length === 2) return out[1]
    return out
  }
  const out = new Array(node.length)
  out[0] = op
  for (let i = 1; i < node.length; i++) out[i] = hoistVars(node[i], names)
  return out
}

function prependDecls(body, names) {
  const decl = ['let', ...names]
  if (Array.isArray(body) && body[0] === ';') return [';', decl, ...body.slice(1)]
  if (Array.isArray(body) && body[0] === '{}') {
    const inner = body[1]
    if (Array.isArray(inner) && inner[0] === ';') return ['{}', [';', decl, ...inner.slice(1)]]
    if (inner == null) return ['{}', decl]
    return ['{}', [';', decl, inner]]
  }
  return body == null ? decl : [';', decl, body]
}

function normalizeForDeclHead(head, names) {
  if (!Array.isArray(head) || (head[0] !== 'var' && head[0] !== 'let' && head[0] !== 'const') || head.length !== 2) return null
  const kind = head[0]
  const expr = head[1]
  if (!Array.isArray(expr)) return null
  if (expr.length >= 3 && Array.isArray(expr[1]) &&
      (expr[1][0] === 'in' || expr[1][0] === 'of') && typeof expr[1][1] === 'string') {
    const iter = expr[1]
    return [iter[0], normalizeForDecl(kind, iter[1], names), hoistVars([expr[0], iter[2], ...expr.slice(2)], names)]
  }
  return null
}

function normalizeForDecl(kind, name, names) {
  if (kind === 'var') {
    names.add(name)
    return name
  }
  return [kind, name]
}

/** Convert a named function declaration to a hoisted const arrow */
function hoistFnDecl(name, params, body) {
  const [p2, b2] = lowerArguments(params, body)
  const decl = ['const', ['=', name, ['=>', p2, wrapArrowBody(b2)]]]
  decl._hoisted = true
  return decl
}

/** Transform a scope (module top-level or block body). Collects hoisted functions. */
function transformScope(node) {
  if (!Array.isArray(node)) return transform(node)

  const [op, ...args] = node

  // Single named function-statement at scope position: hoist as const arrow
  if (op === 'function' && args[0]) return hoistFnDecl(...args)
  // Single statement-form class declaration: bind the factory (no hoisting — classes are TDZ)
  if (op === 'class' && args[0]) return ['let', ['=', args[0], lowerClass(...args)]]

  // Statement sequence: collect hoisted functions
  if (op === ';') {
    const hoisted = [], rest = []
    for (let i = 0; i < args.length; i++) {
      const stmt = args[i]
      // Workaround for subscript parser ASI bug: multiline named IIFE
      // `(function name(){...})();` is parsed as two statements when there are
      // newlines inside the function body. Reconstruct the single-statement IIFE
      // so the () handler can desugar it correctly.
      if (Array.isArray(stmt) && stmt[0] === '()' &&
          Array.isArray(stmt[1]) && stmt[1][0] === 'function' && stmt[1][1] &&
          i + 1 < args.length && Array.isArray(args[i + 1]) && args[i + 1][0] === '()') {
        const merged = ['()', ['()', stmt[1]], args[i + 1][1] ?? null]
        const t = transform(merged)
        if (t != null) {
          if (Array.isArray(t) && t[0] === ';') {
            for (const s of t.slice(1)) { if (s != null) rest.push(s) }
          } else {
            rest.push(t)
          }
        }
        i++
        continue
      }
      // Statement-form named function declaration: hoist directly (skip expression handler)
      if (Array.isArray(stmt) && stmt[0] === 'function' && stmt[1]) {
        hoisted.push(hoistFnDecl(stmt[1], stmt[2], stmt[3]))
        continue
      }
      // Statement-form class declaration: bind the factory in place (not hoisted — TDZ)
      if (Array.isArray(stmt) && stmt[0] === 'class' && stmt[1]) {
        rest.push(['let', ['=', stmt[1], lowerClass(stmt[1], stmt[2], stmt[3])]])
        continue
      }
      const t = transform(stmt)
      if (t == null) continue
      // Hoist function declarations to top of scope
      if (Array.isArray(t) && t[0] === 'const' && t._hoisted) {
        hoisted.push(t)
      } else if (Array.isArray(t) && t[0] === ';') {
        // Flatten nested ; from multi-statement transforms
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
    // Hoist functions AFTER imports (imports must be processed first for scope resolution)
    const imports = rest.filter(s => Array.isArray(s) && s[0] === 'import')
    const nonImports = rest.filter(s => !(Array.isArray(s) && s[0] === 'import'))
    const all = dedupeRedecls([...imports, ...hoisted, ...nonImports])
    return all.length === 0 ? null : all.length === 1 ? all[0] : [';', ...all]
  }

  return transform(node)
}

/**
 * Drop redundant re-declarations of the same name within one scope's statement
 * list. JS allows `function f(){} var f;`, `var x; var x;`, `var x = 1; var x;` —
 * jzify lowers `function`→`const` and `var`→`let`, which would otherwise emit two
 * bindings for one slot (and a typed-slot clash in codegen). The first declaration
 * wins; a later redeclaration keeps only its initializer, as a plain assignment.
 */
function dedupeRedecls(stmts) {
  const nameOf = s => Array.isArray(s) && (s[0] === 'let' || s[0] === 'const' || s[0] === 'var')
    ? (typeof s[1] === 'string' ? s[1]
      : Array.isArray(s[1]) && s[1][0] === '=' && typeof s[1][1] === 'string' ? s[1][1] : null)
    : null
  const seen = new Set(), out = []
  for (const s of stmts) {
    const n = nameOf(s)
    if (n == null) { out.push(s); continue }
    if (seen.has(n)) { if (Array.isArray(s[1]) && s[1][0] === '=') out.push(['=', s[1][1], s[1][2]]); continue }
    seen.add(n); out.push(s)
  }
  return out
}

/** Wrap function body for arrow conversion */
function wrapArrowBody(body) {
  const t = transformScope(body)
  return Array.isArray(t) && (t[0] === '{}' || t[0] === ';') ? (t[0] === '{}' ? t : ['{}', t]) : ['{}', t]
}

/** Prototype identity check: X.prototype.Y */
const isProto = n => Array.isArray(n) && n[0] === '.' && Array.isArray(n[1]) && n[1][0] === '.' && n[1][2] === 'prototype'

const TYPED_ARRAYS = new Set(['Float64Array','Float32Array','Int32Array','Uint32Array',
  'Int16Array','Uint16Array','Int8Array','Uint8Array',
  'ArrayBuffer','BigInt64Array','BigUint64Array','DataView'])

// `arguments` lowering: regular `function` has implicit `arguments`; arrow doesn't.
// jzify converts function → arrow, so any `arguments` use must be rewritten to a rest param.
// Arrow functions inherit `arguments` from enclosing function — don't stop at '=>'.
// Nested `function` introduces its own `arguments` — stop recursion there.
let argsIdx = 0
let doIdx = 0

function usesArguments(node) {
  if (node === 'arguments') return true
  if (!Array.isArray(node)) return false
  if (node[0] === 'function') return false
  if (node[0] === '.' || node[0] === '?.') return usesArguments(node[1])
  if (node[0] === ':') return usesArguments(node[2])
  for (let i = 1; i < node.length; i++) if (usesArguments(node[i])) return true
  return false
}

// `arguments` is the implicit object only if the function body doesn't declare a
// local of that name. Scan the body's own statement list (not nested scopes) for
// `var/let/const arguments` — a regular `function` with `var arguments;` just has
// an ordinary local, no arguments object.
function bindsArguments(body) {
  const isArgDecl = s => Array.isArray(s) && (s[0] === 'var' || s[0] === 'let' || s[0] === 'const') &&
    s.slice(1).some(d => d === 'arguments' || (Array.isArray(d) && d[0] === '=' && d[1] === 'arguments'))
  let n = body
  if (Array.isArray(n) && n[0] === '{}') n = n[1]
  if (Array.isArray(n) && n[0] === ';') return n.slice(1).some(isArgDecl)
  return isArgDecl(n)
}

function renameArguments(node, to) {
  if (node === 'arguments') return to
  if (!Array.isArray(node)) return node
  if (node[0] === 'function') return node
  if (node[0] === '.' || node[0] === '?.')
    return [node[0], renameArguments(node[1], to), node[2]]
  if (node[0] === ':')
    return [node[0], node[1], renameArguments(node[2], to)]
  return node.map(n => renameArguments(n, to))
}

function paramList(params) {
  if (params == null) return []
  if (Array.isArray(params)) {
    if (params[0] === '()') {
      const inner = params[1]
      if (inner == null) return []
      if (Array.isArray(inner) && inner[0] === ',') return inner.slice(1)
      return [inner]
    }
    if (params[0] === ',') return params.slice(1)
  }
  return [params]
}

// Destructuring pattern as a parameter — `[a,b]` / `{a,b}` (optionally with a
// default). Plain `=` defaults and `...rest` are handled natively by emit, so
// they don't by themselves force lowering.
const isDestructurePat = p => Array.isArray(p) && (p[0] === '[]' || p[0] === '{}' || (p[0] === '=' && isDestructurePat(p[1])))

function lowerArguments(params, body) {
  // A function body that declares its own `arguments` local: it's an ordinary
  // variable, not the implicit object \u2014 rename it out of jz's reserved set,
  // no rest param synthesized.
  if (bindsArguments(body)) body = renameArguments(body, `\uE001arg${argsIdx++}`)
  const paramsNeedLowering = paramList(params).some(isDestructurePat)
  const usesArgsObj = usesArguments(params) || usesArguments(body)
  if (!paramsNeedLowering && !usesArgsObj) return [params, body]
  const name = `\uE001arg${argsIdx++}`
  const decls = []
  for (const [idx, param] of paramList(params).entries()) {
    if (Array.isArray(param) && param[0] === '...') {
      decls.push(['=', param[1], ['()', ['.', name, 'slice'], [null, idx]]])
      continue
    }
    if (Array.isArray(param) && param[0] === '=') {
      decls.push(['=', param[1], ['??', ['[]', name, [null, idx]], renameArguments(param[2], name)]])
      continue
    }
    decls.push(['=', param, ['[]', name, [null, idx]]])
  }
  const renamed = usesArgsObj ? renameArguments(body, name) : body
  return [['()', ['...', name]], decls.length ? prependParamDecls(['let', ...decls], renamed) : renamed]
}

function prependParamDecls(decl, body) {
  if (Array.isArray(body) && body[0] === '{}') {
    const inner = body[1]
    if (Array.isArray(inner) && inner[0] === ';') return ['{}', [';', decl, ...inner.slice(1)]]
    if (inner == null) return ['{}', decl]
    return ['{}', [';', decl, inner]]
  }
  if (Array.isArray(body) && (body[0] === ';' || body[0] === 'return')) return [';', decl, body]
  return ['{}', [';', decl, ['return', body]]]
}

const arrowParams = params => Array.isArray(params) && params[0] === '()' ? params : ['()', params]

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
// Out of scope for now (rejected with a clear message): `extends`/`super`,
// `static` members, getters/setters, computed/private-via-`#` member names are
// kept as the literal key string `#name` (jz allows it).
let classIdx = 0

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

function jzifyError(msg) { throw new Error(`jzify: ${msg}`) }

function lowerClass(name, heritage, body) {
  if (heritage != null) jzifyError('`class … extends …` is not supported yet — flatten the hierarchy or compose explicitly')
  let ctorParams = null, ctorBody = null
  const methods = [], fields = []
  for (const it of classBodyItems(body)) {
    if (typeof it === 'string') { fields.push([it, null]); continue }   // bare `x;`
    if (!Array.isArray(it)) continue
    if (it[0] === ':' && Array.isArray(it[2]) && it[2][0] === '=>') {
      if (typeof it[1] !== 'string') jzifyError('computed class member names are not supported')
      if (it[1] === 'constructor') { ctorParams = it[2][1]; ctorBody = it[2][2] }
      else methods.push([it[1], it[2][1], it[2][2]])
      continue
    }
    if (it[0] === '=') {
      const lhs = it[1]
      if (Array.isArray(lhs) && lhs[0] === 'static') jzifyError('`static` class members are not supported yet')
      if (typeof lhs !== 'string') jzifyError('computed/destructured class fields are not supported')
      fields.push([lhs, it[2]])
      continue
    }
    if (it[0] === 'get' || it[0] === 'set') jzifyError('class getters/setters are not supported — jz objects have no accessors')
    if (it[0] === 'static') jzifyError('`static` class members are not supported yet')
    jzifyError(`unsupported class member ${JSON.stringify(it).slice(0, 60)}`)
  }
  const self = `self${classIdx++}`
  const UNDEF = []                                  // jessie's node for `undefined`
  // A class member body from jessie is a bare statement / `;`-sequence — wrap it
  // in a `{}` block so the `=>` handler treats it as a function body, not an
  // expression (an unwrapped `;`-seq arrow body produces malformed IR).
  const block = b => Array.isArray(b) && b[0] === '{}' ? b : ['{}', b]
  const usesThis = n => n === 'this' || (Array.isArray(n) && n[0] !== 'function' && n[0] !== 'class' && n.some(usesThis))
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
  const stmts = [['let', ['=', self, lit]]]
  // `this`-dependent field initializers run, in declaration order, before the ctor.
  for (const [fname, init] of deferred)
    stmts.push(['=', ['.', self, fname], transform(renameThis(init, self))])
  if (ctorBody != null) {
    let cb = transform(renameThis(ctorBody, self))
    if (Array.isArray(cb) && cb[0] === '{}') cb = cb[1]
    if (Array.isArray(cb) && cb[0] === ';') stmts.push(...cb.slice(1).filter(s => s != null))
    else if (cb != null) stmts.push(cb)
  }
  stmts.push(['return', self])
  return ['=>', arrowParams(ctorParams ?? ['()', null]), ['{}', [';', ...stmts]]]
}

const handlers = {
  // Named IIFE: (function name(p){b})(a) → let name = arrow; name(a)
  '()'(callee, ...rest) {
    if (Array.isArray(callee) && callee[0] === '()' && Array.isArray(callee[1]) && callee[1][0] === 'function' && callee[1][1]) {
      const [, name, params, body] = callee[1]
      const [p2, b2] = lowerArguments(params, body)
      return [';', ['let', ['=', name, ['=>', arrowParams(p2), wrapArrowBody(b2)]]], ['()', name, ...rest.map(transform)]]
    }
  },

  // function → arrow. Named function expression desugars to IIFE so the name is
  // bound inside body per ES spec: `function f(){...f...}` → `(()=>{let f;f=arrow;return f})()`.
  // Statement-form named functions are hoisted by transformScope before reaching here.
  'function'(name, params, body) {
    const [p2, b2] = lowerArguments(params, body)
    const arrow = ['=>', p2, wrapArrowBody(b2)]
    if (name) {
      return ['()', ['()', ['=>', null, ['{}', [';',
        ['let', name],
        ['=', name, arrow],
        ['return', name]
      ]]]], null]
    }
    return arrow
  },

  '=>'(params, body) {
    const [p2, b2] = lowerArguments(params, body)
    return ['=>', p2, transform(b2)]
  },

  // Class in expression position → its factory arrow. (A named class
  // expression's own inner binding is dropped — rare; statement-form
  // `class C {}` is handled by transformScope, which keeps the binding.)
  'class'(name, heritage, body) { return lowerClass(name, heritage, body) },

  // `var` is hoisted away before transform reaches here. If one slips through
  // (e.g. raw subscript output without going via jzify entry/wrapArrowBody),
  // fall back to treating it as `let`.
  'var'(...args) {
    return ['let', ...args.map(transform)]
  },

  '='(lhs, rhs) {
    // Chained property assignment: a.x = a.y = v → a.y = v; a.x = v
    if (Array.isArray(lhs) && lhs[0] === '.' && Array.isArray(rhs) && rhs[0] === '=') {
      const targets = []
      let cur = ['=', lhs, rhs]
      while (Array.isArray(cur) && cur[0] === '=') { targets.push(cur[1]); cur = cur[2] }
      const val = transform(cur)
      const stmts = []
      for (let i = targets.length - 1; i >= 0; i--) stmts.push(['=', transform(targets[i]), val])
      return stmts.length === 1 ? stmts[0] : [';', ...stmts]
    }
  },

  'switch'(disc, ...cases) {
    const clean = cases.map(c => {
      if (c[0] === 'case' && Array.isArray(c[2]) && c[2][0] === ';') {
        const body = c[2].slice(1).filter(s => typeof s !== 'number')
        const stripped = stripTerminalSwitchBreak(body.length === 1 ? body[0] : [';', ...body])
        return ['case', c[1], stripped]
      }
      if (c[0] === 'default' && Array.isArray(c[1]) && c[1][0] === ';') {
        const body = c[1].slice(1).filter(s => s != null && typeof s !== 'number')
        const stripped = stripTerminalSwitchBreak(body.length === 1 ? body[0] : [';', ...body])
        return ['default', stripped]
      }
      if (c[0] === 'case') return ['case', c[1], stripTerminalSwitchBreak(c[2])]
      if (c[0] === 'default') return ['default', stripTerminalSwitchBreak(c[1])]
      return c
    })
    return transformSwitch(disc, clean)
  },

  // == → ===, != → !== (with prototype identity folding)
  '=='(a, b) { return isProto(a) || isProto(b) ? 1 : ['===', transform(a), transform(b)] },
  '!='(a, b) { return isProto(a) || isProto(b) ? 0 : ['!==', transform(a), transform(b)] },
  '==='(a, b) { if (isProto(a) || isProto(b)) return 1 },
  '!=='(a, b) { if (isProto(a) || isProto(b)) return 0 },

  // new → call (keep TypedArrays)
  'new'(ctor, ...cargs) {
    if (Array.isArray(ctor) && ctor[0] === '()' && Array.isArray(ctor[1]) && ctor[1][0] === '.') {
      return ['()', ['.', transform(['new', ctor[1][1]]), ctor[1][2]], ...ctor.slice(2).map(transform)]
    }
    const name = typeof ctor === 'string' ? ctor : (Array.isArray(ctor) && ctor[0] === '()' ? ctor[1] : null)
    if (typeof name === 'string' && (TYPED_ARRAYS.has(name) || name === 'Array')) return ['new', transform(ctor), ...cargs.map(transform)]
    if (Array.isArray(ctor) && ctor[0] === '()') return transform(ctor)
    // `new C(a)` → `C(a)`; `new C` (no parens) → `C()` — a 2-element `['()', X]`
    // is grouping parens, so a no-arg call needs the explicit `null` arg slot.
    return ['()', transform(ctor), ...(cargs.length ? cargs.map(transform) : [null])]
  },

  // instanceof → typeof / Array.isArray (jzify allows what strict mode prohibits)
  'instanceof'(val, ctor) {
    const t = transform(val)
    const name = typeof ctor === 'string' ? ctor : (Array.isArray(ctor) && ctor[0] === '()' ? ctor[1] : null)
    if (name === 'Array') return ['()', ['.', 'Array', 'isArray'], t]
    if (name === 'Object') return ['===', ['typeof', t], [null, 'object']]
    if (typeof name === 'string' && TYPED_ARRAYS.has(name)) return ['===', ['typeof', t], [null, 'object']]
    return ['===', ['typeof', t], [null, 'object']]
  },

  // do { body } while (cond) → let _once = true; while (_once || cond) { _once = false; body }
  // Avoids body duplication and preserves continue: `continue` jumps back to the
  // while condition after the one-shot flag has been cleared.
  'do'(body, cond) {
    const flag = `do${doIdx++}`
    return [';',
      ['let', ['=', flag, [null, true]]],
      ['while', ['||', flag, transform(cond)], ['{}', [';', ['=', flag, [null, false]], transform(body)]]]]
  },

  // Block body: recurse as scope for hoisting
  '{}'(...args) { return ['{}', ...args.map(a => transformScope(a) ?? a)] },

  // Export: recurse into exported declaration. Statement-form `export function name`
  // and `export default function name` must be hoisted as const-arrows — otherwise
  // the generic `function` handler wraps them in a named-IIFE (correct for *expressions*,
  // wrong for declarations), producing `export ['()', IIFE]` which has no exportable binding.
  'export'(inner) {
    if (Array.isArray(inner) && inner[0] === 'function' && inner[1]) {
      return ['export', hoistFnDecl(inner[1], inner[2], inner[3])]
    }
    // `export class C {}` → `export let C = factory`; named class keeps its binding.
    if (Array.isArray(inner) && inner[0] === 'class' && inner[1]) {
      return ['export', ['let', ['=', inner[1], lowerClass(inner[1], inner[2], inner[3])]]]
    }
    if (Array.isArray(inner) && inner[0] === 'default' && Array.isArray(inner[1]) && inner[1][0] === 'function' && inner[1][1]) {
      const decl = hoistFnDecl(inner[1][1], inner[1][2], inner[1][3])
      return [';', decl, ['export', ['default', inner[1][1]]]]
    }
    if (Array.isArray(inner) && inner[0] === 'default' && Array.isArray(inner[1]) && inner[1][0] === 'class' && inner[1][1]) {
      return [';', ['let', ['=', inner[1][1], lowerClass(inner[1][1], inner[1][2], inner[1][3])]], ['export', ['default', inner[1][1]]]]
    }
    return ['export', transform(inner)]
  },
}

/** Transform a single AST node recursively. */
function transform(node) {
  if (node == null || typeof node !== 'object' || !Array.isArray(node)) return node
  const [op, ...args] = node
  if (op == null) return node
  const h = handlers[op]
  // A handler that returns nullish (including no `return`) means "no rewrite at
  // this node" — fall through to a generic recurse. `??` (not `||`) so handlers
  // like `'==='` can legitimately return `0`.
  return (h && h(...args)) ?? [op, ...args.map(transform)]
}

// Esbuild emits a small ESM helper:
//
//   var __defProp = Object.defineProperty;
//   var __export = (target, all) => {
//     for (var name in all)
//       __defProp(target, name, { get: all[name], enumerable: true });
//   };
//   __export(src_exports, { default: () => value });
//   use(src_exports.default);
//
// Full descriptor/prototype semantics are outside JZ's fixed-shape object model.
// This pass instead recognizes the static helper pattern and rewrites reads of
// the synthetic export object to the real binding.
function foldStaticExportHelpers(ast) {
  const body = astSeq(ast)
  if (!body) return ast

  const defPropAliases = new Set()
  for (const stmt of body) {
    if (Array.isArray(stmt) && stmt[0] === '=' && typeof stmt[1] === 'string' && isObjectDefineProperty(stmt[2]))
      defPropAliases.add(stmt[1])
  }
  if (!defPropAliases.size) return ast

  const helperNames = new Set()
  for (const stmt of body) {
    if (Array.isArray(stmt) && stmt[0] === '=' && typeof stmt[1] === 'string' &&
        Array.isArray(stmt[2]) && stmt[2][0] === '=>' && containsDefinePropertyCall(stmt[2], defPropAliases))
      helperNames.add(stmt[1])
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

function astSeq(ast) {
  if (!Array.isArray(ast)) return null
  return ast[0] === ';' ? ast.slice(1).filter(Boolean) : [ast]
}

function isObjectDefineProperty(node) {
  return Array.isArray(node) && node[0] === '.' && node[1] === 'Object' && node[2] === 'defineProperty'
}

function isDefPropAliasAssign(stmt, aliases) {
  return Array.isArray(stmt) && stmt[0] === '=' && aliases.has(stmt[1]) && isObjectDefineProperty(stmt[2])
}

function isExportHelperAssign(stmt, helpers) {
  return Array.isArray(stmt) && stmt[0] === '=' && helpers.has(stmt[1])
}

function containsDefinePropertyCall(node, aliases) {
  if (!Array.isArray(node)) return false
  if (node[0] === '()' && (aliases.has(node[1]) || isObjectDefineProperty(node[1]))) return true
  for (let i = 1; i < node.length; i++) if (containsDefinePropertyCall(node[i], aliases)) return true
  return false
}

function staticExportCall(stmt, helpers) {
  if (!Array.isArray(stmt) || stmt[0] !== '()' || !helpers.has(stmt[1])) return null
  const args = callArgs(stmt.slice(2))
  if (args.length !== 2 || typeof args[0] !== 'string') return null
  const props = objectProps(args[1])
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

function callArgs(args) {
  if (args.length === 1 && Array.isArray(args[0]) && args[0][0] === ',') return args[0].slice(1)
  return args.filter(a => a != null)
}

function objectProps(node) {
  if (!Array.isArray(node) || node[0] !== '{}') return null
  const body = node[1]
  if (body == null) return []
  if (Array.isArray(body) && body[0] === ',') return body.slice(1)
  return [body]
}

function getterReturnExpr(node) {
  if (!Array.isArray(node) || node[0] !== '=>') return null
  const params = paramList(node[1])
  if (params.length !== 0) return null
  const body = node[2]
  if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === 'return') return body[1][1]
  if (Array.isArray(body) && body[0] === 'return') return body[1]
  return body
}

function replaceStaticExportReads(node, rewrites) {
  if (node == null || typeof node !== 'object' || !Array.isArray(node)) return node
  if ((node[0] === '.' || node[0] === '?.') && typeof node[1] === 'string' && typeof node[2] === 'string') {
    const value = rewrites.get(`${node[1]}.${node[2]}`)
    if (value) return cloneAst(value)
  }
  if (node[0] === ':') return [node[0], node[1], replaceStaticExportReads(node[2], rewrites)]
  return node.map((part, i) => i === 0 ? part : replaceStaticExportReads(part, rewrites))
}

function canonicalizeObjectIdioms(node) {
  if (node == null || typeof node !== 'object' || !Array.isArray(node)) return node

  const out = node.map((part, i) => i === 0 ? part : canonicalizeObjectIdioms(part))

  const hasOwnCall = objectHasOwnPropertyCall(out)
  if (hasOwnCall) return ['()', ['.', hasOwnCall.obj, 'hasOwnProperty'], hasOwnCall.key]

  if (out[0] === '&&') {
    const leftCtor = constructorIsObject(out[1])
    const rightKeys = objectKeysLengthZero(out[2])
    if (leftCtor && rightKeys && astEqual(leftCtor.obj, rightKeys.obj)) return out[2]

    const leftKeys = objectKeysLengthZero(out[1])
    const rightCtor = constructorIsObject(out[2])
    if (leftKeys && rightCtor && astEqual(leftKeys.obj, rightCtor.obj)) return out[1]
  }

  return out
}

function objectHasOwnPropertyCall(node) {
  if (!Array.isArray(node) || node[0] !== '()') return null
  const callee = node[1]
  if (!Array.isArray(callee) || callee[0] !== '.' || callee[2] !== 'call') return null
  if (!Array.isArray(callee[1]) || callee[1][0] !== '.' || callee[1][1] !== 'Object' || callee[1][2] !== 'hasOwnProperty') return null
  const args = callArgs(node.slice(2))
  if (args.length < 2) return null
  return { obj: args[0], key: args[1] }
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
  const args = callArgs(call.slice(2))
  return args.length === 1 ? args[0] : null
}

function isZeroLiteral(node) {
  return Array.isArray(node) && node[0] == null && node[1] === 0
}

function astEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function cloneAst(node) {
  if (node == null || typeof node !== 'object') return node
  if (!Array.isArray(node)) return node
  return node.map(cloneAst)
}

function stripTerminalSwitchBreak(body) {
  if (!Array.isArray(body)) return body
  if (body[0] === 'break') return null
  if (body[0] === '{}') {
    const inner = stripTerminalSwitchBreak(body[1])
    if (inner == null) return ['{}', [';']]
    return ['{}', Array.isArray(inner) && inner[0] === ';' ? inner : [';', inner]]
  }
  if (body[0] !== ';') return body

  const stmts = body.slice(1)
  if (Array.isArray(stmts.at(-1)) && stmts.at(-1)[0] === 'break') stmts.pop()
  return stmts.length === 0 ? null : stmts.length === 1 ? stmts[0] : [';', ...stmts]
}

/** Transform switch statement to if/else chain. */
let swIdx = 0
function transformSwitch(discriminant, cases) {
  const disc = transform(discriminant)
  const tmp = `\uE000sw${swIdx++}`

  // Collect case/default
  const stmts = [['let', ['=', tmp, disc]]]
  let chain = null

  for (let i = cases.length - 1; i >= 0; i--) {
    const c = cases[i]
    if (c[0] === 'default') {
      chain = transform(c[1])
    } else if (c[0] === 'case') {
      const cond = ['===', tmp, transform(c[1])]
      const body = transform(c[2])
      chain = chain != null ? ['if', cond, body, chain] : ['if', cond, body]
    }
  }
  if (chain) stmts.push(chain)
  return [';', ...stmts]
}
