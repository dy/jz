// A static typed array the program only indexes by constants is registers.
//
// A numeric library reads a float's words through two views of one buffer
// (`F[0] = x; hi = U[1]`), builds a float from words the same way, or takes a
// value's bytes. When the array is static storage, it and every view of its
// buffer are module constants, and each use of them is an element access at a
// constant index, no other access in the program reaches those bytes: a store
// through any other pointer lands in another object. Then
//   • a load whose every byte the stores before it on its path wrote is those
//     values' bits, shifted and joined (`i32.load A+4` after `f64.store A v` is
//     the high word of v), whatever the widths and types on either side, and
//   • a store no load left in the program reads a byte of goes.
// Whatever a binding's use is besides such an access (an argument, a return, an
// element of another object, an index that is not constant, an export) keeps its
// storage in memory, with the storage of every binding that shares its buffer.
//
// A path forgets what it knows where control arrives from elsewhere (a loop's
// entry, the end of a block a branch leaves, the arms of an `if` joining keep what
// both hold) and at a call to anything that may store to such an array: a function
// that does, or calls one that does, or is not this module's.
import { walkAst } from '../ast.js'
import { ctx } from '../ctx.js'
import { PTR, TYPED_ELEM_VIEW_FLAG, decodePtrType, decodePtrAux } from '../../layout.js'
import { findBodyStart } from '../ir.js'
import { dataBytes } from '../static-data.js'
import { accessOf, clone } from './vectorize/access.js'
import { isArr } from './vectorize/node-utils.js'

// op → [bytes, the type of the value stored or loaded, sign-extending]
const STORES = new Map([
  ['f64.store', [8, 'f64']], ['i64.store', [8, 'i64']], ['f32.store', [4, 'f32']], ['i32.store', [4, 'i32']],
  ['i32.store16', [2, 'i32']], ['i32.store8', [1, 'i32']],
  ['i64.store32', [4, 'i64']], ['i64.store16', [2, 'i64']], ['i64.store8', [1, 'i64']],
])
const LOADS = new Map([
  ['f64.load', [8, 'f64', false]], ['i64.load', [8, 'i64', false]], ['f32.load', [4, 'f32', false]], ['i32.load', [4, 'i32', false]],
  ['i32.load16_u', [2, 'i32', false]], ['i32.load16_s', [2, 'i32', true]], ['i32.load8_u', [1, 'i32', false]], ['i32.load8_s', [1, 'i32', true]],
  ['i64.load32_u', [4, 'i64', false]], ['i64.load32_s', [4, 'i64', true]], ['i64.load16_u', [2, 'i64', false]], ['i64.load16_s', [2, 'i64', true]],
  ['i64.load8_u', [1, 'i64', false]], ['i64.load8_s', [1, 'i64', true]],
])
const isAccess = op => typeof op === 'string' && (op.includes('.load') || op.includes('.store'))
const BULK = new Set(['memory.copy', 'memory.fill', 'memory.init'])
const OPEN_CALLS = new Set(['call_indirect', 'call_ref', 'return_call_indirect', 'return_call_ref'])
const BRANCHES = new Set(['br', 'br_if', 'br_table', 'br_on_null', 'br_on_non_null', 'try_table'])
const MASK64 = ['', '0xFF', '0xFFFF', '0xFFFFFF', '0xFFFFFFFF', '0xFFFFFFFFFF', '0xFFFFFFFFFFFF', '0xFFFFFFFFFFFFFF']
const MASK32 = [0, 0xFF, 0xFFFF, 0xFFFFFF]
const HEADER = 16

/** The address of static typed storage a constant box names; -1 for any other value. */
const staticTypedAddr = (init, bytes) => {
  if (!isArr(init) || init[0] !== 'i32.wrap_i64' || !isArr(init[1]) || init[1][0] !== 'i64.reinterpret_f64') return -1
  const c = init[1][1]
  if (!isArr(c) || c[0] !== 'f64.const' || typeof c[1] !== 'string' || !c[1].startsWith('nan:0x')) return -1
  const hex = c[1].slice(6).padStart(16, '0')
  const hi = parseInt(hex.slice(0, 8), 16), addr = parseInt(hex.slice(8), 16)
  if (decodePtrType(hi) !== PTR.TYPED || (decodePtrAux(hi) & TYPED_ELEM_VIEW_FLAG)) return -1
  return addr >= HEADER && addr <= bytes.length ? addr : -1
}
const i32At = (bytes, at) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)

