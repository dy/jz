// Edge-clamp peeling for box-filter / stencil loops.
//
// A stencil loop reads `arr[clamp(iv + k, 0, BOUND-1)]` for a window of taps k ∈
// [-r, r]. The clamp guards the array edges, but for the interior iv ∈ [r, BOUND-r)
// every `iv + k` is already in range, so the clamp is a proven no-op there. Per-tap
// the branch is cheap-but-not-free, and it blocks the marching-pointer / SIMD lift
// of the inner accumulation. Measured ~18% of the box-blur pass.
//
// Split the loop over `iv` (whose bound is the clamp's BOUND) into three runs —
// left edge [0, xs), clamp-free interior [xs, xe), right edge [xe, BOUND) — where
// xs = min(r, BOUND), xe = max(xs, BOUND - r). The interior copy has the clamp `if`
// dropped (the bare `iv + k` index remains). Bit-exact: for iv ∈ [r, BOUND-r),
// iv+k ∈ [iv-r, iv+r] ⊆ [0, BOUND-1].
//
// Recognized (post-prepare AST): a `while (iv < BOUND)` loop whose body contains a
// clamp `ci = iv + k; if (ci < 0) ci = 0; else if (ci >= BOUND) ci = BOUND-1` whose
// BOUND is the SAME var as the loop bound and whose `k` is a tap-loop IV ranging
// [-r, r] (`k = -r … k <= r`). Both hblur (peel the x-loop) and vblur (peel the
// y-loop) match. Number literals are sparse-array holes (`n[0]` is undefined), so
// literal tests use `== null`; generated source literals retain that shape.

import { MUTATE_OPS, walkAst, some, numberGuard } from '../ast.js'
import { ctx } from '../ctx.js'
import { frameNode } from '../function.js'
import { counterInit } from '../static.js'
import { cloneWithSubst } from '../type.js'
import { collectBindings } from './plan/common.js'
import { invalidateBodies } from './analyze.js'
import { invalidateProgramFactsCache } from './program-facts.js'
import { litN, unitIncVar, normalizeLoop, rewriteBlocks, freshLoopId, loopHazards, closureMutatedVars } from './loop-model.js'

const isVar = (n) => typeof n === 'string'

// `k = -r`: prepared as ['u-', r] (unary minus) or ['-', 0, r].
const negOf = (n) => Array.isArray(n) && n[0] === 'u-' ? n[1]
  : (Array.isArray(n) && n[0] === '-' && litN(n[1], 0) ? n[2] : null)

// Find, anywhere in `node`, a clamp `if (ci < 0) ci = 0; else if (ci >= B) ci = B-1`
// over a var `ci` and bound var `B`. Returns { ci, bound } or null (first match).
function findClamp(node) {
  let result = null
  walkAst(node, { enter: n => {
    if (result) return false   // first match wins — prune once found
    if (n[0] !== 'if') return
    const [, cond, then, els] = n
    // outer: if (ci < 0) ci = 0; else <inner>
    if (Array.isArray(cond) && cond[0] === '<' && isVar(cond[1]) && litN(cond[2], 0)
      && Array.isArray(then) && then[0] === '=' && then[1] === cond[1] && litN(then[2], 0)
      && Array.isArray(els) && els[0] === 'if') {
      const ci = cond[1], [, c2, t2] = els
      // inner: if (ci >= B) ci = B-1
      if (Array.isArray(c2) && c2[0] === '>=' && c2[1] === ci && isVar(c2[2])
        && Array.isArray(t2) && t2[0] === '=' && t2[1] === ci
        && Array.isArray(t2[2]) && t2[2][0] === '-' && t2[2][1] === c2[2] && litN(t2[2][2], 1))
        result = { ci, bound: c2[2], node: n }
    }
  } })
  return result
}

// `ci = iv + k` (or `k + iv`) assignment/decl: returns { iv, tap } given the clamp var.
function clampSource(node, ci) {
  let found = null
  walkAst(node, { enter: n => {
    if (found) return false   // first match wins — prune once found
    if (n[0] === '=' && n[1] === ci && Array.isArray(n[2]) && n[2][0] === '+') {
      const [, a, b] = n[2]
      if (isVar(a) && isVar(b)) found = { a, b }
    }
  } })
  return found
}

// Count every write (=, compound-assign, ++/--) to variable `v` in `node`.
function countWrites(node, v) {
  let n = 0
  walkAst(node, { enter: x => { if (MUTATE_OPS.has(x[0]) && x[1] === v) n++ } })
  return n
}

// Inspect statement lists without removing their lexical scopes from the output.
const statements = n => n?.[0] === '{}' ? statements(n[1]) : n?.[0] === ';' ? n.slice(1) : [n]
const assigned = (n, name) => n?.[0] === '=' && n[1] === name ? n[2]
  : n?.[0] === 'let' || n?.[0] === 'const' ? counterInit(n, name) : null

// The clamp immediately follows its source within one canonical tap loop. The
// seed dominates that loop and its only update follows every tap: neither a
// conditional seed nor an update before the clamp may donate [-r,r].
function tapRadius(body, tap, clamp) {
  let radius = null, loops = 0
  walkAst(body, { enter: n => {
    const L = normalizeLoop(n)
    if (!L || L.cond?.[0] !== '<=' || L.cond[1] !== tap || !isVar(L.cond[2])) return
    loops++
    const r = L.cond[2], seq = statements(L.body)
    const update = L.step ?? seq[seq.length - 1]
    if (unitIncVar(update) !== tap || countWrites(L.body, tap) !== (L.step ? 0 : 1)) return
    let seed = L.init && counterInit(L.init, tap)
    if (!L.init) walkAst(body, { enter: parent => {
      if (parent[0] !== ';') return
      const at = parent.indexOf(n)
      if (at > 1) seed = assigned(parent[at - 1], tap)
    } })
    if (negOf(seed) !== r) return
    const at = seq.indexOf(clamp.node)
    if (at < 1 || assigned(seq[at - 1], clamp.ci) == null) return
    if (countWrites(body, tap) !== 2) return
    radius = r
  } })
  return loops === 1 ? radius : null
}

