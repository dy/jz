/**
 * An access at a constant base reads the base from its memarg: where the
 * function's control flow holds a local to one address N at a read of it,
 * `(i32.load (i32.add (local.get $a) E))` is `(i32.load offset=N E)`. A static
 * parameter's entry write gives such a local (compile/emit-func.js: every call
 * passes one placed array, its address a literal), and so does an inlined copy
 * of one. The optimizer substitutes only small literals for their locals, so an
 * address of 96 or 62160 stays a register the access adds; x64 reads
 * `[index + offset]` in the load and the add goes. The access shrinks too: a
 * `local.get` and an `i32.add` become the offset's bytes.
 *
 * The address is the same where the sum does not wrap: a memarg adds without
 * wrapping where the `i32.add` wraps. Both the base and the index come from
 * the intervals optimize/word-ranges.js reads off the function: the base a
 * single address below 2^31, the index non-negative (a counter under its
 * loop's test, a masked hash, a byte), so N + E stays below 2^32. A negative
 * index is no index into the array at N: `samples[j + 1]` at j = -1 adds
 * `j << 3` to the base and takes its 8 from the memarg, where folding the base
 * would leave -8 wrapping past it.
 *
 * A local no read is left of loses its literal writes.
 *
 * @module optimize/const-bases
 */

import { wordRanges } from './word-ranges.js'

const isArr = Array.isArray
// an access whose first operand is its address (a load, a store, a v128 load or store): no lane operand, no atomics
const ACCESS = new Set([
  ...['i32', 'i64', 'f32', 'f64'].flatMap(t => [`${t}.load`, `${t}.store`]),
  'i32.load8_s', 'i32.load8_u', 'i32.load16_s', 'i32.load16_u', 'i32.store8', 'i32.store16',
  'i64.load8_s', 'i64.load8_u', 'i64.load16_s', 'i64.load16_u', 'i64.load32_s', 'i64.load32_u', 'i64.store8', 'i64.store16', 'i64.store32',
  'v128.load', 'v128.store', 'v128.load8x8_s', 'v128.load8x8_u', 'v128.load16x4_s', 'v128.load16x4_u', 'v128.load32x2_s', 'v128.load32x2_u',
  'v128.load8_splat', 'v128.load16_splat', 'v128.load32_splat', 'v128.load64_splat', 'v128.load32_zero', 'v128.load64_zero',
])
const ADDRESS_MAX = 0x7FFFFFFF

/** Fold the constant-address locals of every function of `ast` (a module) into the memargs of their accesses. */
export function constBases(ast) {
  if (!isArr(ast)) return ast
  for (const fn of ast) if (isArr(fn) && fn[0] === 'func') foldFunc(fn)
  return ast
}

function foldFunc(fn) {
  if (!hasAccess(fn)) return
  const ranges = wordRanges(fn)
  if (!ranges) return
  // the address a read holds: one value the flow allows, a place in memory
  const baseOf = (n) => {
    if (!isArr(n) || n[0] !== 'local.get') return null
    const r = ranges.get(n)
    return r && r.lo === r.hi && r.lo > 0 && r.lo <= ADDRESS_MAX ? r.lo : null
  }
  const folded = new Map()
  const fold = (n) => {
    for (let i = 1; i < n.length; i++) if (isArr(n[i])) fold(n[i])
    if (!ACCESS.has(n[0])) return
    let k = 1, offset = 0
    for (; k < n.length && typeof n[k] === 'string'; k++) {
      if (n[k].startsWith('offset=')) offset = Number(n[k].slice(7))
      else if (!n[k].startsWith('align=')) return   // a memory index: leave the access as it is
    }
    const addr = n[k]
    if (!isArr(addr) || addr[0] !== 'i32.add' || addr.length !== 3) return
    const ba = baseOf(addr[1]), bb = ba == null ? baseOf(addr[2]) : null
    const base = ba ?? bb
    if (base == null || offset + base > 0xFFFFFFFF) return
    // a non-negative index below 2^31 and a base below 2^31: the sum never wraps
    const index = ba != null ? addr[2] : addr[1], r = ranges.get(index)
    if (!r || r.lo < 0) return
    const name = (ba != null ? addr[1] : addr[2])[1]
    folded.set(name, (folded.get(name) || 0) + 1)
    const memarg = n.slice(1, k).filter(s => !s.startsWith('offset='))
    n.splice(1, k, `offset=${offset + base}`, ...memarg, index)
  }
  fold(fn)
  if (!folded.size) return
  // a local every read of which went, written with literals alone: its writes go, a tee to its value
  const reads = new Map(), writes = new Map()
  const scan = (n, parent) => {
    if ((n[0] === 'local.get') && typeof n[1] === 'string') reads.set(n[1], (reads.get(n[1]) || 0) + 1)
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && folded.has(n[1])) {
      let w = writes.get(n[1]); if (!w) writes.set(n[1], w = [])
      w.push([n, parent])
    }
    for (let i = 1; i < n.length; i++) if (isArr(n[i])) scan(n[i], n)
  }
  scan(fn, null)
  for (const [name, w] of writes) {
    if (reads.get(name) || !w.every(([n]) => isArr(n[2]) && n[2][0] === 'i32.const')) continue
    for (const [n, parent] of w) {
      const i = parent.indexOf(n)
      if (n[0] === 'local.tee') parent[i] = n[2]
      else parent.splice(i, 1)
    }
  }
}

const hasAccess = (n) => isArr(n) && (ACCESS.has(n[0]) || n.some(hasAccess))
