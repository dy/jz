import { cloneNode, walkAst } from '../../ast.js'
import { _offsetLocalStride, constNum, isI32Const, matchLaneAddr } from './addr-model.js'
import { isArr } from './node-utils.js'

// ---- memory.copy / memory.fill loop idioms ---------------------------------

// Register arithmetic over locals the loop never writes: one value every iteration.
// A copy or fill body sets no global, so a global reads the same throughout.
const INV_OPS = new Set(['i32.add', 'i32.sub', 'i32.mul', 'i32.shl', 'i32.and', 'i32.or'])
const invariant = (n, written) => isArr(n) && (n[0] === 'i32.const' || n[0] === 'global.get' && typeof n[1] === 'string'
  || n[0] === 'local.get' && typeof n[1] === 'string' && !written.has(n[1])
  || INV_OPS.has(n[0]) && n.length === 3 && invariant(n[1], written) && invariant(n[2], written))

/**
 * An address as one lane term, the IV or `IV << K`, plus loop-invariant terms:
 * an index an invariant offsets (`buf[start + k]`, `(i32.shl (i32.add start k) 3)`)
 * scales into a term of its own, `start << 3`, as the IV's term does (modulo 2^32
 * both ways). null where the IV is absent, appears twice, or is scaled otherwise.
 */
export function splitLane(a, iv, written) {
  if (!isArr(a)) return null
  if (a[0] === 'local.get' && a[1] === iv) return { strideLog2: 0, terms: [] }
  if (a[0] === 'i32.shl' && a.length === 3) {
    const k = constNum(a[2])
    const d = k != null && k >= 0 && k <= 3 ? splitLane(a[1], iv, written) : null
    return d && d.strideLog2 === 0 ? { strideLog2: k, terms: d.terms.map(t => ['i32.shl', t, ['i32.const', k]]) } : null
  }
  if (a[0] === 'i32.add' && a.length === 3)
    for (const [x, y] of [[a[1], a[2]], [a[2], a[1]]]) {
      if (!invariant(y, written)) continue
      const d = splitLane(x, iv, written)
      if (d) return { strideLog2: d.strideLog2, terms: [...d.terms, y] }
    }
  return null
}

// Same-width store←load pairs (byte-window moves) and their element stride.
// Sign-variant narrow loads are interchangeable for a MOVE: load8_u/load8_s
// then store8 write the same byte back.
const MEMOP_STORES = {
  'f64.store':   { k: 3, loads: new Set(['f64.load']) },
  'i64.store':   { k: 3, loads: new Set(['i64.load']) },
  'f32.store':   { k: 2, loads: new Set(['f32.load']) },
  'i32.store':   { k: 2, loads: new Set(['i32.load']) },
  'i32.store16': { k: 1, loads: new Set(['i32.load16_u', 'i32.load16_s']) },
  'i32.store8':  { k: 0, loads: new Set(['i32.load8_u', 'i32.load8_s']) },
}

/**
 * Replace whole copy/fill loops with the engine's bulk-memory ops:
 *
 *   for (i < N) a[i] = b[i]   →  memory.copy (overlap-guarded)
 *   for (i < N) a[i] = 0      →  memory.fill 0    (any element width)
 *   for (i < N) u8[i] = C     →  memory.fill C    (byte stores only)
 *
 * V8 lowers memory.copy/fill to memmove/memset — typically several times the
 * throughput of even a SIMD lane loop, and a handful of bytes instead of one.
 * Runs BEFORE the lane vectorizer so these loops never pay the lift.
 *
 * Exactness:
 *  - COPY moves the same byte window the scalar loop wrote (same-width
 *    store←load pairs only — see MEMOP_STORES; f64 load/store round-trips are
 *    bit-exact per spec, so NaN payloads survive). memory.copy is memmove
 *    (as-if-buffered); the FORWARD loop differs from that exactly when the
 *    destination starts strictly inside the source window (dst reads bytes an
 *    earlier iteration already overwrote), so that case keeps the original
 *    loop behind a two-compare runtime guard — every other layout (disjoint,
 *    dst ≤ src, same array) is bit-identical.
 *  - FILL with 0 is width-agnostic (all-zero bytes; −0.0 is excluded — its
 *    sign bit is not zero). Non-zero fills only for byte stores with a
 *    loop-invariant constant ∈ [0,255].
 *  - The induction variable ends at `bound` exactly as the loop would leave
 *    it; a zero-trip range (i ≥ bound) leaves everything untouched.
 *  - In-bounds for the same reason the lane vectorizer's wide loads are: the
 *    moved window is exactly the byte range the scalar iterations touch.
 */
