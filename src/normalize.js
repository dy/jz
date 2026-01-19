// AST normalization + validation + optimization
// Single pass: validate JS subset, normalize AST, apply optimizations

// Allowed operations for JZ subset
const ALLOWED = new Set([
  undefined,      // literal [, value]
  '+', '-', '*', '/', '%', '**',
  '<', '<=', '>', '>=', '==', '!=', '===', '!==',
  '&', '|', '^', '~', '<<', '>>', '>>>',
  '&&', '||', '!', '??',
  '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=',
  '?',            // ternary
  'if',           // if/else statement
  'for', 'while',
  'break', 'continue',
  'switch', 'case', 'default',
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
])

// Allowed namespaces
const NAMESPACES = { Math: new Set([
  'abs', 'ceil', 'floor', 'round', 'trunc', 'sqrt', 'min', 'max', 'pow', 'sign', 'clz32', 'fround',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'cbrt', 'hypot', 'imul', 'random',
  'PI', 'E', 'SQRT2', 'SQRT1_2', 'LN2', 'LN10', 'LOG2E', 'LOG10E',
]), Number: new Set(['isNaN', 'isFinite', 'isInteger']) }

// Main entry
export default function normalize(node) {
  return expr(node)
}

// Core normalizer
function expr(node) {
  if (node == null) return node
  if (typeof node === 'string') return node
  if (!Array.isArray(node)) return node

  const [op, ...args] = node

  // Literal [, value] - sparse array with undefined at index 0
  if (op === undefined) {
    const v = args[0]
    if (typeof v !== 'number' && typeof v !== 'boolean' && typeof v !== 'string' && v !== null && v !== undefined)
      throw new Error(`Unsupported literal: ${typeof v}`)
    return node
  }

  if (!ALLOWED.has(op)) throw new Error(`Unsupported: ${op}`)

  return (handlers[op] || defaultHandler)(op, args)
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

  // Variable declarations
  'let'(op, [init]) {
    if (Array.isArray(init) && init[0] === '=') return ['let', ['=', init[1], expr(init[2])]]
    return ['let', init]
  },
  'const'(op, [init]) {
    if (Array.isArray(init) && init[0] === '=') return ['const', ['=', init[1], expr(init[2])]]
    return ['const', init]
  },
  'var'(op, [init]) {
    if (Array.isArray(init) && init[0] === '=') return ['var', ['=', init[1], expr(init[2])]]
    return ['var', init]
  },

  // Function definition
  'function'(op, [name, params, body]) {
    if (typeof name !== 'string') throw new Error('Function needs name')
    return ['function', name, params, expr(body)]
  },

  // Arrow function
  '=>'(op, [params, body]) {
    return ['=>', params, expr(body)]
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
        inner[0] === 'const' || inner[0] === 'var' || inner[0] === 'for' || inner[0] === 'while' || inner[0] === 'return')) {
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
