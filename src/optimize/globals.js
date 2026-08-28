/**
 * Global/memory hoisting family: module-wide write-set analyses
 * (collectVolatileGlobals, collectReachableGlobalWrites,
 * collectReachableMemoryWrites) that feed the per-function hoists
 * (hoistGlobalPtrOffset, hoistLoopGlobalPtrOffset, hoistStableGlobalConstLoads,
 * guardMaskedVectorSuffix, promoteGlobals) — all built on the shared
 * `globalBaseAliases`/`memGlobal` address-resolution helpers.
 *
 * @module optimize/globals
 */
import { LAYOUT, ctx } from '../ctx.js'
import { VAL } from '../reps.js'
import { findBodyStart, cloneIR } from '../ir.js'
import { walkAst } from '../ast.js'
import { hasIROp } from './ir-scan.js'
import { simplifyBoolContexts } from './peephole.js'

/**
 * Module-wide scan for "volatile" globals — those mutated (`global.set`) in any
 * function other than `$__start`. Globals written only in `$__start` are
 * init-once: `$__start` runs to completion before any other function, so they
 * are effectively read-only afterwards and stay promotable.
 *
 * promoteGlobals uses this to avoid caching a callee-mutable global into a
 * function-entry local across a call (which would leave the local stale).
 *
 * @param {Array<Array>} funcs - all module function IR nodes
 * @returns {Set<string>} volatile global names (with leading `$`)
 */
export function collectVolatileGlobals(funcs) {
  const volatile = new Set()
  const recordWrite = node => {
    if (Array.isArray(node) && node[0] === 'global.set' && typeof node[1] === 'string') volatile.add(node[1])
  }
  const walkOptions = { enter: recordWrite }
  for (const fn of funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func' || fn[1] === '$__start') continue
    walkAst(fn, walkOptions)
  }
  return volatile
}

/**
 * Transitive global-write sets per function: name → Set of globals the function
 * writes directly OR through any (transitively) called function. The precise
 * complement to `collectVolatileGlobals`' coarse module-wide set — a global
 * written only by `init` is volatile module-wide, yet perfectly stable inside
 * a function whose call graph never reaches `init`.
 *
 * Unknown callees (imports — absent from the module's func list) write nothing:
 * wasm imports cannot touch module globals. `call_indirect`/`call_ref` targets
 * are unknown wasm functions — treat as writing every global any function
 * writes (the sound over-approximation).
 */
export function collectReachableGlobalWrites(funcs) {
  const writes = new Map(), callees = new Map(), indirect = new Set(), all = new Set()
  const EMPTY = new Set()
  let w = null, c = null, fnName = null
  // One stable dispatcher instead of one closure + two eager Sets per function.
  const recordEffect = n => {
    if (!Array.isArray(n)) return
    if (n[0] === 'global.set' && typeof n[1] === 'string') {
      if (!w) w = new Set()
      w.add(n[1]); all.add(n[1])
    } else if ((n[0] === 'call' || n[0] === 'return_call') && typeof n[1] === 'string') {
      if (!c) c = new Set()
      c.add(n[1])
    } else if (n[0] === 'call_indirect' || n[0] === 'call_ref' || n[0] === 'return_call_indirect') {
      indirect.add(fnName)
    }
  }
  const walkOptions = { enter: recordEffect }
  for (const fn of funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func' || typeof fn[1] !== 'string') continue
    w = null; c = null; fnName = fn[1]
    walkAst(fn, walkOptions)
    if (w || c || indirect.has(fnName)) writes.set(fnName, w || new Set())
    if (c) callees.set(fnName, c)
  }
  // Dense transitive rows are the expensive part of this analysis: thousands
  // of Sets repeat the same handful of global-name pointers. Convert direct
  // rows once to compact u32 bitsets, then run the closure as word-wise OR.
  const globalIds = new Map()
  for (const name of all) globalIds.set(name, globalIds.size)
  const words = Math.max(1, Math.ceil(globalIds.size / 32))
  const rows = new Map()
  for (const [name, direct] of writes) {
    const bits = new Uint32Array(words)
    for (const g of direct) {
      const id = globalIds.get(g)
      bits[id >>> 5] |= 1 << (id & 31)
    }
    rows.set(name, bits)
  }
  const allBits = new Uint32Array(words)
  for (let id = 0; id < globalIds.size; id++) allBits[id >>> 5] |= 1 << (id & 31)
  // Collapse recursive call components once, then propagate on the resulting
  // DAG. A bit crosses each component edge once instead of once per newly-
  // discovered bit (the event worklist degenerates on large cyclic compilers).
  const names = [...rows.keys()]
  const ids = new Map()
  for (let i = 0; i < names.length; i++) ids.set(names[i], i)
  const index = new Int32Array(names.length), low = new Int32Array(names.length)
  const onStack = new Uint8Array(names.length), componentOf = new Int32Array(names.length)
  index.fill(-1); componentOf.fill(-1)
  const stack = []
  let nextIndex = 0, componentCount = 0
  const strong = v => {
    index[v] = nextIndex
    low[v] = nextIndex++
    stack.push(v); onStack[v] = 1
    for (const callee of callees.get(names[v]) || EMPTY) {
      const w = ids.get(callee)
      if (w == null) continue
      if (index[w] === -1) { strong(w); low[v] = Math.min(low[v], low[w]) }
      else if (onStack[w]) low[v] = Math.min(low[v], index[w])
    }
    if (low[v] !== index[v]) return
    const cid = componentCount++
    while (stack.length) {
      const w = stack.pop()
      onStack[w] = 0
      componentOf[w] = cid
      if (w === v) break
    }
  }
  for (let v = 0; v < names.length; v++) if (index[v] === -1) strong(v)

  const componentBits = [], componentEdges = []
  for (let i = 0; i < componentCount; i++) { componentBits.push(new Uint32Array(words)); componentEdges.push(null) }
  for (let v = 0; v < names.length; v++) {
    const cid = componentOf[v], target = componentBits[cid], direct = rows.get(names[v])
    for (let i = 0; i < words; i++) target[i] |= direct[i]
    if (indirect.has(names[v])) for (let i = 0; i < words; i++) target[i] |= allBits[i]
    for (const callee of callees.get(names[v]) || EMPTY) {
      const w = ids.get(callee)
      if (w != null && componentOf[w] !== cid) {
        let edges = componentEdges[cid]
        if (!edges) { edges = new Set(); componentEdges[cid] = edges }
        edges.add(componentOf[w])
      }
    }
  }
  const solved = new Uint8Array(componentCount)
  const solve = cid => {
    if (solved[cid]) return
    const target = componentBits[cid]
    for (const dep of componentEdges[cid] || EMPTY) {
      solve(dep)
      const source = componentBits[dep]
      for (let i = 0; i < words; i++) target[i] |= source[i]
    }
    solved[cid] = 1
  }
  for (let cid = 0; cid < componentCount; cid++) solve(cid)

  return {
    has(name, global) {
      const id = globalIds.get(global), fid = ids.get(name)
      if (id == null || fid == null) return false
      const row = componentBits[componentOf[fid]]
      return !!(row[id >>> 5] & (1 << (id & 31)))
    },
  }
}

