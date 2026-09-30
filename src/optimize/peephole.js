/**
 * Peephole / rewrite family: the fused bottom-up peephole+inline+memarg walk
 * (fusedRewrite/walkRewrite — the generic rewrite walker), the branchless
 * select conversions (boolConvertToSelect, if→select inside walkRewrite),
 * and the late ptr_offset inliner (inlinePtrOffsetFastPass) + its
 * v128-memarg twin (foldV128Memargs). Loop rotation runs on the tape;
 * condition canonicalization belongs to watr.
 *
 * @module optimize/peephole
 */
import { simplifyCast } from 'watr/optimize'
import { LAYOUT, FORWARDING_MASK, ctx } from '../ctx.js'
import { nanboxF64 } from '../abi/index.js'
import { findBodyStart, isPureIR, hasExpensiveOp, f64Range, cloneIR, valueTruthyIR } from '../ir.js'
import { foldIntCompare, narrowI32, int32Operand, guardedInt32Operand } from '../ir/numeric.js'
import { isLeaf, walkAst } from '../ast.js'
import { clearFlowRanges, tagFlowRanges } from './flow-range.js'
import { nanPrefixHex, atomNanHex, STR_INTERN_BIT } from '../../layout.js'
const TWO_63 = 2 ** 63

const MEMOP = /^[fi](32|64)\.(load|store)(\d+(_[su])?)?$/
const NAN_BITS = nanPrefixHex()
const NULL_BITS = atomNanHex(1)
const UNDEF_BITS = atomNanHex(2)

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
  // Pass 1 — a local whose EVERY definition is a comparison carries a value ∈ {0,1};
  // `err = old - on` (on reused by putBW) reaches us as `convert(local.get $on)`, and a
  // versioned loop defines the same `$on` once per copy. A param is EXCLUDED even if
  // reassigned by comparisons only: its incoming arg is unconstrained, so a read before
  // the reassignment isn't 0/1. (A plain local read before its def is safe — wasm
  // zero-inits it to 0 = false, which select preserves.)
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
  for (const name of defCount.keys()) if (defIsCmp.get(name) && !params.has(name)) boolLocals.add(name)

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
        if (base != null) { if (offset === 0) n[1] = base; else { n[1] = `offset=${offset}`; n.splice(2, 0, base) } }
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