export function tryMemCopyFill(bl, fnLocals, freshIdRef) {
  if (!bl || bl.preamble.length) return null   // no-preamble policy (was allowPreamble:false)
  const { loopNode, incVar, bound } = bl
  // Shape: [loop, $l, boundExit, (set,)? store, inc, br] — 1- or 2-statement body.
  if (loopNode.length !== 6 && loopNode.length !== 7) return null
  // Bound: const or an invariant local that is not the IV itself.
  if (!(isI32Const(bound) || (isArr(bound) && bound[0] === 'local.get' && typeof bound[1] === 'string' && bound[1] !== incVar))) return null

  // Body shapes (emit produces the two-statement form with a temp + shared
  // offset tee; fold/propagate sometimes collapse it to the bare store):
  //   1-stmt:  (T.store DADDR  CONST | (T.load SADDR))
  //   2-stmt:  (local.set $t (T.load SADDR)) (T.store DADDR (local.get $t))
  // Either access may carry a folded `offset=N` memarg (`out[5 + k]` emits
  // `(i32.store8 offset=5 (i32.add out k) …)`).
  const addrLocals = new Map(), offsetTees = new Map(), addrTees = new Map()
  const written = new Set([incVar])
  walkAst(loopNode, { enter: n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') written.add(n[1]) } })
  // A lane address as the bytes it starts at before the loop's first move: the
  // invariant terms it adds (`terms`), the memarg (`off`), and IV << strideLog2.
  // A whole address teed by the load is the store's too where the store reads it
  // back (`a[3 + i] = a[1 + i]`: one `a + i`, two memargs); only in the 2-stmt
  // form, where the load's statement runs before the store evaluates its address.
  const laneAddr = (a, off) => {
    const m = matchLaneAddr(a, incVar, addrLocals, offsetTees)
    if (m && isArr(m.base) && m.base[0] === 'local.get' && typeof m.base[1] === 'string' && !written.has(m.base[1]) && fnLocals.get(m.base[1]) === 'i32') {
      if (m.offsetTeeName) offsetTees.set(m.offsetTeeName, m.strideLog2)
      if (m.teeName) {
        addrTees.set(m.teeName, m.base)
        if (tempName != null) addrLocals.set(m.teeName, { strideLog2: m.strideLog2, base: m.base })
      }
      return { strideLog2: m.strideLog2, terms: [m.base], off }
    }
    const d = splitLane(a, incVar, written)
    return d && { ...d, off }
  }
  const memOp = (n) => typeof n[1] === 'string' && n[1].startsWith('offset=')
    ? { off: +n[1].slice(7), addr: n[2], rest: n.slice(3) } : { off: 0, addr: n[1], rest: n.slice(2) }
  let storeStmt, valNode, tempName = null
  if (loopNode.length === 6) {
    storeStmt = loopNode[3]
    if (!isArr(storeStmt) || memOp(storeStmt).rest.length !== 1) return null
    valNode = memOp(storeStmt).rest[0]
  } else {
    const s1 = loopNode[3]
    storeStmt = loopNode[4]
    if (!isArr(s1) || s1[0] !== 'local.set' || s1.length !== 3 || typeof s1[1] !== 'string') return null
    if (!isArr(storeStmt) || memOp(storeStmt).rest.length !== 1) return null
    const v = memOp(storeStmt).rest[0]
    if (!(isArr(v) && v[0] === 'local.get' && v[1] === s1[1])) return null
    tempName = s1[1]
    if (tempName === incVar) return null
    valNode = s1[2]
  }
  const entry = MEMOP_STORES[storeStmt[0]]
  if (!entry) return null

  // Classify VALUE first (the load side carries the offset tee in the 2-stmt form).
  let fillByte = null, srcM = null
  if (isArr(valNode) && valNode.length === 2 && (valNode[0] === 'i32.const' || valNode[0] === 'i64.const' || valNode[0] === 'f64.const' || valNode[0] === 'f32.const') && typeof valNode[1] === 'number') {
    if (valNode[1] === 0 && !Object.is(valNode[1], -0)) fillByte = 0
    else if (storeStmt[0] === 'i32.store8' && valNode[0] === 'i32.const' && Number.isInteger(valNode[1]) && valNode[1] >= 0 && valNode[1] <= 255) fillByte = valNode[1]
    else return null
  } else if (isArr(valNode) && entry.loads.has(valNode[0]) && memOp(valNode).rest.length === 0) {
    const ld = memOp(valNode)
    srcM = laneAddr(ld.addr, ld.off)
    if (!srcM || srcM.strideLog2 !== entry.k) return null
  } else return null

  const st = memOp(storeStmt)
  const dstM = laneAddr(st.addr, st.off)
  if (!dstM || dstM.strideLog2 !== entry.k) return null
  // Soundness for any shared offset tee resolved via `(local.get $T)` (see tryVectorize).
  for (const [name, k] of offsetTees) {
    if (_offsetLocalStride([loopNode[3], storeStmt], name, incVar) !== k) return null
  }

  const id = freshIdRef.next++
  const lenB = `$__mc${id}_len`, dstA = `$__mc${id}_dst`
  const newLocalDecls = [['local', lenB, 'i32'], ['local', dstA, 'i32']]
  const shl = (x) => entry.k === 0 ? x : ['i32.shl', x, ['i32.const', entry.k]]
  const boundC = () => cloneNode(bound)
  // The window's first byte at IV = 0. The memarg joins the i32 sum: the scalar
  // accesses are in bounds (a raw store or load the emitter left unguarded was
  // proven so), so base + offset stays below the memory's size and never wraps.
  const startOf = (m) => [...m.terms.map(cloneNode), ...(m.off ? [['i32.const', m.off]] : [])]
    .reduce((a, b) => ['i32.add', a, b], ['i32.const', 0])
  const at = (m, off) => ['i32.add', startOf(m), off]
  const setup = [
    ['local.set', lenB, shl(['i32.sub', boundC(), ['local.get', incVar]])],
    ['local.set', dstA, at(dstM, shl(['local.get', incVar]))],
  ]
  // Exact loop-exit state: i ends at bound; a matched offset tee holds the
  // LAST iteration's offset; the value temp holds the last element moved.
  const finish = [['local.set', incVar, boundC()]]
  const lastOff = () => shl(['i32.sub', boundC(), ['i32.const', 1]])
  for (const name of offsetTees.keys()) finish.push(['local.set', name, lastOff()])
  for (const [name, base] of addrTees) finish.push(['local.set', name, ['i32.add', cloneNode(base), lastOff()]])
  if (tempName != null && srcM) finish.push(['local.set', tempName, [valNode[0], at(srcM, lastOff())]])
  if (tempName != null && srcM == null) finish.push(['local.set', tempName, cloneNode(valNode)])

  let action
  if (srcM == null) {
    action = [['memory.fill', ['local.get', dstA], ['i32.const', fillByte], ['local.get', lenB]], ...finish]
  } else {
    const srcA = `$__mc${id}_src`
    newLocalDecls.push(['local', srcA, 'i32'])
    setup.push(['local.set', srcA, at(srcM, shl(['local.get', incVar]))])
    // Forward-loop ≡ memmove unless dst starts strictly inside (src, src+len).
    action = [['if',
      ['i32.or',
        ['i32.le_u', ['local.get', dstA], ['local.get', srcA]],
        ['i32.ge_u', ['local.get', dstA], ['i32.add', ['local.get', srcA], ['local.get', lenB]]]],
      ['then',
        ['memory.copy', ['local.get', dstA], ['local.get', srcA], ['local.get', lenB]],
        ...finish],
      ['else', bl.blockNode]]]
  }

  const wrapper = ['block',
    ['if', ['i32.lt_s', ['local.get', incVar], boundC()],
      ['then', ...setup, ...action]]]
  return { wrapper, newLocalDecls }
}
