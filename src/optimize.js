/**
 * WASM IR post-emission optimizations.
 *
 * # Stage contract
 *   IN:  WAT-as-array IR (function body or module-level).
 *   OUT: equivalent WAT-as-array IR (same semantics, smaller encoding).
 *   INVARIANTS: pure IR→IR rewrite. No ctx reads/writes. No new top-level declarations except
 *        the ones explicitly surfaced via `addGlobal` (hoistConstantPool only).
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
 *   specializePtrBase — `(call $F (i32.add (global.get $G) (i32.const N)))` → `$F_rel_$G (i32.const N)`
 *   sortStrPoolByFreq — reorder string pool so hottest strings get small offsets (smaller LEB128)
 *   hoistConstantPool — frequently-repeated f64.const values → mutable globals (~7 B/reuse)
 *   treeshake         — drop func decls unreachable from exports / start / elem / ref.func roots
 *
 * Per-function passes run over sec.funcs + sec.stdlib + sec.start.
 * Whole-module passes see the full function list + globals map.
 *
 * @module optimize
 */

import { LAYOUT } from './ctx.js'
import { findBodyStart } from './ir.js'
import { vectorizeLaneLocal } from './vectorize.js'

const MEMOP = /^[fi](32|64)\.(load|store)(\d+(_[su])?)?$/
const NAN_BITS = '0x' + LAYOUT.NAN_PREFIX_BITS.toString(16).toUpperCase().padStart(16, '0')
const NULL_BITS = '0x' + (LAYOUT.NAN_PREFIX_BITS | (1n << BigInt(LAYOUT.AUX_SHIFT))).toString(16).toUpperCase().padStart(16, '0')
const UNDEF_BITS = '0x' + (LAYOUT.NAN_PREFIX_BITS | (2n << BigInt(LAYOUT.AUX_SHIFT))).toString(16).toUpperCase().padStart(16, '0')

/**
 * Optimization passes, partitioned by phase. The `level` presets pick which
 * passes are on by default; the user can override individual passes via an
 * object form (`{ level: 1, hoistAddrBase: true }`).
 *
 * Levels:
 *   0 — nothing. Fastest compile, largest output. Useful for live coding.
 *   1 — encoding-compactness only (treeshake + sortLocalsByUse + fusedRewrite-inline).
 *       Cheap, no IR rewrites that perturb V8's tier-up shape.
 *   2 — default. All stable jz passes + watr in 'light' mode (everything except
 *       `inline` / `inlineOnce`). 'light' delivers most of the size win
 *       (treeshake / dedupe / dedupTypes / coalesce / propagate / packData / fold /
 *       peephole / vacuum / mergeBlocks / brif / loopify / …) at essentially zero
 *       net compile cost — the smaller wasm makes watrCompile downstream faster.
 *   3 — level 2 + full watr (adds inlining) + aggressive experimental tunings.
 *
 * String aliases (the size↔speed tradeoff lives entirely in the unroll/scalar
 * knobs; watr is on for all three):
 *   'size'     — loop/const unroll + lane vectorization off, tight scalar-replacement
 *                caps. Smallest wasm.
 *   'balanced' — the default (= level 2).
 *   'speed'    — full nested unroll + lane vectorization (= level 3).
 */
export const PASS_NAMES = [
  'watr',                     // third-party WAT-level CSE/DCE/inlining (heaviest)
  'hoistPtrType',
  'hoistInvariantPtrOffset',
  'hoistInvariantPtrOffsetLoop',
  'fusedRewrite',             // peephole + ptr-helper inline + memarg fold
  'hoistAddrBase',
  'hoistInvariantCellLoads',
  'cseScalarLoad',
  'csePureExpr',
  'dropDeadZeroInit',
  'deadStoreElim',
  'promoteGlobals',          // read-only global.get → local for multi-read globals
  'sortLocalsByUse',
  'specializeMkptr',
  'specializePtrBase',
  'sortStrPoolByFreq',
  'hoistConstantPool',
  'sourceInline',
  'smallConstForUnroll',
  'nestedSmallConstForUnroll',
  'vectorizeLaneLocal',       // SIMD-128 lift for lane-pure typed-array loops
  'arenaRewind',              // per-call heap rewind for no-arg scalar allocator kernels
  'treeshake',
]

const ALL_ON = Object.freeze(Object.fromEntries(PASS_NAMES.map(n => [n, true])))
const ALL_OFF = Object.freeze(Object.fromEntries(PASS_NAMES.map(n => [n, false])))
const LEVEL_PRESETS = Object.freeze({
  0: ALL_OFF,
  1: Object.freeze({ ...ALL_OFF, treeshake: true, sortLocalsByUse: true, fusedRewrite: true }),
  // Default (level 2 / 'balanced'): every stable pass + watr in 'light' mode.
  // 'light' = all watr passes except inlining (`inline` / `inlineOnce`). Inlining is
  // skipped at L2 because it breaks regex-split semantics (watr 4.6.4) and reshapes
  // codegen tests that assert on pre-inline function structure. The remaining passes
  // (treeshake/dedupe/dedupTypes/coalesce/propagate/packData/fold/peephole/...) still
  // deliver most of watr's size win at essentially zero compile cost.
  2: Object.freeze({ ...ALL_ON, watr: 'light', nestedSmallConstForUnroll: 'auto' }),
  // L3/'speed' trades a bit of heap headroom for fewer __arr_grow / __hash growth
  // cycles. arrayMinCap=16 means `[]` and `new Array()` skip the first two doublings
  // (0→2→4→8→16); hashSmallInitCap=8 keeps per-object __dyn_props at the same load
  // factor as the global __hash_new on first set, avoiding the 2→4→8 grow chain.
  // Net cost: ~128 B per empty array, ~144 B per per-object hash. Net win on the
  // watr.compile profile: __arr_grow ~6.7% → ~3%, and lower __ihash_get_local
  // probe depth from a denser-load global hash.
  3: Object.freeze({ ...ALL_ON, arrayMinCap: 16, hashSmallInitCap: 8 }),
  // 'balanced' = level 2; 'size' tightens scalar/unroll caps; 'speed' = level 3.
  balanced: Object.freeze({ ...ALL_ON, watr: 'light', nestedSmallConstForUnroll: 'auto' }),
  size: Object.freeze({
    ...ALL_ON,
    smallConstForUnroll: false, nestedSmallConstForUnroll: false, vectorizeLaneLocal: false,
    scalarTypedLoopUnroll: 4, scalarTypedNestedUnroll: 8, scalarTypedArrayLen: 8,
  }),
  // 'speed' === level 3: full watr (inlining on) + L3 cap/hash tuning.
  speed: Object.freeze({ ...ALL_ON, arrayMinCap: 16, hashSmallInitCap: 8 }),
})

/**
 * Normalize the user's `opts.optimize` value into a flat config object.
 *
 *   resolveOptimize(undefined | true)         → level 2 stable defaults
 *   resolveOptimize(false | 0)                → all off
 *   resolveOptimize(1 | 2 | 3)                → preset for that level
 *   resolveOptimize('size' | 'speed' | 'balanced') → named alias preset
 *   resolveOptimize({ level: 1, watr: true }) → level 1 base, with watr forced on
 *   resolveOptimize({ level: 'size', vectorizeLaneLocal: true }) → 'size' base, override
 *   resolveOptimize({ hoistAddrBase: false }) → level 2 base, hoistAddrBase off
 */
export function resolveOptimize(opt) {
  if (opt === false || opt === 0) return { ...ALL_OFF }
  if (opt === true || opt == null) return { ...LEVEL_PRESETS[2] }
  if (typeof opt === 'number' || typeof opt === 'string') return { ...(LEVEL_PRESETS[opt] || LEVEL_PRESETS[2]) }
  if (typeof opt === 'object') {
    const baseLevel = typeof opt.level === 'number' || typeof opt.level === 'string' ? opt.level : 2
    const base = LEVEL_PRESETS[baseLevel] || ALL_ON
    const out = { ...base }
    for (const n of PASS_NAMES) {
      if (!(n in opt)) continue
      const v = opt[n]
      // Preserve sentinel values that downstream resolution depends on:
      //   nestedSmallConstForUnroll: 'auto' (heuristic at emit time)
      //   watr: 'light' (curated subset — see index.js watrOpts)
      if (n === 'nestedSmallConstForUnroll' && v === 'auto') out[n] = 'auto'
      else if (n === 'watr' && v === 'light') out[n] = 'light'
      else out[n] = !!v
    }
    // Preserve non-pass tuning keys (e.g. plan.js thresholds)
    for (const k of Object.keys(opt)) if (!PASS_NAMES.includes(k)) out[k] = opt[k]
    return out
  }
  return { ...ALL_ON }
}

/**
 * CSE repeated `(call $__ptr_type X)` on same X across stable regions.
 *
 * A stable region for var X is a maximal CFG segment where X is not written.
 * Within each region, the first `__ptr_type X` becomes `(local.tee $__ptN ...)`,
 * subsequent ones become `(local.get $__ptN)`. One hoist local per X is shared
 * across regions (each region's tee re-initializes it).
 *
 * Region boundaries:
 *   - `local.set` / `local.tee` of X → close region, alive[X] = false
 *   - `if` arms processed independently from the if-entry alive state; on merge,
 *     a var is alive after the `if` only if alive in BOTH arms with the same region
 *     (so the same tee was reachable on every path).
 *   - `loop` body walks with empty alive (next iteration may re-enter after a write)
 *   - `block` is sequential (br jumps out, never in)
 *
 * Threshold: a region is committed only when it has ≥2 sites. Singleton regions
 * (one tee with no follow-up gets) are pure cost and skipped.
 *
 * Safety: __ptr_type extracts type tag bits, which never change for a given
 * NaN-boxed f64. Caching is safe inside any region where X isn't rewritten.
 * (Contrast __ptr_offset, which has a forwarding loop for ARRAY — caching its
 * result is unsafe across realloc, so it isn't hoisted here.)
 */
export function hoistPtrType(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Per X: array of regions; each region is array of {parent, idx, role: 'tee'|'get'}.
  const regions = new Map()
  // Currently-open region per X (X → region array). Presence ⇔ alive.
  const open = new Map()

  const ensureRegions = (x) => {
    let arr = regions.get(x)
    if (!arr) { arr = []; regions.set(x, arr) }
    return arr
  }

  const walk = (node, parent, pi) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    if (op === 'call' && node[1] === '$__ptr_type' && node.length === 3) {
      const arg = node[2]
      // Post-i64 migration: arg is (i64.reinterpret_f64 (local.get X)). Peel both wrappers.
      const inner = (Array.isArray(arg) && arg[0] === 'i64.reinterpret_f64' && arg.length === 2) ? arg[1] : arg
      if (Array.isArray(inner) && inner[0] === 'local.get' && typeof inner[1] === 'string') {
        const x = inner[1]
        let region = open.get(x)
        if (!region) {
          region = []
          ensureRegions(x).push(region)
          open.set(x, region)
          region.push({ parent, idx: pi, role: 'tee' })
        } else {
          region.push({ parent, idx: pi, role: 'get' })
        }
        return  // don't recurse — local.get inside is a read, not interesting
      }
      // Non-trivial arg: walk children normally
      for (let i = 2; i < node.length; i++) walk(node[i], node, i)
      return
    }

    if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string') {
      const x = node[1]
      // Walk value first — it may contain __ptr_type X, which sees pre-write X.
      for (let i = 2; i < node.length; i++) walk(node[i], node, i)
      // Then close any open region for X.
      open.delete(x)
      return
    }

    if (op === 'if') {
      // Skip optional `(result T)` siblings to find cond / then / else.
      let i = 1
      while (i < node.length && Array.isArray(node[i]) && node[i][0] === 'result') i++
      if (i < node.length) walk(node[i], node, i)  // cond
      i++
      let thenArm = null, elseArm = null
      for (; i < node.length; i++) {
        const c = node[i]
        if (Array.isArray(c)) {
          if (c[0] === 'then') thenArm = c
          else if (c[0] === 'else') elseArm = c
        }
      }
      const beforeArms = new Map(open)
      let afterThen = beforeArms
      if (thenArm) {
        for (let j = 1; j < thenArm.length; j++) walk(thenArm[j], thenArm, j)
        afterThen = new Map(open)
      }
      open.clear()
      for (const [k, v] of beforeArms) open.set(k, v)
      let afterElse = beforeArms
      if (elseArm) {
        for (let j = 1; j < elseArm.length; j++) walk(elseArm[j], elseArm, j)
        afterElse = new Map(open)
      }
      // Merge: alive after if iff alive on BOTH paths with same region ref
      // (so the same tee was reachable regardless of which arm executed).
      open.clear()
      for (const [k, vT] of afterThen) {
        if (afterElse.get(k) === vT) open.set(k, vT)
      }
      return
    }

    if (op === 'loop') {
      // Conservative: any tee installed in iter N may not have run in iter N+1
      // before reaching the same site (back-edge to loop header). Clear before+after.
      open.clear()
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      open.clear()
      return
    }

    // block / func-body / generic: walk children sequentially.
    for (let i = 0; i < node.length; i++) walk(node[i], node, i)
  }

  for (let i = bodyStart; i < fn.length; i++) walk(fn[i], fn, i)

  if (regions.size === 0) return

  // Commit: for each X with ≥1 usable region, allocate one shared local and rewrite.
  // Per-region threshold ≥2 (a singleton would be pure cost).
  let hoistId = 0
  const locals = []
  for (const [, regs] of regions) {
    let usable = false
    for (const r of regs) if (r.length >= 2) { usable = true; break }
    if (!usable) continue
    const tLocal = `$__pt${hoistId++}`
    locals.push(['local', tLocal, 'i32'])
    for (const r of regs) {
      if (r.length < 2) continue
      for (let i = 0; i < r.length; i++) {
        const { parent, idx, role } = r[i]
        if (role === 'tee') parent[idx] = ['local.tee', tLocal, parent[idx]]
        else parent[idx] = ['local.get', tLocal]
      }
    }
  }
  if (locals.length) fn.splice(bodyStart, 0, ...locals)
}

