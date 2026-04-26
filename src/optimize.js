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
 *   specializeMkptr   — `(call $__mkptr (i32.const T) (i32.const A) X)` → per-combo specialized helper (~4 B/site)
 *   hoistConstantPool — frequently-repeated f64.const values → mutable globals (~7 B/reuse)
 *
 * Per-function passes run over sec.funcs + sec.stdlib + sec.start.
 * Whole-module passes see the full function list + globals map.
 *
 * @module optimize
 */

const MEMOP = /^[fi](32|64)\.(load|store)(\d+(_[su])?)?$/
const NAN_PREFIX_BITS = 0x7FF8n

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
 *
 * Safety: __ptr_type extracts type tag bits, which never change for a given
 * NaN-boxed f64. Caching is always safe when the source local isn't reassigned.
 * (Contrast __ptr_offset, which has a forwarding loop for ARRAY — caching its
 * result is unsafe across realloc, so it isn't hoisted here.)
 */
export function hoistPtrType(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  const groups = new Map()
  const walk = (node, parent, pi) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'call' && node[1] === '$__ptr_type' && node.length === 3) {
      const arg = node[2]
      if (Array.isArray(arg) && arg[0] === 'local.get' && typeof arg[1] === 'string') {
        const xKey = arg[1]
        let g = groups.get(xKey)
        if (!g) { g = { count: 0, sites: [] }; groups.set(xKey, g) }
        g.count++
        g.sites.push({ parent, idx: pi })
      }
    }
    for (let i = 0; i < node.length; i++) walk(node[i], node, i)
  }
  for (let i = bodyStart; i < fn.length; i++) walk(fn[i], fn, i)

  if (groups.size === 0) return

  const written = new Set()
  const scanWrites = (node) => {
    if (!Array.isArray(node)) return
    if ((node[0] === 'local.set' || node[0] === 'local.tee') && typeof node[1] === 'string') written.add(node[1])
    for (const c of node) scanWrites(c)
  }
  for (let i = bodyStart; i < fn.length; i++) scanWrites(fn[i])

  let hoistId = 0
  const locals = []
  for (const [xKey, g] of groups) {
    if (g.count < 3) continue
    if (written.has(xKey)) continue
    const tLocal = `$__pt${hoistId++}`
    locals.push(['local', tLocal, 'i32'])
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
    '$__alloc_hdr': { params: ['i32', 'i32', 'i32'], result: 'i32' },
    '$__typed_idx': { params: ['f64', 'i32'],        result: 'f64' },
    '$__str_idx':   { params: ['f64', 'i32'],        result: 'f64' },
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

  // Pass 1: count per (target, sig). Key separator `##` won't appear in sig content.
  const counts = new Map()  // 'target##sig' → count
  const walk = (node) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'call' && typeof node[1] === 'string' && SPECS[node[1]]) {
      const spec = SPECS[node[1]]
      if (node.length === 2 + spec.params.length) {
        const k = sigKey(node, spec.params.length)
        if (k) counts.set(node[1] + '##' + k, (counts.get(node[1] + '##' + k) || 0) + 1)
      }
    }
    for (const c of node) walk(c)
  }
  for (const fn of funcs) walk(fn)

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
      const tmpl = (NAN_PREFIX_BITS << 48n)
        | ((BigInt(type) & 0xFn) << 47n)
        | ((BigInt(aux) & 0x7FFFn) << 32n)
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

  // Pass 3: rewrite call sites bottom-up (nested calls: rewrite inner before outer).
  const rewrite = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 0; i < node.length; i++) rewrite(node[i])
    for (let i = 0; i < node.length; i++) {
      const c = node[i]
      if (!Array.isArray(c) || c[0] !== 'call' || typeof c[1] !== 'string') continue
      const spec = SPECS[c[1]]
      if (!spec || c.length !== 2 + spec.params.length) continue
      const k = sigKey(c, spec.params.length)
      if (!k || !specialized.has(c[1] + '##' + k)) continue
      const parts = k.split('|')

      // $__mkptr fully literal (rare — mkPtrIR usually folds these ahead of us, but defensive):
      if (c[1] === '$__mkptr' && parts.every(p => p.startsWith('L:'))) {
        const type = +parts[0].slice(2), aux = +parts[1].slice(2), off = +parts[2].slice(2)
        const bits = (NAN_PREFIX_BITS << 48n)
          | ((BigInt(type) & 0xFn) << 47n)
          | ((BigInt(aux) & 0x7FFFn) << 32n)
          | (BigInt(off >>> 0) & 0xFFFFFFFFn)
        const n = ['f64.const', 'nan:0x' + bits.toString(16).toUpperCase().padStart(16, '0')]
        n.type = 'f64'
        node[i] = n
        continue
      }

      const name = variantName(c[1], parts)
      const dynArgs = []
      for (let j = 0; j < parts.length; j++) if (parts[j] === 'D') dynArgs.push(c[2 + j])
      const newCall = ['call', '$' + name, ...dynArgs]
      newCall.type = spec.result
      node[i] = newCall
    }
  }
  for (const fn of funcs) rewrite(fn)
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

  // Pass 1: count (targetFunc, baseGlobal) pairs. Track result-type via any func whose name we recognize.
  const counts = new Map()  // 'F##G' → count
  const walk = (node) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'call' && typeof node[1] === 'string' && node.length === 3) {
      const arg = node[2]
      if (Array.isArray(arg) && arg[0] === 'i32.add' && arg.length === 3 &&
          Array.isArray(arg[1]) && arg[1][0] === 'global.get' && typeof arg[1][1] === 'string' &&
          Array.isArray(arg[2]) && arg[2][0] === 'i32.const') {
        const k = node[1] + '##' + arg[1][1]
        counts.set(k, (counts.get(k) || 0) + 1)
      }
    }
    for (const c of node) walk(c)
  }
  for (const fn of funcs) walk(fn)

  const specialized = new Set()
  for (const [k, n] of counts) if (n >= MIN_USES) specialized.add(k)
  if (!specialized.size) return

  // Find a target func's result-type by locating its decl among `funcs`.
  const funcByName = new Map()
  for (const fn of funcs) if (Array.isArray(fn) && fn[0] === 'func' && typeof fn[1] === 'string')
    funcByName.set(fn[1], fn)
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

  // Pass 3: rewrite sites bottom-up.
  const rewrite = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 0; i < node.length; i++) rewrite(node[i])
    for (let i = 0; i < node.length; i++) {
      const c = node[i]
      if (!Array.isArray(c) || c[0] !== 'call' || typeof c[1] !== 'string' || c.length !== 3) continue
      const arg = c[2]
      if (!Array.isArray(arg) || arg[0] !== 'i32.add' || arg.length !== 3) continue
      const gbase = arg[1], konst = arg[2]
      if (!Array.isArray(gbase) || gbase[0] !== 'global.get' || typeof gbase[1] !== 'string') continue
      if (!Array.isArray(konst) || konst[0] !== 'i32.const') continue
      const key = c[1] + '##' + gbase[1]
      if (!specialized.has(key)) continue
      const newCall = ['call', variantFor(c[1], gbase[1]), konst]
      newCall.type = resultOf(c[1])
      node[i] = newCall
    }
  }
  for (const fn of funcs) rewrite(fn)
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

  const freq = new Map()
  const walk = (n) => {
    if (!Array.isArray(n)) return
    const o = getOff(n)
    if (o !== null) freq.set(o, (freq.get(o) || 0) + 1)
    for (const c of n) walk(c)
  }
  for (const fn of funcs) walk(fn)
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

  // Rebuild pool; map old → new offsets.
  const remap = new Map()
  let newPool = ''
  for (const e of entries) {
    newPool += String.fromCharCode(e.len & 0xFF, (e.len >> 8) & 0xFF, (e.len >> 16) & 0xFF, (e.len >> 24) & 0xFF)
    remap.set(e.oldOff, newPool.length)
    newPool += e.str
  }
  strPoolRef.pool = newPool
  if (strDedupMap)
    for (const [str, oldOff] of strDedupMap) {
      const newOff = remap.get(oldOff)
      if (newOff !== undefined) strDedupMap.set(str, newOff)
    }

  // Rewrite refs.
  const rewrite = (n) => {
    if (!Array.isArray(n)) return
    for (const c of n) rewrite(c)
    const o = getOff(n)
    if (o !== null) { const newO = remap.get(o); if (newO !== undefined) setOff(n, newO) }
  }
  for (const fn of funcs) rewrite(fn)
}

