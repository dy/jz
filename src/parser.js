import { parse as justin } from 'subscript/justin'

export const parse = justin

// Normalize subscript/justin AST to our internal form
export function normalize(ast) {
  if (ast === null) return { type: 'literal', value: 0 }
  if (typeof ast === 'number') return { type: 'literal', value: ast }
  if (typeof ast === 'boolean') return { type: 'literal', value: ast }

  if (typeof ast === 'string') {
    if (ast === 'true') return { type: 'literal', value: true }
    if (ast === 'false') return { type: 'literal', value: false }
    return { type: 'identifier', name: ast }
  }

  if (ast?.type === 'call') {
    return { type: 'call', fn: normalize(ast.fn), args: (ast.args || []).map(normalize) }
  }

  if (!Array.isArray(ast)) throw new Error(`Unsupported AST: ${JSON.stringify(ast)}`)

  const [op, ...args] = ast

  // Handle [null, value] or [undefined, value] wrapper for literals
  if ((op === null || op === undefined) && args.length === 1) {
    return { type: 'literal', value: args[0] }
  }

  // Disambiguate unary +/-
  const operator = (op === '+' || op === '-') && args.length === 1 ? 'u' + op : op

  // Grouping: unwrap single-arg ()
  if (op === '()' && args.length === 1) return normalize(args[0])

  // Call: () with multiple args
  if (op === '()') {
    const fn = normalize(args[0])
    // Handle no-arg call: fn() parses as ["()", "fn", null]
    if (args.length === 2 && args[1] === null) {
      return { type: 'call', fn, args: [] }
    }
    // If the second arg is a comma expression, flatten it into separate args
    if (args.length === 2 && Array.isArray(args[1]) && args[1][0] === ',') {
      return { type: 'call', fn, args: args[1].slice(1).map(normalize) }
    }
    return { type: 'call', fn, args: args.slice(1).map(normalize) }
  }

  // Array literal or indexing: []
  if (op === '[]') {
    if (args.length === 1) {
      // Array literal: [x, y, z]
      const inner = args[0]
      if (Array.isArray(inner) && inner[0] === ',') {
        // Comma-separated elements
        return { type: 'operator', operator: '[', args: inner.slice(1).map(normalize) }
      } else {
        // Single element array
        return { type: 'operator', operator: '[', args: [normalize(inner)] }
      }
    } else if (args.length === 2) {
      // Array indexing: arr[i]
      return { type: 'index', array: normalize(args[0]), index: normalize(args[1]) }
    }
  }

  // Member access
  if (op === '.') return { type: 'member', object: normalize(args[0]), property: normalize(args[1]) }

  // Operators (including ternary)
  return { type: 'operator', operator, args: args.map(normalize) }
}