/**
 * CSE repeated `(i32.add (local.get $A) (i32.shl (local.get $B) (i32.const K)))`
 * — the shape jz emits for `arr[idx + k]` typed-array reads after foldMemargOffsets
 * absorbs the constant K into `offset=`. The remaining base expression is
 * recomputed once per `arr[…]` read; biquad's inner cascade has 9 such reads
 * sharing 2 base shapes per iteration. V8's CSE usually catches this, but emitting
 * the share explicitly avoids relying on tier-up and helps wasm2c / wasm-opt too.
 *
 * Same region-tracking discipline as hoistPtrType: open region per key, closed
 * by re-assignment to either A or B; loop entry/exit clears all open regions.
 *
 * Must run AFTER fusedRewrite — relies on shl-distribution + assoc-lift +
 * foldMemargOffsets having normalized the base shape.
 */
export function hoistAddrBase(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Per key (`$A|$B|K`): array of regions; region: array of {parent, idx, role}.
  const regions = new Map()
  // Open regions keyed by string key; also indexed by local name → set of keys
  // depending on it (so `local.set X` can close any region whose key references X).
  const open = new Map()
  const localToKeys = new Map()

  const ensureRegions = (k) => {
    let arr = regions.get(k)
    if (!arr) { arr = []; regions.set(k, arr) }
    return arr
  }
  const addLocalDep = (name, key) => {
    let s = localToKeys.get(name)
    if (!s) { s = new Set(); localToKeys.set(name, s) }
    s.add(key)
  }
  const closeKey = (key) => {
    const r = open.get(key)
    if (!r) return
    open.delete(key)
    // Don't bother removing from localToKeys; stale entries are filtered on close.
  }
  const closeForLocal = (name) => {
    const s = localToKeys.get(name)
    if (!s) return
    for (const k of s) if (open.has(k)) closeKey(k)
    localToKeys.delete(name)
  }

  // Returns { A, B, K } if node matches the pattern, else null.
  const matchPattern = (node) => {
    if (!Array.isArray(node) || node[0] !== 'i32.add' || node.length !== 3) return null
    const a = node[1], b = node[2]
    // Two orderings: (add (get A) (shl (get B) (const K))) or (add (shl …) (get A))
    let baseGet, shlNode
    if (Array.isArray(a) && a[0] === 'local.get' && typeof a[1] === 'string' &&
        Array.isArray(b) && b[0] === 'i32.shl' && b.length === 3) {
      baseGet = a; shlNode = b
    } else if (Array.isArray(b) && b[0] === 'local.get' && typeof b[1] === 'string' &&
               Array.isArray(a) && a[0] === 'i32.shl' && a.length === 3) {
      baseGet = b; shlNode = a
    } else return null
    const idx = shlNode[1], shamt = shlNode[2]
    if (!Array.isArray(idx) || idx[0] !== 'local.get' || typeof idx[1] !== 'string') return null
    if (!Array.isArray(shamt) || shamt[0] !== 'i32.const' || typeof shamt[1] !== 'number') return null
    return { A: baseGet[1], B: idx[1], K: shamt[1] }
  }

  const walk = (node, parent, pi) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    const m = matchPattern(node)
    if (m) {
      const key = `${m.A}|${m.B}|${m.K}`
      let region = open.get(key)
      if (!region) {
        region = []
        ensureRegions(key).push(region)
        open.set(key, region)
        addLocalDep(m.A, key)
        addLocalDep(m.B, key)
        region.push({ parent, idx: pi, role: 'tee' })
      } else {
        region.push({ parent, idx: pi, role: 'get' })
      }
      return  // children are local.gets — they're reads, not interesting
    }

    if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string') {
      const x = node[1]
      // Walk value first — it may match patterns referencing pre-write X.
      for (let i = 2; i < node.length; i++) walk(node[i], node, i)
      closeForLocal(x)
      return
    }

    if (op === 'if') {
      let i = 1
      while (i < node.length && Array.isArray(node[i]) && node[i][0] === 'result') i++
      if (i < node.length) walk(node[i], node, i)
      i++
      let thenArm = null, elseArm = null
      for (; i < node.length; i++) {
        const c = node[i]
        if (Array.isArray(c)) {
          if (c[0] === 'then') thenArm = c
          else if (c[0] === 'else') elseArm = c
        }
      }
      const beforeArms = new Map(open)
      let afterThen = beforeArms
      if (thenArm) {
        for (let j = 1; j < thenArm.length; j++) walk(thenArm[j], thenArm, j)
        afterThen = new Map(open)
      }
      open.clear()
      for (const [k, v] of beforeArms) open.set(k, v)
      let afterElse = beforeArms
      if (elseArm) {
        for (let j = 1; j < elseArm.length; j++) walk(elseArm[j], elseArm, j)
        afterElse = new Map(open)
      }
      open.clear()
      for (const [k, vT] of afterThen) {
        if (afterElse.get(k) === vT) open.set(k, vT)
      }
      return
    }

    if (op === 'loop') {
      open.clear()
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      open.clear()
      return
    }

    for (let i = 0; i < node.length; i++) walk(node[i], node, i)
  }

  for (let i = bodyStart; i < fn.length; i++) walk(fn[i], fn, i)

  if (regions.size === 0) return

  let hoistId = 0
  const locals = []
  // Find next free $__abN id by scanning existing locals.
  while (fn.some(n => Array.isArray(n) && n[0] === 'local' && n[1] === `$__ab${hoistId}`)) hoistId++
  for (const [, regs] of regions) {
    let usable = false
    for (const r of regs) if (r.length >= 2) { usable = true; break }
    if (!usable) continue
    const tLocal = `$__ab${hoistId++}`
    locals.push(['local', tLocal, 'i32'])
    for (const r of regs) {
      if (r.length < 2) continue
      for (let i = 0; i < r.length; i++) {
        const { parent, idx, role } = r[i]
        if (role === 'tee') parent[idx] = ['local.tee', tLocal, parent[idx]]
        else parent[idx] = ['local.get', tLocal]
      }
    }
  }
  if (locals.length) fn.splice(bodyStart, 0, ...locals)
}

/**
 * Hoist `(call $__ptr_offset (local.get $X))` to a function-entry snapshot
 * when X is an f64-NaN-boxed parameter that's never reassigned and only ever
 * passed to known-pure helpers. Aos-style hot loops read `rows[i]` once per
 * iteration; without this, V8 keeps re-extracting the offset each time.
 *
 * Safety: __ptr_offset on an Array follows the realloc-forwarding chain. Once
 * a function commits to "this param won't realloc inside me", caching is
 * sound for the duration. The whitelist below is the read-only set
 * (no mutation possible); any other callee touching X invalidates hoisting.
 */
const SAFE_OFFSET_CALLS = new Set(['$__ptr_offset', '$__ptr_type', '$__ptr_aux', '$__len'])

export function hoistInvariantPtrOffset(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  const params = new Set()
  for (let i = 2; i < fn.length; i++) {
    const c = fn[i]
    if (!Array.isArray(c)) continue
    if (c[0] !== 'param') continue
    if (typeof c[1] === 'string' && c[2] === 'f64') params.add(c[1])
  }
  if (!params.size) return

  const sites = new Map()
  const unsafe = new Set()

  const walk = (node, parent, pi) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    if (op === 'local.set' || op === 'local.tee') {
      if (typeof node[1] === 'string' && params.has(node[1])) unsafe.add(node[1])
      for (let i = 2; i < node.length; i++) walk(node[i], node, i)
      return
    }

    if (op === 'call') {
      const callee = node[1]
      if (callee === '$__ptr_offset' && node.length === 3) {
        const a = node[2]
        // Post-i64 migration: arg may be (i64.reinterpret_f64 (local.get X)).
        const inner = (Array.isArray(a) && a[0] === 'i64.reinterpret_f64' && a.length === 2) ? a[1] : a
        if (Array.isArray(inner) && inner[0] === 'local.get' && typeof inner[1] === 'string' && params.has(inner[1])) {
          let arr = sites.get(inner[1])
          if (!arr) { arr = []; sites.set(inner[1], arr) }
          arr.push({ parent, idx: pi })
          return
        }
      }
      const isSafe = SAFE_OFFSET_CALLS.has(callee)
      for (let i = 2; i < node.length; i++) {
        const arg = node[i]
        const inner = (Array.isArray(arg) && arg[0] === 'i64.reinterpret_f64' && arg.length === 2) ? arg[1] : arg
        if (Array.isArray(inner) && inner[0] === 'local.get' && typeof inner[1] === 'string' && params.has(inner[1])) {
          if (!isSafe) unsafe.add(inner[1])
          continue
        }
        walk(arg, node, i)
      }
      return
    }

    if (op === 'call_indirect' || op === 'call_ref') {
      for (let i = 1; i < node.length; i++) {
        const arg = node[i]
        if (Array.isArray(arg) && arg[0] === 'local.get' && typeof arg[1] === 'string' && params.has(arg[1])) {
          unsafe.add(arg[1])
          continue
        }
        walk(arg, node, i)
      }
      return
    }

    for (let i = 0; i < node.length; i++) walk(node[i], node, i)
  }

  for (let i = bodyStart; i < fn.length; i++) walk(fn[i], fn, i)

  if (sites.size === 0) return

  let hoistId = 0
  while (fn.some(n => Array.isArray(n) && n[0] === 'local' && n[1] === `$__po${hoistId}`)) hoistId++

  const newLocals = []
  const snaps = []
  for (const [X, arr] of sites) {
    if (unsafe.has(X)) continue
    if (arr.length < 2) continue
    const tLocal = `$__po${hoistId++}`
    newLocals.push(['local', tLocal, 'i32'])
    snaps.push(['local.set', tLocal, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', X]]]])
    for (const { parent, idx } of arr) {
      parent[idx] = ['local.get', tLocal]
    }
  }

  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals, ...snaps)
}

/**
 * Per-loop hoist of `(call $__ptr_offset (local.get X))` for locals X that are
 * loop-invariant (no `local.set/local.tee` to X anywhere in the loop body, no
 * non-safe call inside the loop). Mirrors `hoistInvariantCellLoads`.
 *
 * The function-level pass above only handles params (single hoist at func
 * entry). This pass handles assigned locals that go invariant within a loop
 * scope — the aos pattern: `let rows = []; for (...) rows.push(...)` — outside
 * the build loop, `rows` is no longer reassigned, so `__ptr_offset(rows)` is
 * loop-invariant in the consumer loop.
 *
 * Inside-out: inner loops first. After an inner-loop hoist, the outer loop now
 * contains a `(local.set $__pol (call $__ptr_offset ...))` whose call gets
 * hoisted again at the outer level, climbing the snap up to the outermost loop
 * where X is invariant. Cleanup of the chained `local.set` movs is handled by
 * watr CSE/DCE.
 */