/** The module constants that hold static typed storage or share one's address:
 *  name → { addr, root, len }, from the single assignment each has in `__start`. */
const staticBindings = (funcs, start) => {
  const found = new Map()
  const bytes = dataBytes()
  if (!bytes?.length || ctx.memory.shared) return found
  const writes = new Map()
  for (const fn of funcs) walkAst(fn, { enter: n => {
    if (n[0] === 'global.set' && typeof n[1] === 'string') writes.set(n[1], (writes.get(n[1]) || 0) + 1)
  } })
  const exported = new Set()
  for (const name in ctx.funcs.exports) {
    const v = ctx.funcs.exports[name]
    exported.add(v === true ? name : v)
  }
  for (let i = findBodyStart(start); i < start.length; i++) {
    const s = start[i]
    if (!isArr(s) || s[0] !== 'global.set' || typeof s[1] !== 'string' || writes.get(s[1]) !== 1) continue
    const name = s[1].slice(1), g = ctx.scope.globals.get(name)
    if (!g || g.export || exported.has(name) || (ctx.scope.globalTypes.get(name) ?? g.type) !== 'i32') continue
    if (!ctx.scope.consts?.has(name) || !ctx.scope.userGlobals?.has(name)) continue
    const from = isArr(s[2]) && s[2][0] === 'global.get' ? found.get(s[2][1]) : null
    if (from) { found.set(s[1], { addr: from.addr, root: from.root, len: from.len, init: s }); continue }
    const addr = staticTypedAddr(s[2], bytes)
    if (addr < 0) continue
    const len = i32At(bytes, addr - 8)
    if (len > 0 && len === i32At(bytes, addr - 4) && addr + len <= bytes.length)
      found.set(s[1], { addr, root: s[1], len, init: s })
  }
  return found
}

/** A memory access based on one of `bindings`: its bytes, or why it is none of ours. */
const privateAccess = (n, bindings) => {
  if (!isAccess(n[0])) return null
  const a = accessOf(n)
  const b = isArr(a.base) && a.base[0] === 'global.get' ? bindings.get(a.base[1]) : null
  if (!b) return null
  const store = STORES.get(n[0]), kind = store || LOADS.get(n[0])
  // A width this pass does not read (a vector, an atomic), or bytes outside the
  // array: a header read is no element, anything else is not ours to reason about.
  const header = !store && a.off >= -HEADER && kind && a.off + kind[0] <= 0
  const ok = kind && (header || (a.off >= 0 && a.off + kind[0] <= b.len))
  return { root: b.root, ok, header, store: !!store, at: b.addr + a.off, size: kind?.[0] ?? 0, type: kind?.[1], signed: kind?.[2] === true, val: a.val }
}

/** Every access based on a binding (`onAccess`), and every other read of one (`onStray`).
 *  An access's address holds its binding and constants; its value is any expression. */
const scan = (root, bindings, onAccess, onStray) => {
  const visit = (n, parent, idx) => {
    if (!isArr(n)) return
    if (n[0] === 'global.get') { if (onStray && bindings.has(n[1])) onStray(n, parent); return }
    const a = privateAccess(n, bindings)
    if (!a) { for (let i = 1; i < n.length; i++) visit(n[i], n, i); return }
    onAccess(a, n, parent, idx)
    if (a.val) visit(a.val, n, n.indexOf(a.val))
  }
  visit(root, null, -1)
}

/**
 * Forward stores to loads and drop unread stores in the static typed arrays only
 * constant-index accesses reach. `funcs` is every function of the module, `__start` included.
 */
