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
])

// Allowed namespaces
const NAMESPACES = { Math: new Set([
  'abs', 'ceil', 'floor', 'round', 'trunc', 'sqrt', 'min', 'max', 'pow', 'sign', 'clz32', 'fround',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'cbrt', 'hypot', 'imul', 'random',
  'PI', 'E', 'SQRT2', 'SQRT1_2', 'LN2', 'LN10', 'LOG2E', 'LOG10E',
]), Number: new Set(['isNaN', 'isFinite', 'isInteger']) }

const GLOBALS = new Set(['Math', 'Number', 'Array', 'Infinity', 'NaN', 'true', 'false', 'null', 'undefined', 'isNaN', 'isFinite', 'parseInt'])

// Context for tracking scope
const createCtx = (parent) => ({ vars: new Set(parent?.vars), fns: new Set(parent?.fns) })

// Main entry
export default function normalize(node, ctx = createCtx()) {
  ctx.vars.add('t')  // floatbeat param
  collectFns(node, ctx)  // Forward declare functions
  return expr(node, ctx)
}

// Collect function names in first pass for forward references
function collectFns(node, ctx) {
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  if (op === '=' && Array.isArray(args[1]) && args[1][0] === '=>' && typeof args[0] === 'string')
    ctx.fns.add(args[0])
  else if (op === 'function' && typeof args[0] === 'string')
    ctx.fns.add(args[0])
  else if (op === ',' || op === ';')
    args.forEach(a => collectFns(a, ctx))
}

// Core normalizer
function expr(node, ctx) {
  if (node == null) return node
  if (typeof node === 'string') {
    if (!ctx.vars.has(node) && !ctx.fns.has(node) && !GLOBALS.has(node))
      throw new Error(`Unknown identifier: ${node}`)
    return node
  }
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

  return (handlers[op] || defaultHandler)(op, args, ctx)
}

