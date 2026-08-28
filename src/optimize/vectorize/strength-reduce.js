import { walkAst } from '../../ast.js'
import { isLocalGet, matchLaneAddr } from './addr-model.js'
import { isArr } from './node-utils.js'

// ---- Induction-variable strength reduction --------------------------------

// Match `(i32.add (local.get $base) (i32.shl (local.get $ind) (i32.const K)))` in either
// operand order, or `(i32.add (local.get $base) (local.get $ind))` (K=0). Returns
// {base, k} — the address of element $ind in array $base, byte stride 1<<k — or null.
// Thin wrapper over matchLaneAddr (tee/CSE/AoS-free); both operand orders + bare-local base are this fn's own residual.
function matchAffineAddr(node, ind) {
  if (!isArr(node) || node[0] !== 'i32.add' || node.length !== 3) return null
  const fromOrder = (addr) => {
    const m = matchLaneAddr(addr, ind, undefined, undefined, false, undefined, undefined, false)
    return (m && isLocalGet(m.base) && m.base[1] !== ind) ? { base: m.base[1], k: m.strideLog2 } : null
  }
  return fromOrder(node) || fromOrder(['i32.add', node[2], node[1]])
}

/**
 * Strength-reduce induction-variable addressing in an affine loop the vectorizer
 * couldn't lift (an early `break`, a call, a non-lane body). For each loop-invariant
 * array `base` and shift `K`, every `base + (i<<K)` in the body is replaced by a strided
 * pointer `$p`, initialized to `base + (i<<K)` before the loop and bumped by `1<<K` in
 * lockstep with `i`. Drops the per-iteration shift+add — V8 does NOT strength-reduce this
 * itself (measured ~6% faster, the additive keep-`i` form used here). Canonical shape only
 * (single +1 IV, bottom increment, br_if exit). Bails if the body writes `i` or any `base`
 * (not invariant), or branches to the loop label (which would skip the pointer bump — a
 * `br_if` to the *block* label, i.e. an early break, is fine: the loop is exiting). Runs
 * only where the vectorizer runs (speed levels), so it never grows the size-tuned build.
 */
export function tryStrengthReduceIV(bl, fnLocals, freshIdRef) {
  // Bound-shape-agnostic: strength-reduces address arithmetic, not the loop bound,
  // so it accepts any scaffold (no local-or-const bound check). No preamble (was
  // allowPreamble:false).
  if (!bl || bl.preamble.length) return null
  const { loopNode, loopLabel, incIdx, incVar } = bl

  // Scan the body (stmts between the exit br_if and the bottom increment): collect
  // affine-address sites, track every written local, and bail on a loop-label branch.
  const sites = []                 // { parent, idx, base, k }
  const written = new Set()
  let bail = false
  const inspect = (node, parent, pi) => {
    if (bail || !isArr(node)) return false
    const op = node[0]
    if ((op === 'br' || op === 'br_if') && node[1] === loopLabel) { bail = true; return false }
    if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string') written.add(node[1])
    const m = matchAffineAddr(node, incVar)
    if (m) sites.push({ parent, idx: pi, base: m.base, k: m.k })
  }
  for (let i = 3; i < incIdx; i++) walkAst(loopNode[i], { enter: inspect })
  if (bail || !sites.length || written.has(incVar)) return null

  // Group by (base, k); keep only loop-invariant i32 bases.
  const groups = new Map()         // `base|k` → { base, k, sites }
  for (const s of sites) {
    if (written.has(s.base) || fnLocals.get(s.base) !== 'i32') continue
    const key = s.base + '|' + s.k
    let g = groups.get(key)
    if (!g) groups.set(key, g = { base: s.base, k: s.k, sites: [] })
    g.sites.push(s)
  }
  if (!groups.size) return null

  // One strided pointer per group: init before the block, bump after the i increment,
  // every matched address → (local.get $p).
  const id = freshIdRef.next++
  const preInits = [], bumps = [], newLocalDecls = []
  let gi = 0
  for (const g of groups.values()) {
    const p = `$__iv${id}_${gi++}`
    newLocalDecls.push(['local', p, 'i32'])
    const off = g.k === 0 ? ['local.get', incVar] : ['i32.shl', ['local.get', incVar], ['i32.const', g.k]]
    preInits.push(['local.set', p, ['i32.add', ['local.get', g.base], off]])
    bumps.push(['local.set', p, ['i32.add', ['local.get', p], ['i32.const', 1 << g.k]]])
    for (const s of g.sites) s.parent[s.idx] = ['local.get', p]
  }
  loopNode.splice(incIdx + 1, 0, ...bumps)   // after the induction increment, before the br
  return { wrapper: ['block', ...preInits, bl.blockNode], newLocalDecls }
}