/**
 * Collapse rebox-then-unbox round-trips left by emit.js.
 *
 * The NaN-box rebox/unbox boundary emits patterns like:
 *   `(i32.wrap_i64 (i64.reinterpret_f64 (f64.reinterpret_i64 (i64.or PREFIX (i64.extend_i32_u X)))))`
 * that reduce to just `X` when PREFIX has zero low-32 bits (NaN header only).
 *
 * Folds applied (bottom-up, to fixed point within one call):
 *   `i64.reinterpret_f64 (f64.reinterpret_i64 X)`              → `X`
 *   `f64.reinterpret_i64 (i64.reinterpret_f64 X)`              → `X`
 *   `i32.wrap_i64 (i64.extend_i32_u X)`                        → `X`
 *   `i32.wrap_i64 (i64.extend_i32_s X)`                        → `X`
 *   `i32.wrap_i64 (i64.or (i64.const K) (i64.extend_i32_u X))` → `X` when (K & 0xFFFFFFFF) === 0
 *   `i32.wrap_i64 (i64.or (i64.extend_i32_u X) (i64.const K))` → `X` when (K & 0xFFFFFFFF) === 0
 *
 * The recursive walk handles nested patterns — an outer fold often unlocks
 * an inner one after the intermediate layer is removed.
 */