// Handlers
const handlers = {
  // Unary +/- disambiguation
  '+'(op, [a, b], ctx) {
    if (b === undefined) {
      a = expr(a, ctx)
      return a[0] === undefined && typeof a[1] === 'number' ? a : ['u+', a]
    }
    return optimize('+', expr(a, ctx), expr(b, ctx))
  },

  '-'(op, [a, b], ctx) {
    if (b === undefined) {
      a = expr(a, ctx)
      return a[0] === undefined && typeof a[1] === 'number' ? [, -a[1]] : ['u-', a]
    }
    return optimize('-', expr(a, ctx), expr(b, ctx))
  },

  // Binary with optimization
  '*'(op, [a, b], ctx) { return optimize('*', expr(a, ctx), expr(b, ctx)) },
  '/'(op, [a, b], ctx) { return optimize('/', expr(a, ctx), expr(b, ctx)) },
  '%'(op, [a, b], ctx) { return optimize('%', expr(a, ctx), expr(b, ctx)) },
  '**'(op, [a, b], ctx) { return optimize('**', expr(a, ctx), expr(b, ctx)) },
  '&'(op, [a, b], ctx) { return optimize('&', expr(a, ctx), expr(b, ctx)) },
  '|'(op, [a, b], ctx) { return optimize('|', expr(a, ctx), expr(b, ctx)) },
  '^'(op, [a, b], ctx) { return optimize('^', expr(a, ctx), expr(b, ctx)) },
  '<<'(op, [a, b], ctx) { return optimize('<<', expr(a, ctx), expr(b, ctx)) },
  '>>'(op, [a, b], ctx) { return optimize('>>', expr(a, ctx), expr(b, ctx)) },
  '>>>'(op, [a, b], ctx) { return optimize('>>>', expr(a, ctx), expr(b, ctx)) },

  // Variable declarations
  'let'(op, [init], ctx) { return handleDecl(init, ctx) },
  'const'(op, [init], ctx) { return handleDecl(init, ctx) },
  'var'(op, [init], ctx) { return handleDecl(init, ctx) },

  // Function definition
  'function'(op, [name, params, body], ctx) {
    if (typeof name !== 'string') throw new Error('Function needs name')
    ctx.fns.add(name)
    const fnCtx = createCtx(ctx)
    addParams(params, fnCtx)
    return ['function', name, params, expr(body, fnCtx)]
  },

  // Arrow function
  '=>'(op, [params, body], ctx) {
    const fnCtx = createCtx(ctx)
    addParams(params, fnCtx)
    return ['=>', params, expr(body, fnCtx)]
  },

  // Assignment
  '='(op, [target, value], ctx) {
    addVars(target, ctx)
    return ['=', target, expr(value, ctx)]
  },

  // Compound assignment
  '+='(op, [a, b], ctx) { addVars(a, ctx); return ['+=', a, expr(b, ctx)] },
  '-='(op, [a, b], ctx) { addVars(a, ctx); return ['-=', a, expr(b, ctx)] },
  '*='(op, [a, b], ctx) { addVars(a, ctx); return ['*=', a, expr(b, ctx)] },
  '/='(op, [a, b], ctx) { addVars(a, ctx); return ['/=', a, expr(b, ctx)] },
  '%='(op, [a, b], ctx) { addVars(a, ctx); return ['%=', a, expr(b, ctx)] },
  '&='(op, [a, b], ctx) { addVars(a, ctx); return ['&=', a, expr(b, ctx)] },
  '|='(op, [a, b], ctx) { addVars(a, ctx); return ['|=', a, expr(b, ctx)] },
  '^='(op, [a, b], ctx) { addVars(a, ctx); return ['^=', a, expr(b, ctx)] },
  '<<='(op, [a, b], ctx) { addVars(a, ctx); return ['<<=', a, expr(b, ctx)] },
  '>>='(op, [a, b], ctx) { addVars(a, ctx); return ['>>=', a, expr(b, ctx)] },
  '>>>='(op, [a, b], ctx) { addVars(a, ctx); return ['>>>=', a, expr(b, ctx)] },

  // Function call
  '()'(op, args, ctx) {
    const [fn, ...callArgs] = args
    return ['()', expr(fn, ctx), ...callArgs.map(a => expr(a, ctx))]
  },

  // Property access
  '.'(op, [obj, prop], ctx) {
    if (typeof obj === 'string' && obj in NAMESPACES) {
      if (!NAMESPACES[obj].has(prop)) throw new Error(`Unknown: ${obj}.${prop}`)
      return ['.', obj, prop]
    }
    return ['.', expr(obj, ctx), prop]
  },

  // Optional chaining
  '?.'(op, [obj, prop], ctx) {
    return ['?.', expr(obj, ctx), typeof prop === 'string' ? prop : expr(prop, ctx)]
  },

  // Optional array access: a?.[i]
  '?.[]'(op, [arr, idx], ctx) {
    return ['?.[]', expr(arr, ctx), expr(idx, ctx)]
  },

  // Array literal / indexing
  '[]'(op, args, ctx) {
    if (args.length === 1) {
      // Array literal
      const inner = args[0]
      if (inner == null) return ['[']
      if (Array.isArray(inner) && inner[0] === ',')
        return ['[', ...inner.slice(1).map(e => expr(e, ctx))]
      return ['[', expr(inner, ctx)]
    }
    // Indexing
    return ['[]', expr(args[0], ctx), expr(args[1], ctx)]
  },

  // Normalized array literal (already processed)
  '['(op, elements, ctx) {
    return ['[', ...elements.map(e => expr(e, ctx))]
  },

  // Object literal / block
  '{}'(op, [inner], ctx) {
    if (inner == null) return ['{']

    // Block: contains statements
    if (Array.isArray(inner) && (inner[0] === ';' || inner[0] === '=' || inner[0] === 'let' ||
        inner[0] === 'const' || inner[0] === 'var' || inner[0] === 'for' || inner[0] === 'while' || inner[0] === 'return')) {
      const blockCtx = createCtx(ctx)
      return ['{}', expr(inner, blockCtx)]
    }

    // Object literal
    if (typeof inner === 'string') return ['{', [inner, inner]]
    if (Array.isArray(inner) && inner[0] === ':') return ['{', [inner[1], expr(inner[2], ctx)]]
    if (Array.isArray(inner) && inner[0] === ',') {
      const props = inner.slice(1).map(p => {
        if (typeof p === 'string') return [p, p]
        if (Array.isArray(p) && p[0] === ':') return [p[1], expr(p[2], ctx)]
        throw new Error(`Invalid object property: ${JSON.stringify(p)}`)
      })
      return ['{', ...props]
    }
    throw new Error(`Invalid block/object: ${JSON.stringify(inner)}`)
  },

  // For loop
  'for'(op, [head, body], ctx) {
    const loopCtx = createCtx(ctx)
    if (Array.isArray(head) && head[0] === ';') {
      const [, init, cond, step] = head
      return ['for',
        init ? expr(init, loopCtx) : null,
        cond ? expr(cond, loopCtx) : null,
        step ? expr(step, loopCtx) : null,
        expr(body, loopCtx)
      ]
    }
    return ['for', expr(head, loopCtx), expr(body, loopCtx)]
  },

  // While loop
  'while'(op, [cond, body], ctx) {
    return ['while', expr(cond, ctx), expr(body, ctx)]
  },

  // If statement
  'if'(op, [cond, then, els], ctx) {
    return els !== undefined
      ? ['if', expr(cond, ctx), expr(then, ctx), expr(els, ctx)]
      : ['if', expr(cond, ctx), expr(then, ctx)]
  },

  // Break and continue
  'break'(op, [label], ctx) {
    return label ? ['break', label] : ['break']
  },

  'continue'(op, [label], ctx) {
    return label ? ['continue', label] : ['continue']
  },

  // Switch statement
  'switch'(op, [discriminant, ...cases], ctx) {
    return ['switch', expr(discriminant, ctx), ...cases.map(c => expr(c, ctx))]
  },

  'case'(op, [test, consequent], ctx) {
    return ['case', expr(test, ctx), expr(consequent, ctx)]
  },

  'default'(op, [consequent], ctx) {
    return ['default', expr(consequent, ctx)]
  },

  // Ternary
  '?'(op, [cond, then, els], ctx) {
    return ['?', expr(cond, ctx), expr(then, ctx), expr(els, ctx)]
  },

  // Statements
  ';'(op, stmts, ctx) {
    return [';', ...stmts.filter((s, i) => i === 0 || s != null).map(s => expr(s, ctx))]
  },

  // Comma
  ','(op, items, ctx) {
    return [',', ...items.map(i => expr(i, ctx))]
  },

  // Return
  'return'(op, [value], ctx) {
    return value !== undefined ? ['return', expr(value, ctx)] : ['return']
  },

  // typeof
  'typeof'(op, [value], ctx) {
    return ['typeof', expr(value, ctx)]
  },

  // void
  'void'(op, [value], ctx) {
    return ['void', expr(value, ctx)]
  },

  // Template literals
  '\`'(op, parts, ctx) {
    return ['\`', ...parts.map(p => expr(p, ctx))]
  },
}

