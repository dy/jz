import { parse as subscriptParse } from 'subscript'

export const operators = {
  '+': { precedence: 12, arity: 2 },
  '-': { precedence: 12, arity: 2 },
  '*': { precedence: 13, arity: 2 },
  '/': { precedence: 13, arity: 2 },
  '%': { precedence: 13, arity: 2 },
  '**': { precedence: 14, arity: 2 },
  
  '==': { precedence: 9, arity: 2 },
  '!=': { precedence: 9, arity: 2 },
  '===': { precedence: 9, arity: 2 },
  '!==': { precedence: 9, arity: 2 },
  '<': { precedence: 10, arity: 2 },
  '<=': { precedence: 10, arity: 2 },
  '>': { precedence: 10, arity: 2 },
  '>=': { precedence: 10, arity: 2 },
  
  '&&': { precedence: 5, arity: 2 },
  '||': { precedence: 4, arity: 2 },
  '??': { precedence: 3, arity: 2 },
  
  '!': { precedence: 15, arity: 1 },
  '~': { precedence: 15, arity: 1 },
  '+': { precedence: 15, arity: 1 },
  '-': { precedence: 15, arity: 1 },
  
  '&': { precedence: 8, arity: 2 },
  '^': { precedence: 7, arity: 2 },
  '|': { precedence: 6, arity: 2 },
  '<<': { precedence: 11, arity: 2 },
  '>>': { precedence: 11, arity: 2 },
  '>>>': { precedence: 11, arity: 2 }
}

export function parse(code) {
  return subscriptParse(code)
}

export function validate(ast) {
  return true // TODO: Implement validation
}

export function normalize(ast) {
  if (Array.isArray(ast)) {
    const [operator, ...args] = ast
    
    if (operator === undefined) {
      return { type: 'literal', value: args[0] }
    }
    
    if (operators[operator]) {
      const normalizedArgs = args.map(arg => normalize(arg))
      return {
        type: 'operator',
        operator,
        args: normalizedArgs,
        precedence: operators[operator].precedence
      }
    }
    
    if (operator === '()') {
      return {
        type: 'call',
        fn: normalize(args[0]),
        args: args.slice(1).map(arg => normalize(arg))
      }
    }
    
    if (operator === '.') {
      return {
        type: 'member',
        object: normalize(args[0]),
        property: normalize(args[1])
      }
    }
    
    if (operator === '[]') {
      return {
        type: 'index',
        array: normalize(args[0]),
        index: normalize(args[1])
      }
    }
  }
  
  if (typeof ast === 'string') {
    return { type: 'identifier', name: ast }
  }
  
  throw new Error(`Unsupported AST node: ${JSON.stringify(ast)}`)
}