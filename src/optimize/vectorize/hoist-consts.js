/**
 * A vector constant inside a loop is read from a local set before the loop
 * (speed tier).
 *
 * V8 materializes a `v128.const` where it stands, each time control reaches it:
 * on arm64 a lane ramp `i32x4 0 1 2 3` is five instructions through general
 * registers, on x64 two 64-bit immediates moved through a general register and
 * inserted. In a vector loop (the vectorizer's lane ramps, a lane offset per
 * group of lanes) that is every iteration. A local the loop never writes, set
 * before it, is one value defined outside the loop: the engine builds it once.
 * watr's LICM hoists invariant expressions but leaves a bare constant, and its
 * propagation would forward such a local back into the loop, so this runs after
 * watr. The constants V8 builds in one instruction stay where they are: all
 * zeros (`movi`, `pxor`) and all ones (`movi`, `pcmpeqd`).
 *
 * Each distinct constant of a function takes one local, set before each
 * innermost loop around a use of it; the loop must stand in a statement list.
 *
 * @module optimize/vectorize/hoist-consts
 */

const isArr = Array.isArray
const LISTS = new Set(['func', 'block', 'loop', 'then', 'else'])
const BITS = { i8x16: 8, i16x8: 16, i32x4: 32, i64x2: 64, f32x4: 32, f64x2: 64 }

/** Whether a `v128.const` is all zeros or all ones: one instruction to build on either target. */
const cheap = (n) => {
  const shape = n[1], lanes = n.slice(2).map(String)
  if (!BITS[shape] || !lanes.length) return true
  if (lanes.every(l => /^\+?(0x0+|0+)(\.0*)?$/i.test(l))) return true
  if (shape[0] === 'f') return false
  // (a lane of all ones: -1, or its unsigned spelling in decimal or hex)
  const ones = BITS[shape] === 64 ? '18446744073709551615' : String(2 ** BITS[shape] - 1)
  return lanes.every(l => l === '-1' || l === ones || /^0x(f+)$/i.test(l) && l.length - 2 === BITS[shape] / 4)
}

/** Move the costly vector constants of every loop of `module` into locals set before the loop. */
export function hoistVectorConsts(module) {
  if (!isArr(module)) return module
  for (const fn of module) {
    if (!isArr(fn) || fn[0] !== 'func') continue
    const names = new Set(), locals = new Map()   // constant's text → local
    for (const d of fn) if (isArr(d) && (d[0] === 'local' || d[0] === 'param') && typeof d[1] === 'string') names.add(d[1])
    const localOf = (key) => {
      let name = locals.get(key)
      if (name) return name
      let k = locals.size
      do name = `$__vc${k++}`; while (names.has(name))
      names.add(name)
      locals.set(key, name)
      return name
    }
    const made = new Set()   // the sets this pass put before an inner loop
    // the costly constants a loop's own body holds (not those of a loop inside it), each replaced by its local
    const take = (loop) => {
      const found = new Map()
      const walk = (n) => {
        for (let i = 1; i < n.length; i++) {
          const c = n[i]
          if (!isArr(c) || c[0] === 'loop' || made.has(c)) continue
          if (c[0] === 'v128.const') {
            if (cheap(c)) continue
            const key = c.join(' '), name = localOf(key)
            found.set(name, c)
            n[i] = ['local.get', name]
          } else walk(c)
        }
      }
      walk(loop)
      return found
    }
    const visit = (n) => {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c)) continue
        visit(c)
        if (c[0] !== 'loop' || !LISTS.has(n[0])) continue
        const found = take(c)
        if (!found.size) continue
        const sets = [...found].map(([name, k]) => ['local.set', name, k])
        for (const set of sets) made.add(set)
        n.splice(i, 0, ...sets)
        i += sets.length
      }
    }
    visit(fn)
    if (!locals.size) continue
    let at = 2
    while (at < fn.length && isArr(fn[at]) && ['export', 'type', 'param', 'result', 'local'].includes(fn[at][0])) at++
    fn.splice(at, 0, ...[...locals.values()].map(name => ['local', name, 'v128']))
  }
  return module
}
