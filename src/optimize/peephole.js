/**
 * Peephole / rewrite family: the fused bottom-up peephole+inline+memarg walk
 * (fusedRewrite/walkRewrite — the generic rewrite walker), the branchless
 * select conversions (boolConvertToSelect, if→select inside walkRewrite),
 * boolean-context canonicalization (simplifyBoolContexts, tied to loop
 * rotation), loop rotation (rotateLoops), and the late ptr_offset inliner
 * (inlinePtrOffsetFastPass) + its v128-memarg twin (foldV128Memargs).
 *
 * @module optimize/peephole
 */
import { LAYOUT, ctx, FORWARDING_MASK } from '../ctx.js'
import { findBodyStart, isPureIR, hasExpensiveOp, f64Range, I32_MIN, I32_MAX, cloneIR } from '../ir.js'
import { isLeaf, walkAst } from '../ast.js'
import { nanPrefixHex, atomNanHex, STR_INTERN_BIT } from '../../layout.js'
import { containsV128 } from './ir-scan.js'

const MEMOP = /^[fi](32|64)\.(load|store)(\d+(_[su])?)?$/
const NAN_BITS = nanPrefixHex()
const NULL_BITS = atomNanHex(1)
const UNDEF_BITS = atomNanHex(2)
const FALSE_BITS = atomNanHex(4)

// wasm comparison ops — each yields an i32 that is exactly 0 or 1.
const BOOL_RESULT_OPS = new Set([
  'i32.eqz', 'i64.eqz',
  'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u', 'i32.gt_s', 'i32.gt_u', 'i32.le_s', 'i32.le_u', 'i32.ge_s', 'i32.ge_u',
  'i64.eq', 'i64.ne', 'i64.lt_s', 'i64.lt_u', 'i64.gt_s', 'i64.gt_u', 'i64.le_s', 'i64.le_u', 'i64.ge_s', 'i64.ge_u',
  'f32.eq', 'f32.ne', 'f32.lt', 'f32.gt', 'f32.le', 'f32.ge',
  'f64.eq', 'f64.ne', 'f64.lt', 'f64.gt', 'f64.le', 'f64.ge',
])

/**
 * `f64 ± (cond ? 1 : 0)` → branchless f64 `select`, killing the i32↔f64 domain cross.
 *
 * `err = old - (old >= t)` and friends compile to `f64.sub(X, f64.convert_i32_s(cmp))`.
 * The convert (cvtsi2sd) round-trips the comparison result out of a GPR back into an
 * XMM register — a domain-crossing op that sits ON the value's def chain. In the
 * per-pixel error-diffusion sweeps (Floyd–Steinberg / Atkinson / JJN) and scalar IIR
 * thresholds this chain is the loop-carried critical path, so that one cross roughly
 * doubles the per-step latency (V8 keeps the JS threshold entirely in the FP domain).
 *
 * `X - (B?1:0) ≡ (B ? X-1 : X) ≡ select(X-1, X, B)`  (likewise `+` → `select(X+1, X, B)`),
 * which never leaves the f64 domain. `select` evaluates BOTH arms, so X must be a
 * side-effect-free duplicable leaf (a `local.get`/const); B is the i32 condition,
 * evaluated once (exactly as the convert did). A pure win on latency-bound recurrences;
 * speed-gated (it adds a const + an arithmetic op — a size↔speed trade) — off at 'size'.
 */
