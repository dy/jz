import { nodeEqual as exprEq, walkAst } from '../../ast.js'
import { LOAD_OPS, STORE_OPS } from './lane-tables.js'
import { isArr } from './node-utils.js'

export function isLocalGet(node, name) {
  return isArr(node) && node[0] === 'local.get' && (name == null || node[1] === name)
}
export function isI32Const(node) {
  return isArr(node) && node[0] === 'i32.const'
}
export function constNum(node) {
  if (!isI32Const(node)) return null
  const v = node[1]
  return typeof v === 'number' ? v : (typeof v === 'string' ? parseInt(v, 10) : null)
}

/**
 * Match increment shape `(local.set $X (i32.add (local.get $X) (i32.const 1)))`.
 * Returns $X or null.
 */
export function matchInc1(stmt) {
  if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
  const x = stmt[1]
  const v = stmt[2]
  if (!isArr(v) || v[0] !== 'i32.add' || v.length !== 3) return null
  if (!isLocalGet(v[1], x)) return null
  if (constNum(v[2]) !== 1) return null
  return x
}

/**
 * Match increment shape `(local.set $X (i32.add (local.get $X) (i32.const C)))`
 * for any constant C. Returns { name, c } or null. Generalizes matchInc1 to the
 * strided-pointer bumps (`p += stride`) the ramp-map recognizer must scale.
 */
export function matchIncN(stmt) {
  if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
  const x = stmt[1], v = stmt[2]
  if (!isArr(v) || v[0] !== 'i32.add' || v.length !== 3) return null
  if (!isLocalGet(v[1], x)) return null
  const c = constNum(v[2])
  return c == null ? null : { name: x, c }
}

/**
 * Match `(br_if $LABEL (i32.eqz (i32.lt_{s,u} (local.get $I) BOUND)))`.
 * Returns { ind, bound } or null.
 */
export function matchExitBrIf(stmt, label) {
  if (!isArr(stmt) || stmt[0] !== 'br_if' || stmt[1] !== label) return null
  const cond = stmt[2]
  if (!isArr(cond) || cond[0] !== 'i32.eqz') return null
  const cmp = cond[1]
  if (!isArr(cmp) || (cmp[0] !== 'i32.lt_s' && cmp[0] !== 'i32.lt_u')) return null
  if (!isLocalGet(cmp[1])) return null
  return { ind: cmp[1][1], bound: cmp[2] }
}

/**
 * Walk node, collect set of local names that are written via local.set/local.tee
 * anywhere within. Used to detect loop-invariant locals.
 */
export function collectWrites(node, out) {
  walkAst(node, { enter: n => {
    const op = n[0]
    if ((op === 'local.set' || op === 'local.tee') && typeof n[1] === 'string') out.add(n[1])
  } })
}

/**
 * Return the FIRST kind of access for `name` in straight-line walk order.
 *   'write' — local.set/local.tee seen first
 *   'read'  — local.get seen first
 *   null    — not referenced
 */
export function firstAccess(node, name) {
  if (!isArr(node)) return null
  const op = node[0]
  // Walk children first — operands evaluate before the op. For local.set/tee
  // the VALUE child (idx 2) runs before the write, so a `local.get name` in
  // the value of `local.set name` is a read-before-write.
  if ((op === 'local.set' || op === 'local.tee') && node[1] === name) {
    if (node.length >= 3) {
      const r = firstAccess(node[2], name)
      if (r) return r
    }
    return 'write'
  }
  if (op === 'local.get' && node[1] === name) return 'read'
  for (let i = 1; i < node.length; i++) {
    const r = firstAccess(node[i], name)
    if (r) return r
  }
  return null
}

/**
 * Walk node, collect the set of local names TOUCHED (get/set/tee) anywhere within —
 * the union of read and written names. Every "classify each local in the loop body"
 * recognizer (tryVectorize, tryStencil, tryRampMap, tryToneMap) re-derived this exact
 * walk over the loop body before classifying names via `writes`/firstAccess; hoisted
 * here as the plan-level companion to collectWrites.
 */
export function collectReferencedNames(node, out) {
  walkAst(node, { enter: n => {
    const op = n[0]
    if ((op === 'local.get' || op === 'local.set' || op === 'local.tee') && typeof n[1] === 'string') out.add(n[1])
  } })
}

