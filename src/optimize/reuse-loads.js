// A load an earlier load already read, with no write to memory between: the earlier value.
//
// A kernel that reads an element twice (`const d = a[i] & 0xff; b[count[d]] = a[i]`) loads
// it twice when nothing between the reads stores: the second load reads what the first
// read. The first load keeps its value in a local and the second reads the local.
//
// Two loads read the same value when they are the same instruction (width, sign and
// offset) at an address in the same local, and between them the walk, in the order the
// code runs, passes no store, no bulk or atomic memory operation and no call, and no write
// of that local. A path that joins another (a loop's head, the end of an arm, a block a
// branch leaves) keeps only what holds on both. The later load's address is the local
// itself: dropping it drops nothing that runs. A load inside a conditional arm the first
// load is outside of stays: it runs only on that path, and its arm, a local read, would
// become a select (a predictable branch is cheaper than the select's dependence).
import { nextLocalId, findBodyStart } from '../ir.js'

const isArr = Array.isArray
const LOAD = /^(i32|i64|f32|f64)\.load(8_[su]|16_[su]|32_[su])?$/
// what may change memory, or run code that does
const CLOBBER = /^(call|call_indirect|call_ref|return_call|return_call_indirect|return_call_ref|memory\.(copy|fill|init|grow)|.*\.atomic\..*|.*\.store(8|16|32)?|v128\.store.*)$/

/** The key of a load at `local + offset`, its address local, or null. */
const keyOf = (n) => {
  let i = 1, off = 0
  for (; typeof n[i] === 'string'; i++) if (n[i].startsWith('offset=')) off += Number(n[i].slice(7))
  const a = n[i]
  if (n.length !== i + 1 || !isArr(a) || (a[0] !== 'local.get' && a[0] !== 'local.tee') || typeof a[1] !== 'string') return null
  return { key: n[0] + ' ' + off + ' ' + a[1], local: a[1], pure: a[0] === 'local.get' }
}

export function reuseLoads(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return false
  const bodyStart = findBodyStart(fn)
  const temps = [], shared = new Set()
  let next = null
  // available loads: key → { local, node, parent, idx, temp }
  const meet = (a, b) => { const m = new Map(); for (const [k, v] of a) if (b.get(k) === v) m.set(k, v); return m }
  const kill = (state, local) => { for (const [k, v] of state) if (v.local === local) state.delete(k) }
  // labels a branch inside `n` targets
  const targets = (n, out = new Set()) => {
    if (!isArr(n)) return out
    if (n[0] === 'br' || n[0] === 'br_if') out.add(n[1])
    else if (n[0] === 'br_table') for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string') out.add(n[i])
    for (let i = 1; i < n.length; i++) targets(n[i], out)
    return out
  }
  // Walk `n` (the child at parent[idx]) in evaluation order; returns the state after it.
  const walk = (n, parent, idx, state, depth = 0) => {
    if (!isArr(n)) return state
    const op = n[0]
    if (op === 'block' || op === 'loop') {
      let s = op === 'loop' ? new Map() : state
      for (let i = 1; i < n.length; i++) s = walk(n[i], n, i, s, depth)
      // a block a branch leaves joins that branch's path: nothing is known after it
      return op === 'block' && typeof n[1] === 'string' && targets(n).has(n[1]) ? new Map() : s
    }
    if (op === 'if') {
      let i = 1, s = state
      while (i < n.length && (!isArr(n[i]) || n[i][0] === 'result' || n[i][0] === 'param' || n[i][0] === 'type')) i++
      for (; i < n.length && !(isArr(n[i]) && (n[i][0] === 'then' || n[i][0] === 'else')); i++) s = walk(n[i], n, i, s, depth)
      let thenS = null, elseS = null
      for (; i < n.length; i++) {
        const arm = n[i]
        if (!isArr(arm)) continue
        let a = new Map(s)
        for (let j = 1; j < arm.length; j++) a = walk(arm[j], arm, j, a, depth + 1)
        if (arm[0] === 'then') thenS = a; else elseS = a
      }
      const out = meet(thenS ?? s, elseS ?? s)
      return typeof n[1] === 'string' && targets(n).has(n[1]) ? new Map() : out
    }
    if (op === 'try' || op === 'try_table' || op === 'catch' || op === 'catch_all' || op === 'delegate') {
      for (let i = 1; i < n.length; i++) walk(n[i], n, i, new Map(), depth + 1)
      return new Map()
    }
    for (let i = 1; i < n.length; i++) state = walk(n[i], n, i, state, depth)
    if (op === 'local.set' || op === 'local.tee') { kill(state, n[1]); return state }
    if (typeof op === 'string' && CLOBBER.test(op)) return new Map()
    if (typeof op === 'string' && LOAD.test(op)) {
      const k = keyOf(n)
      if (!k || shared.has(n) || shared.has(parent)) return state
      const seen = state.get(k.key)
      if (seen && k.pure && seen.depth >= depth) {
        if (!seen.temp) {
          next ??= nextLocalId(fn, 'rl')
          seen.temp = `$__rl${next++}`
          temps.push(['local', seen.temp, op.slice(0, 3)])
          seen.parent[seen.idx] = ['local.tee', seen.temp, seen.node]
        }
        parent[idx] = ['local.get', seen.temp]
        return state
      }
      if (!seen || seen.depth > depth) state.set(k.key, { local: k.local, node: n, parent, idx, temp: null, depth })
    }
    return state
  }
  // A node the tree holds in two places runs in both: neither may be rewritten for one.
  const seenOnce = new Set()
  const census = (n) => {
    if (!isArr(n)) return
    if (seenOnce.has(n)) { const mark = (x) => { if (!isArr(x) || shared.has(x)) return; shared.add(x); for (let i = 1; i < x.length; i++) mark(x[i]) }; mark(n); return }
    seenOnce.add(n)
    for (let i = 1; i < n.length; i++) census(n[i])
  }
  for (let i = bodyStart; i < fn.length; i++) census(fn[i])
  let state = new Map()
  for (let i = bodyStart; i < fn.length; i++) state = walk(fn[i], fn, i, state)
  if (!temps.length) return false
  fn.splice(bodyStart, 0, ...temps)
  return true
}

