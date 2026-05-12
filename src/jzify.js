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
  // Hoist module-level vars: any `var x` inside nested blocks bubbles up.
  const names = new Set()
  ast = hoistVars(ast, names)
  if (names.size) ast = prependDecls(ast, names)
  return foldStaticExportHelpers(transformScope(ast))
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
    if (Array.isArray(head) && head[0] === 'var' && Array.isArray(head[1]) &&
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
    const all = [...imports, ...hoisted, ...nonImports]
    return all.length === 0 ? null : all.length === 1 ? all[0] : [';', ...all]
  }

  return transform(node)
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
  const paramsNeedLowering = paramList(params).some(isDestructurePat)
  if (!paramsNeedLowering && !usesArguments(params) && !usesArguments(body)) return [params, body]
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
  const renamed = renameArguments(body, name)
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
        return ['case', c[1], body.length === 1 ? body[0] : [';', ...body]]
      }
      if (c[0] === 'default' && Array.isArray(c[1]) && c[1][0] === ';') {
        const body = c[1].slice(1).filter(s => s != null && typeof s !== 'number')
        return ['default', body.length === 1 ? body[0] : [';', ...body]]
      }
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
    return ['()', transform(ctor), ...cargs.map(transform)]
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

  '[]'(...args) {
    if (args.length !== 1) return
    const fix = (node) => {
      if (Array.isArray(node) && node[0] === '?' && Array.isArray(node[1]) && node[1][0] === '...') {
        return ['...', ['?', node[1][1], node[2], node[3]]]
      }
      return node
    }
    const body = args[0]
    if (Array.isArray(body) && body[0] === ',') return ['[]', [',', ...body.slice(1).map(x => transform(fix(x)))]]
    return ['[]', transform(fix(body))]
  },

  // Export: recurse into exported declaration. Statement-form `export function name`
  // and `export default function name` must be hoisted as const-arrows — otherwise
  // the generic `function` handler wraps them in a named-IIFE (correct for *expressions*,
  // wrong for declarations), producing `export ['()', IIFE]` which has no exportable binding.
  'export'(inner) {
    if (Array.isArray(inner) && inner[0] === 'function' && inner[1]) {
      return ['export', hoistFnDecl(inner[1], inner[2], inner[3])]
    }
    if (Array.isArray(inner) && inner[0] === 'default' && Array.isArray(inner[1]) && inner[1][0] === 'function' && inner[1][1]) {
      const decl = hoistFnDecl(inner[1][1], inner[1][2], inner[1][3])
      return [';', decl, ['export', ['default', inner[1][1]]]]
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
  return (h && h(...args)) ?? (h ? [op, ...args.map(transform)] : [op, ...args.map(transform)])
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

function cloneAst(node) {
  if (node == null || typeof node !== 'object') return node
  if (!Array.isArray(node)) return node
  return node.map(cloneAst)
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

// === AST → jz source codegen ===

const INDENT = '  '
const prec = { '=': 1, '+=': 1, '-=': 1, '*=': 1, '/=': 1, '%=': 1, '&=': 1, '|=': 1, '^=': 1, '>>=': 1, '<<=': 1, '>>>=': 1, '||=': 1, '&&=': 1,
  '??': 2, '||': 3, '&&': 4, '|': 5, '^': 6, '&': 7, '===': 8, '!==': 8, '==': 8, '!=': 8,
  '<': 9, '>': 9, '<=': 9, '>=': 9, '<<': 10, '>>': 10, '>>>': 10,
  '+': 11, '-': 11, '*': 12, '/': 12, '%': 12, '**': 13 }

/** Wrap statement in { } if not already a block */
function wrapBlock(node, depth) {
  if (Array.isArray(node) && node[0] === '{}') return codegen(node, depth)
  return '{ ' + codegen(node, depth) + '; }'
}

/** Generate jz source from AST. Enforces semicolons. */
export function codegen(node, depth = 0) {
  if (node == null) return ''
  if (typeof node === 'number') return String(node)
  if (typeof node === 'bigint') return node + 'n'
  if (typeof node === 'string') return node
  if (!Array.isArray(node)) return String(node)

  const [op, ...a] = node
  const ind = INDENT.repeat(depth), ind1 = INDENT.repeat(depth + 1)

  // Literal: [, value]
  if (op == null) return typeof a[0] === 'string' ? JSON.stringify(a[0]) : a[0] == null ? 'null' : String(a[0]) + (typeof a[0] === 'bigint' ? 'n' : '')

  // Statements
  if (op === ';') return a.map(s => codegen(s, depth)).filter(Boolean).join(';\n' + ind) + ';'
  if (op === '{}') {
    // Discriminate object literal / destructuring pattern from block.
    // Object: `:` key-value, `,` of object-pattern items (id / `:` / `...` / `= default`),
    //         lone string shorthand. Empty `{}` outputs the same string either way.
    const body = a[0]
    const isObjItem = (n) => typeof n === 'string' ||
      (Array.isArray(n) && (n[0] === ':' || n[0] === '...' || n[0] === 'as' ||
        (n[0] === '=' && typeof n[1] === 'string')))
    const isObj = body == null ? false
      : typeof body === 'string' ? true
      : Array.isArray(body) && (body[0] === ':' || body[0] === '...' || body[0] === 'as' ||
          (body[0] === ',' && body.slice(1).every(isObjItem)))
    if (isObj) {
      if (typeof body === 'string') return '{ ' + body + ' }'
      if (body[0] === ',') return '{ ' + body.slice(1).map(x => codegen(x)).join(', ') + ' }'
      return '{ ' + codegen(body) + ' }'
    }
    // Block: body is null, a single statement, or [';', ...stmts]
    const stmts = body == null ? [] : (Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body])
    const rendered = stmts.map(s => codegen(s, depth + 1)).filter(Boolean).join(';\n' + ind1)
    return '{\n' + ind1 + rendered + (rendered ? ';' : '') + '\n' + ind + '}'
  }

  // Declarations
  if (op === 'let' || op === 'const') return op + ' ' + a.map(d => codegen(d, depth)).join(', ')
  if (op === 'export') { const inner = codegen(a[0], depth); return inner ? 'export ' + inner : '' }
  if (op === 'default') return 'default ' + codegen(a[0], depth)

  // Control flow
  if (op === 'if') {
    const cond = codegen(a[0]), then = wrapBlock(a[1], depth)
    return a[2] != null
      ? 'if (' + cond + ') ' + then + ' else ' + wrapBlock(a[2], depth)
      : 'if (' + cond + ') ' + then
  }
  if (op === 'while') return 'while (' + codegen(a[0]) + ') ' + wrapBlock(a[1], depth)
  if (op === 'for') {
    if (a.length === 2) { // ['for', head, body] — subscript shape
      const [head, body] = a
      if (Array.isArray(head) && (head[0] === 'of' || head[0] === 'in'))
        return 'for (' + codegen(head[1]) + ' ' + head[0] + ' ' + codegen(head[2]) + ') ' + wrapBlock(body, depth)
      // ['let'/'const', ['in'/'of', name, obj]] — subscript wraps var→let around in/of
      if (Array.isArray(head) && (head[0] === 'let' || head[0] === 'const') && Array.isArray(head[1]) && (head[1][0] === 'in' || head[1][0] === 'of'))
        return 'for (' + head[0] + ' ' + codegen(head[1][1]) + ' ' + head[1][0] + ' ' + codegen(head[1][2]) + ') ' + wrapBlock(body, depth)
      // C-style head [';', init, cond, update] is positional — empty slots are valid,
      // must not flow through the generic `;` joiner (which adds newlines + a trailing `;`).
      if (Array.isArray(head) && head[0] === ';')
        return 'for (' + (head[1] == null ? '' : codegen(head[1])) + '; ' + (head[2] == null ? '' : codegen(head[2])) + '; ' + (head[3] == null ? '' : codegen(head[3])) + ') ' + wrapBlock(body, depth)
      return 'for (' + codegen(head) + ') ' + wrapBlock(body, depth)
    }
    return 'for (' + (codegen(a[0]) || '') + '; ' + (codegen(a[1]) || '') + '; ' + (codegen(a[2]) || '') + ') ' + wrapBlock(a[3], depth)
  }
  if (op === 'return') return 'return ' + codegen(a[0])
  if (op === 'throw') return 'throw ' + codegen(a[0])
  if (op === 'break') return 'break'
  if (op === 'continue') return 'continue'
  // catch with optional binding: ['catch', tryBlock, catchBody] or ['catch', tryBlock, paramName, catchBody]
  if (op === 'catch') {
    if (a.length === 3) return 'try ' + codegen(a[0], depth) + ' catch (' + a[1] + ') ' + codegen(a[2], depth)
    return 'try ' + codegen(a[0], depth) + ' catch ' + codegen(a[1], depth)
  }

  // Arrow
  if (op === '=>') {
    // Params: already wrapped in () by parser, or bare name
    const p = a[0]
    const params = Array.isArray(p) && p[0] === '()' ? codegen(p) : '(' + codegen(p) + ')'
    const body = a[1]
    const isBlock = Array.isArray(body) && (body[0] === '{}' || body[0] === ';' || body[0] === 'return')
    const bodyStr = Array.isArray(body) && body[0] !== '{}' && isBlock
      ? '{ ' + codegen(body, depth) + '; }'
      : codegen(body, depth)
    return params + ' => ' + bodyStr
  }

  // Grouping parens / function call
  if (op === '()') {
    if (a.length === 1) return '(' + (a[0] == null ? '' : codegen(a[0])) + ')'
    return codegen(a[0]) + '(' + a.slice(1).map(x => codegen(x)).join(', ') + ')'
  }

  // Property access
  if (op === '.') return codegen(a[0]) + '.' + a[1]
  if (op === '?.') return codegen(a[0]) + '?.' + a[1]
  if (op === '?.[]') return codegen(a[0]) + '?.[' + codegen(a[1]) + ']'
  if (op === '?.()') return codegen(a[0]) + '?.(' + a.slice(1).map(x => codegen(x)).join(', ') + ')'
  if (op === '[]') {
    // Array literal: ['[]', body] (length 2 → a.length 1). body may be null (empty),
    // a single element, or a [',', ...items] sequence.
    if (a.length === 1) {
      if (a[0] == null) return '[]'
      const body = a[0]
      if (Array.isArray(body) && body[0] === ',') return '[' + body.slice(1).map(x => codegen(x)).join(', ') + ']'
      return '[' + codegen(body) + ']'
    }
    // Subscript: ['[]', obj, idx]
    return codegen(a[0]) + '[' + codegen(a[1]) + ']'
  }
  if (op === ':') return codegen(a[0]) + ': ' + codegen(a[1])
  if (op === 'str') return JSON.stringify(a[0])
  if (op === '//') return '/' + a[0] + '/' + (a[1] || '')

  // Comma
  if (op === ',') return a.map(x => codegen(x)).join(', ')
  // Template literal: alternating string/expr parts. String parts are [null, "str"], expr parts are AST nodes.
  if (op === '`') return '`' + a.map(p => {
    if (Array.isArray(p) && p[0] == null && typeof p[1] === 'string') return p[1].replace(/[`\\$]/g, c => '\\' + c)
    return '${' + codegen(p) + '}'
  }).join('') + '`'

  // Spread
  if (op === '...') return '...' + codegen(a[0])

  // Import / export rename
  if (op === 'import') return 'import ' + codegen(a[0])
  if (op === 'from') return codegen(a[0]) + ' from ' + codegen(a[1])
  if (op === 'as') return codegen(a[0]) + ' as ' + codegen(a[1])

  // Unary prefix
  if (a.length === 1) {
    if (op === '++' || op === '--') return a[0] == null ? op : op + codegen(a[0])
    if (op === 'typeof') return 'typeof ' + codegen(a[0])
    if (op === 'u-') return '-' + codegen(a[0])
    if (op === 'u+') return '+' + codegen(a[0])
    return op + codegen(a[0])
  }

  // Postfix
  if (a.length === 2 && a[1] === null) return codegen(a[0]) + op

  // Binary
  if (a.length === 2 && prec[op]) return codegen(a[0]) + ' ' + op + ' ' + codegen(a[1])

  // Ternary
  if (op === '?' || op === '?:') return codegen(a[0]) + ' ? ' + codegen(a[1]) + ' : ' + codegen(a[2])

  // Fallback
  return op + '(' + a.map(x => codegen(x)).join(', ') + ')'
}
