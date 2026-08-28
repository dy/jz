/**
 * WASM IR post-emission optimizations.
 *
 * # Stage contract
 *   IN:  WAT-as-array IR (function body or module-level).
 *   OUT: equivalent WAT-as-array IR (same semantics, smaller encoding).
 *   INVARIANTS: semantics-preserving IR→IR rewrites. Leaf passes are context-free;
 *        explicitly documented module-proof passes may read immutable ctx facts. No ctx writes.
 *        No new top-level declarations except those surfaced via `addGlobal`.
 *
 * Each pass is orthogonal. Apply order matters: structural hoists (hoistPtrType) introduce
 * new locals before the fused walk, which mixes peephole rebox folds, ptr-helper inlining,
 * and memarg-offset folding in one bottom-up traversal.
 *
 * Passes:
 *   hoistPtrType      — repeated `(call $__ptr_type X)` on same X → single local.tee + local.get reuse
 *   fusedRewrite      — peephole rebox folds + inline ptr/is_* helpers + memarg-offset fold (one walk)
 *   sortLocalsByUse   — reorder local decls so hot ones get 1-byte LEB128 indices
 *   specializeMkptr   — `(call $__mkptr (i32.const T) (i32.const A) X)` → per-combo specialized helper (~4 B/site)
 *   hoistConstantPool — frequently-repeated f64.const values → mutable globals (~7 B/reuse)
 *   treeshake         — drop func decls unreachable from exports / start / elem / ref.func roots
 *
 * Per-function passes run over sec.funcs + sec.stdlib + sec.start.
 * Whole-module passes see the full function list + globals map.
 *
 * @module optimize
 */

import { LAYOUT, ctx, FORWARDING_MASK } from '../ctx.js'
import { VAL } from '../reps.js'
import { findBodyStart, buildRefcount, nextLocalId, verifyFn, isPureIR, hasExpensiveOp, f64Range, I32_MIN, I32_MAX, cloneIR } from '../ir.js'

// Debug-mode IR structural check (JZ_DEBUG_INVARIANTS=1). Zero production cost.
const DBG_IR = typeof process !== 'undefined' && process.env?.JZ_DEBUG_INVARIANTS === '1'
const DBG_DSR = typeof process !== 'undefined' && !!process.env?.JZ_DBG_DSR
const DBG_UNSWITCH = typeof process !== 'undefined' && (process.env?.JZ_DBG_UNSWITCH || null)
import { T, isLeaf, stableNodeKey, walkAst } from '../ast.js'
import { vectorizeLaneLocal, inlinePureCallExpr } from './vectorize.js'
import { recursionUnroll } from './recurse.js'
export { SIMD_PINNED, inlinePureFnsInFn } from './vectorize.js'
import { nanPrefixHex, atomNanHex, STR_INTERN_BIT, ptrBits, i64Hex, PTR, TYPED_ELEM_CODE, TYPED_ELEM_VIEW_FLAG } from '../../layout.js'


export { hasIROp } from './ir-scan.js'
import { containsV128, hasIROp } from './ir-scan.js'

// Level/string presets + resolveOptimize() — see src/optimize/config.js for
// the full doc (level semantics, the two-layer jz-vs-watr contract, sequencing).
export { PASS_NAMES, TUNING_KEYS, resolveOptimize } from './config.js'

// Region-tracking address/pointer CSE (hoistPtrType, hoistAddrBase) — see
// src/optimize/cse-address.js for the full doc.
export { hoistPtrType, hoistAddrBase } from './cse-address.js'
import { hoistPtrType, hoistAddrBase } from './cse-address.js'

// Branchless select conversion (boolConvertToSelect) — part of the
// peephole/rewrite family, see src/optimize/peephole.js for the full doc.
export { boolConvertToSelect } from './peephole.js'
import { boolConvertToSelect } from './peephole.js'

// Loop-invariant code motion family (hoistInvariantPtrOffset,
// splitLoopPrivateScratch, hoistInvariantLoop, narrowLoopBound, cseScalarLoad)
// — see src/optimize/licm.js for the full doc.
export { hoistInvariantPtrOffset, splitLoopPrivateScratch, hoistInvariantLoop, narrowLoopBound, cseScalarLoad } from './licm.js'
import { hoistInvariantPtrOffset, splitLoopPrivateScratch, hoistInvariantLoop, narrowLoopBound, cseScalarLoad } from './licm.js'

// Local def/use simplification family (propagateSingleUse, foldSetToTee) — see
// src/optimize/locals.js for the full doc.
export { propagateSingleUse, foldSetToTee } from './locals.js'
import { propagateSingleUse, foldSetToTee } from './locals.js'

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
  const bases = x => {
    if (!Array.isArray(x)) return
    if (x[0] === 'local.get' && aliases.has(x[1])) { found.add(aliases.get(x[1]).global); return }
    for (let i = 1; i < x.length; i++) bases(x[i])
  }
  bases(addr)
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
  const ids = n => { if (Array.isArray(n)) { if (n[0] === 'local' && typeof n[1] === 'string') used.add(n[1]); for (let i = 1; i < n.length; i++) ids(n[i]) } }
  ids(fn)
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
  const walk = n => {
    if (!Array.isArray(n)) return
    for (let i = 1; i < n.length; i++) walk(n[i])
    if (n[0] === 'loop') processLoop(n)
  }
  walk(fn)
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

// Whole-module f64 constant pooling (hoistConstantPool) — see
// src/optimize/const-pool.js for the full doc.
export { hoistConstantPool } from './const-pool.js'

// Call-site specialization by literal-arg signature (specializeMkptr) — see
// src/optimize/specialize-mkptr.js for the full doc.
export { specializeMkptr } from './specialize-mkptr.js'

// Pure-function detection for the SIMD lane inliner (buildPureFuncMap) and its
// dead string-dispatch fold (foldStrDispatchF64) — see src/optimize/pure-funcs.js.
export { buildPureFuncMap, foldStrDispatchF64 } from './pure-funcs.js'

/**
 * Loop-unswitch a polymorphic typed-array PARAM loop on the pointer type so the
 * Float64Array case hoists its base and vectorizes.
 *
 * `export function f(buf,n){ for(let i=0;i<n;i++) buf[i]=g(buf[i],i) }` emits a
 * per-iteration POLYMORPHIC store `(drop (if tag(buf)==ARRAY (then __arr_set_idx_ptr;
 * local.set $buf) (else f64.store __ptr_offset(buf)+i<<3)))` and a read
 * `__to_num(reinterpret(__typed_idx(reinterpret(buf), i)))` — re-decoding the NaN-box
 * base every iteration. The `local.set $buf` realloc reassign marks the param unsafe,
 * so hoistInvariantPtrOffset bails and the loop never vectorizes.
 *
 * Insert a ONCE-before-loop test "is buf a (non-BigInt) Float64Array?": yes → a fast
 * loop with the base hoisted to an i32 local, the read collapsed to `f64.load`, and the
 * polymorphic store replaced by a direct `f64.store` (no calls) — which vectorizeLaneLocal
 * then lifts to f64x2. no → the original block verbatim (bit-exact fallback for ARRAY and
 * every other element width). Float64Array (owned aux=7 or view aux=15) is the ONLY gated
 * type: the else-branch f64.store is 8-byte, valid only for f64 elements; Int32Array /
 * Uint8Array / BigInt64Array (aux 4 / 1 / 23) all fall to the verbatim path. The global-
 * Float64Array path already lowers reads to f64.load, proving f64.load == the __to_num
 * read for f64 elements (bit-exact, incl. NaN). All helpers are nested function decls
 * (no ctx param) per the self-compile discipline.
 */