/**
 * Match the index-offset operand of a lane address — the part that scales the
 * induction variable inside `(i32.add base OFFSET)`. OFFSET is one of:
 *   (i32.shl (local.get IND) (i32.const K))            → strideLog2 K
 *   (local.get IND)                                    → strideLog2 0
 *   (local.tee $T <either of the above>)               → records $T
 *   (local.get $T)  where $T is a recorded offset-tee  → that tee's strideLog2
 *
 * The tee'd form arises from CSE: a map loop `b[i] = f(a[i])` over two distinct
 * base pointers shares one `i << K` offset (`(local.tee $T (i32.shl i K))` in
 * the first address, `(local.get $T)` in the second). `offsetTees` (Map
 * name→strideLog2) carries that across calls.
 *
 * Returns { strideLog2, teeName?: string } or null.
 */
// The per-iteration element count P (≥2) of an array-of-structs index `P*ind`, or null. Accepts the
// `(i32.mul P ind)`/`(i32.mul ind P)` form (non-power-of-2 P — RGB's 3) AND the strength-reduced
// power-of-2 form `(i32.shl ind S)` = ind·2^S (a `const j = 2*i`/`4*i` folds to a shift — complex/
// RGBA). P is the ELEMENT stride, not a byte offset.
export function matchConstMulIV(node, ind) {
  if (!isArr(node) || node.length !== 3) return null
  if (node[0] === 'i32.mul') {
    let p = null
    if (isLocalGet(node[1], ind)) p = constNum(node[2])
    else if (isLocalGet(node[2], ind)) p = constNum(node[1])
    return (p != null && p >= 2 && p <= 64) ? p : null
  }
  if (node[0] === 'i32.shl' && isLocalGet(node[1], ind)) {
    const s = constNum(node[2])
    if (s != null && s >= 1 && s <= 6) return 1 << s   // ind·2^S, stride 2..64
  }
  return null
}

// `allowTee` gates the CSE-tee unwrap — matchAffineAddr passes false to stay tee-free.
export function matchLaneOffset(off, ind, offsetTees, allowAos, aosPix, idxTees, allowTee = true) {
  if (isArr(off) && off[0] === 'local.get' && typeof off[1] === 'string' &&
      offsetTees && offsetTees.has(off[1])) {
    return { strideLog2: offsetTees.get(off[1]), pixelStride: (aosPix && aosPix.get(off[1])) || 1, teeName: null }
  }
  let teeName = null
  let n = off
  if (allowTee && isArr(n) && n[0] === 'local.tee' && n.length === 3) { teeName = n[1]; n = n[2] }
  // (i32.shl <ind-scaled> (i32.const K))
  if (isArr(n) && n[0] === 'i32.shl' && n.length === 3) {
    const k = constNum(n[2])
    if (k != null && k >= 0 && k <= 3) {
      if (isLocalGet(n[1], ind)) return { strideLog2: k, pixelStride: 1, teeName }
      // AoS (array-of-structs / interleaved channels), P elements per iteration, element
      // byte-size 1<<K. Only under allowAos (tryVectorize gathers/scatters the lanes); every
      // other recognizer returns null here. Two shapes: the folded `(i32.mul P ind)`, and a
      // pixel-index local `(local.get $J)` with $J = P*ind (the `const j = P*i`, via idxTees).
      if (allowAos) {
        const p = matchConstMulIV(n[1], ind)
        if (p != null) return { strideLog2: k, pixelStride: p, teeName }
        if (isArr(n[1]) && n[1][0] === 'local.get' && idxTees && idxTees.has(n[1][1])) {
          const pj = idxTees.get(n[1][1])
          if (pj > 1) return { strideLog2: k, pixelStride: pj, teeName }
        }
      }
    }
    // POWER-OF-2 AoS stride: `a[P*i]` (P = 2,4,8 — complex/RGBA/…) folds `(P*i)<<3` to a single
    // `(i32.shl ind K)` with K = 3 + log2(P) > 3. The excess shift over the f64 element (3) is the
    // pixel stride. f64 lane only — scanForLoadsStores' `1<<strideLog2 === elemSize` gate keeps
    // strideLog2=3 (=8 bytes), so a folded narrower-lane stride can't be mis-accepted here.
    else if (allowAos && k != null && k >= 4 && k <= 9 && isLocalGet(n[1], ind)) {
      return { strideLog2: 3, pixelStride: 1 << (k - 3), teeName }
    }
  }
  // (local.get ind) — stride 1
  if (isLocalGet(n, ind)) return { strideLog2: 0, pixelStride: 1, teeName }
  return null
}