// Fused bottom-up walk applying three orthogonal pattern sets at each node:
//   inlinePtrType  — call $__ptr_type / __ptr_aux / __is_nullish / __is_null
//                    (skipped inside $__ptr_*/__is_* helper bodies themselves)
//   peephole       — rebox/unbox round-trips: i64.reinterpret_f64 / f64.reinterpret_i64 /
//                    i32.wrap_i64 over (i64.extend_i32_u/_s X) or (i64.or HIGH_ONLY extend X)
//   foldMemarg     — (load/store (i32.add base (i32.const N)) …) → (load/store offset=N base …)
// They discriminate on node[0] and don't overlap, so one visit suffices for all three.
export function fusedRewrite(fn, bigint = false, inlineTruthy = true) {
  if (!Array.isArray(fn) || fn[0] !== 'func') {
    if (Array.isArray(fn)) {
      for (let i = 0; i < fn.length; i++) {
        const c = fn[i]
        if (Array.isArray(c)) fn[i] = walkRewrite(c, true, null, null, null, bigint, inlineTruthy)
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
  const params = new Set(), floatLocals = new Set()
  for (let i = 2; i < bodyStart; i++) {
    const d = fn[i]
    if (!Array.isArray(d)) continue
    if (d[0] === 'param' && typeof d[1] === 'string') params.add(d[1])
    if (d[0] === 'local' && d[2] === 'f64') floatLocals.add(d[1])
    if (Array.isArray(d) && d[0] === 'local' && typeof d[1] === 'string') {
      const m = d[1].match(/^\$__eq[tf](\d+)$/)
      if (m) scratchN = Math.max(scratchN, +m[1] + 1)
    }
  }
  const freshI64 = () => { const n = `$__eqt${scratchN++}`; newDecls.push(['local', n, 'i64']); return n }
  const freshF64 = () => { const n = `$__eqf${scratchN++}`; newDecls.push(['local', n, 'f64']); return n }
  // Single-textual-def locals → their defining value node, so the trunc_sat range fold (below)
  // can see through the temps inlining introduces when proving an index/packed value fits i32.
  // Multi-def locals need a separate all-writes bound; they cannot resolve to one
  // defining expression. PARAMS are excluded outright: a param carries an
  // IMPLICIT entry def the textual scan can't see, and it is the one local class whose pre-write
  // value is externally controlled — `f = (p) => { use(1 >>> Math.abs(p)); p = 0 }` resolved p→0,
  // claimed range [0,0], and the collapsed bare trunc_sat saturated an incoming -Infinity to a
  // 31-lane shift (ToUint32(∞) is 0; the fuzzer's seed-6465 miscompile). Non-param pre-def reads
  // can only be the zero/undef-NaN init, and trunc_sat maps BOTH exactly as ToInt32 does, so the
  // textual rule stays sound for every other local. Pure read of the IR — value-preserving
  // rewrites during this same walk keep the captured def's RANGE intact, so a lazily-built map
  // stays sound. Built on first query only.
  let defVal, defs, bounds, owners, numericLocals
  const get = (name, recurrence = false) => {
    // A parameter has an unknown entry definition regardless of later stores.
    if (params.has(name)) return null
    if (defVal === undefined) {
      defVal = new Map(); defs = new Map(); bounds = new Map(); owners = new Map()
      numericLocals = false
      // Keep only statement ancestry, alongside the existing write census.
      // Expression operands cannot supply a dominating statement initializer.
      const scan = (n, parent = null, index = -1, scope = null, loop = null) => {
        if (!Array.isArray(n)) return
        const op = n[0]
        if (op === 'func' || op === 'block' || op === 'loop' || op === 'then' || op === 'else')
          scope = { node: n, parent: scope, index: scope?.node === parent ? index : -1 }
        if (op === 'loop') loop = scope
        if ((op === 'local.get' || op === 'local.set' || op === 'local.tee') && typeof n[1] !== 'string') numericLocals = true
        if (op === 'local.set' || op === 'local.tee') {
          let ws = defs.get(n[1]); if (!ws) defs.set(n[1], ws = [])
          ws.push(n)
          if (floatLocals.has(n[1])) owners.set(n, owners.has(n) ? null : loop)
        }
        for (let i = 1; i < n.length; i++) scan(n[i], n, i, scope, loop)
      }
      scan(fn)
      for (const [k, ws] of defs) if (ws.length === 1 && !params.has(k)) defVal.set(k, ws[0][2])
    }
    if (defVal.has(name)) return defVal.get(name)
    if (!recurrence || numericLocals || !floatLocals.has(name)) return null
    // A write of another value bounds the local by its own range; one that
    // reads back through a local under enclosure is unknown while it is built.
    if (!bounds.has(name)) {
      bounds.set(name, null)
      bounds.set(name, boundedFloatLocal(name, defs.get(name), owners, params, v => f64Range(v, n => get(n, true), true)))
    }
    return bounds.get(name)
  }
  // A local's reads in the function as it stood before this walk.
  let readCount
  get.reads = name => {
    if (!readCount) {
      readCount = new Map()
      walkAst(fn, { enter: n => { if (n[0] === 'local.get') readCount.set(n[1], (readCount.get(n[1]) || 0) + 1) } })
    }
    return readCount.get(name) || 0
  }
  // Flow intervals for the range folds below, valid for this walk's tree only.
  tagFlowRanges(fn, bodyStart, floatLocals)
  for (let i = bodyStart; i < fn.length; i++) {
    const c = fn[i]
    if (Array.isArray(c)) fn[i] = walkRewrite(c, !skipInline, freshI64, freshF64, get, bigint, inlineTruthy)
  }
  clearFlowRanges(fn)
  mergeByteStores(fn, bodyStart, get.reads)
  if (newDecls.length) fn.splice(bodyStart, 0, ...newDecls)
}

/** The exact conversions no range proof folded (`call $__to_int32 X`, left by
 *  the walk above and read by the lane lift in that form) convert inline where
 *  the i64 truncation is exact, every finite |x| < 2^63 (NaN saturates to
 *  ToInt32's zero), and call the kernel only for the infinities and the values
 *  beyond, whose low word it recovers from the significand. A property a typed
 *  array may carry leaves such a value unbounded (`next[other]` with `other`
 *  possibly undefined). Runs after the lift. */
export function lowerToInt32Tails(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  const decls = []
  let n = 0
  for (let i = 2; i < bodyStart; i++) {
    const m = Array.isArray(fn[i]) && (fn[i][0] === 'local' || fn[i][0] === 'param') && typeof fn[i][1] === 'string' && fn[i][1].match(/^\$__ti(\d+)$/)
    if (m) n = Math.max(n, +m[1] + 1)
  }
  const lower = node => {
    if (!Array.isArray(node)) return node
    // The emitter already supplies this guard. Lower nested conversions in
    // its captured argument, leaving its cold fallback as one plain call.
    const held = guardedInt32Operand(node)
    if (held) {
      if (held[0] === 'local.tee') held[2] = lower(held[2])
      return node
    }
    for (let i = 1; i < node.length; i++) node[i] = lower(node[i])
    if (node[0] !== 'call' || node[1] !== '$__to_int32' || node.length !== 3) return node
    const x = node[2], leaf = Array.isArray(x) && x[0] === 'local.get'
    const t = leaf ? x[1] : `$__ti${n++}`
    if (!leaf) decls.push(['local', t, 'f64'])
    const first = leaf ? x : ['local.tee', t, x]
    return ['if', ['result', 'i32'], ['f64.ge', ['f64.abs', first], ['f64.const', TWO_63]],
      ['then', ['call', '$__to_int32', ['local.get', t]]],
      ['else', ['i32.wrap_i64', ['i64.trunc_sat_f64_s', ['local.get', t]]]]]
  }
  for (let i = bodyStart; i < fn.length; i++) fn[i] = lower(fn[i])
  if (decls.length) fn.splice(bodyStart, 0, ...decls)
}

// All writes must be constants, values with a range of their own (`range`, NaN
// admitted: a checked element read), or one constant increment per counted iteration.
// The count comes from the facts HIR proved for the loop (loopFacts, on its lowering
// link): a counter only its step moves stays within its hull, so the body runs at most
// ⌊(hi - lo) / step⌋ + 1 times per entry. Integer enclosures avoid assuming repeated floating addition equals N * step:
// rounding is monotone, and each integral bound + floor/ceil(step) is exact
// while its magnitude stays within 2^53. These are magnitude bounds, not an
// integer-value proof; the accumulator itself remains f64.
function boundedFloatLocal(name, writes, owners, params, range = null) {
  if (!writes) return null
  let lo = 0, hi = 0
  const changes = (n, key) => {
    let found = false
    walkAst(n, { enter: x => { if ((x[0] === 'local.set' || x[0] === 'local.tee') && x[1] === key) found = true } })
    return found
  }
  const initial = (key, info) => {
    if (params.has(key)) return null
    for (let f = info; f.parent; f = f.parent) {
      if (f.index < 0) return null
      const p = f.parent.node
      // Crossing another loop would mistake its first entry for every entry.
      if (!['func', 'block', 'loop', 'then', 'else'].includes(p[0])) return null
      for (let j = f.index - 1; j >= 1; j--) {
        const s = p[j]
        if (!Array.isArray(s)) continue
        if (s[0] === 'local.set' && s[1] === key && /^(i32|f64)\.const$/.test(s[2]?.[0])) {
          const v = s[2][1]
          return typeof v === 'number' && Number.isFinite(v) ? v : null
        }
        if (changes(s, key)) return null
      }
      if (p[0] === 'loop') return null
    }
    return 0 // a non-parameter Wasm local's implicit entry value
  }
  for (const w of writes) {
    const v = w[2]
    if (v[0] === 'f64.const' && typeof v[1] === 'number' && Number.isFinite(v[1])) {
      lo = Math.min(lo, v[1]); hi = Math.max(hi, v[1]); continue
    }
    const op = v[0], a = v[1], b = v[2]
    const self = x => x?.[0] === 'local.get' && x[1] === name
    const c = self(a) ? b : op === 'f64.add' && self(b) ? a : null
    if ((op !== 'f64.add' && op !== 'f64.sub') || c?.[0] !== 'f64.const' || typeof c[1] !== 'number' || !Number.isFinite(c[1])) {
      const r = range ? range(v) : null
      if (!r) return null
      lo = Math.min(lo, r.lo); hi = Math.max(hi, r.hi)
      continue
    }
    const delta = (op === 'f64.sub' ? -1 : 1) * c[1]
    const info = owners.get(w), loop = info?.node, block = info?.parent?.node
    const facts = block && ctx.plans.loweringLinks?.get(block)?.plan
    if (!facts?.hull) return null
    let valueWrites = 0
    walkAst(loop, { enter: n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === name) valueWrites++ } })
    if (valueWrites !== 1) return null
    const start = initial(name, info)
    if (start == null) return null
    const count = Math.floor((facts.hull.hi - facts.hull.lo) / facts.step) + 1
    const down = count * Math.min(0, Math.floor(delta)), up = count * Math.max(0, Math.ceil(delta))
    if (!Number.isSafeInteger(down) || !Number.isSafeInteger(up)) return null
    const low = Math.floor(start) + down
    const high = Math.ceil(start) + up
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) return null
    lo = Math.min(lo, low); hi = Math.max(hi, high)
  }
  return { lo, hi }
}


