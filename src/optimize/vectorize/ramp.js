import { cloneNode, walkAst } from '../../ast.js'
import { constNum, firstAccess, hasGlobalSet, isI32Const, isLocalGet, matchLaneAddr } from './addr-model.js'
import { LOAD_OPS, STORE_OPS } from './lane-tables.js'
import { liftExprV, liftStmt } from './lift.js'
import { isArr } from './node-utils.js'
import { matchBlockLoop } from './scaffold.js'

export function tryRampMap(blockNode, fnLocals, freshIdRef) {
  // Strict envelope (identical to tryVectorize's) + trailing RUN of increments; the "every
  // increment shares the IV's name" check below is tryRampMap's own residual.
  const bl = matchBlockLoop(blockNode, { multiInc: true })
  if (!bl) return null
  const { incVar: ivName, bound, boundLocal, body, increments, hasGlobalSet: blHasGlobalSet, writes: blWrites, referenced: blReferenced, offsetTees } = bl
  // BodyModel fact (bl.offsetTees — see offsetTeesFromAddrTable, bl.addrTable's offset-kind
  // subset, computed once at the dispatch); combines below with this recognizer's own private
  // recordAddrTees map (genuinely private per the design's terminal verdict).
  if (!boundLocal && !isI32Const(bound)) return null
  if (!body.length) return null
  if (blHasGlobalSet) return null

  // Find exactly one store. Its address is the inline lane address
  // `base + (i << K)` — the IV strength-reducer runs AFTER this pass, so the
  // pointer is still expressed in terms of the IV. We keep the address verbatim
  // (scalar i32) and advance the IV by LANES, so `base + (i<<K)` lands on the
  // next group's first element each SIMD step — for any element width.
  // Collect every store. One store → the original single-map paths (ramp pack / widening /
  // 4-wide). Two or more independent store8s → a multi-channel in-place fade (boids' 4-channel
  // u8 trail), handled by the multi-store WIDEN16 branch below; one pass over memory, N widening
  // stores. Stores beyond the first don't reach the single-store paths.
  const storeStmts = []
  for (let i = 0; i < body.length; i++) {
    const s = body[i]
    if (isArr(s) && STORE_OPS[s[0]]) storeStmts.push({ stmt: s, idx: i })
  }
  if (!storeStmts.length) return null
  const storeStmt = storeStmts[0].stmt, storeIdx = storeStmts[0].idx
  const storeOp = storeStmt[0]
  if (storeStmt.length !== 3) return null
  const elemLog2 = { 'i32.store8': 0, 'i32.store': 2 }[storeOp]
  if (elemLog2 === undefined) return null
  if (increments.some(x => x.name !== ivName)) return null

  // CSE'd lane offsets: a local written ONLY as `i << K` (or bare `i`) is the
  // shared offset the IV stage threads across base pointers (src[i], dst[i],
  // out[i] all reuse one `(local.tee $p (local.get i))`). Resolve them so the
  // load/store address matchers accept the `(local.get $p)` reuses. BodyModel fact
  // (bl.offsetTees, destructured above).

  // CSE'd FULL lane address: an in-place map `a[i] = f(a[i])` shares one `(local.tee $A
  // (i32.add base i))` between the load and the store, reused as `(local.get $A)`. Without
  // resolving it the store/load address matchers reject the bare get (the empty-addrLocals
  // bug that kept every in-place trail-fade scalar). Record each such tee — its lifted
  // address (the tee) runs in the hoisted v128.load, so the store's get reads it back.
  const addrLocals = new Map()
  const recordAddrTees = n => {
    if (n[0] === 'local.tee' && typeof n[1] === 'string' && isArr(n[2]) && n[2][0] === 'i32.add') {
      const m = matchLaneAddr(n[2], ivName, addrLocals, offsetTees)
      if (m && m.teeName == null) addrLocals.set(n[1], { strideLog2: m.strideLog2, base: m.base })
    }
  }
  for (const s of body) walkAst(s, { enter: recordAddrTees })

  const storeAddr = storeStmt[1]
  const addrM = matchLaneAddr(storeAddr, ivName, addrLocals, offsetTees)
  if (!addrM || addrM.strideLog2 !== elemLog2) return null

  // Memory loads turn this into a widening byte-map: out[i] = narrow(f(widen(a[i])…)).
  // Only the u8 shape is supported — every load must be a narrow UNSIGNED u8 load
  // of the same 4 elements the store writes (base + i; the IV strength-reducer
  // runs later). Full-width i32 maps are tryVectorize's job; mixed widths bail.
  let hasLoads = false, loadsOk = true
  const checkLoad = (n) => {
    if (!isArr(n)) return
    if (LOAD_OPS[n[0]]) {
      hasLoads = true
      if (storeOp !== 'i32.store8' || n[0] !== 'i32.load8_u') { loadsOk = false; return }
      const m = matchLaneAddr(n[1], ivName, addrLocals, offsetTees)
      if (!m || m.strideLog2 !== 0) loadsOk = false
      return  // address validated; the IV-strided subtree is not data
    }
    for (let i = 1; i < n.length; i++) checkLoad(n[i])
  }
  for (const s of body) checkLoad(s)
  if (!loadsOk) return null

  // Every other body stmt must be `(local.set $lane EXPR)` — straight-line lane
  // locals feeding the store. Classify locals for the lift (writes/referenced: plan-level census).
  const writes = blWrites
  if (boundLocal && writes.has(boundLocal)) return null
  const referenced = blReferenced

  const localKind = new Map()
  for (const name of referenced) {
    if (name === ivName) continue
    if (writes.has(name)) {
      let firstKind = null
      for (const s of body) { const kAcc = firstAccess(s, name); if (kAcc) { firstKind = kAcc; break } }
      if (firstKind === 'read') return null   // loop-carried → reduction/stencil, not a pure map
      localKind.set(name, 'lane')
    } else {
      localKind.set(name, 'invariant')
    }
  }

  // Lift. lane type is always i32 (the ramp and all narrow stores compute in i32).
  const newLanedLocals = new Map()
  const extraLocals = []
  const freshV128 = (tag) => { const n = `$__${tag}${freshIdRef.next++}`; extraLocals.push(['local', n, 'v128']); return n }
  const ctx = { laneType: 'i32', incVar: ivName, rampVar: ivName, rampTemp: null, widenLoads: true, localKind, fnLocals: null, newLanedLocals, extraLocals, freshIdRef, fail: false, failReason: null }

  // A byte store fed by one value expression (inline, or via a single lane-local
  // temp `tw = EXPR; store(addr, tw)`) carries no loop-carried state, so we can
  // run the lane group 4× (16 samples) per iteration off four offset ramps and
  // pack the low bytes into ONE i8x16 v128.store — amortizing store + loop
  // overhead the way clang/zig's 16-wide NEON does. wideValueExpr is the
  // expression to lift per offset; null (i32 stores, multi-stmt bodies, or
  // widening loads — whose addresses would need per-offset advancing) → 4-wide.
  // The single byte-value expression feeding the store — inline, or via one lane-local
  // temp `tw = EXPR; store(addr, tw)`. Shared by both 16-wide paths below.
  const byteValueExpr = (() => {
    if (storeOp !== 'i32.store8') return null
    if (body.length === 1 && storeIdx === 0) return storeStmt[2]
    if (body.length === 2 && storeIdx === 1) {
      const set = body[0], sv = storeStmt[2]
      if (isArr(set) && set[0] === 'local.set' && set.length === 3 &&
          isLocalGet(sv, set[1]) && localKind.get(set[1]) === 'lane') return set[2]
    }
    return null
  })()
  // With u8 loads, the byte map can go 16-wide in i16x8 (the alpha-blend shape: out[i] =
  // (src[i]*A + dst[i]*B + bias) >> s) — load 16, extend_low/high, the affine arithmetic
  // in i16x8, byte-pack, store 16. Sound ONLY when every
  // intermediate provably fits u16 ([0,65535], so i16x8 mod-2^16 never wraps and shr_u ==
  // the scalar shr_s on a non-negative value) and the result fits a byte ([0,255], so
  // byte selection is exact). `byteValueRange` returns [min,max] or null when any node
  // is unanalyzable, can go negative, or exceeds u16. An invariant local of unknown
  // magnitude (local.get) → null → falls back to the bit-exact 4-wide path.
  const byteValueRange = (e) => {
    if (!isArr(e)) return null
    const op = e[0]
    let r
    if (op === 'i32.const') { const v = constNum(e); r = [v, v] }
    else if (op === 'i32.load8_u') r = [0, 255]
    else if (op === 'i32.add') { const a = byteValueRange(e[1]), b = byteValueRange(e[2]); if (!a || !b) return null; r = [a[0] + b[0], a[1] + b[1]] }
    else if (op === 'i32.sub') { const a = byteValueRange(e[1]), b = byteValueRange(e[2]); if (!a || !b) return null; r = [a[0] - b[1], a[1] - b[0]] }
    else if (op === 'i32.mul') { const a = byteValueRange(e[1]), b = byteValueRange(e[2]); if (!a || !b) return null; const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]]; r = [Math.min(...p), Math.max(...p)] }
    else if ((op === 'i32.shr_u' || op === 'i32.shr_s') && isI32Const(e[2])) { const a = byteValueRange(e[1]); if (!a || a[0] < 0) return null; const s = constNum(e[2]); if (s < 0 || s > 16) return null; r = [a[0] >> s, a[1] >> s] }
    else if (op === 'i32.and' && isI32Const(e[2])) { const a = byteValueRange(e[1]); if (!a) return null; const m = constNum(e[2]); if (m < 0) return null; r = [0, Math.min(a[1], m)] }
    else return null
    return (r[0] < 0 || r[1] > 65535) ? null : r
  }
  // The i16x8 widening byte-map emit for ONE store, factored so a multi-channel fade reuses it
  // per channel: load each u8 input once (v128.load 16), extend_low/high to two i16x8 halves,
  // run the affine map in i16x8 on each half, pack to i8x16, store 16. Each load is hoisted
  // (extend_low + extend_high share one load); loads run in source order, so an offset/address
  // `local.tee` in a load is set before the store's `local.get` reads it.
  const packWiden16 = (low, high) => {
    // `(u16Expr >> 8) & 255` is the HIGH byte of each u16 lane. Select it
    // directly instead of materializing the shifts. Portable Wasm has no
    // non-saturating add-high-narrow op, but this removes two vector shifts and
    // gives native backends one byte-deinterleave to select. Other proven byte
    // results select the low byte as before.
    const highByte = low[0] === 'i16x8.shr_u' && high[0] === 'i16x8.shr_u' &&
      isI32Const(low[2]) && constNum(low[2]) === 8 && isI32Const(high[2]) && constNum(high[2]) === 8
    if (highByte) { low = low[1]; high = high[1] }
    const b = highByte ? 1 : 0
    return ['i8x16.shuffle',
      String(b), String(b + 2), String(b + 4), String(b + 6),
      String(b + 8), String(b + 10), String(b + 12), String(b + 14),
      String(16 + b), String(18 + b), String(20 + b), String(22 + b),
      String(24 + b), String(26 + b), String(28 + b), String(30 + b), low, high]
  }
  const widen16Plan = (sAddr, valueExpr, byteOffset = 0) => {
    const loadTemps = new Map()
    const loadSets = []
    const at = (addr) => byteOffset
      ? ['i32.add', cloneNode(addr), ['i32.const', byteOffset]]
      : cloneNode(addr)
    const collectLoads = (e) => {
      if (!isArr(e)) return
      if (e[0] === 'i32.load8_u') {
        const k = JSON.stringify(e[1])
        if (!loadTemps.has(k)) { const t = freshV128('win'); loadTemps.set(k, t); loadSets.push(['local.set', t, ['v128.load', at(e[1])]]) }
      } else for (let i = 1; i < e.length; i++) collectLoads(e[i])
    }
    collectLoads(valueExpr)
    const liftW = (e, half) => {
      const op = e[0]
      if (op === 'i32.const') return ['i16x8.splat', e]
      if (op === 'i32.load8_u') return [`i16x8.extend_${half}_i8x16_u`, ['local.get', loadTemps.get(JSON.stringify(e[1]))]]
      if (op === 'i32.add') return ['i16x8.add', liftW(e[1], half), liftW(e[2], half)]
      if (op === 'i32.sub') return ['i16x8.sub', liftW(e[1], half), liftW(e[2], half)]
      if (op === 'i32.mul') return ['i16x8.mul', liftW(e[1], half), liftW(e[2], half)]
      if (op === 'i32.shr_u' || op === 'i32.shr_s') return ['i16x8.shr_u', liftW(e[1], half), e[2]]
      if (op === 'i32.and') return ['v128.and', liftW(e[1], half), ['i16x8.splat', e[2]]]
      return null   // byteValueRange already proved every op is one of the above
    }
    const addr = at(sAddr)
    const low = liftW(valueExpr, 'low'), high = liftW(valueExpr, 'high')
    // byteValueRange proved every shifted result in [0,255], so selecting each
    // i16 lane's low byte is exact. A saturating narrow states a stronger,
    // unnecessary operation and blocks native backends from selecting fused
    // shift/add+narrow instructions.
    return { loads: loadSets, addr, low, high,
      body: [['v128.store', addr, packWiden16(low, high)]] }
  }
  const widen16Emit = (sAddr, valueExpr, byteOffset = 0) => {
    const p = widen16Plan(sAddr, valueExpr, byteOffset)
    return [...p.loads, ...p.body]
  }

  let lifted, LANES
  if (storeStmts.length > 1) {
    // MULTI-CHANNEL in-place byte fade: N independent store8s in one loop (boids' 4-channel u8
    // trail). Each store must be a u8 store of a WIDEN16-eligible value (range ≤ 255); it emits
    // its own load→i16x8→narrow→store sequence, all concatenated into ONE 16-wide pass — so the
    // memory traffic stays single-pass (vs N separate vectorized loops). Every body statement
    // must be a store or the lane-local set feeding one; any other (shared/invariant) compute
    // bails to scalar, since it would be dropped.
    LANES = 16
    lifted = []
    const consumed = new Set()
    for (const { stmt, idx } of storeStmts) {
      if (stmt[0] !== 'i32.store8' || stmt.length !== 3) return null
      const a = matchLaneAddr(stmt[1], ivName, addrLocals, offsetTees)
      if (!a || a.strideLog2 !== 0) return null
      consumed.add(idx)
      let val = stmt[2]
      if (isArr(val) && val[0] === 'local.get' && typeof val[1] === 'string' && localKind.get(val[1]) === 'lane') {
        let setIdx = -1
        for (let j = 0; j < idx; j++) { const s = body[j]; if (isArr(s) && s[0] === 'local.set' && s[1] === val[1] && s.length === 3) { setIdx = j; val = s[2] } }
        if (setIdx < 0) return null
        consumed.add(setIdx)
      }
      const rng = byteValueRange(val)
      if (!rng || rng[1] > 255) return null   // not WIDEN16-eligible (overflows u16 or u8) → scalar
      lifted.push(...widen16Emit(stmt[1], val))
    }
    if (consumed.size !== body.length) return null
  } else {
    const wideValueExpr = (!hasLoads && byteValueExpr) ? byteValueExpr : null   // pure ramp → 16-wide pack
    const widenRange = (hasLoads && byteValueExpr) ? byteValueRange(byteValueExpr) : null
    const WIDEN16 = widenRange != null && widenRange[1] <= 255   // result fits a byte ⇒ byte-pack exact
    const WIDE16 = wideValueExpr != null
    LANES = (WIDE16 || WIDEN16) ? 16 : 4
    const ramp = (off) => ['i32x4.add', ['i32x4.splat', ['local.get', ivName]],
      ['v128.const', 'i32x4', String(off), String(off + 1), String(off + 2), String(off + 3)]]

    if (WIDEN16) {
      // wasm2c preserves Wasm's structured back-edge, which keeps clang from
      // applying its native multi-vector unroller. Schedule four independent
      // vectors here: one loop trip handles a cache-line-sized 64-byte span,
      // exposing the same memory-level parallelism as clang's scalar→NEON/AVX
      // path. The aligned SIMD bound plus the untouched scalar loop below cover
      // every remainder exactly, including spans shorter than 64 bytes.
      LANES = 64
      const plans = []
      for (let off = 0; off < LANES; off += 16) plans.push(widen16Plan(storeAddr, byteValueExpr, off))
      // Keep all group inputs live together. Without this phase split, watr
      // correctly coalesces each non-overlapping temp into one local and the C
      // backend sees four serial chains. Overlapping the load lifetimes forces
      // independent v128 values and lets the native scheduler interleave them.
      lifted = plans.flatMap(p => p.loads).concat(plans.flatMap(p => p.body))
    } else if (WIDE16) {
      lifted = []
      const vv = []
      for (let j = 0; j < 4; j++) {
        const rt = freshV128('ramp')
        lifted.push(['local.set', rt, ramp(j * 4)])
        ctx.rampTemp = rt
        const v = liftExprV(wideValueExpr, ctx)
        if (ctx.fail) return null
        const vn = freshV128('rampv')
        lifted.push(['local.set', vn, v])
        vv.push(vn)
      }
      // Pack the low byte of all 16 i32 lanes (4 vectors) into one i8x16, in order.
      const g = (n) => ['local.get', n]
      const sh = (a, b, idx) => ['i8x16.shuffle', ...idx.map(String), a, b]
      const lo = freshV128('ramplo'), hi = freshV128('ramphi')
      lifted.push(['local.set', lo, sh(g(vv[0]), g(vv[1]), [0, 4, 8, 12, 16, 20, 24, 28, 0, 0, 0, 0, 0, 0, 0, 0])])
      lifted.push(['local.set', hi, sh(g(vv[2]), g(vv[3]), [0, 4, 8, 12, 16, 20, 24, 28, 0, 0, 0, 0, 0, 0, 0, 0])])
      lifted.push(['v128.store', storeAddr, sh(g(lo), g(hi), [0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23])])
    } else {
      ctx.rampTemp = freshV128('ramp')
      // ramp = [i, i+1, i+2, i+3], computed once per SIMD iteration.
      lifted = [['local.set', ctx.rampTemp, ramp(0)]]
      for (let i = 0; i < body.length; i++) {
        if (i === storeIdx) {
          const vval = liftExprV(storeStmt[2], ctx)
          if (ctx.fail) return null
          lifted.push(buildRampStore(storeOp, storeAddr, vval, ctx))
        } else {
          const r = liftStmt(body[i], ctx)
          if (ctx.fail) return null
          if (r != null) { if (Array.isArray(r) && r[0] === '__seq__') lifted.push(...r.slice(1)); else lifted.push(r) }
        }
      }
    }
  }
  if (!lifted || !lifted.length) return null

  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`
  const simdBrkLabel = `$__simd_brk${id}`
  const simdLoopLabel = `$__simd_loop${id}`
  const boundExpr = boundLocal ? ['local.get', boundLocal] : bound

  const scaledIncs = increments.map(({ name, c }) =>
    ['local.set', name, ['i32.add', ['local.get', name], ['i32.const', c * LANES]]])

  const simdBlock = ['block', simdBrkLabel,
    ['loop', simdLoopLabel,
      ['br_if', simdBrkLabel, ['i32.eqz', ['i32.lt_s', ['local.get', ivName], ['local.get', simdBoundName]]]],
      ...lifted,
      ...scaledIncs,
      ['br', simdLoopLabel]]]
  // span-aligned (same entry≠0 hazard as tryVectorize's bound — see there)
  const boundSetup = ['local.set', simdBoundName,
    ['i32.add', ['local.get', ivName],
      ['i32.and', ['i32.sub', boundExpr, ['local.get', ivName]], ['i32.const', -LANES]]]]
  const wrapper = ['block', boundSetup, simdBlock, blockNode]
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ...[...newLanedLocals.values()].map(laneName => ['local', laneName, 'v128']),
    ...extraLocals,
  ]
  return { wrapper, newLocalDecls }
}

// Build the store for a ramp-map iteration: i32x4 `vval` → element width of
// `storeOp` at scalar address `addr`. i32.store is the full vector; i32.store8
// truncates (low byte of each lane) via i8x16.shuffle — exactly matching scalar
// store8, with no value-range assumption (shuffle selects, never saturates).
// Narrowing-map store: pack a wider float lane vector `val` down to a narrower
// store element and write the low bytes (extract_lane 0 + scalar store, like
// buildRampStore). f64→f32 demotes (bit-exact vs scalar); f64→i32 truncates;
// f32→i16/i8 truncate to i32x4 then WRAP via i8x16.shuffle (low bytes = scalar
// store{8,16}, never saturates). Returns the store stmt or null (unsupported).
// Peel the scalar narrowing conversion off a store value, returning the inner float
// expr to lift (narrowStore then applies the SIMD narrow). f32 store: f32.demote_f64(X).
// int store: toI32's guarded select, wrapIntIR's ToIntN select (module/typedarray.js),
// or a bare trunc_sat. The inner X is the f64/f32 lane value computed before the cast.

function buildRampStore(storeOp, addr, vval, ctx) {
  if (storeOp === 'i32.store') return ['v128.store', addr, vval]   // 4 i32 lanes → 16 bytes
  // i32.store8: hoist vval to a temp so the shuffle reads it once; low byte of
  // each of 4 lanes → bytes 0..3 → one i32.store (4 bytes). Shuffle lane indices
  // are string tokens for watr's binary encoder.
  const tmp = `$__rampv${ctx.freshIdRef.next++}`
  ctx.extraLocals.push(['local', tmp, 'v128'])
  const g = ['local.get', tmp]
  const packed = ['i8x16.shuffle', ...[0, 4, 8, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].map(String), g, g]
  return ['block', ['local.set', tmp, vval], ['i32.store', addr, ['i32x4.extract_lane', 0, packed]]]
}

// Pivot-stride analysis for the multi-pixel lift. The lift reads 16 source bytes
// (4 RGBA pixels) with ONE v128.load at the address for output pixel `pivot`, so the
// 4 outputs are correct ONLY if consecutive output pixels read consecutive source
// pixels — the load address must advance by EXACTLY 4 bytes per pivot step. Build, in
// program order, each local's value-delta per unit-pivot increment (`pivot` → 1, every
// other local → its assigned expr's delta, unknown/outer locals → 0 = pivot-invariant).
// `delta(e)` returns that constant byte-delta, or null when the dependence is non-
// constant (e.g. x*k) or uses an op we don't model — both of which must bail.
// Index arithmetic is often f64-lowered (JS number `*`): `(yi*ww + x)` becomes
// `(f64(yi)*ww + f64(x)) |0` = trunc_sat with a NaN-guard `select`. We model those
// passthrough/arith ops too, so a runtime-dimension vblur (x carried through f64)
// analyses the same as a literal-dimension one (x in plain i32). The select is the
// `|0` coercion (value branch when the index is finite — always so for an integer
// array index); we take the value branch's delta. Multiplies need a compile-time
// constant factor on the pivot-bearing side (else the stride isn't constant).