/**
 * Mirror lane address: `base + ((INV − iv) << K)` — the DESCENDING twin of the
 * canonical lane address (symmetric fills: `inp[N−k] = lm`). INV is an i32
 * const or a bare local; the CALLER must verify a named INV is body-invariant
 * (not in the body writes set). f64 store sites only (2 lanes): the vector for
 * (iv, iv+1) mirrors to (INV−iv, INV−iv−1) — contiguous descending, stored as
 * one v128 at INV−iv−1 with the lanes swapped.
 */
export function matchMirrorAddr(addr, ind) {
  if (!isArr(addr) || addr[0] !== 'i32.add' || addr.length !== 3) return null
  for (const k of [1, 2]) {
    const off = addr[k]
    if (!isArr(off) || off[0] !== 'i32.shl' || off.length !== 3) continue
    const K = constNum(off[2])
    if (K == null || K < 0 || K > 3) continue
    const sub = off[1]
    if (!isArr(sub) || sub[0] !== 'i32.sub' || sub.length !== 3) continue
    if (!isLocalGet(sub[2], ind)) continue
    const inv = sub[1]
    const invName = isArr(inv) && inv[0] === 'local.get' && typeof inv[1] === 'string' ? inv[1] : null
    if (!invName && constNum(inv) == null) continue
    return { base: addr[k === 1 ? 2 : 1], invExpr: inv, invName, strideLog2: K }
  }
  return null
}

/**
 * Match an address expression `(i32.add base OFFSET)`, with optional outer
 * `(local.tee $A ...)`. OFFSET is matched by matchLaneOffset (which also
 * accepts a CSE'd `(local.tee $T (i32.shl ind K))` / `(local.get $T)` pair).
 * Also accepts `(local.get $A)` when $A is a previously-recorded address tee.
 *
 * Returns { strideLog2, base, teeName?, offsetTeeName?, viaLocal? } or null.
 *   `strideLog2` = K for i32.shl form, 0 for plain add form.
 *   `base` is the loop-invariant base subtree. `allowTee` threads to matchLaneOffset;
 *   matchAffineAddr passes false to stay tee-free.
 */
export function matchLaneAddr(addr, ind, addrLocals, offsetTees, allowAos, aosPix, idxTees, allowTee = true) {
  let teeName = null
  let n = addr
  // (local.get $A) where $A holds a previously-tee'd FULL lane-address.
  if (isArr(n) && n[0] === 'local.get' && typeof n[1] === 'string' && addrLocals && addrLocals.has(n[1])) {
    const e = addrLocals.get(n[1])
    return { strideLog2: e.strideLog2, pixelStride: e.pixelStride || 1, base: e.base, teeName: null, viaLocal: n[1] }
  }
  if (isArr(n) && n[0] === 'local.tee' && n.length === 3) {
    teeName = n[1]
    n = n[2]
  }
  if (!isArr(n) || n[0] !== 'i32.add' || n.length !== 3) return null
  const a = n[1], b = n[2]
  const off = matchLaneOffset(b, ind, offsetTees, allowAos, aosPix, idxTees, allowTee)
  if (!off) return null
  return { strideLog2: off.strideLog2, pixelStride: off.pixelStride || 1, base: a, teeName, offsetTeeName: off.teeName }
}

/**
 * Shared "base + (IDX << K)" address matcher for the tryGeneral* recognizer
 * family (tryGeneralStencil/tryGeneralMap/tryGeneralReduce) — three verbatim
 * ports of tryStencil's own original matchOffset/matchAddr, unified here
 * (pipeline-minimality campaign, `.work/archive/pipeline-minimality.md`'s
 * batch-2 follow-up (c): "the six verbatim load/store validator ports across
 * vectorize map/stencil/reduce are one walker copied six times"). All three
 * ports are code-identical (including the byte-lane offset fallback below,
 * which tryGeneralMap's own header comment says is ITS addition — "needed
 * here for the first time because tryStencil never reached i8 lanes at all" —
 * ported on to tryGeneralStencil/tryGeneralReduce from there, not from
 * tryStencil). tryStencil's own original — the ancestor these three ported
 * their SHAPE from, predating the byte-lane arm, not one of the six copies —
 * stays independent (its inline offset match has no such arm to unify).
 *
 * `ivCoeff` is deliberately NOT unified — it differs by recognizer
 * (tryGeneralStencil's own carries the toroidal wrap-select / float-domain-
 * grid-index arms the plain map/reduce recognizers never need — see the "port,
 * don't share" note above `tryGeneralStencil`), so it threads through as a
 * plain callback instead. `writes`/`offTees`/`addrTees` are the caller's own
 * per-scan mutable state (offTees/addrTees accumulate tee-CSE bindings across
 * the whole scan; `writes` is the block-loop scaffold's written-names set).
 */
