/**
 * A round's last store to an address its next round reads first passes the
 * value through a local (speed tier):
 *
 *   (loop $L
 *     …(f64.load A)…                      the round reads A before it writes memory
 *     …
 *     (f64.store (local.tee $p A) V)      and stores it last: no later store or
 *     (f64.store offset=8 (local.get $p) W)  call that could reach A, no write of
 *     (br_if $L C))                        A's locals, on the way to the latch
 *
 * becomes
 *
 *   (if P (then (local.set $c (f64.load A))))
 *   (loop $L
 *     …(local.get $c)…
 *     …
 *     (f64.store (local.tee $p A) (local.tee $c V))
 *     (f64.store offset=8 (local.get $p) W)
 *     (br_if $L C))
 *
 * A monotone stack's top (a lower envelope's last boundary, `z[k] = s`, which
 * the next round's pop test reads), a state kept in memory across samples: the
 * next round reads back what this one stored, through the store queue, where a
 * register would hand it over. V8 forwards no value across a back edge.
 *
 * Exact. A is an address of locals and literals, the load and the store the
 * same width and offset. The store sits in the loop body's own statement list,
 * so every round that reaches the latch, the loop's one branch to its head,
 * runs it and what follows it, and none of that writes A's locals, calls, or
 * stores but at A's own address (a `local.tee` of A names it) at offsets that
 * miss the stored bytes: each round starts with $c equal to the memory at A.
 * The load reads A before the round writes memory, calls, or writes A's
 * locals, inside conditionals and blocks of the round but no loop, and no
 * branch comes before it on its way. P is the conjunction of the tests of the
 * conditionals around it, reading only locals the round has not written by
 * then: the first round loads A exactly where it would have, from the memory
 * and locals it would have, and the rounds after it read $c.
 *
 * @module optimize/carry-stores
 */
import { nextLocalId, findBodyStart } from '../ir.js'

const isArr = Array.isArray
const LOADS = new Set(['i32.load', 'i64.load', 'f32.load', 'f64.load'])
const STORE_OF = { 'i32.store': 'i32.load', 'i64.store': 'i64.load', 'f32.store': 'f32.load', 'f64.store': 'f64.load' }
const WIDTH = { 'i32.load': 4, 'i64.load': 8, 'f32.load': 4, 'f64.load': 8 }
const TYPE = { 'i32.load': 'i32', 'i64.load': 'i64', 'f32.load': 'f32', 'f64.load': 'f64' }
// an address of locals and literals
const PURE = new Set(['local.get', 'i32.const', 'i32.add', 'i32.sub', 'i32.mul', 'i32.shl', 'i32.and', 'i32.or'])
const BRANCH = new Set(['br', 'br_if', 'br_table', 'return', 'unreachable', 'throw', 'throw_ref', 'rethrow', 'return_call', 'return_call_indirect', 'return_call_ref', 'try', 'try_table'])

// the bytes each store writes; another store may reach anything
const STORE_W = { 'i32.store': 4, 'i64.store': 8, 'f32.store': 4, 'f64.store': 8, 'i32.store8': 1, 'i32.store16': 2, 'i64.store8': 1, 'i64.store16': 2, 'i64.store32': 4, 'v128.store': 16 }

const label = (n) => typeof n[1] === 'string' && n[1][0] === '$' ? n[1] : null
const typed = (n) => n.some((c, i) => i > 0 && isArr(c) && (c[0] === 'result' || c[0] === 'param' || c[0] === 'type'))
const some = (n, f) => isArr(n) && (f(n) || n.some((c, i) => i > 0 && some(c, f)))
const clone = (n) => isArr(n) ? n.map(clone) : n
const same = (a, b) => {
  if (!isArr(a) || !isArr(b)) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false
  return true
}
const pure = (e) => isArr(e) && PURE.has(e[0]) && e.every((c, i) => i === 0 || !isArr(c) || pure(c))
const localsOf = (e, out) => { if (isArr(e)) { if (e[0] === 'local.get') out.add(e[1]); for (let i = 1; i < e.length; i++) localsOf(e[i], out) } return out }
const writesAny = (n, names) => some(n, m => (m[0] === 'local.set' || m[0] === 'local.tee') && names.has(m[1]))
const calls = (n) => some(n, m => typeof m[0] === 'string' && (m[0].startsWith('call') || m[0].startsWith('return_call')))
const memOp = (n) => some(n, m => typeof m[0] === 'string' && (m[0].indexOf('.store') > 0 || m[0].startsWith('memory.') || m[0].indexOf('.atomic') > 0))

/** An access `(op offset=o … ADDR …)`: { op, off, addr, rest } with the immediates read, or null. */
const access = (n) => {
  if (!isArr(n)) return null
  let i = 1, off = 0
  for (; typeof n[i] === 'string'; i++) {
    if (n[i].startsWith('offset=')) off += Number(n[i].slice(7))
    else if (!n[i].startsWith('align=')) return null
  }
  return { op: n[0], off, at: i, addr: n[i] }
}
/** The address an access names: A itself, A through `local.tee`, or a local `alias` holds. */
const addrOf = (a, alias) => {
  if (isArr(a) && a[0] === 'local.tee' && a.length === 3) return a[2]
  if (isArr(a) && a[0] === 'local.get' && alias.has(a[1])) return alias.get(a[1])
  return a
}