export function boolConvertToSelect(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  // Pass 1 — a local whose SOLE definition is a comparison carries a value ∈ {0,1};
  // `err = old - on` (on reused by putBW) reaches us as `convert(local.get $on)`.
  // A param is EXCLUDED even if reassigned once by a comparison: its incoming arg is
  // unconstrained, so a read before the reassignment isn't 0/1. (A plain local read
  // before its def is safe — wasm zero-inits it to 0 = false, which select preserves.)
  const params = new Set()
  for (let i = 2; i < fn.length; i++) if (Array.isArray(fn[i]) && fn[i][0] === 'param') params.add(fn[i][1])
  const defCount = new Map(), defIsCmp = new Map()
  walkAst(fn, { enter: n => {
    if (!Array.isArray(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') {
      defCount.set(n[1], (defCount.get(n[1]) || 0) + 1)
      const cmp = Array.isArray(n[2]) && BOOL_RESULT_OPS.has(n[2][0])
      defIsCmp.set(n[1], (defIsCmp.has(n[1]) ? defIsCmp.get(n[1]) : true) && cmp)
    }
  } })
  const boolLocals = new Set()
  for (const [name, c] of defCount) if (c === 1 && defIsCmp.get(name) && !params.has(name)) boolLocals.add(name)

  const isBool01 = (n) => Array.isArray(n) &&
    (BOOL_RESULT_OPS.has(n[0]) || (n[0] === 'local.get' && boolLocals.has(n[1])))

  // Pass 2 — bottom-up rewrite.
  const rewrite = (n) => {
    if (!Array.isArray(n)) return n
    for (let i = 1; i < n.length; i++) n[i] = rewrite(n[i])
    if ((n[0] === 'f64.sub' || n[0] === 'f64.add') && n.length === 3) {
      const conv = (m) => Array.isArray(m) && (m[0] === 'f64.convert_i32_s' || m[0] === 'f64.convert_i32_u') && isBool01(m[1])
      // `X - bool`, `X + bool`, or (add is commutative) `bool + X`.
      let X = null, B = null
      if (conv(n[2]) && isLeaf(n[1])) { X = n[1]; B = n[2][1] }
      else if (n[0] === 'f64.add' && conv(n[1]) && isLeaf(n[2])) { X = n[2]; B = n[1][1] }
      if (X) return ['select', [n[0], cloneIR(X), ['f64.const', 1]], cloneIR(X), B]
    }
    return n
  }
  rewrite(fn)
}

// Fold `(v128.load/store (i32.add base K) …)` → `(… offset=K base …)`. Same logic as
// walkRewrite's scalar foldMemargOffsets (MEMOP path), but for the v128 loads/stores the
// lane vectorizer creates AFTER fusedRewrite has already run — so they'd otherwise keep a
// per-iteration i32.add. Bottom-up, in place; an addr already in offset=/align= form is left.
export function foldV128Memargs(node) {
  walkAst(node, { enter: n => {
    const op = n[0]
    if (op === 'v128.load' || op === 'v128.store') {
      const m1 = n[1]
      if (!(typeof m1 === 'string' && (m1.startsWith('offset=') || m1.startsWith('align='))) &&
          Array.isArray(m1) && m1[0] === 'i32.add' && m1.length === 3) {
        const a = m1[1], b = m1[2]
        let base, offset
        if (Array.isArray(b) && b[0] === 'i32.const' && typeof b[1] === 'number' && b[1] >= 0 && b[1] < 0x100000000) { base = a; offset = b[1] }
        else if (Array.isArray(a) && a[0] === 'i32.const' && typeof a[1] === 'number' && a[1] >= 0 && a[1] < 0x100000000) { base = b; offset = a[1] }
        if (base != null) { n[1] = `offset=${offset}`; n.splice(2, 0, base) }
      }
    }
  } })
}

/** Speed-tier: inline `$__ptr_offset`'s own loop-free body (mask+tag test, then
 *  followForwardingWat's bounds/sentinel check) at each surviving call site —
 *  the cold relocation-chase call ($__ptr_offset_fwd, the only loop) stays
 *  out-of-line. Trades bytes/site for the self-compile kernel's dominant helper
 *  call by call count — every NaN-box deref is an out-of-line call, kept a
 *  real function by the forwarding branch.
 *
 *  Deliberately its OWN late pass, not folded into fusedRewrite's earlier walk
 *  (where a first version lived): unswitchTypedParamLoop's polymorphic-store
 *  recognizer pattern-matches the RAW `(call $__ptr_offset …)` shape to prove a
 *  Float64Array param loop safe to unswitch + SIMD-lift. Inlining eagerly
 *  erased that shape before the unswitch ran and silently cost a whole
 *  scalar→SIMD loop lift to save a handful of call frames (caught by
 *  test/unswitch-typed-param.js). Running here — after unswitchTypedParamLoop
 *  and vectorizeLaneLocal have had their pick — inlines whatever calls remain,
 *  still the large majority of sites (hoistInvariantPtrOffset/hoistInvariantLoop
 *  already collapsed same-argument repeats to one call each, earlier in 'pre').
 *
 *  `off` must survive past the tag-test branch (it's the return value on BOTH
 *  the forwarding and non-forwarding arms), hence the i32 scratch + wrapping
 *  value-block — the same `['block', ['result', ty], …]` shape the EMITTER
 *  already uses pervasively (module/array.js etc.) for multi-statement f64/i32
 *  expressions, just built by the optimizer instead. */
export function inlinePtrOffsetFastPass(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  // Skip $__ptr_offset's own body and its cold chase — they ARE the helper.
  const name = typeof fn[1] === 'string' ? fn[1] : null
  if (name && name.startsWith('$__ptr_')) return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const newDecls = []
  // `$__poff<N>` — NOT `$__inl<N>...`, which is watr's OWN reserved namespace
  // for its multi-caller function inliner (cfg.inlineFns → watr `inline`
  // option, watr-tail.js, active at this same speed tier): sharing it produced
  // a real `Duplicate local` assembler error when watr's inliner and this pass
  // independently picked the same index. `__poffb<N>` is the i64 bits tee (only
  // needed when the pointer expression isn't cheap to duplicate); `__poff<N>`
  // is the i32 offset scratch. Continue numbering past any this function
  // already has (defensive — this pass runs once per function today, but
  // matches the collision-avoidance convention fusedRewrite's own scratch
  // allocator uses).
  let bN = 0, oN = 0
  for (let i = 2; i < fn.length; i++) {
    const d = fn[i]
    if (Array.isArray(d) && d[0] === 'local' && typeof d[1] === 'string') {
      const mb = d[1].match(/^\$__poffb(\d+)$/)
      if (mb) bN = Math.max(bN, +mb[1] + 1)
      const mo = d[1].match(/^\$__poff(\d+)$/)
      if (mo) oN = Math.max(oN, +mo[1] + 1)
    }
  }
  const freshI64 = () => { const n = `$__poffb${bN++}`; newDecls.push(['local', n, 'i64']); return n }
  const freshI32 = () => { const n = `$__poff${oN++}`; newDecls.push(['local', n, 'i32']); return n }
  const cheapPtr = (n) => Array.isArray(n) &&
    (n[0] === 'local.get' || n[0] === 'global.get' ||
      (n[0] === 'i64.reinterpret_f64' && Array.isArray(n[1]) &&
        (n[1][0] === 'local.get' || n[1][0] === 'global.get')))
  const walk = (node) => {
    if (!Array.isArray(node)) return node
    for (let i = 0; i < node.length; i++) { const c = node[i]; if (Array.isArray(c)) node[i] = walk(c) }
    if (node[0] === 'call' && node[1] === '$__ptr_offset' && node.length === 3) {
      const X = node[2]
      let bitsA = X, bitsB = X
      if (!cheapPtr(X)) {
        const t = freshI64()
        bitsA = ['local.tee', t, X]
        bitsB = ['local.get', t]
      }
      const off = freshI32()
      const offGet = ['local.get', off]
      return ['block', ['result', 'i32'],
        ['local.set', off, ['i32.wrap_i64', ['i64.and', bitsA, ['i64.const', LAYOUT.OFFSET_MASK]]]],
        ['if', ['result', 'i32'],
          ['i32.and',
            ['i32.shl', ['i32.const', 1],
              ['i32.and', ['i32.wrap_i64', ['i64.shr_u', bitsB, ['i64.const', LAYOUT.TAG_SHIFT]]], ['i32.const', LAYOUT.TAG_MASK]]],
            ['i32.const', FORWARDING_MASK]],
          ['then',
            ['if', ['result', 'i32'],
              ['i32.and',
                ['i32.ge_u', offGet, ['i32.const', 8]],
                ['i64.le_u', ['i64.extend_i32_u', offGet], ['global.get', '$__heap_end64']]],
              ['then',
                ['if', ['result', 'i32'],
                  ['i32.eq', ['i32.load', ['i32.sub', offGet, ['i32.const', 4]]], ['i32.const', -1]],
                  ['then', ['call', '$__ptr_offset_fwd', offGet]],
                  ['else', offGet]]],
              ['else', offGet]]],
          ['else', offGet]]]
    }
    return node
  }
  for (let i = bodyStart; i < fn.length; i++) fn[i] = walk(fn[i])
  if (newDecls.length) fn.splice(bodyStart, 0, ...newDecls)
}

// i32 comparison/eqz negations — used to flip a break-condition into the
// loop-continue condition. f64 compares are deliberately ABSENT: ¬(a<b) ≠ (a≥b)
// across NaN, so those fall through to the `i32.eqz` wrap below.
const ROT_NEG = {
  'i32.eqz': null, // sentinel: strip the eqz (handled specially)
  'i32.eq': 'i32.ne', 'i32.ne': 'i32.eq',
  'i32.lt_s': 'i32.ge_s', 'i32.ge_s': 'i32.lt_s', 'i32.gt_s': 'i32.le_s', 'i32.le_s': 'i32.gt_s',
  'i32.lt_u': 'i32.ge_u', 'i32.ge_u': 'i32.lt_u', 'i32.gt_u': 'i32.le_u', 'i32.le_u': 'i32.gt_u',
}

// Boolean-context canonicalization. At a true zero/nonzero position — a `br_if`,
// `if`, `i32.eqz`, or `select` CONDITION — these are all equivalent to the inner
// value: `i32.ne(X, 0) → X`, `i32.ne(0, X) → X`, `i32.eqz(i32.eqz(X)) → X`. jz
// emits the redundant compare from `while (x !== 0)` lowering and from rotateLoops'
// `negate` (which strips one `eqz` but leaves the `i32.ne`). V8 happens to fold it,
// but JSC/wasmtime needn't — so strip it for MINIMAL output regardless of engine.
// Only applied at proven boolean positions (never on a value-position `ne`/`eqz`,
// which produce a real 0/1).
const boolSimp = (n) => {
  for (;;) {
    if (!Array.isArray(n)) return n
    if (n[0] === 'i32.ne' && n.length === 3) {
      if (Array.isArray(n[2]) && n[2][0] === 'i32.const' && (n[2][1] === 0 || n[2][1] === '0')) { n = n[1]; continue }
      if (Array.isArray(n[1]) && n[1][0] === 'i32.const' && (n[1][1] === 0 || n[1][1] === '0')) { n = n[2]; continue }
    }
    if (n[0] === 'i32.eqz' && Array.isArray(n[1]) && n[1][0] === 'i32.eqz' && n[1].length === 2) { n = n[1][1]; continue }
    return n
  }
}
export function simplifyBoolContexts(fn) {
  const nodes = []
  const bodyStart = findBodyStart(fn)
  for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: node => { if (Array.isArray(node)) nodes.push(node) } })
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i], op = node[0]
    if (op === 'br_if' && node.length === 3) node[2] = boolSimp(node[2])
    else if (op === 'i32.eqz' && node.length === 2) node[1] = boolSimp(node[1])
    else if (op === 'if') { const ci = (Array.isArray(node[1]) && node[1][0] === 'result') ? 2 : 1; if (Array.isArray(node[ci])) node[ci] = boolSimp(node[ci]) }
    else if (op === 'select' && node.length === 4 && Array.isArray(node[3])) node[3] = boolSimp(node[3])
  }
}

