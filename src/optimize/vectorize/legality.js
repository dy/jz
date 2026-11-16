// What no gate sees stays each lift's own: a store under a condition is stored under it, a lane
// narrower than the scalar's word means what the word meant (a shift by its width, an unsigned byte
// product), an address the lift keeps reads no value only lane 0 holds, and an outer strip's two
// pixels share an inner loop only where its bound, its start and its splatted loads are no pixel's
// own (`pixelShared`, `outer-scaffold.js`). `test/vector-legality.js` pins a program for each class
// a lift got wrong; `test/vector-dependence.js`, in the generated suite, sweeps dependence-shaped
// loops, those counting down and those with a shifted or inclusive test among them;
// `test/loop-forms.js` pins each form the strips' scaffold lifts; `test/vector-coverage.js`, beside
// the spelling gate, holds which loops of the alias battery a lift takes as a table that only
// grows.

import { cloneNode, walkAst } from '../../ast.js'
import { isLocalGet, laneAccess, readExit, readStep, stepsByOneVia } from './addr-model.js'
import { gateStrips } from './alias.js'
import { isArr } from './node-utils.js'
import { shut, strips } from './scaffold.js'

// ---- The one legality of a lift ----------------------------------------------
//
// A lift runs a scalar loop's iterations in strips, several at once, beside the loop
// as written, which runs what the strips leave. Whichever recognizer built it, it must
// leave memory and locals as the loop does. Memory: a strip runs each site of the body
// for all its iterations before the next site, so two iterations of one strip may not
// touch the same bytes in an order the strip reverses (alias.js gateStrips, every pair
// of sites with a store, one base or two). A lift that runs some statements lane by lane
// in the loop's order says which (`inOrder`, an outer strip's epilogue). Locals: every local
// the loop writes is one of these,
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
  return gateStrips(r, node, env.fnLocals, env.distinct, env.pointerOf(), env.globals?.())
}

/** Whether `r`'s strips run the iterations of `node`'s loop: under an unsigned exit, each
 *  strip of its counter is put behind `iv >= 0 && bound >= 0` (in place); false for a strip
 *  with no bound to test. */
export function countsSigned(r, node) {
  const loop = node.find(c => isArr(c) && c[0] === 'loop')
  const exit = loop ? readExit(loop[2], null) : null
  if (!exit || exit.op !== 'i32.lt_u' || exit.shift) return true
  const iv = exit.counter
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
      parent[i] = at.block ? ['if', both, ['then', c]] : ['select', c, shut(at), both]
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
  const counted = new Set(r.inductions || []), way = new Map()
  walkAst(r.wrapper, { enter: n => { const at = strips.get(n); if (at) { counted.add(at.iv); way.set(at.iv, at.dir ?? 1) } } })
  const writes = new Map()
  walkAst(loop, { enter: n => {
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') writes.set(n[1], (writes.get(n[1]) || 0) + 1)
  } })
  const body = loop.slice(2)
  for (const [name, count] of writes) {
    if (counted.has(name)) { if (count !== 1 || !body.some(s => stepOf(s, name, loop, writes, way.get(name)))) return false; continue }
    const kind = laneAccess(body, name, liveAfter)
    if (kind === 'write') continue
    if (kind === 'read' && (r.reductions?.has(name) || r.landed?.has(name))) continue
    if (kind === 'liveout' && (r.landed?.has(name) || r.reductions?.has(name))) continue
    return false
  }
  return true
}

/** Whether statement `s` is the one step of `name`: `x = x ± step` (an i32 constant or a
 *  local the loop does not write, added; an f64 constant for a Number counter), or `x = t`
 *  where the loop's one write of `t` is `x + 1` (a step CSE folded into a body tee). A strip's
 *  own counter (`dir`, the way its strips run it) steps by a constant that way. */
function stepOf(s, name, loop, writes, dir) {
  if (!isArr(s) || s[0] !== 'local.set' || s[1] !== name || s.length !== 3 || !isArr(s[2])) return false
  const st = readStep(s)
  if (st) return st.by != null ? !dir || Math.sign(st.by) === dir : !dir && st.op === 'i32.add' && !writes.has(st.amount[1])
  const v = s[2]
  return (!dir || dir > 0) && isLocalGet(v) && writes.get(v[1]) === 1 && stepsByOneVia(loop.slice(2), name, v[1])
}