function isInvariantBase(b, writes) {
  return (isArr(b) && b[0] === 'global.get') || (isLocalGet(b) && !writes.has(b[1]))
}

/** Resolve one `(IDX << K)` offset operand — tee-CSE via `offTees`, `ivCoeff(IDX)
 * === 1` proving the affine coefficient; a bare coefficient-1 affine offset with
 * no shift at all also matches (a stride-1/byte lane's `i*1` is a no-op the
 * compiler never wraps in `i32.shl 0`) — dead for tryGeneralReduce in practice
 * (no i8/i16 REDUCE_CANON entry) but kept for parity, exactly as the ported
 * comment at its call site says. */
export function matchStrideOffset(off, expectStride, offTees, ivCoeff) {
  let ot = null, o = off
  if (isArr(o) && o[0] === 'local.tee' && o.length === 3) { ot = o[1]; o = o[2] }
  if (isLocalGet(o) && offTees.has(o[1])) return { idx: offTees.get(o[1]) }
  if (isArr(o) && o[0] === 'i32.shl' && o.length === 3 && isI32Const(o[2]) && (1 << o[2][1]) === expectStride && ivCoeff(o[1]) === 1) {
    if (ot) offTees.set(ot, o[1])
    return { idx: o[1] }
  }
  if (expectStride === 1 && ivCoeff(o) === 1) { if (ot) offTees.set(ot, o); return { idx: o } }
  return null
}

/** Resolve `(i32.add base OFFSET)` (either operand order), or a previously
 * tee'd full address via `addrTees`. `base` must be `isInvariantBase` (a
 * `global.get`, or a `local.get` never in `writes`). Returns `{ base, idx }`
 * or null — same shape as `matchLaneAddr`'s `{ base, strideLog2, … }`, minus
 * the AoS/mirror generality this simpler affine-only proof doesn't need. */
export function matchStrideAddr(addr, expectStride, writes, offTees, addrTees, ivCoeff) {
  let teeName = null, n = addr
  if (isArr(n) && n[0] === 'local.tee' && n.length === 3) { teeName = n[1]; n = n[2] }
  if (isLocalGet(n) && addrTees.has(n[1])) { const e = addrTees.get(n[1]); if (teeName) addrTees.set(teeName, e); return e }
  if (!isArr(n) || n[0] !== 'i32.add' || n.length !== 3) return null
  for (const [bi, oi] of [[1, 2], [2, 1]]) {
    if (!isInvariantBase(n[bi], writes)) continue
    const om = matchStrideOffset(n[oi], expectStride, offTees, ivCoeff)
    if (om) { const e = { base: n[bi], idx: om.idx }; if (teeName) addrTees.set(teeName, e); return e }
  }
  return null
}

/**
 * A scalar i32 local that is ONLY ever assigned a lane offset — `(i32.shl ind K)`
 * (or bare `ind` for stride 0) — is a CSE'd offset shared across base pointers.
 * Returns the consistent strideLog2, or null if any write to it diverges.
 * This soundness check backs every `(local.get $T)` resolved via `offsetTees`.
 */
