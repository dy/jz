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
// literal tests use `== null`; created literals are bare numbers.

import { findMutations } from './analyze-scans.js'
import { ASSIGN_OPS } from '../ast.js'
import { litN, unitIncVar, normalizeLoop, closureMutatedVars, rewriteBlocks, freshLoopId } from './loop-model.js'

const isVar = (n) => typeof n === 'string'

// `k = -r`: prepared as ['u-', r] (unary minus) or ['-', 0, r].
const negOf = (n) => Array.isArray(n) && n[0] === 'u-' ? n[1]
  : (Array.isArray(n) && n[0] === '-' && litN(n[1], 0) ? n[2] : null)

// Every write to `iv` in `node` is a strictly-positive step (++iv / iv+=1 / iv=iv+1),
// so iv advances monotonically — required so the three split loops partition [0,bound)
// and the clamp-free interior never re-runs at an edge index. Any other write → false.
function ivMonotonic(node, iv) {
  if (!Array.isArray(node)) return true
  if ((node[0] === '++' || node[0] === '--') && node[1] === iv) return node[0] === '++'
  if (ASSIGN_OPS.has(node[0]) && node[1] === iv) {
    if (node[0] === '+=' && litN(node[2], 1)) return true
    if (node[0] === '=' && Array.isArray(node[2]) && node[2][0] === '+'
      && ((node[2][1] === iv && litN(node[2][2], 1)) || (node[2][2] === iv && litN(node[2][1], 1)))) return true
    return false   // any other assignment to iv (=, -=, *=, …) breaks monotonicity
  }
  return node.every(c => ivMonotonic(c, iv))
}

// Find, anywhere in `node`, a clamp `if (ci < 0) ci = 0; else if (ci >= B) ci = B-1`
// over a var `ci` and bound var `B`. Returns { ci, bound } or null (first match).
function findClamp(node) {
  if (!Array.isArray(node)) return null
  if (node[0] === 'if') {
    const [, cond, then, els] = node
    // outer: if (ci < 0) ci = 0; else <inner>
    if (Array.isArray(cond) && cond[0] === '<' && isVar(cond[1]) && litN(cond[2], 0)
      && Array.isArray(then) && then[0] === '=' && then[1] === cond[1] && litN(then[2], 0)
      && Array.isArray(els) && els[0] === 'if') {
      const ci = cond[1], [, c2, t2] = els
      // inner: if (ci >= B) ci = B-1
      if (Array.isArray(c2) && c2[0] === '>=' && c2[1] === ci && isVar(c2[2])
        && Array.isArray(t2) && t2[0] === '=' && t2[1] === ci
        && Array.isArray(t2[2]) && t2[2][0] === '-' && t2[2][1] === c2[2] && litN(t2[2][2], 1))
        return { ci, bound: c2[2], node }
    }
  }
  for (const c of node) { const r = findClamp(c); if (r) return r }
  return null
}

// `ci = iv + k` (or `k + iv`) assignment/decl: returns { iv, tap } given the clamp var.
function clampSource(node, ci) {
  let found = null
  const visit = (n) => {
    if (found || !Array.isArray(n)) return
    if (n[0] === '=' && n[1] === ci && Array.isArray(n[2]) && n[2][0] === '+') {
      const [, a, b] = n[2]
      if (isVar(a) && isVar(b)) found = { a, b }
    }
    n.forEach(visit)
  }
  visit(node)
  return found
}

// The tap IV must range EXACTLY [-r, r]: a loop `while (t <= r)` AND `t` seeded to
// `-r` (same `r`). Returns the radius var `r` only when both match; null otherwise.
// Asymmetric / wider ranges would make xs=r, xe=bound-r unsound, so they bail.
function tapRadius(loopBody, tap) {
  let boundR = null, initR = null
  const visit = (n) => {
    if (!Array.isArray(n)) return
    // tap loop bound `k <= r`: while (cond at [1]) or for (cond at [2]).
    const cond = n[0] === 'while' ? n[1] : n[0] === 'for' ? n[2] : null
    if (Array.isArray(cond) && cond[0] === '<=' && cond[1] === tap && isVar(cond[2])) boundR = cond[2]
    // tap init `k = -r` (a bare assignment, or inside the for's `let` init clause).
    if (n[0] === '=' && n[1] === tap) { const neg = negOf(n[2]); if (isVar(neg)) initR = neg }
    n.forEach(visit)
  }
  visit(loopBody)
  return boundR != null && boundR === initR ? boundR : null
}

// Count every write (=, compound-assign, ++/--) to variable `v` in `node`.
function countWrites(node, v) {
  let n = 0
  const visit = (x) => {
    if (!Array.isArray(x)) return
    if ((x[0] === '++' || x[0] === '--') && x[1] === v) n++
    else if (ASSIGN_OPS.has(x[0]) && x[1] === v) n++
    x.forEach(visit)
  }
  visit(node)
  return n
}