export function peepholeFolds(node) {
  if (!Array.isArray(node)) return node
  // Fold children first so outer patterns see already-simplified inputs.
  for (let i = 0; i < node.length; i++) {
    const c = node[i]
    if (Array.isArray(c)) node[i] = peepholeFolds(c)
  }

  const op = node[0]
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
    // i32.wrap_i64 (i64.or (i64.const HIGH_ONLY) (i64.extend_i32_u X)) → X
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
  return node
}

/**
 * Inline tiny pointer-decode helpers — `$__ptr_type`, `$__ptr_aux` — directly at call sites.
 * Each is 3-4 ops of bit extraction; inlining eliminates WASM call dispatch overhead and
 * lets V8 CSE redundant work (common-subexpression elimination across sites sharing the
 * same pointer local). Binary grows a few hundred KB but runtime drops measurably.
 *
 * Skipped inside `$__ptr_*` stdlib bodies (self-reference + keeps helpers intact in case
 * any reflexive site still needs the call form).
 */
export function inlinePtrType(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const name = typeof fn[1] === 'string' ? fn[1] : null
  if (name && (name.startsWith('$__ptr_') || name === '$__is_nullish' || name === '$__is_truthy' || name === '$__is_null')) return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const rewrite = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 0; i < node.length; i++) {
      const c = node[i]
      if (!Array.isArray(c)) continue
      if (c[0] === 'call' && c.length === 3) {
        if (c[1] === '$__ptr_type') {
          node[i] = ['i32.and',
            ['i32.wrap_i64', ['i64.shr_u', ['i64.reinterpret_f64', c[2]], ['i64.const', 47]]],
            ['i32.const', 0xF]]
          continue
        }
        if (c[1] === '$__ptr_aux') {
          node[i] = ['i32.and',
            ['i32.wrap_i64', ['i64.shr_u', ['i64.reinterpret_f64', c[2]], ['i64.const', 32]]],
            ['i32.const', 0x7FFF]]
          continue
        }
        if (c[1] === '$__is_nullish' && Array.isArray(c[2]) && c[2][0] === 'local.get') {
          // Only inline on local.get — for other exprs the helper evaluates once,
          // inline would duplicate or need a tee. local.get is cheap to reference twice.
          node[i] = ['i32.or',
            ['i64.eq', ['i64.reinterpret_f64', c[2]], ['i64.const', '0x7FF8000100000000']],
            ['i64.eq', ['i64.reinterpret_f64', c[2]], ['i64.const', '0x7FF8000000000001']]]
          continue
        }
        if (c[1] === '$__is_null') {
          // One op: reinterpret + compare. Always inline.
          node[i] = ['i64.eq', ['i64.reinterpret_f64', c[2]], ['i64.const', '0x7FF8000100000000']]
          continue
        }
        // __is_truthy on a simple local.get arg: inline the two-branch test.
        // V8 CSEs the repeated local.get / reinterpret; the explicit shape lets
        // it specialize by profiled NaN-vs-numeric bias.
        if (c[1] === '$__is_truthy' && Array.isArray(c[2]) && c[2][0] === 'local.get') {
          const lget = c[2]
          const bits = ['i64.reinterpret_f64', lget]
          node[i] = ['if', ['result', 'i32'],
            ['f64.eq', lget, lget],
            ['then', ['f64.ne', lget, ['f64.const', 0]]],
            ['else', ['i32.and',
              ['i32.and',
                ['i64.ne', bits, ['i64.const', '0x7FF8000000000000']],
                ['i64.ne', bits, ['i64.const', '0x7FF8000100000000']]],
              ['i32.and',
                ['i64.ne', bits, ['i64.const', '0x7FF8000000000001']],
                ['i64.ne', bits, ['i64.const', '0x7FFA800000000000']]]]]]
          continue
        }
      }
      rewrite(c)
    }
  }
  for (let i = bodyStart; i < fn.length; i++) rewrite(fn[i])
}