// The parts of a store: its offset memarg, address and value.
const storeParts = n => {
  let i = 1, offset = 0
  for (; i < n.length && typeof n[i] === 'string'; i++) {
    if (n[i].startsWith('offset=')) offset = +n[i].slice(7)
    else if (!n[i].startsWith('align=')) return null
  }
  return n.length - i === 2 ? { offset, addr: n[i], value: n[i + 1] } : null
}
const unmask = (n, mask) => Array.isArray(n) && n[0] === 'i32.and' && n.length === 3 &&
  Array.isArray(n[2]) && n[2][0] === 'i32.const' && n[2][1] === mask ? n[1] : n
// An address as a pure base expression (keyed by its shape) plus a constant:
// `out + ((op + 1) << 0)` is base `(<< $op 0)` under `$out`, offset 1.
const addrKey = n => {
  if (!Array.isArray(n)) return null
  const op = n[0]
  if (op === 'i32.const') return typeof n[1] === 'number' ? { key: null, offset: n[1], reads: [] } : null
  if (op === 'local.get') return typeof n[1] === 'string' ? { key: n[1], offset: 0, reads: [n[1]] } : null
  if (op === 'i32.add' && n.length === 3) {
    const a = addrKey(n[1]), b = addrKey(n[2])
    if (!a || !b) return null
    const key = a.key && b.key ? `(+ ${a.key} ${b.key})` : a.key || b.key
    return { key, offset: a.offset + b.offset, reads: [...a.reads, ...b.reads] }
  }
  if ((op === 'i32.shl' || op === 'i32.mul') && n.length === 3 && Array.isArray(n[2]) && n[2][0] === 'i32.const' && typeof n[2][1] === 'number') {
    const a = addrKey(n[1]), c = n[2][1]
    if (!a) return null
    const scale = op === 'i32.shl' ? 2 ** (c & 31) : c
    return { key: a.key && `(${op} ${a.key} ${c})`, offset: a.offset * scale, reads: a.reads }
  }
  return null
}
// A store statement, plain or as the emitter's `(block (local.set $t V) (store … (local.get $t)))`.
const storeStmt = stmt => {
  if (!Array.isArray(stmt)) return null
  if (stmt[0] === 'block' && stmt.length === 3 && Array.isArray(stmt[1]) && stmt[1][0] === 'local.set' &&
      Array.isArray(stmt[2]) && typeof stmt[1][1] === 'string') {
    const parts = storeParts(stmt[2])
    if (!parts || !isLocalGetOf(parts.value, stmt[1][1])) return null
    return { node: stmt[2], parts: { ...parts, value: stmt[1][2] }, temp: stmt[1][1] }
  }
  const parts = storeParts(stmt)
  return parts ? { node: stmt, parts, temp: null } : null
}
const isLocalGetOf = (n, name) => Array.isArray(n) && n[0] === 'local.get' && n[1] === name
// A pure expression over locals and constants: evaluating it again between two
// stores reads nothing the first store could have written.
const PURE_RE = /^(?:local\.get|global\.get|select|(?:i32|i64|f32|f64)\.(?!load|store)[a-z0-9_]+)$/
const pureExpr = n => Array.isArray(n)
  ? PURE_RE.test(n[0]) && n.every((x, i) => i === 0 || typeof x === 'number' || typeof x === 'string' || pureExpr(x))
  : typeof n === 'number' || typeof n === 'string'
