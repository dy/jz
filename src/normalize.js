// AST normalization + validation + optimization
// Single pass: validate JS subset, normalize AST, apply optimizations

// Allowed operations for JZ subset
const ALLOWED = new Set([
  undefined,      // literal [, value]
  null,           // literal [null, value] (v10.1.0)
  '+', '-', '*', '/', '%', '**',
  '<', '<=', '>', '>=', '==', '!=', '===', '!==',
  '&', '|', '^', '~', '<<', '>>', '>>>',
  '&&', '||', '!', '??',
  '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=',
  '++', '--',     // increment/decrement
  '?',            // ternary
  'if',           // if/else statement
  'for', 'while',
  'break', 'continue',
  'switch', 'case', 'default',
  'try', 'catch', 'finally', 'throw',  // exception handling
  '{}',           // block statement
  ';',            // statements
  '=>', '()', 'return',
  '[]', '[',      // array indexing / array literal
  '{',            // object literal
  '.', '?.', '?.[]', // property / optional access
  ',',
  'let', 'const', 'var', 'function',
  'typeof', 'void',
  '\`',           // template literals
  '...',          // spread/rest operator
  'export',       // ES module exports
  'new',          // constructor calls (TypedArrays)
  '//',           // regex literal (v10.1.0)
])

// Prohibited operations with helpful error messages
const PROHIBITED = {
  'async': 'async/await not supported: WASM is synchronous',
  'await': 'async/await not supported: WASM is synchronous',
  'class': 'class not supported: use object literals with arrow functions',
  'this': '`this` not supported: use explicit parameter instead',
  'super': 'super not supported: no class inheritance',
  'yield': 'generators not supported: use array methods or loops',
  'delete': 'delete not supported: object shape is fixed at compile time',
  'in': '`in` operator not supported: use optional chaining (?.) or hasOwnProperty pattern',
  'instanceof': 'instanceof not supported: use typeof or Array.isArray()',
  'with': '`with` statement not supported: deprecated and harmful',
  'import': 'dynamic import() not supported: use static imports',
  ':': 'labeled statements not supported: restructure control flow',
}

// Allowed namespaces
const NAMESPACES = { Math: new Set([
  'abs', 'ceil', 'floor', 'round', 'trunc', 'sqrt', 'min', 'max', 'pow', 'sign', 'clz32', 'fround',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'cbrt', 'hypot', 'imul', 'random',
  'PI', 'E', 'SQRT2', 'SQRT1_2', 'LN2', 'LN10', 'LOG2E', 'LOG10E',
]), Number: new Set([
  'isNaN', 'isFinite', 'isInteger',
  'MAX_VALUE', 'MIN_VALUE', 'EPSILON', 'MAX_SAFE_INTEGER', 'MIN_SAFE_INTEGER',
  'POSITIVE_INFINITY', 'NEGATIVE_INFINITY', 'NaN'
]), Array: new Set(['isArray', 'from']),
Object: new Set(['assign', 'keys', 'values', 'entries']),
JSON: new Set(['stringify', 'parse']) }

// Allowed constructors for `new` keyword
const ALLOWED_CONSTRUCTORS = new Set([
  'Array', 'Set', 'Map', 'RegExp',
  'String', 'Number', 'Boolean',  // Boxed primitive wrappers
  'Float64Array', 'Float32Array',
  'Int8Array', 'Int16Array', 'Int32Array',
  'Uint8Array', 'Uint16Array', 'Uint32Array',
  'Uint8ClampedArray',
])

// Prohibited global identifiers
const PROHIBITED_IDENTIFIERS = new Set([
  'arguments', 'eval', 'Function',
  'Proxy', 'Reflect',  // Symbol now supported as ATOM type
  'WeakMap', 'WeakSet',
  'Promise', 'async',
])

// Warnings collector (set externally to capture warnings)
let warnings = []
export function setWarnings(arr) { warnings = arr }
export function getWarnings() { return warnings }

