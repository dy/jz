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

const litN = (n, k) => Array.isArray(n) && n.length === 2 && n[0] == null && n[1] === k
const isVar = (n) => typeof n === 'string'

// `k = -r`: prepared as ['u-', r] (unary minus) or ['-', 0, r].
const negOf = (n) => Array.isArray(n) && n[0] === 'u-' ? n[1]
  : (Array.isArray(n) && n[0] === '-' && litN(n[1], 0) ? n[2] : null)

// Every write to `iv` in `node` is a strictly-positive step (++iv / iv+=1 / iv=iv+1),
// so iv advances monotonically — required so the three split loops partition [0,bound)
// and the clamp-free interior never re-runs at an edge index. Any other write → false.
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '**=', '&&=', '||=', '??='])
function ivMonotonic(node, iv) {
  if (!Array.isArray(node)) return true
  if ((node[0] === '++' || node[0] === '--') && node[1] === iv) return node[0] === '++'
  if (ASSIGN.has(node[0]) && node[1] === iv) {
    if (node[0] === '+=' && litN(node[2], 1)) return true
    if (node[0] === '=' && Array.isArray(node[2]) && node[2][0] === '+'
      && ((node[2][1] === iv && litN(node[2][2], 1)) || (node[2][2] === iv && litN(node[2][1], 1)))) return true
    return false   // any other assignment to iv (=, -=, *=, …) breaks monotonicity
  }
  return node.every(c => ivMonotonic(c, iv))
}

// Vars assigned inside any closure in the function — a call in the loop can mutate
// them even though findMutations (direct writes only) misses it. iv/bound/r in this
// set must bail (same class as the loop-SR closure-mutation guard).
const collectAssigns = (n, out) => {
  if (!Array.isArray(n)) return
  if (typeof n[1] === 'string' && (ASSIGN.has(n[0]) || n[0] === '++' || n[0] === '--')) out.add(n[1])
  n.forEach(c => collectAssigns(c, out))
}
const closureMutated = (n, out) => {
  if (!Array.isArray(n)) return out
  if (n[0] === '=>') collectAssigns(n, out)
  n.forEach(c => closureMutated(c, out))
  return out
}
let _cm = new Set()

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

let _uniq = 0

// Drop the clamp `if` node from a (cloned) body, leaving the bare `ci = iv + k`.
const dropClamp = (node, clampNode) =>
  !Array.isArray(node) ? node
    : node === clampNode ? ['{}', [';']]   // empty block (the if is a statement)
    : node.map(c => dropClamp(c, clampNode))

// A strictly-positive +1 step on `iv` (the for-loop increment): i++, ++i, i+=1, i=i+1.
const stepIsPosInc = (s, iv) => {
  if (!Array.isArray(s)) return false
  let inc = s
  if (s[0] === '-' && litN(s[2], 1) && Array.isArray(s[1]) && s[1][0] === '++') inc = s[1]
  if (inc[0] === '++' && inc[1] === iv) return true
  if (s[0] === '+=' && s[1] === iv && litN(s[2], 1)) return true
  return s[0] === '=' && s[1] === iv && Array.isArray(s[2]) && s[2][0] === '+'
    && ((s[2][1] === iv && litN(s[2][2], 1)) || (s[2][2] === iv && litN(s[2][1], 1)))
}

function tryPeel(stmt) {
  if (!Array.isArray(stmt)) return null
  // Normalize while / for into (iv, bound, body, init, step). For a `while`, the
  // increment is inside the body; for a `for` it is the separate step clause, which
  // we re-append to each split loop's body (converting the for into init + whiles).
  let iv, bound, body, init = null, step = null
  if (stmt[0] === 'while') {
    const cond = stmt[1]
    if (!Array.isArray(cond) || cond[0] !== '<' || !isVar(cond[1])) return null
    iv = cond[1]; bound = cond[2]; body = stmt[2]
  } else if (stmt[0] === 'for') {
    init = stmt[1]; const cond = stmt[2]; step = stmt[3]; body = stmt[4]
    if (!Array.isArray(cond) || cond[0] !== '<' || !isVar(cond[1])) return null
    iv = cond[1]; bound = cond[2]
    if (!stepIsPosInc(step, iv)) return null
  } else return null
  if (!isVar(bound) || !Array.isArray(body) || body[0] !== ';') return null

  const clamp = findClamp(body)
  if (!clamp || clamp.bound !== bound) return null   // clamp bound must be this loop's bound
  const src = clampSource(body, clamp.ci)
  if (!src) return null
  // ci = a + b: one operand is the loop IV, the other the tap IV
  const tap = src.a === iv ? src.b : src.b === iv ? src.a : null
  if (!tap) return null
  const r = tapRadius(body, tap)
  if (r == null) return null

  // Soundness: iv advances monotonically (else the interior re-runs at an edge index),
  // and bound/r are loop-invariant (else the once-computed xs/xe go stale mid-loop).
  if (!ivMonotonic(body, iv)) return null
  const mut = new Set(); findMutations(body, new Set([bound, r]), mut)
  if (mut.has(bound) || mut.has(r)) return null
  if (_cm.has(iv) || _cm.has(bound) || _cm.has(r)) return null  // closure-mutable → unsafe

  const id = _uniq++
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

function walk(node) {
  if (!Array.isArray(node)) return node
  const n = node.map(walk)
  if (n[0] !== ';') return n
  const out = [';']
  for (let k = 1; k < n.length; k++) {
    const r = tryPeel(n[k])
    if (r) out.push(...r)
    else out.push(n[k])
  }
  return out
}

export function peelClampedStencil(body) {
  _cm = closureMutated(body, new Set())
  return walk(body)
}
