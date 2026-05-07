/**
 * Lane-local SIMD-128 vectorizer.
 *
 *   Recognizes inner loops of shape:
 *     for (let i = 0; i < N; i++) arr[i] = f(arr[i], …)
 *   where every body op is "lane-pure" — its k-th lane output depends only
 *   on k-th lane inputs. Lifts the body to SIMD-128, prefixed before the
 *   original (now tail) loop. Original loop runs the remainder.
 *
 * Design:
 *   • Lane-purity is a structural property, not a benchmark match. The op
 *     whitelist is the single source of truth (one entry per (lane-type, op)).
 *   • Lift is mechanical. The recognizer either matches the structure — in
 *     which case lifting is unambiguous — or skips. No bench-specific
 *     heuristics.
 *   • Tail loop is the original WAT, untouched. If anything regresses the
 *     SIMD recognizer just doesn't match, never miscompiles.
 *
 * Match conditions:
 *   1. (block $brk (loop $L (br_if $brk !cond) BODY (i = i+1) (br $L)))
 *   2. cond is `(i32.lt_s i BOUND)` or `i32.lt_u`; BOUND is loop-invariant.
 *   3. All loads/stores in BODY use address `(add base (shl i K))` where
 *      base is loop-invariant and K matches the elem stride. Optional
 *      enclosing `local.tee` is allowed (and reused).
 *   4. All loads share the same opcode → defines lane type.
 *   5. All other ops in BODY are in the lane-pure whitelist for that type.
 *   6. Each non-induction local in BODY is either purely loop-invariant
 *      (only read) or purely lane-local (first action is a write). Never
 *      both — that's a loop-carried scalar (reduction / stencil) → bail.
 *
 * Lift produces, before the original block:
 *     (local.set $__simd_bound{N} (i32.and BOUND (i32.const ~(LANES-1))))
 *     (block $__simd_brk{N}
 *       (loop $__simd_loop{N}
 *         (br_if $__simd_brk{N} (i32.eqz (i32.lt_s i $__simd_bound{N})))
 *         <body lifted op-by-op; lane-local locals routed to v128 shadows>
 *         (local.set $i (i32.add i (i32.const LANES)))
 *         (br $__simd_loop{N})))
 *
 * The original block runs immediately after with i pre-advanced; its own
 * `i < BOUND` guard handles the tail.
 */

// Local copy of findBodyStart (mirrors optimize.js): index of first non-decl
// child in a (func ...) form — past type/param/result/local declarations.
function findBodyStart(fn) {
  for (let i = 2; i < fn.length; i++) {
    const c = fn[i]
    if (!Array.isArray(c)) continue
    if (c[0] === 'export' || c[0] === 'import' || c[0] === 'type' ||
        c[0] === 'param' || c[0] === 'result' || c[0] === 'local') continue
    return i
  }
  return fn.length
}

// ---- Lane type tables ------------------------------------------------------

const LANE_INFO = {
  i32: { lanes: 4, strideLog2: 2, stride: 4, splat: 'i32x4.splat', constOp: 'i32.const' },
  i64: { lanes: 2, strideLog2: 3, stride: 8, splat: 'i64x2.splat', constOp: 'i64.const' },
  f32: { lanes: 4, strideLog2: 2, stride: 4, splat: 'f32x4.splat', constOp: 'f32.const' },
  f64: { lanes: 2, strideLog2: 3, stride: 8, splat: 'f64x2.splat', constOp: 'f64.const' },
}

const LOAD_OPS = {
  'i32.load': 'i32', 'i64.load': 'i64', 'f32.load': 'f32', 'f64.load': 'f64',
}
const STORE_OPS = {
  'i32.store': 'i32', 'i64.store': 'i64', 'f32.store': 'f32', 'f64.store': 'f64',
}

