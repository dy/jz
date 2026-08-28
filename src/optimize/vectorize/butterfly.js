import { walkAst } from '../../ast.js'
import { constNum, isLocalGet } from './addr-model.js'
import { isArr } from './node-utils.js'

// ---- Radix-2 butterfly 2-wide lift (tryButterfly) ----
//
// The Cooley-Tukey inner loop — the one shape the generic lane lift can never take:
// a DUAL-IV scaffold (`j++` carries the exit test, `k += STEP` walks the twiddle
// table) with an in-place complex-rotation update over four disjoint streams
// (re/im × a/b, b = a + HALF, twiddles wre/wim read-only). Lanes j and j+1:
//   - every a/b access is an ADJACENT pair → one v128.load / v128.store,
//   - the twiddle pair is strided by STEP → two scalar f64.loads + lane combine
//     (same load count as two scalar iterations),
//   - the +/−/× rotation lanes with NO reassociation and NO fusion — each lane
//     computes the exact scalar sequence, so the result is bit-identical and the
//     cross-engine checksum contract holds.
// LEGALITY. The strip body runs only while j+1 < half, so b = a + half ≥ a + 2:
// {a,a+1} and {b,b+1} never overlap — the b-pair stores cannot clobber lane 1's
// a-pair loads, and the single im[a] pair load legitimately serves both the
// im[b] store and the im[a] writeback (im[a] ∉ {im[b−1], im[b]}). re/im/wre/wim
// are distinct base locals under the vectorizer's standing distinct-base
// non-aliasing model. HALF/STEP and the four bases must not be written in the
// loop (checked); j/k are exactly reproduced for the scalar tail (each strip
// iteration consumes two scalar iterations), and the tail IS the original loop,
// so an odd half (or half < 2) falls through untouched.
export function tryButterfly(blockNode, fnLocals, freshIdRef) {
  if (!isArr(blockNode) || blockNode[0] !== 'block' || typeof blockNode[1] !== 'string') return null
  const brk = blockNode[1]
  if (blockNode.length !== 3 || !isArr(blockNode[2]) || blockNode[2][0] !== 'loop') return null
  const loop = blockNode[2]
  const lbl = loop[1]
  if (typeof lbl !== 'string') return null
  // scaffold: (loop $L (br_if $brk (i32.eqz (i32.lt_s J HALF))) BODY×17 INC 'drop' (br $L))
  const exit = loop[2]
  if (!isArr(exit) || exit[0] !== 'br_if' || exit[1] !== brk) return null
  const ez = exit[2]
  if (!isArr(ez) || ez[0] !== 'i32.eqz' || !isArr(ez[1]) || ez[1][0] !== 'i32.lt_s') return null
  const [, jGet, halfGet] = ez[1]
  if (!isLocalGet(jGet) || !isLocalGet(halfGet)) return null
  const J = jGet[1], HALF = halfGet[1]
  const end = loop.length - 1
  if (!isArr(loop[end]) || loop[end][0] !== 'br' || loop[end][1] !== lbl) return null
  if (loop[end - 1] !== 'drop') return null
  // inc: (block (result i32) (drop (i32.sub (local.tee J (i32.add J 1)) 1)) (local.tee K (i32.add K STEP)))
  const inc = loop[end - 2]
  if (!isArr(inc) || inc[0] !== 'block' || !isArr(inc[1]) || inc[1][0] !== 'result' || inc.length !== 4) return null
  const jInc = inc[2], kInc = inc[3]
  if (!isArr(jInc) || jInc[0] !== 'drop' || !isArr(jInc[1]) || jInc[1][0] !== 'i32.sub') return null
  const jTee = jInc[1][1]
  if (!isArr(jTee) || jTee[0] !== 'local.tee' || jTee[1] !== J || !isArr(jTee[2]) || jTee[2][0] !== 'i32.add'
      || !isLocalGet(jTee[2][1], J) || constNum(jTee[2][2]) !== 1) return null
  if (!isArr(kInc) || kInc[0] !== 'local.tee' || !isArr(kInc[2]) || kInc[2][0] !== 'i32.add') return null
  const K = kInc[1]
  if (typeof K !== 'string' || !isLocalGet(kInc[2][1], K) || !isLocalGet(kInc[2][2])) return null
  const STEP = kInc[2][2][1]
  const body = loop.slice(3, end - 2)
  if (body.length !== 17) return null

  // unification environment over the exact emit shapes
  const U = {}
  const bind = (name, v) => U[name] === undefined ? (U[name] = v, true) : U[name] === v
  const idx8 = (n, base, iv) => isArr(n) && n[0] === 'i32.add'
    && isLocalGet(n[1]) && bind(base, n[1][1])
    && isArr(n[2]) && n[2][0] === 'i32.shl' && isLocalGet(n[2][1]) && bind(iv, n[2][1][1])
    && constNum(n[2][2]) === 3
  const setF64Load = (st, name, base, iv, ab) => {
    if (!isArr(st) || st[0] !== 'local.set' || st.length !== 3 || !isArr(st[2]) || st[2][0] !== 'f64.load') return false
    let addr = st[2][1]
    if (ab != null) {
      if (!isArr(addr) || addr[0] !== 'local.tee') return false
      if (!bind(ab, addr[1])) return false
      addr = addr[2]
    }
    if (!idx8(addr, base, iv)) return false
    return bind(name, st[1])
  }
  const g = (n, name) => isLocalGet(n) && U[name] !== undefined && n[1] === U[name]
  const mulPair = (n, x, y) => isArr(n) && n[0] === 'f64.mul' && g(n[1], x) && g(n[2], y)
  const setArith = (st, name, op, mk) => {
    if (!isArr(st) || st[0] !== 'local.set' || st.length !== 3 || !isArr(st[2]) || st[2][0] !== op) return false
    if (!mk(st[2])) return false
    return bind(name, st[1])
  }
  // flat pair: (local.set T (op LHS VAL)) ; (f64.store (local.get AB) (local.get T))
  const storePair = (setSt, stoSt, op, lhs, val2, ab) => {
    if (!isArr(setSt) || setSt[0] !== 'local.set' || !isArr(setSt[2]) || setSt[2][0] !== op) return false
    const e = setSt[2]
    if (!lhs(e[1]) || !g(e[2], val2)) return false
    if (!isArr(stoSt) || stoSt[0] !== 'f64.store' || !g(stoSt[1], ab) || !isLocalGet(stoSt[2], setSt[1])) return false
    return true
  }

  if (!setF64Load(body[0], 'WR', 'WRE', 'K0', null) || U.K0 !== K) return null
  if (!setF64Load(body[1], 'WI', 'WIM', 'K1', null) || U.K1 !== K) return null
  {  // a = I + j (either order), I ≠ J
    const st = body[2]
    if (!isArr(st) || st[0] !== 'local.set' || !isArr(st[2]) || st[2][0] !== 'i32.add') return null
    const [, l, r] = st[2]
    if (isLocalGet(l) && isLocalGet(r, J) && l[1] !== J) U.I = l[1]
    else if (isLocalGet(r) && isLocalGet(l, J) && r[1] !== J) U.I = r[1]
    else return null
    U.A = st[1]
  }
  {  // b = a + half (either order)
    const st = body[3]
    if (!isArr(st) || st[0] !== 'local.set' || !isArr(st[2]) || st[2][0] !== 'i32.add') return null
    const [, l, r] = st[2]
    if (!((isLocalGet(l, U.A) && isLocalGet(r, HALF)) || (isLocalGet(r, U.A) && isLocalGet(l, HALF)))) return null
    U.B = st[1]
  }
  if (!setF64Load(body[4], 'XR', 'RE', 'B0', 'AB4') || U.B0 !== U.B) return null
  if (!setF64Load(body[5], 'XI', 'IM', 'B1', 'AB5') || U.B1 !== U.B) return null
  if (!setArith(body[6], 'TR', 'f64.sub', e => mulPair(e[1], 'WR', 'XR') && mulPair(e[2], 'WI', 'XI'))) return null
  if (!setArith(body[7], 'TI', 'f64.add', e => mulPair(e[1], 'WR', 'XI') && mulPair(e[2], 'WI', 'XR'))) return null
  if (!setF64Load(body[8], 'C0', 'RE', 'A0', 'AB6') || U.A0 !== U.A) return null
  const c0lhs = (n) => g(n, 'C0')
  const ab7teeLhs = (n) => {  // (f64.load (local.tee AB7 (im + a<<3)))
    if (!isArr(n) || n[0] !== 'f64.load' || !isArr(n[1]) || n[1][0] !== 'local.tee') return false
    if (!bind('AB7', n[1][1])) return false
    return idx8(n[1][2], 'IM', 'A2') && U.A2 === U.A
  }
  const ab7getLhs = (n) => isArr(n) && n[0] === 'f64.load' && g(n[1], 'AB7')
  if (!storePair(body[9], body[10], 'f64.sub', c0lhs, 'TR', 'AB4')) return null
  if (!storePair(body[11], body[12], 'f64.sub', ab7teeLhs, 'TI', 'AB5')) return null
  if (!storePair(body[13], body[14], 'f64.add', c0lhs, 'TR', 'AB6')) return null
  if (!storePair(body[15], body[16], 'f64.add', ab7getLhs, 'TI', 'AB7')) return null
  // loop-invariance: the four bases, HALF/STEP and the outer offset I are never written in the body
  const invariants = new Set([U.RE, U.IM, U.WRE, U.WIM, HALF, STEP, U.I].filter(x => typeof x === 'string'))
  if (invariants.size !== 7) return null
  let clobbered = false
  const wscan = n => {
    if (clobbered) return false
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && invariants.has(n[1])) { clobbered = true; return false }
  }
  for (const st of body) walkAst(st, { enter: wscan })
  if (clobbered) return null
  if (new Set([U.RE, U.IM, U.WRE, U.WIM]).size !== 4) return null

  const id = freshIdRef.next++
  const nm = (t) => `$__bf${id}_${t}`
  const L = (x) => ['local.get', x]
  const addr = (base, iv) => ['i32.add', L(base), ['i32.shl', L(iv), ['i32.const', 3]]]
  const twiddle = (base) => ['f64x2.replace_lane', 1,
    ['f64x2.splat', ['f64.load', addr(base, K)]],
    ['f64.load', ['i32.add', L(base), ['i32.shl', ['i32.add', L(K), L(STEP)], ['i32.const', 3]]]]]
  const wrv = nm('wrv'), wiv = nm('wiv'), xrv = nm('xrv'), xiv = nm('xiv')
  const trv = nm('trv'), tiv = nm('tiv'), c0v = nm('c0v'), iav = nm('iav')
  const av = nm('a'), bv = nm('b'), vl = nm('L'), strip = nm('go')
  const newLocalDecls = [
    ['local', wrv, 'v128'], ['local', wiv, 'v128'], ['local', xrv, 'v128'], ['local', xiv, 'v128'],
    ['local', trv, 'v128'], ['local', tiv, 'v128'], ['local', c0v, 'v128'], ['local', iav, 'v128'],
    ['local', av, 'i32'], ['local', bv, 'i32'],
  ]
  const stripGuard = () => ['i32.lt_s', ['i32.add', L(J), ['i32.const', 1]], L(HALF)]
  const vbody = [
    ['local.set', wrv, twiddle(U.WRE)],
    ['local.set', wiv, twiddle(U.WIM)],
    ['local.set', av, ['i32.add', L(U.I), L(J)]],
    ['local.set', bv, ['i32.add', L(av), L(HALF)]],
    ['local.set', xrv, ['v128.load', addr(U.RE, bv)]],
    ['local.set', xiv, ['v128.load', addr(U.IM, bv)]],
    ['local.set', trv, ['f64x2.sub', ['f64x2.mul', L(wrv), L(xrv)], ['f64x2.mul', L(wiv), L(xiv)]]],
    ['local.set', tiv, ['f64x2.add', ['f64x2.mul', L(wrv), L(xiv)], ['f64x2.mul', L(wiv), L(xrv)]]],
    ['local.set', c0v, ['v128.load', addr(U.RE, av)]],
    ['v128.store', addr(U.RE, bv), ['f64x2.sub', L(c0v), L(trv)]],
    ['local.set', iav, ['v128.load', addr(U.IM, av)]],
    ['v128.store', addr(U.IM, bv), ['f64x2.sub', L(iav), L(tiv)]],
    ['v128.store', addr(U.RE, av), ['f64x2.add', L(c0v), L(trv)]],
    ['v128.store', addr(U.IM, av), ['f64x2.add', L(iav), L(tiv)]],
    ['local.set', J, ['i32.add', L(J), ['i32.const', 2]]],
    ['local.set', K, ['i32.add', L(K), ['i32.add', L(STEP), L(STEP)]]],
    ['br_if', vl, stripGuard()],
  ]
  const wrapper = ['block',
    ['block', strip,
      ['br_if', strip, ['i32.eqz', stripGuard()]],
      ['loop', vl, ...vbody]],
    blockNode]  // the ORIGINAL loop is the scalar tail: 0..1 leftover iterations, or everything when half < 2
  return { wrapper, newLocalDecls }
}

