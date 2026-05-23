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

import { warn } from '../src/ctx.js'
import { handlerArgs, JZ_BLOCK_OPS, LABEL_BODY_OPS, paramList } from '../src/ast.js'
import { JZIFY_CLASS_ERRORS as JC } from '../src/op-policy.js'
import { createNames } from './names.js'
import { foldStaticExportHelpers, foldStaticBundlerHelpers, canonicalizeObjectIdioms } from './bundler.js'
import { createSwitchLowering, normalizeCaseBody } from './switch.js'
import { createClassLowering } from './classes.js'

const ERROR_INSTANCEOF = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'URIError', 'EvalError'])

/**
 * Transform AST in-place. Returns transformed AST.
 * @param {Array} ast - subscript/jessie parsed AST
 * @returns {Array} Transformed AST
 */
const names = createNames()

let lowerClass, lowerObjectLiteralThis, lowerArrayConstructor, transformSwitch

export default function jzify(ast) {
  names.reset()
  // Hoist module-level vars: any `var x` inside nested blocks bubbles up.
  const hoisted = new Set()
  ast = hoistVars(ast, hoisted)
  if (hoisted.size) ast = prependDecls(ast, hoisted)
  return foldStaticBundlerHelpers(foldStaticExportHelpers(canonicalizeObjectIdioms(transformScope(ast))))
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
  // Labeled statement: recurse into the body so its `var`s hoist to the
  // enclosing function, not stop at the label.
  if (op === ':' && typeof node[1] === 'string') {
    return [':', node[1], hoistVars(node[2], names)]
  }
  if (op === '=' && Array.isArray(node[1]) && node[1][0] === 'var' && typeof node[1][1] === 'string' && node[1].length === 2) {
    names.add(node[1][1])
    return ['=', node[1][1], hoistVars(node[2], names)]
  }
  if (op === '=' && isDestructurePat(node[1])) {
    return ['=', hoistPattern(node[1], names), hoistVars(node[2], names)]
  }
  // For-head `;` is positional (init; cond; update), not a statement sequence.
  // Recurse into each slot but never filter nulls — empty slots are valid.
  if (op === 'for') {
    const head = node[1]
    let h2
    const normalizedHead = normalizeForDeclHead(head, names) || normalizeForCommaHead(head, names)
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
  if (op === 'let' || op === 'const') {
    const decls = [op]
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (Array.isArray(d) && d[0] === '=' && isDestructurePat(d[1])) {
        decls.push(['=', hoistPattern(d[1], names), hoistVars(d[2], names)])
      } else {
        decls.push(hoistVars(d, names))
      }
    }
    return decls
  }
  // Filter null returns from `;` sequences (bare-var no-ops). `{}` is left
  // to recurse normally — it may be either a block or an object literal,
  // and we don't want to clobber `['{}', null]` (empty object literal).
  if (op === ';') {
    const out = [op]
    for (let i = 1; i < node.length; i++) {
      const child = node[i]
      // A direct scope-child `var f = <arrow>` keeps its decl shape (→ a single
      // `let f = arrow`) instead of splitting into a hoisted `let f` + later
      // assignment. `var` and `let` are equivalent at a direct statement
      // position, and the single-decl form is what top-level-function
      // recognition keys on — bundlers (esbuild &c.) emit `var` for every
      // module binding, so without this every bundled function would degrade
      // to a closure value (and hit MAX_CLOSURE_ARITY). Redeclarations are
      // collapsed downstream by the binding-dedup pass.
      if (Array.isArray(child) && child[0] === 'var' && child.length === 2 &&
          Array.isArray(child[1]) && child[1][0] === '=' && typeof child[1][1] === 'string' &&
          Array.isArray(child[1][2]) && child[1][2][0] === '=>') {
        out.push(['let', ['=', child[1][1], hoistVars(child[1][2], names)]])
        continue
      }
      const c = hoistVars(child, names)
      if (c != null) out.push(c)
    }
    if (out.length === 1) return null
    if (out.length === 2) return out[1]
    return out
  }
  // Block body: recursing the inner `;` may collapse it to a bare expression
  // (e.g. `{ v + 1; }` → `['{}', ['+','v',1]]`), which prepare.js would then
  // mistake for an object literal. Re-wrap as a 1-stmt `;` if the inner was
  // block-shaped going in but collapsed to a non-statement-op expression.
  if (op === '{}' && node.length === 2) {
    const inner = node[1]
    const wasBlock = inner != null && Array.isArray(inner) && JZ_BLOCK_OPS.has(inner[0])
    const t = hoistVars(inner, names)
    if (!wasBlock || t == null) return ['{}', t]
    const stayed = Array.isArray(t) && JZ_BLOCK_OPS.has(t[0])
    return ['{}', stayed ? t : [';', t]]
  }
  const out = new Array(node.length)
  out[0] = op
  for (let i = 1; i < node.length; i++) out[i] = hoistVars(node[i], names)
  return out
}