/**
 * Hoist `__ptr_offset` resolution of stable typed-array GLOBALS to one resolve
 * per function. Locals get their pointer unboxed once at bind time, but a
 * module-global typed array (`let x; init = () => { x = new Float64Array(n) }`
 * — the idiomatic DSP-state shape: rfft, game-of-life, diffusion)
 * re-resolves on EVERY element access:
 *   (call $__ptr_offset (i64.reinterpret_f64 (global.get $x)))
 * — 68 such calls in rfft's transform alone, ~7× slower than V8. LICM can't
 * hoist them out of loops: its global-invariance rule requires a call-free
 * loop, and the resolve itself is a call. promoteGlobals can't either: `init`
 * writes the global, so it's volatile module-wide.
 *
 * The precise facts make it sound here: TYPED pointees never forward (only
 * ARRAY/SET/MAP do — same bits ⇒ same offset), so the snapshot is stable iff
 * the global's VALUE is stable through the function — i.e. the function
 * neither writes G itself nor (transitively) calls anything that does
 * (`collectReachableGlobalWrites`). The entry-time resolve is total
 * (`__ptr_offset` bounds-checks garbage to itself), so hoisting past a
 * zero-trip loop or an early return is safe.
 *
 * @param {Array} fn - func IR node
 * @param {Set<string>} stablePtrGlobals - '$name's of VAL.TYPED module globals
 * @param {{has(name:string, global:string):boolean}} reachableWrites - from collectReachableGlobalWrites
 */
// Never-forwarding pointee kinds: every PTR tag outside __ptr_offset's
// forwarding set {ARRAY, HASH, SET, MAP} — same bits ⇒ same offset.
export const STABLE_PTR_VALS = new Set([VAL.TYPED, VAL.STRING, VAL.OBJECT, VAL.BUFFER, VAL.CLOSURE])

/** '$name' set of stable-pointee module globals (hoistGlobalPtrOffset targets). */
export const stablePtrGlobalNames = () => {
  const out = new Set()
  if (ctx.scope.globalValTypes)
    for (const [k, v] of ctx.scope.globalValTypes) if (STABLE_PTR_VALS.has(v)) out.add(`$${k}`)
  return out
}

export function hoistGlobalPtrOffset(fn, stablePtrGlobals, reachableWrites) {
  if (!Array.isArray(fn) || fn[0] !== 'func' || !stablePtrGlobals?.size) return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // `(i64.reinterpret_f64 (global.get $G))` → G, or null.
  const reintGlobal = (n) =>
    Array.isArray(n) && n[0] === 'i64.reinterpret_f64'
      && Array.isArray(n[1]) && n[1][0] === 'global.get' && typeof n[1][1] === 'string'
      ? n[1][1] : null
  // A stable-pointee global's byte-base reaches us in two interchangeable shapes:
  //   • forwarding-aware  `(call $__ptr_offset (i64.reinterpret_f64 (global.get $G)))`
  //   • inline typed read `(i32.wrap_i64 (i64.and (i64.reinterpret_f64 (global.get $G)) MASK))`
  // The inline form is what typed-array reads emit (a fixed-size typed array never
  // relocates, so they skip __ptr_offset's forwarding follow — see module/typedarray.js
  // `typedBase`). For a never-forwarding pointee both yield the identical offset, so
  // either site hoists to the one `__ptr_offset` entry snapshot. Matching only the
  // call form left typed-array globals re-decoding the NaN-box per element in stencil
  // sweeps (watercolor's pressure solve: 5 reads/cell × millions of cells). → G, or null.
  const siteGlobal = (n) => {
    if (!Array.isArray(n)) return null
    if (n[0] === 'call' && n[1] === '$__ptr_offset' && n.length === 3) return reintGlobal(n[2])
    if (n[0] === 'i32.wrap_i64' && n.length === 2 && Array.isArray(n[1]) && n[1][0] === 'i64.and' && n[1].length === 3) {
      const mask = n[1][2]
      if (Array.isArray(mask) && mask[0] === 'i64.const'
          && (typeof mask[1] === 'string' ? Number(mask[1]) : mask[1]) === LAYOUT.OFFSET_MASK)
        return reintGlobal(n[1][1])
    }
    return null
  }

  // Per-global: static site count AND whether any site sits inside a loop. A
  // single in-loop site is a per-ITERATION resolve (lenia's convolution reads
  // each of kdx/kdy/kw at one site × ~14M taps/frame), so loop placement beats
  // site count as the hoist criterion.
  const counts = new Map(), inLoop = new Set(), ownWrites = new Set(), ownCallees = new Set()
  // Globals seen via the `__ptr_offset` call form (vs. only the inline typed mask).
  // The snapshot reuses an EXISTING form so it never resurrects a treeshaken helper:
  // a typed-array-only module emits no `__ptr_offset` call, so snapping one in would
  // reference a function that isn't in the module.
  const ptrOffsetForm = new Set()
  let hasIndirect = false
  const scan = (n, loopDepth) => {
    if (!Array.isArray(n)) return
    const g = siteGlobal(n)
    if (g != null) {
      counts.set(g, (counts.get(g) || 0) + 1)
      if (loopDepth > 0) inLoop.add(g)
      if (n[0] === 'call') ptrOffsetForm.add(g)
      return
    }
    if (n[0] === 'global.set' && typeof n[1] === 'string') ownWrites.add(n[1])
    else if ((n[0] === 'call' || n[0] === 'return_call') && typeof n[1] === 'string') ownCallees.add(n[1])
    else if (n[0] === 'call_indirect' || n[0] === 'call_ref' || n[0] === 'return_call_indirect') hasIndirect = true
    const d = n[0] === 'loop' ? loopDepth + 1 : loopDepth
    for (let i = 1; i < n.length; i++) scan(n[i], d)
  }
  for (let i = bodyStart; i < fn.length; i++) scan(fn[i], 0)
  if (!counts.size) return

  const calleeWrites = (g) => {
    if (hasIndirect) return true  // unknown targets — assume they write
    for (const c of ownCallees) if (reachableWrites?.has(c, g)) return true
    return false
  }

  // Collision-proof snap ids (same scheme as hoistInvariantLoop's $__li).
  const used = new Set()
  walkAst(fn, { enter: n => {
    if (!Array.isArray(n)) return
    if (n[0] === 'local' && typeof n[1] === 'string' && n[1].startsWith('$__go')) {
      const t = n[1].slice(5); if (/^\d+$/.test(t)) used.add(+t)
    }
  } })
  let idCounter = 0
  const freshId = () => { while (used.has(idCounter)) idCounter++; const id = idCounter++; used.add(id); return `$__go${id}` }

  const chosen = new Map()  // global → snap local
  for (const [g, c] of counts) {
    if ((c < 2 && !inLoop.has(g)) || !stablePtrGlobals.has(g) || ownWrites.has(g) || calleeWrites(g)) continue
    chosen.set(g, freshId())
  }
  if (!chosen.size) return

  const replace = (node, parent, idx) => {
    if (!parent) return
    const g = siteGlobal(node)
    if (g != null && chosen.has(g)) { parent[idx] = ['local.get', chosen.get(g)]; return false }
  }
  for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: replace })

  const decls = [], snaps = []
  for (const [g, name] of chosen) {
    decls.push(['local', name, 'i32'])
    // Match an existing site's form so we never reference a treeshaken helper.
    // For a never-forwarding pointee both forms compute the same offset, so the
    // inline mask is a safe (and call-free) snapshot when no __ptr_offset site exists.
    const snap = ptrOffsetForm.has(g)
      ? ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['global.get', g]]]
      : ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', ['global.get', g]], ['i64.const', LAYOUT.OFFSET_MASK]]]
    snaps.push(['local.set', name, snap])
  }
  fn.splice(bodyStart, 0, ...decls, ...snaps)
}

