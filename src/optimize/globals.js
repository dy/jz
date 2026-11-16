/**
 * Global/memory hoisting family: the per-function hoists (hoistGlobalPtrOffset,
 * hoistLoopGlobalPtrOffset, hoistStableGlobalConstLoads, guardMaskedVectorSuffix,
 * promoteGlobals), each asking the module's effects summary (optimize/effects.js) what
 * a call may write, all built on the shared `globalBaseAliases`/`memGlobal`
 * address-resolution helpers.
 *
 * @module optimize/globals
 */
import { LAYOUT } from '../../layout.js'
import { VAL } from '../reps.js'
import { findBodyStart, cloneIR } from '../ir.js'
import { walkAst } from '../ast.js'
import { linear, memop, keyOf } from './address.js'
import { hasIROp } from './ir-scan.js'

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
 * neither writes G itself nor calls anything that may (`effects.sets`). The entry-time resolve is total
 * (`__ptr_offset` bounds-checks garbage to itself), so hoisting past a
 * zero-trip loop or an early return is safe.
 *
 * @param {Array} fn - func IR node
 * @param {Map<string, string>} stablePtrGlobals - '$name' → value type of the stable-pointee module globals (stablePtrGlobalNames)
 * @param fx - the module's effects (optimize/effects.js)
 */
// Never-forwarding pointee kinds: every PTR tag outside __ptr_offset's
// forwarding set {ARRAY, HASH, SET, MAP} — same bits ⇒ same offset.
const STABLE_PTR_VALS = new Set([VAL.TYPED, VAL.STRING, VAL.OBJECT, VAL.BUFFER, VAL.CLOSURE])

/** '$name' → value type of the stable-pointee module globals (hoistGlobalPtrOffset
 *  targets), of the module's value types (ctx.scope.globalValTypes). */
export const stablePtrGlobalNames = (globalValTypes) => {
  const out = new Map()
  if (globalValTypes)
    for (const [k, v] of globalValTypes) if (STABLE_PTR_VALS.has(v)) out.set(`$${k}`, v)
  return out
}

/** Whether no code writes module global `g` ('$name') once the start function has run: it is
 *  immutable, or the module's code sets it in no function but the start function (`effects`,
 *  optimize/effects.js setAfterStart) and the host reaches it by no export (an exported mutable
 *  global is the host's to set between calls) and no import. Of the compile's facts: `globals`
 *  (ctx.scope.globals) and `exports` (ctx.funcs.exports, a binding's name or the one it names). */
export const settledGlobal = (g, { effects, globals, exports }) => {
  const name = g.slice(1), rec = globals?.get(name)
  if (!rec) return false
  if (!rec.mut) return true
  if (rec.export != null || exports && (Object.hasOwn(exports, name) || Object.values(exports).includes(name))) return false
  return !!effects && !effects.setAfterStart(g)
}

export function hoistGlobalPtrOffset(fn, stablePtrGlobals, fx) {
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
    for (const c of ownCallees) if (fx?.sets(c, g)) return true
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

  const lengths = new Map()
  const replace = (node, parent, idx) => {
    if (!parent) return
    // The allocation header of a fixed typed array never changes. Capture
    // it alongside the base, so element stores cannot pin it inside loops.
    const addr = node[0] === 'i32.load' && node.length === 2 ? node[1] : null
    if (addr?.[0] === 'i32.sub' && addr[2]?.[0] === 'i32.const' && addr[2][1] === 8) {
      const g = siteGlobal(addr[1])
      if (chosen.has(g) && stablePtrGlobals.get(g) === VAL.TYPED) {
        let name = lengths.get(g)
        if (!name) lengths.set(g, name = freshId())
        parent[idx] = ['local.get', name]
        return false
      }
    }
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
    if (lengths.has(g)) {
      const len = lengths.get(g)
      decls.push(['local', len, 'i32'])
      // An uninitialized global has offset zero. Speculation must remain
      // safe for zero-trip loops; the original receiver check still throws
      // if the program actually reaches a read or write through it.
      snaps.push(['local.set', len, ['if', ['result', 'i32'], ['local.get', name],
        ['then', ['i32.load', ['i32.sub', ['local.get', name], ['i32.const', 8]]]],
        ['else', ['i32.const', 0]]]])
    }
  }
  fn.splice(bodyStart, 0, ...decls, ...snaps)
  return chosen
}