export function hoistInvariantPtrOffsetLoop(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  let snapId = 0
  while (fn.some(n => Array.isArray(n) && n[0] === 'local' && n[1] === `$__pol${snapId}`)) snapId++
  const newLocals = []

  // Refcount across the whole fn to skip shared subtrees (watr CSE may leave them).
  const refcount = new Map()
  const countRefs = (node) => {
    if (!Array.isArray(node)) return
    const n = (refcount.get(node) || 0) + 1
    refcount.set(node, n)
    if (n > 1) return
    for (let i = 0; i < node.length; i++) countRefs(node[i])
  }
  countRefs(fn)

  const processLoop = (loopNode) => {
    // Recurse into inner loops first (bottom-up).
    for (let i = 1; i < loopNode.length; i++) {
      const child = loopNode[i]
      if (!Array.isArray(child)) continue
      processNode(child, loopNode, i)
    }

    // Scan loop body (including nested loops) for writes to any local and for
    // any non-safe call. Non-safe calls could realloc/move the underlying
    // array storage and invalidate cached offsets.
    const writes = new Set()
    let unsafe = false
    const scan = (node) => {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === 'local.set' || op === 'local.tee') {
        if (typeof node[1] === 'string') writes.add(node[1])
        for (let i = 2; i < node.length; i++) scan(node[i])
        return
      }
      if (op === 'call') {
        if (!SAFE_OFFSET_CALLS.has(node[1])) unsafe = true
        for (let i = 2; i < node.length; i++) scan(node[i])
        return
      }
      if (op === 'call_ref' || op === 'call_indirect') {
        unsafe = true
        for (let i = 1; i < node.length; i++) scan(node[i])
        return
      }
      for (let i = 1; i < node.length; i++) scan(node[i])
    }
    for (let i = 1; i < loopNode.length; i++) scan(loopNode[i])
    if (unsafe) return []

    // Collect call sites for invariant locals. Skip nested loops (already
    // processed) but recurse through everything else.
    const sites = new Map()  // localName → [{ parent, idx }]
    const collect = (node, parent, idx) => {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === 'loop') return
      if (op === 'call' && node[1] === '$__ptr_offset' && node.length === 3) {
        const a = node[2]
        const inner = (Array.isArray(a) && a[0] === 'i64.reinterpret_f64' && a.length === 2) ? a[1] : a
        if (Array.isArray(inner) && inner[0] === 'local.get' && typeof inner[1] === 'string'
            && !writes.has(inner[1])
            && (refcount.get(node) || 0) <= 1
            && (refcount.get(parent) || 0) <= 1) {
          let arr = sites.get(inner[1])
          if (!arr) { arr = []; sites.set(inner[1], arr) }
          arr.push({ parent, idx })
        }
        return
      }
      for (let i = 0; i < node.length; i++) collect(node[i], node, i)
    }
    for (let i = 1; i < loopNode.length; i++) collect(loopNode[i], loopNode, i)

    const snaps = []
    for (const [X, arr] of sites) {
      if (arr.length < 1) continue
      const snapName = `$__pol${snapId++}`
      newLocals.push(['local', snapName, 'i32'])
      snaps.push(['local.set', snapName, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', X]]]])
      for (const { parent, idx } of arr) {
        parent[idx] = ['local.get', snapName]
      }
    }
    return snaps
  }

  const processNode = (node, parent, idx) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'loop') {
      const snaps = processLoop(node)
      if (snaps.length) parent.splice(idx, 0, ...snaps)
      return
    }
    for (let i = 0; i < node.length; i++) processNode(node[i], node, i)
  }

  for (let i = bodyStart; i < fn.length; i++) processNode(fn[i], fn, i)

  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)
}

/**
 * Hoist loop-invariant boxed-cell reads out of loops.
 *
 * Boxed-capture cells (`$cell_X`, allocated by the closure-capture pass) are
 * private to the enclosing function — no other code path can write to that
 * memory. So if a loop body contains `(f64.load (local.get $cell_X))` reads
 * and *no* `(f64.store (local.get $cell_X) …)` writes, the load is loop-
 * invariant and can be hoisted to a snapshot local set just before the loop.
 *
 * Necessary because V8's wasm tier doesn't perform LICM across f64.load:
 * memory may alias with f64.stores in the loop body, and even though we
 * know the cell can't alias with array stores, the engine has to assume it
 * can. Hand-hoisting unblocks register-keeping of the captured value.
 *
 * Inside-out per-loop processing — inner loops handled first, so reads
 * already replaced by snap-locals don't appear as cell reads at outer levels.
 */
export function hoistInvariantCellLoads(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  let snapId = 0
  while (fn.some(n => Array.isArray(n) && n[0] === 'local' && n[1] === `$__sc${snapId}`)) snapId++
  const newLocals = []

  // Build refcount of array nodes: how many positions in `fn` reference each
  // array. Earlier passes (fusedRewrite, hoistAddrBase) introduce shared
  // subtrees; mutating `parent[idx]` for a shared parent would also affect
  // references outside the current loop. Sites whose immediate parent has
  // refcount > 1 are skipped.
  const refcount = new Map()
  const countRefs = (node) => {
    if (!Array.isArray(node)) return
    const n = (refcount.get(node) || 0) + 1
    refcount.set(node, n)
    if (n > 1) return  // already counted children below
    for (let i = 0; i < node.length; i++) countRefs(node[i])
  }
  countRefs(fn)

  // Process one loop node: find cell_X reads, check no writes, hoist.
  // Returns { snapDecls } — list of (local.set $snap (f64.load (local.get $cell_X))) IR
  // to emit before the loop in its parent.
  const processLoop = (loopNode) => {
    // Recurse first — inner loops handled bottom-up. Each inner-loop processor
    // returns a list of pre-loop snap decls; we splice them just before the inner
    // loop within this loop's body.
    for (let i = 1; i < loopNode.length; i++) {
      const child = loopNode[i]
      if (!Array.isArray(child)) continue
      processNode(child, loopNode, i)
    }

    // Scan this loop's body for cell reads & writes (excluding nested loop bodies,
    // since their reads were already hoisted at their level).
    const reads = new Map()  // cellName → array of {parent, idx}
    const writes = new Set()
    let hasCall = false
    const scanWrites = (node) => {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === 'call' || op === 'call_ref' || op === 'call_indirect') {
        hasCall = true
      }
      // DESCEND into nested loops here — we need to know if any nested-loop
      // body writes to cell_X (which would invalidate hoisting THIS loop's reads).
      if (op === 'f64.store' && node.length >= 3) {
        const addr = node[1]
        if (Array.isArray(addr) && addr[0] === 'local.get' && typeof addr[1] === 'string'
            && addr[1].startsWith('$cell_')) {
          writes.add(addr[1])
        }
        // Continue scan into value expr
        for (let i = 2; i < node.length; i++) scanWrites(node[i])
        return
      }
      if (op === 'f64.load' && node.length === 2) {
        const addr = node[1]
        if (Array.isArray(addr) && addr[0] === 'local.get' && typeof addr[1] === 'string'
            && addr[1].startsWith('$cell_')) {
          // Defer; we'll handle in a parent-tracking second pass.
        }
      }
      for (let i = 1; i < node.length; i++) scanWrites(node[i])
    }
    for (let i = 1; i < loopNode.length; i++) scanWrites(loopNode[i])
    // Sound bailout: a call inside the loop could mutate a captured cell
    // via a closure we can't see. Without escape analysis we can't prove
    // non-aliasing, so we skip hoisting from any loop containing calls.
    if (hasCall) return []

    // Parent-tracking pass to collect read sites.
    const collect = (node, parent, idx) => {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === 'loop') return
      if (op === 'f64.load' && node.length === 2) {
        const addr = node[1]
        if (Array.isArray(addr) && addr[0] === 'local.get' && typeof addr[1] === 'string'
            && addr[1].startsWith('$cell_')) {
          const cell = addr[1]
          // Skip if the f64.load node or its immediate parent is shared
          // (refcount>1): mutating parent[idx] would propagate the rewrite to
          // references outside this loop.
          if (!writes.has(cell)
              && (refcount.get(node) || 0) <= 1
              && (refcount.get(parent) || 0) <= 1) {
            let arr = reads.get(cell)
            if (!arr) { arr = []; reads.set(cell, arr) }
            arr.push({ parent, idx })
          }
          return
        }
      }
      for (let i = 0; i < node.length; i++) collect(node[i], node, i)
    }
    for (let i = 1; i < loopNode.length; i++) collect(loopNode[i], loopNode, i)

    // For each cell with reads but no writes (and confirmed no calls above),
    // hoist a snap. Single-read hoist is fine semantically: the cell address
    // doesn't change once allocated, and snap is loaded unconditionally before
    // the loop, then the body uses the snap local.
    const snaps = []
    for (const [cell, sites] of reads) {
      if (sites.length < 1) continue
      const snapName = `$__sc${snapId++}`
      newLocals.push(['local', snapName, 'f64'])
      snaps.push(['local.set', snapName, ['f64.load', ['local.get', cell]]])
      for (const { parent, idx } of sites) {
        parent[idx] = ['local.get', snapName]
      }
    }
    return snaps
  }

  // Recursive node walker that splices snap decls before nested loops.
  const processNode = (node, parent, idx) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'loop') {
      const snaps = processLoop(node)
      if (snaps.length) {
        // Splice snaps just before this loop in its parent. The parent could be
        // a `block` or a top-level func body or any other container.
        parent.splice(idx, 0, ...snaps)
      }
      return
    }
    for (let i = 0; i < node.length; i++) processNode(node[i], node, i)
  }

  for (let i = bodyStart; i < fn.length; i++) {
    processNode(fn[i], fn, i)
  }

  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)
}

/**
 * CSE for `(f64.load offset=K (local.get $X))` over straight-line regions
 * where $X is an i32-typed local (an unboxed pointer in jz's value model).
 *
 * Aos hot path: `let p = rows[i]; xs[i] = p.x + p.y*0.25 + r;
 *                ys[i] = p.y - p.z*0.5;
 *                zs[i] = p.z + p.x*0.125`
 * — emits 6 f64.load on $p (each of x/y/z twice); collapses to 3 unique loads
 * shared via tee'd snap locals.
 *
 * Safety: jz's invariant — distinct unboxed-pointer locals come from distinct
 * fresh allocations (analyzePtrUnboxable refuses to unbox aliased locals).
 * So `(f64.store ADDR ...)` with base `(local.get $Y)` for $Y ≠ $X cannot
 * touch addresses reachable via `$X + K`. Stores to typed-array slots in the
 * loop body don't invalidate row-pointer reads.
 *
 * Region boundaries that flush the table:
 *   - branch (br/br_if/br_table/return/unreachable)
 *   - non-pure call
 *   - loop / if  (control flow)
 *   - local.set/local.tee on a tracked $X (invalidates that X's entries)
 *   - store whose address tree references a tracked $X
 * Blocks are treated as transparent — recurse into children.
 */