// Constant element reads from a fixed typed-array global are immutable for the
// dynamic extent of a function when neither that function nor any reachable
// callee stores through the same global base. Cache those cells once at entry.
// This is load-CSE across the call/loop boundary: ordinary CSE cannot retain a
// memory value past an unrelated store (for example, writes to an output
// buffer), even when both bases are proven-distinct module allocations.
const typedGlobalByteLengths = () => {
  const widths = new Map([
    ['new.Int8Array', 1], ['new.Uint8Array', 1], ['new.Uint8ClampedArray', 1],
    ['new.Int16Array', 2], ['new.Uint16Array', 2],
    ['new.Int32Array', 4], ['new.Uint32Array', 4], ['new.Float32Array', 4],
    ['new.BigInt64Array', 8], ['new.BigUint64Array', 8], ['new.Float64Array', 8],
  ])
  const out = new Map()
  for (const [name, len] of ctx.scope.globalTypedLen || []) {
    const width = widths.get(ctx.scope.globalTypedElem?.get(name))
    if (width && Number.isInteger(len) && len >= 0) out.set(`$${name}`, len * width)
  }
  return out
}

const irI32Const = n => {
  if (!Array.isArray(n)) return null
  if (n[0] === 'i32.const' && Number.isInteger(n[1])) return n[1]
  if (n.length !== 3) return null
  const a = irI32Const(n[1]), b = irI32Const(n[2])
  if (a == null || b == null) return null
  if (n[0] === 'i32.add') return (a + b) | 0
  if (n[0] === 'i32.sub') return (a - b) | 0
  if (n[0] === 'i32.mul') return Math.imul(a, b)
  if (n[0] === 'i32.shl') return a << b
  return null
}
const globalBaseAliases = fn => {
  const aliases = new Map(), assigns = [], poisoned = new Set()
  walkAst(fn, { enter: n => {
    if (Array.isArray(n) && (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') assigns.push([n[1], n[2]])
  } })
  const resolve = rhs => {
    // Snapshot shape emitted by hoistGlobalPtrOffset:
    // i32.wrap_i64(i64.and(i64.reinterpret_f64(global.get $G), MASK))
    const g = Array.isArray(rhs) && rhs[0] === 'i32.wrap_i64' &&
      Array.isArray(rhs[1]) && rhs[1][0] === 'i64.and' &&
      Array.isArray(rhs[1][1]) && rhs[1][1][0] === 'i64.reinterpret_f64' &&
      Array.isArray(rhs[1][1][1]) && rhs[1][1][1][0] === 'global.get'
      ? rhs[1][1][1][1] : null
    if (typeof g === 'string') return { global: g, offset: 0 }
    if (Array.isArray(rhs) && rhs[0] === 'local.get') return aliases.get(rhs[1]) || null
    if (Array.isArray(rhs) && rhs[0] === 'i32.add') {
      const a = rhs[1], b = rhs[2], ac = irI32Const(a), bc = irI32Const(b)
      if (bc != null) {
        const base = resolve(a); return base && { global: base.global, offset: base.offset == null ? null : base.offset + bc }
      }
      if (ac != null) {
        const base = resolve(b); return base && { global: base.global, offset: base.offset == null ? null : base.offset + ac }
      }
      const ra = resolve(a), rb = resolve(b)
      if (ra && !rb) return { global: ra.global, offset: null }
      if (rb && !ra) return { global: rb.global, offset: null }
    }
    return null
  }
  // All writes to an address alias must resolve to the same global+offset.
  // Conflicting or non-address writes poison it rather than retaining the first.
  for (let changed = true; changed;) {
    changed = false
    for (const [name, rhs] of assigns) {
      if (poisoned.has(name)) continue
      const rec = resolve(rhs)
      if (!rec) continue
      const old = aliases.get(name)
      if (old && (old.global !== rec.global || old.offset !== rec.offset)) { aliases.delete(name); poisoned.add(name); changed = true }
      else if (!old) { aliases.set(name, rec); changed = true }
    }
  }
  // A write that never resolved as an address conflicts with any inferred alias
  // unless it is the snapshot expression itself waiting on no local fact.
  for (const [name, rhs] of assigns) if (aliases.has(name) && !resolve(rhs)) aliases.delete(name)
  return aliases
}

const memAddress = n => {
  let i = 1, offset = 0
  while (typeof n[i] === 'string' && (n[i].startsWith('offset=') || n[i].startsWith('align='))) {
    if (n[i].startsWith('offset=')) offset += Number(n[i].slice(7)) || 0
    i++
  }
  let addr = n[i]
  // Address-base CSE often materializes a constant address with a tee on its
  // first load, followed by local.get uses. Preserve the embedded offset.
  if (Array.isArray(addr) && addr[0] === 'local.tee' && addr.length === 3) addr = addr[2]
  if (Array.isArray(addr) && addr[0] === 'i32.add') {
    const a = addr[1], b = addr[2], ac = irI32Const(a), bc = irI32Const(b)
    if (bc != null) { addr = a; offset += bc }
    else if (ac != null) { addr = b; offset += ac }
  }
  return { addr, offset }
}
const plainLoadOp = op => typeof op === 'string' &&
  /^(?:v128|f32|f64|i32|i64)\.load(?:8|16|32)?(?:_[su])?$/.test(op)
const memGlobal = (n, aliases) => {
  const { addr, offset } = memAddress(n)
  if (Array.isArray(addr) && addr[0] === 'local.get' && aliases.has(addr[1])) {
    const rec = aliases.get(addr[1])
    return { global: rec.global, offset: rec.offset == null ? offset : rec.offset + offset, exact: rec.offset != null }
  }
  const found = new Set()
  walkAst(addr, { enter: x => {
    if (x[0] === 'local.get' && aliases.has(x[1])) { found.add(aliases.get(x[1]).global); return false }
  } })
  return { global: found.size === 1 ? [...found][0] : null, offset, exact: false }
}

/** Per-function transitive set of typed globals written through memory; `*` is unknown aliasing. */
export function collectReachableMemoryWrites(funcs) {
  const direct = new Map(), calls = new Map(), names = new Set()
  for (const fn of funcs) if (Array.isArray(fn) && fn[0] === 'func' && typeof fn[1] === 'string') names.add(fn[1])
  for (const fn of funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func' || typeof fn[1] !== 'string') continue
    const aliases = globalBaseAliases(fn), writes = new Set(), callees = new Set()
    walkAst(fn, { enter: n => {
      if (!Array.isArray(n)) return
      const op = n[0]
      if (typeof op === 'string' && (op.endsWith('.store') || op.includes('.store8') || op.includes('.store16') || op.includes('.store32'))) {
        const { global } = memGlobal(n, aliases)
        writes.add(global || '*')
      } else if (op === 'memory.copy' || op === 'memory.fill' || op === 'memory.init') writes.add('*')
      else if ((op === 'call' || op === 'return_call') && typeof n[1] === 'string') {
        // A missing target is a host import. It can observe an exported memory
        // through its JS closure and mutate arbitrary bytes: fail closed.
        if (names.has(n[1])) callees.add(n[1]); else writes.add('*')
      } else if (op === 'call_indirect' || op === 'call_ref' || op === 'return_call_indirect') writes.add('*')
    } })
    direct.set(fn[1], writes); calls.set(fn[1], callees)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const [name, writes] of direct) {
      const before = writes.size
      for (const callee of calls.get(name) || []) for (const g of direct.get(callee) || ['*']) writes.add(g)
      if (writes.size !== before) changed = true
    }
  }
  return direct
}

export function hoistStableGlobalConstLoads(fn, reachableMemoryWrites, reachableGlobalWrites) {
  if (!Array.isArray(fn) || fn[0] !== 'func' || typeof fn[1] !== 'string') return
  const aliases = globalBaseAliases(fn)
  if (!aliases.size) return
  const byteLens = typedGlobalByteLengths()
  if (!byteLens.size) return
  const writes = reachableMemoryWrites?.get(fn[1]) || new Set(['*'])
  if (writes.has('*') || !reachableGlobalWrites) return
  const opWidth = op => op.startsWith('v128.') ? 16
    : op.startsWith('f64.') || op.startsWith('i64.') ? 8
    : op.includes('load8') ? 1 : op.includes('load16') ? 2 : 4
  const sites = new Map()
  const scan = (n, depth = 0) => {
    if (!Array.isArray(n)) return
    const d = n[0] === 'loop' ? depth + 1 : depth
    const op = n[0]
    if (plainLoadOp(op)) {
      const { global, offset, exact } = memGlobal(n, aliases)
      const width = opWidth(op), limit = byteLens.get(global)
      if (global && exact && !writes.has(global) && Number.isInteger(offset) && offset >= 0 && offset + width <= limit) {
        // Keep sign/zero-extending loads distinct even at the same cell.
        const key = `${op}|${global}|${offset}`
        let rec = sites.get(key)
        if (!rec) sites.set(key, rec = { nodes: [], op, global, offset, depth: 0, type: op.startsWith('f64.') ? 'f64' : op.startsWith('f32.') ? 'f32' : op.startsWith('i64.') ? 'i64' : op.startsWith('v128.') ? 'v128' : 'i32' })
        rec.nodes.push(n); rec.depth = Math.max(rec.depth, d)
        return
      }
    }
    for (let i = 1; i < n.length; i++) scan(n[i], d)
  }
  scan(fn)
  const baseByGlobal = new Map()
  for (const [name, rec] of aliases) if (rec.offset === 0 && !baseByGlobal.has(rec.global)) baseByGlobal.set(rec.global, name)
  const chosen = [...sites.values()].filter(rec =>
    (rec.nodes.length >= 2 || rec.depth > 0) && baseByGlobal.has(rec.global) && !reachableGlobalWrites.has(fn[1], rec.global))
  if (!chosen.length) return

  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const used = new Set()
  walkAst(fn, { enter: n => { if (n[0] === 'local' && typeof n[1] === 'string') used.add(n[1]) } })
  let seq = 0
  const fresh = () => {
    let n = `$__gl${seq++}`
    while (used.has(n)) n = `$__gl${seq++}`
    used.add(n)
    return n
  }
  const chosenGlobals = new Set(chosen.map(rec => rec.global))
  // A base snapshot may originally live inside the first load's local.tee.
  // Since that load is about to become a cached local.get, materialize every
  // chosen base explicitly before its cache initializers.
  const baseInits = []
  for (const global of chosenGlobals) {
    const base = baseByGlobal.get(global)
    baseInits.push(['local.set', base,
      ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', ['global.get', global]], ['i64.const', LAYOUT.OFFSET_MASK]]]])
  }
  // Address-base CSE locals whose defining tees disappear with the replaced
  // loads are initialized canonically from the stable global snapshot.
  const aliasInits = []
  for (const [name, rec] of aliases) {
    if (!chosenGlobals.has(rec.global)) continue
    const base = baseByGlobal.get(rec.global)
    if (rec.offset == null || name === base) continue
    const addr = rec.offset === 0 ? ['local.get', base]
      : ['i32.add', ['local.get', base], ['i32.const', rec.offset]]
    aliasInits.push(['local.set', name, addr])
  }
  const decls = [], inits = [], cachedLoads = new Set()
  for (const rec of chosen) {
    const name = fresh(), base = baseByGlobal.get(rec.global)
    const init = rec.offset === 0 ? [rec.op, ['local.get', base]]
      : [rec.op, `offset=${rec.offset}`, ['local.get', base]]
    cachedLoads.add(name)
    decls.push(['local', name, rec.type]); inits.push(['local.set', name, init])
    for (const n of rec.nodes) { n.length = 2; n[0] = 'local.get'; n[1] = name }
  }

  // Vector kernels commonly broadcast a fixed scalar configuration cell on
  // every helper invocation. Once the cell itself is cached above, its pure
  // splat/conversion is invariant too; cache that v128 value rather than doing
  // f64→f32+splat in every inner iteration.
  const broadcasts = new Map()
  const scanBroadcasts = (n, depth = 0) => {
    if (!Array.isArray(n)) return
    const d = n[0] === 'loop' ? depth + 1 : depth
    let load = null
    if (n[0] === 'f32x4.splat' && Array.isArray(n[1]) && n[1][0] === 'f32.demote_f64' &&
        Array.isArray(n[1][1]) && n[1][1][0] === 'local.get' && cachedLoads.has(n[1][1][1])) load = n[1][1][1]
    else if (n[0] === 'f64x2.splat' && Array.isArray(n[1]) && n[1][0] === 'local.get' && cachedLoads.has(n[1][1])) load = n[1][1]
    if (load) {
      const key = `${n[0]}|${load}`
      let rec = broadcasts.get(key)
      if (!rec) broadcasts.set(key, rec = { nodes: [], depth: 0, exemplar: cloneIR(n) })
      rec.nodes.push(n); rec.depth = Math.max(rec.depth, d)
      return
    }
    for (let i = 1; i < n.length; i++) scanBroadcasts(n[i], d)
  }
  scanBroadcasts(fn)
  for (const rec of broadcasts.values()) {
    if (rec.nodes.length < 2 && rec.depth === 0) continue
    const name = fresh()
    decls.push(['local', name, 'v128']); inits.push(['local.set', name, rec.exemplar])
    for (const n of rec.nodes) { n.length = 2; n[0] = 'local.get'; n[1] = name }
  }

  fn.splice(bodyStart, 0, ...decls)
  // Explicit base/alias initialization above is self-contained, so place the
  // cache at true function entry. Waiting for arbitrary original alias sets can
  // put initialization after a use when an address temp is minted mid-body.
  fn.splice(bodyStart + decls.length, 0, ...baseInits, ...aliasInits, ...inits)
}

// Turn a large, pure SIMD producer ending in
//   out = bitselect(value, fallback, mask)
// into a guarded suffix when `mask` is derived from state produced by an
// earlier convergence loop. If every lane selects the fallback, none of the
// expensive producer (normal/shadow/AO-style vector work) needs to run. Mixed
// groups retain the exact original bitselect and lane semantics.
export function guardMaskedVectorSuffix(fn, reachableMemoryWrites) {
  if (!Array.isArray(fn) || fn[0] !== 'func' || !hasIROp(fn, 'v128.bitselect')) return
  const aliases = globalBaseAliases(fn), byteLens = typedGlobalByteLengths()
  const memoryWrites = reachableMemoryWrites?.get(fn[1]) || new Set(['*'])
  const safeLoad = n => {
    if (memoryWrites.has('*')) return false
    const { global, offset, exact } = memGlobal(n, aliases)
    const op = n[0]
    if (!plainLoadOp(op)) return false
    const width = op.startsWith('v128.') ? 16 : op.startsWith('f64.') || op.startsWith('i64.') ? 8
      : op.includes('load8') ? 1 : op.includes('load16') ? 2 : 4
    return global && exact && !memoryWrites.has(global) && Number.isInteger(offset) &&
      offset >= 0 && offset + width <= (byteLens.get(global) ?? -1)
  }
  const reads = (n, out = new Set()) => {
    walkAst(n, { enter: x => { if (x[0] === 'local.get' && typeof x[1] === 'string') out.add(x[1]) } })
    return out
  }
  const writes = (n, out = new Set()) => {
    walkAst(n, { enter: x => { if ((x[0] === 'local.set' || x[0] === 'local.tee') && typeof x[1] === 'string') out.add(x[1]) } })
    return out
  }
  const nodeCount = n => { let c = 0; walkAst(n, { enter: () => { c++ } }); return c }
  const safeRegion = region => {
    const defs = new Set(), refs = []
    let safe = true
    const inspect = n => {
      if (!safe || !Array.isArray(n)) return false
      const op = n[0]
      if ((op === 'block' || op === 'loop') && typeof n[1] === 'string') defs.add(n[1])
      if ((op === 'br' || op === 'br_if') && typeof n[1] === 'string') refs.push(n[1])
      if (op === 'call' || op === 'return_call' || op === 'call_indirect' || op === 'call_ref' ||
          op === 'return' || op === 'unreachable' || op === 'global.set' ||
          (typeof op === 'string' && (op === 'memory.grow' || op.startsWith('memory.') ||
            /^(?:i32|i64)\.(?:div|rem|trunc_f)/.test(op))) ||
          (typeof op === 'string' && (op.includes('.store') || (op.includes('.load') && !safeLoad(n))))) {
        safe = false
        return false
      }
    }
    for (const n of region) {
      walkAst(n, { enter: inspect })
      if (!safe) return false
    }
    return refs.every(label => defs.has(label))
  }
  const processLoop = loop => {
    // Work from the end so replacing one suffix cannot invalidate earlier indices.
    for (let end = loop.length - 1; end >= 2; end--) {
      const stmt = loop[end]
      if (!Array.isArray(stmt) || stmt[0] !== 'local.set' || typeof stmt[1] !== 'string') continue
      const rhs = stmt[2]
      if (!Array.isArray(rhs) || rhs[0] !== 'v128.bitselect' || rhs.length !== 4) continue
      const mask = rhs[3]
      if (!Array.isArray(mask) || !/^f(?:32x4|64x2)\./.test(mask[0]) || !/(?:eq|ne|lt|le|gt|ge)$/.test(mask[0])) continue
      // The guard evaluates the mask once before the original bitselect. A tee
      // in the comparison would therefore write twice on the true path.
      if (writes(mask).size) continue
      const maskReads = reads(mask)
      let boundary = -1
      for (let i = 2; i < end; i++) {
        const ws = writes(loop[i])
        for (const name of maskReads) if (ws.has(name)) boundary = i
      }
      if (boundary < 2 || boundary + 1 >= end) continue
      const start = boundary + 1, region = loop.slice(start, end + 1)
      if (nodeCount(region) < 300 || !safeRegion(region)) continue
      const regionWrites = new Set(); for (const n of region) writes(n, regionWrites)
      // A suffix write observed before `start` is loop-carried into the next
      // iteration. Skipping it would leave stale state even if no same-iteration
      // use follows the bitselect.
      const outsideReads = new Set(), overwritten = new Set()
      for (let i = 2; i < start; i++) {
        const stmtReads = reads(loop[i])
        for (const name of stmtReads) if (!overwritten.has(name)) outsideReads.add(name)
        // Only an unconditional top-level set definitely kills the prior
        // iteration's value before any later read. Nested/conditional writes
        // remain fail-closed.
        const s = loop[i]
        if (Array.isArray(s) && s[0] === 'local.set' && typeof s[1] === 'string') overwritten.add(s[1])
      }
      for (let i = end + 1; i < loop.length; i++) reads(loop[i], outsideReads)
      let escapes = false
      for (const name of regionWrites) if (name !== stmt[1] && outsideReads.has(name)) { escapes = true; break }
      // The all-false arm skips the region, so its fallback must not depend on
      // a value produced inside that region.
      if (!escapes) for (const name of reads(rhs[2])) if (regionWrites.has(name)) { escapes = true; break }
      if (escapes) continue
      const guarded = ['if', ['v128.any_true', cloneIR(mask)], ['then', ...region],
        ['else', ['local.set', stmt[1], cloneIR(rhs[2])]]]
      loop.splice(start, region.length, guarded)
      end = start
    }
  }
  walkAst(fn, { exit: n => { if (n[0] === 'loop') processLoop(n) } })
}

/**
 * Loop-scoped complement to `hoistGlobalPtrOffset`. That pass requires the
 * WHOLE FUNCTION to be clean w.r.t. a global (no write anywhere, no
 * call_indirect/call_ref anywhere) — one unrelated indirect call ANYWHERE in
 * a large function (e.g. a devirtualized Pratt-loop trampoline that inlines
 * many operator handlers) poisons every stable-pointee global for the WHOLE
 * function, even a tight char-scan loop inside it that touches nothing
 * unsafe itself. This pass re-tries per LOOP, narrowing the write/call scan
 * to just that loop's own subtree (including nested loops, whose dynamic
 * extent is part of the enclosing loop's).
 *
 * Soundness (route (a) from the design note — the simplest sound design):
 * a global's base is hoisted to a loop's preheader iff, within that loop's
 * subtree, (1) the global is never `global.set`, (2) no `call_indirect` /
 * `call_ref` appears at all (fail-closed: an unknown target could write
 * anything), and (3) every DIRECTLY-called function does not (transitively,
 * via `reachableWrites` — `collectReachableGlobalWrites`, itself fail-closed
 * the same way) write the global. No route (b) (re-derive-at-write /
 * generation guard) — a loop that fails (1)-(3) is left exactly as
 * `hoistGlobalPtrOffset` left it.
 *
 * One extra idiom this pass alone needs: the durable-receiver override probe
 * (`sidecarOverride`, src/ir.js) reads a global ONCE per iteration into a
 * local for a NaN/tag check, then reuses that SAME local for the base-decode
 * a few nodes downstream — `local.tee $vo (global.get $cur)` feeding a later
 * `(i64.reinterpret_f64 (local.get $vo))`. hoistGlobalPtrOffset's site
 * matcher only recognizes a DIRECT `global.get`, missing this alias.
 * `buildLocalGlobalAlias` resolves it: `$vo` aliases `$cur` when every write
 * to `$vo` within the loop is textually `(global.get $cur)` — since `$cur`
 * is already proven unwritten in the loop, every such tee assigns the same
 * invariant value, so any downstream read of `$vo` is as invariant as
 * `global.get $cur` itself.
 *
 * Runs immediately after `hoistGlobalPtrOffset` in the same module pass: any
 * site the function-wide pass already hoisted is now `local.get $__goN`, so
 * `siteGlobal` no longer matches it there — the two passes can't double-hoist
 * the same read.
 *
 * @param {Array} fn - func IR node
 * @param {Set<string>} stablePtrGlobals - '$name's of never-forwarding module globals
 * @param {{has(name:string, global:string):boolean}} reachableWrites - from collectReachableGlobalWrites
 */
// hoistLoopGlobalPtrOffset keeps its hand-rolled inspect/replace recursion on
// purpose: the self-compiled kernel (dist/jz.wasm) miscompiles walkAst callbacks
// that capture this pass's per-loop state — the same divergence the loop-hoist
// trio hit (.work/handoff-2026-08-22.md §"Full test:wasm loop-hoist trio");
// test/index.js's kernel leg pins it ("ablation: hoistLoopGlobalPtrOffset …").
export function hoistLoopGlobalPtrOffset(fn, stablePtrGlobals, reachableWrites) {
  if (!Array.isArray(fn) || fn[0] !== 'func' || !stablePtrGlobals?.size) return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Per-loop: locals whose every write in `loopNode` is exactly `(global.get
  // $G)` for one consistent G — a conflicting write (different G, or any
  // other expression) poisons the name for this loop.
  const buildLocalGlobalAlias = (loopNode) => {
    const alias = new Map(), poisoned = new Set()
    const recordAlias = n => {
      if (!Array.isArray(n) || (n[0] !== 'local.set' && n[0] !== 'local.tee') || typeof n[1] !== 'string') return
      const name = n[1], rhs = n[2]
      if (!poisoned.has(name)) {
        const g = Array.isArray(rhs) && rhs[0] === 'global.get' && typeof rhs[1] === 'string' ? rhs[1] : null
        if (g != null && (!alias.has(name) || alias.get(name) === g)) alias.set(name, g)
        else { poisoned.add(name); alias.delete(name) }
      }
    }
    for (let i = 1; i < loopNode.length; i++) walkAst(loopNode[i], { enter: recordAlias })
    return alias
  }

  // `(i64.reinterpret_f64 X)` → stable-pointee global name, or null. X is a
  // direct `(global.get $G)`, or a `(local.get $X)` resolved through `alias`.
  const reintGlobal = (n, alias) => {
    if (!Array.isArray(n) || n[0] !== 'i64.reinterpret_f64' || n.length !== 2) return null
    const x = n[1]
    if (Array.isArray(x) && x[0] === 'global.get' && typeof x[1] === 'string') return x[1]
    if (Array.isArray(x) && x[0] === 'local.get' && typeof x[1] === 'string') return alias.get(x[1]) ?? null
    return null
  }
  // Same two interchangeable shapes as hoistGlobalPtrOffset.siteGlobal — see
  // that function's comment for why both forms hoist to one snapshot.
  const siteGlobal = (n, alias) => {
    if (!Array.isArray(n)) return null
    if (n[0] === 'call' && n[1] === '$__ptr_offset' && n.length === 3) return reintGlobal(n[2], alias)
    if (n[0] === 'i32.wrap_i64' && n.length === 2 && Array.isArray(n[1]) && n[1][0] === 'i64.and' && n[1].length === 3) {
      const mask = n[1][2]
      if (Array.isArray(mask) && mask[0] === 'i64.const'
          && (typeof mask[1] === 'string' ? Number(mask[1]) : mask[1]) === LAYOUT.OFFSET_MASK)
        return reintGlobal(n[1][1], alias)
    }
    return null
  }

  // Collision-proof snap ids — shared `$__goN` numbering space with
  // hoistGlobalPtrOffset so re-running either pass never collides.
  const used = new Set()
  walkAst(fn, { enter: n => {
    if (!Array.isArray(n)) return
    if (n[0] === 'local' && typeof n[1] === 'string' && n[1].startsWith('$__go')) {
      const t = n[1].slice(5); if (/^\d+$/.test(t)) used.add(+t)
    }
  } })
  let idCounter = 0
  const freshId = () => { while (used.has(idCounter)) idCounter++; const id = idCounter++; used.add(id); return `$__go${id}` }

  const newDecls = []

  // Attempt one loop; returns preheader statements to splice just before it
  // (possibly empty). Outer-first (top-down): if the outer loop's hoist
  // succeeds, `replace` below rewrites every matching site in its ENTIRE
  // subtree — including nested loops — so a later independent attempt on a
  // nested loop finds nothing left to do for that global (no double-hoist,
  // no redundant inner snapshot of an outer-invariant value).
  const processLoop = (loopNode) => {
    const alias = buildLocalGlobalAlias(loopNode)
    const sites = new Map(), ownWrites = new Set(), ownCallees = new Set(), ptrOffsetForm = new Set()
    let indirectCount = 0
    const inspect = n => {
      if (!Array.isArray(n)) return
      const g = siteGlobal(n, alias)
      if (g != null) {
        let arr = sites.get(g); if (!arr) { arr = []; sites.set(g, arr) }
        arr.push(n)
        if (n[0] === 'call') ptrOffsetForm.add(g)
        return
      }
      if (n[0] === 'global.set' && typeof n[1] === 'string') ownWrites.add(n[1])
      else if ((n[0] === 'call' || n[0] === 'return_call') && typeof n[1] === 'string') ownCallees.add(n[1])
      else if (n[0] === 'call_indirect' || n[0] === 'call_ref' || n[0] === 'return_call_indirect') indirectCount++
      for (let i = 1; i < n.length; i++) inspect(n[i])
    }
    for (let i = 1; i < loopNode.length; i++) inspect(loopNode[i])

    const preheader = []
    if (sites.size && indirectCount === 0) {
      const calleeNames = [...ownCallees]
      // The candidate set is tiny (module pointer globals per loop). Keep the
      // mapping in parallel arrays while the IR subtree is rewritten in place;
      // this is stable in both native and self-compiled executions.
      const chosenGlobals = [], chosenNames = []
      for (const g of sites.keys()) {
        let calleeWrites = false
        for (const callee of calleeNames) if (reachableWrites?.has(callee, g)) { calleeWrites = true; break }
        if (!stablePtrGlobals.has(g) || ownWrites.has(g) || calleeWrites) continue
        chosenGlobals.push(g)
        chosenNames.push(freshId())
      }
      if (chosenGlobals.length) {
        const replace = (parent, idx) => {
          const node = parent[idx]
          if (!Array.isArray(node)) return
          const g = siteGlobal(node, alias)
          if (g != null) {
            let chosenIdx = -1
            for (let i = 0; i < chosenGlobals.length; i++) if (chosenGlobals[i] === g) { chosenIdx = i; break }
            if (chosenIdx >= 0) { parent[idx] = ['local.get', chosenNames[chosenIdx]]; return }
          }
          for (let i = 1; i < node.length; i++) replace(node, i)
        }
        for (let i = 1; i < loopNode.length; i++) replace(loopNode, i)
        for (let i = 0; i < chosenGlobals.length; i++) {
          const g = chosenGlobals[i], name = chosenNames[i]
          newDecls.push(['local', name, 'i32'])
          const snap = ptrOffsetForm.has(g)
            ? ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['global.get', g]]]
            : ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', ['global.get', g]], ['i64.const', LAYOUT.OFFSET_MASK]]]
          preheader.push(['local.set', name, snap])
        }
      }
    }
    return preheader
  }

  // Walk every statement-bearing container; splice a loop's preheader into
  // its own parent array right before it, then recurse into the loop body
  // (nested loops get their own independent, narrower attempt).
  const walk = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 1; i < node.length; i++) {
      const c = node[i]
      if (Array.isArray(c) && c[0] === 'loop') {
        const pre = processLoop(c)
        if (pre.length) {
          for (let j = pre.length - 1; j >= 0; j--) node.splice(i, 0, pre[j])
          i += pre.length
        }
        walk(c)
      } else {
        walk(c)
      }
    }
  }
  walk(fn)
  for (let i = newDecls.length - 1; i >= 0; i--) fn.splice(bodyStart, 0, newDecls[i])
}