/**
 * Loop rotation (loop inversion). Convert jz's top-test loop idiom
 *   (block $brk (loop $loop (br_if $brk ¬C) BODY… (br $loop)))
 * into a guarded bottom-test loop with a FUSED conditional back-edge:
 *   (block $brk (br_if $brk ¬C) (loop $loop BODY… (br_if $loop C)))
 *
 * V8/TurboFan lowers the fused `br_if $loop C` to one hardware loop branch — the
 * shape LLVM gives rust/zig, and the reason their hot scalar loops (lz's greedy
 * match-scan, qoi's run-length scan) beat jz's top-test form, which compiles to a
 * forward exit-branch PLUS a separate unconditional back-jump. Measured 1.35× on
 * the lz inner loop; nothing else jz runs reaches this shape — watr's `loopify`
 * collapses to `loop { if C { …; br } }`, whose back-jump stays UNfused (no win).
 *
 * Evaluation count of C is unchanged: guard-once + one back-edge per iteration ==
 * the top-test form's once-per-loop-top — so it's sound even when C has side
 * effects (a `local.tee` recurrence, a call). The condition is duplicated only in
 * the EMITTED text (guard + back-edge), a small size-for-speed trade — speed-tier.
 *
 * Conservative skips:
 *   - any v128/SIMD op in the loop — already register-tight; reshaping risks
 *     disturbing the lane structure (mirrors hoistInvariantLoop's hasV128 guard).
 *   - a body that branches to $loop: a `continue` with no step lands on the loop
 *     label, which after rotation sits BEFORE the back-edge test — rotating would
 *     skip it. (jz wraps continue-with-step in a `$cont` block → targets that, not
 *     $loop → still rotatable.)
 */