export function unswitchTypedParamLoop(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  // JZ_DBG_UNSWITCH=<substr>: dump matching fns entering this pass (DBG_DSR-style).
  if (DBG_UNSWITCH && String(fn[1]).includes(DBG_UNSWITCH)) console.error(JSON.stringify(fn))
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const f64Params = new Set()
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (Array.isArray(c) && c[0] === 'param' && typeof c[1] === 'string' && c[2] === 'f64') f64Params.add(c[1])
  }
  if (!f64Params.size) return

  const F64 = TYPED_ELEM_CODE.Float64Array, F64V = F64 | TYPED_ELEM_VIEW_FLAG
  const newLocals = []
  let baseId = nextLocalId(fn, 'utb')

  const has = (n, pred) => {
    let found = false
    walkAst(n, { enter: x => {
      if (found) return false
      if (pred(x)) { found = true; return false }
    } })
    return found
  }
  const writes = (n, name) => has(n, (x) => (x[0] === 'local.set' || x[0] === 'local.tee') && x[1] === name)
  const reintParam = (n, p) => Array.isArray(n) && n[0] === 'i64.reinterpret_f64' && Array.isArray(n[1]) && n[1][0] === 'local.get' && n[1][1] === p
  const typedIdx = (n, p) => Array.isArray(n) && n[0] === 'call' && n[1] === '$__typed_idx' && n.length >= 4 && reintParam(n[2], p)

  // A receiver-pointer-kind guard on the SAME param `p` — module/array.js's
  // unknown-receiver, proven-NUMBER-key read fallback:
  // `ptrTypeEq(p,ARRAY) || ptrTypeEq(p,TYPED) ?
  // __typed_idx(p,i) : __dyn_get_expr(...)`, optionally wrapped by its own
  // STRING pointer-kind check. This clone already runs where the OUTER
  // __utb gate has proven `p` IS the target typed-array ctor (PTR.TYPED,
  // matching aux), so ANY further runtime tag test on the SAME `p` here is
  // dead — collapse straight to whichever arm resolves to a typedIdx(p)
  // read; the sibling dyn-props/string arm is unreachable in this
  // specialization.
  //
  // hoistPtrType (runs before this pass) CSEs a repeated `__ptr_type(p)`
  // call — INCLUDING the two calls this guard's own `ARRAY || TYPED` OR
  // makes — into one shared `local.tee $__ptN (...) ` / `local.get $__ptN`
  // pair. When TWO reads of `p` share the same guard shape (`buf[i]*buf[i]`,
  // `buf[i]=f(buf[i])`), only the FIRST occurrence's condition carries the
  // `local.tee` that DEFINES `$__ptN`; the second just reads it. A first cut
  // of this pass deleted the whole condition on collapse — sound for a
  // single occurrence, but for the second (reader) occurrence it deleted the
  // ONLY definition of `$__ptN`, leaving it to read the wasm-default 0 and
  // silently take the dead dyn-props arm on a genuine typed array (a
  // seed-2/4/5/13/14 NaN divergence caught by the Float64Array element-ops
  // fuzz gate). Fix: never delete a matched condition — hoist it, evaluated
  // for its `local.tee` side effect only, to a SINGLE dropped statement once
  // before the loop (paramName is proven not reassigned in this fast body,
  // so the condition is loop-invariant — same footing as `baseSnap`/`gate`
  // below, and keeping it out of the per-iteration body is also what lets
  // the fast read collapse to a bare f64.load the SIMD lane vectorizer still
  // recognizes; a `block`-wrapped drop+load inline broke that pattern match
  // and silently cost the vectorization this whole pass exists to unlock).
  // `drops` accumulates every condition traversed on the path to the
  // matched call (the STRING-wrapper case nests a second guard); the caller
  // dedupes across every read site by structural equality before hoisting.
  function receiverGuardedRead(n, p, drops = []) {
    if (!Array.isArray(n)) return null
    if (typedIdx(n, p)) return { drops, call: n }
    if (n[0] !== 'if' || n.length < 4) return null
    if (!Array.isArray(n[1]) || n[1][0] !== 'result' || n[1][1] !== 'f64') return null
    if (!has(n[2], (x) => reintParam(x, p))) return null
    for (let k = 3; k < n.length; k++) {
      const a = n[k]
      if (!Array.isArray(a) || (a[0] !== 'then' && a[0] !== 'else') || a.length !== 2) continue
      const found = receiverGuardedRead(a[1], p, [...drops, n[2]])
      if (found) return found
    }
    return null
  }

  // Clone, collapsing the typed-array read to a direct f64.load(base + IND<<3):
  //   __to_num(reinterpret(__typed_idx(reinterpret P, IND)))  — and the bare form too.
  // `hoisted` (Map keyed by structural JSON, shared across the whole body scan)
  // collects any receiver-guard conditions found — see receiverGuardedRead's
  // doc comment — for the caller to hoist above the loop, deduplicated.
  function cloneRead(n, p, base, hoisted) {
    if (!Array.isArray(n)) return n
    if (n[0] === 'call' && n[1] === '$__to_num' && n.length === 3
        && Array.isArray(n[2]) && n[2][0] === 'i64.reinterpret_f64' && typedIdx(n[2][1], p))
      return ['f64.load', ['i32.add', ['local.get', base], ['i32.shl', cloneIR(n[2][1][3]), ['i32.const', 3]]]]
    if (typedIdx(n, p))
      return ['f64.load', ['i32.add', ['local.get', base], ['i32.shl', cloneIR(n[3]), ['i32.const', 3]]]]
    const guarded = n[0] === 'if' ? receiverGuardedRead(n, p) : null
    if (guarded) {
      for (const d of guarded.drops) { const key = JSON.stringify(d); if (!hoisted.has(key)) hoisted.set(key, cloneIR(d)) }
      return ['f64.load', ['i32.add', ['local.get', base], ['i32.shl', cloneIR(guarded.call[3]), ['i32.const', 3]]]]
    }
    return n.map((c, i) => i === 0 ? c : cloneRead(c, p, base, hoisted))
  }

  function processBlock(blockNode, parent, idx) {
    if (!Array.isArray(blockNode) || blockNode[0] !== 'block') return
    let loopNode = null, blockLabel = null
    const preamble = []
    for (let i = 1; i < blockNode.length; i++) {
      const c = blockNode[i]
      if (i === 1 && typeof c === 'string' && c.startsWith('$')) { blockLabel = c; continue }
      if (Array.isArray(c) && c[0] === 'loop') { if (loopNode) return; loopNode = c }
      else if (Array.isArray(c) && c[0] === 'local.set' && !loopNode) preamble.push(c)
      else if (Array.isArray(c)) return
    }
    if (!loopNode || !blockLabel) return
    const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
    if (!loopLabel) return
    const endIdx = loopNode.length - 1
    if (!(Array.isArray(loopNode[endIdx]) && loopNode[endIdx][0] === 'br' && loopNode[endIdx][1] === loopLabel)) return
    const incNode = loopNode[endIdx - 1]
    if (!Array.isArray(incNode) || incNode[0] !== 'local.set' || !Array.isArray(incNode[2]) || incNode[2][0] !== 'i32.add') return
    const incVar = incNode[1], inc = incNode[2]
    if (!(Array.isArray(inc[1]) && inc[1][0] === 'local.get' && inc[1][1] === incVar && Array.isArray(inc[2]) && inc[2][0] === 'i32.const' && inc[2][1] === 1)) return
    // Pre-watr, jz wraps every multi-statement expression-group in `(block (result T) …)`
    // — as a dropped expression-statement (drop follows) or as an if-arm's tail value.
    // watr's own vacuum/mergeBlocks used to flatten this post-hoc (when this pass ran
    // post-watr); now it runs pre-watr and must see through the wrapper itself. Unlabeled
    // ⇒ not a branch target (the normalizeTransparentBlocks convention, generalized here to
    // result-carrying blocks since these are unambiguous STATEMENT-LIST positions — never
    // operand slots), so a flattened VIEW is exactly equivalent. Non-mutating: the matched
    // `if` node is shared with the verbatim blockNode preserved as the bit-exact else-
    // fallback, so the scan must not restructure it in place.
    const flattenStmts = (arr, from) => {
      const out = []
      for (let i = from; i < arr.length; i++) {
        const c = arr[i]
        if (Array.isArray(c) && c[0] === 'block' && Array.isArray(c[1]) && c[1][0] === 'result') out.push(...flattenStmts(c, 2))
        else out.push(c)
      }
      return out
    }
    const body = flattenStmts(loopNode, 3).slice(0, -2)  // drop the trailing incNode/br (already validated above)
    if (body.length < 4) return

    // Find the polymorphic-store `if` by scanning (it's followed by a `drop` of its
    // f64 result; in the IR the two are separate statements, not (drop (if …))).
    let storeIdx = -1, storeEndIdx = -1, paramName = null, elseStore = null, helperStore = null
    for (let i = 0; i < body.length; i++) {
      const c = body[i]
      // Outlined ARRAY/TYPED store: the helper owns the runtime width fork and
      // returns the possibly-relocated pointer. Emission materializes that
      // pointer in a temp, then persists it to the receiver binding.
      if (Array.isArray(c) && c[0] === 'local.set' &&
          Array.isArray(c[2]) && c[2][0] === 'call' && c[2][1] === '$__arr_typed_set_idx') {
        const next = body[i + 1], ptrTmp = c[1], call = c[2]
        const p = Array.isArray(next) && next[0] === 'local.set' && f64Params.has(next[1]) &&
          Array.isArray(next[2]) && next[2][0] === 'local.get' && next[2][1] === ptrTmp ? next[1] : null
        const objGet = Array.isArray(call[2]) && call[2][0] === 'i64.reinterpret_f64' ? call[2][1] : null
        const objTmp = Array.isArray(objGet) && objGet[0] === 'local.get' ? objGet[1] : null
        const seeded = p && objTmp && body.slice(0, i).some(st => Array.isArray(st) && st[0] === 'local.set' &&
          st[1] === objTmp && Array.isArray(st[2]) && st[2][0] === 'local.get' && st[2][1] === p)
        if (seeded) {
          let end = i + 1
          const resultGet = body[i + 2], resultDrop = body[i + 3]
          if (Array.isArray(resultGet) && resultGet[0] === 'local.get' &&
              Array.isArray(call[4]) && call[4][0] === 'local.get' && resultGet[1] === call[4][1] &&
              (resultDrop === 'drop' || (Array.isArray(resultDrop) && resultDrop[0] === 'drop'))) end = i + 3
          storeIdx = i; storeEndIdx = end; paramName = p; helperStore = call; break
        }
      }
      if (!Array.isArray(c) || c[0] !== 'if' || !Array.isArray(c[1]) || c[1][0] !== 'result' || c[1][1] !== 'f64') continue
      let thenArm = null, elseArm = null
      for (let k = 2; k < c.length; k++) { const a = c[k]; if (Array.isArray(a)) { if (a[0] === 'then') thenArm = a; else if (a[0] === 'else') elseArm = a } }
      if (!thenArm || !elseArm) continue
      const thenStmts = flattenStmts(thenArm, 1)
      let p = null
      for (const a of thenStmts) {
        if (Array.isArray(a) && a[0] === 'local.set' && f64Params.has(a[1]) && Array.isArray(a[2]) &&
            (a[2][0] === 'local.get' || (a[2][0] === 'call' && a[2][1] === '$__arr_set_idx_ptr'))) p = a[1]
      }
      if (!p || !has(thenArm, (x) => x[0] === 'call' && x[1] === '$__arr_set_idx_ptr')) continue
      // The bare `f64.store(__ptr_offset(o)+i<<3)` is the non-ARRAY fallback. It may be
      // nested under an OBJECT/HASH → __dyn_set guard (emitPolymorphicElementStore's
      // dyn-prop safety fork) — descend to find it; the fast path replaces the whole
      // store with a direct f64.load/store anyway (a proven Float64Array is never an
      // OBJECT, so its dyn arm is dead there). A plain __typed_set_idx arm is also
      // dead-width-specialized by this outer Float64 gate and may be replaced; only
      // the tagged BigInt-capable writer remains ineligible.
      const findRawStore = (n) => {
        let result = null
        walkAst(n, { enter: x => {
          if (result) return false
          if (x[0] === 'f64.store' && Array.isArray(x[1]) && x[1][0] === 'i32.add' &&
              Array.isArray(x[1][2]) && x[1][2][0] === 'i32.shl' &&
              has(x[1], (y) => y[0] === 'call' && y[1] === '$__ptr_offset')) { result = x; return false }
        } })
        return result
      }
      if (has(elseArm, (x) => x[0] === 'call' && x[1] === '$__typed_set_idx_tagged')) continue
      const es = findRawStore(elseArm)
      if (!es) continue
      storeIdx = i; storeEndIdx = i; paramName = p; elseStore = es; break
    }
    if (storeIdx < 0) return
    const shiftIdx = helperStore ? helperStore[3]
      : elseStore[1][2][1]  // the index from the store's (i32.shl IDX 3)
    // The read uses the IV directly; the store uses a snapshot `$asi = $iv`. Emit the
    // store against the IV too so the vectorizer unifies the load/store lanes — bit-exact
    // ($asi == $iv). Bail if the store index isn't the IV or a snapshot of it.
    let storeIdxName = null
    if (Array.isArray(shiftIdx) && shiftIdx[0] === 'local.get') storeIdxName = shiftIdx[1]
    if (storeIdxName !== incVar &&
        !body.some((st) => Array.isArray(st) && st[0] === 'local.set' && st[1] === storeIdxName && Array.isArray(st[2]) && st[2][0] === 'local.get' && st[2][1] === incVar)) return
    // The store-if pushes f64; a following `drop` (bare string in stack-style IR, or a
    // `['drop', …]` node) pops it. The fast store pushes nothing, so the drop must go too.
    const isDrop = (s) => s === 'drop' || (Array.isArray(s) && s[0] === 'drop')
    const hasDrop = storeIdx + 1 < body.length && isDrop(body[storeIdx + 1])

    // Take the stored value from the matched store itself, not by guessing
    // which local reads buf. The outlined helper may carry the whole value
    // expression as its argument; cloneRead rewrites any nested buf reads.
    const storedValue = helperStore ? helperStore[4] : elseStore[2]
    if (!Array.isArray(storedValue)) return
    // GUARD: param reassigned ONLY inside the matched store-if (else the hoisted base goes stale).
    for (let i = 0; i < body.length; i++) { if (i >= storeIdx && i <= storeEndIdx) continue; if (writes(body[i], paramName)) return }
    for (const s of preamble) { if (writes(s, paramName)) return }

    const base = `$__utb${baseId++}`
    newLocals.push(['local', base, 'i32'])
    const reint = () => ['i64.reinterpret_f64', ['local.get', paramName]]
    const tag = ['i32.and', ['i32.wrap_i64', ['i64.shr_u', reint(), ['i64.const', LAYOUT.TAG_SHIFT]]], ['i32.const', LAYOUT.TAG_MASK]]
    const auxOf = () => ['i32.and', ['i32.wrap_i64', ['i64.shr_u', reint(), ['i64.const', LAYOUT.AUX_SHIFT]]], ['i32.const', LAYOUT.AUX_MASK]]
    const gate = ['i32.and', ['i32.eq', tag, ['i32.const', PTR.TYPED]],
      ['i32.or', ['i32.eq', auxOf(), ['i32.const', F64]], ['i32.eq', auxOf(), ['i32.const', F64V]]]]
    const baseSnap = ['local.set', base, ['call', '$__ptr_offset', reint()]]
    const fastStore = ['f64.store',
      ['i32.add', ['local.get', base], ['i32.shl', ['local.get', incVar], ['i32.const', 3]]],
      cloneRead(storedValue, paramName, base, new Map())]
    // Fast body: keep every statement except the store-if (→ fastStore) and its trailing
    // drop (the fast store pushes nothing), with the typed-array read collapsed to f64.load.
    const hoistedGuards = new Map()
    const fastStmts = []
    for (let i = 0; i < body.length; i++) {
      if (i === storeIdx) { fastStmts.push(fastStore); continue }
      if (i > storeIdx && i <= storeEndIdx) continue
      if (hasDrop && i === storeEndIdx + 1) continue
      fastStmts.push(cloneRead(body[i], paramName, base, hoistedGuards))
    }
    // Any receiver-guard conditions cloneRead found (see its doc comment) are
    // loop-invariant here — paramName is proven not reassigned in this fast
    // body — so they run ONCE, before the loop, deduplicated, alongside
    // baseSnap; the loop body then keeps the bare f64.load shape intact.
    const hoistedDrops = [...hoistedGuards.values()].map((d) => ['drop', d])
    const fastLoop = ['block', blockLabel, ...preamble.map(cloneIR),
      ['loop', loopLabel, cloneIR(loopNode[2]), ...fastStmts, cloneIR(incNode), cloneIR(loopNode[endIdx])]]
    parent[idx] = ['if', gate, ['then', baseSnap, ...hoistedDrops, fastLoop], ['else', blockNode]]
  }

  walkAst(fn, { enter: (node, parent, idx) => {
    if (!Array.isArray(node) || !parent || node[0] !== 'block') return
    const before = parent[idx]
    processBlock(node, parent, idx)
    if (parent[idx] !== before) return false
  } })
  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)
}

