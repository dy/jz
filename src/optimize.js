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

const MEMOP = /^[fi](32|64)\.(load|store)(\d+(_[su])?)?$/
const NAN_PREFIX_BITS = 0x7FF8n

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
      if (Array.isArray(arg) && arg[0] === 'local.get' && typeof arg[1] === 'string') {
        const x = arg[1]
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
  // Single walk: count occurrences AND record each f64.const site for direct rewrite.
  // Avoids a second full-AST traversal in the rewrite phase.
  const counts = new Map()
  const sites = []  // { parent, idx, key }
  const walk = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 0; i < node.length; i++) {
      const c = node[i]
      if (Array.isArray(c) && c[0] === 'f64.const' && (typeof c[1] === 'number' || typeof c[1] === 'string')) {
        const k = typeof c[1] === 'number' ? `n:${c[1]}` : `s:${c[1]}`
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
      const bits = (NAN_PREFIX_BITS << 48n)
        | ((BigInt(type) & 0xFn) << 47n)
        | ((BigInt(aux) & 0x7FFFn) << 32n)
        | (BigInt(off >>> 0) & 0xFFFFFFFFn)
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
 */
export function optimizeFunc(fn) {
  hoistPtrType(fn)
  const counts = new Map()
  fusedRewrite(fn, counts)
  sortLocalsByUse(fn, counts)
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
      ['i32.wrap_i64', ['i64.shr_u', ['i64.reinterpret_f64', node[2]], ['i64.const', 47]]],
      ['i32.const', 0xF]]
    if (fname === '$__ptr_aux') return ['i32.and',
      ['i32.wrap_i64', ['i64.shr_u', ['i64.reinterpret_f64', node[2]], ['i64.const', 32]]],
      ['i32.const', 0x7FFF]]
    if (fname === '$__is_null') return ['i64.eq', ['i64.reinterpret_f64', node[2]], ['i64.const', '0x7FF8000100000000']]
    if (fname === '$__is_nullish' && Array.isArray(node[2]) && node[2][0] === 'local.get') return ['i32.or',
      ['i64.eq', ['i64.reinterpret_f64', node[2]], ['i64.const', '0x7FF8000100000000']],
      ['i64.eq', ['i64.reinterpret_f64', node[2]], ['i64.const', '0x7FF8000000000001']]]
    if (fname === '$__is_truthy' && Array.isArray(node[2]) && node[2][0] === 'local.get') {
      const lget = node[2]
      const bits = ['i64.reinterpret_f64', lget]
      return ['if', ['result', 'i32'],
        ['f64.eq', lget, lget],
        ['then', ['f64.ne', lget, ['f64.const', 0]]],
        ['else', ['i32.and',
          ['i32.and',
            ['i64.ne', bits, ['i64.const', '0x7FF8000000000000']],
            ['i64.ne', bits, ['i64.const', '0x7FF8000100000000']]],
          ['i32.and',
            ['i64.ne', bits, ['i64.const', '0x7FF8000000000001']],
            ['i64.ne', bits, ['i64.const', '0x7FFA800000000000']]]]]]
    }
  }

  // Peephole: rebox/unbox round-trips
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
  for (const { arr } of funcSections) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const n = arr[i]
      if (Array.isArray(n) && n[0] === 'func' && typeof n[1] === 'string' && !reachable.has(n[1])) {
        arr.splice(i, 1); removed++
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
