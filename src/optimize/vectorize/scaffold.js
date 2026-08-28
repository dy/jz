import { DBG_INVARIANTS } from '../../ctx.js'
import { walkAst } from '../../ast.js'
import { assertBodyModelSound, buildBodyModel, collectReferencedNames, collectWrites, constNum, hasGlobalSet, hasImpureCall, hasSideEffect, isLocalGet, matchExitBrIf, matchInc1, matchIncN } from './addr-model.js'
import { isArr } from './node-utils.js'

// ---- Recognize a (block (loop)) pair --------------------------------------

/**
 * Match the canonical vectorizable loop SCAFFOLD shared by every inner-loop
 * recognizer:
 *   (block $blk [preamble…]
 *     (loop $loop
 *       (br_if $blk (i32.eqz (i32.lt_{s,u} $i BOUND)))   ; exit guard
 *       BODY…
 *       (local.set $i (i32.add $i 1))                     ; bottom increment
 *       (br $loop)))
 *
 * Returns the structural FACTS only — no policy — or null when the shape
 * doesn't match:
 *   { blockNode, blockLabel, loopNode, loopLabel, endIdx, incIdx, incVar,
 *     exitInfo, bound, boundLocal, body, preamble }
 *   - `blockNode` is the original block, embedded verbatim as the scalar tail by
 *     each lifter's wrapper (the never-miscompile remainder loop).
 *   - `body`       = loopNode.slice(3, incIdx) (between exit guard and increment)
 *   - `bound`      = the raw BOUND expr; `boundLocal` = its local name when it is
 *     `(local.get $L)`, else null. Bound shape is NOT rejected here — callers that
 *     require a local-or-const bound check it themselves (tryStrengthReduceIV is
 *     bound-shape-agnostic, so baking a rejection in would change its behavior).
 *
 * `opts.allowPreamble` (default false): when true, LICM-hoisted invariant
 *   `(local.set $__li* EXPR)` statements BEFORE the loop are collected into
 *   `preamble` (pure & loop-invariant by construction — safe to clone/re-run);
 *   a non-`$__li` preamble, an impure value, or any array content AFTER the loop
 *   bails. When false, ANY non-loop array content in the block bails.
 *
 * Three opt-ins below cover recognizers whose acceptance genuinely differs — see each for
 * its exact contract: `opts.multiInc` (tryRampMap), `opts.envelope: 'loose'`
 * (tryBlurMultiPixel/tryChannelReduce), `opts.envelope: 'pixelIV'` (matchOuterPixelLoop).
 */
// A transparent block — no label (first child isn't a `$label` string) and no result — is
// pure statement grouping: wasm locals are function-scoped, and an unlabeled resultless block
// is neither a branch target nor a value producer, so it can ONLY appear in statement position
// (a resultless block in value position is a type error). jz emits one per source statement
// group; watr's mergeBlocks/vacuum flattens them post-hoc. The vectorizer is jz LOWERING
// (pre-watr), so it normalizes them itself IN PLACE — splicing each transparent block's
// children into its parent's statement list — so every recognizer (scaffold-consuming AND
// raw-node) reads the flat statement lists they were tuned against. Post-order: children are
// already flat when a block is spliced up. A labeled block (branch target) or result-carrying
// block (value producer) is kept — including the `(block $brk (loop …))` SIMD scaffold itself.
export function normalizeTransparentBlocks(node) {
  if (!isArr(node)) return
  for (let i = 1; i < node.length; i++) normalizeTransparentBlocks(node[i])
  for (let i = node.length - 1; i >= 1; i--) {
    const c = node[i]
    if (isArr(c) && c[0] === 'block' &&
        !(typeof c[1] === 'string' && c[1].startsWith('$')) &&
        !(isArr(c[1]) && c[1][0] === 'result'))
      node.splice(i, 1, ...c.slice(1))
  }
}

// Fold the arithmetic identities watr's `identity` pass removes but jz emits raw — most
// importantly `i<<0` (a byte-stride address for a u8/i8 array: `base + (i << 0)`), which the
// vectorizer's address matchers, tuned on watr's folded IR, read as bare `i`. Also the trivial
// `x±0`, `x|0`, `x^0`, `x<<0/>>0`, `x*1`. In place, bottom-up; returns the (possibly folded)
// node so a parent can rebind. Pure syntactic identities — always sound, watr-equivalent.
export function foldVecIdentities(node) {
  if (!isArr(node)) return node
  for (let i = 1; i < node.length; i++) node[i] = foldVecIdentities(node[i])
  if (node.length !== 3) return node
  const op = node[0], a = node[1], b = node[2]
  const ci = (n) => isArr(n) && (n[0] === 'i32.const' || n[0] === 'i64.const') ? Number(n[1]) : NaN
  const rb = ci(b), ra = ci(a)
  switch (op) {
    case 'i32.shl': case 'i32.shr_s': case 'i32.shr_u':
    case 'i64.shl': case 'i64.shr_s': case 'i64.shr_u':
      return rb === 0 ? a : node                       // x << 0 = x (right-identity only)
    case 'i32.add': case 'i32.or': case 'i32.xor':
    case 'i64.add': case 'i64.or': case 'i64.xor':
      return rb === 0 ? a : (ra === 0 ? b : node)      // x±0, x|0, x^0 (either side)
    case 'i32.sub': case 'i64.sub':
      return rb === 0 ? a : node                       // x - 0 = x
    case 'i32.mul': case 'i64.mul':
      return rb === 1 ? a : (ra === 1 ? b : node)      // x*1
    default: return node
  }
}