export function rotateLoops(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Break-condition C → loop-continue condition ¬C for the back-edge. Fold the
  // i32 forms so the back-edge stays ONE fused compare-and-branch (a wrapping
  // `i32.eqz` would add an op inside the hot loop); everything else wraps.
  const negate = (c) => {
    if (Array.isArray(c) && c[0] === 'i32.eqz' && c.length === 2) return c[1]
    if (Array.isArray(c) && c.length === 3 && ROT_NEG[c[0]]) return [ROT_NEG[c[0]], c[1], c[2]]
    return ['i32.eqz', c]
  }
  const targetsLabel = (n, label) => {
    let found = false
    walkAst(n, { enter: x => {
      if (found) return false
      const op = x[0]
      if (op === 'br' || op === 'br_if') { if (x[1] === label) { found = true; return false } }
      else if (op === 'br_table') { for (let i = 1; i < x.length; i++) if (x[i] === label) { found = true; return false } }
    } })
    return found
  }

  const tryRotate = (blk) => {
    let bi = 1, blockLabel = null
    if (typeof blk[1] === 'string' && blk[1][0] === '$') { blockLabel = blk[1]; bi = 2 }
    if (!blockLabel) return null
    // The loop must be the block's final child; LICM may hoist invariant snaps into
    // a `local.set` pre-header before it — keep those ahead of the guard (the guard
    // condition can read them). Bail on anything else (typed blocks, side computations).
    const preamble = []
    let loop = null
    for (let i = bi; i < blk.length; i++) {
      const c = blk[i]
      if (Array.isArray(c) && c[0] === 'loop') { if (loop || i !== blk.length - 1) return null; loop = c }
      else if (Array.isArray(c) && c[0] === 'local.set' && !loop) preamble.push(c)
      else return null
    }
    if (!loop) return null
    let li = 1, loopLabel = null
    if (typeof loop[1] === 'string' && loop[1][0] === '$') { loopLabel = loop[1]; li = 2 }
    if (!loopLabel) return null
    const loopHeader = []
    while (li < loop.length) {
      const c = loop[li]
      if (Array.isArray(c) && c[0] === 'type') { loopHeader.push(c); li++; continue }
      if (Array.isArray(c) && (c[0] === 'param' || c[0] === 'result')) return null
      break
    }
    const body = loop.slice(li)
    if (body.length < 2) return null
    const head = body[0], tail = body[body.length - 1]
    if (!(Array.isArray(head) && head[0] === 'br_if' && head[1] === blockLabel && head.length === 3)) return null
    if (!(Array.isArray(tail) && tail[0] === 'br' && tail[1] === loopLabel && tail.length === 2)) return null
    const inner = body.slice(1, -1)
    if (inner.some((s) => targetsLabel(s, loopLabel))) return null   // continue → loop top: unsafe
    if (containsV128(head) || inner.some(containsV128)) return null  // vectorized: leave tight
    const cond = head[2]
    return ['block', blockLabel, ...preamble,
      ['br_if', blockLabel, cloneIR(cond)],
      ['loop', loopLabel, ...loopHeader, ...inner, ['br_if', loopLabel, negate(cond)]]]
  }

  // Rotate a (block …) at container[i] in place, else descend. Returns true if it fired.
  const tryAt = (container, i) => {
    const c = container[i]
    if (!Array.isArray(c) || c[0] !== 'block') return false
    const rot = tryRotate(c)
    if (!rot) return false
    container[i] = rot
    walk(rot)
    return true
  }
  const walk = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 0; i < node.length; i++) if (!tryAt(node, i)) walk(node[i])
  }
  // Top-level statements (a loop block can BE fn[i], not just nested under one).
  for (let i = bodyStart; i < fn.length; i++) if (!tryAt(fn, i)) walk(fn[i])
}