// scalar op → SIMD op. shamtScalar:true means second operand stays scalar i32.
const LANE_PURE = {
  i32: new Map([
    ['i32.add', { simd: 'i32x4.add' }],
    ['i32.sub', { simd: 'i32x4.sub' }],
    ['i32.mul', { simd: 'i32x4.mul' }],
    ['i32.and', { simd: 'v128.and' }],
    ['i32.or',  { simd: 'v128.or' }],
    ['i32.xor', { simd: 'v128.xor' }],
    ['i32.shl', { simd: 'i32x4.shl', shamtScalar: true }],
    ['i32.shr_s', { simd: 'i32x4.shr_s', shamtScalar: true }],
    ['i32.shr_u', { simd: 'i32x4.shr_u', shamtScalar: true }],
  ]),
  i64: new Map([
    ['i64.add', { simd: 'i64x2.add' }],
    ['i64.sub', { simd: 'i64x2.sub' }],
    ['i64.mul', { simd: 'i64x2.mul' }],
    ['i64.and', { simd: 'v128.and' }],
    ['i64.or',  { simd: 'v128.or' }],
    ['i64.xor', { simd: 'v128.xor' }],
    ['i64.shl', { simd: 'i64x2.shl', shamtScalar: true }],
    ['i64.shr_s', { simd: 'i64x2.shr_s', shamtScalar: true }],
    ['i64.shr_u', { simd: 'i64x2.shr_u', shamtScalar: true }],
  ]),
  f32: new Map([
    ['f32.add', { simd: 'f32x4.add' }],
    ['f32.sub', { simd: 'f32x4.sub' }],
    ['f32.mul', { simd: 'f32x4.mul' }],
    ['f32.div', { simd: 'f32x4.div' }],
    ['f32.min', { simd: 'f32x4.min' }],
    ['f32.max', { simd: 'f32x4.max' }],
    ['f32.neg', { simd: 'f32x4.neg' }],
    ['f32.abs', { simd: 'f32x4.abs' }],
    ['f32.sqrt', { simd: 'f32x4.sqrt' }],
  ]),
  f64: new Map([
    ['f64.add', { simd: 'f64x2.add' }],
    ['f64.sub', { simd: 'f64x2.sub' }],
    ['f64.mul', { simd: 'f64x2.mul' }],
    ['f64.div', { simd: 'f64x2.div' }],
    ['f64.min', { simd: 'f64x2.min' }],
    ['f64.max', { simd: 'f64x2.max' }],
    ['f64.neg', { simd: 'f64x2.neg' }],
    ['f64.abs', { simd: 'f64x2.abs' }],
    ['f64.sqrt', { simd: 'f64x2.sqrt' }],
  ]),
}

// ---- Recognizer ------------------------------------------------------------

const isArr = Array.isArray

function isLocalGet(node, name) {
  return isArr(node) && node[0] === 'local.get' && (name == null || node[1] === name)
}
function isI32Const(node) {
  return isArr(node) && node[0] === 'i32.const'
}
function constNum(node) {
  if (!isI32Const(node)) return null
  const v = node[1]
  return typeof v === 'number' ? v : (typeof v === 'string' ? parseInt(v, 10) : null)
}

/**
 * Match increment shape `(local.set $X (i32.add (local.get $X) (i32.const 1)))`.
 * Returns $X or null.
 */
function matchInc1(stmt) {
  if (!isArr(stmt) || stmt[0] !== 'local.set' || stmt.length !== 3) return null
  const x = stmt[1]
  const v = stmt[2]
  if (!isArr(v) || v[0] !== 'i32.add' || v.length !== 3) return null
  if (!isLocalGet(v[1], x)) return null
  if (constNum(v[2]) !== 1) return null
  return x
}

/**
 * Match `(br_if $LABEL (i32.eqz (i32.lt_{s,u} (local.get $I) BOUND)))`.
 * Returns { ind, bound } or null.
 */
function matchExitBrIf(stmt, label) {
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
function collectWrites(node, out) {
  if (!isArr(node)) return
  const op = node[0]
  if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string') {
    out.add(node[1])
  }
  for (let i = 0; i < node.length; i++) collectWrites(node[i], out)
}