export function _offsetLocalStride(body, name, ind, allowAos, idxTees) {
  let stride = null, found = false, ok = true, pix = null
  const inspect = n => {
    if (!isArr(n) || (n[0] !== 'local.tee' && n[0] !== 'local.set') || n[1] !== name || n.length !== 3) return
    found = true
    const v = n[2]
    let k = null
    if (isArr(v) && v[0] === 'i32.shl' && v.length === 3) {
      const kk = constNum(v[2])
      // Power-of-2 AoS offset local `(i32.shl ind K)` with K>3 — matches matchLaneOffset's
      // power-of-2 arm: element shift 3, pixel stride 2^(K-3). Verify all writes share one P.
      if (allowAos && isLocalGet(v[1], ind) && kk != null && kk >= 4 && kk <= 9) {
        k = 3; const p = 1 << (kk - 3); if (pix == null) pix = p; else if (pix !== p) ok = false
      }
      else if (isLocalGet(v[1], ind)) { k = kk; if (k == null || k < 0 || k > 3) ok = false }
      else if (allowAos && kk != null && kk >= 0 && kk <= 3) {
        // AoS offset local (i32.shl <P·ind> K) — folded `(i32.mul P ind)` or a pixel-index
        // local `(local.get $J)` with $J = P·ind (idxTees). Verify every write shares one P.
        let p = matchConstMulIV(v[1], ind)
        if (p == null && isArr(v[1]) && v[1][0] === 'local.get' && idxTees && idxTees.get(v[1][1]) > 1) p = idxTees.get(v[1][1])
        if (p != null) { k = kk; if (pix == null) pix = p; else if (pix !== p) ok = false }
        else ok = false
      } else ok = false
    } else if (isLocalGet(v, ind)) {
      k = 0
    } else ok = false
    if (k != null) {
      if (stride == null) stride = k
      else if (stride !== k) ok = false
    }
  }
  for (const s of body) walkAst(s, { enter: inspect })
  return found && ok ? stride : null
}

// ---- BodyModel (.work/evidence.md §BodyModel §2) — slices 1-3 landed -------------
//
// One shared per-block record generalizing three independent private discovery predicates
// (`_offsetLocalStride`/`_isAddressLocal`/`_isPixelIndexLocal`) plus `matchMirrorAddr` into a
// single per-name write-shape classification (`addrTable`), and a per-load/store-SITE resolved
// address table (`siteAccess`) + base-identity partition (`aliasClass`) built on top of it.
// Consumers so far (slice 3): tryReduceBitExact + tryRampMap read `bl.addrTable`/
// `bl.siteAccess`; the incremental trio (slices 5-7) still reads its own private derivations.
// JZ_DEBUG_INVARIANTS shadow-asserts (`assertBodyModelSound`, below) prove the generalization
// agrees with the private predicates it will eventually let recognizers retire, on every block
// this compiler matches — see the design doc §6 "silently widening acceptance" risk this exists
// to catch BEFORE any recognizer depends on it.

// One name's write-shape classification against EVERY write of `name` in `body` — generalizes
// `_offsetLocalStride` (offset)/`_isAddressLocal` (fullAddr)/`_isPixelIndexLocal` (idxTee)/
// `matchMirrorAddr` (mirror, applied to the tee/set VALUE rather than a store address) into one
// per-name walk instead of four. A name is admitted for a kind only when EVERY write agrees on
// the SAME concrete shape (same base by structural identity, same strideLog2, same pixelStride/
// invName) — strictly no LOOSER than the classification-only booleans it generalizes, which
// never resolve a concrete offset from their answer and so were safe to accept "always shaped
// like K, but with a different base/stride per write" (a case that can't arise from a single
// address-tee's or pixel-index local's realistic single-definition-per-iteration form). A shared
// table that `siteAccess` will resolve concrete addresses FROM needs the stronger single-value
// guarantee, so this narrowing is deliberate; `assertBodyModelSound` measures it as a no-op on
// the full corpus rather than asserting it away.
// `writes` is EVERY local.set/local.tee node targeting `name` anywhere in the block (collected
// once by buildAddrTable's phase 1, below) — table-local: no re-walk of `body` per name.
function classifyAddrLocal(writes, name, ind) {
  // 'offset': reused verbatim from _offsetLocalStride, given the pre-collected write list as
  // its pseudo-body (the same "synthetic single-write body" shape tryVectorize/tryMemCopyFill's
  // own private incremental scans already pass it) — so addrTable's offset-kind entries stay
  // byte-identical to the old deriveOffsetTees output BY CONSTRUCTION, just without re-deriving
  // `writes` from scratch per name.
  const off = _offsetLocalStride(writes, name, ind)
  if (off != null) return { kind: 'offset', strideLog2: off, pixelStride: 1 }

  let fullAddr = null, fullOk = true, fullFound = false
  let idx = null, idxOk = true, idxFound = false
  let mirror = null, mirrorOk = true, mirrorFound = false

  for (const n of writes) {
    const v = n[2]
    fullFound = true
    const m = matchLaneAddr(['local.tee', name, v], ind)
    if (m) {
      if (!fullAddr) fullAddr = { strideLog2: m.strideLog2, base: m.base }
      else if (fullAddr.strideLog2 !== m.strideLog2 || !exprEq(fullAddr.base, m.base)) fullOk = false
    } else fullOk = false

    idxFound = true
    const p = matchConstMulIV(v, ind)
    if (p != null) { if (idx == null) idx = p; else if (idx !== p) idxOk = false }
    else idxOk = false

    mirrorFound = true
    const mm = matchMirrorAddr(v, ind)
    if (mm) {
      if (!mirror) mirror = { strideLog2: mm.strideLog2, base: mm.base, invName: mm.invName }
      else if (mirror.strideLog2 !== mm.strideLog2 || mirror.invName !== mm.invName || !exprEq(mirror.base, mm.base)) mirrorOk = false
    } else mirrorOk = false
  }

  if (fullFound && fullOk && fullAddr) return { kind: 'fullAddr', strideLog2: fullAddr.strideLog2, pixelStride: 1, base: fullAddr.base }
  if (idxFound && idxOk && idx != null) return { kind: 'idxTee', strideLog2: null, pixelStride: idx }
  if (mirrorFound && mirrorOk && mirror) return { kind: 'mirror', strideLog2: mirror.strideLog2, pixelStride: 1, base: mirror.base, invName: mirror.invName }
  return null
}

