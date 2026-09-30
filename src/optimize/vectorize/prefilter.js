import { cloneNode, walkAst } from '../../ast.js'
import { constNum, hasGlobalSet, isI32Const } from './addr-model.js'
import { isArr } from './node-utils.js'
import { simdBound } from './scaffold.js'

// ---- Prefilter: skip the spans a guarded body never runs on --------------------
//
// A scan loop tests an element and, rarely, does real work:
//   for (let x = 1; x < W - 1; x++)
//     if (bmp[r + x] === 1 && bmp[r + x - 1] === 0 && !seen[r + x]) trace(…)
// The first test of the guard runs on every element; everything behind it runs
// only where that test holds. Sixteen elements answer it at once: where no lane
// holds, the scalar loop would have done nothing on the whole span, so the
// counter steps over it. Where a lane holds, the loop's own statement runs from
// that element to the end of the span, tests included, so whatever the body
// changes is seen exactly as the scalar loop sees it.
//
//   (loop $pf
//     (br_if $done (i32.ge_s x END))
//     (if (i32.eqz (tee m (bitmask TEST))) (then x += LANES, (br $pf)))
//     stop = x + LANES, x += ctz(m)
//     (loop $in STATEMENT, x += 1, (br_if $in (i32.lt_s x stop)))
//     (br $pf))
//   original loop                       ; the remainder
//
// The vector test reads the elements the scalar test reads, no others. The body
// is heavy (a call or a loop): work that size behind a test says the test is
// rare. It leaves the loop only through its exit test, and writes neither the
// counter nor the bound.

const LANES = {
  'i32.load8_u': { shape: 'i8x16', lanes: 16, stride: 1, lo: 0, hi: 255, sign: 'u' },
  'i32.load8_s': { shape: 'i8x16', lanes: 16, stride: 1, lo: -128, hi: 127, sign: 's' },
  'i32.load16_u': { shape: 'i16x8', lanes: 8, stride: 2, lo: 0, hi: 65535, sign: 'u' },
  'i32.load16_s': { shape: 'i16x8', lanes: 8, stride: 2, lo: -32768, hi: 32767, sign: 's' },
  'i32.load': { shape: 'i32x4', lanes: 4, stride: 4, lo: -2147483648, hi: 2147483647, sign: 's' },
}
// The scalar comparison of a widened element, as its lane comparison. An ordered
// test of a narrow element follows the element's signedness, whichever i32 test
// the scalar used: both agree on values inside the element's range. An unsigned
// test of a sign-extended element reads its negatives as large, which no narrow
// lane does; a whole word compares as the scalar says.
const COMPARE = {
  'i32.eq': 'eq', 'i32.ne': 'ne',
  'i32.lt_s': 'lt', 'i32.gt_s': 'gt', 'i32.le_s': 'le', 'i32.ge_s': 'ge',
  'i32.lt_u': 'lt', 'i32.gt_u': 'gt', 'i32.le_u': 'le', 'i32.ge_u': 'ge',
}
const FLIP = { eq: 'eq', ne: 'ne', lt: 'gt', gt: 'lt', le: 'ge', ge: 'le' }

/** The first test of a guard: the innermost condition of its `&&` chain. */
const firstTest = c => {
  const zeros = []
  while (isArr(c) && c[0] === 'if' && c.length === 5 && isArr(c[1]) && c[1][0] === 'result' && c[1][1] === 'i32' &&
      isArr(c[3]) && c[3][0] === 'then' && isArr(c[4]) && c[4][0] === 'else' && c[4].length === 2) {
    const z = c[4][1], condition = c[2]
    if (isI32Const(z) && constNum(z) === 0) c = condition
    else if (z?.[0] === 'local.get' && condition?.[0] === 'local.tee' && z[1] === condition[1]) {
      // Value-preserving && writes its false predicate even when no body
      // runs. A skipped span must leave the same zero in that local.
      zeros.push(condition[1])
      c = condition[2]
    } else break
  }
  return { test: c, zeros }
}

/** Whether `addr` moves `stride` bytes per step of `x` over terms the loop leaves alone. */
function affine(addr, x, stride, writes) {
  let coeff = 0, ok = true
  const add = (n, m) => {
    if (!ok) return
    if (isI32Const(n)) return
    if (isArr(n) && n[0] === 'local.get') { if (n[1] === x) coeff += m; else if (writes.has(n[1])) ok = false; return }
    if (isArr(n) && n[0] === 'global.get') return
    if (isArr(n) && (n[0] === 'i32.add' || n[0] === 'i32.sub') && n.length === 3) { add(n[1], m); add(n[2], n[0] === 'i32.add' ? m : -m); return }
    if (isArr(n) && n[0] === 'i32.shl' && n.length === 3 && isI32Const(n[2])) return add(n[1], m << (constNum(n[2]) & 31))
    if (isArr(n) && n[0] === 'i32.mul' && n.length === 3 && isI32Const(n[2])) return add(n[1], Math.imul(m, constNum(n[2])))
    if (isArr(n) && n[0] === 'i32.mul' && n.length === 3 && isI32Const(n[1])) return add(n[2], Math.imul(m, constNum(n[1])))
    ok = false
  }
  add(addr, 1)
  return ok && coeff === stride
}