/**
 * Return the FIRST kind of access for `name` in straight-line walk order.
 *   'write' — local.set/local.tee seen first
 *   'read'  — local.get seen first
 *   null    — not referenced
 */
function firstAccess(node, name) {
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
 * Match an address expression `(i32.add base (i32.shl (local.get IND) (i32.const K)))`,
 * with optional outer `(local.tee $A ...)`. Stride 1 fallback: `(i32.add base (local.get IND))`.
 * Also accepts `(local.get $A)` when $A is a previously-recorded address tee.
 *
 * Returns { strideLog2, base, teeName?: string, viaLocal?: string } or null.
 *   `strideLog2` = K for i32.shl form, 0 for plain add form.
 *   `base` is the loop-invariant base subtree.
 */
function matchLaneAddr(addr, ind, addrLocals) {
  let teeName = null
  let n = addr
  // (local.get $A) where $A holds a previously-tee'd lane-address.
  if (isArr(n) && n[0] === 'local.get' && typeof n[1] === 'string' && addrLocals && addrLocals.has(n[1])) {
    const e = addrLocals.get(n[1])
    return { strideLog2: e.strideLog2, base: e.base, teeName: null, viaLocal: n[1] }
  }
  if (isArr(n) && n[0] === 'local.tee' && n.length === 3) {
    teeName = n[1]
    n = n[2]
  }
  if (!isArr(n) || n[0] !== 'i32.add' || n.length !== 3) return null
  const a = n[1], b = n[2]
  // case 1: (i32.add base (i32.shl (local.get ind) (i32.const K)))
  if (isArr(b) && b[0] === 'i32.shl' && b.length === 3 && isLocalGet(b[1], ind)) {
    const k = constNum(b[2])
    if (k != null && k >= 0 && k <= 3) return { strideLog2: k, base: a, teeName }
  }
  // case 2: (i32.add base (local.get ind)) — stride 1
  if (isLocalGet(b, ind)) return { strideLog2: 0, base: a, teeName }
  return null
}

// ---- Recognize a (block (loop)) pair --------------------------------------

/**
 * Try to vectorize the inner loop. Returns the replacement node array
 * (synthetic outer block) or null on no match.
 */
function tryVectorize(blockNode, fnLocals, freshIdRef) {
  if (!isArr(blockNode) || blockNode[0] !== 'block') return null
  // Find label and inner loop.
  let blockLabel = null
  let loopIdx = -1, loopNode = null
  for (let i = 1; i < blockNode.length; i++) {
    const c = blockNode[i]
    if (typeof c === 'string' && c.startsWith('$') && blockLabel == null && i === 1) {
      blockLabel = c; continue
    }
    if (isArr(c) && c[0] === 'loop') {
      if (loopNode) return null  // multiple loops
      loopIdx = i; loopNode = c
    } else if (isArr(c)) {
      return null  // foreign content alongside the loop
    }
  }
  if (!loopNode || !blockLabel) return null

  // Loop layout: ['loop', '$label', ...stmts]
  const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
  if (!loopLabel) return null

  // Find induction increment + back-branch at the END.
  let endIdx = loopNode.length - 1
  if (!(isArr(loopNode[endIdx]) && loopNode[endIdx][0] === 'br' && loopNode[endIdx][1] === loopLabel)) return null
  const incIdx = endIdx - 1
  const incVar = matchInc1(loopNode[incIdx])
  if (!incVar) return null

  // First stmt must be the exit br_if.
  const exitInfo = matchExitBrIf(loopNode[2], blockLabel)
  if (!exitInfo) return null
  if (exitInfo.ind !== incVar) return null

  // Body = stmts between exit and increment.
  const body = []
  for (let i = 3; i < incIdx; i++) body.push(loopNode[i])

  // Bound must be loop-invariant. For now, accept (local.get $L) where $L
  // is declared but not written inside the body, OR (i32.const N).
  let bound = exitInfo.bound
  let boundLocal = null
  if (isArr(bound) && bound[0] === 'local.get' && typeof bound[1] === 'string') {
    boundLocal = bound[1]
  } else if (isI32Const(bound)) {
    // ok
  } else {
    return null
  }

  // Detect lane type from the FIRST load in body.
  let laneType = null
  let stride = -1
  const loadStoreSites = []  // {parent, idx, kind:'load'|'store'}
  // Address tees: name → {strideLog2, base}. A `(local.tee NAME (lane-addr))`
  // both validates the load's address AND records NAME so the matching store's
  // `(local.get NAME)` is accepted as the same lane address.
  const addrLocals = new Map()

  function scanForLoadsStores(node, parent, pi) {
    if (!isArr(node)) return true
    const op = node[0]
    if (LOAD_OPS[op]) {
      if (laneType == null) {
        laneType = LOAD_OPS[op]
        stride = LANE_INFO[laneType].stride
      } else if (LOAD_OPS[op] !== laneType) {
        return false
      }
      const m = matchLaneAddr(node[1], incVar, addrLocals)
      if (!m) return false
      if ((1 << m.strideLog2) !== stride) return false
      if (m.teeName) addrLocals.set(m.teeName, { strideLog2: m.strideLog2, base: m.base })
      loadStoreSites.push({ parent, idx: pi, kind: 'load' })
      return true
    }
    if (STORE_OPS[op]) {
      const sty = STORE_OPS[op]
      if (laneType != null && sty !== laneType) return false
      if (laneType == null) { laneType = sty; stride = LANE_INFO[laneType].stride }
      const m = matchLaneAddr(node[1], incVar, addrLocals)
      if (!m) return false
      if ((1 << m.strideLog2) !== stride) return false
      if (m.teeName) addrLocals.set(m.teeName, { strideLog2: m.strideLog2, base: m.base })
      loadStoreSites.push({ parent, idx: pi, kind: 'store' })
      // Recurse into VALUE child (idx 2) — it's data, not address.
      if (!scanForLoadsStores(node[2], node, 2)) return false
      return true
    }
    // local.set/tee of an address local outside a load/store context (e.g.
    // `(local.set $a (i32.add base (i32.shl i 2)))` as a standalone stmt) —
    // record so a later `(local.get $a)` resolves.
    if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string' && node.length === 3) {
      const valM = matchLaneAddr(['local.tee', node[1], node[2]], incVar, addrLocals)
      if (valM && valM.teeName) {
        addrLocals.set(valM.teeName, { strideLog2: valM.strideLog2, base: valM.base })
      }
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
  if (!laneType) return null  // no memory ops — vectorizing buys nothing
  if (loadStoreSites.length === 0) return null

  // Classify all locals referenced in body.
  // - induction var (incVar): exempt
  // - bound local (if any): must be invariant
  // - each other local: first access must not be a read-then-written pattern
  const writes = new Set()
  for (const s of body) collectWrites(s, writes)
  if (boundLocal && writes.has(boundLocal)) return null  // bound varies in body → bail

  const localKind = new Map()  // name → 'lane' | 'invariant' | 'addr'
  // Walk to collect ALL referenced names
  const referenced = new Set()
  const collectRefs = (n) => {
    if (!isArr(n)) return
    const op = n[0]
    if ((op === 'local.get' || op === 'local.set' || op === 'local.tee') && typeof n[1] === 'string')
      referenced.add(n[1])
    for (let i = 1; i < n.length; i++) collectRefs(n[i])
  }
  for (const s of body) collectRefs(s)

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
      if (decl === 'i32' && _isAddressLocal(body, name, incVar)) {
        localKind.set(name, 'addr')
      } else {
        localKind.set(name, 'lane')
      }
    } else {
      localKind.set(name, 'invariant')
    }
  }

  // Build lifted body. If anything fails to lift, bail.
  const newLanedLocals = new Map()  // origName → { laneName, simdType }
  const ctx = { laneType, incVar, localKind, newLanedLocals, fail: false, failReason: null }
  const lifted = []
  for (const s of body) {
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

  // Bound setup: simdBoundName = bound & ~(lanes-1)
  const boundSetup = ['local.set', simdBoundName,
    ['i32.and', boundExpr, ['i32.const', mask]]]

  // Synthetic outer wrapper — has no result, no label, just sequences.
  // The original block is preserved unchanged as the tail.
  const wrapper = ['block', boundSetup, simdBlock, blockNode]

  // Locals to add to function header.
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ...[...newLanedLocals.values()].map(({ laneName }) => ['local', laneName, 'v128'])
  ]

  return { wrapper, newLocalDecls }
}