export function scalarizeStaticScratch(funcs) {
  const start = funcs.find(f => isArr(f) && f[0] === 'func' && f[1] === '$__start')
  if (!start) return
  const bindings = staticBindings(funcs, start)
  if (!bindings.size) return
  const inits = new Set([...bindings.values()].map(b => b.init))

  // Every read of a binding is the base of an access of known bytes, or its root is open.
  const open = new Set(), users = new Set()
  for (const fn of funcs) scan(fn, bindings,
    a => { if (!a.ok) open.add(a.root); else if (!a.header) users.add(fn) },
    (n, parent) => { if (!(inits.has(parent) && parent[2] === n)) open.add(bindings.get(n[1]).root) })
  for (const [name, b] of bindings) if (open.has(b.root)) bindings.delete(name)
  if (!bindings.size) return

  // The functions a call to which may store to such an array.
  const names = new Set(), stores = new Map(), calls = new Map()
  for (const fn of funcs) if (isArr(fn) && fn[0] === 'func' && typeof fn[1] === 'string') names.add(fn[1])
  for (const fn of funcs) {
    if (!isArr(fn) || fn[0] !== 'func' || typeof fn[1] !== 'string') continue
    let writes = false
    const callees = new Set()
    walkAst(fn, { enter: n => {
      const op = n[0]
      if (OPEN_CALLS.has(op) || BULK.has(op)) writes = true
      else if ((op === 'call' || op === 'return_call') && typeof n[1] === 'string') { if (names.has(n[1])) callees.add(n[1]); else writes = true }
    } })
    scan(fn, bindings, a => { if (a.store) writes = true })
    stores.set(fn[1], writes); calls.set(fn[1], callees)
  }
  for (let changed = true; changed;) {
    changed = false
    for (const [name, callees] of calls) {
      if (stores.get(name)) continue
      for (const c of callees) if (stores.get(c)) { stores.set(name, true); changed = true; break }
    }
  }

  for (const fn of funcs) if (users.has(fn)) forwardIn(fn, bindings, name => stores.get(name) !== false)

  // The bytes a load still reads; a store to none of them goes.
  const read = new Set(), written = []
  for (const fn of funcs) scan(fn, bindings, (a, n, parent) => {
    if (a.header) return
    if (a.store) written.push({ a, n, parent })
    else for (let k = 0; k < a.size; k++) read.add(a.at + k)
  })
  for (const { a, n, parent } of written) {
    let live = false
    for (let k = 0; k < a.size && !live; k++) live = read.has(a.at + k)
    if (live || !isArr(parent)) continue
    const v = a.val
    const rest = v[0] === 'local.tee' ? ['local.set', v[1], v[2]]
      : v[0] === 'local.get' || v[0].endsWith('.const') ? ['nop'] : ['drop', v]
    for (let i = 1; i < parent.length; i++) if (parent[i] === n) parent[i] = rest
  }
}