/** Carry the value of `loop` (child `pos` of `parent`) that its rounds store last and read first. */
function carryLoop(fn, loop, parent, pos) {
  const L = label(loop)
  if (!L || typed(loop) || parent[0] !== 'block' && parent[0] !== 'loop' && parent[0] !== 'then' && parent[0] !== 'else' && parent[0] !== 'func') return false
  const last = loop[loop.length - 1]
  if (!isArr(last) || last[1] !== L || !(last[0] === 'br_if' && last.length === 3 || last[0] === 'br' && last.length === 2)) return false
  // the latch is the loop's one way back
  let back = 0
  some(loop, m => { if ((m[0] === 'br' || m[0] === 'br_if' || m[0] === 'br_table') && m.slice(1).some(c => c === L)) back++; return false })
  if (back !== 1) return false
  // the store: the last of the body's own statements to store at an address the rest leaves alone
  for (let j = loop.length - 2; j >= 2; j--) {
    const st = loop[j]
    if (!isArr(st) || !STORE_OF[st[0]]) continue
    const s = access(st)
    if (!s || st.length !== s.at + 2) continue
    const tee = isArr(s.addr) && s.addr[0] === 'local.tee' && s.addr.length === 3 ? s.addr[1] : null
    const A = tee ? s.addr[2] : s.addr
    if (!pure(A)) continue
    const names = localsOf(A, new Set())
    if (tee && names.has(tee)) continue
    const ld = STORE_OF[st[0]], w = WIDTH[ld]
    // what follows the store, to the latch
    const after = loop.slice(j + 1)
    const alias = new Map(tee ? [[tee, A]] : [])
    if (after.some(n => writesAny(n, names) || calls(n) || tee && writesAny(n, new Set([tee])))) continue
    const misses = (n) => !some(n, m => {
      if (typeof m[0] !== 'string') return false
      if (m[0].startsWith('memory.') || m[0].indexOf('.atomic') > 0) return true
      if (m[0].indexOf('.store') < 0) return false
      const o = access(m), ow = STORE_W[m[0]]
      if (!o || !ow || !same(addrOf(o.addr, alias), A)) return true
      return o.off < s.off + w && s.off < o.off + ow
    })
    if (!after.every(misses)) continue
    // the load: before the round writes memory, calls, or writes A's locals, with no branch before it
    let found = null, tests = [], stop = false
    const written = new Set()
    const scan = (list, from, conds) => {
      for (let i = from; i < list.length && !stop && !found; i++) {
        const n = list[i]
        if (!isArr(n)) continue
        // the reads of this statement come before its writes: find the load in evaluation order
        const look = (e) => {
          if (found || stop || !isArr(e)) return
          // (a construct inside an expression: its arms are not walked, so nothing after it is clean)
          if (e[0] === 'loop' || e[0] === 'block' || e[0] === 'if' || BRANCH.has(e[0]) && e[0] !== 'br_if') { stop = true; return }
          const at = e[0] === 'local.tee' || e[0] === 'local.set' ? 2 : 1
          for (let k = at; k < e.length; k++) look(e[k])
          if (found || stop) return
          if (LOADS.has(e[0]) && e[0] === ld) {
            const a = access(e)
            if (a && a.off === s.off && e.length === a.at + 1 && same(a.addr, A)) { found = e; tests = conds.slice(); return }
          }
          if (e[0] === 'br_if') { stop = true; return }
          if (e[0] === 'local.set' || e[0] === 'local.tee') { if (names.has(e[1])) { stop = true; return } written.add(e[1]) }
          if (typeof e[0] === 'string' && (e[0].indexOf('.store') > 0 || e[0].startsWith('memory.') || e[0].indexOf('.atomic') > 0 || e[0].startsWith('call'))) { stop = true; return }
        }
        if (n[0] === 'block' && !typed(n)) { scan(n, label(n) ? 2 : 1, conds); if (!found) stop = true; continue }
        if (n[0] === 'if' && !typed(n)) {
          const k = label(n) ? 2 : 1, c = n[k], th = n[k + 1], el = n[k + 2]
          look(c)
          if (found || stop) return
          const reads = localsOf(c, new Set())
          if (memOp(c) || calls(c) || some(c, m => m[0] === 'local.tee' || m[0] === 'local.set') || [...reads].some(r => written.has(r))) { stop = true; return }
          if (isArr(th) && th[0] === 'then') scan(th, 1, conds.concat([{ test: c, reads }]))
          if (!found && isArr(el) && el[0] === 'else') { stop = false; scan(el, 1, conds.concat([{ test: ['i32.eqz', c], reads }])) }
          stop = true
          return
        }
        look(n)
      }
    }
    scan(loop, 2, [])
    if (!found) continue
    const type = TYPE[ld]
    const c = `$__cs${nextLocalId(fn, 'cs')}`
    const at = findBodyStart(fn)
    fn.splice(at, 0, ['local', c, type])
    // the first round's load, where it would run; the rest read the local
    let init = ['local.set', c, clone(found)]
    for (let t = tests.length - 1; t >= 0; t--) init = ['if', clone(tests[t].test), ['then', init]]
    found.length = 0
    found.push('local.get', c)
    st[st.length - 1] = ['local.tee', c, st[st.length - 1]]
    const idx = parent.indexOf(loop)
    parent.splice(idx, 0, init)
    return true
  }
  return false
}

/** Carry each loop's stored element to its next round, in every function of `ast` (a module). */
export function carryStores(ast) {
  if (!isArr(ast)) return ast
  for (const fn of ast) {
    if (!isArr(fn) || fn[0] !== 'func' || !some(fn, n => n[0] === 'loop')) continue
    const walk = (n) => {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c)) continue
        walk(c)
        if (c[0] === 'loop' && carryLoop(fn, c, n, i)) i++
      }
    }
    walk(fn)
  }
  return ast
}