const localsOf = (n, out = []) => {
  if (!Array.isArray(n)) return out
  if (n[0] === 'local.get') out.push(n[1])
  else for (let i = 1; i < n.length; i++) localsOf(n[i], out)
  return out
}
// Byte `k` (of `width` bytes) of a word, as a store value: the word itself for
// k = 0, else the word shifted down by k bytes; a mask of the byte is idle.
// Returns the word expression, or null.
const wordByte = (value, width, k) => {
  const v = unmask(value, width === 1 ? 255 : 65535)
  if (k === 0) return pureExpr(v) ? v : null
  if (!Array.isArray(v) || (v[0] !== 'i32.shr_u' && v[0] !== 'i32.shr_s') || v.length !== 3) return null
  if (!Array.isArray(v[2]) || v[2][0] !== 'i32.const' || v[2][1] !== 8 * width * k) return null
  return pureExpr(v[1]) ? v[1] : null
}

/** (i32.store8 A W) (i32.store8 offset=1 A (i32.shr_u W 8)) → (i32.store16 A W):
 *  consecutive stores of one word's bytes at consecutive addresses are the word's
 *  little-endian store, which Wasm memory defines. Two byte stores make a store16,
 *  four (or two halfword stores) a store32. The addresses share one pure base
 *  expression and differ by the byte position; the values read one word local,
 *  which a temp the emitter sets beside each store may carry. The first store
 *  keeps its address and value expressions, so their tees stay, and the later
 *  stores go, each with the temp only it read (`reads` counts a local's reads
 *  in the function). */
