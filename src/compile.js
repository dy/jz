/**
 * jz compiler - main compile function
 * @module compile
 */

import { compile as watrCompile, print as watrPrint } from 'watr'
import { parse } from './parse.js'
import { analyze } from './analyze.js'
import { emit } from './emit.js'
import { optimize, defaultOptimizers } from './optimize.js'
import { assemble } from './assemble.js'
import math from '../module/math.js'

// Built-in modules registry
const MODULES = { math }

/**
 * Register a built-in module
 */
export function registerModule(name, mod) {
  MODULES[name] = mod
}

/**
 * Create fresh compilation context
 */
function createContext() {
  return {
    types: {},
    emitters: {},
    optimizers: [],
    funcs: [],
    imports: [],
    needsMemory: false,
  }
}

/**
 * Compile jz source to WASM
 * @param {string} code - Source code
 * @param {Object} opts - Options
 * @param {Array|string} opts.modules - Modules to use: ['math'] or 'std'
 * @param {boolean} opts.optimize - Enable optimizations (default: true)
 * @param {boolean} opts.wat - Return WAT text instead of binary
 * @returns {Uint8Array|string} WASM binary or WAT text
 */
export function compile(code, opts = {}) {
  const ctx = createContext()

  // Resolve modules
  let modules = opts.modules || ['math']
  if (typeof modules === 'string') modules = modules.split(' ')

  // Load modules (call init with ctx)
  for (const mod of modules) {
    const m = typeof mod === 'string' ? MODULES[mod] : mod
    if (!m) {
      console.warn(`Unknown module: ${mod}`)
      continue
    }
    // Call module init function
    if (typeof m === 'function') m(ctx)
  }

  // Pipeline: Parse → Analyze → Emit → Optimize → Assemble
  const ast = parse(code)
  ctx.scope = analyze(ast, ctx)
  const ir = emit(ast, ctx)
  const optimizers = opts.optimize !== false ? [...defaultOptimizers, ...ctx.optimizers] : ctx.optimizers
  const optimized = optimize(ir, optimizers)
  const moduleIR = assemble(optimized, ctx)

  return opts.wat ? watrPrint(moduleIR) : watrCompile(moduleIR)
}