/**
 * Run all per-function IR optimizations on a single function node.
 * Order matters: hoistPtrType before foldMemargOffsets (former may introduce
 * new locals that shouldn't interfere with memarg folding; they don't today,
 * but keep the invariant that structural rewrites run before low-level folds).
 * peepholeFolds runs first to collapse rebox/unbox round-trips before
 * downstream passes (hoistPtrType, memarg fold) try to analyze those patterns.
 */
export function optimizeFunc(fn) {
  if (Array.isArray(fn)) {
    for (let i = 0; i < fn.length; i++) {
      const c = fn[i]
      if (Array.isArray(c)) fn[i] = peepholeFolds(c)
    }
  }
  hoistPtrType(fn)
  inlinePtrType(fn)
  foldMemargOffsets(fn)
  sortLocalsByUse(fn)
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
 */
export function treeshake(funcSections, allModuleNodes) {
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

  const CALL_OPS = new Set(['call', 'return_call', 'ref.func'])
  const visitCalls = (node) => {
    if (!Array.isArray(node)) return
    if (CALL_OPS.has(node[0]) && typeof node[1] === 'string') addRoot(node[1])
    for (const c of node) visitCalls(c)
  }
  // Anonymous funcs can't be pruned (no name) — walk them to seed roots.
  for (const fn of allFuncs) if (typeof fn[1] !== 'string') visitCalls(fn)
  while (stack.length) visitCalls(funcByName.get(stack.pop()))

  let removed = 0
  for (const { arr } of funcSections) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const n = arr[i]
      if (Array.isArray(n) && n[0] === 'func' && typeof n[1] === 'string' && !reachable.has(n[1])) {
        arr.splice(i, 1); removed++
      }
    }
  }
  return removed
}

/**
 * Reorder non-param local decls by reference count (hot locals first).
 * WASM `local.get/set/tee` encode local idx as ULEB128 — 1 B for idx < 128, else 2 B.
 * Only the decl order changes; refs by name are unchanged and re-resolved by watr.
 * Params are fixed (their slot defines the call ABI) — only `(local …)` nodes move.
 */
export function sortLocalsByUse(fn) {
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
  const counts = new Map()
  const visit = (n) => {
    if (!Array.isArray(n)) return
    if ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string')
      counts.set(n[1], (counts.get(n[1]) || 0) + 1)
    for (const c of n) visit(c)
  }
  for (let i = totalDecls + 2; i < fn.length; i++) visit(fn[i])
  const locals = localIdxs.map(i => fn[i])
  locals.sort((a, b) => (counts.get(b[1]) || 0) - (counts.get(a[1]) || 0))
  localIdxs.forEach((i, k) => { fn[i] = locals[k] })
}
