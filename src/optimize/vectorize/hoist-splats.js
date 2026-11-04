/**
 * A splat whose value is the same on every pass of a lane strip is computed once, where the
 * strip opens (speed tier).
 *
 * A lift broadcasts a scalar operand where the scalar loop read it: a weight a convolution
 * reads at an index the strip never moves, a coefficient of the row. The splat then runs on
 * every pass, and on x64 a broadcast from a general register is a move and a shuffle or two
 * beside the load it reads, where a value set before the loop is a register or one stack
 * read. watr's LICM moves the invariant code it can see, but not a load past the strip's
 * stores, which it cannot tell apart from it, nor a value an unrolled body recomputes each
 * pass in a scratch local (`wrow = wCh + 3`, written once per row of the receptive field).
 *
 * Both are told apart here. The strip runs only past the test of every store against every
 * other access of the loop (alias.js gateStrips), and an access at an address the iterations
 * do not move is tested against the bytes each store touches over the loop left, whatever
 * names the two use: a load at a strip-invariant address reads the same bytes on every pass,
 * unless a store of the strip has an address that does not move either (the gate reads one
 * address as one element, untested), or the strip calls code that may write memory. A
 * scratch local is followed through the straight-line statements of the body, so its value at
 * each read is an expression of the names the strip never writes.
 *
 * A splat moves only from code every pass runs, to after the strip's own exit test evaluated
 * once more: the read happens only where the scalar loop's first iteration makes it. A tee
 * inside the moved operand leaves its value set where it stood, where a read is left.
 *
 * @module optimize/vectorize/hoist-splats
 */
import { cloneNode, walkAst } from '../../ast.js'
import { readsBeforeWrite } from './addr-model.js'
import { LOAD_OPS, STORE_OPS } from './lane-tables.js'
import { isArr } from './node-utils.js'

