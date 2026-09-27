/**
 * A typed receiver of open element kind, decoded once per loop.
 *
 *   for (let i = 0; i < n; i++) out[i] = a[i] * g
 *
 * When the summary knows `out` and `a` are typed arrays but not of which
 * element kind (a channel list holding Float32Array views beside Float64Array
 * blocks), every element access is a call: the helper tests the tag, walks the
 * header for the length, follows a view's descriptor and dispatches on the
 * kind, per element. None of that changes while the loop runs: a typed array
 * never relocates, its length and kind are fixed at construction, and the loop
 * does not write the local that names it.
 *
 * So the receiver is decoded before the loop into locals: the element count
 * `n`, the data address `b` and the width flag `w` (Float64Array). A receiver
 * that is not a Float32Array or a Float64Array (a view of either included)
 * decodes to `n = 0`. Each access then tests `i < n`: inside, a direct load or
 * store of the width; outside, the helper as before, which answers a missing
 * receiver, another element kind and an index past the end. One test covers
 * both the kind and the bound. The decode is branch-free sets, so it sits in
 * the loop's pre-header beside the hoisted invariants and the loop still
 * rotates.
 *
 * A store of a value the emitter typed a number canonicalizes a missing element
 * it read to NaN, as the helper does; a value of open kind takes the direct
 * store when it is a number (`v == v`), else the helper and its ToNumber.
 *
 * Runs after the loop unswitch and the vectorizer: a small loop of one output
 * receiver is versioned whole there (and lifted to SIMD); this pass takes the
 * accesses they leave, in loops of any size and any number of receivers.
 * Speed tier: each access keeps its helper call and gains the direct path.
 *
 * @module optimize/typed-decode
 */
import { findBodyStart, nextLocalId, cloneIR } from '../ir.js'
import { PTR, encodePtrHi, TYPED_ELEM_CODE, TYPED_ELEM_VIEW_FLAG } from '../../layout.js'

const isArr = Array.isArray
const STORE = '$__typed_set_idx_tagged'
const READS = new Set(['$__typed_idx', '$__typed_idx_tagged'])
// The value domain the emitter passes a store (emit-assign.js): 2 a number, -1 open.
const DOMAIN_NUMBER = 2, DOMAIN_OPEN = -1

const simple = n => isArr(n) && (n[0] === 'local.get' || n[0] === 'i32.const')

/** The local a receiver operand reads, as { name, boxed }, or null. */
const receiverOf = n => {
  const v = isArr(n) && n[0] === 'i64.reinterpret_f64' ? n[1] : n
  return isArr(v) && v[0] === 'local.get' && typeof v[1] === 'string' && v.length === 2
    ? { name: v[1], boxed: v !== n } : null
}

const domainOf = n => isArr(n) && n[0] === 'i32.const' ? Number(n[1]) : null

/** A helper call this pass rewrites: 'read', 'store' or null. */
const accessOf = n => {
  if (!isArr(n) || n[0] !== 'call') return null
  if (READS.has(n[1]) && n.length === 4) return 'read'
  if (n[1] === STORE && n.length === 6) {
    const d = domainOf(n[5])
    return d === DOMAIN_NUMBER || d === DOMAIN_OPEN ? 'store' : null
  }
  return null
}

const writesIn = (n, out = new Set()) => {
  if (!isArr(n)) return out
  if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') out.add(n[1])
  for (let i = 1; i < n.length; i++) writesIn(n[i], out)
  return out
}