export function cseScalarLoad(fn) {
  // DISABLED: the safety claim above relies on `analyzePtrUnboxable` having vetted
  // every i32 local as a non-aliased fresh-allocation pointer. But this pass scans
  // *all* i32 locals from `(local … i32)` decls — wasm-native i32 scalars (lengths,
  // indices), narrow-ABI helper returns, and analyze.js's new arrayElemSchema-driven
  // unboxes share the same declaration form. The metacircular path (jz-compiled
  // watr.wasm) trips this: CSE'd loads survive across stores that legitimately
  // mutate the same memory through a different i32 local, returning stale bytes
  // (manifests as "memory access out of bounds" once a corrupted offset is
  // dereferenced). Re-enable once candidacy is restricted to vetted pointers
  // (e.g. emit-side annotation or rep-derived whitelist).
  return
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  const i32Locals = new Set()
  for (let i = 2; i < fn.length; i++) {
    const c = fn[i]
    if (Array.isArray(c) && (c[0] === 'local' || c[0] === 'param') && typeof c[1] === 'string' && c[2] === 'i32') {
      i32Locals.add(c[1])
    }
  }
  if (!i32Locals.size) return

  let snapId = 0
  while (fn.some(n => Array.isArray(n) && n[0] === 'local' && n[1] === `$__cs${snapId}`)) snapId++
  const newLocals = []

  // CSE table: key `${X}|${K}` → { snapName | null, anchorParent, anchorIdx }
  const table = new Map()

  const invalidateLocal = (X) => {
    for (const key of table.keys()) {
      if (key.startsWith(`${X}|`)) table.delete(key)
    }
  }

  // Scan a node's subtree and return the set of i32 locals referenced via local.get.
  const collectGets = (node, out) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'local.get' && typeof node[1] === 'string' && i32Locals.has(node[1])) {
      out.add(node[1])
      return
    }
    for (let i = 1; i < node.length; i++) collectGets(node[i], out)
  }

  // Parse f64.load shape; returns { K, addrIdx } or null.
  const parseLoad = (node) => {
    if (!Array.isArray(node) || node[0] !== 'f64.load') return null
    let K = 0, addrIdx = 1
    if (typeof node[1] === 'string' && node[1].startsWith('offset=')) {
      K = parseInt(node[1].slice(7), 10) | 0
      addrIdx = 2
    }
    if (node.length <= addrIdx) return null
    return { K, addrIdx }
  }

  const walk = (node, parent, idx) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    // Control-flow boundaries: clear table.
    if (op === 'br' || op === 'br_if' || op === 'br_table' || op === 'return' || op === 'unreachable') {
      // Process args first (a br_if value, br arg, etc. could still benefit from current table)
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      table.clear()
      return
    }

    if (op === 'loop' || op === 'if') {
      // Save table state isn't useful; recurse with cleared table, then clear after.
      const saved = new Map(table)
      table.clear()
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      // After leaving compound, conservatively assume invalidation.
      table.clear()
      // Restore? No — restoring would be unsafe since the compound may have written.
      saved.clear()
      return
    }

    if (op === 'call') {
      const callee = node[1]
      // Process args first.
      for (let i = 2; i < node.length; i++) walk(node[i], node, i)
      if (!SAFE_OFFSET_CALLS.has(callee)) table.clear()
      return
    }

    if (op === 'call_ref' || op === 'call_indirect') {
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      table.clear()
      return
    }

    if (op === 'local.set' || op === 'local.tee') {
      // Process value first.
      for (let i = 2; i < node.length; i++) walk(node[i], node, i)
      const X = node[1]
      if (typeof X === 'string') invalidateLocal(X)
      return
    }

    // Stores: process operands first; if address tree references any tracked X,
    // invalidate that X's entries.
    if (op === 'f64.store' || op === 'i32.store' || op === 'i64.store'
        || op === 'i32.store8' || op === 'i32.store16'
        || op === 'i64.store8' || op === 'i64.store16' || op === 'i64.store32'
        || op === 'f32.store') {
      // Address may be node[1] (raw) or node[2] (when node[1] is offset=/align= attr).
      let addrIdx = 1
      if (typeof node[1] === 'string' && (node[1].startsWith('offset=') || node[1].startsWith('align='))) {
        addrIdx = 2
      }
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      const dirty = new Set()
      collectGets(node[addrIdx], dirty)
      for (const X of dirty) invalidateLocal(X)
      return
    }

    // f64.load: try CSE.
    const lp = parseLoad(node)
    if (lp) {
      const addr = node[lp.addrIdx]
      if (Array.isArray(addr) && addr[0] === 'local.get' && typeof addr[1] === 'string' && i32Locals.has(addr[1])) {
        const X = addr[1]
        const key = `${X}|${lp.K}`
        const entry = table.get(key)
        if (entry) {
          if (!entry.snapName) {
            const snapName = `$__cs${snapId++}`
            entry.snapName = snapName
            newLocals.push(['local', snapName, 'f64'])
            // Wrap anchor with (local.tee $snap originalLoad).
            const orig = entry.anchorParent[entry.anchorIdx]
            entry.anchorParent[entry.anchorIdx] = ['local.tee', snapName, orig]
          }
          parent[idx] = ['local.get', entry.snapName]
          return
        } else {
          table.set(key, { snapName: null, anchorParent: parent, anchorIdx: idx })
          // Don't recurse; (local.get $X) has no children of interest.
          return
        }
      }
      // Non-CSE'able address; recurse to find inner loads.
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      return
    }

    // Default: recurse.
    for (let i = 0; i < node.length; i++) walk(node[i], node, i)
  }

  for (let i = bodyStart; i < fn.length; i++) walk(fn[i], fn, i)

  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)
}

/**
 * CSE for pure f64 binary ops on local-only operands.
 *
 * Mandelbrot loop: condition computes `(f64.mul $zx $zx)` and `(f64.mul $zy $zy)`;
 * body recomputes both inside `tx = zx*zx - zy*zy + cx`. Pure ops on locals can't
 * alias memory — only `local.set/tee X` invalidates entries referencing X. Unlike
 * `cseScalarLoad`, br_if doesn't need to clear (no memory aliasing concern).
 *
 * Targets nodes of shape `(OP A B)` where OP ∈ {f64.mul, f64.add, f64.sub} and
 * A,B ∈ `(local.get X)` | `(f64.const N)`. Commutative ops (mul, add) sort
 * operand keys for canonical form.
 *
 * Region boundaries:
 *   - `local.set/tee X` → invalidates entries referencing X
 *   - `loop`, `if` → recurse with cleared table; clear after (compound may have written)
 *   - `call`, `call_ref`, `call_indirect` → no clear (calls don't write locals directly;
 *     the surrounding `local.set/tee` handles that)
 *   - `br/br_if/br_table/return/unreachable` → NO clear (pure values still valid)
 */
export function csePureExpr(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  let snapId = 0
  while (fn.some(n => Array.isArray(n) && n[0] === 'local' && n[1] === `$__pe${snapId}`)) snapId++
  const newLocals = []

  const COMMUTATIVE = new Set(['f64.mul', 'f64.add', 'i32.mul', 'i32.add', 'i32.and', 'i32.or', 'i32.xor', 'i64.mul', 'i64.add', 'i64.and', 'i64.or', 'i64.xor'])
  const TARGET_OPS = new Set([
    'f64.mul', 'f64.add', 'f64.sub',
    'i32.mul', 'i32.add', 'i32.sub', 'i32.shl', 'i32.shr_u', 'i32.shr_s', 'i32.and', 'i32.or', 'i32.xor',
    'i64.mul', 'i64.add', 'i64.sub', 'i64.shl', 'i64.shr_u', 'i64.shr_s', 'i64.and', 'i64.or', 'i64.xor',
  ])
  const OP_TYPE = {
    'f64.mul': 'f64', 'f64.add': 'f64', 'f64.sub': 'f64',
    'i32.mul': 'i32', 'i32.add': 'i32', 'i32.sub': 'i32', 'i32.shl': 'i32', 'i32.shr_u': 'i32', 'i32.shr_s': 'i32', 'i32.and': 'i32', 'i32.or': 'i32', 'i32.xor': 'i32',
    'i64.mul': 'i64', 'i64.add': 'i64', 'i64.sub': 'i64', 'i64.shl': 'i64', 'i64.shr_u': 'i64', 'i64.shr_s': 'i64', 'i64.and': 'i64', 'i64.or': 'i64', 'i64.xor': 'i64',
  }

  // Encode a leaf operand to a stable string key. Returns null if not pure-leaf.
  const leafKey = (n) => {
    if (!Array.isArray(n)) return null
    if (n[0] === 'local.get' && typeof n[1] === 'string') return `L:${n[1]}`
    if (n[0] === 'f64.const' || n[0] === 'i32.const' || n[0] === 'i64.const' || n[0] === 'f32.const') return `C:${n[0]}:${n[1]}`
    return null
  }

  // table: key → { snapName | null, anchorParent, anchorIdx, locals: Set<string> }
  const table = new Map()

  const invalidateLocal = (X) => {
    for (const [key, entry] of table) {
      if (entry.locals.has(X)) table.delete(key)
    }
  }

  const walk = (node, parent, idx) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    if (op === 'loop' || op === 'if') {
      const saved = new Map(table)
      table.clear()
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      table.clear()
      saved.clear()
      return
    }

    // `then`/`else` branches of an `if` are mutually exclusive at runtime —
    // a snap tee cached in the `then` branch is unset when the `else` runs.
    // Isolate per-branch tables so a sibling branch can't reach into another's
    // CSE entries.
    if (op === 'then' || op === 'else') {
      table.clear()
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      table.clear()
      return
    }

    if (op === 'call' || op === 'call_ref' || op === 'call_indirect') {
      // Calls don't write locals; recurse, no clear.
      for (let i = 1; i < node.length; i++) walk(node[i], node, i)
      return
    }

    if (op === 'local.set' || op === 'local.tee') {
      for (let i = 2; i < node.length; i++) walk(node[i], node, i)
      const X = node[1]
      if (typeof X === 'string') invalidateLocal(X)
      return
    }

    // Try CSE on (OP A B) where A,B are pure leaves.
    if (TARGET_OPS.has(op) && node.length === 3) {
      const ka = leafKey(node[1])
      const kb = leafKey(node[2])
      if (ka && kb) {
        const key = COMMUTATIVE.has(op) && ka > kb ? `${op}|${kb}|${ka}` : `${op}|${ka}|${kb}`
        const entry = table.get(key)
        if (entry) {
          if (!entry.snapName) {
            const snapName = `$__pe${snapId++}`
            entry.snapName = snapName
            newLocals.push(['local', snapName, OP_TYPE[op] || 'f64'])
            const orig = entry.anchorParent[entry.anchorIdx]
            entry.anchorParent[entry.anchorIdx] = ['local.tee', snapName, orig]
          }
          parent[idx] = ['local.get', entry.snapName]
          return
        } else {
          const locals = new Set()
          if (ka.startsWith('L:')) locals.add(ka.slice(2))
          if (kb.startsWith('L:')) locals.add(kb.slice(2))
          table.set(key, { snapName: null, anchorParent: parent, anchorIdx: idx, locals })
          return
        }
      }
      // Fall through to recurse.
    }

    for (let i = 0; i < node.length; i++) walk(node[i], node, i)
  }

  for (let i = bodyStart; i < fn.length; i++) walk(fn[i], fn, i)

  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)
}

/**
 * Drop redundant zero-initialisation of fresh function-scope locals.
 *
 * WASM zero-initialises every local on entry (0 / 0.0 / null). jz lowers source
 * `let x = 0` to `(local $x …)` + `(local.set $x (<zero const>))` at the top of
 * the function body — the explicit set is a no-op when nothing has touched `$x`
 * yet. `wasm-opt -Oz` elides these; do the same so jz's own output is minimal.
 *
 * Only removes a `(local.set $L (i32|i64|f64|f32.const 0))` when:
 *   - `$L` is a non-param local (a param's "default" is the incoming arg, not 0),
 *   - it is a *top-level* body statement (never descend into block/loop/if — a
 *     nested zero-set inside a loop genuinely re-initialises across iterations),
 *   - `$L` has not been referenced by any earlier top-level statement (so the
 *     local still holds its entry-time zero at this point),
 *   - `$L` is read (`local.get`) somewhere in the function (otherwise leave the
 *     store for deadStoreElim and avoid orphaning the `(local $L …)` decl),
 *   - the constant is +0 / +0.0 (a `-0.0` f64 set is *not* redundant — locals
 *     default to +0.0, which differs in bits from -0.0).
 */
export function dropDeadZeroInit(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  const seen = new Set()           // params + locals referenced by an earlier stmt
  const reads = new Set()          // locals read by `local.get` anywhere
  for (const c of fn) if (Array.isArray(c) && c[0] === 'param' && typeof c[1] === 'string') seen.add(c[1])

  const collectGets = (node) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'local.get' && typeof node[1] === 'string') reads.add(node[1])
    for (let i = 1; i < node.length; i++) collectGets(node[i])
  }
  for (let i = bodyStart; i < fn.length; i++) collectGets(fn[i])

  const collectRefs = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if ((op === 'local.get' || op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string') seen.add(node[1])
    for (let i = 1; i < node.length; i++) collectRefs(node[i])
  }
  const isPlusZeroConst = (e) => {
    if (!Array.isArray(e) || e.length !== 2) return false
    if (e[0] !== 'i32.const' && e[0] !== 'i64.const' && e[0] !== 'f64.const' && e[0] !== 'f32.const') return false
    const v = e[1]
    if (typeof v === 'bigint') return v === 0n
    if (typeof v === 'number') return v === 0 && !Object.is(v, -0)
    if (typeof v === 'string') { const t = v.trim(); return t === '0' || t === '0.0' || t === '+0' || t === '+0.0' }
    return false
  }

  const drop = []
  for (let i = bodyStart; i < fn.length; i++) {
    const node = fn[i]
    if (!Array.isArray(node)) continue
    if (node[0] === 'local.set' && node.length === 3 && typeof node[1] === 'string' &&
        !seen.has(node[1]) && reads.has(node[1]) && isPlusZeroConst(node[2])) {
      drop.push(i)
      seen.add(node[1])
      continue
    }
    collectRefs(node)
  }
  for (let i = drop.length - 1; i >= 0; i--) fn.splice(drop[i], 1)
}

/**
 * Dead-store elimination: remove `local.set` / `local.tee` and `drop` of pure
 * expressions whose values are never consumed.
 *
 * Conservative single-block analysis: tracks last-write per local within each
 * straight-line sequence. A write is dead if the same local is written again
 * before any intervening read in the same block. Control-flow boundaries
 * (block, loop, if) reset the table — we don't eliminate across branches.
 *
 * Also removes `drop` of pure expressions (e.g. leftover ptr-type calls).
 */