// One function, in evaluation order. `known` maps a byte's address to the store that
// last wrote it on this path and which of the value's bytes it holds.
const forwardIn = (fn, bindings, mayStore) => {
  const bodyStart = findBodyStart(fn)
  // A node the tree holds twice runs in two places: nothing inside it is replaced.
  const seen = new Set(), shared = new Set(), leaves = new Set()
  walkAst(fn, { enter: n => { if (seen.has(n)) shared.add(n); else seen.add(n) },
    exit: n => { if (BRANCHES.has(n[0])) leaves.add(n); else for (let i = 1; i < n.length; i++) if (leaves.has(n[i])) { leaves.add(n); break } } })
  let locals = 0
  for (let i = 2; i < bodyStart; i++) if (isArr(fn[i]) && fn[i][0] === 'local' && typeof fn[i][1] === 'string' && fn[i][1].startsWith('$__sw')) locals++
  const decls = []
  // The value a store wrote, read again: a constant, or the local its store now sets.
  const ref = (e) => {
    if (e.lit) return clone(e.lit)
    if (!e.local) {
      e.local = `$__sw${locals++}`
      decls.push(['local', e.local, e.type])
      e.node[e.vi] = ['local.tee', e.local, e.node[e.vi]]
    }
    return ['local.get', e.local]
  }
  const bits = (w, e) => {
    const v = ref(e)
    if (w === 'i32') return e.type === 'f32' ? ['i32.reinterpret_f32', v] : v
    return e.type === 'f64' ? ['i64.reinterpret_f64', v] : e.type === 'i64' ? v
      : ['i64.extend_i32_u', e.type === 'f32' ? ['i32.reinterpret_f32', v] : v]
  }
  const wide = e => e.type === 'f64' || e.type === 'i64'
  const compose = (a, runs) => {
    const r0 = runs[0]
    if (runs.length === 1 && !r0.k && r0.len === a.size && r0.e.type === a.type && r0.len === (wide(r0.e) ? 8 : 4) && !a.signed)
      return ref(r0.e)
    const w = a.size === 8 || runs.some(r => wide(r.e)) ? 'i64' : 'i32'
    let all = null
    for (const r of runs) {
      let x = bits(w, r.e)
      if (r.k) x = [`${w}.shr_u`, x, [`${w}.const`, r.k * 8]]
      if (r.k + r.len < (wide(r.e) ? 8 : 4)) x = [`${w}.and`, x, [`${w}.const`, w === 'i64' ? MASK64[r.len] : MASK32[r.len]]]
      if (r.d) x = [`${w}.shl`, x, [`${w}.const`, r.d * 8]]
      all = all ? [`${w}.or`, all, x] : x
    }
    if (a.type === 'f64') return ['f64.reinterpret_i64', all]
    const narrow = w === 'i64' && a.size <= 4 ? ['i32.wrap_i64', all] : all
    if (a.type === 'f32') return ['f32.reinterpret_i32', narrow]
    if (a.type === 'i32') {
      const s = 32 - a.size * 8
      return a.signed && s ? ['i32.shr_s', ['i32.shl', narrow, ['i32.const', s]], ['i32.const', s]] : narrow
    }
    // An i64 result from fewer than eight bytes.
    if (a.size === 8) return all
    if (w === 'i32') return [a.signed ? 'i64.extend_i32_s' : 'i64.extend_i32_u',
      a.signed && a.size < 4 ? ['i32.shr_s', ['i32.shl', all, ['i32.const', 32 - a.size * 8]], ['i32.const', 32 - a.size * 8]] : all]
    const s = 64 - a.size * 8
    return a.signed ? ['i64.shr_s', ['i64.shl', all, ['i64.const', s]], ['i64.const', s]] : all
  }

  let known = new Map()
  const meet = (x, y) => {
    const out = new Map()
    for (const [at, p] of x) { const q = y.get(at); if (q && q.e === p.e && q.k === p.k) out.set(at, p) }
    return out
  }
  const run = (n, parent, idx, frozen) => {
    if (!isArr(n)) return
    const op = n[0]
    if (shared.has(n)) frozen = true
    if (op === 'loop') {
      known = new Map()
      for (let i = 1; i < n.length; i++) run(n[i], n, i, frozen)
      return
    }
    if (op === 'block' || op === 'try_table') {
      for (let i = 1; i < n.length; i++) run(n[i], n, i, frozen)
      if (leaves.has(n)) known = new Map()
      return
    }
    if (op === 'if') {
      let arms = null
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!isArr(c) || (c[0] !== 'then' && c[0] !== 'else')) { run(c, n, i, frozen); continue }
        const before = arms ? arms.before : known
        known = new Map(before)
        for (let j = 1; j < c.length; j++) run(c[j], c, j, frozen)
        arms = { before, ends: arms ? meet(arms.ends, known) : known, n: (arms?.n ?? 0) + 1 }
      }
      if (arms) known = arms.n > 1 ? arms.ends : meet(arms.ends, arms.before)
      return
    }
    for (let i = 1; i < n.length; i++) run(n[i], n, i, frozen)
    if (op === 'call' || op === 'return_call') { if (typeof n[1] !== 'string' || mayStore(n[1])) known = new Map(); return }
    if (OPEN_CALLS.has(op) || BULK.has(op)) { known = new Map(); return }
    const a = privateAccess(n, bindings)
    if (!a || a.header) return
    if (a.store) {
      const vi = n.indexOf(a.val)
      const e = { node: n, vi, type: a.type, local: null, lit: isArr(a.val) && a.val[0] === `${a.type}.const` ? a.val : null }
      for (let k = 0; k < a.size; k++) known.set(a.at + k, { e, k })
      return
    }
    if (frozen || !isArr(parent)) return
    const runs = []
    for (let d = 0; d < a.size; d++) {
      const p = known.get(a.at + d)
      if (!p) return
      const last = runs[runs.length - 1]
      if (last && last.e === p.e && last.k + last.len === p.k) last.len++
      else runs.push({ e: p.e, k: p.k, len: 1, d })
    }
    parent[idx] = compose(a, runs)
  }
  for (let i = bodyStart; i < fn.length; i++) run(fn[i], fn, i, false)
  if (decls.length) fn.splice(bodyStart, 0, ...decls)
}