/**
 * Promote read-only globals to locals within each function.
 *
 * When a global is only read (never written) within a function and read ≥ 2 times,
 * load it once at function entry into a fresh local and replace all global.get with local.get.
 *
 * This eliminates repeated global.get instructions (5 bytes each with LEB128 idx) in
 * favour of cheaper local.get (1–2 bytes), and helps V8's TurboFan by reducing the
 * number of load-from-global operations it must track.
 *
 * Only promotes globals that appear read-only in the function body. Globals that are
 * also written (global.set) are left untouched — the promotion would be unsound if
 * the global changes between reads.
 *
 * A within-function read-only check is NOT sufficient: a callee can mutate the
 * global between two reads in this function. `volatileGlobals` (globals written
 * anywhere outside `$__start`) gates that case — a volatile global is not
 * promoted in any function that makes a call. Init-once globals (written only in
 * `$__start`) stay promotable everywhere.
 *
 * @param {Array} fn - Function IR (WAT-as-array)
 * @param {Map<string,string>} [globalTypes] - Optional: global name → wasm type ('i32'|'f64'|'i64'|'funcref')
 * @param {Set<string>} [volatileGlobals] - Optional: globals mutated outside `$__start` (see collectVolatileGlobals)
 */
export function promoteGlobals(fn, globalTypes, volatileGlobals, reachableWrites) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Collect global.get counts, detect any global.set, and note whether the
  // function makes a call (a callee may mutate a volatile global between reads).
  const getCounts = new Map()  // globalName → count
  const written = new Set(), callees = new Set()
  let hasCall = false, hasIndirect = false

  const inspect = node => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'global.get' && typeof node[1] === 'string') {
      getCounts.set(node[1], (getCounts.get(node[1]) || 0) + 1)
      return false
    }
    if (op === 'global.set' && typeof node[1] === 'string') written.add(node[1])
    if (op === 'call' || op === 'return_call') { hasCall = true; if (typeof node[1] === 'string') callees.add(node[1]) }
    else if (op === 'call_indirect' || op === 'call_ref' || op === 'return_call_indirect') { hasCall = true; hasIndirect = true }
  }

  for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: inspect })

  // Build replacement map: globalName → { localName, type } for globals read ≥ 3 times, not written.
  // Threshold 3 avoids size regressions in tiny functions where local setup cost dominates.
  // Find the highest existing $_pg index to avoid duplicate local names on re-runs.
  let localIdx = 0
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (Array.isArray(c) && c[0] === 'local' && typeof c[1] === 'string') {
      const m = c[1].match(/^\$_pg(\d+)$/)
      if (m) localIdx = Math.max(localIdx, parseInt(m[1], 10) + 1)
    }
  }
  const replacements = new Map()
  for (const [gName, count] of getCounts) {
    if (count < 3 || written.has(gName)) continue
    // Unsound to cache a callee-mutable global across a call in this function.
    // With reachableWrites the test is exact per call edge (a global written
    // only by init stays promotable in functions whose call graph never
    // reaches init); without it, fall back to the coarse module-wide set.
    if (hasCall && (reachableWrites
      ? (hasIndirect || [...callees].some(c => reachableWrites.has(c, gName)))
      : volatileGlobals?.has(gName))) continue
    // Determine type: use provided map, or infer from context
    const type = globalTypes?.get(gName) || inferTypeFromContext(fn, gName, bodyStart)
    if (!type) continue  // can't determine type, skip
    const lName = `$_pg${localIdx++}`
    replacements.set(gName, { lName, type })
  }
  if (!replacements.size) return

  // Inject local declarations for promoted globals
  for (const [, { lName, type }] of replacements) {
    fn.splice(bodyStart, 0, ['local', lName, type])
  }
  // After all splices, bodyStart has shifted
  const newBodyStart = bodyStart + replacements.size

  // Insert local.set at the very start of the body (after the new locals)
  let insertIdx = newBodyStart
  for (const [gName, { lName }] of replacements) {
    fn.splice(insertIdx, 0, ['local.set', lName, ['global.get', gName]])
    insertIdx++
  }

  // Replace all global.get with local.get (only for promoted globals)
  const replace = node => {
    if (node[0] === 'global.get' && typeof node[1] === 'string') {
      const info = replacements.get(node[1])
      if (info) { node[0] = 'local.get'; node[1] = info.lName }
      return false
    }
  }
  for (let i = insertIdx; i < fn.length; i++) walkAst(fn[i], { enter: replace })
  // Promotion can expose `i32.ne(local.get, 0)` conditions after the ordinary
  // function peephole already ran. Canonicalize now so native and self-hosted
  // module pipelines converge on the same boolean IR.
  simplifyBoolContexts(fn)
}