function hoistPattern(node, names) {
  if (node == null || !Array.isArray(node)) return node
  const op = node[0]
  if (op === '=') return ['=', hoistPattern(node[1], names), hoistVars(node[2], names)]
  if (op === ':') return [':', hoistVars(node[1], names), hoistPattern(node[2], names)]
  if (op === '...') return ['...', hoistPattern(node[1], names)]
  if (op === '[]' || op === '{}' || op === ',') return [op, ...node.slice(1).map(n => hoistPattern(n, names))]
  return hoistVars(node, names)
}

function transformPattern(node) {
  if (node == null || !Array.isArray(node)) return node
  const op = node[0]
  if (op === '=') return ['=', transformPattern(node[1]), transform(node[2])]
  if (op === ':') return [':', transform(node[1]), transformPattern(node[2])]
  if (op === '...') return ['...', transformPattern(node[1])]
  if (op === '[]' || op === '{}' || op === ',') return [op, ...node.slice(1).map(transformPattern)]
  return transform(node)
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
  if (!Array.isArray(head) || (head[0] !== 'var' && head[0] !== 'let' && head[0] !== 'const')) return null
  const kind = head[0]
  if (head.length === 2) {
    const expr = head[1]
    if (!Array.isArray(expr)) return null
    if (expr.length >= 3 && Array.isArray(expr[1]) &&
        (expr[1][0] === 'in' || expr[1][0] === 'of') && typeof expr[1][1] === 'string') {
      const iter = expr[1]
      return [iter[0], normalizeForDecl(kind, iter[1], names), hoistVars([expr[0], iter[2], ...expr.slice(2)], names)]
    }
    return null
  }
  // Comma Expression in a for-in/of head: subscript parses with no for-head
  // context, so `for (let x in A, B)` becomes a multi-declarator `let` whose
  // tail declarators are really the rest of a comma Expression. Fold them back
  // into the iterated source so the comma operator evaluates them in order.
  if (head.length > 2 && Array.isArray(head[1]) &&
      (head[1][0] === 'in' || head[1][0] === 'of') && typeof head[1][1] === 'string') {
    const iter = head[1]
    return [iter[0], normalizeForDecl(kind, iter[1], names), hoistVars([',', iter[2], ...head.slice(2)], names)]
  }
  return null
}

// Bare-LHS counterpart of the above: `for (x in A, B)` (no declaration) parses
// as a comma expression whose first operand is the for-in/of head.
function normalizeForCommaHead(head, names) {
  if (!Array.isArray(head) || head[0] !== ',' || head.length < 3) return null
  const iter = head[1]
  if (!Array.isArray(iter) || (iter[0] !== 'in' && iter[0] !== 'of') || typeof iter[1] !== 'string') return null
  return [iter[0], iter[1], hoistVars([',', iter[2], ...head.slice(2)], names)]
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
  const [p2, b2] = lowerArguments(params, functionBodyBlock(body))
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
  // Per-declarator name — bare `x` or `['=', x, init]`; null for patterns.
  const declName = d => typeof d === 'string' ? d
    : Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' ? d[1] : null
  const seen = new Set(), out = []
  for (const s of stmts) {
    if (!Array.isArray(s) || (s[0] !== 'let' && s[0] !== 'const' && s[0] !== 'var')) { out.push(s); continue }
    // Walk every declarator: a multi-name bare `let` (the var-hoist
    // `prependDecls` output) can carry a name already bound by a hoisted
    // function `const`. Keep only fresh declarators; a redeclaration with an
    // initializer survives as a plain assignment.
    const keep = [s[0]], reassign = []
    for (let i = 1; i < s.length; i++) {
      const d = s[i], n = declName(d)
      if (n == null) { keep.push(d); continue }
      if (seen.has(n)) { if (Array.isArray(d) && d[0] === '=') reassign.push(['=', d[1], d[2]]) }
      else { seen.add(n); keep.push(d) }
    }
    if (keep.length > 1) out.push(keep)
    for (const r of reassign) out.push(r)
  }
  return out
}

/** Wrap function body for arrow conversion.
 *  Produces the canonical block form `['{}', [';', ...stmts]]`: a `{}` whose
 *  sole child is a `;`-list. A bare single statement (`['{}', stmt]`, from the
 *  parser eliding the `;` wrapper) would otherwise be mistaken for an object
 *  literal, so it is `;`-wrapped here too — `function`→arrow conversions bypass
 *  the `=>` transform handler and must normalize their own bodies. */
