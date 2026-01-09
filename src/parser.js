import { parse as justin } from 'subscript/justin'

export const parse = justin

// Normalize subscript/justin AST for codegen
// Input format: [op, ...args] where [, value] is literal, string is identifier
// Output: same format but with clean ops for codegen
export function normalize(ast) {
  // Placeholder null in AST → 0 literal
  if (ast === null) return [, 0]

  // Numbers stay as literals
  if (typeof ast === 'number') return [, ast]
  if (typeof ast === 'boolean') return [, ast]

  // Strings are identifiers, but handle null/undefined keywords
  // (subscript sometimes leaves these as strings after operators)
  if (typeof ast === 'string') {
    if (ast === 'null') return [, null]
    if (ast === 'undefined') return [, undefined]
    return ast
  }

  if (!Array.isArray(ast)) throw new Error(`Unsupported AST: ${JSON.stringify(ast)}`)

  const [op, ...args] = ast

  // Literal [, value] - includes null, undefined, NaN from justin
  if (op === undefined || op === null) {
    return [, args[0]]
  }

  // Disambiguate unary +/- from binary
  const normOp = (op === '+' || op === '-') && args.length === 1 ? 'u' + op : op

  // Grouping: unwrap single-arg ()
  if (op === '()' && args.length === 1) return normalize(args[0])

  // Call: () with function + args
  if (op === '()') {
    const fn = normalize(args[0])
    // No-arg call: fn() parses as ["()", "fn", null]
    if (args.length === 2 && args[1] === null) {
      return ['()', fn]
    }
    // Comma-separated args: ["()", fn, [",", a, b, c]]
    if (args.length === 2 && Array.isArray(args[1]) && args[1][0] === ',') {
      return ['()', fn, ...args[1].slice(1).map(normalize)]
    }
    return ['()', fn, ...args.slice(1).map(normalize)]
  }

  // Array literal vs indexing: []
  if (op === '[]') {
    if (args.length === 1) {
      // Array literal: [x, y, z]
      const inner = args[0]
      if (Array.isArray(inner) && inner[0] === ',') {
        return ['[', ...inner.slice(1).map(normalize)]
      }
      return ['[', normalize(inner)]
    }
    // Array indexing: arr[i]
    return ['[]', normalize(args[0]), normalize(args[1])]
  }

  // All other operators
  return [normOp, ...args.map(normalize)]
}