/**
 * Infer a global's type from its first usage context within a function body.
 * Looks at how the global.get result is consumed:
 *   - wrapped in i32.wrap_i64 → global is i64 (but jz doesn't use i64 globals)
 *   - used as arg to i32 ops (i32.add, i32.store, etc.) → i32
 *   - stored to i32-typed local → i32
 *   - otherwise → f64 (default for NaN-boxing scheme)
 */
function inferTypeFromContext(fn, gName, bodyStart) {
  let inferred = null
  const check = (node, parent, idx) => {
    if (inferred) return false
    if (node[0] === 'global.get' && node[1] === gName) {
      // Check parent context
      if (parent) {
        const pOp = parent[0]
        // If parent is an i32 op that takes this as operand, likely i32
        if (typeof pOp === 'string') {
          if (pOp.startsWith('i32.') && pOp !== 'i32.wrap_i64' && pOp !== 'i32.trunc_f64') {
            inferred = 'i32'
            return false
          }
          if (pOp === 'i32.store' && idx === 2) { inferred = 'i32'; return false }  // addr
          if (pOp === 'f64.store' && idx === 2) { inferred = 'f64'; return false }  // addr can be i32, but value is f64
          // i32 comparisons already matched the `i32.` prefix above; a `local.set`
          // parent tells us nothing here — both fall through to the f64 default.
        }
      }
      // Default: f64 (the NaN-boxing carrier)
      inferred = 'f64'
      return false
    }
  }
  for (let i = bodyStart; i < fn.length && !inferred; i++) walkAst(fn[i], { enter: check })
  return inferred
}