// The affine access table (design §2): every scalar i32 local in `body` whose write shape is
// provably-consistent, keyed by name. Phase 1 is ONE walk collecting every local.set/local.tee
// write node, BUCKETED BY NAME — the evidence phase 2 (classifyAddrLocal, above) classifies
// against; phase 2 is then table-local (reads its name's own write list, never re-walks
// `body`). Re-walking `body` once per candidate name inside classifyAddrLocal would be
// quadratic in loop-body size × candidate-local count; bucketing by name up front keeps this
// linear. Both phases are pure functions of (body, ind) — order-independent, per design §3's
// "collect every tee-definition first, resolve second" argument.
function buildAddrTable(body, ind) {
  const writesByName = new Map()
  const gather = n => {
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string' && n.length === 3) {
      let list = writesByName.get(n[1])
      if (!list) writesByName.set(n[1], list = [])
      list.push(n)
    }
  }
  for (const s of body) walkAst(s, { enter: gather })
  const addrTable = new Map()
  for (const [name, writes] of writesByName) {
    const e = classifyAddrLocal(writes, name, ind)
    if (e) addrTable.set(name, e)
  }
  return addrTable
}

// Projects addrTable's offset-kind subset to the plain `Map<name, strideLog2>` shape
// matchLaneAddr's `offsetTees` parameter expects — this projection is the SOLE construction of
// that table: `bodyFacts` derives `bl.offsetTees` FROM `bl.addrTable` via this function instead
// of computing it twice, so the two can never diverge. tryRampMap's own private `addrLocals`
// (recordAddrTees — an in-place-map CSE'd full-address tee, genuinely recognizer-private per
// the design's terminal verdict) still combines with this at each matchLaneAddr call; only the
// offsetTees half is BodyModel-sourced.
function offsetTeesFromAddrTable(addrTable) {
  const m = new Map()
  for (const [name, e] of addrTable) if (e.kind === 'offset') m.set(name, e.strideLog2)
  return m
}

// Per-load/store SITE resolved access (design §2): re-runs matchLaneAddr against the FROZEN
// `offsetTees` table (read-only lookup) instead of a live-mutation map — the plain, non-AoS query
// shape tryReduceBitExact/tryRampMap's non-recordAddrTees call sites already make: `node[1]`
// RAW (empty addrLocals: neither consumer resolves a `(local.get $A)` full-address-tee today; NO
// memarg unwrap: neither consumer ever unwraps a folded `offset=N` memarg either — tryReduceBitExact
// has no store path at all, tryRampMap's own store-shape gate requires `length===3`, rejecting the
// 4-element memarg form outright — so a memarg-carrying site correctly gets NO entry here, matching
// their existing silent-bail on such nodes exactly; unwrapping would be a WIDER acceptance than
// either consumer has ever had, precisely the "silently widening" risk the design's §6 flags).
function buildSiteAccess(body, ind, offsetTees) {
  const siteAccess = new WeakMap()
  const recordSite = node => {
    if (!isArr(node)) return
    const op = node[0]
    if (LOAD_OPS[op] || STORE_OPS[op]) {
      const m = matchLaneAddr(node[1], ind, undefined, offsetTees)
      if (m) siteAccess.set(node, { base: m.base, strideLog2: m.strideLog2, pixelStride: m.pixelStride || 1, elemWidth: 1 << m.strideLog2, teeName: m.teeName || null })
    }
  }
  for (const s of body) walkAst(s, { enter: recordSite })
  return siteAccess
}

