// A binding the statement list split off takes the slot of the one it continues.
//
// `x = +x` declares a binding of its own (prepare/split-bindings.js), so that
// each holds one value and has its kind. Where both have one wasm type the
// split bought a kind and costs a local: the binding before is dead once the
// next is written, since every later mention reads the next. Such a binding
// keeps the slot, and the function is the one the source wrote:
//
//   (local.set $x1 (f64.neg (local.get $x)))   →   (local.set $x (f64.neg (local.get $x)))
//
// A binding shares when, in the order the body evaluates,
//   • every access of the slot comes before the binding's first write, and the
//     binding is read only after it (a write's operands come before the write),
//   • no loop holds both an access of the slot and a write of the binding: a
//     later pass of the loop would read the slot after the write.
// Runs last before the generic optimizer, so the passes before it see one
// value per local.
import { T } from '../ast.js'
import { findBodyStart } from '../ir.js'
import { isArr } from './vectorize/node-utils.js'

const SPLIT = new RegExp(`^(\\$.*)${T}s(\\d+)$`)
const WRITES = new Set(['local.set', 'local.tee'])

export function shareSplitSlots(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return false
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return false
  const types = new Map(), chains = new Map()
  for (let i = 2; i < bodyStart; i++) {
    const d = fn[i]
    if (!isArr(d) || (d[0] !== 'param' && d[0] !== 'local') || typeof d[1] !== 'string' || d.length !== 3) continue
    types.set(d[1], d[2])
    const m = d[0] === 'local' && SPLIT.exec(d[1])
    if (m) { let c = chains.get(m[1]); if (!c) chains.set(m[1], c = []); c.push([+m[2], d[1]]) }
  }
  if (!chains.size) return false
  const tracked = new Set()
  for (const [root, c] of chains) { if (types.has(root)) tracked.add(root); for (const [, name] of c) tracked.add(name) }

  // the accesses of each tracked local and the span of each loop, in evaluation order
  const reads = new Map(), writes = new Map(), loops = []
  let pos = 0, flat = false
  const note = (map, name) => { let l = map.get(name); if (!l) map.set(name, l = []); l.push(pos++) }
  const scan = (n) => {
    if (!isArr(n)) return
    const op = n[0]
    if (op === 'local.get') { if (tracked.has(n[1])) note(reads, n[1]); return }
    if (WRITES.has(op)) {
      if (n.length < 3) { if (tracked.has(n[1])) flat = true; return }
      for (let i = 2; i < n.length; i++) scan(n[i])
      if (tracked.has(n[1])) note(writes, n[1])
      return
    }
    const from = pos
    for (let i = 1; i < n.length; i++) scan(n[i])
    if (op === 'loop') loops.push([from, pos])
  }
  for (let i = bodyStart; i < fn.length; i++) scan(fn[i])
  if (flat) return false

  const NONE = []
  const rename = new Map()
  for (const [root, c] of chains) {
    c.sort((a, b) => a[0] - b[0])
    let slot = null, held = []   // the slot in progress and the positions of its accesses
    if (types.has(root)) { slot = root; held = [...(reads.get(root) ?? NONE), ...(writes.get(root) ?? NONE)] }
    for (const [, name] of c) {
      const w = writes.get(name) ?? NONE, r = reads.get(name) ?? NONE
      const first = w.length ? w[0] : -1
      const shares = slot != null && first >= 0 && types.get(name) === types.get(slot) &&
        held.every(p => p < first) && r.every(p => p > first) &&
        !loops.some(([a, b]) => held.some(p => p >= a && p < b) && w.some(p => p >= a && p < b))
      if (shares) { rename.set(name, slot); held.push(...w, ...r) }
      else { slot = name; held = [...w, ...r] }
    }
  }
  if (!rename.size) return false

  const apply = (n) => {
    if (!isArr(n)) return
    for (let i = n.length - 1; i >= 1; i--) {
      const c = n[i]
      if (!isArr(c)) continue
      if ((c[0] === 'local.get' || WRITES.has(c[0])) && rename.has(c[1])) c[1] = rename.get(c[1])
      apply(c)
      // the copy a shared slot makes of itself
      if (WRITES.has(c[0]) && c.length === 3 && isArr(c[2]) && c[2][0] === 'local.get' && c[2][1] === c[1] && c[2].length === 2) {
        if (c[0] === 'local.tee') n[i] = c[2]
        else if (n === fn || n[0] === 'block' || n[0] === 'loop' || n[0] === 'then' || n[0] === 'else') n.splice(i, 1)
      }
    }
  }
  apply(fn)
  for (let i = bodyStart - 1; i >= 2; i--) if (isArr(fn[i]) && fn[i][0] === 'local' && rename.has(fn[i][1])) fn.splice(i, 1)
  return true
}