/** Hoist the SSO/heap choice out of a leaf byte-scan loop.
 *
 * `emitDecompCharRead` deliberately makes both select arms trap-free: SSO
 * routes the speculative heap load to memory[0+idx], while heap receivers may
 * harmlessly evaluate the packed-byte shift. A loop-invariant select is still
 * paid per byte, however. For a compact call-free loop, version the loop once
 * on `$param$ccsso` and fold every matching select in each clone. This is a
 * representation-level loop unswitch, not a source/benchmark special case.
 * Large or call-bearing parser loops fail closed to avoid I-cache growth. */
function unswitchStringRepLoop(fn) {
  // Hand-rolled, not walkAst: walkAst's enter only sees array nodes (primitive
  // operands are deliberately unvisited, see src/ast.js), which would undercount
  // this I-cache guard against the original threshold's calibration below.
  const size = n => !Array.isArray(n) ? 1 : 1 + n.slice(1).reduce((s, x) => s + size(x), 0)
  const containsName = (n, name) => {
    let found = false
    walkAst(n, { enter: x => {
      if (found) return false
      if (x[0] === 'local.get' && x[1] === name) { found = true; return false }
    } })
    return found
  }
  const match = n => {
    if (!Array.isArray(n) || n[0] !== 'select' || n.length !== 4) return null
    const c = n[3]
    if (!Array.isArray(c) || c[0] !== 'local.get' || typeof c[1] !== 'string' || !c[1].endsWith('$ccsso')) return null
    const stem = c[1].slice(0, -6)
    if (!containsName(n[1], `${stem}$ccp64`) || !containsName(n[2], `${stem}$ccldb`)) return null
    return c[1]
  }
  const hasCallOrWrite = (n, flag) => {
    let found = false
    walkAst(n, { enter: x => {
      if (found) return false
      if (x[0] === 'call' || x[0] === 'call_indirect' || x[0] === 'return_call' ||
          ((x[0] === 'local.set' || x[0] === 'local.tee') && x[1] === flag)) { found = true; return false }
    } })
    return found
  }
  const collect = (n, out) => {
    walkAst(n, { enter: (c, parent) => {
      if (parent && c[0] === 'loop') return false
      const m = match(c)
      if (m) out.push(m)
    } })
  }
  const choose = (n, flag, arm) => {
    if (!Array.isArray(n)) return n
    if (match(n) === flag) return choose(n[arm], flag, arm)
    return n.map(x => choose(x, flag, arm))
  }
  walkAst(fn, { enter: (n, parent, idx) => {
    if (!Array.isArray(n) || n[0] !== 'loop' || !parent || size(n) > 250 ||
        n.some(x => Array.isArray(x) && (x[0] === 'result' || x[0] === 'param'))) return
    const flags = []
    collect(n, flags)
    const flag = flags[0]
    if (flag && flags.every(x => x === flag) && !hasCallOrWrite(n, flag)) {
      parent[idx] = ['if', ['local.get', flag],
        ['then', choose(cloneIR(n), flag, 1)],
        ['else', choose(cloneIR(n), flag, 2)]]
      return false
    }
  } })
}