// Partition of every access base in siteAccess into equivalence classes (design §4, v1 scope: the
// static base-identity fact only — no dependence-edge graph, see §4/§7).
// SOUNDNESS: two classes may be DISTINCT only under an existing proof (distinctParams, separate
// fresh allocations, neverGrown anchors — none of these are threaded through here yet, and the
// HIR provenance link is a shadow-assert with no consumer, so it does not supply a distinctness
// proof either); absent proof, different bases are UNKNOWN aliasing and must conservatively
// share one class — `let b = a` gives two names for one base, so a per-base partition would
// manufacture a distinctness proof out of a rename. Same-base positivity ("provably the same
// base") doesn't need a partition: compare base identity directly. Until a real proof channel is
// threaded, the sound answer is the single universal class — a CONSTANT. A per-site base-key
// collection (a structural serialization per load/store site) is only worth building in
// buildSiteAccess once a points-to consumer actually partitions on it — building it against a
// constant class would be pure dead production cost.
const ALIAS_CLASS_UNIVERSAL = { get: () => 0 }
function buildAliasClass() {
  return ALIAS_CLASS_UNIVERSAL
}

export function buildBodyModel(body, ind) {
  const addrTable = buildAddrTable(body, ind)
  const offsetTees = offsetTeesFromAddrTable(addrTable)
  const siteAccess = buildSiteAccess(body, ind, offsetTees)
  const aliasClass = buildAliasClass()
  return { addrTable, offsetTees, siteAccess, aliasClass }
}

// JZ_DEBUG_INVARIANTS-gated proof that BodyModel's generalized tables agree with the private
// predicates/queries they generalize, on every block this compiler ever matches (battery + bench
// corpus + self-compile — see .work/archive/todo.md's LOOPPLAN BODYMODEL SLICE 1 entry for the measured
// counts). Throws on the first divergence found — a widening or narrowing in the generalization
// is a correctness question to answer BEFORE any recognizer can depend on the shared table, not
// a warning to log past. No-op unless JZ_DEBUG_INVARIANTS=1 (DBG_INVARIANTS), zero production cost.
export function assertBodyModelSound(body, ind, bm) {
  const { addrTable, offsetTees, siteAccess } = bm
  // (a) No check here: `offsetTees` is DERIVED from `addrTable` (see `offsetTeesFromAddrTable`,
  // `buildBodyModel`), so the two can never diverge — comparing them would just compare
  // addrTable to itself. A check is only meaningful while two independent constructions coexist;
  // once one is defined in terms of the other, asserting their agreement is vacuous.

  // (b) fullAddr/idxTee classification vs the private predicates they generalize — addrTable is
  // allowed to be a STRICTER subset (see classifyAddrLocal's doc) but never a WIDER one: every
  // addrTable entry must be a case the private predicate also accepts.
  const names = new Set()
  const gather = n => {
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') names.add(n[1])
  }
  for (const s of body) walkAst(s, { enter: gather })
  for (const name of names) {
    const e = addrTable.get(name)
    if (e && e.kind === 'fullAddr' && !_isAddressLocal(body, name, ind))
      throw new Error(`BodyModel addrTable fullAddr entry for ${name} not accepted by _isAddressLocal`)
    if (e && e.kind === 'idxTee' && !_isPixelIndexLocal(body, name, ind))
      throw new Error(`BodyModel addrTable idxTee entry for ${name} not accepted by _isPixelIndexLocal`)
  }

  // (c) siteAccess reproduces the plain (non-AoS, no addrLocals) matchLaneAddr query
  // tryReduceBitExact/tryRampMap's non-recordAddrTees paths already make at every
  // load/store site — a fresh re-derivation compared against the built table (the same
  // cache-freshness-assert shape as analyze.js's assertBodyFactsFresh).
  const assertSite = node => {
    if (!isArr(node)) return
    const op = node[0]
    if (LOAD_OPS[op] || STORE_OPS[op]) {
      const ref = matchLaneAddr(node[1], ind, undefined, offsetTees)
      const got = siteAccess.get(node)
      const refKey = ref ? `${ref.strideLog2}|${JSON.stringify(ref.base)}|${ref.pixelStride || 1}|${ref.teeName || ''}` : null
      const gotKey = got ? `${got.strideLog2}|${JSON.stringify(got.base)}|${got.pixelStride || 1}|${got.teeName || ''}` : null
      if (refKey !== gotKey)
        throw new Error(`BodyModel siteAccess diverges at a load/store site: ref=${refKey} got=${gotKey}`)
    }
  }
  for (const s of body) walkAst(s, { enter: assertSite })
}