function warn(code, msg) {
  warnings.push({ code, msg })
}

// Main entry
export default function normalize(node) {
  warnings = []  // Reset warnings for each compile
  return expr(node)
}

// Core normalizer
function expr(node) {
  if (node == null) return node
  if (typeof node === 'string') {
    // Check for prohibited identifiers
    if (PROHIBITED_IDENTIFIERS.has(node)) {
      throw new Error(`jz: [prohibited] \`${node}\` is not supported`)
    }
    return node
  }
  if (!Array.isArray(node)) return node

  const [op, ...args] = node

  // Empty array [] means undefined (v10.1.0)
  if (node.length === 0) return [, undefined]

  // Literal [, value] or [null, value] - sparse array with undefined/null at index 0
  if (op === undefined || op === null) {
    const v = args[0]
    if (typeof v !== 'number' && typeof v !== 'boolean' && typeof v !== 'string' && v !== null && v !== undefined)
      throw new Error(`Unsupported literal: ${typeof v}`)
    return [, v]  // normalize to [, value] form
  }

  // Check for prohibited operations
  if (op in PROHIBITED) {
    throw new Error(`jz: [prohibited] ${PROHIBITED[op]}`)
  }

  if (!ALLOWED.has(op)) throw new Error(`Unsupported: ${op}`)

  return (handlers[op] || defaultHandler)(op, args)
}

/**
 * Normalize function parameters - recursively normalize default values
 * Handles: x, (x), (x, y), default params, rest params, destructuring
 */
function normalizeParams(params) {
  if (params == null) return params
  if (typeof params === 'string') return params
  if (!Array.isArray(params)) return params

  const [op, ...args] = params

  // Wrapped params: ["()", inner]
  if (op === '()' && args.length === 1) {
    return ['()', normalizeParams(args[0])]
  }

  // Comma-separated params: [",", p1, p2, ...]
  if (op === ',') {
    return [',', ...args.map(normalizeParams)]
  }

  // Default param: ["=", name, defaultValue]
  if (op === '=' && typeof args[0] === 'string') {
    return ['=', args[0], expr(args[1])]
  }

  // Rest param: ["...", name]
  if (op === '...' && typeof args[0] === 'string') {
    return params
  }

  // Destructuring: ["[]", pattern] or ["{", ...]
  if (op === '[]' || op === '{' || op === '{}') {
    return params  // Don't recurse into destructuring patterns
  }

  return params
}