/** The lane test of `a` over the counter `x`: { test, lanes, shape }, or null. */
function laneTest(a, x, writes) {
  if (!isArr(a)) return null
  let load = null, k = null, cmp = null
  if (LANES[a[0]]) { load = a; k = ['i32.const', 0]; cmp = 'ne' }          // a bare element: non-zero
  else if (COMPARE[a[0]] && a.length === 3) {
    if (isArr(a[1]) && LANES[a[1][0]]) { load = a[1]; k = a[2]; cmp = COMPARE[a[0]] }
    else if (isArr(a[2]) && LANES[a[2][0]]) { load = a[2]; k = a[1]; cmp = FLIP[COMPARE[a[0]]] }
  } else if (a[0] === 'i32.eqz' && a.length === 2 && isArr(a[1]) && LANES[a[1][0]]) { load = a[1]; k = ['i32.const', 0]; cmp = 'eq' }
  if (!load || load.length !== 2) return null
  const info = LANES[load[0]]
  // The constant sits inside the element's range, so the lane holds it as the scalar does.
  if (!isI32Const(k) || constNum(k) < info.lo || constNum(k) > info.hi) return null
  const unsigned = a[0].endsWith('_u')
  if (unsigned && info.sign === 's' && info.stride < 4) return null
  // An address the scalar keeps in a temp is its value here: the lanes write no local.
  let addr = load[1]
  while (isArr(addr) && addr[0] === 'local.tee' && addr.length === 3) addr = addr[2]
  if (!affine(addr, x, info.stride, writes)) return null
  const sign = info.stride === 4 ? (unsigned ? 'u' : 's') : info.sign
  const op = cmp === 'eq' || cmp === 'ne' ? `${info.shape}.${cmp}` : `${info.shape}.${cmp}_${sign}`
  return { ...info, test: [op, ['v128.load', cloneNode(addr)], [`${info.shape}.splat`, ['i32.const', constNum(k)]]] }
}

/** Whether `body` leaves only through labels of its own, and returns nowhere. */
function staysInside(body) {
  const own = new Set()
  let ok = true
  walkAst(body, { enter: n => { if ((n[0] === 'block' || n[0] === 'loop' || n[0] === 'if') && typeof n[1] === 'string') own.add(n[1]) } })
  walkAst(body, { enter: n => {
    const op = n[0]
    if (op === 'return' || op === 'return_call' || op === 'return_call_indirect' || op === 'throw' || op === 'rethrow' || op === 'try_table' || op === 'try') ok = false
    else if (op === 'br' || op === 'br_if') { if (!own.has(n[1])) ok = false }
    else if (op === 'br_table') { for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string' && !own.has(n[i])) ok = false }
  } })
  return ok
}

export function tryPrefilter(bl, fnLocals, freshIdRef) {
  if (!bl) return null
  const { incVar, bound, boundLocal, body, preamble, blockNode } = bl
  if (!boundLocal && !isI32Const(bound)) return null
  if (body.length !== 1) return null
  const stmt = body[0]
  if (!isArr(stmt) || stmt[0] !== 'if' || stmt.length !== 3 || !isArr(stmt[2]) || stmt[2][0] !== 'then') return null
  const guarded = stmt[2]
  // Heavy work behind the test.
  let heavy = false
  walkAst(guarded, { enter: n => { if (n[0] === 'call' || n[0] === 'call_indirect' || n[0] === 'loop') heavy = true } })
  if (!heavy || hasGlobalSet(guarded) || !staysInside(guarded)) return null
  // The guarded work may write anything but the counter and the bound.
  const writes = new Set()
  walkAst(stmt, { enter: n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') writes.add(n[1]) } })
  if (writes.has(incVar) || (boundLocal && writes.has(boundLocal))) return null
  const first = firstTest(stmt[1]), t = laneTest(first.test, incVar, writes)
  if (!t) return null

  const id = freshIdRef.next++
  const end = `$__pf_end${id}`, stop = `$__pf_stop${id}`, mask = `$__pf_m${id}`
  const x = () => ['local.get', incVar]
  const step = n => ['local.set', incVar, ['i32.add', x(), n]]
  const scan = ['block', `$__pf_brk${id}`,
    ['loop', `$__pf_loop${id}`,
      ['br_if', `$__pf_brk${id}`, ['i32.ge_s', x(), ['local.get', end]]],
      ['if', ['i32.eqz', ['local.tee', mask, [`${t.shape}.bitmask`, t.test]]],
        ['then', ...first.zeros.map(name => ['local.set', name, ['i32.const', 0]]),
          step(['i32.const', t.lanes]), ['br', `$__pf_loop${id}`]]],
      ['local.set', stop, ['i32.add', x(), ['i32.const', t.lanes]]],
      step(['i32.ctz', ['local.get', mask]]),
      ['loop', `$__pf_in${id}`,
        cloneNode(stmt),
        step(['i32.const', 1]),
        ['br_if', `$__pf_in${id}`, ['i32.lt_s', x(), ['local.get', stop]]]],
      ['br', `$__pf_loop${id}`]]]
  const wrapper = ['block', ...preamble.map(cloneNode),
    ['local.set', end, simdBound(incVar, bound, t.lanes)],
    scan, blockNode]
  return { wrapper, newLocalDecls: [['local', end, 'i32'], ['local', stop, 'i32'], ['local', mask, 'i32']] }
}