/**
 * Run all per-function IR optimizations on a single function node.
 * hoistPtrType runs first — it introduces new locals (`$__ptN`) that the fused
 * walk should see in their final form. fusedRewrite then collapses rebox/unbox
 * round-trips, inlines tiny ptr/is_* helpers, and folds (i32.add base const)
 * into memarg offset= form, all in a single bottom-up traversal — and
 * piggybacks local-ref counting so sortLocalsByUse skips its own walk.
 *
 * @param fn  func IR node
 * @param cfg optional resolved config from resolveOptimize() — when omitted, all on.
 * @param globalTypes optional global name → wasm type map (for promoteGlobals)
 * @param volatileGlobals optional set of callee-mutable globals (see collectVolatileGlobals)
 * (The former 'post' phase and its csePureExprLoop arm are deleted, and the
 * straight-line csePureExpr followed in the 2026-07 ablation sweeps — watr's
 * write-clock CSE reaches a smaller fixpoint on its own; jz's optimizer runs
 * exactly once, before watr. splitLoopPrivateScratch remains as the flag-gated
 * migration seed; see the splitScratch gate below.)
 */
export function optimizeFunc(fn, cfg, globalTypes, volatileGlobals, reachableWrites) {
  // Entry verify attributes an invalid-IR failure to EMIT (already bad here)
  // vs an optimizer pass (bad only at the exit check) — the jzify free-name
  // `local.get $__it_drain` class was pinned this way. Debug-only cost.
  if (DBG_IR) { const bad = verifyFn(fn); if (bad) throw new Error(`[ir verify] fn ${fn[1]} invalid at optimizeFunc ENTRY (emit-produced): ${bad}`) }
  if (cfg && cfg.hoistPtrType === false &&
      cfg.hoistInvariantPtrOffset === false &&
      cfg.hoistInvariantLoop === false &&
      cfg.narrowLoopBound === false &&
      cfg.fusedRewrite === false &&
      cfg.hoistAddrBase === false &&
      cfg.cseScalarLoad === false &&
      cfg.unswitchStringRepLoop === false &&
      cfg.propagateSingleUse === false &&
      cfg.promoteGlobals === false &&
      cfg.sortLocalsByUse === false &&
      cfg.vectorizeLaneLocal === false &&
      cfg.inlinePtrOffsetFast === false) return
  // Static-const-array base/len fold runs FIRST: it matches the exact emit shape
  // via node tags (.saArr/.saBits), and any later pass that rebuilds a subtree
  // (CSE, fused rewrite, LICM temp-splitting) strips array properties — the tag
  // only survives untouched nodes.
  if (!cfg || cfg.foldStaticArrReads !== false) foldStaticConstArrayReads(fn)
  // Recursion-unrolling runs first in 'pre': self-calls are still clean `call`
  // nodes (watr's inliner hasn't reshaped them) and the freshly-inlined body then
  // rides every pass below (LICM, fold, sort). Speed-tier only; 'pre' only (so the
  // post-watr re-optimize doesn't unroll a second time).
  if (cfg && cfg.recursionUnroll === true) recursionUnroll(fn)
  if (!cfg || cfg.hoistPtrType !== false) hoistPtrType(fn)
  if (!cfg || cfg.hoistInvariantPtrOffset !== false) hoistInvariantPtrOffset(fn)
  // Before LICM: the snapped i32 bound is itself a hoistable hard-op subtree, so
  // an outer loop's LICM can lift it further when the bound is outer-invariant.
  if (!cfg || cfg.narrowLoopBound !== false) narrowLoopBound(fn)
  // Unified LICM (replaces hoistInvariantToInt32 / PtrOffsetLoop / CellLoads).
  // Run at both maturity points (idempotent): pre-fusedRewrite catches the raw
  // ToInt32/ptr-offset/arithmetic shapes; post-hoistAddrBase catches cell loads.
  if (!cfg || cfg.hoistInvariantLoop !== false) hoistInvariantLoop(fn)
  const counts = new Map()
  if (!cfg || cfg.fusedRewrite !== false) fusedRewrite(fn, counts)
  if (cfg && cfg.unswitchStringRepLoop === true && ctx.funcs.list.length <= 64 &&
      fn.some(n => Array.isArray(n) && n[0] === 'local' && typeof n[1] === 'string' && n[1].endsWith('$ccsso')))
    unswitchStringRepLoop(fn)
  if (cfg && cfg.boolConvertToSelect === true) boolConvertToSelect(fn)
  if (!cfg || cfg.hoistAddrBase !== false) hoistAddrBase(fn)
  if (!cfg || cfg.hoistInvariantLoop !== false) hoistInvariantLoop(fn)
  if (!cfg || cfg.cseScalarLoad !== false) cseScalarLoad(fn)
  if (!cfg || cfg.promoteGlobals !== false) promoteGlobals(fn, globalTypes, volatileGlobals, reachableWrites)
  if (cfg && cfg.vectorizeLaneLocal === true) {
    // Vectorization is jz LOWERING — it always runs pre-watr (never in a post-watr
    // re-optimize). watr is the sole optimizer that runs after, and it preserves the
    // v128 the lift produces. `phase === 'post'` is now vestigial (no post caller).
    // foldStrDispatchF64(fn) must not run directly on `fn` here: `fn` is the real,
    // standalone-callable function, and foldStrDispatchF64's "proven rawF64 param"
    // claim is unsound for a bare declared param (see buildPureFuncMap's note above —
    // under NaN-boxing an f64 param can carry a string/undefined/atom just as validly
    // as a real number). Folding `fn` directly would strip its own live runtime
    // string/atom dispatch, not just a copy used for proven-numeric inline
    // substitution — the `g(m.get(missingKey))` "+"-miscompile class. The
    // pureFuncMap-driven inline path (buildPureFuncMap, above in assemble.js) instead
    // folds a private CLONE for the one context where the substituted argument is
    // independently proven numeric (a per-lane typed-array read) — that's the only
    // place this fold is sound.
    if (!cfg || cfg.unswitchTypedParamLoop !== false) unswitchTypedParamLoop(fn)
    if (vectorizeLaneLocal(fn, {
      multiAcc: cfg.reduceUnroll === true,
      relaxedFma: cfg.relaxedSimd === true,
      blurMP: cfg.blurMultiPixel !== false,
      whyNot: cfg.whyNotSimd === true,
      stencil: cfg.stencil !== false,
      outerStrip: cfg.outerStrip !== false,
      pureFuncMap: cfg._pureFuncMap || null,
      toneMap: cfg.toneMap !== false,
      slp: cfg.slp !== false,  // SLP default-on
      crPow: cfg.crPow === true,
    }) && typeof fn[1] === 'string') (cfg._vectorizedFnNames ??= new Set()).add(fn[1])
    // The vectorizer emits `v128.load/store (i32.add base K)` for the unrolled
    // multi-accumulator reduction (a[i],a[i+2],a[i+4]…) and stencil/strided reads.
    // fusedRewrite's memarg fold already ran (above, before vectorize), so fold the
    // freshly-created v128 memargs now — one fewer i32.add per accumulator per
    // iteration in hot dot/sum-style reduction loops.
    foldV128Memargs(fn)
  }
  // Speed-tier only, and deliberately LATE (after unswitchTypedParamLoop/
  // vectorizeLaneLocal above, not bundled into fusedRewrite's earlier walk):
  // unswitchTypedParamLoop's polymorphic-store recognizer pattern-matches the
  // RAW `(call $__ptr_offset …)` shape inside the typed-array fallback store to
  // prove a Float64Array param loop is safe to unswitch + SIMD-lift — running
  // this inline first (it used to live in fusedRewrite) erased that shape and
  // silently starved the unswitch of its match (a whole scalar→SIMD loop lift
  // lost to save a handful of call frames — measured on the DSP self-map flagship
  // shape, test/unswitch-typed-param.js). Running here, after that pass has had
  // its pick, inlines whatever `$__ptr_offset` calls remain — still the large
  // majority of sites.
  if (cfg && cfg.inlinePtrOffsetFast === true) inlinePtrOffsetFastPass(fn)
  // Preserve source-unrolled SSA scratch before propagation sinks its single
  // definition into a local.tee. The transform is gated while it matures; when
  // enabled, its moved invariants ride the normal LICM pass once more below.
  if (cfg && cfg.splitScratch === true && (!cfg || cfg.hoistInvariantLoop !== false)) {
    splitLoopPrivateScratch(fn)
    hoistInvariantLoop(fn)
  }
  // Forward-substitute single-use temps — AFTER the vectorizer, never before: it pattern-matches a
  // STRAIGHT-LINE `s += a[i]*2`, and folding an address/index temp out scrambles it (the typed-array
  // loop fell from a SIMD body to a scalar unroll, +231 B). For watr:false the whole pipeline is the
  // 'pre' phase (no 'post' re-run), so vectorize already ran above; for full watr the vectorizer is
  // deferred to 'post', so skip 'pre' here to stay after it. (propagateSingleUse itself skips any
  // function the vectorizer already lifted to v128.)
  // Forward-substitute single-use temps AFTER the vectorizer (which now always runs in
  // 'pre', above) — propagateSingleUse itself skips any function already lifted to v128.
  if (!cfg || cfg.propagateSingleUse !== false) propagateSingleUse(fn)
  // Then sink single-def RHS into first use as a tee — captures the simplify-locals slack
  // watr's use-count propagate leaves (set→tee fold, incl. effectful single-use forward).
  if (!cfg || cfg.foldSetToTee !== false) foldSetToTee(fn)
  // A second idempotent sweep catches fresh opportunities exposed by
  // propagation/fold-to-tee. The first sweep above does the important work
  // while source-level SSA names are still explicit.
  if (cfg && cfg.splitScratch === true && (!cfg || cfg.hoistInvariantLoop !== false)) {
    splitLoopPrivateScratch(fn)
    hoistInvariantLoop(fn)
  }
  // Const-fn-array dispatch devirt: emit tagged the call_indirect of
  // `constOps[idx](args)` (the decl's candidate set only fills when module init
  // emits, AFTER function bodies) — rewrite to a br_table of direct calls with
  // the original call_indirect as the always-sound default arm.
  if (!cfg || cfg.devirtFnArrays !== false) devirtConstFnArrayCalls(fn, cfg)
  if (!cfg || cfg.devirtSchemaReads !== false) devirtSchemaReads(fn)
  // Loop rotation — the LAST shape pass. Runs in the pre phase (the only phase now); the
  // vectorizer above has already formed the v128 loops it skips. Speed-tier: it duplicates the
  // loop condition for a fused conditional back-edge (1.35× on the lz/qoi scalar scans). watr's
  // loopify is disabled when vectorizing, so nothing downstream reverts the rotation.
  if (cfg && cfg.rotateLoops === true) rotateLoops(fn)
  // Canonicalize boolean conditions (strip redundant `!= 0` / double-`eqz`) — after
  // rotateLoops so its fused back-edges get cleaned too. Tied to the peephole pass.
  if (!cfg || cfg.fusedRewrite !== false) simplifyBoolContexts(fn)
  if (!cfg || cfg.sortLocalsByUse !== false) sortLocalsByUse(fn, cfg && cfg.fusedRewrite !== false ? counts : null)
  // An optimizer pass that emits a malformed local — the class that otherwise dies
  // as an opaque watr "Duplicate/Unknown local $x" several phases on — is caught
  // here, pinned to the function and the bad name.
  if (DBG_IR) { const bad = verifyFn(fn); if (bad) throw new Error(`[ir verify] optimize produced invalid IR in ${fn[1]}: ${bad}`) }
}