// Canonicalize jz's `if COND (then (br L))` break-idiom to watr's `br_if L COND` — the shape the
// loop-scan recognizers (byte-scan, divergent-escape) match. watr's `brif` pass does this
// post-hoc; the pre-watr vectorizer needs it now. Only the statement-form (no result), no-else,
// single-`br`-then shape becomes a br_if — anything richer is left untouched for watr. In place,
// top-down (a converted br_if has no nested `if` to revisit).
export function canonicalizeIfBr(node) {
  walkAst(node, { enter: (c, parent, i) => {
    if (!parent) return
    if (c[0] === 'if' && c.length === 3 &&
        !(isArr(c[1]) && c[1][0] === 'result') &&
        isArr(c[2]) && c[2][0] === 'then' && c[2].length === 2 &&
        isArr(c[2][1]) && c[2][1][0] === 'br' && c[2][1].length === 2 && typeof c[2][1][1] === 'string') {
      // `(br L)` only — a value-carrying `(br L v)` would lose its operand under br_if's 2-arg form.
      parent[i] = ['br_if', c[2][1][1], c[1]]
      return false
    }
  } })
}

// Shared tail of every envelope below: the loop's own label (position 1) and its bottom
// `(br label)` back-edge. Returns { loopLabel, endIdx } or null.
function matchLoopBrEnd(loopNode) {
  const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
  if (!loopLabel) return null
  const endIdx = loopNode.length - 1
  if (!(isArr(loopNode[endIdx]) && loopNode[endIdx][0] === 'br' && loopNode[endIdx][1] === loopLabel)) return null
  return { loopLabel, endIdx }
}

// Per-loop-body facts every "classify each referenced local" recognizer re-derived
// from `body` before doing its own recognizer-specific classification: `writes` (names
// written anywhere in the body — loop-invariance/lane tests key off this),
// `referenced` (all names touched, get or set/tee — the classification domain),
// `hasGlobalSet` (a global write breaks the "global.get is invariant" splat, checked
// verbatim by tryVectorize/tryStencil/tryRampMap/tryToneMap), `hasImpureCall` (a non-pure
// call breaks per-lane epilogue re-evaluation — see hasImpureCall's own doc). Computed once
// here per LoopPlan; consumers read bl.writes/bl.referenced/bl.hasGlobalSet instead of
// re-walking.
//
// Also computes BodyModel (.work/research.md §BodyModel; consumed by tryReduceBitExact/
// tryRampMap): `addrTable`/`offsetTees`/`siteAccess`/`aliasClass`, spread in below. `offsetTees`
// is ONE construction — `buildBodyModel` derives it FROM `addrTable`, so it rides in with
// `...bm` instead of its own separate `deriveOffsetTees` call. JZ_DEBUG_INVARIANTS
// shadow-asserts the generalization against the private predicates it will eventually let
// recognizers retire.
function bodyFacts(body, ind) {
  const writes = new Set()
  for (const s of body) collectWrites(s, writes)
  const referenced = new Set()
  for (const s of body) collectReferencedNames(s, referenced)
  const bm = buildBodyModel(body, ind)
  if (DBG_INVARIANTS) assertBodyModelSound(body, ind, bm)
  return { writes, referenced, hasGlobalSet: body.some(hasGlobalSet), hasImpureCall: body.some(hasImpureCall), ...bm }
}

