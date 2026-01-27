/**
 * Scope analysis - extract variables, types, exports
 * @module analyze
 */

// Visitor table for AST nodes
const visitors = {
  ';': (args, scope, ctx) => args.forEach(a => visit(a, scope, ctx)),
  'let': (args, scope, ctx) => analyzeDeclare(args, false, scope, ctx),
  'const': (args, scope, ctx) => analyzeDeclare(args, true, scope, ctx),
  'export': (args, scope, ctx) => {
    visit(args[0], scope, ctx)
    markExports(args[0], scope)
  },
}

function visit(node, scope, ctx) {
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  visitors[op]?.(args, scope, ctx)
}

/**
 * Analyze AST for scope information
 * @param {Array} ast - Parsed AST
 * @param {Object} ctx - Compilation context
 * @returns {Object} Scope info: { vars, funcs, exports }
 */
export function analyze(ast, ctx) {
  const scope = {
    vars: new Map(),      // name → { type, mutable }
    funcs: new Map(),     // name → { params, returns }
    exports: new Set(),   // exported names
  }

  visit(ast, scope, ctx)
  return scope
}

function analyzeDeclare(args, isConst, scope, ctx) {
  for (const arg of args) {
    if (Array.isArray(arg) && arg[0] === '=') {
      const [, name, init] = arg

      if (typeof name === 'string') {
        // Infer type from init
        const type = inferType(init, scope, ctx)
        scope.vars.set(name, { type, mutable: !isConst })

        // If it's a function, record signature
        if (Array.isArray(init) && init[0] === '=>') {
          const params = extractParams(init[1])
          scope.funcs.set(name, {
            params: params.map(() => 'f64'),  // assume f64 for now
            returns: 'f64'
          })
        }
      }
    }
  }
}

function extractParams(rawParams) {
  // Unwrap ['()', params]
  let params = rawParams
  if (Array.isArray(params) && params[0] === '()') {
    params = params[1]
  }
  // Handle [',', 'a', 'b', ...] → ['a', 'b', ...]
  if (Array.isArray(params)) {
    return params[0] === ',' ? params.slice(1) : [params]
  }
  return params ? [params] : []
}

function inferType(expr, scope, ctx) {
  if (typeof expr === 'number') return 'f64'
  if (typeof expr === 'string') {
    // Check if it's a known type from modules
    if (ctx.types?.has(expr)) {
      return ctx.types.get(expr).returns || 'f64'
    }
    // Check local scope
    if (scope.vars.has(expr)) {
      return scope.vars.get(expr).type
    }
    return 'f64'
  }
  if (Array.isArray(expr)) {
    const [op] = expr
    if (op === '=>') return 'func'
    // Most operators return f64
    return 'f64'
  }
  return 'f64'
}

function markExports(decl, scope) {
  if (!Array.isArray(decl)) return

  const [op, ...args] = decl
  if (op === 'let' || op === 'const') {
    for (const arg of args) {
      if (Array.isArray(arg) && arg[0] === '=') {
        const name = arg[1]
        if (typeof name === 'string') {
          scope.exports.add(name)
        }
      }
    }
  }
}
