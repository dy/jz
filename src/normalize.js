// Precompile - normalizes AST for codegen
// Following piezo pattern: https://github.com/dy/piezo/blob/main/src/precompile.js
import { INT, FLOAT } from './parser.js'

export default function precompile(node) {
  return expr(node)
}

// Recursive expression normalizer
function expr(node) {
  if (Array.isArray(node)) {
    return expr[node[0]] ? expr[node[0]](node) : defaultExpr(node)
  }
  return node
}

// Default: just recurse into args
function defaultExpr([op, ...args]) {
  return [op, ...args.map(expr)]
}

Object.assign(expr, {
  // Typed numbers → literals
  [INT]([, n]) { return [, n] },
  [FLOAT]([, n]) { return [, n] },

  // Unary +/- disambiguation
  '+'([, a, b]) {
    if (b === undefined) {
      a = expr(a)
      // +literal → literal
      if (typeof a[1] === 'number') return a
      return ['u+', a]
    }
    return ['+', expr(a), expr(b)]
  },

  '-'([, a, b]) {
    if (b === undefined) {
      a = expr(a)
      // -literal → negated literal
      if (typeof a[1] === 'number') return [, -a[1]]
      return ['u-', a]
    }
    return ['-', expr(a), expr(b)]
  },

  // Grouping: unwrap single-element parens
  '()'([, ...args]) {
    if (args.length === 1) return expr(args[0])

    // Function call: ['()', fn, ...args]
    const [fn, ...callArgs] = args
    const normFn = expr(fn)

    // No-arg call: fn() → ['()', fn]
    if (callArgs.length === 1 && callArgs[0] == null) {
      return ['()', normFn]
    }

    // Flatten comma-separated args
    if (callArgs.length === 1 && Array.isArray(callArgs[0]) && callArgs[0][0] === ',') {
      return ['()', normFn, ...callArgs[0].slice(1).map(expr)]
    }

    return ['()', normFn, ...callArgs.map(expr)]
  },

  // Array literal vs indexing
  '[]'([, ...args]) {
    if (args.length === 1) {
      // Empty array or array literal
      if (args[0] == null) return ['[']
      const inner = args[0]
      if (Array.isArray(inner) && inner[0] === ',') {
        return ['[', ...inner.slice(1).map(expr)]
      }
      return ['[', expr(inner)]
    }
    // Array indexing: arr[i]
    return ['[]', expr(args[0]), expr(args[1])]
  },

  // Object literal OR block statement
  '{}'([, inner]) {
    if (inner == null) return ['{']

    // Block statement: { stmt; stmt; ... } - has ; at top level
    if (Array.isArray(inner) && inner[0] === ';') {
      return ['{}', expr(inner)]
    }

    // Block statement: single statement { stmt }
    if (Array.isArray(inner) && (inner[0] === '=' || inner[0] === '+=' || inner[0] === '-=' ||
        inner[0] === '*=' || inner[0] === '/=' || inner[0] === '%=' ||
        inner[0] === 'for' || inner[0] === 'while')) {
      return ['{}', expr(inner)]
    }

    // Single property shorthand: {x}
    if (typeof inner === 'string') {
      return ['{', [inner, inner]]
    }

    // Single property: {x: 1}
    if (Array.isArray(inner) && inner[0] === ':') {
      return ['{', [inner[1], expr(inner[2])]]
    }

    // Multiple properties
    if (Array.isArray(inner) && inner[0] === ',') {
      const props = inner.slice(1).map(p => {
        if (typeof p === 'string') return [p, p]
        if (Array.isArray(p) && p[0] === ':') return [p[1], expr(p[2])]
        throw new Error(`Invalid object property: ${JSON.stringify(p)}`)
      })
      return ['{', ...props]
    }

    throw new Error(`Invalid object literal: ${JSON.stringify(inner)}`)
  },

  // Arrow function: (params) => body
  '=>'([, params, body]) {
    return ['=>', expr(params), expr(body)]
  },

  // Ternary: a ? b : c
  '?:'([, a, b, c]) {
    return ['?:', expr(a), expr(b), expr(c)]
  },

  // Optional chaining
  '?.'([, a, b]) {
    return ['?.', expr(a), typeof b === 'string' ? b : expr(b)]
  },

  // Property access: normalize but keep prop as string
  '.'([, a, b]) {
    return ['.', expr(a), typeof b === 'string' ? b : expr(b)]
  },

  // Spread
  '...'([, a]) {
    return ['...', expr(a)]
  },

  // Comma: just normalize each element
  ','([, ...items]) {
    return [',', ...items.map(expr)]
  },

  // Semicolon: filter empty, normalize
  ';'([, ...items]) {
    return [';', ...items.filter((s, i) => !i || s).map(expr)]
  },

  // For loop: normalize init, cond, step, body
  'for'([, init, cond, step, body]) {
    return ['for',
      init ? expr(init) : null,
      cond ? expr(cond) : null,
      step ? expr(step) : null,
      expr(body)
    ]
  },

  // While loop: normalize cond and body
  'while'([, cond, body]) {
    return ['while', expr(cond), expr(body)]
  }
})
