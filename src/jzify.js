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
  objThisIdx = 0
  staticClassIdx = 0
  classBaseIdx = 0
  // Hoist module-level vars: any `var x` inside nested blocks bubbles up.
  const names = new Set()
  ast = hoistVars(ast, names)
  if (names.size) ast = prependDecls(ast, names)
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

const TYPED_ARRAYS = new Set(['Float64Array','Float32Array','Int32Array','Uint32Array',
  'Int16Array','Uint16Array','Int8Array','Uint8Array',
  'ArrayBuffer','BigInt64Array','BigUint64Array','DataView'])

// Block-shape ops used to detect "this `{}` is a block body, not an object literal".
// Mirrors analyze.STMT_OPS — kept inline so jzify stays self-contained.
const JZ_BLOCK_OPS = new Set([';', 'let', 'const', 'var', 'return', 'if', 'for', 'for-in', 'for-of',
  'while', 'do', 'break', 'continue', 'switch', 'throw', 'try', 'catch', 'finally',
  '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '>>=', '<<=', '>>>=', '||=', '&&=', '??=',
  '++', '--', '()', 'function', 'class', 'import', 'export', 'label'])
const LABEL_BODY_OPS = new Set([';', 'if', 'for', 'for-in', 'for-of', 'while', 'do', 'switch', 'try', 'throw'])

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
// A method body from jessie is a bare statement / `;`-sequence — wrap it in a
// `{}` block so the `=>` handler treats it as a function body, not an expression
// (an unwrapped `;`-seq arrow body produces malformed IR).
const block = b => Array.isArray(b) && b[0] === '{}' ? b : ['{}', b]

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
let classIdx = 0
let objThisIdx = 0
let staticClassIdx = 0
let classBaseIdx = 0
const DEFAULT_DERIVED_CTOR_ARITY = 8

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

