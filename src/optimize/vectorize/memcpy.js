import { cloneNode } from '../../ast.js'
import { _offsetLocalStride, isI32Const, matchLaneAddr } from './addr-model.js'
import { isArr } from './node-utils.js'

// ---- memory.copy / memory.fill loop idioms ---------------------------------

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
  const addrLocals = new Map(), offsetTees = new Map()
  const laneAddr = (a) => {
    const m = matchLaneAddr(a, incVar, addrLocals, offsetTees)
    if (!m || m.viaLocal) return null
    if (m.offsetTeeName) offsetTees.set(m.offsetTeeName, m.strideLog2)
    if (!(isArr(m.base) && m.base[0] === 'local.get' && typeof m.base[1] === 'string' && m.base[1] !== incVar)) return null
    if (fnLocals.get(m.base[1]) !== 'i32') return null
    return m
  }
  let storeStmt, valNode, tempName = null
  if (loopNode.length === 6) {
    storeStmt = loopNode[3]
    if (!isArr(storeStmt) || storeStmt.length !== 3) return null
    valNode = storeStmt[2]
  } else {
    const s1 = loopNode[3]
    storeStmt = loopNode[4]
    if (!isArr(s1) || s1[0] !== 'local.set' || s1.length !== 3 || typeof s1[1] !== 'string') return null
    if (!isArr(storeStmt) || storeStmt.length !== 3) return null
    if (!(isArr(storeStmt[2]) && storeStmt[2][0] === 'local.get' && storeStmt[2][1] === s1[1])) return null
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
  } else if (isArr(valNode) && valNode.length === 2 && entry.loads.has(valNode[0])) {
    srcM = laneAddr(valNode[1])
    if (!srcM || srcM.strideLog2 !== entry.k) return null
  } else return null

  const dstM = laneAddr(storeStmt[1])
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
  const setup = [
    ['local.set', lenB, shl(['i32.sub', boundC(), ['local.get', incVar]])],
    ['local.set', dstA, ['i32.add', ['local.get', dstM.base[1]], shl(['local.get', incVar])]],
  ]
  // Exact loop-exit state: i ends at bound; a matched offset tee holds the
  // LAST iteration's offset; the value temp holds the last element moved.
  const finish = [['local.set', incVar, boundC()]]
  const lastOff = () => shl(['i32.sub', boundC(), ['i32.const', 1]])
  for (const name of offsetTees.keys()) finish.push(['local.set', name, lastOff()])
  if (tempName != null && srcM) finish.push(['local.set', tempName,
    [valNode[0], ['i32.add', ['local.get', srcM.base[1]], lastOff()]]])
  if (tempName != null && srcM == null) finish.push(['local.set', tempName, cloneNode(valNode)])

  let action
  if (srcM == null) {
    action = [['memory.fill', ['local.get', dstA], ['i32.const', fillByte], ['local.get', lenB]], ...finish]
  } else {
    const srcA = `$__mc${id}_src`
    newLocalDecls.push(['local', srcA, 'i32'])
    setup.push(['local.set', srcA, ['i32.add', ['local.get', srcM.base[1]], shl(['local.get', incVar])]])
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
