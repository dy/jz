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
 * - Type promotion: variables assigned f64 anywhere are promoted to f64
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

    // Property access: obj.prop - only walk object, not property name string
    if (op === '.' || op === '?.') {
      walk(args[0], inFunc)  // object expression
      // args[1] is the property name string - don't walk it
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

/**
 * Analyze all assignments to variables to determine which need f64 type.
 * A variable needs f64 if ANY assignment to it could produce f64.
 *
 * @param {any} ast - AST to analyze (function body or statement list)
 * @returns {Set<string>} - Variable names that should be f64
 */
export function findF64Vars(ast) {
  const f64Vars = new Set()

  // Operators that always produce f64
  const F64_OPS = new Set(['/', '**'])
  // Operators that produce f64 if either operand is f64
  const MIXED_OPS = new Set(['+', '-', '*', '%'])

  // Check if expression could produce f64
  function couldBeF64(expr) {
    if (expr == null) return false
    // Literal: check if float
    if (Array.isArray(expr) && (expr[0] === null || expr[0] === undefined)) {
      const v = expr[1]
      return typeof v === 'number' && !Number.isInteger(v)
    }
    // Division and power always f64
    if (Array.isArray(expr) && F64_OPS.has(expr[0])) return true
    // Array/TypedArray element access - could be f64
    if (Array.isArray(expr) && expr[0] === '[]') return true
    // Function call - assume f64 (conservative)
    if (Array.isArray(expr) && expr[0] === '(') return true
    // Property access (e.g., Math.PI) - could be f64
    if (Array.isArray(expr) && expr[0] === '.') return true
    // Known f64 variable
    if (typeof expr === 'string' && f64Vars.has(expr)) return true
    // Binary op with f64 operand
    if (Array.isArray(expr) && MIXED_OPS.has(expr[0])) {
      return couldBeF64(expr[1]) || couldBeF64(expr[2])
    }
    // Ternary - either branch could be f64
    if (Array.isArray(expr) && expr[0] === '?') {
      return couldBeF64(expr[2]) || couldBeF64(expr[3])
    }
    return false
  }

  // Walk AST looking for assignments
  function walk(node) {
    if (!node || typeof node !== 'object') return
    if (!Array.isArray(node)) return

    const [op, ...args] = node

    // Variable declaration: let x = expr, const x = expr
    if ((op === 'let' || op === 'const' || op === 'var') && Array.isArray(args[0]) && args[0][0] === '=') {
      const [, name, value] = args[0]
      if (typeof name === 'string' && couldBeF64(value)) {
        f64Vars.add(name)
      }
      walk(value)
      return
    }

    // Assignment: x = expr
    if (op === '=' && typeof args[0] === 'string') {
      const name = args[0]
      if (couldBeF64(args[1])) {
        f64Vars.add(name)
      }
      walk(args[1])
      return
    }

    // Compound assignment: x += expr, etc
    if ((op === '+=' || op === '-=' || op === '*=' || op === '/=') && typeof args[0] === 'string') {
      const name = args[0]
      // Division always f64, others if operand is f64
      if (op === '/=' || couldBeF64(args[1])) {
        f64Vars.add(name)
      }
      walk(args[1])
      return
    }

    // For loop init
    if (op === 'for') {
      const [init, cond, update, body] = args
      walk(init)
      walk(cond)
      walk(update)
      walk(body)
      return
    }

    // Recurse
    for (const arg of args) walk(arg)
  }

  walk(ast)
  return f64Vars
}

/**
 * Analyze function return types to enable i32 returns at function boundaries.
 * Returns 'i32' if ALL return paths definitely produce i32 values.
 *
 * @param {any} ast - Module-level AST
 * @returns {Map<string, string>} - Function name → 'i32' | 'f64'
 */
export function findFuncReturnTypes(ast) {
  const funcs = new Map()       // name → { params, body }
  const returnTypes = new Map() // name → 'i32' | 'f64'

  // Ops that always produce f64
  const F64_OPS = new Set(['/', '**'])
  // Ops that preserve i32 if both operands are i32
  const PRESERVING_OPS = new Set(['+', '-', '*', '%', '&', '|', '^', '<<', '>>', '>>>'])
  // Comparison ops always produce i32 (boolean)
  const CMP_OPS = new Set(['<', '<=', '>', '>=', '==', '!=', '===', '!=='])

  // Collect all exported/defined functions
  function collectFuncs(node) {
    if (!node || typeof node !== 'object') return
    if (!Array.isArray(node)) return
    const [op, ...args] = node

    // export const name = (params) => body
    if (op === 'export' && Array.isArray(args[0]) && args[0][0] === 'const') {
      const decl = args[0][1]
      if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string') {
        const [, name, value] = decl
        if (Array.isArray(value) && value[0] === '=>') {
          funcs.set(name, { params: extractParams(value[1]), body: value[2] })
        }
      }
      return
    }

    // const name = (params) => body (top-level)
    if (op === 'const' && Array.isArray(args[0]) && args[0][0] === '=') {
      const [, name, value] = args[0]
      if (typeof name === 'string' && Array.isArray(value) && value[0] === '=>') {
        funcs.set(name, { params: extractParams(value[1]), body: value[2] })
      }
      return
    }

    // let name = (params) => body
    if (op === 'let' && Array.isArray(args[0]) && args[0][0] === '=') {
      const [, name, value] = args[0]
      if (typeof name === 'string' && Array.isArray(value) && value[0] === '=>') {
        funcs.set(name, { params: extractParams(value[1]), body: value[2] })
      }
      return
    }

    // Recurse into statement sequences
    if (op === ';') {
      for (const arg of args) collectFuncs(arg)
    }
  }

  // Determine expression type (i32, f64, or unknown)
  function exprType(expr, localI32 = new Set()) {
    if (expr == null) return 'i32' // null/undefined → 0
    // Literal
    if (Array.isArray(expr) && (expr[0] === null || expr[0] === undefined)) {
      const v = expr[1]
      if (typeof v === 'number') {
        return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? 'i32' : 'f64'
      }
      if (typeof v === 'boolean') return 'i32'
      return 'f64' // strings, etc → pointer
    }
    // Boolean literals
    if (expr === 'true' || expr === 'false') return 'i32'
    // Variable
    if (typeof expr === 'string') {
      if (localI32.has(expr)) return 'i32'
      return 'f64' // conservative - params are f64
    }
    if (!Array.isArray(expr)) return 'f64'

    const [op, ...args] = expr

    // Division/power always f64
    if (F64_OPS.has(op)) return 'f64'
    // Comparisons always i32
    if (CMP_OPS.has(op)) return 'i32'
    // Bitwise always i32
    if (op === '~') return 'i32'
    // Preserving binary ops
    if (PRESERVING_OPS.has(op)) {
      const lt = exprType(args[0], localI32)
      const rt = exprType(args[1], localI32)
      return (lt === 'i32' && rt === 'i32') ? 'i32' : 'f64'
    }
    // Unary minus
    if (op === '-' && args.length === 1) {
      return exprType(args[0], localI32)
    }
    // Ternary
    if (op === '?') {
      const tt = exprType(args[1], localI32)
      const ft = exprType(args[2], localI32)
      return (tt === 'i32' && ft === 'i32') ? 'i32' : 'f64'
    }
    // Function call - check if we know return type
    if (op === '()') {
      const callee = args[0]
      if (typeof callee === 'string' && returnTypes.has(callee)) {
        return returnTypes.get(callee)
      }
      return 'f64' // unknown → conservative
    }
    // Logical ops produce i32 (truthy/falsy)
    if (op === '!' || op === '&&' || op === '||') return 'i32'

    return 'f64' // conservative default
  }

  // Find all return expressions in a function body
  function findReturns(body) {
    const returns = []
    function walk(node) {
      if (!node || typeof node !== 'object') return
      if (!Array.isArray(node)) return
      const [op, ...args] = node
      if (op === 'return') {
        returns.push(args[0])
        return
      }
      // Don't descend into nested functions
      if (op === '=>') return
      for (const arg of args) walk(arg)
    }
    walk(body)
    return returns
  }

  // Get implicit return expression (last expr in body or body itself for expression arrows)
  function implicitReturn(body) {
    if (!Array.isArray(body)) return body
    const [op, ...args] = body
    // Block with statements - last statement
    if (op === ';' && args.length > 0) {
      return implicitReturn(args[args.length - 1])
    }
    // If the body is not a block, it's the return value
    if (op !== '{' && op !== 'let' && op !== 'const' && op !== 'var' &&
        op !== 'if' && op !== 'for' && op !== 'while' && op !== 'return') {
      return body
    }
    return null
  }

  // Analyze a single function's return type
  function analyzeFunc(name, params, body) {
    // Build set of i32 locals (loop counters, integer inits)
    const localI32 = new Set()
    const f64Vars = findF64Vars(body)

    function scanLocals(node) {
      if (!node || typeof node !== 'object') return
      if (!Array.isArray(node)) return
      const [op, ...args] = node
      if ((op === 'let' || op === 'const') && Array.isArray(args[0]) && args[0][0] === '=') {
        const [, varName, value] = args[0]
        if (typeof varName === 'string' && !f64Vars.has(varName)) {
          // Check if init is i32
          if (exprType(value, localI32) === 'i32') {
            localI32.add(varName)
          }
        }
      }
      if (op === 'for' && Array.isArray(args[0])) {
        const init = args[0]
        if ((init[0] === 'let' || init[0] === 'const') && Array.isArray(init[1]) && init[1][0] === '=') {
          const varName = init[1][1]
          if (typeof varName === 'string') localI32.add(varName) // loop vars usually i32
        }
      }
      for (const arg of args) scanLocals(arg)
    }
    scanLocals(body)

    // Find explicit returns
    const returns = findReturns(body)

    // Check implicit return (for expression-bodied arrows)
    const implicit = implicitReturn(body)

    // If no explicit returns, use implicit
    if (returns.length === 0 && implicit) {
      return exprType(implicit, localI32)
    }

    // All explicit returns must be i32
    for (const ret of returns) {
      if (exprType(ret, localI32) !== 'i32') return 'f64'
    }

    // If there's also an implicit return path (no return in some branch), check it
    if (implicit && exprType(implicit, localI32) !== 'i32') return 'f64'

    return returns.length > 0 ? 'i32' : 'f64'
  }

  // Collect all functions
  collectFuncs(ast)

  // Simple analysis (no mutual recursion handling - default to f64 for unknown calls)
  // Process in definition order (good enough for most cases)
  for (const [name, { params, body }] of funcs) {
    returnTypes.set(name, analyzeFunc(name, params, body))
  }

  return returnTypes
}