const SPLAT = /^(?:i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\.splat$/
const VECTOR = /^(?:v128|[if](?:8|16|32|64)x\d+)\./
// scalar operators that cannot trap and read nothing but their operands
const PURE = /^(?:i32|i64|f32|f64)\.(?:const|add|sub|mul|and|or|xor|shl|shr_[su]|rotl|rotr|eqz?|ne|[lg][te](?:_[su])?|neg|abs|sqrt|min|max|ceil|floor|trunc|nearest|copysign|convert_i(?:32|64)_[su]|promote_f32|demote_f64|trunc_sat_f(?:32|64)_[su]|wrap_i64|extend_i32_[su]|extend(?:8|16|32)_s|reinterpret_[fi](?:32|64))$|^f(?:32|64)\.div$/
const CONTROL = new Set(['if', 'block', 'loop', 'br', 'br_if', 'br_table', 'return', 'select'])

/** Hoist the strip-invariant splats of every lane strip in `wrapper`; returns the new locals. */
export function hoistStripSplats(wrapper, freshIdRef, outsideReads = null) {
  const decls = [], kept = []
  walkAst(wrapper, { enter: (n) => {
    if (n[0] !== 'block' || typeof n[1] !== 'string') return
    const at = n.findIndex((c, i) => i > 1 && isArr(c) && c[0] === 'loop')
    const loop = n[at]
    if (at < 0 || !isArr(loop[2]) || loop[2][0] !== 'br_if' || loop[2][1] !== n[1] || loop[2].length !== 3) return
    let vector = false
    walkAst(loop, { enter: c => { if (VECTOR.test(c[0])) vector = true } })
    if (vector) decls.push(...hoistIn(n, at, freshIdRef, kept))
  } })
  // a moved tee's write stays where anything may read what it wrote: a read left in a strip,
  // one past the loop, one outside any loop of the wrapper, or a loop (the scalar one) that
  // may read it before writing it
  if (kept.length) {
    const strips = new Set(kept.map(k => k.loop)), stripReads = new Set(), early = new Set()
    const visit = (c) => {
      if (!isArr(c)) return
      if (c[0] === 'loop') {
        if (strips.has(c)) walkAst(c, { enter: x => { if (x[0] === 'local.get') stripReads.add(x[1]) } })
        else for (const { tees } of kept) for (const [t] of tees) if (readsBeforeWrite(c.slice(2), t)) early.add(t)
        return
      }
      if (c[0] === 'local.get') early.add(c[1])
      for (let i = 1; i < c.length; i++) visit(c[i])
    }
    visit(wrapper)
    for (const { node, tees, get } of kept) {
      const live = tees.filter(([t]) => stripReads.has(t) || early.has(t) || outsideReads?.has(t))
      node.length = 0
      if (live.length) node.push('block', ['result', 'v128'], ...live.map(([t, v]) => ['local.set', t, v]), get)
      else node.push(...get)
    }
  }
  return decls
}

function hoistIn(block, at, freshIdRef, kept) {
  const loop = block[at]
  const written = new Set(), globals = new Set()
  let effects = false
  walkAst(loop, { enter: c => {
    if ((c[0] === 'local.set' || c[0] === 'local.tee') && typeof c[1] === 'string') written.add(c[1])
    else if (c[0] === 'global.set') globals.add(c[1])
    else if (c[0] === 'call_indirect' || c[0] === 'call_ref' || c[0].startsWith('memory.') || (c[0] === 'call' && !String(c[1]).startsWith('$math.'))) effects = true
  } })
  // name → its value on this pass as an expression of names the strip never writes
  const env = new Map()
  let movelessStore = false
  const found = []   // { node, value, loads, tees }
  // The value of `n` as such an expression, or null; `every`: the pass runs this code.
  const ev = (n, every) => {
    if (!isArr(n)) return null
    const op = n[0]
    if (op === 'local.get') return !written.has(n[1]) ? n : env.has(n[1]) ? cloneNode(env.get(n[1])) : null
    if (op === 'global.get') return globals.has(n[1]) ? null : n
    if (op === 'local.set' || op === 'local.tee') {
      const v = ev(n[2], every)
      if (every && v) env.set(n[1], v); else env.delete(n[1])
      return op === 'local.tee' ? v : null
    }
    if (CONTROL.has(op)) { for (let i = 1; i < n.length; i++) ev(n[i], false); return null }
    const vals = [], tees = []
    let ok = true
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (!isArr(c)) { vals.push(c); continue }
      const v = ev(c, every)
      if (v == null) ok = false
      vals.push(v)
    }
    // (a store's address is its first operand past the memarg)
    if (STORE_OPS[op] && vals[n.findIndex((c, i) => i > 0 && isArr(c)) - 1] != null) movelessStore = true
    if (!ok) return null
    const value = [op, ...vals]
    if (SPLAT.test(op)) {
      if (every && !plain(n[1])) {
        walkAst(n[1], { enter: c => { if (c[0] === 'local.tee') tees.push(c[1]) } })
        let loads = false
        walkAst(value, { enter: c => { if (LOAD_OPS[c[0]]) loads = true } })
        found.push({ node: n, value, loads, tees: tees.map(name => [name, cloneNode(env.get(name))]) })
      }
      return value
    }
    if (LOAD_OPS[op] || PURE.test(op)) return value
    return null
  }
  // (a splat watr's LICM moves itself: of names the strip never writes, reading no memory)
  const plain = (e) => {
    let ok = true
    walkAst(e, { enter: c => { if (LOAD_OPS[c[0]] || ((c[0] === 'local.get' || c[0] === 'local.tee') && written.has(c[1]))) ok = false } })
    return ok
  }
  for (let i = 3; i < loop.length; i++) ev(loop[i], true)
  const take = found.filter(f => !f.loads || (!effects && !movelessStore))
  if (!take.length) return []
  const id = freshIdRef.next++, sets = [], decls = [], shared = new Map()
  for (const f of take) {
    const key = JSON.stringify(f.value)
    let name = shared.get(key)
    if (!name) {
      name = `$__hs${id}_${shared.size}`
      shared.set(key, name)
      sets.push(['local.set', name, cloneNode(f.value)])
      decls.push(['local', name, 'v128'])
    }
    const get = ['local.get', name], tees = f.tees.filter(([, v]) => v)
    f.node.length = 0
    f.node.push(...get)
    if (tees.length) kept.push({ node: f.node, tees, get, loop })
  }
  const [, label, cond] = loop[2]
  block.splice(at, 0, ['br_if', label, cloneNode(cond)], ...sets)
  return decls
}