// Peephole/rewrite family (foldV128Memargs, inlinePtrOffsetFastPass,
// simplifyBoolContexts, rotateLoops, fusedRewrite/walkRewrite) — see
// src/optimize/peephole.js for the full doc.
export { foldV128Memargs, inlinePtrOffsetFastPass, simplifyBoolContexts, rotateLoops, fusedRewrite } from './peephole.js'
import { foldV128Memargs, inlinePtrOffsetFastPass, simplifyBoolContexts, rotateLoops, fusedRewrite } from './peephole.js'

// Whole-module dead-code elimination (treeshake) — see
// src/optimize/treeshake.js for the full doc.
export { treeshake } from './treeshake.js'

/** `o.x` on a statically-unknown receiver — the megamorphic property read
 *  (shapes bench: 8 record variants at one site, every field load a ~50-op
 *  __dyn_get_any_t_h hash probe). The module's registered schema list is known
 *  and bounded once emission completes: switch on the box's aux schemaId via
 *  br_table into direct slot loads for every schema CARRYING the field — the
 *  static mirror of a polymorphic inline cache. Non-OBJECT tags, alien sids and
 *  schemas lacking the field all take the original call (default arm): a
 *  schema slot is authoritative for its own fields (dyn writes to schema keys
 *  mirror into the slot — buildObjectSchemaSetArm), so the direct load is
 *  bit-identical where it fires. Emit tagged the call (.dvProp) because
 *  schema.list is still growing while function bodies emit. */