// Scalar locals that are ALWAYS computed as `(i32.add base (i32.shl ind K))`
// or aliased to such an address are "address tees", not lane data. They stay
// scalar i32 in the lifted body.
function _isAddressLocal(body, name, ind) {
  let onlyAsAddrTee = true
  let foundTee = false
  function walk(n) {
    if (!isArr(n)) return
    if (n[0] === 'local.tee' && n[1] === name) {
      foundTee = true
      // Check the value is a lane-address shape
      const m = matchLaneAddr(['local.tee', name, n[2]], ind)
      if (!m) onlyAsAddrTee = false
      return
    }
    if (n[0] === 'local.set' && n[1] === name) {
      // A set-not-tee: check value shape
      const m = matchLaneAddr(['local.tee', name, n[2]], ind)
      if (!m) onlyAsAddrTee = false
      foundTee = true
      return
    }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  for (const s of body) walk(s)
  return foundTee && onlyAsAddrTee
}

// ---- Lifter ----------------------------------------------------------------

function getOrAllocLanedLocal(name, ctx) {
  let r = ctx.newLanedLocals.get(name)
  if (!r) {
    r = { laneName: `${name}__v`, origName: name }
    ctx.newLanedLocals.set(name, r)
  }
  return r
}

/** Lift a statement. Returns lifted stmt, or null to skip, or ['__seq__', ...] for multiple. */
function liftStmt(stmt, ctx) {
  if (!isArr(stmt)) {
    // Bare strings like "drop" — produced by stack-form WAT. We unwrap value-blocks
    // separately so an isolated "drop" should not appear here, but tolerate it.
    if (stmt === 'drop') return null
    ctx.fail = true; return null
  }
  const op = stmt[0]

  if (op === 'local.set' && typeof stmt[1] === 'string' && stmt.length === 3) {
    const name = stmt[1]
    const kind = ctx.localKind.get(name)
    if (kind === 'addr') {
      // Address-only local: lift the value as-is (it's i32 arithmetic on ind).
      return ['local.set', name, stmt[2]]
    }
    if (kind === 'lane') {
      const { laneName } = getOrAllocLanedLocal(name, ctx)
      const v = liftExprV(stmt[2], ctx)
      if (ctx.fail) return null
      return ['local.set', laneName, v]
    }
    ctx.fail = true; return null
  }

  if (STORE_OPS[op]) {
    const simdStore = 'v128.store'
    const addr = stmt[1]  // we leave addresses as-is (scalar i32 expressions)
    const val = liftExprV(stmt[2], ctx)
    if (ctx.fail) return null
    // Handle memarg if present (last positional after addr/val): unlikely in
    // pre-watr IR for this shape; bail if more than 3 children.
    if (stmt.length !== 3) { ctx.fail = true; return null }
    return [simdStore, addr, val]
  }

  // (block (result T) STMTS... TAIL_EXPR) followed by sibling "drop" — we get
  // the block alone here; the "drop" is a separate sibling and is returned as
  // null by the next call. Strip the wrapper, lift the inner stmts; the
  // dropped-tail expr is discarded.
  if (op === 'block') {
    // Block may be: ['block', LABEL?, RESULT?, ...stmts]
    let i = 1
    if (typeof stmt[i] === 'string' && stmt[i].startsWith('$')) i++
    if (isArr(stmt[i]) && stmt[i][0] === 'result') i++
    const inner = stmt.slice(i)
    // Last item is the tail expression yielding the block's result. Drop it
    // from the lifted sequence — its only consumer is the sibling "drop".
    const stmts = inner.slice(0, inner.length - 1)
    const out = ['__seq__']
    for (const s of stmts) {
      const lifted = liftStmt(s, ctx)
      if (ctx.fail) return null
      if (lifted == null) continue
      if (Array.isArray(lifted) && lifted[0] === '__seq__') out.push(...lifted.slice(1))
      else out.push(lifted)
    }
    return out
  }

  // Standalone expression-as-statement (e.g. a load that gets dropped) — bail.
  ctx.fail = true; return null
}

/** Lift a value expression into v128 context. */
function liftExprV(expr, ctx) {
  if (!isArr(expr)) { ctx.fail = true; return null }
  const op = expr[0]
  const info = LANE_INFO[ctx.laneType]

  // Loads → v128.load (preserving address, including any local.tee).
  if (LOAD_OPS[op]) {
    if (LOAD_OPS[op] !== ctx.laneType) { ctx.fail = true; return null }
    return ['v128.load', expr[1]]
  }

  // Constants → splat.
  if (op === info.constOp) {
    return [info.splat, expr]
  }

  // local.get
  if (op === 'local.get' && typeof expr[1] === 'string') {
    const name = expr[1]
    const kind = ctx.localKind.get(name)
    if (kind === 'lane') {
      const { laneName } = getOrAllocLanedLocal(name, ctx)
      return ['local.get', laneName]
    }
    if (kind === 'invariant') {
      return [info.splat, ['local.get', name]]
    }
    if (kind === 'addr' || name === ctx.incVar) {
      ctx.fail = true; return null  // can't be in a value position
    }
    ctx.fail = true; return null
  }

  // Lane-pure op?
  const table = LANE_PURE[ctx.laneType]
  const entry = table?.get(op)
  if (entry) {
    const a = liftExprV(expr[1], ctx)
    if (ctx.fail) return null
    if (entry.shamtScalar) {
      // Second operand stays scalar i32 — must be const or invariant local.
      const b = expr[2]
      if (!isI32Const(b) && !(isArr(b) && b[0] === 'local.get' && ctx.localKind.get(b[1]) === 'invariant')) {
        ctx.fail = true; return null
      }
      return [entry.simd, a, b]
    }
    if (expr.length === 2) {  // unary (neg, abs, sqrt)
      return [entry.simd, a]
    }
    const b = liftExprV(expr[2], ctx)
    if (ctx.fail) return null
    return [entry.simd, a, b]
  }

  ctx.fail = true; return null
}

// ---- Pass entry ------------------------------------------------------------

/**
 * Walk a function looking for vectorizable (block (loop)) pairs, in-place.
 * Adds new locals to the function header.
 */
export function vectorizeLaneLocal(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Build local-name → wasm-type map.
  const fnLocals = new Map()
  for (let i = 2; i < bodyStart; i++) {
    const d = fn[i]
    if (isArr(d) && d[0] === 'local' && typeof d[1] === 'string' && typeof d[2] === 'string') {
      fnLocals.set(d[1], d[2])
    } else if (isArr(d) && d[0] === 'param' && typeof d[1] === 'string' && typeof d[2] === 'string') {
      fnLocals.set(d[1], d[2])
    }
  }

  const freshIdRef = { next: 0 }
  const newLocalDeclsAll = []

  // Walk body recursively. Process inner-most matches first (post-order)
  // so we don't try to vectorize an outer loop whose inner is the lane-local one.
  function walk(parent, idx) {
    const node = parent[idx]
    if (!isArr(node)) return
    for (let i = 0; i < node.length; i++) {
      if (isArr(node[i])) walk(node, i)
    }
    if (node[0] === 'block') {
      const r = tryVectorize(node, fnLocals, freshIdRef)
      if (r) {
        parent[idx] = r.wrapper
        newLocalDeclsAll.push(...r.newLocalDecls)
      }
    }
  }
  for (let i = bodyStart; i < fn.length; i++) walk(fn, i)

  if (newLocalDeclsAll.length) {
    fn.splice(bodyStart, 0, ...newLocalDeclsAll)
  }
}