export function matchBlockLoop(blockNode, opts = {}) {
  if (!isArr(blockNode) || blockNode[0] !== 'block') return null

  // envelope: 'pixelIV' — matchOuterPixelLoop's scaffold (see its own header doc); exit-guard
  // and increment stay matchOuterPixelLoop's own residual.
  if (opts.envelope === 'pixelIV') {
    if (!(typeof blockNode[1] === 'string' && blockNode[1].startsWith('$'))) return null
    const blockLabel = blockNode[1]
    let loopNode = null
    const preamble = []
    for (let i = 2; i < blockNode.length; i++) {
      const c = blockNode[i]
      if (!isArr(c)) return null
      if (c[0] === 'loop') { if (loopNode) return null; loopNode = c }
      else if (loopNode) return null              // statement after the loop → bail
      else if (c[0] !== 'local.set') return null  // preamble must be pure local.set
      else preamble.push(c)
    }
    if (!loopNode) return null
    const le = matchLoopBrEnd(loopNode)
    if (!le) return null
    return { blockNode, blockLabel, loopNode, loopLabel: le.loopLabel, endIdx: le.endIdx, preamble }
  }

  // envelope: 'loose' (tryBlurMultiPixel/tryChannelReduce) tolerates ANY non-loop content
  // anywhere — before or after the loop — with no validation at all; woven into the same
  // scan as the default/allowPreamble envelope below rather than duplicating it.
  const loose = opts.envelope === 'loose'
  const allowPreamble = loose || !!opts.allowPreamble
  let blockLabel = null, loopNode = null
  const preamble = []
  for (let i = 1; i < blockNode.length; i++) {
    const c = blockNode[i]
    if (typeof c === 'string' && c.startsWith('$') && blockLabel == null && i === 1) { blockLabel = c; continue }
    if (isArr(c) && c[0] === 'loop') {
      if (loopNode) return null  // multiple loops
      loopNode = c
    } else if (isArr(c)) {
      if (loose) continue
      // `loopNode` truthy ⇒ this content is AFTER the loop ⇒ bail (even for a $__li set).
      // A LICM-hoisted invariant is `$__liN`; INLINING renames it (e.g. `$__inl7___li0`). Default
      // accepts only un-inlined `$__li*` (keeps the existing recognizers byte-identical);
      // `allowInlinedLi` (gated callers only) also accepts the `__liN` marker anywhere — both are
      // pure & loop-invariant by construction (belt-and-suspenders: hasSideEffect guard).
      // Under allowInlinedLi a block preamble is loop-invariant by construction (jz hoists only
      // invariants before the loop; IV-dependent work lives in the body), so any PURE local.set is
      // safe to clone ahead of the SIMD — covers $__inl*__li* (schrodinger) AND $_pg0-style
      // peephole-hoisted bounds (slime). The hasSideEffect guard rejects impure setups.
      const liOk = typeof c[1] === 'string' && (opts.allowInlinedLi ? true : c[1].startsWith('$__li'))
      if (!allowPreamble || loopNode || c[0] !== 'local.set' || !liOk || hasSideEffect(c[2])) return null
      preamble.push(c)
    }
  }
  if (!loopNode || !blockLabel) return null

  const le = matchLoopBrEnd(loopNode)
  if (!le) return null
  const { loopLabel, endIdx } = le
  if (loose) return { blockNode, blockLabel, loopNode, loopLabel, endIdx }

  // multiInc (tryRampMap) — trailing RUN of `x += C` (matchIncN); the exit IV must be in
  // the run stepping by exactly 1. Other constraints on the run are tryRampMap's residual.
  if (opts.multiInc) {
    const exitInfo = matchExitBrIf(loopNode[2], blockLabel)
    if (!exitInfo) return null
    const increments = []
    let bodyEnd = endIdx - 1
    while (bodyEnd >= 2) {
      const inc = matchIncN(loopNode[bodyEnd])
      if (!inc) break
      increments.unshift(inc)
      bodyEnd--
    }
    if (!increments.length) return null
    const ivInc = increments.find(x => x.name === exitInfo.ind)
    if (!ivInc || ivInc.c !== 1) return null
    const incVar = exitInfo.ind
    const bound = exitInfo.bound
    const boundLocal = isArr(bound) && bound[0] === 'local.get' && typeof bound[1] === 'string' ? bound[1] : null
    const body = loopNode.slice(3, bodyEnd + 1)
    return { blockNode, blockLabel, loopNode, loopLabel, endIdx, incVar, exitInfo, bound, boundLocal, body, preamble, increments, ...bodyFacts(body, incVar) }
  }

  const incIdx = endIdx - 1
  let incVar = matchInc1(loopNode[incIdx])
  // CSE'd increment (gated): O3 may fold `x+1` into a body tee (the `xe = x+1` wrap) and write the
  // increment as `x = $t` reusing it. Recover the IV when `$t` is `(tee/set $t (i32.add x 1))` in body.
  if (!incVar && opts.allowInlinedLi) {
    const inc = loopNode[incIdx]
    if (isArr(inc) && inc[0] === 'local.set' && inc.length === 3 && isLocalGet(inc[2])) {
      const copyOf = inc[2][1], iv = inc[1]
      const findInc1 = (m) => isArr(m) && (((m[0] === 'local.set' || m[0] === 'local.tee') && m[1] === copyOf && isArr(m[2]) && m[2][0] === 'i32.add' && isLocalGet(m[2][1], iv) && constNum(m[2][2]) === 1) || m.some(findInc1))
      if (loopNode.slice(3, incIdx).some(findInc1)) incVar = iv
    }
  }
  if (!incVar) return null

  const exitInfo = matchExitBrIf(loopNode[2], blockLabel)
  if (!exitInfo || exitInfo.ind !== incVar) return null

  const bound = exitInfo.bound
  const boundLocal = isArr(bound) && bound[0] === 'local.get' && typeof bound[1] === 'string' ? bound[1] : null
  const body = loopNode.slice(3, incIdx)
  return { blockNode, blockLabel, loopNode, loopLabel, endIdx, incIdx, incVar, exitInfo, bound, boundLocal, body, preamble, ...bodyFacts(body, incVar) }
}
