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
  return transformScope(ast)
}

/** Transform a scope (module top-level or block body). Collects hoisted functions. */
function transformScope(node) {
  if (!Array.isArray(node)) return transform(node)

  const [op, ...args] = node

  // Statement sequence: collect hoisted functions
  if (op === ';') {
    const hoisted = [], rest = []
    for (const stmt of args) {
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

function lowerArguments(params, body) {
  if (!usesArguments(body)) return [params, body]
  const name = `\uE001arg${argsIdx++}`
  const items = paramList(params)
  items.push(['...', name])
  const inner = items.length === 1 ? items[0] : [',', ...items]
  return [['()', inner], renameArguments(body, name)]
}

const handlers = {
  // Named IIFE: (function name(p){b})(a) → let name = arrow; name(a)
  '()'(callee, ...rest) {
    if (Array.isArray(callee) && callee[0] === '()' && Array.isArray(callee[1]) && callee[1][0] === 'function' && callee[1][1]) {
      const [, name, params, body] = callee[1]
      const [p2, b2] = lowerArguments(params, body)
      return [';', ['let', ['=', name, ['=>', p2, wrapArrowBody(b2)]]], ['()', name, ...rest.map(transform)]]
    }
  },

  // function → arrow (named → hoisted const)
  'function'(name, params, body) {
    const [p2, b2] = lowerArguments(params, body)
    const arrow = ['=>', p2, wrapArrowBody(b2)]
    if (name) { const decl = ['const', ['=', name, arrow]]; decl._hoisted = true; return decl }
    return arrow
  },

  'var'(...args) { return ['let', ...args.map(transform)] },

  '='(lhs, rhs) {
    // var assignment: ['=', ['var', name], init] → let
    if (Array.isArray(lhs) && lhs[0] === 'var')
      return ['let', ['=', lhs[1], transform(rhs)]]
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
    const name = typeof ctor === 'string' ? ctor : (Array.isArray(ctor) && ctor[0] === '()' ? ctor[1] : null)
    if (typeof name === 'string' && TYPED_ARRAYS.has(name)) return ['new', transform(ctor), ...cargs.map(transform)]
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

  // do { body } while (cond) → for (let _once = true; _once || cond; _once = false) body
  // Avoids body duplication; matches JS continue semantics (continue runs cond, not body).
  'do'(body, cond) {
    const flag = `do${doIdx++}`
    return ['for',
      [';',
        ['let', ['=', flag, [null, true]]],
        ['||', flag, transform(cond)],
        ['=', flag, [null, false]]],
      transform(body)]
  },

  // Block body: recurse as scope for hoisting
  '{}'(...args) { return ['{}', ...args.map(a => transformScope(a) ?? a)] },

  // Export: recurse into exported declaration
  'export'(inner) {
    if (Array.isArray(inner) && inner[0] === 'default' && Array.isArray(inner[1]) && inner[1][0] === 'function' && inner[1][1]) {
      const decl = transform(inner[1])
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
    const body = a.map(s => codegen(s, depth + 1)).filter(Boolean).join(';\n' + ind1)
    return '{\n' + ind1 + body + (body ? ';' : '') + '\n' + ind + '}'
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
    if (a.length === 2) { // for...of / for...in
      const [head, body] = a
      if (Array.isArray(head) && (head[0] === 'of' || head[0] === 'in'))
        return 'for (' + codegen(head[1]) + ' ' + head[0] + ' ' + codegen(head[2]) + ') ' + codegen(body, depth)
      return 'for (' + codegen(head) + ') ' + codegen(body, depth)
    }
    return 'for (' + (codegen(a[0]) || '') + '; ' + (codegen(a[1]) || '') + '; ' + (codegen(a[2]) || '') + ') ' + codegen(a[3], depth)
  }
  if (op === 'return') return 'return ' + codegen(a[0])
  if (op === 'throw') return 'throw ' + codegen(a[0])
  if (op === 'break') return 'break'
  if (op === 'continue') return 'continue'
  if (op === 'catch') return 'try ' + codegen(a[0], depth) + ' catch (' + a[1] + ') ' + codegen(a[2], depth)

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
  if (op === '[]') return codegen(a[0]) + '[' + codegen(a[1]) + ']'

  // Array/object literals
  if (op === '[') return '[' + a.map(x => codegen(x)).join(', ') + ']'
  if (op === ':') return codegen(a[0]) + ': ' + codegen(a[1])
  if (op === 'str') return JSON.stringify(a[0])
  if (op === '//') return '/' + a[0] + '/' + (a[1] || '')

  // Comma
  if (op === ',') return a.map(x => codegen(x)).join(', ')
  // Template literal
  if (op === '`') return '`' + a.map((p, i) => i % 2 ? '${' + codegen(p) + '}' : (p?.[1] ?? '')).join('') + '`'

  // Spread
  if (op === '...') return '...' + codegen(a[0])

  // Import
  if (op === 'import') return 'import ' + codegen(a[0])
  if (op === 'from') return codegen(a[0]) + ' from ' + codegen(a[1])

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
