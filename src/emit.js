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

  // Add emit helper to ctx for use by custom emitters
  ctx.emit = (expr) => emitExpr(expr, ctx)

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

/**
 * Emit expression to IR
 */
function emitExpr(expr, ctx) {
  // Literal number
  if (typeof expr === 'number') {
    return ['f64.const', expr]
  }

  // Variable reference
  if (typeof expr === 'string') {
    // Check if it's a module-provided constant
    if (ctx.emitters?.has(expr)) {
      return ctx.emitters.get(expr)([], ctx)
    }
    return ['local.get', `$${expr}`]
  }

  if (!Array.isArray(expr)) {
    return ['f64.const', 0]
  }

  const [op, ...args] = expr

  // Subscript wraps literals as [,value] (sparse array) - unwrap
  if (op == null && args.length === 1) {
    return emitExpr(args[0], ctx)
  }

  // Check for custom emitter
  if (ctx.emitters?.has(op)) {
    return ctx.emitters.get(op)(args, ctx)
  }

  // Binary operators
  const binOps = {
    '+': 'f64.add', '-': 'f64.sub', '*': 'f64.mul', '/': 'f64.div',
    '%': 'f64.rem', '**': null,  // pow needs stdlib
    '==': 'f64.eq', '!=': 'f64.ne',
    '<': 'f64.lt', '>': 'f64.gt', '<=': 'f64.le', '>=': 'f64.ge',
  }

  if (op in binOps && args.length === 2) {
    const wasmOp = binOps[op]
    if (!wasmOp) {
      throw new Error(`Operator ${op} requires math module`)
    }
    return [wasmOp, emitExpr(args[0], ctx), emitExpr(args[1], ctx)]
  }

  // Unary operators
  if (op === '-' && args.length === 1) {
    return ['f64.neg', emitExpr(args[0], ctx)]
  }

  if (op === '!') {
    return ['f64.eq', emitExpr(args[0], ctx), ['f64.const', 0]]
  }

  // Ternary: ['?:', cond, then, else]
  if (op === '?:') {
    return ['select',
      emitExpr(args[1], ctx),  // then
      emitExpr(args[2], ctx),  // else
      ['f64.ne', emitExpr(args[0], ctx), ['f64.const', 0]]  // cond (truthy)
    ]
  }

  // Function call: ['()', callee, args]
  if (op === '()') {
    const [callee, callArgs] = args
    const argList = Array.isArray(callArgs)
      ? (callArgs[0] === ',' ? callArgs.slice(1) : [callArgs])
      : callArgs ? [callArgs] : []

    // Check if callee has custom emitter
    if (typeof callee === 'string' && ctx.emitters?.has(callee)) {
      return ctx.emitters.get(callee)(argList, ctx)
    }

    // Regular function call
    const fnName = typeof callee === 'string' ? `$${callee}` : '$fn'
    return ['call', fnName, ...argList.map(a => emitExpr(a, ctx))]
  }

  // Parentheses: ['(', expr]
  if (op === '(') {
    return emitExpr(args[0], ctx)
  }

  // Default: try to lower recursively
  console.warn(`Unknown op: ${op}`)
  return ['f64.const', 0]
}

/**
 * Create emit context helper for modules
 */
export function createEmitCtx(ctx) {
  return {
    emit: (expr) => emitExpr(expr, ctx),
    ...ctx
  }
}
