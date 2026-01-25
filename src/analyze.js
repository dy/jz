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
 * Infer type hint from default parameter value
 * @param {any} defaultVal - AST node of the default value
 * @returns {{ type?: string, schema?: string[] }} - Inferred type hint
 */
function inferTypeFromDefault(defaultVal) {
  if (defaultVal == null) return {}

  // Literal number: [null, 42] or [null, 1.5]
  if (Array.isArray(defaultVal) && defaultVal[0] === null) {
    const v = defaultVal[1]
    if (typeof v === 'number') {
      return { type: Number.isInteger(v) ? 'i32' : 'f64' }
    }
    if (typeof v === 'string') return { type: 'string' }
    return {}
  }

  // Empty array literal: ["["]
  if (Array.isArray(defaultVal) && defaultVal[0] === '[') {
    return { type: 'array' }
  }

  // Object literal: ["{", ...] or ["{}", ...]
  if (Array.isArray(defaultVal) && (defaultVal[0] === '{' || defaultVal[0] === '{}')) {
    const schema = []
    if (defaultVal[0] === '{') {
      // Normalized form: ["{", [key, val], [key, val], ...]
      // or ["{", [":", key, val], ...] with colon syntax
      for (let i = 1; i < defaultVal.length; i++) {
        const p = defaultVal[i]
        if (typeof p === 'string') {
          // Shorthand string property name
          schema.push(p)
        } else if (Array.isArray(p)) {
          if (p[0] === ':') {
            // Colon syntax: [":", key, val]
            schema.push(p[1])
          } else if (typeof p[0] === 'string') {
            // Normalized shorthand: [key, val]
            schema.push(p[0])
          }
        }
      }
    } else if (defaultVal[0] === '{}') {
      // Parser form: ["{}", content] where content is either:
      // - [":", key, val] for single prop
      // - [",", [":", k1, v1], [":", k2, v2], ...] for multiple props
      const content = defaultVal[1]
      if (Array.isArray(content)) {
        if (content[0] === ':') {
          // Single property: [":", key, val]
          schema.push(content[1])
        } else if (content[0] === ',') {
          // Multiple properties: [",", [":", k1, v1], ...]
          for (let i = 1; i < content.length; i++) {
            const p = content[i]
            if (Array.isArray(p) && p[0] === ':') schema.push(p[1])
          }
        }
      }
    }
    return { type: 'object', schema }
  }

  // TypedArray constructor: ["()", [".", "Float32Array"], ...]
  if (Array.isArray(defaultVal) && defaultVal[0] === 'new') {
    const ctor = defaultVal[1]
    if (typeof ctor === 'string' && ctor.endsWith('Array')) {
      return { type: 'typedarray', arrayType: ctor }
    }
  }

  return {}
}

/**
 * Extract rich parameter info for compilation
 * @returns {Array<{name: string, default?: any, typeHint?: string, schema?: string[], rest?: boolean, destruct?: 'array'|'object', pattern?: any}>}
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
    // Default param: ["=", name, default] - with type inference
    if (params[0] === '=' && typeof params[1] === 'string') {
      const inferred = inferTypeFromDefault(params[2])
      return [{ name: params[1], default: params[2], typeHint: inferred.type, schema: inferred.schema }]
    }
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

    // Declarations: let x, const x = y, var x (can have multiple: const a = 1, b = 2)
    if (op === 'let' || op === 'const' || op === 'var') {
      // Process each declarator in args
      for (const decl of args) {
        if (Array.isArray(decl) && decl[0] === '=') {
          const declName = decl[1]
          const declValue = decl[2]
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
            continue
          }
          walk(declValue, inFunc)
          if (typeof declName === 'string') defined.add(declName)
        } else if (typeof decl === 'string') {
          defined.add(decl)
        }
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
 * Unified pre-analysis pass: walks AST once to collect all compile-time info.
 * Combines findF64Vars, findFuncReturnTypes, and inferObjectSchemas into single walk.
 *
 * @param {any} ast - AST to analyze
 * @returns {{f64Vars: Set<string>, funcReturnTypes: Map<string, string>, inferredSchemas: Map<string, object>}}
 */
