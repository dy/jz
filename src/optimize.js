/**
 * WASM IR post-emission optimizations.
 *
 * # Stage contract
 *   IN:  WAT-as-array IR (function body or module-level).
 *   OUT: equivalent WAT-as-array IR (same semantics, smaller encoding).
 *   INVARIANTS: pure IR→IR rewrite. No ctx reads/writes. No new top-level declarations except
 *        the ones explicitly surfaced via `addGlobal` (hoistConstantPool only).
 *
 * Each pass is orthogonal. Apply order matters: structural hoists (hoistPtrType) before
 * low-level folds (foldMemargOffsets) — former may introduce locals the latter shouldn't
 * interfere with.
 *
 * Passes:
 *   foldMemargOffsets — `(load (i32.add base (i32.const N)) …)` → `(load offset=N base …)` (~2 B/site)
 *   hoistPtrType      — repeated `(call $__ptr_type X)` on same X → single local.tee + local.get reuse
 *   hoistConstantPool — frequently-repeated f64.const values → mutable globals (~7 B/reuse)
 *
 * Per-function passes run over sec.funcs + sec.stdlib + sec.start.
 * Whole-module passes see the full function list + globals map.
 *
 * @module optimize
 */

const MEMOP = /^[fi](32|64)\.(load|store)(\d+(_[su])?)?$/

/**
 * Fold constant-offset address arithmetic into memarg offset=N syntax.
 * `(load/store (i32.add base (i32.const N)) …)` → `(load/store offset=N base …)`.
 * Saves ~2 bytes per site (removes i32.add + i32.const encoding, fold into memarg).
 */
export function foldMemargOffsets(node) {
  if (!Array.isArray(node)) return
  for (const c of node) foldMemargOffsets(c)
  if (typeof node[0] !== 'string' || !MEMOP.test(node[0])) return
  if (typeof node[1] === 'string' && (node[1].startsWith('offset=') || node[1].startsWith('align='))) return
  const addr = node[1]
  if (!Array.isArray(addr) || addr[0] !== 'i32.add' || addr.length !== 3) return
  let base, offset
  const a = addr[1], b = addr[2]
  if (Array.isArray(b) && b[0] === 'i32.const' && typeof b[1] === 'number' && b[1] >= 0 && b[1] < 0x100000000) { base = a; offset = b[1] }
  else if (Array.isArray(a) && a[0] === 'i32.const' && typeof a[1] === 'number' && a[1] >= 0 && a[1] < 0x100000000) { base = b; offset = a[1] }
  if (base == null) return
  node[1] = `offset=${offset}`
  node.splice(2, 0, base)
}

/**
 * Hoist repeated `(call $__ptr_type X)` on same X into a single local.
 * First occurrence becomes `(local.tee $_pt_N (call $__ptr_type X))`;
 * subsequent become `(local.get $_pt_N)`. Adds `(local $_pt_N i32)` decl.
 *
 * Only hoists when:
 *   - X is `(local.get $Y)` — cheap to keep first call, simple mutation tracking
 *   - $Y is never written (local.set/local.tee) within the function body
 *   - group has ≥3 occurrences (break-even: 2N-5 bytes saved, positive at N≥3)
 */
export function hoistPtrType(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Pass 1: find all (call $__ptr_type X) nodes, group by X signature.
  const groups = new Map()  // x-key → { count, arg, sites: [{parent, idx}] }
  const callSites = []  // [{parent, idx, xKey}]
  const walk = (node, parent, pi) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'call' && node[1] === '$__ptr_type' && node.length === 3) {
      const arg = node[2]
      if (Array.isArray(arg) && arg[0] === 'local.get' && typeof arg[1] === 'string') {
        const xKey = arg[1]
        let g = groups.get(xKey)
        if (!g) { g = { count: 0, argLocal: xKey, sites: [] }; groups.set(xKey, g) }
        g.count++
        g.sites.push({ parent, idx: pi })
      }
    }
    for (let i = 0; i < node.length; i++) walk(node[i], node, i)
  }
  for (let i = bodyStart; i < fn.length; i++) walk(fn[i], fn, i)

  if (groups.size === 0) return

  // Pass 2: check mutation — skip if $Y is written anywhere.
  const written = new Set()
  const scanWrites = (node) => {
    if (!Array.isArray(node)) return
    if ((node[0] === 'local.set' || node[0] === 'local.tee') && typeof node[1] === 'string') written.add(node[1])
    for (const c of node) scanWrites(c)
  }
  for (let i = bodyStart; i < fn.length; i++) scanWrites(fn[i])

  // Pass 3: apply hoist for eligible groups.
  let hoistId = 0
  const locals = []
  for (const [xKey, g] of groups) {
    if (g.count < 3) continue
    if (written.has(xKey)) continue
    const tLocal = `$__pt${hoistId++}`
    locals.push(['local', tLocal, 'i32'])
    // First site: wrap in local.tee. Remaining sites: replace with local.get.
    for (let i = 0; i < g.sites.length; i++) {
      const { parent, idx } = g.sites[i]
      if (i === 0) parent[idx] = ['local.tee', tLocal, parent[idx]]
      else parent[idx] = ['local.get', tLocal]
    }
  }
  if (locals.length) fn.splice(bodyStart, 0, ...locals)
}

/**
 * Find the index of the first body-content child in a func node.
 * Skips `$name`, (export …), (import …), (type …), (param …), (result …), (local …).
 */
function findBodyStart(fn) {
  for (let i = 2; i < fn.length; i++) {
    const c = fn[i]
    if (!Array.isArray(c)) continue
    if (c[0] === 'export' || c[0] === 'import' || c[0] === 'type' || c[0] === 'param' || c[0] === 'result' || c[0] === 'local') continue
    return i
  }
  return fn.length
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
  const counts = new Map()
  const countConsts = (node) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'f64.const' && (typeof node[1] === 'number' || typeof node[1] === 'string')) {
      const k = typeof node[1] === 'number' ? `n:${node[1]}` : `s:${node[1]}`
      counts.set(k, (counts.get(k) || 0) + 1)
    }
    for (const c of node) countConsts(c)
  }
  for (const s of funcs) countConsts(s)
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
  const rewrite = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 0; i < node.length; i++) {
      const c = node[i]
      if (Array.isArray(c) && c[0] === 'f64.const') {
        const k = typeof c[1] === 'number' ? `n:${c[1]}` : `s:${c[1]}`
        const g = hoist.get(k)
        if (g) { node[i] = ['global.get', `$${g}`]; continue }
      }
      rewrite(c)
    }
  }
  for (const s of funcs) rewrite(s)
}

/**
 * Run all per-function IR optimizations on a single function node.
 * Order matters: hoistPtrType before foldMemargOffsets (former may introduce
 * new locals that shouldn't interfere with memarg folding; they don't today,
 * but keep the invariant that structural rewrites run before low-level folds).
 */
export function optimizeFunc(fn) {
  hoistPtrType(fn)
  foldMemargOffsets(fn)
}
