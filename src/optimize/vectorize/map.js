import { nodeEqual as exprEq, cloneNode, walkAst } from '../../ast.js'
import { _isAddressLocal, _isPixelIndexLocal, _offsetLocalStride, firstAccess, hasGlobalSet, isI32Const, isLocalGet, matchConstMulIV, matchLaneAddr, matchLaneOffset, matchMirrorAddr } from './addr-model.js'
import { ALIAS_VERSION_MAX_BODY_NODES, gmNodeCount, isProfitable } from './cost-model.js'
import { normTee } from './idioms.js'
import { INT_WIDEN_F32, LANE_INFO, LOAD_OPS, STORE_OPS } from './lane-tables.js'
import { liftFail, liftStmt, peelNarrowConv } from './lift.js'
import { isArr } from './node-utils.js'

/**
 * Try to vectorize the inner loop. Returns the replacement node array
 * (synthetic outer block) or null on no match.
 */
export function tryVectorize(bl, fnLocals, freshIdRef, pureFuncMap, constLocals) {
  // Consumes the shared scaffold descriptor (matchBlockLoop, computed once by the
  // dispatch). The LICM `$__li` preamble is cloned ahead of the SIMD block; each
  // set is pure & loop-invariant, so the kept scalar tail harmlessly re-runs it.
  if (!bl) return null
  const { incVar, bound, boundLocal, body, preamble, hasGlobalSet: blHasGlobalSet, writes: blWrites, referenced: blReferenced } = bl

  // Bound must be loop-invariant: (local.get $L) or (i32.const N).
  if (!boundLocal && !isI32Const(bound)) return null

  // Detect lane type from the FIRST load in body.
  let laneType = null
  let stride = -1
  const loadStoreSites = []  // {parent, idx, kind:'load'|'store'}
  // Address tees: name → {strideLog2, base}. A `(local.tee NAME (lane-addr))`
  // both validates the load's address AND records NAME so the matching store's
  // `(local.get NAME)` is accepted as the same lane address.
  const addrLocals = new Map()
  // Offset tees: name → strideLog2. A CSE'd `i << K` shared across base
  // pointers (map loops over distinct arrays). Soundness re-checked post-scan.
  const offsetTees = new Map()
  // AoS (array-of-structs) de-interleave: this recognizer alone accepts a pixel-stride
  // access `base[P*i + c]` (interleaved RGB/vec3/complex). allowAos enables it in every
  // shared matcher; aosPix carries P for a CSE'd offset tee; aosPixelStride is the loop's
  // single P (1 = plain stride-1, unchanged). Set once, verified equal across all sites.
  const allowAos = true
  const aosPix = new Map()
  let aosPixelStride = 1
  const mirrorSites = []   // mirror stores a[INV−iv] — invariance of INV checked post-scan
  // Pixel-INDEX locals: `$J = P*i` (the `const j = 3*i` of an AoS loop, kept as its own local
  // pre-watr). A channel address is then `base + ((local.get $J) << K)`; idxTees lets
  // matchLaneOffset resolve $J → pixel-stride P. Value -1 marks an inconsistent local (bail).
  const idxTees = new Map()
  {
    const recordIndex = n => {
      if (!isArr(n) || (n[0] !== 'local.set' && n[0] !== 'local.tee') || typeof n[1] !== 'string' || n.length !== 3) return
      const p = matchConstMulIV(n[2], incVar)
      if (p != null) idxTees.set(n[1], idxTees.has(n[1]) && idxTees.get(n[1]) !== p ? -1 : p)
    }
    for (const s of body) walkAst(s, { enter: recordIndex })
  }

  // The compute/lane type is the WIDEST FLOAT among all loads+stores. A narrower
  // float/int LOAD is then a widening read (INT_WIDEN_F32 / f32→f64), a narrower
  // float/int STORE a narrowing write (demote / trunc+wrap) — both sub-width memory
  // ops around the float lane. Pinning it up front (vs whichever op the recursive
  // scan hits first) is what lets a narrowing map `i16[i] = f32arr[i]*k` keep the
  // f32 compute lane instead of locking onto the i16 store. No float → integer lane
  // (set by the scan below, unchanged).
  const isNarrowStore = (lane, sty) => (lane === 'f32' && (sty === 'i16' || sty === 'i8'))
    || (lane === 'f64' && (sty === 'f32' || sty === 'i32'))
  let preFloat = null
  const recordFloatWidth = n => {
    if (!isArr(n)) return
    const t = LOAD_OPS[n[0]] || STORE_OPS[n[0]]
    if (t === 'f64') preFloat = 'f64'
    else if (t === 'f32' && preFloat == null) preFloat = 'f32'
  }
  for (const s of body) walkAst(s, { enter: recordFloatWidth })
  if (preFloat) { laneType = preFloat; stride = LANE_INFO[preFloat].stride }

  // Record a memory site's pixel stride. An AoS stride (P>1) is f64-lane only (the gather/scatter
  // lifts 2 f64 lanes). Strides are collected for the post-scan uniformity gate: EVERY site must
  // share one stride, else the loop mixes stride-1 and stride-P accesses (e.g. AoS-struct loads
  // feeding stride-1 array stores) and a single gather/scatter delta would corrupt the odd sites.
  const siteStrides = []
  const recordAos = (m) => {
    const ps = m.pixelStride || 1
    if (ps > 1) {
      if (laneType !== 'f64') return false
      if (aosPixelStride === 1) aosPixelStride = ps
      if (m.offsetTeeName) aosPix.set(m.offsetTeeName, ps)
    }
    siteStrides.push(ps)
    return true
  }
  // The real address is node[1], unless a folded `offset=N` memarg precedes it (node[1] is the
  // string `offset=N`, node[2] the address) — the AoS channels `d[j+1]`,`d[j+2]` and stencil
  // neighbours arrive this way.
  const memAddr = (node) => (typeof node[1] === 'string' && node[1].startsWith('offset=')) ? node[2] : node[1]

  function scanForLoadsStores(node, parent, pi) {
    if (!isArr(node)) return true
    const op = node[0]
    if (LOAD_OPS[op]) {
      const lt = LOAD_OPS[op]
      // int→f32 widening map (`out[i] = intArr[i] (*k)`): an integer load feeding a
      // Float32Array store. Accept under the f32 lane and validate at the int element
      // stride (the loop steps `lanes` f32 = 4 elements; load64_zero/load32_zero read
      // exactly 4 ints). liftExprV widens via INT_WIDEN_F32.
      const widenInt = laneType === 'f32' && lt !== 'f32' && INT_WIDEN_F32[op]
      if (laneType == null) {
        laneType = lt
        stride = LANE_INFO[laneType].stride
      } else if (lt !== laneType && !widenInt) {
        return false
      }
      const m = matchLaneAddr(memAddr(node), incVar, addrLocals, offsetTees, allowAos, aosPix, idxTees)
      if (!m) return false
      if ((1 << m.strideLog2) !== (widenInt ? LANE_INFO[lt].stride : stride)) return false
      if (!recordAos(m)) return false
      if (m.teeName) addrLocals.set(m.teeName, { strideLog2: m.strideLog2, pixelStride: m.pixelStride, base: m.base })
      if (m.offsetTeeName) offsetTees.set(m.offsetTeeName, m.strideLog2)
      loadStoreSites.push({ parent, idx: pi, kind: 'load' })
      return true
    }
    if (STORE_OPS[op]) {
      const sty = STORE_OPS[op]
      // narrowing store: a narrower element under a wider float lane (`o[i]=narrow(f(x))`,
      // codec encode / downsample). Validate the store address at the narrow element stride
      // (the loop steps `lanes` of the float lane; the partial store writes that many).
      const narrowing = laneType != null && sty !== laneType && isNarrowStore(laneType, sty)
      if (laneType != null && sty !== laneType && !narrowing) return false
      if (laneType == null) { laneType = sty; stride = LANE_INFO[laneType].stride }
      const memarg = typeof node[1] === 'string' && node[1].startsWith('offset=')
      let m = matchLaneAddr(memAddr(node), incVar, addrLocals, offsetTees, allowAos, aosPix, idxTees)
      if (!m) {
        // mirror store `a[INV − iv] = lane` (f64, full-width, no memarg): the
        // descending twin — accepted as its own site class; INV invariance is
        // verified post-scan against the body writes set.
        const mm = !memarg && sty === 'f64' && laneType === 'f64' && matchMirrorAddr(memAddr(node), incVar)
        if (mm && (1 << mm.strideLog2) === stride) {
          mirrorSites.push(mm)
          siteStrides.push(1)
          loadStoreSites.push({ parent, idx: pi, kind: 'store' })
          return scanForLoadsStores(node[2], node, 2)
        }
        return false
      }
      if ((1 << m.strideLog2) !== (narrowing ? LANE_INFO[sty].stride : stride)) return false
      if (!recordAos(m)) return false
      if (m.teeName) addrLocals.set(m.teeName, { strideLog2: m.strideLog2, pixelStride: m.pixelStride, base: m.base })
      if (m.offsetTeeName) offsetTees.set(m.offsetTeeName, m.strideLog2)
      loadStoreSites.push({ parent, idx: pi, kind: 'store' })
      // Recurse into VALUE child (idx 2, or 3 past an offset= memarg) — it's data, not address.
      const valIdx = memarg ? 3 : 2
      if (!scanForLoadsStores(node[valIdx], node, valIdx)) return false
      return true
    }
    // local.set/tee of an address local outside a load/store context (e.g.
    // `(local.set $a (i32.add base (i32.shl i 2)))` as a standalone stmt) —
    // record so a later `(local.get $a)` resolves.
    if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string' && node.length === 3) {
      const valM = matchLaneAddr(['local.tee', node[1], node[2]], incVar, addrLocals, offsetTees, allowAos, aosPix, idxTees)
      if (valM && valM.teeName) {
        addrLocals.set(valM.teeName, { strideLog2: valM.strideLog2, pixelStride: valM.pixelStride, base: valM.base })
      }
      // Standalone offset compute: `(local.set $t (i32.shl i K))` (or AoS `(i32.shl (mul P i) K)`).
      const offM = matchLaneOffset(node[2], incVar, offsetTees, allowAos, aosPix, idxTees)
      if (offM) { offsetTees.set(node[1], offM.strideLog2); if (offM.pixelStride > 1) aosPix.set(node[1], offM.pixelStride) }
    }
    // Recurse into all children
    for (let i = 1; i < node.length; i++) {
      if (!scanForLoadsStores(node[i], node, i)) return false
    }
    return true
  }
  for (const stmt of body) {
    if (!scanForLoadsStores(stmt, null, -1)) return null
  }
  if (blHasGlobalSet) return null  // a global write breaks the "global.get is invariant" splat
  if (!laneType) return null  // no memory ops — vectorizing buys nothing
  if (loadStoreSites.length === 0) return null
  // Uniform stride gate: an AoS loop must have EVERY load/store at the same pixel stride. A mix of
  // stride-1 and stride-P sites can't share one lift stride — bail (stays scalar, always correct).
  if (aosPixelStride > 1 && siteStrides.some(s => s !== aosPixelStride)) return null

  // Soundness gate for offset-tee resolution: every `(local.get $T)` we
  // accepted as `i << K` is only valid if EVERY write of $T is that offset.
  for (const [name, k] of offsetTees) {
    if (_offsetLocalStride(body, name, incVar, allowAos, idxTees) !== k) return null
  }

  // Classify all locals referenced in body.
  // - induction var (incVar): exempt
  // - bound local (if any): must be invariant
  // - each other local: first access must not be a read-then-written pattern
  const writes = blWrites
  if (boundLocal && writes.has(boundLocal)) return null  // bound varies in body → bail
  // a mirror INV written in the body is not invariant — the descending window would drift
  for (const mm of mirrorSites) if (mm.invName && writes.has(mm.invName)) return null
  // AoS gather/scatter and mirror windows don't compose (distinct per-step deltas)
  if (mirrorSites.length && aosPixelStride > 1) return null

  const localKind = new Map()  // name → 'lane' | 'invariant' | 'addr'
  // Plan-level referenced-names census (bl.referenced) — every locally-touched name.
  const referenced = blReferenced

  for (const name of referenced) {
    if (name === incVar) continue
    if (writes.has(name)) {
      // Must be lane-local: first access is a write.
      let firstKind = null
      for (const s of body) {
        const k = firstAccess(s, name)
        if (k) { firstKind = k; break }
      }
      if (firstKind === 'read') return null  // loop-carried (reduction or stencil)
      // Discriminate lane-data vs address-tee. Address tees hold i32 addresses,
      // not vector data. We classify by checking the local's declared type.
      const decl = fnLocals.get(name)
      if (decl === 'i32' && (addrLocals.has(name) || offsetTees.has(name) || _isAddressLocal(body, name, incVar) || _isPixelIndexLocal(body, name, incVar))) {
        localKind.set(name, 'addr')
      } else {
        localKind.set(name, 'lane')
      }
    } else {
      localKind.set(name, 'invariant')
    }
  }

  // A ToInt32 (`|0`) narrowing conversion is commonly CSE'd into its own lane-local just before
  // the store (`set $t (…trunc_sat…); store addr (local.get $t)`), hiding it from the
  // narrowing-store path (liftStmt would then lift the i32 wrap in the f64 lane and bail). When
  // such a lane-local is read exactly once by a narrowing store, inline the conversion back into
  // the store so peelNarrowConv/narrowStore handle it. The original set survives in the scalar
  // remainder; this only reshapes the SIMD lift (and bails cleanly if liftStmt still declines).
  let body2 = body
  {
    const getCount = new Map()
    const countGets = n => { if (n[0] === 'local.get' && typeof n[1] === 'string') getCount.set(n[1], (getCount.get(n[1]) || 0) + 1) }
    for (const s of body) walkAst(s, { enter: countGets })
    const dropped = new Set()
    const inlined = body.map(s => {
      if (isArr(s) && STORE_OPS[s[0]] && s.length === 3 && STORE_OPS[s[0]] !== laneType &&
          isLocalGet(s[2]) && localKind.get(s[2][1]) === 'lane' && getCount.get(s[2][1]) === 1) {
        const def = body.find(x => isArr(x) && x[0] === 'local.set' && x[1] === s[2][1] && x.length === 3)
        if (def && peelNarrowConv(def[2], STORE_OPS[s[0]])) { dropped.add(def); return [s[0], s[1], def[2]] }
      }
      return s
    })
    if (dropped.size) body2 = inlined.filter(s => !dropped.has(s))
  }

  // The SAME CSE hides an i32 add/sub's own operand from the arithmetic-recovery lift
  // (liftAddSubOfConverts, below): `a[i]+b[i]` into a same-type Int32Array store can't prove
  // i32.add's native fast path, so jz computes it in f64 and ToIntN-wraps it back via wrapIntIR
  // — but sinks the f64.add/sub into its own lane-local first (wrapIntIR's own doc: its argument
  // must be a pre-temped, re-evaluable node), so the store's canon reads a bare `$t` at each of
  // its 4 probe sites instead of carrying the add/sub inline. Unlike the narrowing case above
  // (sty≠laneType, one read), this is a SAME-type store (sty===laneType) reading `$t` up to 4
  // times — generalize: when `$t`'s only def is `f64.add/sub(convert,convert)` and EVERY read of
  // `$t` in the whole body is inside this one store, splice the def back in at every occurrence
  // and drop the separate local.set (dead once inlined).
  if (laneType === 'i32') {
    const setDefs = new Map()
    for (const s of body2) {
      if (isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3)
        setDefs.set(s[1], setDefs.has(s[1]) ? null : s)   // a second def disqualifies (not single-assign)
    }
    const getCount3 = new Map()
    const countGets3 = n => { if (n[0] === 'local.get' && typeof n[1] === 'string') getCount3.set(n[1], (getCount3.get(n[1]) || 0) + 1) }
    for (const s of body2) walkAst(s, { enter: countGets3 })
    const isAddSubOfConverts = (v) => {
      if (!isArr(v) || (v[0] !== 'f64.add' && v[0] !== 'f64.sub') || v.length !== 3) return false
      const isConv = (n) => isArr(n) && (n[0] === 'f64.convert_i32_s' || n[0] === 'f64.convert_i32_u') && n.length === 2
      return isConv(v[1]) && isConv(v[2])
    }
    const substAll = (n, nm, val) => {
      if (!isArr(n)) return n
      if (n[0] === 'local.get' && n[1] === nm) return cloneNode(val)
      return n.map(x => substAll(x, nm, val))
    }
    const dropped3 = new Set()
    body2 = body2.map(s => {
      if (!(isArr(s) && STORE_OPS[s[0]] && STORE_OPS[s[0]] === laneType && s.length === 3)) return s
      const names = new Set()
      walkAst(s[2], { enter: n => { if (n[0] === 'local.get' && typeof n[1] === 'string') names.add(n[1]) } })
      let val = s[2], changed = false
      for (const nm of names) {
        if (localKind.get(nm) !== 'lane') continue
        const def = setDefs.get(nm)
        if (!def || !isAddSubOfConverts(def[2])) continue
        let inStore = 0
        walkAst(val, { enter: n => { if (n[0] === 'local.get' && n[1] === nm) inStore++ } })
        if (inStore !== getCount3.get(nm)) continue   // read outside this store too — not safe to drop
        val = substAll(val, nm, def[2])
        dropped3.add(def)
        changed = true
      }
      return changed ? [s[0], s[1], val] : s
    })
    if (dropped3.size) body2 = body2.filter(s => !dropped3.has(s))
  }

  // A signum ternary (`a<0?-1:1`) is commonly CSE'd into its own lane-local just before its
  // sole use (`set $s (select (i32.const -1)(i32.const 1) COND); … f64.convert_i32_s($s) …`),
  // hiding it from liftExprV's `f64.convert_i32_s(select …)` fusion (below), which only matches
  // the select INLINE. Post-watr this local hop would already be copy-propagated away; pre-watr
  // it survives. When such a lane-local is read exactly once, and that read is inside a
  // `f64.convert_i32_s`, inline the select back — same "sink a single-use def into its sole
  // specialized consumer" trick as the narrowing-store case above.
  {
    const getCount2 = new Map()
    const countGets2 = n => { if (n[0] === 'local.get' && typeof n[1] === 'string') getCount2.set(n[1], (getCount2.get(n[1]) || 0) + 1) }
    for (const s of body2) walkAst(s, { enter: countGets2 })
    const dropDefs = new Set()
    const inlineSign = (n) => {
      if (!isArr(n)) return n
      if (n[0] === 'f64.convert_i32_s' && n.length === 2 && isArr(n[1]) && n[1][0] === 'local.get' &&
          typeof n[1][1] === 'string' && getCount2.get(n[1][1]) === 1) {
        const nm = n[1][1]
        const def = body2.find(x => isArr(x) && x[0] === 'local.set' && x[1] === nm && x.length === 3)
        if (def && isArr(def[2]) && def[2][0] === 'select' && def[2].length === 4 && isI32Const(def[2][1]) && isI32Const(def[2][2])) {
          dropDefs.add(def)
          return ['f64.convert_i32_s', def[2]]
        }
      }
      return n.map((c, i) => i === 0 ? c : inlineSign(c))
    }
    const inlined2 = body2.map(inlineSign)
    // Two-pass: inlineSign allocates a fresh array for every node it visits (even unchanged
    // ones), so filtering `inlined2` by `dropDefs.has(...)` would fail on reference identity —
    // `dropDefs` holds references into the PRE-map `body2`, so the drop-filter must run against
    // `body2` (matching indices into `inlined2`), not against the mapped output.
    if (dropDefs.size) body2 = body2.map((s, i) => dropDefs.has(s) ? null : inlined2[i]).filter(s => s != null)
  }

  // Build lifted body. If anything fails to lift, bail.
  const newLanedLocals = new Map()  // origName → laneName (bare string; see getOrAllocLanedLocal)
  const extraLocals = []  // canon temps allocated during lift
  const ctx = { laneType, incVar, rampVar: null, rampTemp: null, widenLoads: false, localKind, fnLocals, newLanedLocals, extraLocals, freshIdRef, fail: false, failReason: null, aosPixelStride, pureFuncMap, inlineDepth: 0, constLocals }
  const lifted = []
  for (const s of body2) {
    const r = liftStmt(s, ctx)
    if (ctx.fail) return null
    if (r != null) {
      if (Array.isArray(r) && r[0] === '__seq__') lifted.push(...r.slice(1))
      else lifted.push(r)
    }
  }
  if (lifted.length === 0) return null

  // Generate fresh names
  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`
  const simdBrkLabel = `$__simd_brk${id}`
  const simdLoopLabel = `$__simd_loop${id}`

  const info = LANE_INFO[laneType]
  const lanes = info.lanes
  const mask = -lanes  // bit pattern ~(lanes-1) in i32 two's complement

  // Build SIMD prefix block.
  const boundExpr = boundLocal
    ? ['local.get', boundLocal]
    : bound  // i32.const N
  const simdBlock = ['block', simdBrkLabel,
    ['loop', simdLoopLabel,
      ['br_if', simdBrkLabel,
        ['i32.eqz', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]]]],
      ...lifted,
      ['local.set', incVar,
        ['i32.add', ['local.get', incVar], ['i32.const', lanes]]],
      ['br', simdLoopLabel]
    ]
  ]

  // Bound setup: align the SPAN, not the bound — simdBound = iv + ((bound − iv)
  // & ~(lanes−1)). `bound & mask` assumed a 0 entry: a loop entering at k=1
  // (symmetric fills start past the DC bin) would run its last vector step at
  // k = bound−1 and overrun one lane past the bound. iv holds the entry value
  // here (the setup precedes the SIMD block).
  const boundSetup = ['local.set', simdBoundName,
    ['i32.add', ['local.get', incVar],
      ['i32.and', ['i32.sub', boundExpr, ['local.get', incVar]], ['i32.const', mask]]]]

  // Synthetic outer wrapper — has no result, no label, just sequences.
  // A clone of any LICM-hoisted preamble runs first (so the SIMD block sees the
  // invariant); the original block is preserved unchanged as the scalar tail (which
  // re-runs the preamble harmlessly — it is loop-invariant).
  const wrapper = ['block', ...preamble.map(cloneNode), boundSetup, simdBlock, bl.blockNode]

  // Locals to add to function header.
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ...[...newLanedLocals.values()].map(laneName => ['local', laneName, 'v128']),
    ...extraLocals,
  ]

  return { wrapper, newLocalDecls }
}

export function tryGeneralMap(node, fnLocals, freshIdRef, bl, opts = {}) {
  if (!bl) return null
  const { aliasVersion = true } = opts
  const { incVar, bound, boundLocal, body, preamble, hasGlobalSet: blHasGlobalSet, writes, referenced: blReferenced } = bl
  if (blHasGlobalSet) return null
  if (!boundLocal && !isI32Const(bound)) return null

  // Nested loop / non-$math call inside the body breaks the "every site is one straight-line
  // lane op" assumption a flat scan here relies on (verbatim from tryStencil).
  const hasNestedLoopOrCall = (n) => {
    let found = false
    walkAst(n, { enter: x => {
      if (found) return false
      if (x[0] === 'loop' || (x[0] === 'call' && (typeof x[1] !== 'string' || !x[1].startsWith('$math.'))) || x[0] === 'call_indirect') { found = true; return false }
    } })
    return found
  }
  if (body.some(hasNestedLoopOrCall)) return null

  const isInvBase = (b) => (isArr(b) && b[0] === 'global.get') || (isLocalGet(b) && !writes.has(b[1]))

  // Affine-in-IV coefficient solver, i32 domain only (no toroidal wrap, no float-derived index —
  // both genuinely stencil-specific; see header doc). Returns 0 (loop-invariant), 1 (stride-1
  // affine — IV itself, or ± a loop-invariant term, nested arbitrarily deep), or null (unprovable).
  const ivCoeff = (n) => {
    if (isLocalGet(n)) {
      const nm = n[1]
      if (nm === incVar) return 1
      return writes.has(nm) ? null : 0
    }
    if (isI32Const(n)) return 0
    if (isArr(n) && n[0] === 'global.get') return 0
    if (isArr(n) && (n[0] === 'i32.add' || n[0] === 'i32.sub') && n.length === 3) {
      const a = ivCoeff(n[1]), b = ivCoeff(n[2])
      if (a == null || b == null) return null
      const c = n[0] === 'i32.add' ? a + b : a - b
      return c === 0 || c === 1 ? c : null
    }
    if (isArr(n) && n[0] === 'i32.mul' && n.length === 3)
      return ivCoeff(n[1]) === 0 && ivCoeff(n[2]) === 0 ? 0 : null
    if (isArr(n) && n[0] === 'local.tee' && n.length === 3) return ivCoeff(n[2])
    return null
  }

  // Address match: `base + (IDX << K)` (or the flipped operand order), IDX affine coefficient 1,
  // K matching the site's own element stride. Tee-CSE resolved via addrTees/offTees, exactly like
  // tryStencil's own matchAddr (ported, not re-derived — same soundness argument).
  let laneType = null, stride = -1
  const offTees = new Map(), addrTees = new Map()
  const sites = []   // { kind, base, idx, memBytes }
  const matchOffset = (off, expectStride) => {
    let ot = null, o = off
    if (isArr(o) && o[0] === 'local.tee' && o.length === 3) { ot = o[1]; o = o[2] }
    if (isLocalGet(o) && offTees.has(o[1])) return { idx: offTees.get(o[1]) }
    if (isArr(o) && o[0] === 'i32.shl' && o.length === 3 && isI32Const(o[2]) && (1 << o[2][1]) === expectStride && ivCoeff(o[1]) === 1) {
      if (ot) offTees.set(ot, o[1])
      return { idx: o[1] }
    }
    // Byte lanes (i8, stride 1): `i*1` is a no-op the compiler never wraps in a shl — the
    // offset is the bare affine expression itself (matchLaneOffset's own `isLocalGet(n,ind)`
    // fallback, generalized past a bare IV to any coefficient-1 affine form).
    if (expectStride === 1 && ivCoeff(o) === 1) { if (ot) offTees.set(ot, o); return { idx: o } }
    return null
  }
  const matchAddr = (addr, expectStride = stride) => {
    let teeName = null, n = addr
    if (isArr(n) && n[0] === 'local.tee' && n.length === 3) { teeName = n[1]; n = n[2] }
    if (isLocalGet(n) && addrTees.has(n[1])) { const e = addrTees.get(n[1]); if (teeName) addrTees.set(teeName, e); return e }
    if (!isArr(n) || n[0] !== 'i32.add' || n.length !== 3) return null
    for (const [bi, oi] of [[1, 2], [2, 1]]) {
      if (!isInvBase(n[bi])) continue
      const om = matchOffset(n[oi], expectStride)
      if (om) { const e = { base: n[bi], idx: om.idx }; if (teeName) addrTees.set(teeName, e); return e }
    }
    return null
  }
  const scan = (n, parent, pi) => {
    if (!isArr(n)) return true
    const op = n[0]
    if (LOAD_OPS[op]) {
      let addr = n[1], memBytes = 0
      if (typeof addr === 'string' && addr.startsWith('offset=')) { memBytes = +addr.slice(7); addr = n[2] }
      const lt = LOAD_OPS[op]
      if (laneType == null) { laneType = lt; stride = LANE_INFO[lt].stride }
      else if (lt !== laneType) return false
      const m = matchAddr(addr, stride)
      if (!m) return false
      sites.push({ kind: 'load', base: m.base, idx: m.idx, memBytes })
      return true
    }
    if (STORE_OPS[op]) {
      if (n.length !== 3) return false
      const st = STORE_OPS[op]
      if (laneType == null) { laneType = st; stride = LANE_INFO[st].stride }
      else if (st !== laneType) return false
      const m = matchAddr(n[1])
      if (!m) return false
      sites.push({ kind: 'store', base: m.base, idx: m.idx, memBytes: 0 })
      return scan(n[2], n, 2)
    }
    if ((op === 'local.set' || op === 'local.tee') && typeof n[1] === 'string' && n.length === 3) {
      const v = n[2]
      if (isArr(v) && v[0] === 'i32.shl' && v.length === 3 && isI32Const(v[2]) && stride > 0 && (1 << v[2][1]) === stride && ivCoeff(v[1]) === 1) offTees.set(n[1], v[1])
      else matchAddr(['local.tee', n[1], v])
    }
    for (let i = 1; i < n.length; i++) if (!scan(n[i], n, i)) return false
    return true
  }
  for (const s of body) if (!scan(s, null, -1)) return null
  if (!laneType || !sites.some(s => s.kind === 'store') || !sites.some(s => s.kind === 'load')) return null

  // Same-array dependence gate: every access to a WRITTEN base must touch the SAME element
  // (idx + memarg) as every OTHER access to that same base — else SIMD reads stale/future data
  // a scalar iteration wouldn't (verbatim from tryStencil's own alias proof). A mismatch is no
  // longer an unconditional decline — see the header doc's "RUNTIME ALIAS VERSIONING" note: each
  // mismatched pair resolves one of three ways —
  //   1. the element delta constant-folds (both sides built only from the IV/consts/+/-/*, no
  //      OTHER local/global) to a COMPILE-TIME number: |delta| ≥ lanes ⇒ provably disjoint
  //      already, accepted for free (no guard, no clone — same zero-cost path a real elemKey
  //      MATCH gets); |delta| < lanes ⇒ provably NOT disjoint (a genuine in-place recurrence,
  //      e.g. `a[j]=a[j-1]+a[j]`) — declines exactly as before, a runtime check could never help.
  //   2. the delta depends on something else (an `off` param etc.) — genuinely runtime-unknown —
  //      version it (`aliasGuards`, non-null).
  //   3. unrepresentable (non-stride-aligned memarg) — declines exactly as before.
  const elemKey = (s) => `${JSON.stringify(normTee(s.idx))}@${s.memBytes / stride}`
  const lanesForGuard = LANE_INFO[laneType].lanes
  // Fold an idx expression at a FIXED, arbitrary IV value (0) — sound because every idx here
  // already passed ivCoeff's coefficient-EXACTLY-{0,1} proof, so two same-coefficient sides
  // differ by a value independent of which IV value is substituted (see header doc). Returns
  // null (not a compile-time number) the moment it hits any local/global OTHER than the IV.
  const foldAtIv0 = (n) => {
    if (isI32Const(n)) return +n[1]
    if (isLocalGet(n)) return n[1] === incVar ? 0 : null
    if (isArr(n) && n[0] === 'local.tee' && n.length === 3) return foldAtIv0(n[2])
    if (isArr(n) && (n[0] === 'i32.add' || n[0] === 'i32.sub' || n[0] === 'i32.mul') && n.length === 3) {
      const a = foldAtIv0(n[1]), b = foldAtIv0(n[2])
      if (a == null || b == null) return null
      return n[0] === 'i32.add' ? a + b : n[0] === 'i32.sub' ? a - b : a * b
    }
    return null
  }
  let aliasGuards = null
  {
    const guards = [], seenPairs = new Set()
    let sawMismatch = false, unversionable = false, bodyTooBig = null   // lazy: only sized once actually needed
    for (let i = 0; i < sites.length; i++) {
      const st = sites[i]
      if (st.kind !== 'store') continue
      for (let j = 0; j < sites.length; j++) {
        if (i === j) continue
        const s = sites[j]
        if (!exprEq(normTee(s.base), normTee(st.base)) || elemKey(s) === elemKey(st)) continue
        const pk = i < j ? `${i}|${j}` : `${j}|${i}`
        if (seenPairs.has(pk)) continue
        seenPairs.add(pk)
        if ((st.memBytes - s.memBytes) % stride !== 0) { sawMismatch = true; unversionable = true; continue }
        const constDelta = (s.memBytes - st.memBytes) / stride
        const foldedA = foldAtIv0(s.idx), foldedB = foldAtIv0(st.idx)
        if (foldedA != null && foldedB != null) {
          // Fully compile-time: resolve now, never touches `aliasVersion`/size gates — a
          // provably-disjoint constant offset costs NOTHING (no guard, no clone), matching the
          // zero-cost path every ordinary elemKey MATCH already gets.
          if (Math.abs(foldedA - foldedB + constDelta) >= lanesForGuard) continue
          sawMismatch = true; unversionable = true; continue
        }
        sawMismatch = true
        if (bodyTooBig == null) bodyTooBig = body.reduce((n, stmt) => n + gmNodeCount(stmt), 0) > ALIAS_VERSION_MAX_BODY_NODES
        if (!aliasVersion || bodyTooBig) { unversionable = true; continue }
        let delta = ['i32.sub', cloneNode(s.idx), cloneNode(st.idx)]
        if (constDelta !== 0) delta = ['i32.add', delta, ['i32.const', String(constDelta)]]
        guards.push(['i32.or',
          ['i32.le_s', delta, ['i32.const', String(-lanesForGuard)]],
          ['i32.ge_s', delta, ['i32.const', String(lanesForGuard)]]])
      }
    }
    if (sawMismatch) {
      if (unversionable) return null
      aliasGuards = guards
    }
  }

  // A scalar local whose every write is address/offset-shaped (an addrTees/offTees entry, or
  // matches the SAME address grammar directly) is index arithmetic, not lane data — kept scalar
  // in the lift (tryVectorize's own `_isAddressLocal` pattern, ported onto this pass's matchAddr).
  const _isAddrLocalGM = (name) => {
    let onlyAddr = true, found = false
    const inspect = n => {
      if (!isArr(n) || (n[0] !== 'local.tee' && n[0] !== 'local.set') || n[1] !== name || n.length !== 3) return
      found = true
      const m = matchAddr(['local.tee', name, n[2]])
      if (!m && !(isArr(n[2]) && n[2][0] === 'i32.shl' && n[2].length === 3 && isI32Const(n[2][2]) && ivCoeff(n[2][1]) === 1)) onlyAddr = false
      return false
    }
    for (const s of body) walkAst(s, { enter: inspect })
    return found && onlyAddr
  }

  // Classify every referenced local (tryVectorize's own convention, ported — NOT tryStencil's
  // stricter ty===laneType gate): induction var exempt; a WAT-i32 local proven pure address/
  // offset arithmetic is 'addr' (kept scalar); every OTHER written local is 'lane' data
  // (first access must be a write — a read-before-write is a loop-carried scalar, REDUCTION's
  // job, not this pass's); every unwritten local is 'invariant'. Declared WAT type is
  // deliberately NOT gated here: jz's overflow-safe integer-arithmetic idiom (`a[i]+b[i]` into
  // an Int32Array store, unprovable native-i32-add-in-range) computes the sum in an f64-typed
  // temp (`f64.add(convert_i32_s(A), convert_i32_s(B))`) even under an i32 lane — liftExprV's
  // own `liftAddSubOfConverts` dispatch (called from liftStmt's ordinary 'lane' local.set path,
  // no special-casing needed here) already lifts that shape to `i32x4.add` correctly. A local
  // whose value liftStmt/liftExprV genuinely can't lift under this lane type fails closed
  // (`ctx.fail`, checked below) — never a silent miscompile, same safety net tryVectorize relies on.
  const localKind = new Map()
  for (const name of blReferenced) {
    if (name === incVar) continue
    const ty = fnLocals.get(name)
    if (ty === 'i32' && (addrTees.has(name) || offTees.has(name) || _isAddrLocalGM(name))) { localKind.set(name, 'addr'); continue }
    if (writes.has(name)) {
      let fk = null
      for (const s of body) { const k = firstAccess(s, name); if (k) { fk = k; break } }
      if (fk === 'read') return null   // loop-carried scalar — not a dependence-free map
      localKind.set(name, 'lane')
    } else localKind.set(name, 'invariant')
  }

  const newLanedLocals = new Map(), extraLocals = []
  const ctx = { laneType, incVar, rampVar: null, rampTemp: null, widenLoads: false, localKind, fnLocals, newLanedLocals, extraLocals, freshIdRef, fail: false, failReason: null, aosPixelStride: 1, pureFuncMap: null, inlineDepth: 0, constLocals: null }
  const lifted = []
  for (const s of body) {
    const r = liftStmt(s, ctx)
    if (ctx.fail) return null
    if (r != null) { if (Array.isArray(r) && r[0] === '__seq__') lifted.push(...r.slice(1)); else lifted.push(r) }
  }
  if (!lifted.length) return null
  // Cost model (Part 2 — see the header doc right before tryGeneralMap): decline
  // when the vector step costs at least as much per lane as the scalar iteration it replaces.
  // `aliasGuards` (computed above) is non-null only for the versioned path; its own `.length` is
  // the guard-clause count the wrapper below actually ANDs together, so it's the right count here.
  if (!isProfitable(body, lifted, LANE_INFO[laneType].lanes, aliasGuards ? aliasGuards.length : 0))
    return liftFail(ctx, 'not profitable: vector cost/lane ≥ scalar cost')

  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`, simdBrkLabel = `$__simd_brk${id}`, simdLoopLabel = `$__simd_loop${id}`
  const info = LANE_INFO[laneType], lanes = info.lanes, mask = -lanes
  const boundExpr = boundLocal ? ['local.get', boundLocal] : bound
  const boundSetup = ['local.set', simdBoundName,
    ['i32.add', ['local.get', incVar],
      ['i32.and', ['i32.sub', boundExpr, ['local.get', incVar]], ['i32.const', mask]]]]
  const simdBlock = ['block', simdBrkLabel,
    ['loop', simdLoopLabel,
      ['br_if', simdBrkLabel, ['i32.eqz', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]]]],
      ...lifted,
      ['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', lanes]]],
      ['br', simdLoopLabel]]]
  // Runtime alias versioning (see header doc): when `aliasGuards` is non-null, the SIMD path
  // (unchanged) runs only behind a hoisted disjointness check; the else-branch is a FRESH clone
  // of the original loop — `bl.blockNode` itself stays reserved for the tail-after-SIMD use
  // above, so the fallback needs its own independent copy, not a second reference to the same
  // node. `preamble` (pure & loop-invariant, established by every recognizer in this file) stays
  // a single shared prefix ahead of the branch — safe for the alias-fallback path too, since the
  // untouched clone of `bl.blockNode` re-derives the same values internally regardless.
  const simdPath = [boundSetup, simdBlock, bl.blockNode]
  const guardedPath = aliasGuards
    ? [['if', aliasGuards.reduce((a, g) => a == null ? g : ['i32.and', a, g], null),
        ['then', ...simdPath],
        ['else', cloneNode(bl.blockNode)]]]
    : simdPath
  const wrapper = ['block', ...preamble.map(cloneNode), ...guardedPath]
  const newLocalDecls = [['local', simdBoundName, 'i32'], ...[...newLanedLocals.values()].map(laneName => ['local', laneName, 'v128']), ...extraLocals]
  return { wrapper, newLocalDecls }
}