// The i32 form of an integer-valued f64 expression, or null. Used to push ToInt32
// through a conditional and to collapse the f64 round-trip on integer `+`/`-`.
// Lossless by construction: `convert_i32(X) → X`; integer `f64.const → i32.const`
// (ToInt32); `f64.add/sub` of i32-valued operands → `i32.add/sub` (mod-2³² is a ring
// homomorphism, and each i32±i32 < 2³² < 2⁵³ so the f64 op is exact). EXCLUDES `mul`
// (products can exceed 2⁵³, so the f64 op loses precision and i32.mul wouldn't match)
// and anything non-integer or unprovable. Address `local.tee`s inside operands are
// preserved (kept as-is in the returned i32 tree).
function toI32(n) {
  if (!Array.isArray(n)) return null
  const op = n[0]
  if ((op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u') && n.length === 2) return n[1]
  // i32-range consts only: keeps every leaf within i32 so f64 add/sub of leaves stays exact
  // (< 2^53) and ToInt32-homomorphic. A larger const would round in f64.add or saturate in
  // trunc_sat differently from JS `|0`, breaking the fold.
  if (op === 'f64.const' && typeof n[1] === 'number' && (n[1] | 0) === n[1]) return ['i32.const', n[1]]
  if ((op === 'f64.add' || op === 'f64.sub') && n.length === 3) {
    const a = toI32(n[1]), b = toI32(n[2])
    if (a && b) return [op === 'f64.add' ? 'i32.add' : 'i32.sub', a, b]
  }
  // ToInt32 distributes through a conditional: ToInt32(if C A B) == if(result i32) C
  // ToInt32(A) ToInt32(B). Recursive — a nested integer `?:` like `((3<a)?(2&a):((7<a)?a:1))|0`
  // narrows whole to i32 (each arm folded by toI32, incl. nested ifs), so the lane vectorizer
  // lifts it as i32x4 bitselect instead of bailing on the f64 result. Only reached from
  // ToInt32 sinks (the select idiom / toI32 recursion), so the i32 result is always wanted.
  if (op === 'if' && Array.isArray(n[1]) && n[1][0] === 'result' && n[1][1] === 'f64'
      && Array.isArray(n[3]) && n[3][0] === 'then' && n[3].length === 2
      && Array.isArray(n[4]) && n[4][0] === 'else' && n[4].length === 2) {
    const t = toI32(n[3][1]), e = toI32(n[4][1])
    if (t && e) return ['if', ['result', 'i32'], n[2], ['then', t], ['else', e]]
  }
  return null
}

// Fused bottom-up walk applying three orthogonal pattern sets at each node:
//   inlinePtrType  — call $__ptr_type / __ptr_aux / __is_nullish / __is_null / __is_truthy
//                    (skipped inside $__ptr_*/__is_* helper bodies themselves)
//   peephole       — rebox/unbox round-trips: i64.reinterpret_f64 / f64.reinterpret_i64 /
//                    i32.wrap_i64 over (i64.extend_i32_u/_s X) or (i64.or HIGH_ONLY extend X)
//   foldMemarg     — (load/store (i32.add base (i32.const N)) …) → (load/store offset=N base …)
// They discriminate on node[0] and don't overlap, so one visit suffices for all three.
export function fusedRewrite(fn, counts) {
  if (!Array.isArray(fn) || fn[0] !== 'func') {
    if (Array.isArray(fn)) {
      for (let i = 0; i < fn.length; i++) {
        const c = fn[i]
        if (Array.isArray(c)) fn[i] = walkRewrite(c, true, counts, null, null)
      }
    }
    return
  }
  // Skip __ptr_*/is_* bodies for inline pattern (they ARE the helpers).
  const name = typeof fn[1] === 'string' ? fn[1] : null
  const skipInline = !!(name && (name.startsWith('$__ptr_') || name === '$__is_nullish' || name === '$__is_truthy' || name === '$__is_null'))
  const bodyStart = findBodyStart(fn)
  // i64 scratch allocator for the literal-eq inline: any-shaped operand is
  // tee'd once instead of duplicated. Decls splice in after the walk.
  const newDecls = []
  // pre+post phases both run this pass — continue numbering past any scratch
  // locals the earlier phase already declared, or the decls collide.
  let scratchN = 0
  for (let i = 2; i < fn.length; i++) {
    const d = fn[i]
    if (Array.isArray(d) && d[0] === 'local' && typeof d[1] === 'string') {
      const m = d[1].match(/^\$__eq[tf](\d+)$/)
      if (m) scratchN = Math.max(scratchN, +m[1] + 1)
    }
  }
  const freshI64 = () => { const n = `$__eqt${scratchN++}`; newDecls.push(['local', n, 'i64']); return n }
  const freshF64 = () => { const n = `$__eqf${scratchN++}`; newDecls.push(['local', n, 'f64']); return n }
  // Single-textual-def locals → their defining value node, so the trunc_sat range fold (below)
  // can see through the temps inlining introduces when proving an index/packed value fits i32.
  // Multi-def (incl. loop-carried self-referential) locals are excluded: their value is not the
  // one def's, so its range wouldn't bound them. PARAMS are excluded outright: a param carries an
  // IMPLICIT entry def the textual scan can't see, and it is the one local class whose pre-write
  // value is externally controlled — `f = (p) => { use(1 >>> Math.abs(p)); p = 0 }` resolved p→0,
  // claimed range [0,0], and the collapsed bare trunc_sat saturated an incoming -Infinity to a
  // 31-lane shift (ToUint32(∞) is 0; the fuzzer's seed-6465 miscompile). Non-param pre-def reads
  // can only be the zero/undef-NaN init, and trunc_sat maps BOTH exactly as ToInt32 does, so the
  // textual rule stays sound for every other local. Pure read of the IR — value-preserving
  // rewrites during this same walk keep the captured def's RANGE intact, so a lazily-built map
  // stays sound. Built on first query only.
  let defVal
  const get = (name) => {
    if (defVal === undefined) {
      defVal = new Map(); const defCnt = new Map()
      for (let i = 2; i < fn.length; i++) {
        const d = fn[i]
        if (Array.isArray(d) && d[0] === 'param' && typeof d[1] === 'string') defCnt.set(d[1], 2)
      }
      const recordDef = n => {
        if (Array.isArray(n) && (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') {
          defCnt.set(n[1], (defCnt.get(n[1]) || 0) + 1); defVal.set(n[1], n[2])
        }
      }
      for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: recordDef })
      for (const [k, c] of defCnt) if (c > 1) defVal.delete(k)
    }
    return defVal.get(name) || null
  }
  for (let i = bodyStart; i < fn.length; i++) {
    const c = fn[i]
    if (Array.isArray(c)) fn[i] = walkRewrite(c, !skipInline, counts, freshI64, freshF64, get)
  }
  if (newDecls.length) fn.splice(bodyStart, 0, ...newDecls)
}

function walkRewrite(node, doInline, counts, freshI64, freshF64, get) {
  if (!Array.isArray(node)) return node
  for (let i = 0; i < node.length; i++) {
    const c = node[i]
    if (Array.isArray(c)) node[i] = walkRewrite(c, doInline, counts, freshI64, freshF64, get)
  }
  const op = node[0]
  // Piggyback local-ref counting for sortLocalsByUse. `counts` may be undefined
  // when fusedRewrite is called outside optimizeFunc (whole-module pass).
  if (counts && (op === 'local.get' || op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string')
    counts.set(node[1], (counts.get(node[1]) || 0) + 1)

  // Generic-equality bit-eq fast path: $__eq's own first branch hoisted to the
  // site when both args duplicate cheaply (local.get / reinterpret of one).
  // Identical bits ⇒ equal-unless-canonical-NaN; static-literal dedup + SSO +
  // slice interning make the hit dominant in tree-walking code (tag compares),
  // so most sites skip the call. The else arm keeps the original call.
  if (doInline && op === 'call' && (node[1] === '$__eq' || node[1] === '$__str_eq')
      && node.length === 4 && !node._eqFast) {
    const cheap = (n) => Array.isArray(n) &&
      (n[0] === 'local.get' ||
        (n[0] === 'i64.reinterpret_f64' && Array.isArray(n[1]) && n[1][0] === 'local.get'))
    // i64.const whose bits decode to a CANONICAL interned string (STRING tag,
    // INTERN_BIT set, SSO/SLICE clear) — i.e. a static-literal operand.
    const internedLit = (n) => {
      // (i64.const 0x…) or its f64-carrier form (i64.reinterpret_f64 (f64.const nan:0x…))
      let tok = null
      if (Array.isArray(n) && n[0] === 'i64.const') tok = n[1]
      else if (Array.isArray(n) && n[0] === 'i64.reinterpret_f64' && Array.isArray(n[1])
        && n[1][0] === 'f64.const' && typeof n[1][1] === 'string' && n[1][1].startsWith('nan:'))
        tok = n[1][1].slice(4)
      if (tok == null) return false
      let v
      try { v = BigInt(tok) } catch { return false }
      if (v < 0n) v += 1n << 64n
      if (((v >> 47n) & 0xFn) !== 4n) return false
      return ((v >> 32n) & 0x6001n) === BigInt(STR_INTERN_BIT)
    }
    // Literal-vs-X inline: bit-eq → 1; X carrying the canonical aux pattern →
    // 0 (only a canonical string can content-equal a canonical literal, and
    // canonicals are deduped; every NON-string kind is ≠ a string under ===
    // as well, so answering 0 on the pattern is sound for ANY value). Slices,
    // SSO, fresh heap strings and NaN fall through to the call. This is what
    // makes `op === 'literal'` dispatch ladders cost ~3 ops per rung instead
    // of a helper call — the V8 interned-pointer-compare equivalent.
    const a = node[2], b = node[3]
    const lit = internedLit(b) ? b : internedLit(a) ? a : null
    const x = lit === b ? a : b
    if (lit && (cheap(x) || freshI64)) {
      node._eqFast = true
      // Cheap operands duplicate; anything else evaluates ONCE into an i64
      // scratch (tee in the first use), so the inline applies to un-hoisted
      // shapes like `node[0] === 'lit'` too.
      let first = x, reuse = x
      if (!cheap(x)) {
        const t = freshI64()
        first = ['local.tee', t, x]
        reuse = ['local.get', t]
        node[2] = lit === b ? reuse : lit
        node[3] = lit === b ? lit : reuse
      }
      const auxPat = ['i32.eq',
        ['i32.and', ['i32.wrap_i64', ['i64.shr_u', reuse, ['i64.const', 32]]], ['i32.const', 0x6001]],
        ['i32.const', STR_INTERN_BIT]]
      return ['if', ['result', 'i32'],
        ['i64.eq', first, lit],
        ['then', ['i32.const', 1]],
        ['else', ['if', ['result', 'i32'], auxPat,
          ['then', ['i32.const', 0]],
          ['else', node]]]]
    }
    if (node[1] === '$__eq' && cheap(a) && cheap(b)) {
      node._eqFast = true   // pre+post phases both run this walk — wrap once
      return ['if', ['result', 'i32'],
        ['i64.eq', a, b],
        ['then', ['i64.ne', a, ['i64.const', NAN_BITS]]],
        ['else', node]]
    }
  }

  // Inline-ptr-helpers: $__ptr_type / $__ptr_aux / $__is_nullish / $__is_null / $__is_truthy
  if (doInline && op === 'call' && node.length === 3 && typeof node[1] === 'string') {
    const fname = node[1]
    if (fname === '$__ptr_type') return ['i32.and',
      ['i32.wrap_i64', ['i64.shr_u', node[2], ['i64.const', LAYOUT.TAG_SHIFT]]],
      ['i32.const', LAYOUT.TAG_MASK]]
    if (fname === '$__ptr_aux') return ['i32.and',
      ['i32.wrap_i64', ['i64.shr_u', node[2], ['i64.const', LAYOUT.AUX_SHIFT]]],
      ['i32.const', LAYOUT.AUX_MASK]]
    if (fname === '$__is_null') return ['i64.eq', node[2], ['i64.const', NULL_BITS]]
    if (fname === '$__is_nullish' && Array.isArray(node[2]) && node[2][0] === 'i64.reinterpret_f64'
        && Array.isArray(node[2][1]) && node[2][1][0] === 'local.get') return ['i32.or',
      ['i64.eq', node[2], ['i64.const', NULL_BITS]],
      ['i64.eq', node[2], ['i64.const', UNDEF_BITS]]]
    // Expression-arg __is_truthy: evaluate once into an f64 scratch via tee —
    // the local.tee form below then expands inline (covers `(c = next()) || …`
    // and every condition the emitter didn't pre-hoist).
    if (fname === '$__is_truthy' && freshF64 && Array.isArray(node[2]) && node[2][0] === 'i64.reinterpret_f64'
        && Array.isArray(node[2][1])
        && node[2][1][0] !== 'local.get' && node[2][1][0] !== 'local.tee') {
      node[2] = ['i64.reinterpret_f64', ['local.tee', freshF64(), node[2][1]]]
    }
    if (fname === '$__is_truthy' && Array.isArray(node[2]) && node[2][0] === 'i64.reinterpret_f64'
        && Array.isArray(node[2][1]) && (node[2][1][0] === 'local.get' || node[2][1][0] === 'local.tee')) {
      // `local.tee $x SRC` evaluates SRC once, stores to $x, returns the value —
      // hot for `a || b` lowering (`__is_truthy(local.tee $t …)`). Keep the tee
      // as the first use (the `if` condition runs before then/else, and f64.eq's
      // left operand runs first), so $x is set before every `local.get` repeat.
      const ref = node[2][1]
      const lname = ref[1]
      const lget = ['local.get', lname]
      const first = ref[0] === 'local.tee' ? ref : lget
      const bits = ['i64.reinterpret_f64', lget]
      // Mirror $__is_truthy (module/core.js) exactly: FIVE falsy patterns —
      // canonical NaN, null, undefined, the empty SSO string, AND boolean
      // false. Omitting FALSE made inlined `x || y` treat false as truthy.
      return ['if', ['result', 'i32'],
        ['f64.eq', first, lget],
        ['then', ['f64.ne', lget, ['f64.const', 0]]],
        ['else', ['i32.and',
          ['i32.and',
            ['i32.and',
              ['i64.ne', bits, ['i64.const', NAN_BITS]],
              ['i64.ne', bits, ['i64.const', NULL_BITS]]],
            ['i32.and',
              ['i64.ne', bits, ['i64.const', UNDEF_BITS]],
              ['i64.ne', bits, ['i64.const', '0x7FFA400000000000']]]],
          ['i64.ne', bits, ['i64.const', FALSE_BITS]]]]]
    }
  }

  // Peephole: rebox/unbox round-trips
  if ((op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u') && node.length === 2) {
    const a = node[1]
    if (Array.isArray(a) && a[0] === 'i32.const') {
      const n = typeof a[1] === 'number' ? a[1] : typeof a[1] === 'string' ? Number(a[1]) : NaN
      if (Number.isFinite(n)) return ['f64.const', op === 'f64.convert_i32_u' ? n >>> 0 : n]
    }
  }
  if (op === 'f64.mul' && node.length === 3) {
    const a = node[1], b = node[2]
    const isTwo = x => Array.isArray(x) && x[0] === 'f64.const' && x[1] === 2
    const isCheapF64 = x => Array.isArray(x) &&
      ((x[0] === 'local.get' && typeof x[1] === 'string') ||
       (x[0] === 'f64.const' && typeof x[1] === 'number'))
    if (isTwo(a) && isCheapF64(b)) return ['f64.add', b, b]
    if (isTwo(b) && isCheapF64(a)) return ['f64.add', a, a]
  }
  if (op === 'i32.trunc_sat_f64_s' && node.length === 2) {
    const a = node[1]
    if (Array.isArray(a) && a[0] === 'f64.convert_i32_s' && a.length === 2) return a[1]
  }
  if (op === 'i64.trunc_sat_f64_s' && node.length === 2) {
    const a = node[1]
    if (Array.isArray(a) && a[0] === 'f64.convert_i32_s' && a.length === 2) return ['i64.extend_i32_s', a[1]]
    if (Array.isArray(a) && a[0] === 'f64.convert_i32_u' && a.length === 2) return ['i64.extend_i32_u', a[1]]
  }
  // Rep-specific folds (NaN-box layout-aware reinterpret/wrap simplifications under
  // the nanbox preset). See abi/number/<rep>.js — each rep owns the rules that
  // depend on its own carrier layout. The universal `i32.wrap_i64 (i64.extend_i32_*)`
  // fold below stays here because it's pure WASM bit-pattern, ABI-agnostic.
  if (op === 'i64.reinterpret_f64' || op === 'f64.reinterpret_i64' || op === 'i32.wrap_i64') {
    const repFold = ctx.abi?.number?.peephole(node)
    if (repFold != null) return repFold
  }
  if (op === 'i32.wrap_i64' && node.length === 2) {
    const a = node[1]
    if (Array.isArray(a) && (a[0] === 'i64.extend_i32_u' || a[0] === 'i64.extend_i32_s') && a.length === 2)
      return a[1]
  }

  // Push ToInt32 through integer expressions and conditionals. The universal value model
  // computes integer `+`/`-` and `?:` in f64, then ToInt32-clamps — emitting
  //   (select (i32.wrap_i64 (i64.trunc_sat_f64_s [local.tee T] X)) FALLBACK COND)
  // whose three arms all compute ToInt32(X). When X is an integer-valued f64 expression,
  // ToInt32(X) == its i32 form (exact); and ToInt32 distributes through a conditional:
  //   ToInt32(if C A B) == if(result i32) C ToInt32(A) ToInt32(B).
  // Folding here drops the f64 round-trip AND turns int `s += a[i]` reductions and
  // `a[i] = cond ? … : …` conditional maps into pure i32 the vectorizer lifts (i32x4.add /
  // i32x4 bitselect). FALLBACK/COND (which recompute the same ToInt32 from T) are dropped.
  if (op === 'select' && node.length >= 4) {
    const v = node[1]
    if (Array.isArray(v) && v[0] === 'i32.wrap_i64' && Array.isArray(v[1]) && v[1][0] === 'i64.trunc_sat_f64_s' && v[1].length === 2) {
      let inner = v[1][1]
      if (Array.isArray(inner) && inner[0] === 'local.tee' && inner.length === 3) inner = inner[2]
      // ToInt32(integer-valued f64 expr) → its i32 form: covers (i32±i32)|0 sums AND the
      // conditional `?:` (toI32 distributes through `(if result f64)`, recursively).
      const i = toI32(inner)
      if (i) return i
      // Range fallback for the NON-integer-ring values toI32 rejects (`floor(scale·v)`,
      // `base + scale·v` — every grid/lattice/colour index): when the def chain — resolved
      // through single-def inlining temps via `get` — provably yields a finite i32-range value,
      // the +∞ guard is dead AND trunc_sat can't saturate, so the whole guarded select collapses
      // to one `i32.trunc_sat_f64_s`. SOUND: f64Range admits only pure nodes and proves
      // finiteness (kills the guard) + in-range (kills saturation), so the result is identical
      // ToInt32 on every value the program can produce. Drops the i64 round-trip + guard on all
      // runtimes (this is the post-inline twin of the emit-time fold at ir.js toI32).
      const rng = f64Range(inner, get)
      if (rng && rng.lo >= I32_MIN && rng.hi <= I32_MAX) return ['i32.trunc_sat_f64_s', inner]
    }
  }
  // (i32.or X 0) / (i32.or 0 X) → X — drops the redundant source-level `|0` clamp left
  // after the fold above, so the accumulator update is a bare i32.add the recognizer matches.
  if (op === 'i32.or' && node.length === 3) {
    const a = node[1], b = node[2]
    if (Array.isArray(b) && b[0] === 'i32.const' && b[1] === 0) return a
    if (Array.isArray(a) && a[0] === 'i32.const' && a[1] === 0) return b
  }

  // if→select for a value-producing f64 `if` with PURE arms: (if (result f64) COND (then A)
  // (else B)) → (select A B COND). This is the branchless `cmov` lowering LLVM/clang apply to
  // every `cond ? a : b` — it removes the conditional branch (and its misprediction cost on
  // data-unpredictable conditions) on the whole class of float sign/clamp/reflect ternaries.
  // The flagship: noise's gradient `(h & 1) === 0 ? x : -x` (8 per perlin × 5 octaves × 65k px).
  // SOUND: wasm `select` evaluates BOTH arms unconditionally, and `isPureIR` admits only
  // side-effect-free, non-trapping ops (no load/call, no trapping i32.div_s/rem_s) — so eager
  // evaluation never changes OBSERVABLE behavior; it is the exact predicate emit.js uses for the
  // same fold at emit time, now applied post-watr where the arms (e.g. `f64.neg (local.get $x)`)
  // are clean after canon-DCE. Gated to NOT fire when BOTH arms are i32-narrowable — those stay
  // an `if` for the ToInt32-through-if fold + the i32x4-bitselect conditional-map vectorizer
  // (don't steal the integer path). COST VETO: isPureIR admits f64.div/f64.sqrt too (non-trapping
  // but NOT cheap — 10-40+ cycle latency, often non-pipelined) — eagerly computing a div/sqrt arm
  // a predictable branch would have skipped can cost more than it saves (the synth ADSR's 4-way
  // ternary with three f64.div arms measured ~8% slower selected than branched). hasExpensiveOp
  // vetoes both arms recursively so a cascaded ternary (each level itself a nested select/if from
  // this same fold) can't hide the div/sqrt a few levels down.
  if (op === 'if' && node.length === 5 && Array.isArray(node[1]) && node[1][0] === 'result' && node[1][1] === 'f64'
      && Array.isArray(node[3]) && node[3][0] === 'then' && node[3].length === 2
      && Array.isArray(node[4]) && node[4][0] === 'else' && node[4].length === 2) {
    const a = node[3][1], b = node[4][1], cond = node[2]
    // The COND must also be pure: `if` evaluates cond FIRST then one arm, but wasm `select`
    // evaluates its arms BEFORE the cond. A short-circuit lowering like `a || b` =
    // `(if (result f64) is_truthy(local.tee $t a) (then get $t)(else b))` hides a `tee` in the
    // cond that the then-arm reads — reordering it after the arms reads $t stale. Requiring
    // isPureIR(cond) excludes every tee/call/short-circuit cond while admitting the pure
    // comparison conds of real float ternaries (noise's `(h & 1) === 0`). This SAME
    // isPureIR(cond) requirement also subsumes the sort-lane FLAG-construction veto
    // (ir.js dataDependentFlag): a cond containing a nested value-`if` (the &&/||
    // short-circuit shape a load-bearing clause forces) is never isPureIR — 'if' isn't in
    // PURE_OPS — so this fold already can't fire on that shape; no separate check needed
    // here (verified: emit.js's sibling `?:` select sites, which build `cond` once and
    // reuse it across multiple i32/i64/f64 branches, DO need the explicit
    // dataDependentFlag/selectCondOK gate because they don't run isPureIR(cond) at all).
    if (isPureIR(a) && isPureIR(b) && isPureIR(cond) && !hasExpensiveOp(a) && !hasExpensiveOp(b) &&
        !(toI32(a) && toI32(b))) return ['select', a, b, cond]
  }

  // f64.CMP(convert_i32 A, convert_i32 B) → i32.CMP(A, B). Comparing two i32 values is
  // identical whether done in exact f64 or in i32 (the converts are lossless and
  // order-preserving), so an integer comparison over typed-array loads (reads are f64)
  // drops its f64 round-trip. eq/ne are sign-agnostic; ordered compares need matching
  // signedness; an integer comparand constant works for the signed case. Both operands
  // are kept, so any address `local.tee` inside them survives. Prerequisite for i32
  // conditional-lane vectorization (the mask becomes an i32x4 compare).
  if (op === 'f64.eq' || op === 'f64.ne' || op === 'f64.lt' || op === 'f64.gt' || op === 'f64.le' || op === 'f64.ge') {
    const base = op.slice(4)
    const cv = (x) => Array.isArray(x) && (x[0] === 'f64.convert_i32_s' || x[0] === 'f64.convert_i32_u') && x.length === 2 ? x : null
    const intK = (x) => Array.isArray(x) && x[0] === 'f64.const' && Number.isInteger(x[1]) && x[1] >= -2147483648 && x[1] <= 2147483647 ? x[1] : null
    const a = node[1], b = node[2], ca = cv(a), cb = cv(b)
    if (ca && cb) {
      const sa = ca[0] === 'f64.convert_i32_s', sb = cb[0] === 'f64.convert_i32_s'
      if (base === 'eq' || base === 'ne') return ['i32.' + base, ca[1], cb[1]]
      if (sa === sb) return ['i32.' + base + (sa ? '_s' : '_u'), ca[1], cb[1]]
    } else if (ca && ca[0] === 'f64.convert_i32_s') {
      const k = intK(b)
      if (k != null) return base === 'eq' || base === 'ne' ? ['i32.' + base, ca[1], ['i32.const', k]] : ['i32.' + base + '_s', ca[1], ['i32.const', k]]
    } else if (cb && cb[0] === 'f64.convert_i32_s') {
      const k = intK(a)
      if (k != null) return base === 'eq' || base === 'ne' ? ['i32.' + base, ['i32.const', k], cb[1]] : ['i32.' + base + '_s', ['i32.const', k], cb[1]]
    }
  }

  // shl-distribute-over-add: (i32.shl (i32.add x (i32.const K)) (i32.const S))
  // → (i32.add (i32.shl x S) (i32.const K<<S)). Overflow-safe — both forms wrap
  // mod 2^32 identically. Unlocks memarg offset= folding for biquad-style
  // `arr[c+K0..KN]` reads where idx is precomputed but K is a small literal.
  if (op === 'i32.shl' && node.length === 3) {
    const a = node[1], b = node[2]
    // shl-shl-merge: (i32.shl (i32.shl x K1) K2) → (i32.shl x (K1+K2))
    // when K1+K2 < 32. Biquad: `sb = s<<2` then `__ab1 = state + (sb<<3)` ⇒
    // `s<<5` directly.
    if (Array.isArray(a) && a[0] === 'i32.shl' && a.length === 3 &&
        Array.isArray(b) && b[0] === 'i32.const' && typeof b[1] === 'number' &&
        Array.isArray(a[2]) && a[2][0] === 'i32.const' && typeof a[2][1] === 'number') {
      const sum = a[2][1] + b[1]
      if (sum >= 0 && sum < 32) return ['i32.shl', a[1], ['i32.const', sum]]
    }
    if (Array.isArray(a) && a[0] === 'i32.add' && a.length === 3 &&
        Array.isArray(b) && b[0] === 'i32.const' && typeof b[1] === 'number' && b[1] >= 0 && b[1] < 32) {
      const ka = a[1], kb = a[2]
      let inner, k
      if (Array.isArray(kb) && kb[0] === 'i32.const' && typeof kb[1] === 'number') { inner = ka; k = kb[1] }
      else if (Array.isArray(ka) && ka[0] === 'i32.const' && typeof ka[1] === 'number') { inner = kb; k = ka[1] }
      if (inner != null) {
        const shifted = (k * (1 << b[1])) | 0
        return ['i32.add', ['i32.shl', inner, b], ['i32.const', shifted]]
      }
    }
  }

  // assoc-lift-const-add: (i32.add A (i32.add B (i32.const K))) → (i32.add (i32.add A B) (i32.const K))
  // and mirror for left side. Lifts constant to top level so foldMemargOffsets
  // recognizes the canonical (i32.add base const) shape.
  if (op === 'i32.add' && node.length === 3) {
    const a = node[1], b = node[2]
    if (Array.isArray(b) && b[0] === 'i32.add' && b.length === 3) {
      const bb1 = b[1], bb2 = b[2]
      if (Array.isArray(bb2) && bb2[0] === 'i32.const') return ['i32.add', ['i32.add', a, bb1], bb2]
      if (Array.isArray(bb1) && bb1[0] === 'i32.const') return ['i32.add', ['i32.add', a, bb2], bb1]
    }
    if (Array.isArray(a) && a[0] === 'i32.add' && a.length === 3) {
      const aa1 = a[1], aa2 = a[2]
      if (Array.isArray(aa2) && aa2[0] === 'i32.const') return ['i32.add', ['i32.add', aa1, b], aa2]
      if (Array.isArray(aa1) && aa1[0] === 'i32.const') return ['i32.add', ['i32.add', aa2, b], aa1]
    }
  }

  // foldMemargOffsets: (load/store (i32.add base const) ...) → (load/store offset=N base ...)
  if (typeof op === 'string' && MEMOP.test(op)) {
    const m1 = node[1]
    if (!(typeof m1 === 'string' && (m1.startsWith('offset=') || m1.startsWith('align=')))) {
      const addr = m1
      if (Array.isArray(addr) && addr[0] === 'i32.add' && addr.length === 3) {
        const a = addr[1], b = addr[2]
        let base, offset
        if (Array.isArray(b) && b[0] === 'i32.const' && typeof b[1] === 'number' && b[1] >= 0 && b[1] < 0x100000000) { base = a; offset = b[1] }
        else if (Array.isArray(a) && a[0] === 'i32.const' && typeof a[1] === 'number' && a[1] >= 0 && a[1] < 0x100000000) { base = b; offset = a[1] }
        if (base != null) {
          node[1] = `offset=${offset}`
          node.splice(2, 0, base)
        }
      }
    }
  }
  return node
}