function mergeByteStores(list, start, reads) {
  for (let i = start; i < list.length; i++) {
    const first = storeStmt(list[i])
    if (!first || (first.node[0] !== 'i32.store8' && first.node[0] !== 'i32.store16')) continue
    const width = first.node[0] === 'i32.store8' ? 1 : 2, kind = first.node[0]
    const head = addrKey(first.parts.addr), word = wordByte(first.parts.value, width, 0)
    if (!head || !head.key || !word) continue
    const mask = width === 1 ? 255 : 65535, key = JSON.stringify(word)
    // The locals the later stores re-evaluate: no temp of theirs may write one.
    const fixed = new Set([...head.reads, ...localsOf(word)])
    let run = 1
    while (run < 4 / width && i + run < list.length) {
      const next = storeStmt(list[i + run])
      if (!next || next.node[0] !== kind || (next.temp && fixed.has(next.temp))) break
      const a = addrKey(next.parts.addr)
      if (!a || a.key !== head.key || a.offset + next.parts.offset !== head.offset + first.parts.offset + run * width) break
      const w = wordByte(next.parts.value, width, run)
      if (!w || JSON.stringify(w) !== key) break
      run++
    }
    const bytes = run * width
    if (bytes !== 2 && bytes !== 4) continue
    const merged = [bytes === 2 ? 'i32.store16' : 'i32.store']
    if (first.parts.offset) merged.push(`offset=${first.parts.offset}`)
    merged.push(first.parts.addr, unmask(first.parts.value, mask))
    // A temp read once was read by its store alone: its set goes with the store.
    const rest = []
    for (let k = 1; k < run; k++) { const s = list[i + k]; if (s[0] === 'block' && reads(s[1][1]) !== 1) rest.push(s[1]) }
    if (first.temp && reads(first.temp) === 1) list[i] = merged
    else if (first.temp) list[i][2] = merged
    else list[i] = merged
    list.splice(i + 1, run - 1, ...rest)
  }
}