// Handlers
const handlers = {
  // Unary +/- disambiguation
  '+'(op, [a, b]) {
    if (b === undefined) {
      a = expr(a)
      return a[0] === undefined && typeof a[1] === 'number' ? a : ['u+', a]
    }
    return optimize('+', expr(a), expr(b))
  },

  '-'(op, [a, b]) {
    if (b === undefined) {
      a = expr(a)
      return a[0] === undefined && typeof a[1] === 'number' ? [, -a[1]] : ['u-', a]
    }
    return optimize('-', expr(a), expr(b))
  },

  // Binary with optimization
  '*'(op, [a, b]) { return optimize('*', expr(a), expr(b)) },
  '/'(op, [a, b]) { return optimize('/', expr(a), expr(b)) },
  '%'(op, [a, b]) { return optimize('%', expr(a), expr(b)) },
  '**'(op, [a, b]) { return optimize('**', expr(a), expr(b)) },
  '&'(op, [a, b]) { return optimize('&', expr(a), expr(b)) },
  '|'(op, [a, b]) { return optimize('|', expr(a), expr(b)) },
  '^'(op, [a, b]) { return optimize('^', expr(a), expr(b)) },
  '<<'(op, [a, b]) { return optimize('<<', expr(a), expr(b)) },
  '>>'(op, [a, b]) { return optimize('>>', expr(a), expr(b)) },
  '>>>'(op, [a, b]) { return optimize('>>>', expr(a), expr(b)) },

  // Variable declarations (can have multiple: let a = 1, b = 2)
  'let'(op, inits) {
    return ['let', ...inits.map(init => {
      if (Array.isArray(init) && init[0] === '=') {
        return ['=', init[1], expr(init[2])]
      }
      return init
    })]
  },
  'const'(op, inits) {
    return ['const', ...inits.map(init => {
      if (Array.isArray(init) && init[0] === '=') {
        return ['=', init[1], expr(init[2])]
      }
      return init
    })]
  },
  'var'(op, inits) {
    // Extract variable name for warning
    let varName = inits[0]
    if (Array.isArray(inits[0]) && inits[0][0] === '=') varName = inits[0][1]
    warn('var', `\`var ${varName}\` - prefer \`let\` or \`const\` (var has hoisting surprises)`)
    return ['var', ...inits.map(init => {
      if (Array.isArray(init) && init[0] === '=') {
        return ['=', init[1], expr(init[2])]
      }
      return init
    })]
  },

  // Arrow function
  '=>'(op, [params, body]) {
    return ['=>', normalizeParams(params), expr(body)]
  },

  // Assignment
  '='(op, [target, value]) {
    // Handle var parsed as ["=", ["var", name], value] -> ["var", ["=", name, value]]
    if (Array.isArray(target) && target[0] === 'var') {
      return ['var', ['=', target[1], expr(value)]]
    }
    return ['=', target, expr(value)]
  },

  // Compound assignment
  '+='(op, [a, b]) { return ['+=', a, expr(b)] },
  '-='(op, [a, b]) { return ['-=', a, expr(b)] },
  '*='(op, [a, b]) { return ['*=', a, expr(b)] },
  '/='(op, [a, b]) { return ['/=', a, expr(b)] },
  '%='(op, [a, b]) { return ['%=', a, expr(b)] },
  '&='(op, [a, b]) { return ['&=', a, expr(b)] },
  '|='(op, [a, b]) { return ['|=', a, expr(b)] },
  '^='(op, [a, b]) { return ['^=', a, expr(b)] },
  '<<='(op, [a, b]) { return ['<<=', a, expr(b)] },
  '>>='(op, [a, b]) { return ['>>=', a, expr(b)] },
  '>>>='(op, [a, b]) { return ['>>>=', a, expr(b)] },

  // Increment/decrement: i++ → (i += 1) - 1, ++i → (i += 1)
  '++'(op, [a, post]) {
    // post is null for postfix (i++), undefined for prefix (++i)
    if (post === null) {
      // Postfix: return old value (i++ → (i += 1) - 1)
      return ['-', ['+=', a, [, 1]], [, 1]]
    }
    // Prefix: return new value (++i → i += 1)
    return ['+=', a, [, 1]]
  },
  '--'(op, [a, post]) {
    if (post === null) {
      // Postfix: i-- → (i -= 1) + 1
      return ['+', ['-=', a, [, 1]], [, 1]]
    }
    // Prefix: --i → i -= 1
    return ['-=', a, [, 1]]
  },

  // Function call
  '()'(op, args) {
    const [fn, ...callArgs] = args
    return ['()', expr(fn), ...callArgs.map(a => expr(a))]
  },

  // Property access
  '.'(op, [obj, prop]) {
    if (typeof obj === 'string' && obj in NAMESPACES) {
      if (!NAMESPACES[obj].has(prop)) throw new Error(`Unknown: ${obj}.${prop}`)
      return ['.', obj, prop]
    }
    return ['.', expr(obj), prop]
  },

  // Optional chaining
  '?.'(op, [obj, prop]) {
    return ['?.', expr(obj), typeof prop === 'string' ? prop : expr(prop)]
  },

  // Optional array access: a?.[i]
  '?.[]'(op, [arr, idx]) {
    return ['?.[]', expr(arr), expr(idx)]
  },

  // Array literal / indexing
  '[]'(op, args) {
    if (args.length === 1) {
      // Array literal
      const inner = args[0]
      if (inner == null) return ['[']
      if (Array.isArray(inner) && inner[0] === ',')
        return ['[', ...inner.slice(1).map(e => expr(e))]
      return ['[', expr(inner)]
    }
    // Indexing
    return ['[]', expr(args[0]), expr(args[1])]
  },

  // Normalized array literal (already processed)
  '['(op, elements) {
    return ['[', ...elements.map(e => expr(e))]
  },

  // Object literal / block
  '{}'(op, [inner]) {
    if (inner == null) return ['{']

    // Block: contains statements
    if (Array.isArray(inner) && (inner[0] === ';' || inner[0] === '=' || inner[0] === 'let' ||
        inner[0] === 'const' || inner[0] === 'var' || inner[0] === 'for' || inner[0] === 'while' || inner[0] === 'return' ||
        inner[0] === 'try' || inner[0] === 'catch' || inner[0] === 'finally' || inner[0] === 'throw' || inner[0] === 'if')) {
      return ['{}', expr(inner)]
    }

    // Object literal
    if (typeof inner === 'string') return ['{', [inner, inner]]
    if (Array.isArray(inner) && inner[0] === ':') return ['{', [inner[1], expr(inner[2])]]
    if (Array.isArray(inner) && inner[0] === ',') {
      const props = inner.slice(1).map(p => {
        if (typeof p === 'string') return [p, p]
        if (Array.isArray(p) && p[0] === ':') return [p[1], expr(p[2])]
        throw new Error(`Invalid object property: ${JSON.stringify(p)}`)
      })
      return ['{', ...props]
    }
    throw new Error(`Invalid block/object: ${JSON.stringify(inner)}`)
  },

  // For loop
  'for'(op, [head, body]) {
    if (Array.isArray(head) && head[0] === ';') {
      const [, init, cond, step] = head
      return ['for',
        init ? expr(init) : null,
        cond ? expr(cond) : null,
        step ? expr(step) : null,
        expr(body)
      ]
    }
    return ['for', expr(head), expr(body)]
  },

  // While loop
  'while'(op, [cond, body]) {
    return ['while', expr(cond), expr(body)]
  },

  // If statement
  'if'(op, [cond, then, els]) {
    return els !== undefined
      ? ['if', expr(cond), expr(then), expr(els)]
      : ['if', expr(cond), expr(then)]
  },

  // Break and continue
  'break'(op, [label]) {
    return label ? ['break', label] : ['break']
  },

  'continue'(op, [label]) {
    return label ? ['continue', label] : ['continue']
  },

  // Switch statement
  'switch'(op, [discriminant, ...cases]) {
    return ['switch', expr(discriminant), ...cases.map(c => expr(c))]
  },

  'case'(op, [test, consequent]) {
    return ['case', expr(test), expr(consequent)]
  },

  'default'(op, [consequent]) {
    return ['default', expr(consequent)]
  },

  // Ternary
  '?'(op, [cond, then, els]) {
    return ['?', expr(cond), expr(then), expr(els)]
  },

  // Statements
  ';'(op, stmts) {
    return [';', ...stmts.filter((s, i) => i === 0 || s != null).map(s => expr(s))]
  },

  // Comma
  ','(op, items) {
    return [',', ...items.map(i => expr(i))]
  },

  // Return
  'return'(op, [value]) {
    return value !== undefined ? ['return', expr(value)] : ['return']
  },

  // typeof
  'typeof'(op, [value]) {
    return ['typeof', expr(value)]
  },

  // void
  'void'(op, [value]) {
    return ['void', expr(value)]
  },

  // Template literals
  '\`'(op, parts) {
    return ['\`', ...parts.map(p => expr(p))]
  },

  // Export declaration: export const/let/function or export { names }
  'export'(op, [decl]) {
    // export { x } or export { x, y }
    if (Array.isArray(decl) && decl[0] === '{}') {
      const inner = decl[1]
      if (typeof inner === 'string') return ['export', ['{', inner]]
      if (Array.isArray(inner) && inner[0] === ',') return ['export', ['{', ...inner.slice(1)]]
      return ['export', ['{', inner]]
    }
    // export const/let/var/function
    return ['export', expr(decl)]
  },

  // Regex literal: ['//', pattern, flags] -> ['//', pattern, flags]
  '//'(op, [pattern, flags]) {
    if (typeof pattern !== 'string') throw new Error('Regex pattern must be string')
    if (flags && typeof flags !== 'string') throw new Error('Regex flags must be string')
    return ['//', pattern, flags || '']
  },

  // new - only allowed with builtin constructors
  'new'(op, [constructor, ...args]) {
    // Handle member access on new expression: new String("x").length
    // Parser gives: ['new', ['.', ['()', 'String', arg], 'length']]
    // We need: ['.', ['new', ['()', 'String', arg]], 'length']
    if (Array.isArray(constructor) && (constructor[0] === '.' || constructor[0] === '?.')) {
      const [dotOp, innerExpr, prop] = constructor
      // innerExpr should be the call expression ['()', 'String', ...]
      if (Array.isArray(innerExpr) && innerExpr[0] === '()') {
        // Normalize: new X().prop => ['.', ['new', X()], prop]
        return [dotOp, expr(['new', innerExpr, ...args]), prop]
      }
    }
    // Handle indexing on new expression: new String("x")[0]
    if (Array.isArray(constructor) && constructor[0] === '[') {
      const [bracketOp, innerExpr, idx] = constructor
      if (Array.isArray(innerExpr) && innerExpr[0] === '()') {
        return ['[', expr(['new', innerExpr, ...args]), expr(idx)]
      }
    }

    // Constructor is either a string or a function call expression
    let name = constructor
    if (Array.isArray(constructor) && constructor[0] === '()') {
      name = constructor[1]
    }
    if (typeof name !== 'string') {
      throw new Error(`jz: [prohibited] \`new\` with computed constructor not supported`)
    }
    if (!ALLOWED_CONSTRUCTORS.has(name)) {
      throw new Error(`jz: [prohibited] \`new ${name}()\` not supported. Allowed: ${[...ALLOWED_CONSTRUCTORS].join(', ')}`)
    }
    return ['new', expr(constructor), ...args.map(a => expr(a))]
  },

  // function keyword - warn, suggest arrow
  'function'(op, [name, params, body]) {
    if (typeof name !== 'string') throw new Error('Function needs name')
    warn('function', `\`function ${name}\` - prefer arrow function: \`${name} = (...) => ...\``)
    return ['function', name, normalizeParams(params), expr(body)]
  },
}