// A byte or half of a loaded word, read alone: the narrow load of it. Wasm memory is
// little-endian, so byte k of the word at A is the byte at A + k, inside the word's own
// bytes: `(a[i] >>> 8) & 0xff` reads one byte where it would shift and mask the word
// (clang's load narrowing). A word in a local (reuseLoads' shared read) narrows when its
// one write is the load and every read takes the same byte: the local holds that byte.
const BYTE_MASK = { 255: 1, 65535: 2 }
const u32 = (n) => { const v = isArr(n) && n[0] === 'i32.const' ? Number(n[1]) : NaN; return Number.isInteger(v) ? v >>> 0 : null }
/** `(i32.load [offset=o] A)` with no other memarg: [offset, address], or null. */
const word = (n) => {
  if (!isArr(n) || n[0] !== 'i32.load') return null
  if (n.length === 2) return [0, n[1]]
  if (n.length === 3 && typeof n[1] === 'string' && n[1].startsWith('offset=')) return [Number(n[1].slice(7)), n[2]]
  return null
}
/** The part of a word `n` takes: { x: the word operand, width, signed, at: byte } or null.
 *  `x & mask`, `(x >>> s) & mask`, `x >>> 24|16`, `x >> 24|16`. */
const extract = (n) => {
  if (!isArr(n) || n.length !== 3) return null
  if (n[0] === 'i32.and') {
    const width = BYTE_MASK[u32(n[2])]
    if (!width) return null
    const x = n[1]
    if (isArr(x) && x[0] === 'i32.shr_u' && x.length === 3) {
      const s = u32(x[2])
      return s != null && s % 8 === 0 && s / 8 + width <= 4 ? { x: x[1], width, signed: false, at: s / 8 } : null
    }
    return { x, width, signed: false, at: 0 }
  }
  if (n[0] === 'i32.shr_u' || n[0] === 'i32.shr_s') {
    const s = u32(n[2])
    return s === 24 || s === 16 ? { x: n[1], width: s === 24 ? 1 : 2, signed: n[0] === 'i32.shr_s', at: s / 8 } : null
  }
  return null
}
const narrow = (e, w) => [`i32.load${e.width === 1 ? 8 : 16}_${e.signed ? 's' : 'u'}`, ...(w[0] + e.at ? [`offset=${w[0] + e.at}`] : []), w[1]]
const same = (a, b) => a.width === b.width && a.signed === b.signed && a.at === b.at
export function narrowByteLoads(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return false
  const bodyStart = findBodyStart(fn)
  // A local's write and reads: the write, every read with the part it takes (null: the word).
  const locals = new Map()
  const of = (name) => { let r = locals.get(name); if (!r) locals.set(name, r = { defs: [], reads: [] }); return r }
  const scan = (n, parent, idx) => {
    if (!isArr(n)) return
    const e = extract(n)
    const x = e && e.x
    if (x && (x[0] === 'local.get' || x[0] === 'local.tee') && typeof x[1] === 'string') {
      of(x[1]).reads.push({ e, parent, idx })
      if (x[0] === 'local.tee') { of(x[1]).defs.push(x); for (let i = 2; i < x.length; i++) scan(x[i], x, i) }
      return
    }
    if (n[0] === 'local.get') of(n[1]).reads.push({ e: null })
    else if (n[0] === 'local.set') of(n[1]).defs.push(n)
    else if (n[0] === 'local.tee') { of(n[1]).defs.push(n); of(n[1]).reads.push({ e: null }) }
    for (let i = 1; i < n.length; i++) scan(n[i], n, i)
  }
  for (let i = bodyStart; i < fn.length; i++) scan(fn[i], fn, i)
  const types = new Map()
  for (let i = 2; i < bodyStart; i++) if (isArr(fn[i]) && fn[i][0] === 'local') types.set(fn[i][1], fn[i][2])
  let did = false
  for (const [name, { defs, reads }] of locals) {
    if (types.get(name) !== 'i32' || defs.length !== 1 || !reads.length) continue
    const w = word(defs[0][2]), e = reads[0].e
    if (!w || !e || !reads.every(r => r.e && same(r.e, e))) continue
    defs[0][2] = narrow(e, w)
    for (const r of reads) r.parent[r.idx] = r.e.x
    did = true
  }
  // a part of a load read in place, the widest pattern first (`(x >>> 16) & 255` is a byte)
  const visit = (n) => {
    if (!isArr(n)) return n
    const e = extract(n), w = e && word(e.x)
    if (w) { did = true; const r = narrow(e, w); r[r.length - 1] = visit(r[r.length - 1]); return r }
    for (let i = 1; i < n.length; i++) n[i] = visit(n[i])
    return n
  }
  for (let i = bodyStart; i < fn.length; i++) fn[i] = visit(fn[i])
  return did
}