function objectLiteralProps(args) {
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
  const props = objectLiteralProps(args)
  if (props.length === 0 || !props.some(objectMethodUsesThis)) return null
  if (!props.every(p => Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string')) return null

  const self = `obj${objThisIdx++}`
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
      if (key == null) jzifyError('non-constant computed class member names are not supported')
      if (key === 'constructor') { ctorParams = it[2][1]; ctorBody = it[2][2] }
      else methods.push([key, it[2][1], it[2][2]])
      continue
    }
    if (it[0] === '=') {
      const lhs = it[1]
      if (Array.isArray(lhs) && lhs[0] === 'static') {
        const key = constStringKey(lhs[1])
        if (key == null) jzifyError('non-constant computed static class fields are not supported')
        statics.push([key, it[2]])
        continue
      }
      const key = constStringKey(lhs)
      if (key == null) jzifyError('non-constant computed/destructured class fields are not supported')
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
      if (key == null) jzifyError('non-constant computed static class member names are not supported')
      statics.push([key, it[1][2], true])
      continue
    }
    if (it[0] === 'get' || it[0] === 'set') jzifyError('class getters/setters are not supported — jz objects have no accessors')
    if (it[0] === 'static') jzifyError('`static` class members are not supported yet')
    jzifyError(`unsupported class member ${JSON.stringify(it).slice(0, 60)}`)
  }
  const superMethods = heritage == null ? new Set() : new Set([
    ...collectSuperMethodCalls(ctorBody),
    ...fields.flatMap(([, init]) => init == null ? [] : [...collectSuperMethodCalls(init)]),
    ...methods.flatMap(([, , mbody]) => [...collectSuperMethodCalls(mbody)])
  ])
  if (heritage != null) {
    const dummySuperVars = new Map([...superMethods].map((k, i) => [k, `super_${i}`]))
    const unsupportedSuperProp = node => node != null && hasSuperProp(rewriteSuperMethodCalls(node, dummySuperVars))
    if (
      unsupportedSuperProp(ctorBody) ||
      fields.some(([, init]) => unsupportedSuperProp(init)) ||
      methods.some(([, , mbody]) => unsupportedSuperProp(mbody))
    )
      jzifyError('`super` property access is not supported yet')
  }
  const self = `self${classIdx++}`
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
  const baseRef = heritage == null ? null : dynamicBase ? `base${classBaseIdx++}` : heritage
  const stmts = []
  if (heritage != null) {
    const split = splitCtorSuper(ctorBody)
    ctorBody = split.body
    const defaultArgs = ctorParams == null
      ? Array.from({ length: DEFAULT_DERIVED_CTOR_ARITY }, (_, i) => `superArg${classIdx}_${i}`)
      : null
    const baseArgs = split.args ?? (defaultArgs ? [defaultArgs.length === 1 ? defaultArgs[0] : [',', ...defaultArgs]] : paramList(ctorParams))
    stmts.push(['let', ['=', self, ['()', baseRef, ...baseArgs.map(transform)]]])
    const superMethodVars = new Map()
    let superIdx = 0
    for (const mname of superMethods) {
      const v = `super${classIdx}_${superIdx++}`
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

  const cls = name || `class${staticClassIdx++}`
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

  // Equality keeps the JS loose/strict distinction (jz core now lowers both):
  // `==`/`!=` stay loose, `===`/`!==` stay strict. A comparison against a prototype
  // object (e.g. `x.constructor === Object`) folds to a boolean — jz has no
  // prototype objects, so identity against one is decided statically.
  '=='(a, b) { return isProto(a) || isProto(b) ? 1 : ['==', transform(a), transform(b)] },
  '!='(a, b) { return isProto(a) || isProto(b) ? 0 : ['!=', transform(a), transform(b)] },
  '==='(a, b) { if (isProto(a) || isProto(b)) return 1 },
  '!=='(a, b) { if (isProto(a) || isProto(b)) return 0 },

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
    const flag = `do${doIdx++}`
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
function foldStaticBundlerHelpers(ast) {
  const body = astSeq(ast)
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
        astSome(b[1], n => n === 'default') && astSome(b[1], n => n === '__esModule'))
      interopHelpers.add(b[0])

  // Bindings produced by an interop-helper call: name -> wrapped module expression.
  const interopBindings = new Map()
  for (const b of binds)
    if (b && Array.isArray(b[1]) && b[1][0] === '()' && interopHelpers.has(b[1][1])) {
      const args = callArgs(b[1].slice(2))
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
    if (!(b && synthetic(b[0]))) collectRefs(stmt, live)
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

// Deep `some` over AST children (skips the op slot, so op names never match).
function astSome(node, pred) {
  if (pred(node)) return true
  if (!Array.isArray(node)) return false
  for (let i = 1; i < node.length; i++) if (astSome(node[i], pred)) return true
  return false
}

// Does `node` contain a `()` call whose string callee satisfies `ok`?
const containsCall = (node, ok) =>
  astSome(node, n => Array.isArray(n) && n[0] === '()' && typeof n[1] === 'string' && ok(n[1]))

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
    const args = callArgs(node.slice(2))

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
  if (typeof node === 'string' && bindings.has(node)) return cloneAst(bindings.get(node))
  if (!Array.isArray(node)) return node
  if (node[0] === '=' && typeof node[1] === 'string') return ['=', node[1], replaceInteropReads(node[2], bindings)]
  if (node[0] === 'let' || node[0] === 'const' || node[0] === 'var')
    return [node[0], ...node.slice(1).map(decl =>
      Array.isArray(decl) && decl[0] === '=' ? ['=', decl[1], replaceInteropReads(decl[2], bindings)] : decl)]
  if ((node[0] === '.' || node[0] === '?.') && typeof node[1] === 'string' && typeof node[2] === 'string' && bindings.has(node[1])) {
    const mod = cloneAst(bindings.get(node[1]))
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
  const key = stringLiteral(keyExpr)
  const props = objectProps(desc)
  if (typeof key !== 'string' || !props) return undefined
  if (key === '__esModule') return null
  const prop = name => props.find(p => Array.isArray(p) && p[0] === ':' && p[1] === name)?.[2]
  const value = prop('value')
  if (value !== undefined) return ['=', ['.', obj, key], value]
  const got = getterReturnExpr(prop('get'))
  return got !== null ? ['=', ['.', obj, key], got] : undefined
}

function stringLiteral(node) {
  return Array.isArray(node) && node[0] == null && typeof node[1] === 'string' ? node[1] : null
}

// Identifier references in `node`, excluding declaration names, member property
// names and object keys — enough to decide whether a synthetic binding is live.
function collectRefs(node, out) {
  if (typeof node === 'string') return void out.add(node)
  if (!Array.isArray(node)) return
  if (node[0] === 'let' || node[0] === 'const' || node[0] === 'var') {
    for (let i = 1; i < node.length; i++)
      if (Array.isArray(node[i]) && node[i][0] === '=') collectRefs(node[i][2], out)
  } else if ((node[0] === '.' || node[0] === '?.') && typeof node[2] === 'string') {
    collectRefs(node[1], out)
  } else if (node[0] === ':') {
    collectRefs(node[2], out)
  } else {
    for (let i = 1; i < node.length; i++) collectRefs(node[i], out)
  }
}

function astSeq(ast) {
  if (!Array.isArray(ast)) return null
  return ast[0] === ';' ? ast.slice(1).filter(Boolean) : [ast]
}

function isObjectDefineProperty(node) {
  return Array.isArray(node) && node[0] === '.' && node[1] === 'Object' && node[2] === 'defineProperty'
}

/** Unwrap an esbuild module binding to `[name, init]`. After hoistVars, a binding
 *  reaches this pass either split into a bare `['=', name, init]` (RHS hoisted out
 *  as a separate `let name;`) or kept as a single `['let', ['=', name, init]]` decl
 *  (arrow RHS — see the `;` handler in hoistVars). The fold keys on name/init,
 *  so it must see through both shapes. */
function bindingOf(stmt) {
  if (!Array.isArray(stmt)) return null
  if (stmt[0] === '=' && typeof stmt[1] === 'string') return [stmt[1], stmt[2]]
  if ((stmt[0] === 'let' || stmt[0] === 'const' || stmt[0] === 'var') && stmt.length === 2 &&
      Array.isArray(stmt[1]) && stmt[1][0] === '=' && typeof stmt[1][1] === 'string')
    return [stmt[1][1], stmt[1][2]]
  return null
}

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
  if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === ';' &&
      Array.isArray(body[1][1]) && body[1][1][0] === 'return') return body[1][1][1]
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

  const mapString = arrayMapStringCallback(out)
  if (mapString) return mapString

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

function arrayMapStringCallback(node) {
  if (!Array.isArray(node) || node[0] !== '()') return null
  const callee = node[1]
  if (!Array.isArray(callee) || callee[0] !== '.' || callee[2] !== 'map') return null
  const args = callArgs(node.slice(2))
  if (args.length !== 1 || args[0] !== 'String') return null
  return ['()', callee, ['=>', 'value', ['()', 'String', 'value']]]
}

function objectHasOwnPropertyCall(node) {
  if (!Array.isArray(node) || node[0] !== '()') return null
  const callee = node[1]
  if (!Array.isArray(callee) || callee[0] !== '.' || callee[2] !== 'call') return null
  if (!isObjectHasOwnPropertyRef(callee[1])) return null
  const args = callArgs(node.slice(2))
  if (args.length < 2) return null
  return { obj: args[0], key: args[1] }
}

function isObjectHasOwnPropertyRef(node) {
  if (!Array.isArray(node) || node[0] !== '.' || node[2] !== 'hasOwnProperty') return false
  if (node[1] === 'Object') return true
  return Array.isArray(node[1]) && node[1][0] === '.' && node[1][1] === 'Object' && node[1][2] === 'prototype'
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

const SWITCH_BREAK_BOUNDARIES = new Set(['for', 'for-in', 'for-of', 'while', 'do', 'switch', '=>', 'function', 'class'])

function hasOwnSwitchBreak(node) {
  if (!Array.isArray(node)) return false
  if (node[0] === 'break') return true
  if (SWITCH_BREAK_BOUNDARIES.has(node[0])) return false
  for (let i = 1; i < node.length; i++) if (hasOwnSwitchBreak(node[i])) return true
  return false
}

function rewriteSwitchBreaks(node, flag) {
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op === 'break') return ['=', flag, [null, true]]
  if (SWITCH_BREAK_BOUNDARIES.has(op)) return node

  if (op === ';') {
    const out = []
    const stmts = node.slice(1)
    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i]
      out.push(rewriteSwitchBreaks(stmt, flag))
      if (hasOwnSwitchBreak(stmt) && i < stmts.length - 1) {
        const tail = rewriteSwitchBreaks([';', ...stmts.slice(i + 1)], flag)
        out.push(['if', ['!', flag], tail])
        break
      }
    }
    return out.length === 0 ? null : out.length === 1 ? out[0] : [';', ...out]
  }

  return node.map((part, i) => i === 0 ? part : rewriteSwitchBreaks(part, flag))
}

/** Transform switch statement to if/else chain. */
let swIdx = 0
function transformSwitch(discriminant, cases) {
  const disc = transform(discriminant)
  const tmp = `\uE000sw${swIdx++}`
  const needsBreakFlag = cases.some(c => hasOwnSwitchBreak(c[0] === 'case' ? c[2] : c[1]))
  const brk = needsBreakFlag ? `\uE000swbrk${swIdx++}` : null

  // Collect case/default
  const stmts = [['let', ['=', tmp, disc]]]
  if (brk) stmts.push(['let', ['=', brk, [null, false]]])
  let chain = null

  for (let i = cases.length - 1; i >= 0; i--) {
    const c = cases[i]
    if (c[0] === 'default') {
      const body = transform(c[1])
      chain = brk ? rewriteSwitchBreaks(body, brk) : body
    } else if (c[0] === 'case') {
      const cond = ['===', tmp, transform(c[1])]
      const body = transform(c[2])
      const lowered = brk ? rewriteSwitchBreaks(body, brk) : body
      chain = chain != null ? ['if', cond, lowered, chain] : ['if', cond, lowered]
    }
  }
  if (chain) stmts.push(chain)
  return [';', ...stmts]
}