export function preanalyze(ast) {
  const f64Vars = new Set()
  const funcs = new Map()       // name → { params, body }
  const funcReturnTypes = new Map() // name → 'i32' | 'f64'
  const inferredSchemas = new Map() // varName -> { props, closures, isBoxed, boxedType }
  const arrayParams = new Map()  // funcName → Set<paramName> for params used as arrays

  // ===== Array param detection helpers =====
  const ARRAY_METHODS = new Set(['map', 'filter', 'reduce', 'find', 'findIndex', 'indexOf', 'includes',
    'some', 'every', 'slice', 'concat', 'join', 'flat', 'flatMap', 'push', 'pop', 'shift', 'unshift',
    'reverse', 'sort', 'fill', 'at', 'forEach', 'reduceRight', 'copyWithin', 'entries', 'keys', 'values'])

  // ===== F64 detection helpers =====
  const F64_OPS = new Set(['/', '**'])
  const MIXED_OPS = new Set(['+', '-', '*', '%'])

  function couldBeF64(expr) {
    if (expr == null) return false
    if (Array.isArray(expr) && (expr[0] === null || expr[0] === undefined)) {
      const v = expr[1]
      return typeof v === 'number' && !Number.isInteger(v)
    }
    if (Array.isArray(expr) && F64_OPS.has(expr[0])) return true
    if (Array.isArray(expr) && expr[0] === '[]') return true
    if (Array.isArray(expr) && expr[0] === '(') return true
    if (Array.isArray(expr) && expr[0] === '.') return true
    if (typeof expr === 'string' && f64Vars.has(expr)) return true
    if (Array.isArray(expr) && MIXED_OPS.has(expr[0])) {
      return couldBeF64(expr[1]) || couldBeF64(expr[2])
    }
    if (Array.isArray(expr) && expr[0] === '?') {
      return couldBeF64(expr[2]) || couldBeF64(expr[3])
    }
    return false
  }

  // ===== Object schema helpers =====
  function isObjectLiteral(node) {
    return Array.isArray(node) && (node[0] === '{' || node[0] === '{}')
  }

  function extractProps(node) {
    if (!isObjectLiteral(node)) return []
    if (node[0] === '{}') {
      const pair = node[1]
      if (Array.isArray(pair) && pair[0] === ':') return [[pair[1], pair[2]]]
      return []
    }
    return node.slice(1).map(p => Array.isArray(p) && p[0] === ':' ? [p[1], p[2]] : p)
  }

  function isObjectAssign(node) {
    return Array.isArray(node) && node[0] === '()' &&
      Array.isArray(node[1]) && node[1][0] === '.' &&
      node[1][1] === 'Object' && node[1][2] === 'assign' &&
      Array.isArray(node[2]) && node[2][0] === ','
  }

  function getBoxedType(node) {
    if (Array.isArray(node) && node.length === 2) {
      if (typeof node[1] === 'string') return 'string'
      if (typeof node[1] === 'number') return 'number'
      if (typeof node[1] === 'boolean') return 'boolean'
    }
    if (node === 'true' || node === 'false') return 'boolean'
    if (typeof node === 'number') return 'number'
    if (Array.isArray(node) && node[0] === '[') return 'array'
    return null
  }

  function getAssignArgs(node) {
    if (isObjectAssign(node)) {
      const argsNode = node[2]
      return { target: argsNode[1], source: argsNode[2] }
    }
    return null
  }

  // ===== Unified walk =====
  function walk(node, objScope = new Set()) {
    if (!node || typeof node !== 'object') return
    if (!Array.isArray(node)) return

    const [op, ...args] = node

    // ----- Collect functions for return type analysis -----
    // export const fn = (args) => body
    if (op === 'export' && Array.isArray(args[0]) && args[0][0] === 'const') {
      const decl = args[0][1]
      if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string') {
        const [, name, value] = decl
        if (Array.isArray(value) && value[0] === '=>') {
          funcs.set(name, { params: extractParams(value[1]), body: value[2] })
        }
      }
    }
    // export function name(params) { body }
    if (op === 'export' && Array.isArray(args[0]) && args[0][0] === 'function') {
      const [, name, params, body] = args[0]
      if (typeof name === 'string') {
        funcs.set(name, { params: extractParams(params), body })
      }
    }
    // function name(params) { body }
    if (op === 'function') {
      const [name, params, body] = args
      if (typeof name === 'string') {
        funcs.set(name, { params: extractParams(params), body })
      }
    }
    // const/let fn = (args) => body
    if ((op === 'const' || op === 'let') && Array.isArray(args[0]) && args[0][0] === '=') {
      const [, name, value] = args[0]
      if (typeof name === 'string' && Array.isArray(value) && value[0] === '=>') {
        funcs.set(name, { params: extractParams(value[1]), body: value[2] })
      }
    }

    // ----- F64 vars: variable declarations -----
    if ((op === 'let' || op === 'const' || op === 'var') && Array.isArray(args[0]) && args[0][0] === '=') {
      const [, name, value] = args[0]
      if (typeof name === 'string' && couldBeF64(value)) {
        f64Vars.add(name)
      }
      // ----- Object schemas: declarations -----
      if (typeof name === 'string') {
        if (isObjectLiteral(value)) {
          const props = extractProps(value)
          const literalKeys = props.map(p => p[0])
          const closures = new Set()
          for (const [key, val] of props) {
            if (Array.isArray(val) && val[0] === '=>') closures.add(key)
          }
          inferredSchemas.set(name, { props: literalKeys, closures, isBoxed: false, boxedType: null })
          objScope.add(name)
        } else if (isObjectAssign(value)) {
          const { target, source } = getAssignArgs(value)
          const boxedType = getBoxedType(target)
          if (isObjectLiteral(source)) {
            const props = extractProps(source)
            const literalKeys = props.map(p => p[0])
            const closures = new Set()
            for (const [key, val] of props) {
              if (Array.isArray(val) && val[0] === '=>') closures.add(key)
            }
            inferredSchemas.set(name, { props: literalKeys, closures, isBoxed: !!boxedType, boxedType })
            objScope.add(name)
          }
        }
      }
      walk(value, objScope)
      return
    }

    // ----- F64 vars: assignments -----
    if (op === '=' && typeof args[0] === 'string') {
      if (couldBeF64(args[1])) f64Vars.add(args[0])
      walk(args[1], objScope)
      return
    }
    if ((op === '+=' || op === '-=' || op === '*=' || op === '/=') && typeof args[0] === 'string') {
      if (op === '/=' || couldBeF64(args[1])) f64Vars.add(args[0])
      walk(args[1], objScope)
      return
    }

    // ----- Object schemas: property assignments -----
    if (op === '=' && Array.isArray(args[0]) && args[0][0] === '.' && args[0].length === 3) {
      const [, objName, propName] = args[0]
      if (typeof objName === 'string' && typeof propName === 'string' && objScope.has(objName)) {
        const info = inferredSchemas.get(objName)
        if (info && !info.props.includes(propName)) info.props.push(propName)
        if (info && Array.isArray(args[1]) && args[1][0] === '=>') info.closures.add(propName)
      }
      walk(args[1], objScope)
      return
    }

    // ----- Object schemas: Object.assign calls -----
    if (isObjectAssign(node)) {
      const { target, source } = getAssignArgs(node)
      if (typeof target === 'string' && objScope.has(target) && isObjectLiteral(source)) {
        const info = inferredSchemas.get(target)
        if (info) {
          const props = extractProps(source)
          for (const [propName, propVal] of props) {
            if (!info.props.includes(propName)) info.props.push(propName)
            if (Array.isArray(propVal) && propVal[0] === '=>') info.closures.add(propName)
          }
        }
      }
      walk(target, objScope)
      walk(source, objScope)
      return
    }

    // ----- For loops -----
    if (op === 'for') {
      for (const arg of args) walk(arg, objScope)
      return
    }

    // ----- Block/sequence: new scope for objects -----
    if (op === '{}' || op === ';') {
      const blockScope = new Set(objScope)
      for (const stmt of args) walk(stmt, blockScope)
      return
    }

    // ----- Function body: fresh object scope -----
    if (op === '=>') {
      walk(args[1], new Set())
      return
    }

    // Recurse
    for (const arg of args) walk(arg, objScope)
  }

  // Walk the AST once
  walk(ast, new Set())

  // ===== Analyze function return types (needs funcs collected first) =====
  const PRESERVING_OPS = new Set(['+', '-', '*', '%', '&', '|', '^', '<<', '>>', '>>>'])
  const CMP_OPS = new Set(['<', '<=', '>', '>=', '==', '!=', '===', '!=='])

  function exprType(expr, localI32 = new Set()) {
    if (expr == null) return 'i32'
    if (Array.isArray(expr) && (expr[0] === null || expr[0] === undefined)) {
      const v = expr[1]
      if (typeof v === 'number') return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? 'i32' : 'f64'
      if (typeof v === 'boolean') return 'i32'
      return 'f64'
    }
    if (expr === 'true' || expr === 'false') return 'i32'
    if (typeof expr === 'string') return localI32.has(expr) ? 'i32' : 'f64'
    if (!Array.isArray(expr)) return 'f64'

    const [op, ...eArgs] = expr
    if (F64_OPS.has(op)) return 'f64'
    if (CMP_OPS.has(op)) return 'i32'
    if (op === '~') return 'i32'
    if (PRESERVING_OPS.has(op)) {
      return (exprType(eArgs[0], localI32) === 'i32' && exprType(eArgs[1], localI32) === 'i32') ? 'i32' : 'f64'
    }
    if (op === '-' && eArgs.length === 1) return exprType(eArgs[0], localI32)
    if (op === '?') return (exprType(eArgs[1], localI32) === 'i32' && exprType(eArgs[2], localI32) === 'i32') ? 'i32' : 'f64'
    if (op === '()' && typeof eArgs[0] === 'string' && funcReturnTypes.has(eArgs[0])) return funcReturnTypes.get(eArgs[0])
    if (op === '!' || op === '&&' || op === '||') return 'i32'
    return 'f64'
  }

  function findReturns(body) {
    const returns = []
    function walkRet(node) {
      if (!node || typeof node !== 'object') return
      if (!Array.isArray(node)) return
      const [rop, ...rArgs] = node
      if (rop === 'return') { returns.push(rArgs[0]); return }
      if (rop === '=>') return
      for (const arg of rArgs) walkRet(arg)
    }
    walkRet(body)
    return returns
  }

  function implicitReturn(body) {
    if (!Array.isArray(body)) return body
    const [op, ...args] = body
    if (op === ';' && args.length > 0) return implicitReturn(args[args.length - 1])
    if (op !== '{' && op !== 'let' && op !== 'const' && op !== 'var' &&
        op !== 'if' && op !== 'for' && op !== 'while' && op !== 'return') return body
    return null
  }

  function analyzeFunc(name, params, body) {
    const localI32 = new Set()
    const bodyF64 = findF64Vars(body) // Reuse existing for per-function

    function scanLocals(node) {
      if (!node || typeof node !== 'object') return
      if (!Array.isArray(node)) return
      const [op, ...args] = node
      if ((op === 'let' || op === 'const') && Array.isArray(args[0]) && args[0][0] === '=') {
        const [, varName, value] = args[0]
        if (typeof varName === 'string' && !bodyF64.has(varName)) {
          if (exprType(value, localI32) === 'i32') localI32.add(varName)
        }
      }
      if (op === 'for' && Array.isArray(args[0])) {
        const init = args[0]
        if ((init[0] === 'let' || init[0] === 'const') && Array.isArray(init[1]) && init[1][0] === '=') {
          const varName = init[1][1]
          if (typeof varName === 'string') localI32.add(varName)
        }
      }
      for (const arg of args) scanLocals(arg)
    }
    scanLocals(body)

    const returns = findReturns(body)
    const implicit = implicitReturn(body)
    if (returns.length === 0 && implicit) return exprType(implicit, localI32)
    for (const ret of returns) {
      if (exprType(ret, localI32) !== 'i32') return 'f64'
    }
    if (implicit && exprType(implicit, localI32) !== 'i32') return 'f64'
    return returns.length > 0 ? 'i32' : 'f64'
  }

  for (const [name, { params, body }] of funcs) {
    funcReturnTypes.set(name, analyzeFunc(name, params, body))
  }

  // ===== Detect array params =====
  // A param is inferred as array if used with: arr[i], arr.length, arr.map(), etc.
  function detectArrayParams(funcName, params, body) {
    const paramSet = new Set(params)
    const arrays = new Set()

    function scan(node) {
      if (!node || typeof node !== 'object') return
      if (!Array.isArray(node)) return
      const [op, ...args] = node

      // arr[i] - array indexing
      if (op === '[]' && typeof args[0] === 'string' && paramSet.has(args[0])) {
        arrays.add(args[0])
      }

      // arr.length or arr.method()
      if (op === '.' && typeof args[0] === 'string' && paramSet.has(args[0])) {
        const prop = args[1]
        if (prop === 'length' || ARRAY_METHODS.has(prop)) {
          arrays.add(args[0])
        }
      }

      // method call: arr.map(fn) - the '()' wraps ['.', arr, 'map']
      if (op === '()' && Array.isArray(args[0]) && args[0][0] === '.') {
        const [, obj, method] = args[0]
        if (typeof obj === 'string' && paramSet.has(obj) && ARRAY_METHODS.has(method)) {
          arrays.add(obj)
        }
      }

      for (const arg of args) scan(arg)
    }

    scan(body)
    if (arrays.size > 0) arrayParams.set(funcName, arrays)
  }

  for (const [name, { params, body }] of funcs) {
    detectArrayParams(name, params, body)
  }

  return { f64Vars, funcReturnTypes, inferredSchemas, arrayParams }
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