export function deadStoreElim(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  const dead = []

  const collectGets = (node, out) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'local.get' && typeof node[1] === 'string') { out.add(node[1]); return }
    for (let i = 1; i < node.length; i++) collectGets(node[i], out)
  }

  const isPure = (node) => {
    if (!Array.isArray(node)) return true
    const op = node[0]
    if (typeof op === 'string' && MEMOP.test(op)) return false
    if (op === 'call' || op === 'call_indirect' || op === 'call_ref') return false
    if (op === 'global.get' || op === 'global.set') return false
    if (op === 'local.tee') return false
    if (op === 'memory.size' || op === 'memory.grow') return false
    for (let i = 1; i < node.length; i++) if (!isPure(node[i])) return false
    return true
  }

  const scanBlock = (items, start, end) => {
    const lastWrite = new Map() // localName → { parent, idx }

    for (let i = start; i < end; i++) {
      const node = items[i]
      if (!Array.isArray(node)) continue
      const op = node[0]

      // Reads invalidate pending dead writes
      const reads = new Set()
      collectGets(node, reads)
      if (op === 'local.tee') reads.delete(node[1])
      for (const name of reads) lastWrite.delete(name)

      // Drop of pure expr → dead
      if (op === 'drop' && isPure(node[1])) {
        dead.push({ parent: items, idx: i, drop: true })
      }

      // Local write tracking
      if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string') {
        const prev = lastWrite.get(node[1])
        if (prev) {
          // The store-to-local is dead, but a `local.set` is only *removable*
          // if its RHS is pure — `local.set $x (call f …)` where `f` mutates
          // memory must still run. (A `local.tee` is always safe: removal demotes
          // it to its value expression, so any side effects there are preserved.)
          const pn = prev.parent[prev.idx]
          if (pn[0] === 'local.tee' || isPure(pn[2])) dead.push(prev)
        }
        lastWrite.set(node[1], { parent: items, idx: i })
      }

      // Recurse into nested blocks with fresh state
      if (op === 'block' || op === 'loop') {
        let j = 1
        while (j < node.length && Array.isArray(node[j]) && node[j][0] === 'result') j++
        scanBlock(node, j, node.length)
      } else if (op === 'if') {
        let j = 1
        while (j < node.length && Array.isArray(node[j]) && node[j][0] === 'result') j++
        const condReads = new Set()
        collectGets(node[j], condReads)
        for (const name of condReads) lastWrite.delete(name)
        j++
        for (; j < node.length; j++) {
          const c = node[j]
          if (Array.isArray(c) && (c[0] === 'then' || c[0] === 'else')) scanBlock(c, 1, c.length)
        }
      }
    }
  }

  scanBlock(fn, bodyStart, fn.length)

  // Remove in reverse order so indices stay valid
  for (let i = dead.length - 1; i >= 0; i--) {
    const d = dead[i]
    if (d.drop) {
      d.parent.splice(d.idx, 1)
    } else {
      const node = d.parent[d.idx]
      if (node[0] === 'local.tee') {
        // tee in statement position: replace with just the value (implicitly dropped)
        d.parent[d.idx] = node[2]
      } else {
        // set in statement position: remove entirely
        d.parent.splice(d.idx, 1)
      }
    }
  }
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
 * @param {Array} fn - Function IR (WAT-as-array)
 * @param {Map<string,string>} [globalTypes] - Optional: global name → wasm type ('i32'|'f64'|'i64'|'funcref')
 */
export function promoteGlobals(fn, globalTypes) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Collect global.get counts and detect any global.set
  const getCounts = new Map()  // globalName → count
  const written = new Set()

  const scan = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'global.get' && typeof node[1] === 'string') {
      getCounts.set(node[1], (getCounts.get(node[1]) || 0) + 1)
      return  // don't recurse into the name string
    }
    if (op === 'global.set') {
      if (typeof node[1] === 'string') written.add(node[1])
      if (node[2]) scan(node[2])
      return
    }
    for (let i = 1; i < node.length; i++) scan(node[i])
  }

  for (let i = bodyStart; i < fn.length; i++) scan(fn[i])

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
  const replace = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'global.get' && typeof node[1] === 'string') {
      const info = replacements.get(node[1])
      if (info) { node[0] = 'local.get'; node[1] = info.lName }
      return
    }
    for (let i = 1; i < node.length; i++) replace(node[i])
  }
  for (let i = insertIdx; i < fn.length; i++) replace(fn[i])
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
    if (!Array.isArray(node) || inferred) return
    if (node[0] === 'global.get' && node[1] === gName) {
      // Check parent context
      if (Array.isArray(parent)) {
        const pOp = parent[0]
        // If parent is an i32 op that takes this as operand, likely i32
        if (typeof pOp === 'string') {
          if (pOp.startsWith('i32.') && pOp !== 'i32.wrap_i64' && pOp !== 'i32.trunc_f64') {
            inferred = 'i32'
            return
          }
          if (pOp === 'i32.store' && idx === 2) { inferred = 'i32'; return }  // addr
          if (pOp === 'f64.store' && idx === 2) { inferred = 'f64'; return }  // addr can be i32, but value is f64
          if (pOp === 'i32.eq' || pOp === 'i32.ne' || pOp === 'i32.lt_s' || pOp === 'i32.lt_u' ||
              pOp === 'i32.gt_s' || pOp === 'i32.gt_u' || pOp === 'i32.le_s' || pOp === 'i32.le_u' ||
              pOp === 'i32.ge_s' || pOp === 'i32.ge_u') {
            // Comparison — could be i32, but in jz NaN-boxing scheme most globals are f64
            // Only if we can confirm from local.set context
          }
          if (pOp === 'local.set' && idx === 0) {
            // Can't determine local type from here easily
          }
        }
      }
      // Default: f64 (the NaN-boxing carrier)
      if (!inferred) inferred = 'f64'
      return
    }
    for (let i = 0; i < node.length; i++) {
      if (Array.isArray(node[i])) check(node[i], node, i)
      if (inferred) return
    }
  }
  for (let i = bodyStart; i < fn.length && !inferred; i++) check(fn[i], null, i)
  return inferred
}

/**
 * Hoist frequently-repeated f64 constants into mutable globals.
 * f64.const is 9 bytes; global.get with idx<128 is 2 bytes — saves 7 B per reuse.
 * Pool entries sorted by usage descending, so hottest get lowest indices (1-byte LEB128).
 * Break-even: N ≥ 2 uses (pool cost: 11 B global decl + 2N bytes vs 9N original).
 *
 * Mutates `funcs` in place; writes new global decls via `addGlobal(name, watString)`.
 */
export function hoistConstantPool(funcs, addGlobal) {
  const MIN_USES = 2
  // Single walk: count occurrences AND record each f64.const site for direct rewrite.
  // Avoids a second full-AST traversal in the rewrite phase.
  const counts = new Map()
  const sites = []  // { parent, idx, key }
  const walk = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 0; i < node.length; i++) {
      const c = node[i]
      if (Array.isArray(c) && c[0] === 'f64.const' && (typeof c[1] === 'number' || typeof c[1] === 'string')) {
        // Distinguish -0 from +0 by sign: template literal collapses both to "0".
        const k = typeof c[1] === 'number'
          ? (Object.is(c[1], -0) ? 'n:-0' : `n:${c[1]}`)
          : `s:${c[1]}`
        counts.set(k, (counts.get(k) || 0) + 1)
        sites.push({ parent: node, idx: i, key: k })
      }
      walk(c)
    }
  }
  for (let i = 0; i < funcs.length; i++) walk(funcs[i])

  const hoist = new Map()
  const sorted = [...counts].filter(([, n]) => n >= MIN_USES).sort((a, b) => b[1] - a[1])
  let gId = 0
  for (const [k] of sorted) {
    const name = `__fc${gId++}`
    const lit = k.slice(2)
    addGlobal(name, `(global $${name} (mut f64) (f64.const ${lit}))`)
    hoist.set(k, name)
  }
  if (!hoist.size) return

  // Rewrite recorded sites directly. Idempotent: if parent[idx] is no longer the
  // f64.const we recorded (shared subtrees), skip.
  for (let i = 0; i < sites.length; i++) {
    const { parent, idx, key } = sites[i]
    const g = hoist.get(key)
    if (!g) continue
    const c = parent[idx]
    if (!Array.isArray(c) || c[0] !== 'f64.const') continue
    parent[idx] = ['global.get', `$${g}`]
  }
}

/**
 * Specialize `(call $F arg1 arg2 …)` call sites by literal-arg signature.
 *
 * For each call target with a stable (param-types, result-type) signature,
 * scan all call sites and group by "literal-arg signature" (which args are
 * `i32.const N` literals vs runtime-dynamic). For groups with ≥ MIN_USES, emit
 * a specialized trampoline `$F_L1_L2_…` that bakes literals into the call:
 *
 *   (func $F_L1_L2 (param $a2 T2) (result R)
 *     (call $F (i32.const L1) (local.get $a2)))
 *
 * Call sites are rewritten `(call $F (i32.const L1) a2)` → `(call $F_L1_L2 a2)`.
 * Savings per site: ~2 B per dropped literal arg.
 *
 * For `$__mkptr`, every combo has type+aux literal so we special-case the body:
 * fold the prefix into `(i64.const TEMPLATE)` instead of a trampoline call —
 * avoids a runtime indirection for the hottest path.
 *
 * @param funcs    — flat list of func IR nodes (sec.funcs + sec.stdlib + sec.start)
 * @param addFunc  — callback `(watString) => void` to register new helpers
 * @param parseWat — `wat → IR` parser (injected to avoid circular imports)
 */
export function specializeMkptr(funcs, addFunc, parseWat) {
  // Per-target specification: param-types, result-type. Threshold tuned so helper cost amortizes.
  // Any target not listed here is left untouched. Order matters only for readability.
  const SPECS = {
    '$__mkptr':     { params: ['i32', 'i32', 'i32'], result: 'f64', inline: true },
    '$__alloc_hdr':   { params: ['i32', 'i32'],        result: 'i32' },
    '$__alloc_hdr_n': { params: ['i32', 'i32', 'i32'], result: 'i32' },
    '$__typed_idx': { params: ['i64', 'i32'],        result: 'f64' },
    '$__str_idx':   { params: ['i64', 'i32'],        result: 'f64' },
  }
  const MIN_USES = 5

  // Build literal-arg signature key for a call node. Returns null if no args are literal.
  // Key format: 'T:V' per literal arg, 'D' per dynamic; indexed by position.
  const sigKey = (call, nParams) => {
    const key = []
    let anyLit = false
    for (let i = 0; i < nParams; i++) {
      const a = call[2 + i]
      if (Array.isArray(a) && a[0] === 'i32.const' && typeof a[1] === 'number') { key.push('L:' + a[1]); anyLit = true }
      else key.push('D')
    }
    return anyLit ? key.join('|') : null
  }

  // Pass 1: count per (target, sig) AND record candidate site locations for direct
  // rewrite in pass 3. Pre-order push means nested candidates appear later in `sites`,
  // so reverse iteration in pass 3 yields leaf-first rewrite order (inner before outer).
  const counts = new Map()  // 'target##sig' → count
  const sites = []  // { parent, idx, fullKey, parts }
  const walk = (node, parent, idx) => {
    if (!Array.isArray(node)) return
    if (parent && node[0] === 'call' && typeof node[1] === 'string' && SPECS[node[1]]) {
      const spec = SPECS[node[1]]
      if (node.length === 2 + spec.params.length) {
        const k = sigKey(node, spec.params.length)
        if (k) {
          const fullKey = node[1] + '##' + k
          counts.set(fullKey, (counts.get(fullKey) || 0) + 1)
          sites.push({ parent, idx, fullKey, parts: k.split('|') })
        }
      }
    }
    for (let i = 0; i < node.length; i++) walk(node[i], node, i)
  }
  for (let i = 0; i < funcs.length; i++) walk(funcs[i], null, 0)

  // Pass 2: for each eligible (target, sig), emit helper.
  const specialized = new Set()
  for (const [k, n] of counts) if (n >= MIN_USES) specialized.add(k)
  if (!specialized.size) return

  const variantName = (target, sigParts) => target.slice(1) + '_' + sigParts
    .map(p => p === 'D' ? 'd' : p.slice(2)).join('_')

  for (const fullKey of specialized) {
    const [target, sig] = fullKey.split('##')
    const parts = sig.split('|')
    const spec = SPECS[target]
    const name = variantName(target, parts)

    // $__mkptr inline fast path: bake (type, aux) literals into i64.const template.
    if (target === '$__mkptr' && spec.inline && parts[0].startsWith('L:') && parts[1].startsWith('L:')) {
      const type = +parts[0].slice(2), aux = +parts[1].slice(2)
      const tmpl = LAYOUT.NAN_PREFIX_BITS
        | ((BigInt(type) & BigInt(LAYOUT.TAG_MASK)) << BigInt(LAYOUT.TAG_SHIFT))
        | ((BigInt(aux) & BigInt(LAYOUT.AUX_MASK)) << BigInt(LAYOUT.AUX_SHIFT))
      // Third arg (offset) may also be literal — emit (f64.const nan:…) then.
      if (parts[2].startsWith('L:')) {
        // Fully literal: all sites can be f64.const — no helper needed, handled in rewrite below.
        continue
      }
      addFunc(`(func $${name} (param $o i32) (result f64)
        (f64.reinterpret_i64 (i64.or (i64.const 0x${tmpl.toString(16).toUpperCase()}) (i64.extend_i32_u (local.get $o)))))`)
      continue
    }

    // Generic trampoline: (func $F_LITS (param …dyn) (result R) (call $F lits+dyn))
    const dynArgs = []
    const callArgs = []
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith('L:')) {
        callArgs.push(`(i32.const ${parts[i].slice(2)})`)
      } else {
        dynArgs.push(`(param $a${i} ${spec.params[i]})`)
        callArgs.push(`(local.get $a${i})`)
      }
    }
    addFunc(`(func $${name} ${dynArgs.join(' ')} (result ${spec.result}) (call ${target} ${callArgs.join(' ')}))`)
  }

  // Pass 3: rewrite recorded sites in reverse (leaf-first since pass 1 was pre-order).
  // Iterating the captured site list avoids a second full-AST walk.
  // Idempotency guard: shared subtrees in the IR cause the same (parent, idx) to be
  // recorded as multiple sites. The first visit rewrites; subsequent visits see the
  // rewritten call (target no longer in SPECS) and skip — same behavior as the
  // recursive rewrite this replaces.
  for (let i = sites.length - 1; i >= 0; i--) {
    const { parent, idx, fullKey, parts } = sites[i]
    if (!specialized.has(fullKey)) continue
    const c = parent[idx]
    const target = c[1]
    const spec = SPECS[target]
    if (!spec || c.length !== 2 + spec.params.length) continue

    // $__mkptr fully literal (rare — mkPtrIR usually folds these ahead of us, but defensive):
    if (target === '$__mkptr' && parts[0].startsWith('L:') && parts[1].startsWith('L:') && parts[2].startsWith('L:')) {
      const type = +parts[0].slice(2), aux = +parts[1].slice(2), off = +parts[2].slice(2)
      const bits = LAYOUT.NAN_PREFIX_BITS
        | ((BigInt(type) & BigInt(LAYOUT.TAG_MASK)) << BigInt(LAYOUT.TAG_SHIFT))
        | ((BigInt(aux) & BigInt(LAYOUT.AUX_MASK)) << BigInt(LAYOUT.AUX_SHIFT))
        | (BigInt(off >>> 0) & BigInt(LAYOUT.OFFSET_MASK))
      const n = ['f64.const', 'nan:0x' + bits.toString(16).toUpperCase().padStart(16, '0')]
      n.type = 'f64'
      parent[idx] = n
      continue
    }

    const name = variantName(target, parts)
    const dynArgs = []
    for (let j = 0; j < parts.length; j++) if (parts[j] === 'D') dynArgs.push(c[2 + j])
    const newCall = ['call', '$' + name, ...dynArgs]
    newCall.type = spec.result
    parent[idx] = newCall
  }
}