// Constant element reads from a fixed typed-array global are immutable for the
// dynamic extent of a function when neither that function nor any reachable
// callee stores through the same global base. Cache those cells once at entry.
// This is load-CSE across the call/loop boundary: ordinary CSE cannot retain a
// memory value past an unrelated store (for example, writes to an output
// buffer), even when both bases are proven-distinct module allocations.
const typedGlobalByteLengths = (globalTypedLen, globalTypedElem) => {
  const widths = new Map([
    ['new.Int8Array', 1], ['new.Uint8Array', 1], ['new.Uint8ClampedArray', 1],
    ['new.Int16Array', 2], ['new.Uint16Array', 2],
    ['new.Int32Array', 4], ['new.Uint32Array', 4], ['new.Float32Array', 4],
    ['new.BigInt64Array', 8], ['new.BigUint64Array', 8], ['new.Float64Array', 8],
  ])
  const out = new Map()
  for (const [name, len] of globalTypedLen || []) {
    const width = widths.get(globalTypedElem?.get(name))
    if (width && Number.isInteger(len) && len >= 0) out.set(`$${name}`, len * width)
  }
  return out
}

// The typed global a sum points into (optimize/address.js): its one box pointer, a global's
// (`hoistGlobalPtrOffset`'s snapshot, `i32.wrap_i64` of the box's bits), at the sum's
// constant where that is all the sum adds, or at an offset no one knows.
const globalOf = (lin) => {
  if (!lin) return null
  let g = null
  for (const [key, t] of lin.terms) if (key.startsWith('p:g:')) { if (g || t.scale !== 1) return null; g = key.slice(4) }
  return g && { global: g, offset: lin.terms.size === 1 ? lin.k : null }
}
// (a local an alias names reads as its global's pointer and its offset, or an index no one knows)
const aliasLook = (aliases) => (n) => {
  const rec = n[0] === 'local.get' && aliases.get(n[1])
  if (!rec) return undefined
  const terms = new Map([['p:g:' + rec.global, { scale: 1, node: n }]])
  if (rec.offset == null) terms.set('n:?' + n[1], { scale: 1, node: n })
  return { sum: { k: rec.offset ?? 0, terms } }
}
export const globalBaseAliases = fn => {
  const aliases = new Map(), assigns = [], poisoned = new Set()
  walkAst(fn, { enter: n => {
    if (Array.isArray(n) && (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') assigns.push([n[1], n[2]])
  } })
  const look = aliasLook(aliases)
  const resolve = rhs => globalOf(linear(rhs, look))
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

const plainLoadOp = op => typeof op === 'string' &&
  /^(?:v128|f32|f64|i32|i64)\.load(?:8|16|32)?(?:_[su])?$/.test(op)
// The typed global an access reads or writes through, at its byte offset where that is exact;
// a global named under an operation of no add (an index masked, shifted) is the global's, at
// no exact offset.
export const memGlobal = (n, aliases) => {
  const m = memop(n), lin = m && linear(m.addr, aliasLook(aliases))
  const rec = globalOf(lin)
  if (rec) return { global: rec.global, offset: (rec.offset ?? lin.k) + m.off, exact: rec.offset != null }
  const found = new Set(lin ? [...keyOf(lin).matchAll(/p:g:(\$[^\s)+#*]+)/g)].map(x => x[1]) : [])
  return { global: found.size === 1 ? [...found][0] : null, offset: m ? m.off : 0, exact: false }
}

// Facts: the module's fixed typed-array globals, their lengths and kinds (`globalTypedLen`,
// `globalTypedElem`), and those holding buffers of their own (`freshTypedGlobals`).
export function hoistStableGlobalConstLoads(fn, fx, { globalTypedLen = null, globalTypedElem = null, freshTypedGlobals: own = null } = {}) {
  if (!Array.isArray(fn) || fn[0] !== 'func' || typeof fn[1] !== 'string') return
  const aliases = globalBaseAliases(fn)
  if (!aliases.size) return
  const byteLens = typedGlobalByteLengths(globalTypedLen, globalTypedElem)
  if (!byteLens.size) return
  const writes = fx ? fx.memOf(fn[1]) : new Set(['*'])
  if (writes.has('*')) return
  // A store through one global leaves another's elements alone only when both
  // hold buffers of their own: `b = a`, or a view of `a.buffer`, is a.
  const apart = global => !writes.size || !!own?.has(global) && [...writes].every(g => own.has(g))
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
      if (global && exact && !writes.has(global) && apart(global) && Number.isInteger(offset) && offset >= 0 && offset + width <= limit) {
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
    (rec.nodes.length >= 2 || rec.depth > 0) && baseByGlobal.has(rec.global) && !fx.sets(fn[1], rec.global))
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
export function guardMaskedVectorSuffix(fn, fx) {
  if (!Array.isArray(fn) || fn[0] !== 'func' || !hasIROp(fn, 'v128.bitselect')) return
  const aliases = globalBaseAliases(fn), byteLens = typedGlobalByteLengths()
  const memoryWrites = fx ? fx.memOf(fn[1]) : new Set(['*'])
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
 * anything), and (3) no DIRECTLY-called function may write the global
 * (`effects.sets`, fail-closed the same way). No route (b) (re-derive-at-write /
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
 * Runs after `hoistGlobalPtrOffset` and reuses its entry snapshots when the
 * broader write proof already holds; other globals use per-loop snapshots.
 *
 * @param {Array} fn - func IR node
 * @param {Map<string, string>} stablePtrGlobals - '$name's of never-forwarding module globals (stablePtrGlobalNames)
 * @param fx - the module's effects (optimize/effects.js)
 */
// hoistLoopGlobalPtrOffset keeps its hand-rolled inspect/replace recursion on
// purpose: the self-compiled kernel (dist/jz.wasm) miscompiles walkAst callbacks
// that capture this pass's per-loop state — the same divergence the loop-hoist
// trio hit (.work/archive/handoff-2026-08-22.md §"Full test:wasm loop-hoist trio");
// test/index.js's kernel leg pins it ("ablation: hoistLoopGlobalPtrOffset …").
export function hoistLoopGlobalPtrOffset(fn, stablePtrGlobals, fx, entrySnapshots) {
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
        for (const callee of calleeNames) if (fx?.sets(callee, g)) { calleeWrites = true; break }
        if (!stablePtrGlobals.has(g) || ownWrites.has(g) || calleeWrites) continue
        chosenGlobals.push(g)
        chosenNames.push(entrySnapshots?.get(g) ?? freshId())
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
          if (entrySnapshots?.has(g)) continue
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
 * global between two reads in this function. `fx` (the module's effects,
 * optimize/effects.js) gates that case per call edge; without it, calls are not
 * checked (unit-test callers only).
 *
 * @param {Array} fn - Function IR (WAT-as-array)
 * @param {Map<string,string>} [globalTypes] - Optional: global name → wasm type ('i32'|'f64'|'i64'|'funcref')
 * @param [fx] - the module's effects
 */
export function promoteGlobals(fn, globalTypes, fx) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Collect global.get counts, detect any global.set, and note whether the
  // function makes a call (a callee may mutate a volatile global between reads).
  const getCounts = new Map()  // globalName → count
  const written = new Set(), callees = new Set()
  let hasIndirect = false

  const inspect = node => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'global.get' && typeof node[1] === 'string') {
      getCounts.set(node[1], (getCounts.get(node[1]) || 0) + 1)
      return false
    }
    if (op === 'global.set' && typeof node[1] === 'string') written.add(node[1])
    if (op === 'call' || op === 'return_call') { if (typeof node[1] === 'string') callees.add(node[1]) }
    else if (op === 'call_indirect' || op === 'call_ref' || op === 'return_call_indirect') hasIndirect = true
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
    // Unsound to cache a global what the function runs may write: a callee
    // (the test is exact per call edge: a global written only by init stays
    // promotable in functions whose call graph never reaches init), or a
    // kernel a later pass calls in it (`later` of the effects' solve:
    // a loop's compaction, which bumps the epoch an iteration's release
    // reads), which the function's own row holds.
    if (fx && (hasIndirect || fx.sets(fn[1], gName) || [...callees].some(c => fx.sets(c, gName)))) continue
    // Determine type: use provided map, or infer from context
    const type = globalTypes?.get(gName) || inferTypeFromContext(fn, gName, bodyStart)
    if (!type) continue  // can't determine type, skip
    const lName = `$_pg${localIdx++}`
    replacements.set(gName, { lName, type })
  }
  // The copy holds what the global holds: the header facts follow it (optimize/licm.js).
  const facts = (g, l) => { for (const s of [fn.presentArrays, fn.stableHeaderNames, fn.viewNames, fn.presentTyped]) if (s?.has(g)) s.add(l) }
  const swap = (n, names) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'global.get' && names.has(n[1])) { n[0] = 'local.get'; n[1] = names.get(n[1]); return }
    for (let i = 1; i < n.length; i++) swap(n[i], names)
  }
  let at = bodyStart
  if (replacements.size) {
    // Inject local declarations for promoted globals, and their copies at the very start of the body
    for (const [, { lName, type }] of replacements) fn.splice(bodyStart, 0, ['local', lName, type])
    at = bodyStart + replacements.size
    for (const [gName, { lName }] of replacements) { fn.splice(at++, 0, ['local.set', lName, ['global.get', gName]]); facts(gName, lName) }
    const names = new Map([...replacements].map(([g, r]) => [g, r.lName]))
    for (let i = at; i < fn.length; i++) swap(fn[i], names)
  }
  if (!fx) return
  // A global the function as a whole keeps no copy of (a call may set it, or the function
  // does outside a loop), a loop keeps, read as it is entered, where it sets it nowhere and
  // calls nothing indirect, nothing that may set it and nothing that comes back having
  // written memory (a copy kept across such a call is a spill a round, where the read after
  // it is a load): the loops of a function that calls the host elsewhere (decode-wav's
  // tables beside its `__ext` calls). Outer loops first; an inner loop tries what is left.
  // A loop the emitter wrapped in a block of its own (`(block $brk … (loop …))`) is copied
  // for ahead of that block, where it is read before anything a later pass lifts to the
  // block's head (LICM's snaps of the copy itself, which would read it unset).
  // The function's own threshold holds for a loop: a global the function reads under three
  // times was never worth a copy and is not worth one a loop. A copy in every loop that read
  // a global put one in `__ptr_offset_fwd`, whose loop follows a forward and runs one round:
  // the same reads, a local more, and three.js's animation case 7% slower (V8's time; the
  // helper is called from every array access).
  const decls = []
  const inLoop = (loop) => {
    const reads = new Set(), sets = new Set(), calls = new Set()
    let indirect = false
    const scan = (n) => {
      if (!Array.isArray(n)) return
      const op = n[0]
      if (op === 'global.get') { reads.add(n[1]); return }
      if (op === 'global.set') sets.add(n[1])
      else if (op === 'call' || op === 'return_call') calls.add(n[1])
      else if (op === 'call_indirect' || op === 'call_ref' || op === 'return_call_indirect' || op === 'return_call_ref') indirect = true
      for (let i = 1; i < n.length; i++) scan(n[i])
    }
    for (let i = 1; i < loop.length; i++) scan(loop[i])
    if (indirect || [...calls].some(c => fx.returns(c) && (fx.writes(c) || fx.header(c)))) return []
    const pre = [], names = new Map()
    for (const g of reads) {
      if (replacements.has(g) || (getCounts.get(g) || 0) < 3 || sets.has(g) || [...calls].some(c => fx.sets(c, g))) continue
      const type = globalTypes?.get(g) || inferTypeFromContext(fn, g, bodyStart)
      if (!type) continue
      const l = `$_pg${localIdx++}`
      decls.push(['local', l, type]); pre.push(['local.set', l, ['global.get', g]]); facts(g, l); names.set(g, l)
    }
    for (let i = 1; i < loop.length; i++) swap(loop[i], names)
    return pre
  }
  const loops = (node, from) => {
    for (let i = from; i < node.length; i++) {
      const c = node[i]
      if (!Array.isArray(c)) continue
      if (c[0] === 'loop' || c[0] === 'block' && Array.isArray(c[c.length - 1]) && c[c.length - 1][0] === 'loop') { const pre = inLoop(c); node.splice(i, 0, ...pre); i += pre.length }
      loops(c, 1)
    }
  }
  loops(fn, at)
  fn.splice(bodyStart, 0, ...decls)
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