// Drop the clamp `if` node from a (cloned) body, leaving the bare `ci = iv + k`.
const dropClamp = (node, clampNode) =>
  !Array.isArray(node) ? node
    : node === clampNode ? ['{}', [';']]   // empty block (the if is a statement)
    : node.map(c => dropClamp(c, clampNode))

function tryPeel(stmt, cm) {
  // Normalize while / for into (iv, bound, body, init, step). For a `while`, the
  // increment is inside the body; for a `for` it is the separate step clause, which
  // we re-append to each split loop's body (converting the for into init + whiles).
  const L = normalizeLoop(stmt)
  if (!L) return null
  let { init, cond, step, body } = L
  if (!Array.isArray(cond) || cond[0] !== '<' || !isVar(cond[1])) return null
  const iv = cond[1], bound = cond[2]
  // The `for` step must be the IV's strictly-positive +1 increment; a `while` increments in
  // its body (validated below by the exactly-one-+1 checks).
  if (L.kind === 'for' && unitIncVar(step) !== iv) return null
  if (!isVar(bound) || !Array.isArray(body)) return null
  const clamp = findClamp(body)
  if (!clamp || clamp.bound !== bound) return null   // clamp bound must be this loop's bound
  const src = clampSource(body, clamp.ci)
  if (!src) return null
  // ci = a + b: one operand is the loop IV, the other the tap IV
  const tap = src.a === iv ? src.b : src.b === iv ? src.a : null
  if (!tap) return null
  const r = tapRadius(body, tap, clamp)
  if (r == null) return null

  // The clamp var must be written EXACTLY three times: its `ci = iv+k` source and the
  // two clamp branches (`ci=0`, `ci=bound-1`). Any extra write — `ci = ci-1`, `ci = -ci`
  // between the source and the clamp — changes what value the clamp actually guards, so
  // dropping the clamp in the interior (which assumes the guarded value is iv+k) is
  // unsound. Three is the exact count for a well-formed clamp; more ⇒ a mutation.
  if (countWrites(body, clamp.ci) !== 3) return null
  // Splitting a loop changes which loop an abrupt transfer would leave. Keep
  // those loops intact, including closures that could retain a copied binding.
  if (some(stmt, n => ['break', 'continue', 'return', 'throw', 'try', 'label', '=>', 'yield', 'await'].includes(n[0]))) return null
  const seq = statements(body)
  if (countWrites(body, iv) !== (step ? 0 : 1) || (!step && unitIncVar(seq[seq.length - 1]) !== iv)) return null
  const hz = loopHazards(cm, body)
  if (hz.mutated(bound) || hz.mutated(r)) return null
  if ([iv, tap, clamp.ci].some(name => cm.has(name))) return null
  if ([iv, bound, r, tap, clamp.ci].some(name => ctx.scope.globalTypes?.has(name) && !ctx.scope.consts?.has(name))) return null

  const id = freshLoopId()
  const xs = `__pks${id}`, xe = `__pke${id}`
  // xs = r < bound ? r : bound ;  xe = (bound - r) > xs ? bound - r : xs
  const seed = ['let',
    ['=', xs, ['?:', ['<', r, bound], r, bound]],
    ['=', xe, ['?:', ['>', ['-', bound, r], xs], ['-', bound, r], xs]]]
  // Each run owns its declarations; bindings outside the loop keep their
  // identity. The original for-head scope surrounds its single initialization,
  // the guard and either complete traversal.
  const inner = new Set()
  collectBindings(body, inner)
  const mk = (B, middle) => {
    const own = new Map([...inner].map(name => [name, `${name}$peel${freshLoopId()}`]))
    const bod = cloneWithSubst(middle ? dropClamp(body, clamp.node) : body, new Map(), own)
    const result = ['while', ['<', iv, B], step ? [';', bod, step] : bod]
    if (middle) result[2]._rangeFacts = [[own.get(clamp.ci) ?? clamp.ci, bound]]
    return result
  }
  const loops = [mk(xs, false), mk(xe, true), mk(bound, false)]
  const word = name => ['&&', numberGuard(name), ['===', name, ['|', name, [null, 0]]]]
  const guard = [word(iv), ['>=', iv, [null, 0]],
    ['||', ['!==', iv, [null, 0]], ['>', ['/', [null, 1], iv], [null, 0]]],
    word(bound), ['>=', bound, [null, 0]], word(r), ['>=', r, [null, 0]], ['<', r, [null, 2147483647]]]
    .reduce((a, b) => ['&&', a, b])
  const fallback = init ? ['for', null, cond, step, body] : stmt
  const guarded = ['if', guard, ['{}', [';', seed, ...loops]], fallback]
  return [init ? ['{}', [';', init, guarded]] : guarded]

}

// Run before integral copies rewrite tap-loop tests. The planning sweep owns
// program revision invalidation; each rewritten body drops its local caches.
export function peelClampedStencil() {
  if (ctx.transform.optimize?.clampPeel !== true) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    const old = func.body, cm = closureMutatedVars(frameNode(func))
    const body = rewriteBlocks(old, stmt => tryPeel(stmt, cm))
    if (body === old) continue
    func.body = body
    invalidateProgramFactsCache(old)
    invalidateBodies([old, body])
    changed = true
  }
  return changed
}