// True if the tree contains any branch or return — control flow that a flattened value-block
// lift can't preserve (an early `br`/`return` out of the block changes which value is produced).
export const hasBranchOrReturn = (node) => {
  let found = false
  walkAst(node, { enter: n => {
    if (found) return false
    const op = n[0]
    if (op === 'br' || op === 'br_if' || op === 'br_table' || op === 'return') { found = true; return false }
  } })
  return found
}

// True if any node in the tree writes a global. When false for a loop body,
// every `global.get` inside it is loop-invariant — safe to splat for SIMD.
export const hasGlobalSet = (node) => {
  let found = false
  walkAst(node, { enter: n => { if (found) return false; if (n[0] === 'global.set') { found = true; return false } } })
  return found
}

// True if EXPR carries any side effect — a call, a memory store/op, or a global
// write. Used to reject an impure preamble we would otherwise clone (run twice).
export const hasSideEffect = (node) => {
  let found = false
  walkAst(node, { enter: n => {
    if (found) return false
    const op = n[0]
    if (op === 'call' || op === 'call_indirect' || op === 'global.set'
      || (typeof op === 'string' && (op.includes('.store') || op.startsWith('memory.')))) { found = true; return false }
  } })
  return found
}

// True if any node in the tree is a call whose callee is not a `$math.*` pure
// helper. A non-pure call (writes a scratch global/memory) can mutate state that
// a per-pixel lane local — computed once, before the outer-pixel recognizers'
// per-lane epilogue re-runs the call — would then read stale, breaking bit-
// exactness. Every outer-pixel recognizer that lifts a per-pixel body (strip,
// iterated-reduce, conv-column) re-derived this exact scan over `obody` before
// admitting the shape; hoisted as the LoopPlan companion to hasGlobalSet.
// (tryPerPixelColor additionally exempts pureFuncMap-registered pure user
// functions — a recognizer-specific admission, kept local there.)
export const hasImpureCall = (node) => {
  let found = false
  walkAst(node, { enter: n => {
    if (found) return false
    if (n[0] === 'call' && typeof n[1] === 'string' && !n[1].startsWith('$math.')) { found = true; return false }
  } })
  return found
}

// Scalar locals that are ALWAYS computed as `(i32.add base (i32.shl ind K))`
// or aliased to such an address are "address tees", not lane data. They stay
// scalar i32 in the lifted body.
export function _isAddressLocal(body, name, ind) {
  let onlyAsAddrTee = true
  let foundTee = false
  const inspect = n => {
    if (!isArr(n) || (n[0] !== 'local.tee' && n[0] !== 'local.set') || n[1] !== name) return
    foundTee = true
    // A set is checked through the equivalent tee-shaped matcher.
    const m = matchLaneAddr(['local.tee', name, n[2]], ind)
    if (!m) onlyAsAddrTee = false
    return false
  }
  for (const s of body) walkAst(s, { enter: inspect })
  return foundTee && onlyAsAddrTee
}

// A pixel-INDEX local — every write is `(i32.mul P ind)` — is the `const j = P*i` of an
// AoS loop (feeds channel addresses `base + ((j+c)<<K)`). Classified as 'addr' so the lift
// keeps it a recomputed scalar i32, never a v128 lane. (Only tryVectorize consults this.)
export function _isPixelIndexLocal(body, name, ind) {
  let found = false, ok = true
  const inspect = n => {
    if (!isArr(n) || (n[0] !== 'local.set' && n[0] !== 'local.tee') || n[1] !== name || n.length !== 3) return
    found = true
    if (matchConstMulIV(n[2], ind) == null) ok = false
    return false
  }
  for (const s of body) walkAst(s, { enter: inspect })
  return found && ok
}