export function devirtSchemaReads(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const schemas = ctx.schema?.list
  if (!schemas || !schemas.length || schemas.length > 24) return
  if (!ctx.core.includes.has('__ptr_type')) return
  let uid = null
  const newDecls = []
  // Receiver-stable sid cache: a devirt read whose receiver is a bare local that
  // is NEVER written in this function (param or single-init const — this pass
  // runs before watr inlining, so `measure(o)`-style helpers still have their
  // own frame) has a CONSTANT schemaId for the whole body: the sid lives in the
  // box's aux bits and a jz OBJECT's shape never changes (dyn writes go to the
  // sidecar, not the aux). Compute `sid | -1(non-OBJECT)` ONCE at body start;
  // every read on that receiver drops its per-read __ptr_type guard + aux
  // extract and br_tables on the cached local (-1 wraps u32-huge → default arm).
  const assigned = new Set()
  walkAst(fn, { enter: n => {
    if (Array.isArray(n) && (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') assigned.add(n[1])
  } })
  // receiver expr → { name, bits } for a bare never-written local (f64 local
  // wrapped in reinterpret, or an already-i64 local), else null (keep the
  // per-read spill+guard path)
  const stableRecv = (r) => {
    if (Array.isArray(r) && r[0] === 'i64.reinterpret_f64' &&
      Array.isArray(r[1]) && r[1][0] === 'local.get' && typeof r[1][1] === 'string' &&
      !assigned.has(r[1][1])) return { name: r[1][1], bits: r }
    if (Array.isArray(r) && r[0] === 'local.get' && typeof r[1] === 'string' &&
      !assigned.has(r[1])) return { name: r[1], bits: r }
    return null
  }
  const sidCache = new Map()  // receiver local name → sid i32 local
  const sidInit = []
  const recvReads = new Map()  // receiver local name → tagged-read count (pre-scan)
  const recvAllObject = new Map() // every tagged read already proves OBJECT by static VAL
  // select(aux, -1, tag==OBJECT) — both operands pure, no branch
  const sidExprFor = (bits, objectKnown = false) => objectKnown
    ? ['i32.wrap_i64', ['i64.and',
        ['i64.shr_u', cloneIR(bits), ['i64.const', LAYOUT.AUX_SHIFT]],
        ['i64.const', LAYOUT.AUX_MASK]]]
    : ['select',
        ['i32.wrap_i64', ['i64.and',
          ['i64.shr_u', cloneIR(bits), ['i64.const', LAYOUT.AUX_SHIFT]],
          ['i64.const', LAYOUT.AUX_MASK]]],
        ['i32.const', -1],
        ['i32.eq',
          ['i32.wrap_i64', ['i64.and',
            ['i64.shr_u', cloneIR(bits), ['i64.const', LAYOUT.TAG_SHIFT]],
            ['i64.const', LAYOUT.TAG_MASK]]],
          ['i32.const', PTR.OBJECT]]]
  // ≥2 reads on the receiver: amortize into an entry-hoisted local. A single
  // read inlines the select at its site instead — an eager entry compute would
  // tax every call of a function whose lone read sits on a cold path (the
  // self-compile kernel's shape; measured 0.9% compile-time regression).
  const sidRead = (stable) => {
    const objectKnown = recvAllObject.get(stable.name) === true
    if ((recvReads.get(stable.name) || 0) < 2) return sidExprFor(stable.bits, objectKnown)
    let sidT = sidCache.get(stable.name)
    if (!sidT) {
      sidT = `$__dsrs${uid++}`
      newDecls.push(['local', sidT, 'i32'])
      sidInit.push(['local.set', sidT, sidExprFor(stable.bits, objectKnown)])
      sidCache.set(stable.name, sidT)
    }
    return ['local.get', sidT]
  }
  // Evaluation-order safety class shared by the rewrite and the duplicate-read
  // memo: arms/reuse evaluate ONLY the receiver (or nothing); the original call
  // also evaluates key/tag/hash operands. All must be pure for the paths to be
  // observationally identical (they are in practice: local reads + constants —
  // the emitDynGetAnyTyped shape). `call $__ptr_type` is a pure bit extract.
  const PURE_I64 = new Set(['i64.const', 'i64.reinterpret_f64', 'f64.reinterpret_i64',
    'i64.and', 'i64.or', 'i64.xor', 'i64.shr_u', 'i64.shl', 'i64.eq', 'i64.ne', 'i64.eqz',
    'i64.extend_i32_u', 'i64.extend_i32_s',
    'i32.const', 'i32.wrap_i64', 'i32.and', 'i32.or', 'i32.xor', 'i32.shr_u', 'i32.shl',
    'i32.add', 'i32.sub', 'i32.eq', 'i32.ne', 'i32.eqz'])
  const pureOp = (n) => !Array.isArray(n) ? true
    : n[0] === 'call' && n[1] === '$__ptr_type' ? n.slice(2).every(pureOp)
    : PURE_I64.has(n[0]) ? n.slice(1).every(pureOp)
    : isPureIR(n)
  const rewrite = (parent, i) => {
    const node = parent[i]
    const prop = node.dvProp
    const withProp = []
    for (let sid = 0; sid < schemas.length; sid++) {
      const slot = schemas[sid].indexOf(prop)
      if (slot >= 0) withProp.push([sid, slot])
    }
    if (!withProp.length) return
    // `local.tee` operands (foldSetToTee folds shared tag/CSE
    // locals into the FIRST read's call, possibly nested) are hoisted to
    // standalone sets before the dispatch, innermost first — the original call
    // evaluated them unconditionally, so unconditional sets are observationally
    // identical, later readers of those locals still see them, and the arms
    // (which skip the default call) stay sound.
    const teeHoists = []
    const extractTees = (n) => {
      if (!Array.isArray(n)) return n
      if (n[0] === 'local.tee' && typeof n[1] === 'string') {
        teeHoists.push(['local.set', n[1], extractTees(n[2])])
        return ['local.get', n[1]]
      }
      return n.map((c, k) => k === 0 ? c : extractTees(c))
    }
    const operands = node.slice(2).map(extractTees)
    for (const op of operands) if (!pureOp(op)) { if (DBG_DSR) console.error('[dsr-bail]', prop, 'impure operand:', JSON.stringify(op).slice(0, 200)); return }
    for (const h of teeHoists) if (!pureOp(h[2])) { if (DBG_DSR) console.error('[dsr-bail]', prop, 'impure tee:', JSON.stringify(h).slice(0, 200)); return }
    // the dispatch's generic arm — the original call over the tee-free operands
    const genericCall = [node[0], node[1], ...operands]
    if (uid === null) uid = nextLocalId(fn, '$__dsr')
    const stable = stableRecv(genericCall[2])
    const id = uid++
    const rT = stable ? null : `$__dsr${id}r`
    if (rT) newDecls.push(['local', rT, 'i64'])
    // receiver bits for arms/default: the stable local read inline (fresh clone
    // per use — IR nodes must not alias), or the spill
    const recvBits = () => stable ? cloneIR(stable.bits) : ['local.get', rT]
    const out = `$__dsro${id}`, dflt = `$__dsrd${id}`
    const lo = withProp[0][0], hi = withProp[withProp.length - 1][0]
    const bySid = new Map(withProp)
    // Discriminant-field collapse: when EVERY compile-time schema has the prop
    // at the SAME slot (the canonical tag-field pattern — `.k`/`.type`/`.kind`
    // as first key of every variant literal), a known-schema OBJECT resolves to
    // that slot with no dispatch at all: `(u32)sid < count ? load : generic`.
    // The unsigned compare routes BOTH the -1 non-OBJECT sentinel and any
    // runtime-registered alien sid (__jp_obj / host-marshaled shapes mint sids
    // past the compile-time list) to the generic arm.
    if (stable && withProp.length === schemas.length &&
      withProp.every(([, slot]) => slot === withProp[0][1])) {
      const slot = withProp[0][1]
      const dispatch = ['if', ['result', 'i64'],
        ['i32.lt_u', sidRead(stable), ['i32.const', schemas.length]],
        ['then', ['i64.load',
          ['i32.add', ['i32.wrap_i64', recvBits()], ['i32.const', slot * 8]]]],
        ['else', genericCall]]
      parent[i] = teeHoists.length
        ? ['block', out, ['result', 'i64'], ...teeHoists, dispatch]
        : dispatch
      return
    }
    const labels = Array.from({ length: hi - lo + 1 }, (_, k) => bySid.has(lo + k) ? `$__dsr${id}_${lo + k}` : dflt)
    // arms in sid order: each closes its block, loads its slot, brs out; the
    // innermost block (first arm's label) carries the br_table — selecting on
    // the hoisted sid cache when the receiver is stable (its -1 non-OBJECT
    // sentinel wraps u32-huge → default arm, so no separate tag guard), else
    // on a per-read aux extract behind a per-read tag guard.
    const armSids = withProp.map(([sid]) => sid)
    let inner = ['br_table', ...labels, dflt,
      ['i32.sub',
        stable ? sidRead(stable)
          : ['i32.wrap_i64', ['i64.and',
            ['i64.shr_u', ['local.get', rT], ['i64.const', LAYOUT.AUX_SHIFT]],
            ['i64.const', LAYOUT.AUX_MASK]]],
        ['i32.const', lo]]]
    inner = ['block', `$__dsr${id}_${armSids[0]}`,
      ...(stable ? [] : [['br_if', dflt, ['i32.ne',
        ['call', '$__ptr_type', ['local.get', rT]],
        ['i32.const', PTR.OBJECT]]]]),
      inner]
    for (let k = 0; k < armSids.length; k++) {
      const sid = armSids[k], slot = bySid.get(sid)
      const arm = ['br', out, ['i64.load',
        ['i32.add', ['i32.wrap_i64', recvBits()], ['i32.const', slot * 8]]]]
      const nextLabel = k + 1 < armSids.length ? `$__dsr${id}_${armSids[k + 1]}` : dflt
      inner = ['block', nextLabel, inner, arm]
    }
    const dfltCall = [...genericCall]
    if (!stable) dfltCall[2] = ['local.get', rT]
    parent[i] = ['block', out, ['result', 'i64'],
      ...teeHoists,
      ...(stable ? [] : [['local.set', rT, genericCall[2]]]),
      inner,
      dfltCall]
  }
  let seen = 0
  // pre-scan: count tagged reads per stable receiver (sidRead's entry-hoist
  // choice) AND per (receiver, prop) key — only keys read ≥2× tee their result
  // for the duplicate-read memo below (a lone read must not pay a local write)
  const keyReads = new Map()
  const memoKey = (c) => {
    const st = stableRecv(c[2])
    return st && c.dvProp != null ? `${st.name} ${c.dvProp}` : null
  }
  const countScan = (n) => {
    if (n[0] === 'call' && n.dvProp) {
      const st = stableRecv(n[2])
      if (st) {
        recvReads.set(st.name, (recvReads.get(st.name) || 0) + 1)
        recvAllObject.set(st.name, (recvAllObject.get(st.name) ?? true) && n.dvObject === true)
        const k = `${st.name} ${n.dvProp}`
        keyReads.set(k, (keyReads.get(k) || 0) + 1)
      }
    }
  }
  walkAst(fn, { enter: countScan })
  // Duplicate-read elimination riding the rewrite walk: a SECOND tagged read
  // of the SAME (stable receiver, prop) in the same straight-line region
  // reuses the first read's tee'd i64 — the whole sid-dispatch + slot load
  // drops (measure()'s `imul(o.r, imul(o.r, 3))` pays one read). Soundness:
  // the receiver is a never-written local and a jz OBJECT's shape never
  // changes, so only an intervening WRITE could change the value — any
  // non-readonly call, store, global.set or memory.grow clears the memo.
  // Conditional regions (if arms, labeled blocks a br may skip) keep entries
  // born inside them local: snapshot on entry, restore on exit (outer entries
  // stay usable inside — the first read dominates). A LOOP whose body clobbers
  // clears up front: an entry born before iteration 1's clobber must not serve
  // iteration 2. Replacing a read drops its operand evaluation — legal for
  // exactly the pure class rewrite() enforces; tee'd operands refuse (their
  // set would vanish).
  const READONLY_CALL = /^\$(__dyn_get|__ptr_type$|math\.)/
  const isClobberNode = (x) => {
    const op = x[0]
    if (op === 'call' && !x.dvProp && typeof x[1] === 'string' && !READONLY_CALL.test(x[1])) return true
    return typeof op === 'string' && (op.includes('.store') || op === 'global.set' || op === 'memory.grow')
  }
  const hasClobber = (x) => {
    let found = false
    walkAst(x, { enter: n => {
      if (found) return false
      if (isClobberNode(n)) { found = true; return false }
    } })
    return found
  }
  const noTee = (x) => {
    let clean = true
    walkAst(x, { enter: n => {
      if (!clean) return false
      if (n[0] === 'local.tee') { clean = false; return false }
    } })
    return clean
  }
  const memo = new Map()
  let clobbers = 0
  const scoped = (walkBody) => {
    const snap = new Map(memo), pre = clobbers
    walkBody()
    memo.clear()
    if (clobbers === pre) for (const [k, v] of snap) memo.set(k, v)
  }
  const visitChild = (n, i) => {
    const c = n[i]
    if (!Array.isArray(c)) return
    walkDSR(c)
    if (c[0] === 'call' && c.dvProp) {
      seen++
      const key = memoKey(c)
      const hit = key && memo.get(key)
      if (hit && c.slice(2).every(o => pureOp(o) && noTee(o))) { n[i] = ['local.get', hit]; return }
      rewrite(n, i)
      if (key && (keyReads.get(key) || 0) >= 2 && Array.isArray(n[i])) {
        if (uid === null) uid = nextLocalId(fn, '$__dsr')
        const L = `$__dsrm${uid++}`
        newDecls.push(['local', L, 'i64'])
        n[i] = ['local.tee', L, n[i]]
        memo.set(key, L)
      }
      return
    }
    if (isClobberNode(c)) { memo.clear(); clobbers++ }
  }
  const walkDSR = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'if') {
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!Array.isArray(c)) continue
        if (c[0] === 'then' || c[0] === 'else') scoped(() => walkDSR(c))
        else visitChild(n, i)
      }
      return
    }
    if (n[0] === 'loop') {
      if (hasClobber(n)) { memo.clear(); clobbers++ }
      scoped(() => { for (let i = 1; i < n.length; i++) visitChild(n, i) })
      return
    }
    if (n[0] === 'block' && typeof n[1] === 'string') {
      scoped(() => { for (let i = 1; i < n.length; i++) visitChild(n, i) })
      return
    }
    for (let i = 1; i < n.length; i++) visitChild(n, i)
  }
  walkDSR(fn)
  if (DBG_DSR && String(fn[1]).includes('measure')) console.error('[dsr]', fn[1], 'schemas:', schemas.length, 'tagged seen:', seen)
  if (newDecls.length) {
    let at = typeof fn[1] === 'string' ? 2 : 1
    while (at < fn.length && Array.isArray(fn[at]) &&
      (fn[at][0] === 'export' || fn[at][0] === 'type' || fn[at][0] === 'param' || fn[at][0] === 'result' || fn[at][0] === 'local')) at++
    // sid-cache computations go right after the decls, before the first body
    // statement — stable receivers are never-written names (params), so their
    // value at body start equals their value at every read
    fn.splice(at, 0, ...newDecls, ...sidInit)
  }
}

