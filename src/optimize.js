/**
 * Optimization passes on IR
 * @module optimize
 */

/**
 * Run optimization passes on IR
 * @param {Array} ir - IR tree (watr format)
 * @param {Array} passes - List of { name, fn } passes
 * @returns {Array} Optimized IR
 */
export function optimize(ir, passes = []) {
  let result = ir

  for (const { name, fn } of passes) {
    result = transform(result, fn)
  }

  return result
}

/**
 * Deep transform IR tree (bottom-up)
 */
function transform(ir, fn) {
  if (!Array.isArray(ir)) return ir

  // Transform children first
  const [op, ...args] = ir
  const transformed = [op, ...args.map(arg => transform(arg, fn))]

  // Then apply pass to this node
  return fn(transformed)
}

/**
 * Built-in passes (can be used by modules)
 */

/**
 * Constant folding pass
 */
export const foldConstants = ([op, ...args]) => {
  // f64 binary ops
  if (op === 'f64.add' && args[0]?.[0] === 'f64.const' && args[1]?.[0] === 'f64.const') {
    return ['f64.const', args[0][1] + args[1][1]]
  }
  if (op === 'f64.sub' && args[0]?.[0] === 'f64.const' && args[1]?.[0] === 'f64.const') {
    return ['f64.const', args[0][1] - args[1][1]]
  }
  if (op === 'f64.mul' && args[0]?.[0] === 'f64.const' && args[1]?.[0] === 'f64.const') {
    return ['f64.const', args[0][1] * args[1][1]]
  }
  if (op === 'f64.div' && args[0]?.[0] === 'f64.const' && args[1]?.[0] === 'f64.const') {
    return ['f64.const', args[0][1] / args[1][1]]
  }

  // i32 binary ops
  if (op === 'i32.add' && args[0]?.[0] === 'i32.const' && args[1]?.[0] === 'i32.const') {
    return ['i32.const', (args[0][1] + args[1][1]) | 0]
  }
  if (op === 'i32.mul' && args[0]?.[0] === 'i32.const' && args[1]?.[0] === 'i32.const') {
    return ['i32.const', (args[0][1] * args[1][1]) | 0]
  }

  return [op, ...args]
}

/**
 * Strength reduction pass
 */
export const strengthReduce = ([op, ...args]) => {
  // x * 2 → x + x
  if (op === 'f64.mul' && args[1]?.[0] === 'f64.const' && args[1][1] === 2) {
    return ['f64.add', args[0], args[0]]
  }

  // x * 0 → 0
  if (op === 'f64.mul' && args[1]?.[0] === 'f64.const' && args[1][1] === 0) {
    return ['f64.const', 0]
  }

  // x * 1 → x
  if (op === 'f64.mul' && args[1]?.[0] === 'f64.const' && args[1][1] === 1) {
    return args[0]
  }

  // x + 0 → x
  if (op === 'f64.add' && args[1]?.[0] === 'f64.const' && args[1][1] === 0) {
    return args[0]
  }

  // x - 0 → x
  if (op === 'f64.sub' && args[1]?.[0] === 'f64.const' && args[1][1] === 0) {
    return args[0]
  }

  return [op, ...args]
}

/**
 * Default passes
 */
export const defaultOptimizers = [
  { name: 'fold-constants', fn: foldConstants },
  { name: 'strength-reduce', fn: strengthReduce },
]
