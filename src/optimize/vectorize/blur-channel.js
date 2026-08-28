import { walkAst } from '../../ast.js'
import { constNum, isI32Const, isLocalGet } from './addr-model.js'
import { isArr } from './node-utils.js'
import { readsVar } from './outer-scaffold.js'

// ---- Channel-reduction recognizer (RGBA box-filter accumulation) -----------
//
// The image-convolution hot shape: 4 adjacent-byte accumulators summed over a
// window, then divided + stored — `for k: sr+=src[p]; sg+=src[p+1]; …` (blur,
// box filters, separable convolutions). The 4 channels are 4 i32x4 lanes, the
// 4-byte load is one widening v128.load32_zero. We vectorize ONLY the inner
// accumulation (integer add → associative/exact → bit-identical) and extract the
// lane sums back to the scalars; the edge-clamp address math and the per-pixel
// divide+store stay scalar, untouched. So no float-reduction reordering, no
// lane-juggled divide — just the dense inner loop lifted, safely.
//
// Operates on the OUTER pixel-loop block: its body is [exit, 4×(acc=0), …setup,
// (block (loop INNER)), …uses-of-acc, inc, br]. INNER's body accumulates the 4
// channels off a shared base address.

// Match `(local.set $ACC (i32.add (local.get $ACC) (i32.load8_u ADDR)))` where
// ADDR is `(local.get $base)` or `(local.tee $base EXPR)` at byte offset `off`.
// Returns { acc, base, off, teeExpr? } or null.
function matchChannelAccum(stmt, off) {
  if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
  const acc = stmt[1]
  const add = stmt[2]
  if (!isArr(add) || add[0] !== 'i32.add' || add.length !== 3) return null
  if (!isLocalGet(add[1], acc)) return null
  const load = add[2]
  if (!isArr(load) || load[0] !== 'i32.load8_u') return null
  // memarg offset: bare load → off 0; `i32.load8_u offset=N addr` → off N.
  let addr = load[1], loadOff = 0
  if (typeof load[1] === 'string' && /^offset=/.test(load[1])) { loadOff = +load[1].slice(7); addr = load[2] }
  if (loadOff !== off) return null
  if (isArr(addr) && addr[0] === 'local.tee' && addr.length === 3) return { acc, base: addr[1], off, teeExpr: addr[2] }
  if (isLocalGet(addr)) return { acc, base: addr[1], off }
  return null
}

// Recognize, inside the inner loop body, four consecutive channel accumulations
// `acc0+=base[0]; acc1+=base[1]; acc2+=base[2]; acc3+=base[3]` over ONE shared
// base. Returns { accs:[a0..a3], baseLocal, teeExpr, idx } (idx = position of the
// first accum stmt in `body`) or null.
function matchChannelGroup(body) {
  for (let i = 0; i + 3 < body.length; i++) {
    const m0 = matchChannelAccum(body[i], 0)
    if (!m0 || m0.teeExpr == null) continue   // first load carries the address tee
    const ms = [m0]
    let ok = true
    for (let c = 1; c < 4; c++) {
      const m = matchChannelAccum(body[i + c], c)
      if (!m || m.base !== m0.base || m.teeExpr != null) { ok = false; break }
      ms.push(m)
    }
    if (!ok) continue
    const accs = ms.map(m => m.acc)
    if (new Set(accs).size !== 4) continue   // four distinct accumulators
    return { accs, baseLocal: m0.base, teeExpr: m0.teeExpr, idx: i }
  }
  return null
}