// Default: just recurse
function defaultHandler(op, args, ctx) {
  return [op, ...args.map(a => expr(a, ctx))]
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

// Handle variable declaration init
function handleDecl(init, ctx) {
  if (Array.isArray(init) && init[0] === '=') {
    addVars(init[1], ctx)
    return ['=', init[1], expr(init[2], ctx)]
  }
  if (typeof init === 'string') ctx.vars.add(init)
  return init
}

// Add variable names from target
function addVars(target, ctx) {
  if (typeof target === 'string') ctx.vars.add(target)
  else if (Array.isArray(target)) {
    const op = target[0]
    if (op === '[]' || op === ',') target.slice(1).forEach(v => addVars(v, ctx))
    // Object destructuring: ['{}', [',', 'a', 'b']] or ['{}', [',', [':', 'a', 'a'], ...]]
    else if (op === '{}' && Array.isArray(target[1])) {
      const inner = target[1]
      if (inner[0] === ',') inner.slice(1).forEach(v => addVars(v, ctx))
      else if (inner[0] === ':') addVars(inner[1], ctx)
      else addVars(inner, ctx)
    }
    // Handle [':','a','a'] -> add 'a'
    else if (op === ':') addVars(target[1], ctx)
  }
}

// Add params to context
function addParams(params, ctx) {
  if (params == null) return
  if (typeof params === 'string') ctx.vars.add(params)
  else if (Array.isArray(params)) {
    if (params[0] === ',') params.slice(1).forEach(p => addParams(p, ctx))
    else params.forEach(p => addParams(p, ctx))
  }
}
