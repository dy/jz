/**
 * Region-tracking CSE for the two pointer/address hoists that share one
 * skeleton: `hoistPtrType` (repeated `__ptr_type X` tag extracts) and
 * `hoistAddrBase` (repeated `base + idx<<K` typed-array subscript addresses).
 *
 * @module optimize/cse-address
 */
import { findBodyStart, nextLocalId } from '../ir.js'

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
  return regionTrackCSE(fn, {
    matchSite(node) {
      // (call $__ptr_type (i64.reinterpret_f64 (local.get X))) — key is X, dep is X.
      if (node[0] !== 'call' || node[1] !== '$__ptr_type' || node.length !== 3) return null
      const arg = node[2]
      const inner = (Array.isArray(arg) && arg[0] === 'i64.reinterpret_f64' && arg.length === 2) ? arg[1] : arg
      if (!Array.isArray(inner) || inner[0] !== 'local.get' || typeof inner[1] !== 'string') return null
      const x = inner[1]
      return { key: x, deps: [x] }
    },
    localPrefix: 'pt',
    localType: 'i32',
  })
}

/** Region-tracking CSE skeleton shared by hoistPtrType and hoistAddrBase.
 *  Walks `fn`, accumulating "regions" — sequences of structurally-identical
 *  sites along straight-line control flow where the site's value is invariant
 *  (no writes to its dependent locals between sites). Per region with ≥2 sites,
 *  allocates one `$__<prefix><id>` local and rewrites the first site to
 *  `local.tee` and the rest to `local.get`.
 *
 *  Control-flow semantics:
 *    - `local.set/tee X` closes every region whose dep set includes X.
 *    - `if`/`else` arms walk independently from the if-entry open set; after
 *      the if, a region is open iff it was open on BOTH arms (same region ref).
 *    - `loop` clears open before AND after — back edges may skip the original tee.
 *    - `block` / func body — sequential walk.
 *
 *  `matchSite(node, parent, pi)` returns `{ key, deps }` for a CSE-able site
 *  (key is a stable string; deps lists locals whose writes invalidate this key)
 *  or null. Match-arm sites don't recurse into children. */
function regionTrackCSE(fn, { matchSite, localPrefix, localType }) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Per key: array of regions; each region is array of {parent, idx, role: 'tee'|'get'}.
  const regions = new Map()
  // Currently-open region per key. Presence ⇔ alive.
  const open = new Map()
  // local-name → keys depending on it (so `local.set X` closes all dependent keys).
  const localToKeys = new Map()

  const addDep = (name, key) => {
    let s = localToKeys.get(name)
    if (!s) { s = new Set(); localToKeys.set(name, s) }
    s.add(key)
  }
  const closeForLocal = (name) => {
    const s = localToKeys.get(name)
    if (!s) return
    for (const k of s) open.delete(k)
    localToKeys.delete(name)
  }

  const walk = (node, parent, pi) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    const m = matchSite(node, parent, pi)
    if (m) {
      let region = open.get(m.key)
      if (!region) {
        region = []
        let regs = regions.get(m.key)
        if (!regs) { regs = []; regions.set(m.key, regs) }
        regs.push(region)
        open.set(m.key, region)
        for (const d of m.deps) addDep(d, m.key)
        region.push({ parent, idx: pi, role: 'tee' })
      } else {
        region.push({ parent, idx: pi, role: 'get' })
      }
      return  // children are local.gets — they're reads, not interesting
    }

    if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string') {
      const x = node[1]
      // Walk value first — it may contain a site referencing pre-write X.
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
      // Merge: alive after if iff alive on BOTH paths with same region ref.
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

  // Commit: ≥2 sites per region to be worthwhile (a singleton is pure cost).
  let hoistId = nextLocalId(fn, localPrefix)
  const locals = []
  for (const [, regs] of regions) {
    let usable = false
    for (const r of regs) if (r.length >= 2) { usable = true; break }
    if (!usable) continue
    const tLocal = `$__${localPrefix}${hoistId++}`
    locals.push(['local', tLocal, localType])
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
// Pure i32 ops whose value is a function of locals/consts alone — no memory read,
// no call, no global. A subscript expression built only from these is invariant
// between two sites as long as none of its local deps is rewritten between them,
// so CSE-ing the WHOLE address (base + shl(idx)) is value-safe — even when `idx`
// is a compound stencil offset like `(i32.sub (i32.add idx W) 1)` for `arr[idx+W-1]`.
const PURE_I32_ADDR_OPS = new Set([
  'i32.add', 'i32.sub', 'i32.mul', 'i32.shl', 'i32.shr_s', 'i32.shr_u',
  'i32.and', 'i32.or', 'i32.xor', 'i32.wrap_i64',
])
// Serialize a pure-i32 subscript to a stable key, accumulating its local deps.
// Returns null if any leaf isn't a local.get / i32.const / pure-i32 op (a load,
// call, or global.get could change between sites — not CSE-safe by local tracking).
function pureI32AddrKey(node, deps) {
  if (!Array.isArray(node)) return null
  const op = node[0]
  if (op === 'local.get' && typeof node[1] === 'string') { deps.add(node[1]); return `$${node[1]}` }
  if (op === 'i32.const' && typeof node[1] === 'number') return `#${node[1]}`
  if (!PURE_I32_ADDR_OPS.has(op)) return null
  let key = op + '('
  for (let i = 1; i < node.length; i++) {
    const sub = pureI32AddrKey(node[i], deps)
    if (sub == null) return null
    key += sub + ','
  }
  return key + ')'
}

export function hoistAddrBase(fn) {
  return regionTrackCSE(fn, {
    matchSite(node) {
      if (node[0] !== 'i32.add' || node.length !== 3) return null
      const a = node[1], b = node[2]
      // Two orderings: (add (get A) (shl IDX (const K))) or (add (shl …) (get A))
      let baseGet, shlNode
      if (Array.isArray(a) && a[0] === 'local.get' && typeof a[1] === 'string' &&
          Array.isArray(b) && b[0] === 'i32.shl' && b.length === 3) {
        baseGet = a; shlNode = b
      } else if (Array.isArray(b) && b[0] === 'local.get' && typeof b[1] === 'string' &&
                 Array.isArray(a) && a[0] === 'i32.shl' && a.length === 3) {
        baseGet = b; shlNode = a
      } else return null
      const idx = shlNode[1], shamt = shlNode[2]
      if (!Array.isArray(shamt) || shamt[0] !== 'i32.const' || typeof shamt[1] !== 'number') return null
      // idx may be a plain `local.get` (the original biquad case) or any compound
      // pure-i32 subscript (stencil neighbour `arr[idx+W-1]`); both CSE the same way.
      const deps = new Set([baseGet[1]])
      const idxKey = pureI32AddrKey(idx, deps)
      if (idxKey == null) return null
      return { key: `${baseGet[1]}|${idxKey}|${shamt[1]}`, deps: [...deps] }
    },
    localPrefix: 'ab',
    localType: 'i32',
  })
}