/**
 * Specialize `(call $F (i32.add (global.get $G) (i32.const N)))` → `(call $F_rel_$G (i32.const N))`.
 * Helper bakes `(global.get $G) + i32.add` into its body so call sites drop those 3 B.
 * Targets any single-arg call whose arg is `add(global_base, const)` — in practice: $__mkptr_X_Y_d
 * specializations against $__strBase (watr self-host: ~2193 sites × 3 B ≈ 6.5 KB).
 *
 * @param funcs    — flat list of func IR nodes
 * @param addFunc  — callback `(watString) => void` to register new helpers
 * @param parseWat — `wat → IR` parser (injected)
 */
export function specializePtrBase(funcs, addFunc, parseWat) {
  const MIN_USES = 20

  // Pass 1: count (targetFunc, baseGlobal) pairs AND record candidate sites for direct
  // rewrite in pass 3 (avoids a second full-AST walk).
  const counts = new Map()  // 'F##G' → count
  const sites = []  // { parent, idx, key }
  const walk = (node, parent, idx) => {
    if (!Array.isArray(node)) return
    if (parent && node[0] === 'call' && typeof node[1] === 'string' && node.length === 3) {
      const arg = node[2]
      if (Array.isArray(arg) && arg[0] === 'i32.add' && arg.length === 3 &&
          Array.isArray(arg[1]) && arg[1][0] === 'global.get' && typeof arg[1][1] === 'string' &&
          Array.isArray(arg[2]) && arg[2][0] === 'i32.const') {
        const k = node[1] + '##' + arg[1][1]
        counts.set(k, (counts.get(k) || 0) + 1)
        sites.push({ parent, idx, key: k })
      }
    }
    for (let i = 0; i < node.length; i++) walk(node[i], node, i)
  }
  for (let i = 0; i < funcs.length; i++) walk(funcs[i], null, 0)

  const specialized = new Set()
  for (const [k, n] of counts) if (n >= MIN_USES) specialized.add(k)
  if (!specialized.size) return

  // Find a target func's result-type by locating its decl among `funcs`.
  const funcByName = new Map()
  for (let i = 0; i < funcs.length; i++) {
    const fn = funcs[i]
    if (Array.isArray(fn) && fn[0] === 'func' && typeof fn[1] === 'string') funcByName.set(fn[1], fn)
  }
  const resultOf = (name) => {
    const fn = funcByName.get(name)
    if (!fn) return 'f64'  // defensive; mkptr specializations all return f64
    for (let i = 2; i < fn.length; i++) {
      const c = fn[i]
      if (Array.isArray(c) && c[0] === 'result') return c[1]
      if (Array.isArray(c) && c[0] !== 'param') break
    }
    return 'f64'
  }

  const sanit = (g) => g.replace(/^\$/, '').replace(/[^a-zA-Z0-9_]/g, '_')
  const variantFor = (F, G) => `${F}_rel_${sanit(G)}`

  // Pass 2: emit helpers.
  for (const fullKey of specialized) {
    const [F, G] = fullKey.split('##')
    const rt = resultOf(F)
    const name = variantFor(F, G)
    addFunc(`(func ${name} (param $o i32) (result ${rt}) (call ${F} (i32.add (global.get ${G}) (local.get $o))))`)
  }

  // Pass 3: rewrite recorded sites in reverse (leaf-first since pass 1 was pre-order).
  // Idempotency guard: shared IR subtrees can record the same (parent, idx) twice.
  // The first visit rewrites to a 2-arg call; subsequent visits see a shape that
  // doesn't match the original `call F (i32.add (global.get) (i32.const))` pattern.
  for (let i = sites.length - 1; i >= 0; i--) {
    const { parent, idx, key } = sites[i]
    if (!specialized.has(key)) continue
    const c = parent[idx]
    if (!Array.isArray(c) || c[0] !== 'call' || c.length !== 3) continue
    const arg = c[2]
    if (!Array.isArray(arg) || arg[0] !== 'i32.add' || arg.length !== 3) continue
    if (!Array.isArray(arg[1]) || arg[1][0] !== 'global.get') continue
    if (!Array.isArray(arg[2]) || arg[2][0] !== 'i32.const') continue
    const F = c[1]
    const G = arg[1][1]
    const konst = arg[2]
    const newCall = ['call', variantFor(F, G), konst]
    newCall.type = resultOf(F)
    parent[idx] = newCall
  }
}

/**
 * Reorder strings in `strPool` so most-referenced strings get low byte offsets.
 * Each string ref is encoded as `(i32.const off)` with ULEB128: 1 B for off<128, 2 B for off<16384, 3 B for off<2M.
 * Frequent strings migrating from 3-B to 2-B (or 2-B to 1-B) LEB128 saves ~541 B on watr self-host.
 *
 * Pool layout: `[4-byte-len][data-bytes][4-byte-len][data-bytes]...`. Offsets in refs point PAST the len prefix.
 *
 * @param funcs        — flat list of func IR nodes (scanned for refs)
 * @param strPoolRef   — `{ pool: string }` holder; pool is rewritten in place
 * @param strDedupMap  — optional `Map<string, offset>` to update (kept consistent for later queries)
 */