/**
 * Forward schema inference: Find object schemas from declarations + assignments
 *
 * Scans ahead to find all property assignments to object variables,
 * building complete schemas even when objects are built incrementally:
 *   let a = {};      // empty object
 *   a.x = 1;         // adds 'x' to schema
 *   a.fn = () => {}; // adds 'fn' to schema
 * Result: a has schema ['x', 'fn']
 *
 * @param {any} ast - AST to analyze (function body or statement list)
 * @returns {Map<string, {props: string[], closures: Set<string>}>} varName -> schema info
 */
export function inferObjectSchemas(ast) {
  const schemas = new Map()  // varName -> { props: string[], closures: Set<string>, isBoxed: boolean, boxedType: string|null }

  // Track which variables are declared as objects (literal or empty)
  // Multi-prop: ['{', [k1,v1], [k2,v2]] or single-prop: ['{}', [':', k, v]]
  function isObjectLiteral(node) {
    return Array.isArray(node) && (node[0] === '{' || node[0] === '{}')
  }

  // Extract props from object literal (handles both { and {} formats)
  function extractProps(node) {
    if (!isObjectLiteral(node)) return []
    if (node[0] === '{}') {
      // Single prop: ['{}', [':', key, value]]
      const pair = node[1]
      if (Array.isArray(pair) && pair[0] === ':') {
        return [[pair[1], pair[2]]]
      }
      return []
    }
    // Multi-prop: ['{', [k1,v1], [k2,v2], ...]
    return node.slice(1).map(p => {
      if (Array.isArray(p) && p[0] === ':') return [p[1], p[2]]
      return p  // [key, value]
    })
  }

  // Check if node is Object.assign call: ['()', ['.', 'Object', 'assign'], [',', target, source]]
  function isObjectAssign(node) {
    return Array.isArray(node) && node[0] === '()' &&
      Array.isArray(node[1]) && node[1][0] === '.' &&
      node[1][1] === 'Object' && node[1][2] === 'assign' &&
      Array.isArray(node[2]) && node[2][0] === ','
  }

  // Get boxed type from primitive AST node
  // String literal: [undefined, "value"] (sparse array) or [null, "value"]
  function getBoxedType(node) {
    if (Array.isArray(node) && node.length === 2) {
      // Literal: [undefined/null, value]
      if (typeof node[1] === 'string') return 'string'
      if (typeof node[1] === 'number') return 'number'
      if (typeof node[1] === 'boolean') return 'boolean'
    }
    if (node === 'true' || node === 'false') return 'boolean'
    if (typeof node === 'number') return 'number'
    if (Array.isArray(node) && node[0] === '[') return 'array'
    return null
  }

  // Extract target and source from Object.assign args: [',', target, source]
  function getAssignArgs(node) {
    if (isObjectAssign(node)) {
      const argsNode = node[2]  // [',', target, source]
      return { target: argsNode[1], source: argsNode[2] }
    }
    return null
  }

  function walk(node, scope = new Set()) {
    if (!node || typeof node !== 'object') return
    if (!Array.isArray(node)) return

    const [op, ...args] = node

    // Variable declaration: let a = {} or let a = {x: 1}
    if ((op === 'let' || op === 'const' || op === 'var') && Array.isArray(args[0]) && args[0][0] === '=') {
      const [, name, value] = args[0]
      if (typeof name === 'string') {
        if (isObjectLiteral(value)) {
          // Extract props from literal (may be empty)
          const props = extractProps(value)
          const literalKeys = props.map(p => p[0])
          const closures = new Set()
          // Track which props are closures
          for (const [key, val] of props) {
            if (Array.isArray(val) && val[0] === '=>') {
              closures.add(key)
            }
          }
          schemas.set(name, { props: literalKeys, closures, isBoxed: false, boxedType: null })
          scope.add(name)
        } else if (isObjectAssign(value)) {
          // let a = Object.assign(target, {props})
          const { target, source } = getAssignArgs(value)
          const boxedType = getBoxedType(target)
          if (isObjectLiteral(source)) {
            const props = extractProps(source)
            const literalKeys = props.map(p => p[0])
            const closures = new Set()
            for (const [key, val] of props) {
              if (Array.isArray(val) && val[0] === '=>') {
                closures.add(key)
              }
            }
            schemas.set(name, { props: literalKeys, closures, isBoxed: !!boxedType, boxedType })
            scope.add(name)
          }
        }
      }
      walk(value, scope)
      return
    }

    // Assignment to object property: a.x = expr
    if (op === '=' && Array.isArray(args[0]) && args[0][0] === '.' && args[0].length === 3) {
      const [, objName, propName] = args[0]
      if (typeof objName === 'string' && typeof propName === 'string' && scope.has(objName)) {
        const info = schemas.get(objName)
        if (info && !info.props.includes(propName)) {
          info.props.push(propName)
        }
        // Track if this is a closure assignment
        if (info && Array.isArray(args[1]) && args[1][0] === '=>') {
          info.closures.add(propName)
        }
      }
      walk(args[1], scope)
      return
    }

    // Object.assign(existingVar, {props}) as statement or expression
    if (isObjectAssign(node)) {
      const { target, source } = getAssignArgs(node)
      // If target is a variable in scope and source is object literal
      if (typeof target === 'string' && scope.has(target) && isObjectLiteral(source)) {
        const info = schemas.get(target)
        if (info) {
          // Add new props from source
          const props = extractProps(source)
          for (const [propName, propVal] of props) {
            if (!info.props.includes(propName)) {
              info.props.push(propName)
            }
            if (Array.isArray(propVal) && propVal[0] === '=>') {
              info.closures.add(propName)
            }
          }
        }
      }
      // Recurse into the arguments
      walk(target, scope)
      walk(source, scope)
      return
    }

    // Block scope: new scope for let/const
    if (op === '{}' || op === ';') {
      const blockScope = new Set(scope)
      for (const stmt of args) {
        walk(stmt, blockScope)
      }
      return
    }

    // Function body: new scope
    if (op === '=>') {
      const [params, body] = args
      const funcScope = new Set()  // Fresh scope inside function
      walk(body, funcScope)
      return
    }

    // Recurse into all children
    for (const arg of args) {
      walk(arg, scope)
    }
  }

  walk(ast, new Set())
  return schemas
}