/** Decode each loop's stable typed receivers once and inline their float accesses. */
export function hoistTypedDecode(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const start = findBodyStart(fn)
  if (start < 0) return
  const types = new Map()
  for (let i = 2; i < start; i++) {
    const c = fn[i]
    if (isArr(c) && (c[0] === 'param' || c[0] === 'local') && typeof c[1] === 'string') types.set(c[1], c[2])
  }
  const locals = []
  let id = nextLocalId(fn, 'utd')
  const fresh = type => { const name = `$__utd${id++}`; locals.push(['local', name, type]); return name }
  const get = name => ['local.get', name]
  const F32 = TYPED_ELEM_CODE.Float32Array
  // The helper calls a rewritten access keeps for its other arm: an inner loop leaves them.
  const kept = new Set()

  const decode = r => {
    const bits = () => r.boxed ? ['i64.reinterpret_f64', get(r.name)] : get(r.name)
    const high = () => ['i32.wrap_i64', ['i64.shr_u', bits(), ['i64.const', 32]]]
    const view = () => ['i32.and', high(), ['i32.const', TYPED_ELEM_VIEW_FLAG]]
    const n = fresh('i32'), b = fresh('i32'), w = fresh('i32'), ok = fresh('i32'), v = fresh('i32')
    // Float32Array is 6 and Float64Array 7: one compare with the low bit and the
    // view flag masked. The setup is local.sets alone, the form a loop's
    // pre-header keeps (the loop rotation reads the block as label, sets, loop):
    // a header load of a receiver that is no float array reads address 0 and
    // its result is dropped by the select.
    const setup = [
      ['local.set', ok, ['i32.eq', ['i32.and', high(), ['i32.const', ~(TYPED_ELEM_VIEW_FLAG | 1)]],
        ['i32.const', encodePtrHi(PTR.TYPED, F32) | 0]]],
      ['local.set', v, ['select', view(), ['i32.const', 0], get(ok)]],
      ['local.set', w, ['i32.and', high(), ['i32.const', 1]]],
      ['local.set', b, ['i32.wrap_i64', bits()]],
      ['local.set', n, ['select',
        ['i32.shr_u',
          ['i32.load', ['select', ['select', get(b), ['i32.sub', get(b), ['i32.const', 8]], get(v)], ['i32.const', 0], get(ok)]],
          ['i32.add', ['i32.const', 2], get(w)]],
        ['i32.const', 0], get(ok)]],
      ['local.set', b, ['select',
        ['i32.load', ['select', ['i32.add', get(b), ['i32.const', 4]], ['i32.const', 0], get(v)]],
        get(b), get(v)]],
    ]
    const at = (ix, shift) => ['i32.add', get(b), ['i32.shl', ix, ['i32.const', shift]]]
    return {
      setup,
      within: ix => ['i32.lt_u', ix, get(n)],
      load: ix => ['if', ['result', 'f64'], get(w),
        ['then', ['f64.load', at(ix(), 3)]],
        ['else', ['f64.promote_f32', ['f32.load', at(ix(), 2)]]]],
      store: (ix, value) => ['if', get(w),
        ['then', ['f64.store', at(ix(), 3), value()]],
        ['else', ['f32.store', at(ix(), 2), ['f32.demote_f64', value()]]]],
    }
  }

  const rewriteLoop = (loop) => {
    const writes = writesIn(loop)
    const decoded = new Map()
    const setup = []
    const stable = call => {
      const r = receiverOf(call[2])
      if (!r || writes.has(r.name)) return null
      const type = types.get(r.name)
      if (type !== (r.boxed ? 'f64' : 'i64')) return null
      const key = (r.boxed ? 'f:' : 'i:') + r.name
      let d = decoded.get(key)
      if (!d) { d = decode(r); decoded.set(key, d); setup.push(...d.setup) }
      return d
    }
    const visit = n => {
      if (!isArr(n)) return n
      for (let i = 1; i < n.length; i++) n[i] = visit(n[i])
      const kind = kept.has(n) ? null : accessOf(n)
      if (!kind) return n
      const d = stable(n)
      if (!d) return n
      const pre = []
      let ix
      if (simple(n[3])) { const node = n[3]; ix = () => cloneIR(node) }
      else { const t = fresh('i32'); pre.push(['local.set', t, n[3]]); ix = () => get(t) }
      if (kind === 'read') {
        const call = ['call', n[1], n[2], ix()]
        kept.add(call)
        const read = ['if', ['result', 'f64'], d.within(ix()), ['then', d.load(ix)], ['else', call]]
        return pre.length ? ['block', ['result', 'f64'], ...pre, read] : read
      }
      const v = fresh('f64'), open = domainOf(n[5]) === DOMAIN_OPEN
      const value = () => open ? get(v) : ['select', get(v), ['f64.const', 'nan'], ['f64.eq', get(v), get(v)]]
      const helper = ['call', n[1], n[2], ix(), get(v), n[5]]
      kept.add(helper)
      const call = ['drop', helper]
      const direct = open ? ['i32.and', d.within(ix()), ['f64.eq', get(v), get(v)]] : d.within(ix())
      return ['block', ['result', 'f64'], ...pre, ['local.set', v, n[4]],
        ['if', direct, ['then', d.store(ix, value)], ['else', call]],
        get(v)]
    }
    for (let i = 1; i < loop.length; i++) loop[i] = visit(loop[i])
    return setup
  }

  // Outermost loops first: a receiver stable across a nest decodes before it;
  // one an outer body assigns decodes before the inner loop that reads it.
  const walk = (node) => {
    if (!isArr(node)) return
    for (let i = 1; i < node.length; i++) {
      const c = node[i]
      if (!isArr(c)) continue
      if (c[0] === 'loop' && !c.some(x => isArr(x) && (x[0] === 'result' || x[0] === 'param'))) {
        const setup = rewriteLoop(c)
        if (setup.length) { node.splice(i, 0, ...setup); i += setup.length }
      }
      walk(c)
    }
  }
  walk(fn)
  if (locals.length) fn.splice(start, 0, ...locals)
}