/** Fold the base/len ceremony of `constArr[i]` element reads whose receiver is a
 *  STATIC array literal bound to a const global (module/array.js tags `.saArr` /
 *  `.saBits` on the read IR; the decl registers ctx.scope.staticArrs). The
 *  data-segment offset and length are compile-time constants, so the per-read
 *  `__ptr_offset` call + header len load collapse to literals — decisive in
 *  loops containing calls, where a callee may write memory and watr's LICM must
 *  keep the loads in place (the devirt'd operator-table dispatch loop is the
 *  canonical victim). Facts gate: any indexed write, resizing method call, or
 *  bare value use of the name anywhere in the program (ctx.types.arrResized /
 *  nameEscapes, collectProgramFacts) keeps the generic form — an alias or a
 *  grow could relocate the payload (header forwarding) or change len, and a
 *  folded base would read stale memory. */
export function foldStaticConstArrayReads(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const sa = ctx.scope.staticArrs
  if (!sa || !sa.size) return
  // Facts must EXIST to fold — an absent fact set means the program was never
  // walked for resize/escape, not that the name is safe.
  const resized = ctx.types.arrResized, escapes = ctx.types.nameEscapes
  if (!resized || !escapes) return
  const rewrite = (node) => {
    const st = sa.get(node.saArr)
    if (!st) return
    // A bits-form tag (receiver folded to a const box at emit) must match the decl's
    // recorded bits; a name-form tag (receiver read `global.get $name` directly) IS
    // the identity — global names are unique.
    if (node.saBits != null && st.bits !== node.saBits) return
    if (resized.has(node.saArr) || escapes.has(node.saArr)) return
    // The base derives from the GLOBAL, not a baked constant: assemble's
    // static-prefix-strip rebases every static pointer AFTER this pass runs, so a
    // baked absolute offset goes stale (caught by the module-const table tests).
    // `global.get` is the strip-safe anchor — the global's init is rebased in
    // place, jz never folds immutable global reads, and watr (which runs after
    // the strip) propagates the rebased init into a final constant memarg. The
    // win stands regardless: the `__ptr_offset` CALL (whose forwarding follow the
    // never-resized proof makes dead) and the len header load both drop.
    const baseIR = () => ['i32.wrap_i64', ['i64.reinterpret_f64', ['global.get', `$${node.saArr}`]]]
    const isBaseIR = (n) => Array.isArray(n) && n[0] === 'i32.wrap_i64' &&
      Array.isArray(n[1]) && n[1][0] === 'i64.reinterpret_f64' &&
      Array.isArray(n[1][1]) && n[1][1][0] === 'global.get' && n[1][1][1] === `$${node.saArr}`
    // 1) base tee → global-derived base: (local.tee $b (call $__ptr_offset …)) → baseIR
    let baseLocal = null
    const subBase = (n, parent, idx) => {
      if (!parent) return
      if (n[0] === 'local.tee' && Array.isArray(n[2]) && n[2][0] === 'call' && n[2][1] === '$__ptr_offset') {
        baseLocal = n[1]
        parent[idx] = baseIR()
        return false
      }
    }
    walkAst(node, { enter: subBase })
    if (!baseLocal) return
    // 2) len header load over the folded base → literal len (position-independent);
    //    remaining base reads → box-derived base
    const subLen = (n, parent, idx) => {
      if (!parent) return
      if (n[0] === 'i32.load' && Array.isArray(n[1]) && n[1][0] === 'i32.sub' &&
          isBaseIR(n[1][1]) &&
          Array.isArray(n[1][2]) && n[1][2][0] === 'i32.const' && +n[1][2][1] === 8) {
        parent[idx] = ['i32.const', st.len]
        return false
      }
      if (n[0] === 'local.get' && n[1] === baseLocal) { parent[idx] = baseIR(); return false }
    }
    walkAst(node, { enter: subLen })
  }
  walkAst(fn, { enter: n => { if (Array.isArray(n) && n.saArr != null) rewrite(n) } })
}

/** `constOps[idx](args)` — data-driven dispatch through a module-const array of
 *  capture-free arrows (operator tables, strategy maps, bytecode handlers). The
 *  generic lowering pays call_indirect's bounds + signature checks per call and
 *  blocks V8 from inlining the tiny bodies. Emit tagged the call_indirect
 *  (`.dvArr` = receiver name); this pass switches on the closure box's OWN
 *  funcIdx (aux bits) via br_table into direct uniform-ABI calls — an AOT
 *  polymorphic inline cache. The untouched original call_indirect is the
 *  default arm, so any runtime divergence (an element overwritten through an
 *  alias, an out-of-range index yielding the UNDEF box) takes the generic path:
 *  semantics are bit-identical regardless of the candidate set. */