export function sortStrPoolByFreq(funcs, strPoolRef, strDedupMap) {
  if (!strPoolRef.pool) return
  // Match both specialized and unspecialized strBase refs.
  const isSpecRef = (n) =>
    Array.isArray(n) && n[0] === 'call' && typeof n[1] === 'string' && n[1].includes('_rel___strBase') &&
    n.length === 3 && Array.isArray(n[2]) && n[2][0] === 'i32.const'
  const isUnspecRef = (n) =>
    Array.isArray(n) && n[0] === 'call' && typeof n[1] === 'string' && n[1].startsWith('$__mkptr_') &&
    n.length === 3 && Array.isArray(n[2]) && n[2][0] === 'i32.add' && n[2].length === 3 &&
    Array.isArray(n[2][1]) && n[2][1][0] === 'global.get' && n[2][1][1] === '$__strBase' &&
    Array.isArray(n[2][2]) && n[2][2][0] === 'i32.const'
  const getOff = (n) => isSpecRef(n) ? (n[2][1] | 0) : isUnspecRef(n) ? (n[2][2][1] | 0) : null
  const setOff = (n, v) => { if (isSpecRef(n)) n[2][1] = v; else if (isUnspecRef(n)) n[2][2][1] = v }

  // Single walk: count freq AND record each ref site for direct rewrite.
  const freq = new Map()
  const sites = []  // { node, oldOff } — node is the ref node, mutate offset in place
  const walk = (n) => {
    if (!Array.isArray(n)) return
    const o = getOff(n)
    if (o !== null) { freq.set(o, (freq.get(o) || 0) + 1); sites.push({ node: n, oldOff: o }) }
    for (let i = 0; i < n.length; i++) walk(n[i])
  }
  for (let i = 0; i < funcs.length; i++) walk(funcs[i])
  if (!freq.size) return

  // Parse pool structure into entries.
  const pool = strPoolRef.pool
  const entries = []
  let i = 0
  while (i < pool.length) {
    const len = pool.charCodeAt(i) | (pool.charCodeAt(i+1) << 8) | (pool.charCodeAt(i+2) << 16) | (pool.charCodeAt(i+3) << 24)
    const oldOff = i + 4
    entries.push({ oldOff, len, str: pool.substring(oldOff, oldOff + len) })
    i = oldOff + len
  }

  // Sort by freq descending; tie-break by length ascending (pack short hot strings into low-offset range).
  entries.sort((a, b) => (freq.get(b.oldOff) || 0) - (freq.get(a.oldOff) || 0) || a.len - b.len)

  // Rebuild pool; map old → new offsets. Deduplicate identical strings — keep the
  // first (hottest) occurrence as canonical and point duplicates to it.
  const remap = new Map()
  const canon = new Map() // str content → new offset
  let newPool = ''
  for (const e of entries) {
    const existing = canon.get(e.str)
    if (existing !== undefined) {
      remap.set(e.oldOff, existing)
      continue
    }
    newPool += String.fromCharCode(e.len & 0xFF, (e.len >> 8) & 0xFF, (e.len >> 16) & 0xFF, (e.len >> 24) & 0xFF)
    remap.set(e.oldOff, newPool.length)
    canon.set(e.str, newPool.length)
    newPool += e.str
  }
  strPoolRef.pool = newPool
  if (strDedupMap)
    for (const [str, oldOff] of strDedupMap) {
      const newOff = remap.get(oldOff)
      if (newOff !== undefined) strDedupMap.set(str, newOff)
    }

  // Rewrite recorded ref sites directly (no second AST walk).
  for (let i = 0; i < sites.length; i++) {
    const { node, oldOff } = sites[i]
    const newO = remap.get(oldOff)
    if (newO !== undefined) setOff(node, newO)
  }
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
 */
export function optimizeFunc(fn, cfg, globalTypes) {
  if (cfg && cfg.hoistPtrType === false &&
      cfg.hoistInvariantPtrOffset === false &&
      cfg.hoistInvariantPtrOffsetLoop === false &&
      cfg.fusedRewrite === false &&
      cfg.hoistAddrBase === false &&
      cfg.hoistInvariantCellLoads === false &&
      cfg.cseScalarLoad === false &&
      cfg.csePureExpr === false &&
      cfg.dropDeadZeroInit === false &&
      cfg.deadStoreElim === false &&
      cfg.promoteGlobals === false &&
      cfg.sortLocalsByUse === false &&
      cfg.vectorizeLaneLocal === false) return
  if (!cfg || cfg.hoistPtrType !== false) hoistPtrType(fn)
  if (!cfg || cfg.hoistInvariantPtrOffset !== false) hoistInvariantPtrOffset(fn)
  if (!cfg || cfg.hoistInvariantPtrOffsetLoop !== false) hoistInvariantPtrOffsetLoop(fn)
  const counts = new Map()
  if (!cfg || cfg.fusedRewrite !== false) fusedRewrite(fn, counts)
  if (!cfg || cfg.hoistAddrBase !== false) hoistAddrBase(fn)
  if (!cfg || cfg.hoistInvariantCellLoads !== false) hoistInvariantCellLoads(fn)
  if (!cfg || cfg.cseScalarLoad !== false) cseScalarLoad(fn)
  if (!cfg || cfg.csePureExpr !== false) csePureExpr(fn)
  if (!cfg || cfg.dropDeadZeroInit !== false) dropDeadZeroInit(fn)
  if (!cfg || cfg.deadStoreElim !== false) deadStoreElim(fn)
  if (!cfg || cfg.promoteGlobals !== false) promoteGlobals(fn, globalTypes)
  // Vectorizer runs PRE-watr unless full watr is enabled (`watr: true`). For full watr,
  // defer to post — full passes (notably `inlineOnce` + the post-inline `propagate`
  // sweep) reshape the IR so much that pre-watr SIMD patterns get scrambled. Light
  // watr (or no watr) leaves the lane locals intact for vectorize to pattern-match,
  // and lets a non-trivial chunk of SIMD survive the propagate+fold pipeline.
  if (cfg && cfg.vectorizeLaneLocal === true) {
    const fullWatr = cfg.watr === true
    const runVectorizer = (fullWatr && cfg.__phase === 'post') || (!fullWatr && cfg.__phase !== 'post')
    if (runVectorizer) vectorizeLaneLocal(fn)
  }
  if (!cfg || cfg.sortLocalsByUse !== false) sortLocalsByUse(fn, cfg && cfg.fusedRewrite !== false ? counts : null)
}

// Fused bottom-up walk applying three orthogonal pattern sets at each node:
//   inlinePtrType  — call $__ptr_type / __ptr_aux / __is_nullish / __is_null / __is_truthy
//                    (skipped inside $__ptr_*/__is_* helper bodies themselves)
//   peephole       — rebox/unbox round-trips: i64.reinterpret_f64 / f64.reinterpret_i64 /
//                    i32.wrap_i64 over (i64.extend_i32_u/_s X) or (i64.or HIGH_ONLY extend X)
//   foldMemarg     — (load/store (i32.add base (i32.const N)) …) → (load/store offset=N base …)
// They discriminate on node[0] and don't overlap, so one visit suffices for all three.
function fusedRewrite(fn, counts) {
  if (!Array.isArray(fn) || fn[0] !== 'func') {
    if (Array.isArray(fn)) {
      for (let i = 0; i < fn.length; i++) {
        const c = fn[i]
        if (Array.isArray(c)) fn[i] = walkRewrite(c, true, counts)
      }
    }
    return
  }
  // Skip __ptr_*/is_* bodies for inline pattern (they ARE the helpers).
  const name = typeof fn[1] === 'string' ? fn[1] : null
  const skipInline = !!(name && (name.startsWith('$__ptr_') || name === '$__is_nullish' || name === '$__is_truthy' || name === '$__is_null'))
  const bodyStart = findBodyStart(fn)
  for (let i = bodyStart; i < fn.length; i++) {
    const c = fn[i]
    if (Array.isArray(c)) fn[i] = walkRewrite(c, !skipInline, counts)
  }
}

function walkRewrite(node, doInline, counts) {
  if (!Array.isArray(node)) return node
  for (let i = 0; i < node.length; i++) {
    const c = node[i]
    if (Array.isArray(c)) node[i] = walkRewrite(c, doInline, counts)
  }
  const op = node[0]
  // Piggyback local-ref counting for sortLocalsByUse. `counts` may be undefined
  // when fusedRewrite is called outside optimizeFunc (whole-module pass).
  if (counts && (op === 'local.get' || op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string')
    counts.set(node[1], (counts.get(node[1]) || 0) + 1)

  // Inline-ptr-helpers: $__ptr_type / $__ptr_aux / $__is_nullish / $__is_null / $__is_truthy
  if (doInline && op === 'call' && node.length === 3 && typeof node[1] === 'string') {
    const fname = node[1]
    if (fname === '$__ptr_type') return ['i32.and',
      ['i32.wrap_i64', ['i64.shr_u', node[2], ['i64.const', LAYOUT.TAG_SHIFT]]],
      ['i32.const', LAYOUT.TAG_MASK]]
    if (fname === '$__ptr_aux') return ['i32.and',
      ['i32.wrap_i64', ['i64.shr_u', node[2], ['i64.const', LAYOUT.AUX_SHIFT]]],
      ['i32.const', LAYOUT.AUX_MASK]]
    if (fname === '$__is_null') return ['i64.eq', node[2], ['i64.const', NULL_BITS]]
    if (fname === '$__is_nullish' && Array.isArray(node[2]) && node[2][0] === 'i64.reinterpret_f64'
        && Array.isArray(node[2][1]) && node[2][1][0] === 'local.get') return ['i32.or',
      ['i64.eq', node[2], ['i64.const', NULL_BITS]],
      ['i64.eq', node[2], ['i64.const', UNDEF_BITS]]]
    if (fname === '$__is_truthy' && Array.isArray(node[2]) && node[2][0] === 'i64.reinterpret_f64'
        && Array.isArray(node[2][1]) && node[2][1][0] === 'local.get') {
      const lget = node[2][1]
      const bits = node[2]
      return ['if', ['result', 'i32'],
        ['f64.eq', lget, lget],
        ['then', ['f64.ne', lget, ['f64.const', 0]]],
        ['else', ['i32.and',
          ['i32.and',
            ['i64.ne', bits, ['i64.const', NAN_BITS]],
            ['i64.ne', bits, ['i64.const', NULL_BITS]]],
          ['i32.and',
            ['i64.ne', bits, ['i64.const', UNDEF_BITS]],
            ['i64.ne', bits, ['i64.const', '0x7FFA400000000000']]]]]]
    }
  }

  // Peephole: rebox/unbox round-trips
  if ((op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u') && node.length === 2) {
    const a = node[1]
    if (Array.isArray(a) && a[0] === 'i32.const') {
      const n = typeof a[1] === 'number' ? a[1] : typeof a[1] === 'string' ? Number(a[1]) : NaN
      if (Number.isFinite(n)) return ['f64.const', op === 'f64.convert_i32_u' ? n >>> 0 : n]
    }
  }
  if (op === 'f64.mul' && node.length === 3) {
    const a = node[1], b = node[2]
    const isTwo = x => Array.isArray(x) && x[0] === 'f64.const' && x[1] === 2
    const isCheapF64 = x => Array.isArray(x) &&
      ((x[0] === 'local.get' && typeof x[1] === 'string') ||
       (x[0] === 'f64.const' && typeof x[1] === 'number'))
    if (isTwo(a) && isCheapF64(b)) return ['f64.add', b, b]
    if (isTwo(b) && isCheapF64(a)) return ['f64.add', a, a]
  }
  if (op === 'i32.trunc_sat_f64_s' && node.length === 2) {
    const a = node[1]
    if (Array.isArray(a) && a[0] === 'f64.convert_i32_s' && a.length === 2) return a[1]
  }
  if (op === 'i64.trunc_sat_f64_s' && node.length === 2) {
    const a = node[1]
    if (Array.isArray(a) && a[0] === 'f64.convert_i32_s' && a.length === 2) return ['i64.extend_i32_s', a[1]]
    if (Array.isArray(a) && a[0] === 'f64.convert_i32_u' && a.length === 2) return ['i64.extend_i32_u', a[1]]
  }
  if (op === 'i64.reinterpret_f64' && node.length === 2) {
    const a = node[1]
    if (Array.isArray(a) && a[0] === 'f64.reinterpret_i64' && a.length === 2) return a[1]
  }
  if (op === 'f64.reinterpret_i64' && node.length === 2) {
    const a = node[1]
    if (Array.isArray(a) && a[0] === 'i64.reinterpret_f64' && a.length === 2) return a[1]
  }
  if (op === 'i32.wrap_i64' && node.length === 2) {
    const a = node[1]
    if (Array.isArray(a) && (a[0] === 'i64.extend_i32_u' || a[0] === 'i64.extend_i32_s') && a.length === 2)
      return a[1]
    // (i32.wrap_i64 (i64.reinterpret_f64 (f64.load ADDR ?offset))) → (i32.load ADDR ?offset).
    // Wasm is little-endian; the low 32 bits of the f64 at ADDR are exactly
    // i32.load(ADDR). Saves two ops on every NaN-box pointer extraction from
    // an array slot or struct field.
    if (Array.isArray(a) && a[0] === 'i64.reinterpret_f64' && a.length === 2) {
      const inner = a[1]
      if (Array.isArray(inner) && inner[0] === 'f64.load') {
        const out = ['i32.load']
        for (let i = 1; i < inner.length; i++) out.push(inner[i])
        return out
      }
      // (i32.wrap_i64 (i64.reinterpret_f64 (call $__mkptr* … offset))) → offset.
      // A NaN-boxed pointer keeps type/aux in the high bits and the i32 offset in
      // the low 32, so the round-trip through f64 is pure overhead whenever the
      // consumer only wants the offset (typical when the pointer feeds an unboxed
      // i32 local). Covers the generic 3-arg `$__mkptr` and the specialized
      // single-arg `$__mkptr_T_A_d` trampolines alike — offset is the last arg.
      const isMkptr = n => Array.isArray(n) && n[0] === 'call' && typeof n[1] === 'string'
        && (n[1] === '$__mkptr' || n[1].startsWith('$__mkptr_'))
      if (isMkptr(inner)) return inner[inner.length - 1]
      // …and reach through a `(block (result f64) …stmts (call $__mkptr …))` —
      // `new TypedArray(n)` lowers to exactly this shape — by retyping the block
      // to i32 and dropping the box on its tail.
      if (Array.isArray(inner) && inner[0] === 'block' && isMkptr(inner[inner.length - 1])) {
        let ri = -1
        for (let i = 1; i <= 2 && i < inner.length; i++)
          if (Array.isArray(inner[i]) && inner[i][0] === 'result') { ri = i; break }
        if (ri >= 0 && inner[ri][1] === 'f64') {
          const tail = inner[inner.length - 1]
          const nb = inner.slice()
          nb[ri] = ['result', 'i32']
          nb[nb.length - 1] = tail[tail.length - 1]
          return nb
        }
      }
    }
    if (Array.isArray(a) && a[0] === 'i64.or' && a.length === 3) {
      const l = a[1], r = a[2]
      const isHighOnly = (n) => {
        if (!Array.isArray(n) || n[0] !== 'i64.const') return false
        const v = n[1]
        let bi
        if (typeof v === 'number') bi = BigInt(v)
        else if (typeof v === 'string') {
          try { bi = v.startsWith('-') ? -BigInt(v.slice(1)) : BigInt(v) } catch { return false }
        } else return false
        return (bi & 0xFFFFFFFFn) === 0n
      }
      const isExtend = (n) => Array.isArray(n) && (n[0] === 'i64.extend_i32_u' || n[0] === 'i64.extend_i32_s') && n.length === 2
      if (isHighOnly(l) && isExtend(r)) return r[1]
      if (isHighOnly(r) && isExtend(l)) return l[1]
    }
  }

  // shl-distribute-over-add: (i32.shl (i32.add x (i32.const K)) (i32.const S))
  // → (i32.add (i32.shl x S) (i32.const K<<S)). Overflow-safe — both forms wrap
  // mod 2^32 identically. Unlocks memarg offset= folding for biquad-style
  // `arr[c+K0..KN]` reads where idx is precomputed but K is a small literal.
  if (op === 'i32.shl' && node.length === 3) {
    const a = node[1], b = node[2]
    // shl-shl-merge: (i32.shl (i32.shl x K1) K2) → (i32.shl x (K1+K2))
    // when K1+K2 < 32. Biquad: `sb = s<<2` then `__ab1 = state + (sb<<3)` ⇒
    // `s<<5` directly.
    if (Array.isArray(a) && a[0] === 'i32.shl' && a.length === 3 &&
        Array.isArray(b) && b[0] === 'i32.const' && typeof b[1] === 'number' &&
        Array.isArray(a[2]) && a[2][0] === 'i32.const' && typeof a[2][1] === 'number') {
      const sum = a[2][1] + b[1]
      if (sum >= 0 && sum < 32) return ['i32.shl', a[1], ['i32.const', sum]]
    }
    if (Array.isArray(a) && a[0] === 'i32.add' && a.length === 3 &&
        Array.isArray(b) && b[0] === 'i32.const' && typeof b[1] === 'number' && b[1] >= 0 && b[1] < 32) {
      const ka = a[1], kb = a[2]
      let inner, k
      if (Array.isArray(kb) && kb[0] === 'i32.const' && typeof kb[1] === 'number') { inner = ka; k = kb[1] }
      else if (Array.isArray(ka) && ka[0] === 'i32.const' && typeof ka[1] === 'number') { inner = kb; k = ka[1] }
      if (inner != null) {
        const shifted = (k * (1 << b[1])) | 0
        return ['i32.add', ['i32.shl', inner, b], ['i32.const', shifted]]
      }
    }
  }

  // assoc-lift-const-add: (i32.add A (i32.add B (i32.const K))) → (i32.add (i32.add A B) (i32.const K))
  // and mirror for left side. Lifts constant to top level so foldMemargOffsets
  // recognizes the canonical (i32.add base const) shape.
  if (op === 'i32.add' && node.length === 3) {
    const a = node[1], b = node[2]
    if (Array.isArray(b) && b[0] === 'i32.add' && b.length === 3) {
      const bb1 = b[1], bb2 = b[2]
      if (Array.isArray(bb2) && bb2[0] === 'i32.const') return ['i32.add', ['i32.add', a, bb1], bb2]
      if (Array.isArray(bb1) && bb1[0] === 'i32.const') return ['i32.add', ['i32.add', a, bb2], bb1]
    }
    if (Array.isArray(a) && a[0] === 'i32.add' && a.length === 3) {
      const aa1 = a[1], aa2 = a[2]
      if (Array.isArray(aa2) && aa2[0] === 'i32.const') return ['i32.add', ['i32.add', aa1, b], aa2]
      if (Array.isArray(aa1) && aa1[0] === 'i32.const') return ['i32.add', ['i32.add', aa2, b], aa1]
    }
  }

  // foldMemargOffsets: (load/store (i32.add base const) ...) → (load/store offset=N base ...)
  if (typeof op === 'string' && MEMOP.test(op)) {
    const m1 = node[1]
    if (!(typeof m1 === 'string' && (m1.startsWith('offset=') || m1.startsWith('align=')))) {
      const addr = m1
      if (Array.isArray(addr) && addr[0] === 'i32.add' && addr.length === 3) {
        const a = addr[1], b = addr[2]
        let base, offset
        if (Array.isArray(b) && b[0] === 'i32.const' && typeof b[1] === 'number' && b[1] >= 0 && b[1] < 0x100000000) { base = a; offset = b[1] }
        else if (Array.isArray(a) && a[0] === 'i32.const' && typeof a[1] === 'number' && a[1] >= 0 && a[1] < 0x100000000) { base = b; offset = a[1] }
        if (base != null) {
          node[1] = `offset=${offset}`
          node.splice(2, 0, base)
        }
      }
    }
  }
  return node
}

/**
 * Dead-code elimination: remove func decls not reachable from any entry point.
 * Roots: `(start $X)`, `(export "n" (func $X))`, `(elem … $X …)`, `(ref.func $X)`.
 * Iteratively adds funcs called from reachable ones. Mutates arrays in place.
 * Typical win: watr's optimize.js has orphan top-level consts (e.g. `hoist` = 26 KB).
 *
 * @param funcSections — array of { arr, isStartContainer? }. Each `arr` holds func IR nodes
 *                       (may be interleaved with other nodes like `(start $X)` for sec.start).
 * @param allModuleNodes — flat iterable of all module-level nodes for root discovery
 *                          (exports, elem, start directive are elsewhere than funcSections).
 * @param opts — optional `{ removeDead: bool }`. When `removeDead` is false, the
 *               reachability walk still runs (so `callCount` is populated for the
 *               funcidx sort downstream) but unreachable funcs are kept. Default true.
 */
export function treeshake(funcSections, allModuleNodes, opts) {
  const removeDead = !opts || opts.removeDead !== false
  const funcByName = new Map()
  const allFuncs = []
  for (const { arr } of funcSections)
    for (const n of arr)
      if (Array.isArray(n) && n[0] === 'func') {
        allFuncs.push(n)
        if (typeof n[1] === 'string') funcByName.set(n[1], n)
      }

  const reachable = new Set()
  const stack = []
  const addRoot = (name) => { if (funcByName.has(name) && !reachable.has(name)) { reachable.add(name); stack.push(name) } }

  // Named funcs with inline `(export "name")` are module-export roots.
  for (const [name, fn] of funcByName)
    for (let i = 2; i < fn.length; i++)
      if (Array.isArray(fn[i]) && fn[i][0] === 'export') { addRoot(name); break }

  const findRoots = (node) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'start' && typeof node[1] === 'string') addRoot(node[1])
    else if (node[0] === 'export' && Array.isArray(node[2]) && node[2][0] === 'func') addRoot(node[2][1])
    else if (node[0] === 'elem') for (const c of node) if (typeof c === 'string' && c.startsWith('$')) addRoot(c)
    for (const c of node) findRoots(c)
  }
  for (const n of allModuleNodes) findRoots(n)

  // Side-output: per-callee call counts over all reachable + anonymous funcs.
  // Caller uses this to sort funcs by hotness for low-LEB128-funcidx packing.
  // Counting here is free — we already visit every node in these funcs.
  const callCount = new Map()
  const CALL_OPS = new Set(['call', 'return_call', 'ref.func'])
  const visitCalls = (node) => {
    if (!Array.isArray(node)) return
    if (CALL_OPS.has(node[0]) && typeof node[1] === 'string') {
      addRoot(node[1])
      if (node[0] === 'call' || node[0] === 'return_call')
        callCount.set(node[1], (callCount.get(node[1]) || 0) + 1)
    }
    for (const c of node) visitCalls(c)
  }
  // Anonymous funcs can't be pruned (no name) — walk them to seed roots.
  for (const fn of allFuncs) if (typeof fn[1] !== 'string') visitCalls(fn)
  while (stack.length) visitCalls(funcByName.get(stack.pop()))

  let removed = 0
  if (removeDead) {
    for (const { arr } of funcSections) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const n = arr[i]
        if (Array.isArray(n) && n[0] === 'func' && typeof n[1] === 'string' && !reachable.has(n[1])) {
          arr.splice(i, 1); removed++
        }
      }
    }
  }

  // Dead-global elimination: after dead funcs are gone, drop `(global $g …)` decls
  // that nothing references (a `global.get`/`global.set` in a remaining func, a kept
  // global's init expr, a data/elem offset, or an `(export … (global $g))`). Imported
  // globals live in `allModuleNodes`, not in `opts.globals`, so they're never touched.
  // Fixpoint: a kept global's init may reference another global.
  const globals = removeDead && opts && Array.isArray(opts.globals) ? opts.globals : null
  if (globals) {
    const collectGlobalRefs = (node, refd) => {
      if (!Array.isArray(node)) return
      if ((node[0] === 'global.get' || node[0] === 'global.set') && typeof node[1] === 'string') refd.add(node[1])
      else if (node[0] === 'export' && Array.isArray(node[2]) && node[2][0] === 'global' && typeof node[2][1] === 'string') refd.add(node[2][1])
      for (const c of node) collectGlobalRefs(c, refd)
    }
    let changed = true
    while (changed) {
      changed = false
      const refd = new Set()
      for (const { arr } of funcSections) for (const n of arr) collectGlobalRefs(n, refd)
      for (const n of allModuleNodes) collectGlobalRefs(n, refd)
      for (const g of globals) collectGlobalRefs(g, refd)
      for (let i = globals.length - 1; i >= 0; i--) {
        const g = globals[i]
        if (Array.isArray(g) && g[0] === 'global' && typeof g[1] === 'string' && !refd.has(g[1])) {
          globals.splice(i, 1); changed = true
        }
      }
    }
  }

  return { removed, callCount }
}