function wrapArrowBody(body) {
  const t = transformScope(body)
  if (!Array.isArray(t)) return ['{}', [';', t]]
  if (t[0] === ';') return ['{}', t]
  if (t[0] !== '{}') return ['{}', [';', t]]
  if (t.length === 2 && !(Array.isArray(t[1]) && t[1][0] === ';')) return ['{}', [';', t[1]]]
  return t
}

function functionBodyBlock(body) {
  if (Array.isArray(body) && body[0] === '{}') return body
  if (Array.isArray(body) && body[0] === ';') return ['{}', body]
  return ['{}', [';', body]]
}

/** Prototype identity check: X.prototype.Y */
const isProto = n => Array.isArray(n) && n[0] === '.' && Array.isArray(n[1]) && n[1][0] === '.' && n[1][2] === 'prototype'

/** `obj.M <eq> Ctor.prototype.M` is not a real reference comparison — jz has no
 *  prototype objects — it asks whether `obj` overrides `M`, which is exactly
 *  `obj.hasOwnProperty('M')`. Returns that call node when the shape matches
 *  (a member access `obj.M` against a same-named prototype method), else null. */
const methodOverrideHasOwn = (a, b) => {
  const proto = isProto(a) ? a : isProto(b) ? b : null
  if (!proto) return null
  const other = proto === a ? b : a
  if (!Array.isArray(other) || other[0] !== '.' || other[2] !== proto[2]) return null
  return ['()', ['.', transform(other[1]), 'hasOwnProperty'], [null, proto[2]]]
}

const TYPED_ARRAYS = new Set(['Float64Array','Float32Array','Int32Array','Uint32Array',
  'Int16Array','Uint16Array','Int8Array','Uint8Array',
  'ArrayBuffer','BigInt64Array','BigUint64Array','DataView'])

/** Statically discriminate `x instanceof Ctor` when the LHS's syntactic shape
 *  already pins down its runtime type. Returns true/false or null (unknown).
 *  Matches the lhs forms a user might plausibly write: literal arrays, object
 *  literals, string/number literals, and `new C(...)` whose ctor name is known.
 *  Stays conservative — anything else returns null and falls back to the runtime
 *  predicate so behavior is never silently changed. */
function staticInstanceofFold(val, ctor) {
  if (typeof ctor !== 'string' || !Array.isArray(val)) return null
  // Unwrap grouping parens: `(expr)` parses as `['()', expr]`
  if (val[0] === '()' && val.length === 2) return staticInstanceofFold(val[1], ctor)
  // Array literal: `[1,2,3]` → `['[]', [',', …]]` (or `['[]']` for empty array)
  if (val[0] === '[]' && val.length <= 2) return ctor === 'Array' || ctor === 'Object'
  // Object literal: `{a:1}` → `['{}', [':', …], …]`
  if (val[0] === '{}') return ctor === 'Object'
  // Regex literal: `/x/` → `['//', …]`
  if (val[0] === '//') return ctor === 'RegExp' || ctor === 'Object'
  // `new C(...)` — `['new', ['()', 'C', args]]` or `['new', 'C']`
  if (val[0] === 'new') {
    const inner = val[1]
    const cname = typeof inner === 'string' ? inner
      : (Array.isArray(inner) && inner[0] === '()' && typeof inner[1] === 'string') ? inner[1]
      : null
    if (cname) return cname === ctor || (cname !== 'Object' && ctor === 'Object')
  }
  // Bare primitive: `[null, v]` where v is a primitive — never an instance per JS spec.
  if (val[0] == null && val.length === 2) {
    const v = val[1]
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null) return false
  }
  return null
}

// `arguments` lowering: regular `function` has implicit `arguments`; arrow doesn't.
// jzify converts function → arrow, so any `arguments` use must be rewritten to a rest param.
// Arrow functions inherit `arguments` from enclosing function — don't stop at '=>'.
// Nested `function` introduces its own `arguments` — stop recursion there.

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


// Destructuring pattern as a parameter — `[a,b]` / `{a,b}` (optionally with a
// default). Plain `=` defaults and `...rest` are handled natively by emit, so
// they don't by themselves force lowering.
const isDestructurePat = p => Array.isArray(p) && (p[0] === '[]' || p[0] === '{}' || (p[0] === '=' && isDestructurePat(p[1])))