export function devirtConstFnArrayCalls(fn, cfg) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const cfa = ctx.scope.constFnArrays
  if (!cfa || !cfa.size) return
  const armInline = !cfg || cfg.inlineDevirtArms !== false
  let uid = null
  const newDecls = []
  // ONE inline-temp counter for the whole function: two dispatch SITES can share
  // a `uid` (a const-folded receiver spills nothing, leaving uid untouched), so a
  // per-site counter would mint the same `$__dvi{uid}_0` twice — duplicate local.
  const inlRef = { next: 0 }
  const rewrite = (parent, i) => {
    const node = parent[i]
    const cands = cfa.get(node.dvArr)
    if (!cands) return
    // shape (module/function.js closure.call inline path):
    // [call_indirect, [type,$ftN], envExpr, [i32.const,n], ...W slots, idxExtract]
    if (!Array.isArray(node[1]) || node[1][0] !== 'type') return
    const env = node[2], argc = node[3]
    if (!Array.isArray(argc) || argc[0] !== 'i32.const') return
    const idxExtract = node[node.length - 1]
    const slots = node.slice(4, node.length - 1)
    const lo = Math.min(...cands.map(c => c.idx)), hi = Math.max(...cands.map(c => c.idx))
    if (hi - lo > 32) return
    if (uid === null) uid = nextLocalId(fn, '$__dv')
    // Spill env + every non-constant slot once; both the arms and the default read the spills.
    // An arg that is itself `f64.convert_i32_s(E)` spills the i32 E and re-materializes the
    // convert at each use — the convert then sits SYNTACTICALLY at every consumer, so the
    // inlined arms' `trunc∘convert` round-trips and `ne(convert, impossible-const)` guards
    // fold away (watr identities). Behind an f64 spill local the value-flow is invisible.
    const spills = []
    const spill = (expr, tag) => {
      if (Array.isArray(expr) && (expr[0] === 'f64.const' || expr[0] === 'local.get')) return expr
      if (Array.isArray(expr) && expr[0] === 'f64.convert_i32_s' && Array.isArray(expr[1])) {
        const name = `$__dv${uid++}${tag}`
        newDecls.push(['local', name, 'i32'])
        spills.push(['local.set', name, expr[1]])
        return ['f64.convert_i32_s', ['local.get', name]]
      }
      const name = `$__dv${uid++}${tag}`
      newDecls.push(['local', name, 'f64'])
      spills.push(['local.set', name, expr])
      return ['local.get', name]
    }
    const envG = spill(env, 'e')
    const slotGs = slots.map((sl, k) => spill(sl, 'a' + k))
    const out = `$__dvo${uid}`, dflt = `$__dvd${uid}`
    const byOff = new Map(cands.map(c => [c.idx - lo, c]))
    const labels = Array.from({ length: hi - lo + 1 }, (_, k) => byOff.has(k) ? `$__dv${uid}_${k}` : dflt)
    // idxExtract reads the env box — after spilling, re-point its env reference:
    // the extraction shape is wrap(and(shr(reinterpret(ENV))...)); rebuild it on the spill.
    const extract = ['i32.sub',
      ['i32.wrap_i64', ['i64.and',
        ['i64.shr_u', ['i64.reinterpret_f64', envG], ['i64.const', LAYOUT.AUX_SHIFT]],
        ['i64.const', LAYOUT.AUX_MASK]]],
      ['i32.const', lo]]
    let inner = ['br_table', ...labels, dflt, extract]
    const armOffsets = [...byOff.keys()].sort((a, b) => a - b)
    inner = ['block', labels[armOffsets[0]], inner]
    // Tiny straight-line body → inline it straight into the arm: the uniform-ABI
    // call (env + argc + W padded f64 slots) vanishes and the arm becomes the
    // operator body itself — the AOT equivalent of the switch a JIT synthesizes
    // for a hot polymorphic table. The UNFILTERED candidate map: an arm executes
    // exactly when the original call did, so a straight-line body with a side
    // effect (closure0's cold string-concat branch inside a polymorphic `+`) is
    // safe to substitute verbatim — inlinePureCallExpr itself enforces the
    // straight-line shape and read-only params, and returns null for anything it
    // can't prove (the call stays). Purity mattered only for value-motion uses.
    const bodies = ctx.scope.dvArmFns
    const nodeCount = (n) => { let c = 0; walkAst(n, { enter: () => { c++ } }); return c }
    // i32 block-narrow: when the receiver is a facts-qualified STATIC table (the
    // same never-resized/never-aliased gate as foldStaticConstArrayReads — its
    // elements are exactly the original arrows, forever) and EVERY candidate body
    // exits through `f64.convert_i32_s` (a ToInt32'd result), the dispatch value
    // is int-valued on every path: arms br the raw i32 (their convert stripped),
    // call-formed arms and the generic call_indirect wrap in i32.trunc_sat_f64_s
    // (exact on int-valued f64), and ONE convert re-boxes the block. The
    // loop-carried receiver of `x = ops[i](x, k)` then has a syntactic-convert
    // def — watr's narrowLocals retypes it and the x-side ToInt32 guard dies the
    // same way the k-side did (watr intguard).
    const convertTopped = (fnNode) => {
      if (!Array.isArray(fnNode)) return false
      const exits = []
      let last = null
      const returns = { enter: n => {
        if (!Array.isArray(n)) return
        if (n[0] === 'return') { exits.push(n.length === 2 ? n[1] : null); return false }
      } }
      for (let k = 2; k < fnNode.length; k++) {
        const s = fnNode[k]
        if (!Array.isArray(s) || s[0] === 'param' || s[0] === 'result' || s[0] === 'local' || s[0] === 'export' || s[0] === 'type') continue
        last = s
        walkAst(s, returns)
      }
      if (last && last[0] !== 'return') exits.push(last)
      return exits.length > 0 && exits.every(e => Array.isArray(e) && e[0] === 'f64.convert_i32_s')
    }
    const sa = ctx.scope.staticArrs?.get(node.dvArr)
    const fns = ctx.scope.dvArmFns
    const narrow = !!(sa && fns && ctx.types.arrResized && ctx.types.nameEscapes &&
      !ctx.types.arrResized.has(node.dvArr) && !ctx.types.nameEscapes.has(node.dvArr) &&
      cands.every(c => convertTopped(fns.get(`$${c.name}`))))
    const intOf = (v) => {
      if (Array.isArray(v) && v[0] === 'f64.convert_i32_s') return v[1]
      if (Array.isArray(v) && v[0] === 'block' && Array.isArray(v[1]) && v[1][0] === 'result' && v[1][1] === 'f64') {
        const vl = v[v.length - 1]
        if (Array.isArray(vl) && vl[0] === 'f64.convert_i32_s')
          return ['block', ['result', 'i32'], ...v.slice(2, -1), vl[1]]
      }
      return ['i32.trunc_sat_f64_s', v]
    }
    for (let k = 0; k < armOffsets.length; k++) {
      const cand = byOff.get(armOffsets[k])
      const call = ['call', `$${cand.name}`, envG, argc, ...slotGs]
      let armVal = null
      const bodyFn = armInline ? bodies?.get(`$${cand.name}`) : null
      if (bodyFn && nodeCount(bodyFn) <= 96)
        armVal = inlinePureCallExpr(call, bodies, inlRef, newDecls, 'f64', '$__dvi')
      const armExpr = armVal ?? call
      const arm = ['br', out, narrow ? intOf(armExpr) : armExpr]
      const nextLabel = k + 1 < armOffsets.length ? labels[armOffsets[k + 1]] : dflt
      inner = ['block', nextLabel, inner, arm]
    }
    // default: the original call_indirect on the spilled operands
    const generic = ['call_indirect', node[1], envG, argc, ...slotGs, node[node.length - 1]]
    parent[i] = narrow
      ? ['f64.convert_i32_s', ['block', out, ['result', 'i32'], ...spills, inner, ['i32.trunc_sat_f64_s', generic]]]
      : ['block', out, ['result', 'f64'], ...spills, inner, generic]
  }
  const walkDV = (n) => {
    if (!Array.isArray(n)) return
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (!Array.isArray(c)) continue
      if (c[0] === 'call_indirect' && c.dvArr) { walkDV(c); rewrite(n, i); continue }
      walkDV(c)
    }
  }
  walkDV(fn)
  if (newDecls.length) {
    let at = typeof fn[1] === 'string' ? 2 : 1
    while (at < fn.length && Array.isArray(fn[at]) &&
      (fn[at][0] === 'export' || fn[at][0] === 'type' || fn[at][0] === 'param' || fn[at][0] === 'result' || fn[at][0] === 'local')) at++
    fn.splice(at, 0, ...newDecls)
  }
}

// Encoding-compactness local reordering (sortLocalsByUse) — see
// src/optimize/sort-locals.js for the full doc.
export { sortLocalsByUse } from './sort-locals.js'
import { sortLocalsByUse } from './sort-locals.js'

// Module-level arena-rewind escape analysis (arenaRewindModule) — see
// src/optimize/arena-rewind.js for the full doc.
export { arenaRewindModule } from './arena-rewind.js'
