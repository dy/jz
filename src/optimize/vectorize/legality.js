import { cloneNode, walkAst } from '../../ast.js'
import { isI32Const, isLocalGet, laneAccess, stepsByOneVia } from './addr-model.js'
import { gateStrips } from './alias.js'
import { isArr } from './node-utils.js'
import { strips } from './scaffold.js'

// ---- The one legality of a lift ----------------------------------------------
//
// A lift runs a scalar loop's iterations in strips, several at once, beside the loop
// as written, which runs what the strips leave. Whichever recognizer built it, it must
// leave memory and locals as the loop does. Memory: a strip runs each site of the body
// for all its iterations before the next site, so two iterations of one strip may not
// touch the same bytes in an order the strip reverses (alias.js gateStrips, every pair
// of sites with a store, one base or two). A lift that runs some statements lane by lane
// in the loop's order says which (`inOrder`, an outer strip's epilogue), and one that
// versions its own one-base distances says so (`versioned`, the general map and stencil
// behind alias.js aliasGuards). Locals: every local the loop writes is one of these,
// against what the lift says of it on its result:
//   - an induction: a strip's counter, or one the lift names (`inductions`), written
//     once an iteration, at the loop's top level, as `x = x + step` with a constant or
//     unwritten step: the lift steps it as an iteration does, each step counted;
//   - private to an iteration: every path writes it before reading it, and nothing
//     after the loop reads it (addr-model.js laneAccess 'write');
//   - a reduction the lift carries and merges (`reductions`): read before written;
//   - landed (`landed`): one the lift leaves holding what the loop leaves, a flag set
//     after the strip, a recurrence the lift runs in the loop's own order.
// Anything else declines: what the recognizer says is checked against the loop, and
// saying nothing is no. A lift that keeps the loop's order of every effect (`ordered`:
// `memory.copy` landing every local it writes, a pixel's channels as lanes inside the
// loop's own iteration) answers for itself.
//
// And the iterations a strip runs are the loop's: a strip counts its counter signed, so a
// loop that leaves on `iv <u bound` (`x >= 0 && x < a.length`, entered at x = −3, runs not
// once) opens its strips only where both ends are non-negative, where the two agree.

/** The lift `r` of the scalar block `node` when it holds, else null. `liveAfter`: the
 *  locals the continuation reads (index.js, the exact scan); `env`: the function's
 *  `fnLocals`, `distinct` parameters and `pointerOf()` (alias.js arrayPointers). */
export function legal(r, node, liveAfter, env) {
  if (!r || !localsHold(r, node, liveAfter) || !countsSigned(r, node)) return null
  return gateStrips(r, node, env.fnLocals, env.distinct, env.pointerOf())
}

/** Whether `r`'s strips run the iterations of `node`'s loop: under an unsigned exit, each
 *  strip of its counter is put behind `iv >= 0 && bound >= 0` (in place); false for a strip
 *  with no bound to test. */
export function countsSigned(r, node) {
  const loop = node.find(c => isArr(c) && c[0] === 'loop')
  const exit = loop ? loop[2] : null, test = isArr(exit) && exit[0] === 'br_if' && isArr(exit[2]) && exit[2][0] === 'i32.eqz' ? exit[2][1] : null
  if (!isArr(test) || test[0] !== 'i32.lt_u' || !isLocalGet(test[1])) return true
  const iv = test[1][1]
  let ok = true
  const open = (parent) => {
    for (let i = 1; i < parent.length; i++) {
      const c = parent[i]
      if (!isArr(c)) continue
      const at = strips.get(c)
      if (!at) { open(c); continue }
      if (at.iv !== iv) continue
      if (!at.bound) { ok = false; continue }
      const both = ['i32.and', ['i32.ge_s', ['local.get', iv], ['i32.const', 0]], ['i32.ge_s', cloneNode(at.bound), ['i32.const', 0]]]
      parent[i] = at.block ? ['if', both, ['then', c]] : ['select', c, ['local.get', iv], both]
    }
  }
  open(r.wrapper)
  return ok
}

/** Whether every local the scalar loop of `node` writes is what `r` says it is (above). */
export function localsHold(r, node, liveAfter) {
  if (r.ordered) return true
  const loop = node.find(c => isArr(c) && c[0] === 'loop')
  if (!loop) return true
  const counted = new Set(r.inductions || [])
  walkAst(r.wrapper, { enter: n => { const at = strips.get(n); if (at) counted.add(at.iv) } })
  const writes = new Map()
  walkAst(loop, { enter: n => {
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') writes.set(n[1], (writes.get(n[1]) || 0) + 1)
  } })
  const body = loop.slice(2)
  for (const [name, count] of writes) {
    if (counted.has(name)) { if (count !== 1 || !body.some(s => stepOf(s, name, loop, writes))) return false; continue }
    const kind = laneAccess(body, name, liveAfter)
    if (kind === 'write') continue
    if (kind === 'read' && (r.reductions?.has(name) || r.landed?.has(name))) continue
    if (kind === 'liveout' && (r.landed?.has(name) || r.reductions?.has(name))) continue
    return false
  }
  return true
}

/** Whether statement `s` is the one step of `name`: `x = x + step` (an i32 constant or a
 *  local the loop does not write; an f64 constant for a Number counter), or `x = t` where
 *  the loop's one write of `t` is `x + 1` (a step CSE folded into a body tee). */
function stepOf(s, name, loop, writes) {
  if (!isArr(s) || s[0] !== 'local.set' || s[1] !== name || s.length !== 3 || !isArr(s[2])) return false
  const v = s[2]
  if (v.length === 3 && isLocalGet(v[1], name)) {
    if (v[0] === 'i32.add') return isI32Const(v[2]) || (isLocalGet(v[2]) && !writes.has(v[2][1]))
    if (v[0] === 'f64.add') return isArr(v[2]) && v[2][0] === 'f64.const'
    return false
  }
  return isLocalGet(v) && writes.get(v[1]) === 1 && stepsByOneVia(loop.slice(2), name, v[1])
}