// Class-A hoist (.work/research.md §BodyModel §1a/§5 slice 3): the init+inner-loop-locate scan
// tryBlurMultiPixel and tryChannelReduce each ran over their pixel-loop body — locate four
// consecutive `acc_c = 0` inits, then the `(block (loop))` immediately after them, then the
// channel-accumulation group inside it via matchChannelGroup, then verify the summed
// accumulators are exactly the four zero-inited ones. Functionally identical between the two
// callers (tryChannelReduce's z-push carried one extra `typeof s[1] === 'string'` guard that's
// always true for a `local.set`'s name slot — dead, not a behavior difference; the shared version
// below keeps it, matching the codebase's prevailing name-narrowing convention). Returns
// `{ initIdx, accInits, innerIdx, innerBlock, innerLoop, ilEnd, innerBody, grp }` or `null`.
function matchChannelReducePixelLoop(loopNode, bodyStart, bodyEnd) {
  // four `acc_c = 0` inits, consecutive
  let initIdx = -1, accInits = null
  for (let i = bodyStart; i + 3 <= bodyEnd; i++) {
    const z = []
    for (let c = 0; c < 4; c++) {
      const s = loopNode[i + c]
      if (isArr(s) && s[0] === 'local.set' && s.length === 3 && isI32Const(s[2]) && constNum(s[2]) === 0 && typeof s[1] === 'string') z.push(s[1])
      else break
    }
    if (z.length === 4 && new Set(z).size === 4) { initIdx = i; accInits = z; break }
  }
  if (initIdx < 0) return null

  // the inner accumulation loop: the (block (loop)) appearing after the inits
  let innerIdx = -1, innerBlock = null
  for (let i = initIdx + 4; i <= bodyEnd; i++) {
    const s = loopNode[i]
    if (isArr(s) && s[0] === 'block' && s.slice(1).some(c => isArr(c) && c[0] === 'loop')) { innerIdx = i; innerBlock = s; break }
    if (isArr(s) && s[0] === 'loop') { innerIdx = i; innerBlock = ['block', s]; break }
  }
  if (!innerBlock) return null
  const innerLoop = innerBlock.find(c => isArr(c) && c[0] === 'loop')
  if (!innerLoop) return null
  const ilEnd = innerLoop.length - 1
  if (!(isArr(innerLoop[ilEnd]) && innerLoop[ilEnd][0] === 'br')) return null
  const innerBody = innerLoop.slice(3, ilEnd - 1)

  const grp = matchChannelGroup(innerBody)
  if (!grp) return null
  // the four channels summed must be exactly the four that were zero-inited (any order)
  if (grp.accs.slice().sort().join('\x00') !== accInits.slice().sort().join('\x00')) return null

  return { initIdx, accInits, innerIdx, innerBlock, innerLoop, ilEnd, innerBody, grp }
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
function buildPivotCoeff(loopNode, pivot) {
  const coeff = new Map([[pivot, 1]])
  const cval = (n) => isI32Const(n) ? constNum(n) : (isArr(n) && n[0] === 'f64.const' && n[1] != null ? Number(n[1]) : null)
  const delta = (e) => {
    if (isI32Const(e)) return 0
    if (isLocalGet(e)) return coeff.has(e[1]) ? coeff.get(e[1]) : 0
    if (!isArr(e)) return null
    const [op, a, b] = e
    switch (op) {
      case 'i32.add': case 'f64.add': { const x = delta(a), y = delta(b); return x == null || y == null ? null : x + y }
      case 'i32.sub': case 'f64.sub': { const x = delta(a), y = delta(b); return x == null || y == null ? null : x - y }
      case 'i32.shl': { const c = cval(b), x = delta(a); return c == null || x == null ? null : x << c }
      case 'i32.mul': case 'f64.mul': {
        const ca = cval(a), cb = cval(b), x = delta(a), y = delta(b)
        if (x == null || y == null) return null
        if (ca != null) return ca * y          // const × expr
        if (cb != null) return cb * x          // expr × const
        return x === 0 && y === 0 ? 0 : null    // var × var: pivot-dependent ⇒ non-constant
      }
      // value-preserving conversions: passthrough. `local.tee $v EXPR` yields EXPR.
      case 'f64.convert_i32_s': case 'f64.convert_i32_u': case 'i64.trunc_sat_f64_s':
      case 'i64.trunc_sat_f64_u': case 'i32.wrap_i64': case 'i64.extend_i32_s':
        return delta(a)
      case 'local.tee': return delta(b)
      // the `(expr)|0` NaN/Inf-guard `select(value, 0, finite?)`: take the value branch
      // (the index is a finite integer in any real blur). Only when the else-branch is
      // the const-0 guard — a general ternary index whose arms differ in stride bails.
      case 'select': return isI32Const(e[2]) && constNum(e[2]) === 0 ? delta(a) : null
      default: return null                     // any other op (and/or/div/…) ⇒ unanalyzable
    }
  }
  walkAst(loopNode, { enter: n => {
    if (isArr(n) && (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') coeff.set(n[1], delta(n[2]))
  } })
  return delta
}

// Vectorize the inner accumulation of an RGBA box-filter pixel loop. See the
// matchChannelGroup header. Returns { wrapper, newLocalDecls } or null.
// Multi-pixel SIMD lift of a clamp-free RGBA box-filter interior (produced by the
// clamp-peel pass). Processes 4 output pixels per iteration: at tap k the 4 outputs
// read 4 CONSECUTIVE source pixels — one 16-byte v128.load whose lanes map DIRECTLY
// to the 4 accumulators (no shuffle). Sums (≤ win·255 < 2^16) accumulate in two
// i16x8 vectors; the divide+store reuses the scalar store templates per pixel.
// Validated bit-exact + 4.34× vs scalar. Bails (→ tryChannelReduce 1-pixel lift)
// unless the body is exactly: clamp-free `xi=x+k; p=(row+xi)<<2; acc_c += u8[base+c]`
// over a unit-stride x, then a 4-byte RGBA store `dst[ab1+c] = f(acc_c)`. r≥127 →
// i16 overflow → bail. Leaves a scalar remainder loop for the ≤3 trailing pixels.
// 4px/step tier of the unified CHANNEL-REDUCE recognizer (see `tryChannelReduce` below,
// the dispatch entry). Takes the ALREADY-COMPUTED `scan` (matchChannelReducePixelLoop),
// shared with the 1px/step tier (`tryChannelReduce1px`) so the dispatch entry runs the
// scan exactly once instead of each tier separately re-deriving it on a blur-tier bail
// (design §2 "CHANNEL-REDUCE … nearly free" merge).

function tryBlurMultiPixel(blockNode, fnLocals, freshIdRef, bl, scan) {
  // Loose-envelope scaffold, matched once at the dispatch (LoopPlan). The exit
  // guard below accepts NO label check and lt_s only (not lt_u), a strictly
  // narrower shape than matchExitBrIf, so it stays this recognizer's own
  // residual rather than folding into the shared scaffold.
  const { loopNode, endIdx } = bl
  // exit guard: br_if $brk (i32.eqz (i32.lt_s x BOUND))
  const exit = loopNode[2]
  if (!(isArr(exit) && exit[0] === 'br_if' && isArr(exit[2]) && exit[2][0] === 'i32.eqz'
    && isArr(exit[2][1]) && exit[2][1][0] === 'i32.lt_s' && isLocalGet(exit[2][1][1]))) return null
  const pivot = exit[2][1][1][1]          // pixel IV $x
  const bound = exit[2][1][2]              // interior bound (expr)
  const bodyEnd = endIdx - 1
  // increment must be `x = x + 1`
  const inc = loopNode[bodyEnd]
  if (!(isArr(inc) && inc[0] === 'local.set' && inc[1] === pivot && isArr(inc[2]) && inc[2][0] === 'i32.add'
    && isLocalGet(inc[2][1], pivot) && isI32Const(inc[2][2]) && constNum(inc[2][2]) === 1)) return null

  const { initIdx, accInits, innerIdx, innerBlock, innerLoop, ilEnd, innerBody, grp } = scan
  // CLAMP-FREE: nothing before the channel group may be an `if` (the edge clamp).
  for (let i = 0; i < grp.idx; i++) if (isArr(innerBody[i]) && innerBody[i][0] === 'if') return null
  // The tap loop must be the i32 form `k <= r`; extract the radius r (reused in the
  // runtime overflow guard below). f64-typed tap loops (f64 dims) bail to scalar.
  const ic = innerLoop[2]
  if (!(isArr(ic) && ic[0] === 'br_if' && isArr(ic[2]) && ic[2][0] === 'i32.eqz'
    && isArr(ic[2][1]) && ic[2][1][0] === 'i32.le_s' && isLocalGet(ic[2][1][1]))) return null
  const rBound = ic[2][1][2]
  if (!(isLocalGet(rBound) || isI32Const(rBound))) return null

  // the RGBA store: 4 i32.store8 at `ab1 + c`, ab1 tee'd in the first. jz's raw pre-watr
  // emission of `dst[o]=(sr/win)|0` materializes the divide into its own single-use temp
  // (`tw = sr/win; store(tw)`) — pre-watr propagateSingleUse runs AFTER the vectorizer
  // (ordered there so it doesn't scramble the dot-pair matcher), so this indirection is
  // never folded before this recognizer sees it, unlike the old post-watr pipeline where
  // watr's own copy-prop had already inlined it into the store operand. Resolve that one-hop
  // indirection here: if a store's value is a bare local.get and the statement immediately
  // before it is that local's SOLE def in the loop, substitute the def's RHS.
  const resolvedTemps = new Set()
  const resolveStoreVal = (idx, val) => {
    if (!(isArr(val) && val[0] === 'local.get')) return val
    const t = val[1], prev = loopNode[idx - 1]
    if (!(isArr(prev) && prev[0] === 'local.set' && prev.length === 3 && prev[1] === t)) return val
    let uses = 0
    walkAst(loopNode, { enter: n => { if (n[0] === 'local.get' && n[1] === t) uses++ } })
    if (uses !== 1) return val
    resolvedTemps.add(t)
    return prev[2]
  }
  let storeIdx = -1
  for (let i = innerIdx + 1; i + 3 <= bodyEnd; i++) {
    const s0 = loopNode[i]
    if (isArr(s0) && s0[0] === 'i32.store8' && s0.length === 3 && isArr(s0[1]) && s0[1][0] === 'local.tee') { storeIdx = i; break }
  }
  if (storeIdx < 0) return null
  const s0 = loopNode[storeIdx]
  const ab1 = s0[1][1], dstExpr = s0[1][2]      // ab1 local, its address expr
  const storeVals = [resolveStoreVal(storeIdx, s0[2])]
  let scanIdx = storeIdx + 1
  for (let c = 1; c < 4; c++) {
    if (isArr(loopNode[scanIdx]) && loopNode[scanIdx][0] === 'local.set') scanIdx++   // skip the next store's div-into-temp
    const s = loopNode[scanIdx]
    if (!(isArr(s) && s[0] === 'i32.store8' && s[1] === `offset=${c}` && isLocalGet(s[2], ab1))) return null
    storeVals.push(resolveStoreVal(scanIdx, s[3]))
    scanIdx++
  }
  // each store value must read its accumulator (the divided sum)
  for (let c = 0; c < 4; c++) if (!readsVar(storeVals[c], accInits[c])) return null

  // ── Soundness guards for the 4-pixels-per-load lift ──────────────────────────
  // Scope the stride analysis to THIS pixel loop. A peeled interior is one segment ⇒
  // one inner tap loop, so there is no sibling same-named-`p` ambiguity, and the scope
  // still captures the LICM preamble where the x-dependent index term is hoisted out of
  // the tap loop (e.g. `__li = f64(x)` — x is invariant w.r.t. the tap IV k).
  const pivotDelta = buildPivotCoeff(loopNode, pivot)
  // (a) Source unit-stride: the v128.load address (array base + byte index) must
  // advance by exactly 4 bytes (one RGBA pixel) per output-pixel step, else the
  // 16-byte load spans the wrong source pixels. Bails on strided indices
  // ((xi*2+row)<<2) and non-constant ones ((yi*W + x + k*x)<<2 → x*(1+k)).
  if (pivotDelta(grp.teeExpr) !== 4) return null
  // (b) No dropped pivot-dependent setup: statements before the inits (loopNode[3..
  // initIdx)) are NOT carried into the 4-pixel loop, so a per-pixel value computed
  // there (e.g. `x2 = x*2`) would go stale. Bail if any such statement is pivot-
  // dependent. (Statements between the inits and the inner loop ARE carried.)
  for (let i = 3; i < initIdx; i++) {
    let bad = false
    walkAst(loopNode[i], { enter: n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string' && pivotDelta(n[2]) !== 0) bad = true } })
    if (bad) return null
  }
  // (c) Store values must read only the accumulators (set per-pixel by the epilogue)
  // and pivot-invariants — never a per-pixel local like the pivot itself, since the
  // store template is reused verbatim for all 4 pixels (`dst[o]=(sr+x)&255` would use
  // the group-base x for pixels 1-3).
  const perPixel = new Set()
  walkAst(loopNode, { enter: n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') perPixel.add(n[1]) } })
  for (const a of grp.accs) perPixel.delete(a)   // accumulators are repopulated per pixel
  const readsPerPixel = (root) => {
    let found = false
    walkAst(root, { enter: n => { if (found) return false; if (n[0] === 'local.get' && perPixel.has(n[1])) { found = true; return false } } })
    return found
  }
  for (let c = 0; c < 4; c++) if (readsPerPixel(storeVals[c])) return null

  // ── Lift ───────────────────────────────────────────────────────────────────
  const id = freshIdRef.next++
  const accLo = `$__bmplo${id}`, accHi = `$__bmphi${id}`, b4 = `$__bmpb${id}`
  const newLocalDecls = [['local', accLo, 'v128'], ['local', accHi, 'v128'], ['local', b4, 'i32']]
  const Z = ['v128.const', 'i64x2', '0', '0']
  // inner body: 4 channel adds → 2 i16 widening adds off the same tee'd base.
  const newInner = []
  for (let i = 0; i < innerBody.length; i++) {
    if (i === grp.idx) {
      newInner.push(['local.set', accLo, ['i16x8.add', ['local.get', accLo], ['i16x8.extend_low_i8x16_u', ['v128.load', ['local.tee', grp.baseLocal, grp.teeExpr]]]]])
      newInner.push(['local.set', accHi, ['i16x8.add', ['local.get', accHi], ['i16x8.extend_high_i8x16_u', ['v128.load', ['local.get', grp.baseLocal]]]]])
    } else if (i > grp.idx && i <= grp.idx + 3) continue
    else newInner.push(innerBody[i])
  }
  const newInnerLoop = [...innerLoop.slice(0, 3), ...newInner, ...innerLoop.slice(ilEnd - 1)]
  const newInnerBlock = innerBlock.map(c => c === innerLoop ? newInnerLoop : c)
  // store epilogue: the o=(row+x)<<2 setup, then ab1, then per pixel j set acc_c to
  // its lane and reuse the scalar store template at byte offset j*4+c.
  // `o = (row+x)<<2` etc. — drop resolved-away div-into-temp defs (unused now; storeVals
  // carries their RHS directly), else a dead `tw15 = sr/win` reading a stale `sr` gets
  // carried into the 4-pixel loop (harmless — unused — but unnecessary bytes/work).
  const preStore = loopNode.slice(innerIdx + 1, storeIdx).filter(s => !(isArr(s) && s[0] === 'local.set' && resolvedTemps.has(s[1])))
  const epilogue = [...preStore, ['local.set', ab1, dstExpr]]
  for (let j = 0; j < 4; j++) {
    const vec = j < 2 ? accLo : accHi, base = (j % 2) * 4
    // lane base+c summed source byte at offset c → grp.accs[c] (the accumulator
    // tied to read-offset c), NOT accInits[c] (zero-init order); see tryChannelReduce.
    for (let c = 0; c < 4; c++) epilogue.push(['local.set', grp.accs[c], ['i16x8.extract_lane_u', String(base + c), ['local.get', vec]]])
    for (let c = 0; c < 4; c++) epilogue.push(['i32.store8', `offset=${j * 4 + c}`, ['local.get', ab1], storeVals[c]])
  }
  // 4-pixel loop body: splat inits, the tap-IV init, the lifted inner loop, the
  // lifted store, x += 4.
  const v4label = `$__bmpx${id}`, v4brk = `$__bmpe${id}`
  const fourBody = [
    ['br_if', v4brk, ['i32.eqz', ['i32.lt_s', ['local.get', pivot], ['local.get', b4]]]],
    ['local.set', accLo, Z], ['local.set', accHi, Z],
    ...loopNode.slice(initIdx + 4, innerIdx),
    newInnerBlock,
    ...epilogue,
    ['local.set', pivot, ['i32.add', ['local.get', pivot], ['i32.const', 4]]],
    ['br', v4label],
  ]
  // Deep-clone the 4-pixel loop: it reuses sub-trees (inner body, store templates,
  // dst expr) that also live in the scalar remainder below — sharing would let a
  // later pass mutating one corrupt the other.
  const dc = (n) => isArr(n) ? n.map(dc) : n
  const fourLoop = dc(['block', v4brk, ['loop', v4label, ...fourBody]])
  // b4 = x + (r<128 ? ((bound-x) & ~3) : 0): the 4-aligned end of the interior from
  // the entry x. The r<128 guard is the i16-overflow check (win·255 < 2^16 ⇔ r<128);
  // when r≥128 the 4-pixel loop runs zero iterations and the scalar remainder covers
  // the whole interior — sound for any runtime r, no duplicated loop body.
  const b4set = ['local.set', b4, ['i32.add', ['local.get', pivot],
    ['select', ['i32.and', ['i32.sub', dc(bound), ['local.get', pivot]], ['i32.const', -4]], ['i32.const', 0],
      ['i32.lt_s', dc(rBound), ['i32.const', 128]]]]]
  // The interior block may carry a LICM-hoisted invariant preamble (e.g. `k=-r`'s
  // value) that the lifted body reads but which the original sets only on block
  // entry — run a clone of it first so the 4-pixel loop sees it. Then b4 setup, the
  // 4-pixel loop, then the ORIGINAL block unchanged (the ≤3-pixel scalar remainder;
  // x continues from b4).
  const loopPos = blockNode.indexOf(loopNode)
  const preamble = blockNode.slice(2, loopPos).map(dc)
  const wrapper = ['block', ...preamble, b4set, fourLoop, blockNode]
  return { wrapper, newLocalDecls }
}

// 1px/step tier of the unified CHANNEL-REDUCE recognizer (see `tryChannelReduce` below,
// the dispatch entry) — the fallback of `tryBlurMultiPixel`'s 4px/step tier. Takes the
// ALREADY-COMPUTED `scan` (matchChannelReducePixelLoop), shared with the 4px tier.
// Loose envelope: LICM may hoist an invariant edge-clamp bound ahead of the loop when
// this pixel loop nests in an outer row loop; preserved verbatim by the wrapper rebuild.
// Unlike tryBlurMultiPixel this never validates the exit/inc shape — it trusts
// `bodyStart..bodyEnd` as the body outright. Loose scaffold from the dispatch.
function tryChannelReduce1px(blockNode, fnLocals, freshIdRef, bl, scan) {
  const { loopNode } = bl
  const { initIdx, innerIdx, innerBlock, innerLoop, ilEnd, innerBody, grp } = scan

  // ── Lift. accv (v128) holds the four channel sums.
  const id = freshIdRef.next++
  const accv = `$__chv${id}`
  const newLocalDecls = [['local', accv, 'v128']]
  // Zero-init → one splat.
  const zeroInit = ['local.set', accv, ['v128.const', 'i32x4', '0', '0', '0', '0']]
  // Inner accumulation: keep the address-producing stmts, replace the 4 channel
  // adds with one widening add off the shared base. The base address is the
  // tee'd expr of the first load (re-tee'd so any later `local.get base` still
  // resolves — though the other channel loads are gone).
  const widen = ['i32x4.extend_low_i16x8_u', ['i16x8.extend_low_i8x16_u',
    ['v128.load32_zero', ['local.tee', grp.baseLocal, grp.teeExpr]]]]
  const newInner = []
  for (let i = 0; i < innerBody.length; i++) {
    if (i === grp.idx) newInner.push(['local.set', accv, ['i32x4.add', ['local.get', accv], widen]])
    else if (i > grp.idx && i <= grp.idx + 3) continue   // drop the other 3 channel adds
    else newInner.push(innerBody[i])
  }
  // Rebuild the inner loop with the lifted body.
  const newInnerLoop = [...innerLoop.slice(0, 3), ...newInner, ...innerLoop.slice(ilEnd - 1)]
  const newInnerBlock = innerBlock.map(c => c === innerLoop ? newInnerLoop : c)
  // After the inner loop, extract the four lane sums back to the scalar
  // accumulators the divide+store code reads. Lane c summed source byte
  // `base+c`, so it must land in grp.accs[c] — the accumulator matchChannelGroup
  // tied to read-offset c — NOT accInits[c] (zero-init order). They coincide only
  // when the program inits/sums in offset order (every real blur); a channel-
  // permuted program (sums offset 0 into a var stored at a later offset) needs the
  // offset-order mapping or the lanes mis-map.
  const extracts = grp.accs.map((acc, c) => ['local.set', acc, ['i32x4.extract_lane', c, ['local.get', accv]]])

  // Reassemble the pixel-loop body: replace the 4 inits with the splat, the inner
  // block with the lifted one, and insert the extracts right after it.
  const newLoop = [...loopNode]
  newLoop.splice(innerIdx, 1, newInnerBlock, ...extracts)   // inner block → lifted + extracts
  newLoop.splice(initIdx, 4, zeroInit)                       // 4 inits → 1 splat (do last; lower index)
  const wrapper = blockNode.map(c => c === loopNode ? newLoop : c)
  return { wrapper, newLocalDecls }
}

// ---- Unified CHANNEL-REDUCE recognizer (dispatch entry) ---------------------
//
// One recognizer, two codegen tiers (design §2 "CHANNEL-REDUCE (#13-14) → 1 general
// recognizer … nearly free" — tryBlurMultiPixel's own doc already called itself "the
// fast tier of tryChannelReduce", bailing to it on any deviation). The ONE shared
// structural scan (matchChannelReducePixelLoop) runs ONCE here instead of each tier
// separately re-deriving it on a blur-tier bail (today's redundant double-scan when
// blurMP's own later guards — clamp-free interior, tap-loop shape, RGBA store match —
// fail after the scan already succeeded). Same dispatch order as before the merge
// (`(blurMP ? tryBlurMultiPixel(...) : null) ?? tryChannelReduce(...)`), so behavior
// is unchanged by construction — pure entry-point + shared-scan consolidation.
export function tryChannelReduce(blockNode, fnLocals, freshIdRef, bl, blurMP) {
  if (!bl) return null
  const { loopNode, endIdx } = bl
  const bodyStart = 3, bodyEnd = endIdx - 1   // [exit] at 2, [inc?][br] at the end
  const scan = matchChannelReducePixelLoop(loopNode, bodyStart, bodyEnd)
  if (!scan) return null
  if (blurMP) {
    const r = tryBlurMultiPixel(blockNode, fnLocals, freshIdRef, bl, scan)
    if (r) return r
  }
  return tryChannelReduce1px(blockNode, fnLocals, freshIdRef, bl, scan)
}