// Count tap-shaped seeds (`tap = -r`) and bounds (`tap <= r`) in `body`. The peel is
// sound only for a SINGLE tap loop; two loops sharing the tap var make tapRadius pick
// the wrong (last-seen) radius, so xs=r/xe=bound-r no longer match the clamped loop.
function tapStructures(body, tap) {
  let seeds = 0, bounds = 0
  const visit = (n) => {
    if (!Array.isArray(n)) return
    const cond = n[0] === 'while' ? n[1] : n[0] === 'for' ? n[2] : null
    if (Array.isArray(cond) && cond[0] === '<=' && cond[1] === tap && isVar(cond[2])) bounds++
    if (n[0] === '=' && n[1] === tap && isVar(negOf(n[2]))) seeds++
    n.forEach(visit)
  }
  visit(body)
  return { seeds, bounds }
}

// True if `iv` is written anywhere INSIDE a nested loop within `body`. Then iv is not
// constant across the tap accumulation (e.g. an `iv++` living inside the tap loop, so
// the real outer step is 2r+1), and the per-outer-iteration peel is unsound.
function ivWrittenInNestedLoop(body, iv) {
  let found = false
  const visit = (n, inLoop) => {
    if (!Array.isArray(n)) return
    if (inLoop && (((n[0] === '++' || n[0] === '--') && n[1] === iv) || (ASSIGN_OPS.has(n[0]) && n[1] === iv))) found = true
    const deeper = inLoop || n[0] === 'while' || n[0] === 'for'
    n.forEach(c => visit(c, deeper))
  }
  visit(body, false)
  return found
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
  // its body (validated below by ivMonotonic / the exactly-one-+1 checks).
  if (L.kind === 'for' && unitIncVar(step) !== iv) return null
  if (!isVar(bound) || !Array.isArray(body)) return null
  // A loop whose body is a single statement (e.g. an outer row loop wrapping one
  // inner loop — the vertical blur pass) isn't a `;` sequence; normalize it.
  if (body[0] !== ';') body = [';', body]

  const clamp = findClamp(body)
  if (!clamp || clamp.bound !== bound) return null   // clamp bound must be this loop's bound
  const src = clampSource(body, clamp.ci)
  if (!src) return null
  // ci = a + b: one operand is the loop IV, the other the tap IV
  const tap = src.a === iv ? src.b : src.b === iv ? src.a : null
  if (!tap) return null
  const r = tapRadius(body, tap)
  if (r == null) return null

  // The clamp var must be written EXACTLY three times: its `ci = iv+k` source and the
  // two clamp branches (`ci=0`, `ci=bound-1`). Any extra write — `ci = ci-1`, `ci = -ci`
  // between the source and the clamp — changes what value the clamp actually guards, so
  // dropping the clamp in the interior (which assumes the guarded value is iv+k) is
  // unsound. Three is the exact count for a well-formed clamp; more ⇒ a mutation.
  if (countWrites(body, clamp.ci) !== 3) return null
  // Exactly one tap loop (one seed, one bound): two loops sharing the tap var would let
  // tapRadius pick the wrong radius.
  const ts = tapStructures(body, tap)
  if (ts.seeds !== 1 || ts.bounds !== 1) return null
  // iv must be constant across the tap accumulation — not bumped inside the tap loop.
  if (ivWrittenInNestedLoop(body, iv)) return null

  // Soundness: iv advances monotonically (else the interior re-runs at an edge index),
  // and bound/r are loop-invariant (else the once-computed xs/xe go stale mid-loop).
  if (!ivMonotonic(body, iv)) return null
  const mut = new Set(); findMutations(body, new Set([bound, r]), mut)
  if (mut.has(bound) || mut.has(r)) return null
  if (cm.has(iv) || cm.has(bound) || cm.has(r)) return null  // closure-mutable → unsafe

  const id = freshLoopId()
  const xs = `__pks${id}`, xe = `__pke${id}`
  // xs = r < bound ? r : bound ;  xe = (bound - r) > xs ? bound - r : xs
  const seed = ['let',
    ['=', xs, ['?:', ['<', r, bound], r, bound]],
    ['=', xe, ['?:', ['>', ['-', bound, r], xs], ['-', bound, r], xs]]]
  const interiorBody = dropClamp(body, clamp.node)
  // for: append the step to each split loop's body; while: body already increments.
  const mk = (B, bod) => ['while', ['<', iv, B], step ? [';', ...bod.slice(1), step] : bod]
  const loops = [mk(xs, body), mk(xe, interiorBody), mk(bound, body)]
  return init ? [init, seed, ...loops] : [seed, ...loops]
}

export function peelClampedStencil(body) {
  const cm = closureMutatedVars(body)
  return rewriteBlocks(body, stmt => tryPeel(stmt, cm))
}
