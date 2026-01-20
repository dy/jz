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
 * Handles: x, (x), (x, y), default params, rest params, destructuring patterns
 * For destructuring, uses extractParamInfo to get consistent synthetic names
 * @returns {string[]} List of WASM-level parameter names
 */
export function extractParams(params) {
  // Use extractParamInfo for consistent handling of all param types
  return extractParamInfo(params).map(pi => pi.name)
}

/**
 * Extract all variable names from destructuring pattern
 */
function extractDestructNames(pattern) {
  if (!pattern) return []
  if (typeof pattern === 'string') return [pattern]
  if (Array.isArray(pattern)) {
    if (pattern[0] === ',') return pattern.slice(1).flatMap(extractDestructNames)
    if (pattern[0] === '=' && typeof pattern[1] === 'string') return [pattern[1]]
    if (pattern[0] === '...' && typeof pattern[1] === 'string') return [pattern[1]]
    if (pattern[0] === '[]' || pattern[0] === '{}') return extractDestructNames(pattern[1])
    return pattern.flatMap(extractDestructNames)
  }
  return []
}

/**
 * Extract names from object destructuring pattern ["{", key:val, ...]
 */
function extractObjDestructNames(pairs) {
  const names = []
  for (const p of pairs) {
    if (typeof p === 'string') names.push(p)
    else if (Array.isArray(p) && p[0] === ':' && typeof p[2] === 'string') names.push(p[2])
    else if (Array.isArray(p) && p[0] === ':' && typeof p[1] === 'string') names.push(p[1])
  }
  return names
}

/**
 * Extract rich parameter info for compilation
 * @returns {Array<{name: string, default?: any, rest?: boolean, destruct?: 'array'|'object', pattern?: any}>}
 */
export function extractParamInfo(params, idx = 0) {
  if (!params) return []
  if (typeof params === 'string') return [{ name: params }]
  if (Array.isArray(params)) {
    if (params[0] === '()' && params.length === 2) return extractParamInfo(params[1], idx)
    if (params[0] === ',') {
      // Track index across comma-separated params
      const result = []
      for (let i = 1; i < params.length; i++) {
        const infos = extractParamInfo(params[i], idx)
        result.push(...infos)
        idx += infos.length
      }
      return result
    }
    // Default param: ["=", name, default]
    if (params[0] === '=' && typeof params[1] === 'string') return [{ name: params[1], default: params[2] }]
    // Rest param: ["...", name]
    if (params[0] === '...' && typeof params[1] === 'string') return [{ name: params[1], rest: true }]
    // Array destructuring: ["[]", pattern] or ["[]", singleName]
    if (params[0] === '[]') {
      // Single element: ["[]", "x"] or with pattern: ["[]", [",", "a", "b"]]
      const pattern = params[1]
      const names = typeof pattern === 'string' ? [pattern] : extractDestructNames(pattern)
      return [{ name: `_d${idx}`, destruct: 'array', pattern, names }]
    }
    // Object destructuring: ["{}", pattern] or ["{", ...pairs]
    if (params[0] === '{}') {
      const pattern = params[1]
      const names = typeof pattern === 'string' ? [pattern] : extractDestructNames(pattern)
      return [{ name: `_d${idx}`, destruct: 'object', pattern, names }]
    }
    if (params[0] === '{') {
      const names = extractObjDestructNames(params.slice(1))
      return [{ name: `_d${idx}`, destruct: 'object', pattern: params.slice(1), names }]
    }
    return params.flatMap((p, i) => extractParamInfo(p, idx + i))
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
        const declName = args[0][1]
        const declValue = args[0][2]
        // Check if value is a function (closure definition)
        if (Array.isArray(declValue) && declValue[0] === '=>') {
          const fnParams = extractParams(declValue[1])
          const fnBody = declValue[2]
          // Analyze inner function - outer defined vars available for capture
          const allDefined = new Set([...defined, ...outerDefined])
          const analysis = analyzeScope(fnBody, new Set(fnParams), true)
          // Captured = free vars that are defined in outer scope
          const captured = [...analysis.free].filter(v => allDefined.has(v))
          innerFunctions.push({
            name: declName,
            params: fnParams,
            body: fnBody,
            captured,
            innerFunctions: analysis.innerFunctions
          })
          defined.add(declName)
          return
        }
        walk(declValue, inFunc)
        defined.add(declName)
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
    // This handles anonymous closures like `return () => n + 1`
    if (op === '=>') {
      const fnParams = extractParams(args[0])
      const fnBody = args[1]
      const allDefined = new Set([...defined, ...outerDefined])
      const analysis = analyzeScope(fnBody, new Set(fnParams), true)
      // Captured = free vars that are defined in outer scope
      const captured = [...analysis.free].filter(v => allDefined.has(v))
      // Register as inner function (anonymous) for closure analysis
      if (captured.length > 0 || analysis.innerFunctions.length > 0) {
        innerFunctions.push({
          name: null, // anonymous
          params: fnParams,
          body: fnBody,
          captured,
          innerFunctions: analysis.innerFunctions
        })
      }
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
