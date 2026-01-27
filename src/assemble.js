/**
 * Assemble final IR module
 * @module assemble
 */

/**
 * Assemble IR functions into complete module
 * @param {Array} funcs - IR functions
 * @param {Object} ctx - Compilation context
 * @returns {Array} Complete module IR
 */
export function assemble(funcs, ctx) {
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
  sections.push(...funcs)

  return ['module', ...sections]
}