/**
 * Reorder non-param local decls by reference count (hot locals first).
 * WASM `local.get/set/tee` encode local idx as ULEB128 — 1 B for idx < 128, else 2 B.
 * Only the decl order changes; refs by name are unchanged and re-resolved by watr.
 * Params are fixed (their slot defines the call ABI) — only `(local …)` nodes move.
 */
export function sortLocalsByUse(fn, precomputedCounts) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const localIdxs = []
  let totalDecls = 0
  for (let i = 2; i < fn.length; i++) {
    const c = fn[i]
    if (!Array.isArray(c)) continue
    if (c[0] === 'param' || c[0] === 'result') { totalDecls++; continue }
    if (c[0] === 'local') { localIdxs.push(i); totalDecls++; continue }
    break
  }
  if (localIdxs.length < 2 || totalDecls <= 128) return
  let counts = precomputedCounts
  if (!counts) {
    counts = new Map()
    const visit = (n) => {
      if (!Array.isArray(n)) return
      if ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string')
        counts.set(n[1], (counts.get(n[1]) || 0) + 1)
      for (const c of n) visit(c)
    }
    for (let i = totalDecls + 2; i < fn.length; i++) visit(fn[i])
  }
  const locals = localIdxs.map(i => fn[i])
  locals.sort((a, b) => (counts.get(b[1]) || 0) - (counts.get(a[1]) || 0))
  localIdxs.forEach((i, k) => { fn[i] = locals[k] })
}

/**
 * Module-level arena rewind: transitive escape analysis.
 *
 * Per-function `applyArenaRewind` in compile.js is limited to a static whitelist
 * of internal helpers. This pass generalizes by building a call graph and
 * propagating "arena-safe callee" status via fixed-point iteration.
 *
 * A function is an arena-safe callee if:
 *   - no global.set, call_indirect, call_ref in body
 *   - all user-function calls are to other arena-safe callees
 *
 * A function is arena-rewindable (gets heap save/restore injected) if:
 *   - single scalar result (f64 or i32)
 *   - contains allocation ($__alloc / $__alloc_hdr)
 *   - no global.set, return_call, call_indirect, call_ref
 *   - all user-function calls are to arena-safe callees
 *   - does NOT return a pointer (checked via ptrTypes map from compile.js)
 *
 * Unlike the per-function pass, this does NOT require 0 params.
 *
 * @param {Array[]} fns - Array of func IR nodes (sec.funcs + sec.stdlib + sec.start)
 * @param {boolean} sharedMemory - Whether memory is shared (affects heap get/set IR)
 * @param {Map<string, {ptrKind: *}|null>} [ptrTypes] - Map from func name to ptrKind info.
 *   Functions with ptrKind != null return pointers and cannot be rewound.
 *   If omitted, no pointer-return check is done (conservative: fewer functions rewound).
 */
export function arenaRewindModule(fns) {
  const BUILTIN_SAFE = new Set([
    '$__alloc', '$__alloc_hdr', '$__alloc_hdr_n', '$__mkptr',
    '$__ptr_offset', '$__ptr_type', '$__ptr_aux',
    '$__len', '$__cap', '$__typed_shift', '$__typed_data',
  ])

  // Phase 1: collect per-function metadata
  const fnMap = new Map()
  for (const fn of fns) {
    if (!Array.isArray(fn) || fn[0] !== 'func') continue
    const name = fn[1]
    if (typeof name !== 'string') continue

    let results = [], hasGlobalSet = false, hasReturnCall = false
    let hasCallIndirect = false, hasCallRef = false, hasAlloc = false
    const calls = new Set()
    const bodyStart = findBodyStart(fn)

    for (let i = 2; i < fn.length; i++) {
      const c = fn[i]
      if (!Array.isArray(c)) continue
      if (c[0] === 'result') { results.push(c[1] || c[2]); continue }
      if (i >= bodyStart) break
    }

    const scan = node => {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === 'global.set') hasGlobalSet = true
      else if (op === 'return_call') hasReturnCall = true
      else if (op === 'call_indirect') hasCallIndirect = true
      else if (op === 'call_ref') hasCallRef = true
      else if (op === 'call') {
        const callee = node[1]
        if (callee === '$__alloc' || callee === '$__alloc_hdr' || callee === '$__alloc_hdr_n') hasAlloc = true
        if (typeof callee === 'string' && !BUILTIN_SAFE.has(callee)) calls.add(callee)
      }
      for (let i = 1; i < node.length; i++) scan(node[i])
    }
    for (let i = bodyStart; i < fn.length; i++) scan(fn[i])

    fnMap.set(name, {
      fn, results,
      hasGlobalSet, hasReturnCall, hasCallIndirect, hasCallRef, hasAlloc,
      calls: [...calls],
    })
  }

  // Phase 2: fixed-point transitive safety analysis
  const safeCallees = new Set(BUILTIN_SAFE)
  let changed = true
  while (changed) {
    changed = false
    for (const [name, info] of fnMap) {
      if (safeCallees.has(name)) continue
      if (info.hasGlobalSet || info.hasCallIndirect || info.hasCallRef) continue
      if (info.calls.every(c => safeCallees.has(c) || !fnMap.has(c))) {
        safeCallees.add(name)
        changed = true
      }
    }
  }

  return safeCallees
}
