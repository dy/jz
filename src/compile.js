/**
 * jz compiler - AST → WASM
 * @module compile
 */

import { compile as watrCompile, print as watrPrint } from 'watr'
import { parse } from './parse.js'
import math from '../module/math.js'

// Built-in modules registry
const MODULES = { math }

/**
 * Register a built-in module
 */
export function registerModule(name, mod) {
  MODULES[name] = mod
}


// ============================================================================
// Analyze - scope analysis
// ============================================================================

const analyzeVisitors = {
  ';': (args, ctx) => args.forEach(a => analyzeNode(a, ctx)),
  'let': (args, ctx) => analyzeDeclare(args, false, ctx),
  'const': (args, ctx) => analyzeDeclare(args, true, ctx),
  'export': (args, ctx) => {
    analyzeNode(args[0], ctx)
    markExports(args[0], ctx)
  },
}

function analyzeNode(node, ctx) {
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  analyzeVisitors[op]?.(args, ctx)
}

function analyzeDeclare(args, isConst, ctx) {
  for (const arg of args) {
    if (Array.isArray(arg) && arg[0] === '=') {
      const [, name, init] = arg

      if (typeof name === 'string') {
        const type = inferType(init, ctx)
        ctx.vars[name] = { type, mutable: !isConst }
      }
    }
  }
}

function inferType(expr, ctx) {
  if (typeof expr === 'number') return 'f64'
  if (typeof expr === 'string') {
    if (ctx.types[expr]) return ctx.types[expr].returns || 'f64'
    if (ctx.vars[expr]) return ctx.vars[expr].type
    return 'f64'
  }
  if (Array.isArray(expr)) {
    const [op] = expr
    if (op === '=>') return 'func'
    return 'f64'
  }
  return 'f64'
}

function markExports(decl, ctx) {
  if (!Array.isArray(decl)) return

  const [op, ...args] = decl
  if (op === 'let' || op === 'const') {
    for (const arg of args) {
      if (Array.isArray(arg) && arg[0] === '=') {
        const name = arg[1]
        if (typeof name === 'string') ctx.exports[name] = true
      }
    }
  }
}

/**
 * Analyze AST for scope information
 */
function analyze(ast, ctx) {
  analyzeNode(ast, ctx)
}

// ============================================================================
// Emit - AST to IR (watr format)
// ============================================================================

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
  if (typeof expr === 'number') return ['f64.const', expr]

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

/**
 * Emit arrow function to IR
 */
function emitFunc(name, arrow, ctx, exported) {
  const [, rawParams, body] = arrow

  let params = rawParams
  if (Array.isArray(params) && params[0] === '()') {
    params = params[1]
  }
  const paramList = Array.isArray(params)
    ? (params[0] === ',' ? params.slice(1) : [params])
    : params ? [params] : []

  const irParams = paramList.map(p => ['param', `$${p}`, 'f64'])
  const irBody = emitExpr(body, ctx)

  const fn = ['func']
  if (exported) {
    fn.push(['export', `"${name}"`])
  } else {
    fn.push(`$${name}`)
  }
  fn.push(...irParams)
  fn.push(['result', 'f64'])
  fn.push(irBody)

  return fn
}

/**
 * Emit a declaration
 */
function emitDecl(decl, ctx, exported) {
  const [, ...args] = decl
  const funcs = []

  for (const arg of args) {
    if (Array.isArray(arg) && arg[0] === '=') {
      const [, name, init] = arg

      if (Array.isArray(init) && init[0] === '=>') {
        const fn = emitFunc(name, init, ctx, exported)
        funcs.push(fn)
      }
    }
  }

  return funcs
}

/**
 * Emit AST to IR (watr tree format)
 */
function emit(ast, ctx) {
  const funcs = []
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

// ============================================================================
// Optimize - IR transforms
// ============================================================================

/** Bottom-up tree transform */
function transform(ir, fn) {
  if (!Array.isArray(ir)) return ir
  const [op, ...args] = ir
  return fn([op, ...args.map(arg => transform(arg, fn))])
}

/** Constant folding */
const foldConstants = ([op, ...args]) => {
  const [a, b] = args
  if (a?.[0] === 'f64.const' && b?.[0] === 'f64.const') {
    const [x, y] = [a[1], b[1]]
    if (op === 'f64.add') return ['f64.const', x + y]
    if (op === 'f64.sub') return ['f64.const', x - y]
    if (op === 'f64.mul') return ['f64.const', x * y]
    if (op === 'f64.div') return ['f64.const', x / y]
  }
  if (a?.[0] === 'i32.const' && b?.[0] === 'i32.const') {
    const [x, y] = [a[1], b[1]]
    if (op === 'i32.add') return ['i32.const', (x + y) | 0]
    if (op === 'i32.mul') return ['i32.const', (x * y) | 0]
  }
  return [op, ...args]
}

/** Strength reduction */
const strengthReduce = ([op, ...args]) => {
  const [a, b] = args
  if (b?.[0] === 'f64.const') {
    const v = b[1]
    if (op === 'f64.mul' && v === 2) return ['f64.add', a, a]
    if (op === 'f64.mul' && v === 0) return ['f64.const', 0]
    if (op === 'f64.mul' && v === 1) return a
    if (op === 'f64.add' && v === 0) return a
    if (op === 'f64.sub' && v === 0) return a
  }
  return [op, ...args]
}

const defaultOptimizers = [foldConstants, strengthReduce]

// ============================================================================
// Main compile function
// ============================================================================

/**
 * Compile jz source to WASM
 */
export function compile(code, opts = {}) {
  const ctx = {
    types: {},
    emitters: {},
    optimizers: [],
    funcs: [],
    imports: [],
    needsMemory: false,
    vars: {},      // name → { type, mutable }
    exports: {},   // name → true
  }

  // Load modules
  let modules = opts.modules || ['math']
  if (typeof modules === 'string') modules = modules.split(' ')
  for (const mod of modules) {
    const m = typeof mod === 'string' ? MODULES[mod] : mod
    if (m) m(ctx)
  }

  // Pipeline: parse → analyze → emit → optimize → assemble
  const ast = parse(code)
  analyze(ast, ctx)
  let ir = emit(ast, ctx)

  // Apply optimizations
  const passes = opts.optimize !== false ? [...defaultOptimizers, ...ctx.optimizers] : ctx.optimizers
  for (const fn of passes) ir = ir.map(node => transform(node, fn))

  // Assemble final module
  const sections = []

  // Host imports
  if (ctx.imports?.length) {
    sections.push(...ctx.imports)
  }

  // Memory (if any module needs it)
  if (ctx.needsMemory) {
    sections.push(['memory', ['export', '"memory"'], 1])
  }

  // Stdlib functions from modules
  if (ctx.funcs?.length) {
    sections.push(...ctx.funcs)
  }

  // User functions
  sections.push(...ir)

  let moduleIR = ['module', ...sections]

  return opts.wat ? watrPrint(moduleIR) : watrCompile(moduleIR)
}
