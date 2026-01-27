/**
 * Emit - AST to IR (watr format)
 * @module emit
 */

/**
 * Emit AST to IR (watr tree format)
 * @param {Array} ast - Parsed AST
 * @param {Object} ctx - Compilation context with emitters, scope
 * @returns {Array} IR in watr format
 */
export function emit(ast, ctx) {
  const funcs = []

  // Process top-level statements
  const stmts = ast[0] === ';' ? ast.slice(1) : [ast]

  for (const stmt of stmts) {
    if (!Array.isArray(stmt)) continue

    const [op, ...args] = stmt

    if (op === 'export') {
      const decl = args[0]
      if (Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const')) {
        const exportedFuncs = emitDecl(decl, ctx, true)
        funcs.push(...exportedFuncs)
      }
    } else if (op === 'let' || op === 'const') {
      const declFuncs = emitDecl(stmt, ctx, false)
      funcs.push(...declFuncs)
    }
  }

  return funcs
}

/**
 * Emit a declaration
 */
function emitDecl(decl, ctx, exported) {
  const [op, ...args] = decl
  const funcs = []

  for (const arg of args) {
    if (Array.isArray(arg) && arg[0] === '=') {
      const [, name, init] = arg

      if (Array.isArray(init) && init[0] === '=>') {
        // Function declaration
        const fn = emitFunc(name, init, ctx, exported)
        funcs.push(fn)
      }
      // TODO: Handle non-function exports (globals)
    }
  }

  return funcs
}

/**
 * Emit arrow function to IR
 */
function emitFunc(name, arrow, ctx, exported) {
  const [, rawParams, body] = arrow

  // Extract params: may be 'x', ['()', [',', 'a', 'b']], or [',', 'a', 'b']
  let params = rawParams
  // Unwrap ['()', params]
  if (Array.isArray(params) && params[0] === '()') {
    params = params[1]
  }
  // Handle [',', 'a', 'b', ...] → ['a', 'b', ...]
  const paramList = Array.isArray(params)
    ? (params[0] === ',' ? params.slice(1) : [params])
    : params ? [params] : []

  const irParams = paramList.map(p => ['param', `$${p}`, 'f64'])

  // Emit body
  const irBody = emitExpr(body, ctx)

  // Build function
  const fn = ['func']
  if (exported) fn.push(['export', `"${name}"`])
  else fn.push(`$${name}`)  // Only use $name for internal functions
  fn.push(...irParams)
  fn.push(['result', 'f64'])
  fn.push(irBody)

  return fn
}

// Core emitters for built-in ops
const emitters = {
  // Binary arithmetic
  '+': (a, c) => ['f64.add', emitExpr(a[0], c), emitExpr(a[1], c)],
  '-': (a, c) => a.length === 1
    ? ['f64.neg', emitExpr(a[0], c)]
    : ['f64.sub', emitExpr(a[0], c), emitExpr(a[1], c)],
  '*': (a, c) => ['f64.mul', emitExpr(a[0], c), emitExpr(a[1], c)],
  '/': (a, c) => ['f64.div', emitExpr(a[0], c), emitExpr(a[1], c)],
  '%': (a, c) => ['f64.rem', emitExpr(a[0], c), emitExpr(a[1], c)],

  // Comparisons
  '==': (a, c) => ['f64.eq', emitExpr(a[0], c), emitExpr(a[1], c)],
  '!=': (a, c) => ['f64.ne', emitExpr(a[0], c), emitExpr(a[1], c)],
  '<': (a, c) => ['f64.lt', emitExpr(a[0], c), emitExpr(a[1], c)],
  '>': (a, c) => ['f64.gt', emitExpr(a[0], c), emitExpr(a[1], c)],
  '<=': (a, c) => ['f64.le', emitExpr(a[0], c), emitExpr(a[1], c)],
  '>=': (a, c) => ['f64.ge', emitExpr(a[0], c), emitExpr(a[1], c)],

  // Logical
  '!': (a, c) => ['f64.eq', emitExpr(a[0], c), ['f64.const', 0]],

  // Ternary
  '?:': (a, c) => ['select',
    emitExpr(a[1], c),
    emitExpr(a[2], c),
    ['f64.ne', emitExpr(a[0], c), ['f64.const', 0]]
  ],

  // Parentheses
  '(': (a, c) => emitExpr(a[0], c),

  // Function call
  '()': (args, ctx) => {
    const [callee, callArgs] = args
    const argList = Array.isArray(callArgs)
      ? (callArgs[0] === ',' ? callArgs.slice(1) : [callArgs])
      : callArgs ? [callArgs] : []

    // Check if callee has custom emitter
    if (typeof callee === 'string' && callee in ctx.emitters) {
      return ctx.emitters[callee](argList, ctx)
    }

    const fnName = typeof callee === 'string' ? `$${callee}` : '$fn'
    return ['call', fnName, ...argList.map(a => emitExpr(a, ctx))]
  },
}

/**
 * Emit expression to IR
 */
export function emitExpr(expr, ctx) {
  // Literal number
  if (typeof expr === 'number') return ['f64.const', expr]

  // Variable reference
  if (typeof expr === 'string') {
    if (expr in ctx.emitters) return ctx.emitters[expr]([], ctx)
    return ['local.get', `$${expr}`]
  }

  if (!Array.isArray(expr)) return ['f64.const', 0]

  const [op, ...args] = expr

  // Subscript wraps literals as [,value] (sparse array)
  if (op == null && args.length === 1) return emitExpr(args[0], ctx)

  // Module emitters (can override built-ins)
  if (op in ctx.emitters) return ctx.emitters[op](args, ctx)

  // Built-in emitters
  if (op in emitters) return emitters[op](args, ctx)

  console.warn(`Unknown op: ${op}`)
  return ['f64.const', 0]
}
