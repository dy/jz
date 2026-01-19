/**
 * Closure analysis for jz compiler
 *
 * Determines which variables are captured by closures and need
 * to be stored in shared environment structs.
 *
 * Key concepts:
 * - Free variables: referenced but not defined in current scope
 * - Captured variables: free vars that exist in outer scope
 * - Hoisted variables: vars captured by ANY nested closure (need env struct)
 */

// Global constants - identifiers that don't count as free variables
const BUILTIN_IDENTS = new Set([
  'true', 'false', 'null', 'undefined',
  'Infinity', 'NaN', 'PI', 'E', 'SQRT2', 'SQRT1_2', 'LN2', 'LN10', 'LOG2E', 'LOG10E'
])

/**
 * Extract parameter names from arrow function AST
 * Handles: x, (x), (x, y), destructuring patterns
 */
export function extractParams(params) {
  if (!params) return []
  if (typeof params === 'string') return [params]
  if (Array.isArray(params)) {
    if (params[0] === '()' && params.length === 2) return extractParams(params[1])
    if (params[0] === ',') return params.slice(1).flatMap(extractParams)
    return params.flatMap(extractParams)
  }
  return []
}

/**
 * Analyze scope to find free variables and inner function definitions
 *
 * @param {any} ast - AST node to analyze
 * @param {Set<string>} outerDefined - Variables defined in outer scopes
 * @param {boolean} inFunction - Whether we're inside a function body
 * @returns {{ free: Set<string>, defined: Set<string>, innerFunctions: Array }}
 */
export function analyzeScope(ast, outerDefined = new Set(), inFunction = false) {
  const defined = new Set(outerDefined)
  const free = new Set()
  const innerFunctions = []

  function walk(node, inFunc = inFunction) {
    if (node == null) return
    if (typeof node === 'string') {
      // Identifier reference - check if free (not defined, not builtin)
      if (!defined.has(node) && !node.startsWith('_') && !BUILTIN_IDENTS.has(node)) {
        free.add(node)
      }
      return
    }
    if (!Array.isArray(node)) return

    const [op, ...args] = node
    if (op === undefined || op === null) return // Literals

    // Variable assignment: name = value
    if (op === '=' && typeof args[0] === 'string') {
      // Check if RHS is a function (closure definition)
      if (Array.isArray(args[1]) && args[1][0] === '=>') {
        const fnParams = extractParams(args[1][1])
        const fnBody = args[1][2]
        // Analyze inner function with ONLY its own params as defined
        // This way, uses of outer variables will be marked as 'free'
        const analysis = analyzeScope(fnBody, new Set(fnParams), true)
        // Captured = free vars that are defined in outer scope
        const captured = [...analysis.free].filter(v => defined.has(v) || outerDefined.has(v))
        innerFunctions.push({
          name: args[0],
          params: fnParams,
          body: fnBody,
          captured,
          innerFunctions: analysis.innerFunctions
        })
        defined.add(args[0])
        return
      }
      walk(args[1], inFunc)
      defined.add(args[0])
      return
    }

    // Declarations: let x, const x = y, var x
    if (op === 'let' || op === 'const' || op === 'var') {
      if (Array.isArray(args[0]) && args[0][0] === '=') {
        walk(args[0][1], inFunc)
        defined.add(args[0][0])
      } else if (typeof args[0] === 'string') {
        defined.add(args[0])
      }
      return
    }

    // Function declaration: function name(params) { body }
    if (op === 'function') {
      const [name, params, body] = args
      const fnParams = extractParams(params)
      const analysis = analyzeScope(body, new Set(fnParams), true)
      const captured = [...analysis.free].filter(v => defined.has(v) || outerDefined.has(v))
      innerFunctions.push({ name, params: fnParams, body, captured, innerFunctions: analysis.innerFunctions })
      defined.add(name)
      return
    }

    // Arrow function: (params) => body
    if (op === '=>') {
      const fnParams = extractParams(args[0])
      const analysis = analyzeScope(args[1], new Set(fnParams), true)
      // Pass through free vars that come from outer scopes
      for (const v of analysis.free) {
        if (!fnParams.includes(v)) free.add(v)
      }
      return
    }

    // For loop - handles let/const in init
    if (op === 'for') {
      const [init, cond, update, body] = args
      if (Array.isArray(init) && (init[0] === 'let' || init[0] === 'const' || init[0] === 'var')) {
        if (Array.isArray(init[1]) && init[1][0] === '=') {
          walk(init[1][1], inFunc)
          defined.add(init[1][0])
        }
      } else {
        walk(init, inFunc)
      }
      walk(cond, inFunc)
      walk(update, inFunc)
      walk(body, inFunc)
      return
    }

    // Recurse into all children
    for (const arg of args) walk(arg, inFunc)
  }

  walk(ast)
  return { free, defined, innerFunctions }
}

/**
 * Find all variables that need to be hoisted to an environment struct
 * because they are captured by at least one nested closure.
 *
 * @param {any} bodyAst - Function body AST
 * @param {string[]} params - Function parameter names
 * @returns {Set<string>} - Variables that need to be in environment struct
 */
export function findHoistedVars(bodyAst, params) {
  const analysis = analyzeScope(bodyAst, new Set(params), true)
  const hoisted = new Set()

  function collectCaptured(innerFunctions) {
    for (const fn of innerFunctions) {
      for (const v of fn.captured) hoisted.add(v)
      if (fn.innerFunctions) collectCaptured(fn.innerFunctions)
    }
  }
  collectCaptured(analysis.innerFunctions)
  return hoisted
}
