/**
 * Float literals come from immutable globals (speed tier).
 *
 * V8 has no float immediate. It rematerializes an `f64.const` at each use:
 * zero by a register clear, any other value on x64 as a 64-bit immediate
 * moved into a scratch integer register and transferred to the vector
 * register, two instructions on the use's path. A floating-point loop keeps
 * every register busy, so the constant gets none of its own and the pair
 * recurs once per use inside the loop. An immutable global is a load from
 * the instance's globals, which the engine folds into the arithmetic as a
 * memory operand: one instruction, no integer register.
 *
 * Every nonzero `f64.const`/`f32.const` of a function body reads a global
 * holding the literal's own bits (signed zero, NaN payloads included); equal
 * spellings share one. Zero stays inline, as do integer literals, which x64
 * encodes in the instruction. Constant expressions outside function bodies
 * (global initializers, segment offsets) stay literals. Runs last, after the
 * passes that read constants as constants. The size tier keeps watr's own
 * pool of repeated literals instead.
 *
 * @module optimize/pool-floats
 */

const FLOAT_CONST = new Set(['f64.const', 'f32.const'])
// positive zero: a register clear, cheaper than any load
const isZero = (v) => typeof v === 'number' ? v === 0 && !Object.is(v, -0) : Object.is(Number(v), 0)

/** Pool the nonzero float literals of every function in `ast` (a module) into immutable globals. */
export function poolFloatConstants(ast) {
  if (!Array.isArray(ast) || ast[0] !== 'module') return ast
  const names = new Set(), literals = new Set()
  let at = 1
  const walk = (n, f) => { if (!Array.isArray(n)) return; f(n); for (let i = 0; i < n.length; i++) walk(n[i], f) }
  for (let i = 1; i < ast.length; i++) {
    const n = ast[i]
    if (!Array.isArray(n)) continue
    if (n[0] === 'import') at = i + 1
    const g = n[0] === 'import' ? n[n.length - 1] : n
    if (Array.isArray(g) && g[0] === 'global') {
      if (typeof g[1] === 'string' && g[1][0] === '$') names.add(g[1])
      if (n[0] === 'global') at = i + 1
    }
    if (n[0] !== 'func') walk(n, v => { if (FLOAT_CONST.has(v[0])) literals.add(v) })
  }
  // a literal's identity is its bits (the hosted compiler prints a number to nine digits)
  const scratch = new Float64Array(1), words = new Uint32Array(scratch.buffer)
  const keyOf = (c) => {
    if (typeof c[1] !== 'number') return c[0] + ':s:' + c[1]
    scratch[0] = c[1]
    return c[0] + ':' + words[0] + ':' + words[1]
  }
  const pooled = new Map(), decls = []
  let serial = 0
  const visit = (n) => {
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (!Array.isArray(c)) continue
      if (FLOAT_CONST.has(c[0]) && c.length === 2 && !literals.has(c) && !isZero(c[1])) {
        const key = keyOf(c)
        let name = pooled.get(key)
        if (!name) {
          do { name = '$__ff' + serial++ } while (names.has(name))
          pooled.set(key, name)
          decls.push(['global', name, c[0].slice(0, 3), [c[0], c[1]]])
        }
        n[i] = ['global.get', name]
      } else visit(c)
    }
  }
  for (const n of ast) if (Array.isArray(n) && n[0] === 'func') visit(n)
  if (decls.length) ast.splice(at, 0, ...decls)
  return ast
}