// Default: just recurse
function defaultHandler(op, args) {
  return [op, ...args.map(a => expr(a))]
}

// Constant folding optimization
function optimize(op, a, b) {
  if (a[0] === undefined && b[0] === undefined) {
    const va = a[1], vb = b[1]
    if (typeof va === 'number' && typeof vb === 'number') {
      switch (op) {
        case '+': return [, va + vb]
        case '-': return [, va - vb]
        case '*': return [, va * vb]
        case '/': return [, va / vb]
        case '%': return [, va % vb]
        case '**': return [, va ** vb]
        case '&': return [, (va | 0) & (vb | 0)]
        case '|': return [, (va | 0) | (vb | 0)]
        case '^': return [, (va | 0) ^ (vb | 0)]
        case '<<': return [, (va | 0) << (vb | 0)]
        case '>>': return [, (va | 0) >> (vb | 0)]
        case '>>>': return [, (va | 0) >>> (vb | 0)]
      }
    }
  }
  // Identity optimizations
  if (b[0] === undefined && b[1] === 0 && (op === '+' || op === '-')) return a
  if (b[0] === undefined && b[1] === 1 && (op === '*' || op === '/')) return a
  if (a[0] === undefined && a[1] === 0 && op === '+') return b
  if (a[0] === undefined && a[1] === 1 && op === '*') return b

  return [op, a, b]
}