function walkRewrite(node, doInline, freshI64, freshF64, get, bigint, inlineTruthy) {
  if (!Array.isArray(node)) return node
  for (let i = 0; i < node.length; i++) {
    const c = node[i]
    if (Array.isArray(c)) node[i] = walkRewrite(c, doInline, freshI64, freshF64, get, bigint, inlineTruthy)
  }
  const op = node[0]

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

  // Inline fixed tag tests and the shared runtime truthiness predicate.
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
    if (inlineTruthy && fname === '$__is_truthy' && Array.isArray(node[2]) && node[2][0] === 'i64.reinterpret_f64'
        && Array.isArray(node[2][1])) {
      let ref = node[2][1]
      if (ref[0] !== 'local.get' && ref[0] !== 'local.tee') {
        if (!freshF64) return node
        ref = ['local.tee', freshF64(), ref]
      }
      return valueTruthyIR(ref, bigint)
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
  // The early SIMD preparation and final optimizer share exact cast rules.
  const cast = simplifyCast(node)
  if (cast) return cast
  // Rep-specific folds (NaN-box layout-aware reinterpret/wrap simplifications under
  // the nanbox preset). Each rep owns the rules depending on its carrier layout.
  if (op === 'i64.reinterpret_f64' || op === 'f64.reinterpret_i64' || op === 'i32.wrap_i64') {
    const repFold = nanboxF64.peephole(node)
    if (repFold != null) return repFold
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
  if (op === 'select' && node.length === 4) {
    const v = node[1]
    if (Array.isArray(v) && v[0] === 'i32.wrap_i64' && Array.isArray(v[1]) && v[1][0] === 'i64.trunc_sat_f64_s' && v[1].length === 2) {
      let inner = v[1][1]
      const conversion = int32Operand(node)
      const cond = node[3], read = cond?.[1]?.[1]
      const present = node[2]?.[0] === 'i32.const' && node[2][1] === -1 &&
        cond?.[0] === 'i64.ne' && cond[1]?.[0] === 'i64.reinterpret_f64' &&
        read?.[0] === 'local.get' && (inner[0] === 'local.get' || inner[0] === 'local.tee') && read[1] === inner[1] &&
        cond[2]?.[0] === 'i64.const' && cond[2][1] === UNDEF_BITS
      if (!conversion && !present) return node
      if (Array.isArray(inner) && inner[0] === 'local.tee' && inner.length === 3) inner = inner[2]
      // ToInt32(integer-valued f64 expr) → its i32 form: covers (i32±i32)|0 sums AND the
      // conditional `?:` (toI32 distributes through `(if result f64)`, recursively).
      const i = conversion && narrowI32(inner, true)?.node
      if (i) return i
      // A finite value below 2^63 truncates exactly through i64 and its low
      // word is ToInt32 (mod 2^32); the guard serves only ±∞, NaN payloads
      // and |x| ≥ 2^63. The i64 form is the fast one too: V8's arm64
      // lowering of `i32.trunc_sat_f64_s` adds a float round-trip and range
      // checks (a 5e7-iteration micro: i64 wrap 294 ns, guarded 343, bare
      // i32 trunc_sat 446), so a proven range drops the guard and keeps i64.
      const rng = f64Range(inner, get, !!conversion)
      if (rng && rng.lo > -TWO_63 && rng.hi < TWO_63) return v
      // Loop invariants only remove the guard, preserving the captured value.
      const bound = conversion && get && f64Range(inner, name => get(name, true), true)
      if (bound && bound.lo > -TWO_63 && bound.hi < TWO_63) return v
    }
  }
  // The exact element-store conversion (toInt32's `call $__to_int32 X`) folds the
  // same two ways: an integer-valued X takes its i32 form; i32-range values
  // or NaN need one trunc_sat — both identical ToInt32 on every value.
  if (op === 'call' && node[1] === '$__to_int32' && node.length === 3) {
    const i = narrowI32(node[2], true)?.node
    if (i) return i
    const rng = f64Range(node[2], get, true) || (get && f64Range(node[2], name => get(name, true), true))
    if (rng && rng.lo > -TWO_63 && rng.hi < TWO_63) return ['i32.wrap_i64', ['i64.trunc_sat_f64_s', node[2]]]
  }
  // The same conversion behind its inline fast path (toInt32 at the speed tiers):
  //   (if (result i32) (f64.lt (f64.abs [local.tee T] X) 2^63) (then (wrap (trunc T))) (else (call $__to_int32 T)))
  // folds as the call does, over X: the guard serves only what the range rules out.
  const held = op === 'if' && guardedInt32Operand(node)
  if (held) {
    const x = Array.isArray(held) && held[0] === 'local.tee' && held.length === 3 ? held[2] : held
    const i = narrowI32(x, true)?.node
    if (i) return i
    const rng = f64Range(x, get, true)
    if (rng && rng.lo > -TWO_63 && rng.hi < TWO_63) return ['i32.wrap_i64', ['i64.trunc_sat_f64_s', x]]
  }
  // (i32.or X 0) / (i32.or 0 X) → X — drops the redundant source-level `|0` clamp left
  // after the fold above, so the accumulator update is a bare i32.add the recognizer matches.
  if (op === 'i32.or' && node.length === 3) {
    const a = node[1], b = node[2]
    if (Array.isArray(b) && b[0] === 'i32.const' && b[1] === 0) return a
    if (Array.isArray(a) && a[0] === 'i32.const' && a[1] === 0) return b
  }

  // and-redundant-after-shr_u: (i32.and (i32.shr_u X K) M) → (i32.shr_u X K) when M's low
  // (32-K) bits are all set. `X >>> K` is bounded to [0, 2^(32-K)-1] by the shift alone (it
  // zero-fills the top K bits), so a mask that already covers every bit the shift can ever
  // produce is a no-op — extra HIGH bits set in M beyond that range are harmless (the shift
  // never sets them either way). K and M are both compile-time constants, so this is a pure
  // identity, sound for every runtime X — not a proof-dependent fold. Flagship idiom: bit-field
  // extraction after a hash/PRNG mix, `(state >>> 23) & 511` (xorshift32-style channel/lane
  // split) — the mask is a leftover source-level safety habit, not a real constraint once the
  // shift amount is known. wasm-opt's optimize-instructions finds this generically; jz didn't
  // have an i32.and rule at all before this one.
  if (op === 'i32.and' && node.length === 3) {
    const isConstShrU = (n) => Array.isArray(n) && n[0] === 'i32.shr_u' && n.length === 3 &&
      Array.isArray(n[2]) && n[2][0] === 'i32.const' && typeof n[2][1] === 'number'
    const a = node[1], b = node[2]
    const shr = isConstShrU(a) ? a : isConstShrU(b) ? b : null
    const mask = shr === a ? b : a
    if (shr && Array.isArray(mask) && mask[0] === 'i32.const' && typeof mask[1] === 'number') {
      const k = ((shr[2][1] % 32) + 32) % 32
      const bits = 32 - k
      const lowMask = bits >= 32 ? 0xFFFFFFFF : (1 << bits) - 1
      if (((mask[1] & lowMask) >>> 0) === (lowMask >>> 0)) return shr
    }
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
        !(narrowI32(a, true) && narrowI32(b, true))) return ['select', a, b, cond]
  }

  // Share the emitter's signedness proof; a later fold must not turn a
  // mixed signed/unsigned equality back into an equality of the raw bits.
  if (op === 'f64.eq' || op === 'f64.ne' || op === 'f64.lt' || op === 'f64.gt' || op === 'f64.le' || op === 'f64.ge') {
    const cmp = foldIntCompare(op.slice(4), node[1], node[2])
    if (cmp) return cmp
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
        // offset 0 is the address itself: no memarg to carry, none for a recognizer to read past
        if (base != null) {
          if (offset === 0) node[1] = base
          else { node[1] = `offset=${offset}`; node.splice(2, 0, base) }
        }
      }
    }
  }
  if (get && (op === 'block' || op === 'loop' || op === 'then' || op === 'else')) {
    let start = 1
    while (start < node.length && (typeof node[start] === 'string' || (Array.isArray(node[start]) && node[start][0] === 'result'))) start++
    mergeByteStores(node, start, get.reads)
  }
  return node
}