function lowerArguments(params, body) {
  // A function body that declares its own `arguments` local: it's an ordinary
  // variable, not the implicit object \u2014 rename it out of jz's reserved set,
  // no rest param synthesized.
  if (bindsArguments(body)) body = renameArguments(body, names.arg())
  const paramsNeedLowering = paramList(params).some(isDestructurePat)
  const usesArgsObj = usesArguments(params) || usesArguments(body)
  if (!paramsNeedLowering && !usesArgsObj) return [params, body]
  const name = names.arg()
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
// A method body from jessie is a bare statement / `;`-sequence — wrap it in a
// `{}` block so the `=>` handler treats it as a function body, not an expression
// (an unwrapped `;`-seq arrow body produces malformed IR).
const block = b => Array.isArray(b) && b[0] === '{}' ? b : ['{}', b]

const handlers = {
  // Named IIFE: (function name(p){b})(a) → let name = arrow; name(a)
  '()'(callee, ...rest) {
    if (callee === 'Array') {
      const lit = lowerArrayConstructor(rest[0])
      if (lit) return lit
    }
    if (Array.isArray(callee) && callee[0] === '()' && Array.isArray(callee[1]) && callee[1][0] === 'function' && callee[1][1]) {
      const [, name, params, body] = callee[1]
      const [p2, b2] = lowerArguments(params, functionBodyBlock(body))
      return [';', ['let', ['=', name, ['=>', arrowParams(p2), wrapArrowBody(b2)]]], ['()', name, ...rest.map(transform)]]
    }
  },

  // function → arrow. Named function expression desugars to IIFE so the name is
  // bound inside body per ES spec: `function f(){...f...}` → `(()=>{let f;f=arrow;return f})()`.
  // Statement-form named functions are hoisted by transformScope before reaching here.
  'function'(name, params, body) {
    const [p2, b2] = lowerArguments(params, functionBodyBlock(body))
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
    // The subscript parser elides the `[';', stmt, null]` wrapper inside an
    // arrow's `{` block when the block holds a single statement — the result
    // `['{}', stmt]` is syntactically identical to an object-literal shape, and
    // downstream `{}` handlers can no longer tell them apart. JS grammar makes
    // it unambiguous: `=>` followed by `{` is always a block (use `=> ({...})`
    // for an object return), so coerce every single-statement body to the
    // canonical `['{}', [';', stmt]]` block form — `;`-wrapped, never bare.
    let b = body
    if (Array.isArray(b) && b[0] === '{}' && b.length === 2) {
      const inner = b[1]
      if (inner != null && !(Array.isArray(inner) && inner[0] === ';')) {
        b = ['{}', [';', inner]]
      }
    }
    const [p2, b2] = lowerArguments(params, b)
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

  ':'(label, body) {
    if (typeof label === 'string' && Array.isArray(body) && LABEL_BODY_OPS.has(body[0]))
      return ['label', label, transform(body)]
  },

  '='(lhs, rhs) {
    if (isDestructurePat(lhs)) return ['=', transformPattern(lhs), transform(rhs)]
  },

  'switch'(disc, ...cases) {
    const clean = cases.map(c => {
      if (c[0] === 'case') return ['case', c[1], normalizeCaseBody(c[2])]
      if (c[0] === 'default') return ['default', normalizeCaseBody(c[1])]
      return c
    })
    return transformSwitch(disc, clean)
  },

  // Equality keeps the JS loose/strict distinction (jz core now lowers both):
  // `==`/`!=` stay loose, `===`/`!==` stay strict. A comparison against a prototype
  // object folds to a boolean — jz has no prototype objects, so identity against one
  // is decided statically. The one exception is `obj.M <eq> Ctor.prototype.M`: that
  // probes whether `obj` overrides the builtin `M`, so it lowers to a runtime
  // `obj.hasOwnProperty('M')` (equal ⇒ not overridden, unequal ⇒ overridden).
  '=='(a, b) { const own = methodOverrideHasOwn(a, b); if (own) return ['!', own]; return isProto(a) || isProto(b) ? 1 : ['==', transform(a), transform(b)] },
  '!='(a, b) { const own = methodOverrideHasOwn(a, b); if (own) return own; return isProto(a) || isProto(b) ? 0 : ['!=', transform(a), transform(b)] },
  '==='(a, b) { const own = methodOverrideHasOwn(a, b); if (own) return ['!', own]; if (isProto(a) || isProto(b)) return 1 },
  '!=='(a, b) { const own = methodOverrideHasOwn(a, b); if (own) return own; if (isProto(a) || isProto(b)) return 0 },

  // new → call (keep TypedArrays)
  'new'(ctor, ...cargs) {
    if (Array.isArray(ctor) && ctor[0] === '()' && ctor[1] === 'Array') {
      const lit = lowerArrayConstructor(ctor[2])
      if (lit) return lit
    }
    const name = typeof ctor === 'string' ? ctor : (Array.isArray(ctor) && ctor[0] === '()' ? ctor[1] : null)
    if (typeof name === 'string' && (TYPED_ARRAYS.has(name) || name === 'Array' || name === 'RegExp')) return ['new', transform(ctor), ...cargs.map(transform)]
    if (Array.isArray(ctor) && ctor[0] === '()') return transform(ctor)
    // `new C(a)` → `C(a)`; `new C` (no parens) → `C()` — a 2-element `['()', X]`
    // is grouping parens, so a no-arg call needs the explicit `null` arg slot.
    return ['()', transform(ctor), ...(cargs.length ? cargs.map(transform) : [null])]
  },

  // instanceof → typeof / Array.isArray / __is_* helpers. jzify lets us preserve
  // constructor identity that strict-mode `instanceof` discards — Map, Set, and
  // TypedArrays get dedicated typed predicates (__is_map / __is_set / __is_typed)
  // that both compile to a runtime __ptr_type check and feed extractRefinements
  // for downstream method-dispatch elision (e.g. `if (x instanceof Map) x.has(k)`
  // resolves to __map_has, not the default __set_has fallback). Date / RegExp /
  // Object stay on the weak typeof-object lowering — they share PTR.OBJECT and
  // the JS runtime offers no cheaper discrimination.
  'instanceof'(val, ctor) {
    const t = transform(val)
    const name = typeof ctor === 'string' ? ctor : (Array.isArray(ctor) && ctor[0] === '()' ? ctor[1] : null)
    // Static fold: literal shape of LHS already discriminates against the constructor.
    const fold = staticInstanceofFold(val, name)
    if (fold != null) return [null, fold]
    if (typeof name === 'string' && ERROR_INSTANCEOF.has(name)) {
      warn('untagged-instanceof',
        `\`instanceof ${name}\` does not discriminate thrown values in jz — errors are untagged; inspect the message or value instead`,
        { loc: Array.isArray(val) ? val.loc : null })
    }
    if (name === 'Array') return ['()', ['.', 'Array', 'isArray'], t]
    if (name === 'Map') return ['()', '__is_map', t]
    if (name === 'Set') return ['()', '__is_set', t]
    if (typeof name === 'string' && TYPED_ARRAYS.has(name) && name !== 'ArrayBuffer' && name !== 'DataView')
      return ['()', '__is_typed', t]
    // Object / ArrayBuffer / DataView / RegExp / Date / unknown: weak typeof-object check.
    return ['===', ['typeof', t], [null, 'object']]
  },

  // do { body } while (cond) → let _once = true; while (_once || cond) { _once = false; body }
  // Avoids body duplication and preserves continue: `continue` jumps back to the
  // while condition after the one-shot flag has been cleared.
  'do'(body, cond) {
    const flag = names.doFlag()
    return [';',
      ['let', ['=', flag, [null, true]]],
      ['while', ['||', flag, transform(cond)], ['{}', [';', ['=', flag, [null, false]], transform(body)]]]]
  },

  // Block body: recurse as scope for hoisting. transformScope reduces a single-statement
  // sequence to its bare element; if the input WAS block-shaped (`;` list or a single
  // statement op), we re-wrap the collapsed result in `[';', ...]` so prepare.js keeps
  // routing the `{}` through the block branch instead of mistaking it for `{ expr }`.
  '{}'(...args) {
    const loweredObject = lowerObjectLiteralThis(args)
    if (loweredObject) return loweredObject

    return ['{}', ...args.map((a, i) => {
      const t = transformScope(a) ?? a
      if (i !== 0 || a == null) return t
      const blockIn = Array.isArray(a) && JZ_BLOCK_OPS.has(a[0])
      if (!blockIn || t == null) return t
      // transformScope collapses a single-statement `;`-list to its bare element;
      // re-wrap so the block always stays `['{}', [';', ...]]`. The `;` is the
      // only reliable block marker — a bare statement op can desugar to an
      // expression op downstream (postfix `c++` → `['-', ...]`) and lose its
      // block identity, leaving `['{}', expr]` mistakable for an object literal.
      return Array.isArray(t) && t[0] === ';' ? t : [';', t]
    })]
  },

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

;({ lowerClass, lowerObjectLiteralThis, lowerArrayConstructor } = createClassLowering({ transform, names, JC }))
transformSwitch = createSwitchLowering(transform, names)
