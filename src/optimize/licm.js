/**
 * Loop-invariant code motion family: the per-function whitelist of read-only
 * helper calls jz's own LICM trusts (SAFE_OFFSET_CALLS / READONLY_MEM_CALLS /
 * NON_MUTATING_CALLS / PURE_CALL_I32), the shared invariance/purity predicate
 * (loopInvariance, consumed by both splitLoopPrivateScratch and
 * hoistInvariantLoop), the two loop-shape hoists (splitLoopPrivateScratch,
 * hoistInvariantLoop), the f64→i32 loop-bound narrowing that feeds LICM
 * (narrowLoopBound), the entry-hoisted pointer-offset snapshot
 * (hoistInvariantPtrOffset), and straight-line scalar-load CSE (cseScalarLoad).
 *
 * @module optimize/licm
 */
import { LAYOUT } from '../ctx.js'
import { findBodyStart, buildRefcount, nextLocalId } from '../ir.js'
import { T, walkAst, stableNodeKey } from '../ast.js'

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
// Read-only i32-returning calls: safe to hoist when operands are invariant,
// and their presence in a loop must not block other hoists (hasUnsafeCall).
// __jss_* are wasm:js-string host builtins over IMMUTABLE JS strings — pure by
// the same argument as the __ptr_* helpers (charCodeAt won't itself hoist —
// its index varies — but whitelisting it keeps hasUnsafeCall false so the
// loop-invariant __jss_length in the same loop condition CAN hoist).
const SAFE_OFFSET_CALLS = new Set(['$__ptr_offset', '$__ptr_type', '$__ptr_aux', '$__len', '$__jss_length', '$__jss_charCodeAt'])

// wasm comparison-op mantissas (the part after the `.`): they yield i32 regardless of
// operand width (i64.eq, f64.lt, i32.ge_s, …). `eq`/`ne` are sign-agnostic; the ordered
// compares carry `_s`/`_u` for the integer types and none for f64. Used by resultType to
// type a hoisted subtree by its root op. A Set membership test, NOT a regex
// (`/^(eq|ne|lt|gt|le|ge)(_[su])?$/`): the regex mis-anchored under self-compile −O2 — `nearest`
// (the f64.nearest mantissa, from Math.round) starts with `ne`, and the embedded −O2 build
// matched it as a comparison → the LICM hoist local got typed i32, so `local.set $__li
// (f64.nearest …)` emitted invalid wasm (f64 into i32) only in the kernel. Explicit string
// membership is both self-compile-robust and cheaper in this LICM-hot path.
const CMP_MANTISSA = new Set([
  'eqz', 'eq', 'ne', 'lt', 'gt', 'le', 'ge',
  'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u',
])

// Calls that don't modify EXISTING heap memory: they may allocate (bump the heap
// pointer) or do tag dispatch, but they never write to an address a hoisted
// __typed_idx/__str_idx element read would revisit. Their presence must not
// block readonly-mem-call LICM (else any `s += unknown` — which dispatches via
// __is_str_key/__str_concat — would pin every invariant array element in-loop:
// the jagged-array `grid[i][j]` deopt).
// $__mkptr is pure bit-packing over its i32 args (no memory access at all) — its
// only loop-body producer is the in-place replace-store's re-boxed result, which
// otherwise pinned the loop's `__ptr_offset(arr)` base resolution in-body (the
// immutable-update kernel paid the full forwarding+bounds dance per iteration).
const NON_MUTATING_CALLS = new Set(['$__is_str_key', '$__str_concat', '$__to_num', '$__to_str', '$__str_byteLen', '$__mkptr'])

// Read-only HEAP-MEMORY calls: like SAFE_OFFSET_CALLS but they read element
// storage that a direct f64.store/i32.store in the loop could alias. Safe to
// hoist only when the loop has no mutating call AND no direct store at all (we
// can't do alias analysis at WAT level). __typed_idx/__str_idx read arr[i] /
// s[i]; plain-array element writes go through calls (caught by hasUnsafeCall),
// and typed-array writes are direct stores (caught by hasDirectStore) — so the
// guard covers both. This is what lets LICM hoist `grid[i]` out of a read-only
// `for(j) { ... grid[i][j] ... }` inner loop (the jagged-array deopt).
const READONLY_MEM_CALLS = new Set(['$__typed_idx', '$__str_idx'])

// PURE FUNCTION calls — result is a function of the ARGUMENTS alone, with no
// dependence on mutable state: math reads no memory; the string search/compare
// helpers read only their operands' bytes, and jz strings are IMMUTABLE, so their
// content can't change under the loop's stores. So on loop-invariant args the
// RESULT is loop-invariant regardless of anything else the loop does (unlike a
// READONLY_MEM_CALLS element read, which an aliasing store could invalidate — no
// !hasDirectStore guard is needed here). Speculative pre-header execution can't
// trap: math returns NaN/∞ rather than trapping, and a value reaching .indexOf/===
// is a valid string (in-bounds reads). This is the LICM V8's wasm tier won't do —
// it treats every call as opaque and recomputes the search/transcendental each
// iteration. (Math.random is INLINED — it mutates a global PRNG seed, never a
// `$math.` call — but exclude it by name defensively; $__str_eq_cold is the cold
// half of __str_eq, equally pure.) $__length stays OUT: it is polymorphic over
// MUTABLE arrays (push changes it), so it isn't arg-pure. $__str_byteLen is IN:
// its operand is a string (immutable), and the one in-place length mutator —
// the heap-top bump-extend twins (module/string.js) — is only emitted where the
// OLD string value is provably dead, so a live, loop-invariant operand's length
// cannot change under the loop (`for (j = 0; j < line.length; j++)` hoists to
// one call instead of one per character — the strbuild row-scan shape).
const PURE_CALL_I32 = new Set(['$__str_indexof', '$__str_lastindexof', '$__str_eq', '$__str_eq_cold', '$__is_str_key', '$__str_byteLen'])
const isPureFnCall = (callee) =>
  typeof callee === 'string' &&
  ((callee.startsWith('$math.') && !callee.startsWith('$math.random')) || PURE_CALL_I32.has(callee))

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

  const inspect = (node, parent, pi) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    if (op === 'local.set' || op === 'local.tee') {
      if (typeof node[1] === 'string' && params.has(node[1])) unsafe.add(node[1])
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
          return false
        }
      }
      const isSafe = SAFE_OFFSET_CALLS.has(callee)
      for (let i = 2; i < node.length; i++) {
        const arg = node[i]
        const inner = (Array.isArray(arg) && arg[0] === 'i64.reinterpret_f64' && arg.length === 2) ? arg[1] : arg
        if (Array.isArray(inner) && inner[0] === 'local.get' && typeof inner[1] === 'string' && params.has(inner[1])) {
          if (!isSafe) unsafe.add(inner[1])
        }
      }
      return
    }

    if (op === 'call_indirect' || op === 'call_ref') {
      for (let i = 1; i < node.length; i++) {
        const arg = node[i]
        if (Array.isArray(arg) && arg[0] === 'local.get' && typeof arg[1] === 'string' && params.has(arg[1])) unsafe.add(arg[1])
      }
      return
    }
  }

  for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: inspect })

  if (sites.size === 0) return

  let hoistId = nextLocalId(fn, 'po')

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


// Non-trapping, side-effect-free ops whose result is a pure function of their
// operands. Hoisting one to the pre-header is sound iff its operands are loop-
// invariant: same value every iteration, no traps, no memory/global effects.
// DELIBERATELY EXCLUDES trapping ops — i32/i64 div_s/u & rem_s/u (trap on 0),
// non-saturating trunc_f64 (trap on overflow/NaN) — because hoisting a trap to
// the pre-header would fire it even when the loop runs zero times. Loads and
// calls are NOT here; they are admitted by `pureGiven` only under the loop's
// effect-summary barriers (cell loads with no aliasing store/call; the read-only
// __ptr_* call whitelist with no other call).
// Boxed-capture cells are `freshLocal`-generated, so the name carries the T
// (U+E000) prefix: `$<T>cell_<var>`. Built from the constant — a hand-typed
// `'$cell_'` literal silently omits the invisible T and never matches.
const CELL_PREFIX = '$' + T + 'cell_'

// Ops V8's wasm tier (TurboFan) will NOT hoist out of a loop itself: saturating
// f64→int truncation and `select` are not LICM-eligible there, memory loads are
// blocked by conservative aliasing, and calls are opaque. These are the ONLY
// things worth hoisting — V8 already does general arithmetic LICM, and hoisting
// pure arithmetic ourselves only bloats the body and breaks the lane-vectorizer's
// straight-line pattern match. So a subtree is hoisted only if it contains one.
const HARD_OPS = new Set([
  'i64.trunc_sat_f64_s', 'i64.trunc_sat_f64_u', 'i32.trunc_sat_f64_s', 'i32.trunc_sat_f64_u',
  'select', 'f64.load', 'i32.load', 'call',
])
const hasHardOp = (n) => {
  let found = false
  walkAst(n, { enter: x => {
    if (found) return false
    if (HARD_OPS.has(x[0])) { found = true; return false }
  } })
  return found
}

// The inline typed-array base decode `(i32.wrap_i64 (i64.and (i64.reinterpret_f64
// (local|global X)) 0xFFFFFFFF))` — what `typedBase` emits for a NaN-boxed pointer.
// V8's wasm tier does NOT reliably LICM this i64 reinterpret chain, and it carries no
// HARD_OP, so without this it stays per-element inside the loop. It is the typed-read
// equivalent of the `__ptr_offset` call (a HARD_OP) that hoistGlobalPtrOffset hoists at
// function scope; admitting it here also covers a pointer reassigned ELSEWHERE in the
// function (the ping-pong double-buffer `a = b` in wireworld / any CA), where the base
// is invariant within each loop but not function-wide.
const isPtrBaseDecode = (n) =>
  Array.isArray(n) && n[0] === 'i32.wrap_i64' && n.length === 2 &&
  Array.isArray(n[1]) && n[1][0] === 'i64.and' && n[1].length === 3 &&
  Array.isArray(n[1][2]) && n[1][2][0] === 'i64.const' &&
  (typeof n[1][2][1] === 'string' ? Number(n[1][2][1]) : n[1][2][1]) === LAYOUT.OFFSET_MASK &&
  Array.isArray(n[1][1]) && n[1][1][0] === 'i64.reinterpret_f64' && n[1][1].length === 2 &&
  Array.isArray(n[1][1][1]) && (n[1][1][1][0] === 'local.get' || n[1][1][1][0] === 'global.get')

const PURE_LICM_OPS = new Set([
  'f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.neg', 'f64.abs', 'f64.sqrt',
  'f64.min', 'f64.max', 'f64.ceil', 'f64.floor', 'f64.trunc', 'f64.nearest', 'f64.copysign',
  'i32.add', 'i32.sub', 'i32.mul', 'i32.and', 'i32.or', 'i32.xor',
  'i32.shl', 'i32.shr_s', 'i32.shr_u', 'i32.rotl', 'i32.rotr', 'i32.clz', 'i32.ctz', 'i32.popcnt', 'i32.eqz',
  'i64.add', 'i64.sub', 'i64.mul', 'i64.and', 'i64.or', 'i64.xor',
  'i64.shl', 'i64.shr_s', 'i64.shr_u', 'i64.rotl', 'i64.rotr', 'i64.eqz',
  'f64.eq', 'f64.ne', 'f64.lt', 'f64.gt', 'f64.le', 'f64.ge',
  'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u', 'i32.gt_s', 'i32.gt_u', 'i32.le_s', 'i32.le_u', 'i32.ge_s', 'i32.ge_u',
  'i64.eq', 'i64.ne', 'i64.lt_s', 'i64.lt_u', 'i64.gt_s', 'i64.gt_u', 'i64.le_s', 'i64.le_u', 'i64.ge_s', 'i64.ge_u',
  'f64.convert_i32_s', 'f64.convert_i32_u', 'f64.convert_i64_s', 'f64.convert_i64_u',
  'i32.trunc_sat_f64_s', 'i32.trunc_sat_f64_u', 'i64.trunc_sat_f64_s', 'i64.trunc_sat_f64_u',
  'i32.wrap_i64', 'i64.extend_i32_s', 'i64.extend_i32_u',
  'f64.reinterpret_i64', 'i64.reinterpret_f64', 'f32.reinterpret_i32', 'i32.reinterpret_f32',
  'f64.promote_f32', 'f32.demote_f64', 'select',
])

// Resolve a load/store address back to the single typed-array PARAM it derives from — through
// `local.get`, the arithmetic in PURE_LICM_OPS, and single-def snap locals ($__li/$__ab) — or
// null if not exactly one / unprovable (a multi-def or unknown local in the address). Built once
// per function over the proven-distinct `distinctParams` set; the alias substrate both LICM
// passes query to hoist a read-only input load across a distinct-buffer store (raytrace's spheres
// vs framebuffer — the alias-analysis LICM rust/clang get for free).
function buildBaseParamOf(fn, bodyStart, distinctParams) {
  if (!distinctParams) return () => null
  const paramNames = new Set()
  for (let i = 2; i < bodyStart; i++)
    if (Array.isArray(fn[i]) && fn[i][0] === 'param' && typeof fn[i][1] === 'string') paramNames.add(fn[i][1])
  const singleDef = new Map(), defCount = new Map()
  const recordDef = n => {
    if (!Array.isArray(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') {
      defCount.set(n[1], (defCount.get(n[1]) || 0) + 1); singleDef.set(n[1], n[2])
    }
  }
  for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: recordDef })
  for (const [k, c] of defCount) if (c > 1) singleDef.delete(k)   // multi-def → can't trust the resolution
  return (addr) => {
    const found = new Set(); const seen = new Set(); let bad = false
    const walk = (n) => {
      if (bad || !Array.isArray(n)) return
      if (n[0] === 'local.get' && typeof n[1] === 'string') {
        if (paramNames.has(n[1])) found.add(n[1])
        else if (singleDef.has(n[1]) && !seen.has(n[1])) { seen.add(n[1]); walk(singleDef.get(n[1])) }
        else bad = true   // a written/unknown local in the address → base unprovable
        return
      }
      for (let i = 1; i < n.length; i++) walk(n[i])
    }
    walk(addr)
    return !bad && found.size === 1 ? [...found][0] : null
  }
}

// Per-loop invariance/purity analysis — the single proven predicate both LICM passes share.
// Scans the loop into an effect summary (locals/globals it writes, cells/buffers it stores to,
// whether it has any call / unsafe call / direct store / v128 op), then closes `pureGiven(node,
// bound)` over it: true iff `node` is side-effect-free AND loop-invariant, given that the locals
// in `bound` are private to the candidate (a `local.get` of a bound local reads the in-subtree
// teed invariant; a free `local.get` must be unwritten by the loop). Memory leaves are admitted
// only under the summary: a `$__cell_`/distinct-param load iff no aliasing store + no call; a
// SAFE_OFFSET/READONLY_MEM call iff no unsafe call (+ no direct store for heap reads).
function loopInvariance(loopNode, { distinctParams, baseParamOf, allowPrivateSets = false, stableHeaderNames = null }) {
  const locals = new Set(), globals = new Set(), storedCells = new Set(), storedBases = new Set()
  let hasUnsafeCall = false, hasAnyCall = false, hasDirectStore = false, hasV128 = false
  const recordEffect = node => {
    if (!Array.isArray(node)) return
    const op = node[0]
    // A vectorized loop (lane/v128 ops) is already register-tight and hand-tuned;
    // extra scalar hoisting there only adds spill pressure — keep it conservative.
    if (op.startsWith('v128.') || /^[if]\d+x\d+\./.test(op)) hasV128 = true
    if (op === 'local.set' || op === 'local.tee') { if (typeof node[1] === 'string') locals.add(node[1]) }
    else if (op === 'global.set') { if (typeof node[1] === 'string') globals.add(node[1]) }
    else if (op === 'call') {
      hasAnyCall = true
      if (!SAFE_OFFSET_CALLS.has(node[1]) && !READONLY_MEM_CALLS.has(node[1]) && !NON_MUTATING_CALLS.has(node[1]) && !isPureFnCall(node[1])) hasUnsafeCall = true
    } else if (op === 'call_ref' || op === 'call_indirect') hasAnyCall = hasUnsafeCall = true
    if ((op === 'f64.store' || op === 'i32.store') && node.length >= 3) {
      hasDirectStore = true
      const a = node[1]
      if (Array.isArray(a) && a[0] === 'local.get' && typeof a[1] === 'string' && a[1].startsWith(CELL_PREFIX)) storedCells.add(a[1])
      if (distinctParams) { const sb = baseParamOf(a); if (sb) storedBases.add(sb) }   // alias: which buffers this loop writes
    }
  }
  for (let i = 1; i < loopNode.length; i++) walkAst(loopNode[i], { enter: recordEffect })

  const pureGiven = (node, bound) => {
    if (!Array.isArray(node)) return true   // bare operand string/number
    const op = node[0]
    if (op === 'i32.const' || op === 'i64.const' || op === 'f64.const' || op === 'f32.const') return true
    if (op === 'local.get') return typeof node[1] === 'string' && (bound.has(node[1]) || !locals.has(node[1]))
    // A global is invariant only if not set directly AND no UNSAFE call in the loop —
    // an unproven callee may mutate it (no interprocedural effect analysis). SAFE_OFFSET/
    // READONLY_MEM/NON_MUTATING/pure calls are jz's own runtime helpers, audited to never
    // touch a user global, so they don't block this the way an arbitrary call does — same
    // distinction READONLY_MEM_CALLS purity already makes below. (Locals are frame-private,
    // so calls can't touch them; only direct local.set matters.)
    if (op === 'global.get') return typeof node[1] === 'string' && !globals.has(node[1]) && !hasUnsafeCall
    if (op === 'local.tee') {
      if (typeof node[1] !== 'string') return false
      // The operand is evaluated BEFORE the tee writes $X, so a `local.get $X`
      // inside it reads the loop-carried value, not the newly written one.
      const inner = bound.has(node[1]) ? new Set([...bound].filter(b => b !== node[1])) : bound
      return pureGiven(node[2], inner)
    }
    if (op === 'local.set') {
      if (!allowPrivateSets || typeof node[1] !== 'string' || !bound.has(node[1])) return false
      const inner = new Set([...bound].filter(b => b !== node[1]))
      return pureGiven(node[2], inner)
    }
    if ((op === 'f64.load' || op === 'i32.load') && node.length === 2) {
      const a = node[1]
      if (Array.isArray(a) && a[0] === 'local.get' && typeof a[1] === 'string' && a[1].startsWith(CELL_PREFIX)
        && !hasAnyCall && !storedCells.has(a[1]) && (bound.has(a[1]) || !locals.has(a[1]))) return true
      // Length-HEADER load: `i32.load(i32.sub(local.get $X, i32.const 8))` where $X is a
      // proven stable-header pointer (stableHeaderNames — VAL.TYPED or ARRAY neverGrown, see
      // the compile/index.js stamp). Unlike the cell/distinctParam admissions, this needs NO
      // alias-analysis against the loop's stores: the header word is immutable for $X's whole
      // lifetime (a typed array never resizes; a neverGrown array never relocates — no store
      // this loop could contain ever targets it), so invariance follows purely from $X's own
      // address being loop-invariant (the local.get rule just below, applied to $X itself).
      if (op === 'i32.load' && stableHeaderNames && Array.isArray(a) && a[0] === 'i32.sub' && a.length === 3 &&
          Array.isArray(a[1]) && a[1][0] === 'local.get' && typeof a[1][1] === 'string' && stableHeaderNames.has(a[1][1]) &&
          Array.isArray(a[2]) && a[2][0] === 'i32.const' && Number(a[2][1]) === 8 &&
          pureGiven(a[1], bound)) return true
      // Alias-analysis LICM: a load from a typed-array param PROVEN distinct from every buffer
      // this loop writes (base ∉ storedBases) is loop-invariant when its address is invariant —
      // even across the loop's stores, because they can't alias it. This is what lets rust/clang
      // hoist read-only input arrays out of a write loop (raytrace's spheres vs the framebuffer).
      // `pureGiven(a, bound)` proves the address itself invariant (base param unwritten + invariant
      // offset); the calls guard rules out callee memory mutation.
      if (distinctParams && !hasAnyCall) {
        const base = baseParamOf(a)
        if (base && distinctParams.has(base) && !storedBases.has(base) && pureGiven(a, bound)) return true
      }
      return false
    }
    if (op === 'call') {
      // Pure-function call: invariant iff its ARGS are. No effect-summary barrier —
      // its result depends on nothing the loop can mutate (math: no memory; string
      // search/compare: immutable operands), so neither a store nor another call
      // can invalidate it. This hoists the loop-invariant transcendental / substr
      // search V8's wasm tier recomputes every iteration.
      if (isPureFnCall(node[1]))
        return node.slice(2).every(c => pureGiven(c, bound))
      if (SAFE_OFFSET_CALLS.has(node[1]))
        return !hasUnsafeCall && node.slice(2).every(c => pureGiven(c, bound))
      // Read-only heap reads: additionally require no direct store (alias-safe).
      if (READONLY_MEM_CALLS.has(node[1]))
        return !hasUnsafeCall && !hasDirectStore && node.slice(2).every(c => pureGiven(c, bound))
      return false
    }
    // A value-producing block with private scratch sets is pure when every
    // statement is pure. This is the canonical-NaN wrapper shape emitted for
    // `const ox = -typed[i]`: block(result f64, set tmp, select …). The caller's
    // bound/private-use proof is what makes moving the internal set sound.
    if (op === 'block' && allowPrivateSets) {
      for (let i = 1; i < node.length; i++) {
        const c = node[i]
        if (!Array.isArray(c) || c[0] === 'result') continue
        if (!pureGiven(c, bound)) return false
      }
      return true
    }
    // A value-producing `if` whose condition and both arms are pure is itself
    // pure — the tag-dispatch idiom `(if (result f64) tag-check (then read-A)
    // (else read-B))` that wraps __typed_idx/__str_idx element access.
    if (op === 'if') {
      for (let i = 1; i < node.length; i++) {
        const c = node[i]
        if (!Array.isArray(c)) continue
        if (c[0] === 'result') continue
        if (c[0] === 'then' || c[0] === 'else') { if (!c.slice(1).every(x => pureGiven(x, bound))) return false }
        else if (!pureGiven(c, bound)) return false   // the condition
      }
      return true
    }
    if (PURE_LICM_OPS.has(op)) return node.slice(1).every(c => pureGiven(c, bound))
    return false
  }
  return { pureGiven, locals, globals, storedCells, storedBases, hasUnsafeCall, hasAnyCall, hasDirectStore, hasV128 }
}

/**
 * Unified loop-invariant code motion. One principle replaces the three former
 * pattern hoists (ToInt32 / __ptr_offset / cell-load): a MAXIMAL pure subtree
 * whose every free input is loop-invariant is computed once before the loop, in
 * a fresh snap local.
 *
 * Invariance/purity (`pureGiven`) is closed over PURE_LICM_OPS plus two memory-
 * touching leaves admitted only under the loop's effect summary (`collectMutations`):
 *   - (f64.load (local.get $cell_X))   iff no f64.store to $cell_X and no call in loop
 *   - (call $__ptr_offset|__ptr_type|__ptr_aux|__len …)  iff no non-whitelisted call
 * — exactly the old per-pass barriers, generalized. A subtree may also WRITE a
 * local via (local.tee P E) iff P is private to the subtree (occurs nowhere else
 * in the loop); this hoists the guarded-ToInt32 form
 *   (select (i32.wrap_i64 (i64.trunc_sat_f64_s (local.tee P E))) 0 (f64.ne (get P) G))
 * as a unit — which the old leaf-only matcher could not (it needed a bare local).
 *
 * Bottom-up (inner loops first → progressive climbing), refcount-guarded against
 * watr's shared CSE subtrees, snaps spliced before the loop, decls at bodyStart.
 * Idempotent: re-running sees only `(local.get $__liN)` and finds nothing to do.
 */
// SSA-split loop-private straight-line multi-def scratch so the LICM below can hoist
// the invariant versions. jz's unroller MERGES each unrolled iteration's `const x`
// into one multi-def local (e.g. raytrace's sphere loop unrolls 8× sharing $ox/$c),
// which the LICM cannot hoist — so the per-sphere invariant `c_i = sx_i²+sy_i²+sz_i²
// −sr_i²` recomputes every pixel instead of once (the 1.24× rust-wasm gap; rust/LLVM
// keeps them as distinct SSA values and hoists each). Renaming each def to its own
// version makes them single-def → hoistInvariantLoop lifts the loop-invariant ones.
//
// BIT-EXACT: pure renaming + invariant code motion — the same value computed fewer
// times, no reassociation. Gated to loops with NO v128, so it never disturbs a
// vectorized loop (whose unrolled shared names the lane/dot vectorizer relies on).
//
// SOUND only for a local that, within the loop body, (a) is referenced NOWHERE else in
// the function (loop-local lifetime — else a post-loop read of the merged name breaks),
// (b) has every occurrence STRAIGHT-LINE (never under a nested if/block/loop, so a
// linear walk assigns each use its unique dominating def), (c) is first accessed by a
// WRITE (no value carried across the back-edge), (d) is only ever `local.set` (never
// `local.tee`/conditionally defined). Each condition rejects a class that would miscompile.
export function splitLoopPrivateScratch(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const SCALAR = new Set(['i32', 'i64', 'f64', 'f32'])
  const UNROLLED_PREFIXES = [`$${T}ul`, `$${T}us`]
  const isUnrolledScratch = name => UNROLLED_PREFIXES.some(p => name.startsWith(p))
  const localTypes = new Map()
  let hasUnrolledScratch = false
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (Array.isArray(c) && (c[0] === 'param' || c[0] === 'local') && typeof c[1] === 'string') {
      localTypes.set(c[1], c[2])
      if (isUnrolledScratch(c[1])) hasUnrolledScratch = true
    }
  }
  // Demand-driven: ordinary functions retain the allocation-free optimizer
  // path. Only loops expanded by the AST/emitter unrollers mint these names.
  if (!hasUnrolledScratch) return
  // Whole-function reference count per local (to verify a candidate is loop-local).
  const fnRefs = new Map()
  const countRefs = n => {
    if ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string')
      fnRefs.set(n[1], (fnRefs.get(n[1]) || 0) + 1)
  }
  for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: countRefs })
  // Same proven alias substrate hoistInvariantLoop uses (re-attached after watOptimize, so it
  // survives into this 'post' pass) — lets pureGiven prove a read-only input-array load distinct
  // from the loop's output store, the SOUND replacement for the old address-local-disjointness
  // heuristic (which assumed two loads/stores in different locals never alias — false in general).
  const distinctParams = fn.distinctParams || null
  const baseParamOf = buildBaseParamOf(fn, bodyStart, distinctParams)

  const hasV128 = (n) => {
    let f = false
    walkAst(n, { enter: x => {
      if (f) return false
      const o = x[0]
      if (typeof o === 'string' && (o.startsWith('v128') || /x(2|4|8|16)\b/.test(o) || o.includes('x2.') || o.includes('x4.') || o.includes('x8.') || o.includes('x16.'))) { f = true; return false }
    } })
    return f
  }
  let minted = 0
  const newDecls = []

  const processLoop = (loop, parent, idx) => {
    if (loop[0] !== 'loop' || hasV128(loop)) return
    // Candidate names: locals set somewhere directly in the loop's statement list.
    const seen = new Set()
    for (let i = 2; i < loop.length; i++) {
      const s = loop[i]
      if (Array.isArray(s) && s[0] === 'local.set' && typeof s[1] === 'string' && isUnrolledScratch(s[1])) seen.add(s[1])
    }
    // Stage 1 — collect SAFE candidates (loop-local, straight-line, first-write, set-only,
    // ≥2 defs) and record each one's def RHS list for the invariance fixpoint.
    const cand = new Map()  // name → { defs: [rhs…] }
    for (const name of seen) {
      if (!SCALAR.has(localTypes.get(name))) continue
      let inLoop = 0
      walkAst(loop, { enter: n => { if ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === name) inLoop++ } })
      if (inLoop !== (fnRefs.get(name) || 0)) continue
      let safe = true, first = null, defs = []
      const scan = (n, depth) => {
        if (!safe || !Array.isArray(n)) return
        const op = n[0]
        if (op === 'local.tee' && n[1] === name) { safe = false; return }
        if (op === 'local.set' && n[1] === name) {
          if (depth > 0) { safe = false; return }
          if (first === null) first = 'w'
          defs.push(n[2])
          scan(n[2], depth)
          return
        }
        if (op === 'local.get' && n[1] === name) {
          if (depth > 0) { safe = false; return }
          if (first === null) first = 'r'
          return
        }
        const ctrl = op === 'if' || op === 'then' || op === 'else' || op === 'block' || op === 'loop'
        for (let i = 1; i < n.length; i++) scan(n[i], depth + (ctrl ? 1 : 0))
      }
      for (let i = 2; i < loop.length; i++) scan(loop[i], 0)
      if (safe && first === 'w' && defs.length >= 1) cand.set(name, defs)
    }
    if (!cand.size) return
    // Stage 2 — invariance fixpoint over the SHARED proven predicate. `pureGiven(def, hoistable)`
    // decides loop-invariance with hoistInvariantLoop's exact model: a `$__cell_`/distinct-param
    // read-only load is invariant across the loop's stores (sound alias analysis), a global is
    // invariant only without a loop write or call, and the `bound` set (here `hoistable`) carries
    // the cascade — a def reading an already-split sibling is invariant once that sibling moves out
    // (c = ox²+… invariant only after ox hoists). `motionSafe` adds the one extra obligation a
    // whole-assignment MOTION needs beyond value-invariance: no `local.tee` writing a local read
    // elsewhere (pureGiven already rejects set/store/global.set/unsafe-call). This replaces the old
    // address-local-disjointness load test, which was unsound in general (two distinct locals can
    // hold the same address) and only worked by luck on the bench shapes.
    const { pureGiven } = loopInvariance(loop, { distinctParams, baseParamOf, allowPrivateSets: true })
    const motionSafe = (n) => {
      let hasTee = false
      walkAst(n, { enter: x => { if (hasTee) return false; if (x[0] === 'local.tee') { hasTee = true; return false } } })
      return !hasTee
    }
    const countName = (n, name) => {
      let c = 0
      walkAst(n, { enter: x => { if ((x[0] === 'local.get' || x[0] === 'local.set' || x[0] === 'local.tee') && x[1] === name) c++ } })
      return c
    }
    const privateInternalWrites = (def, base) => {
      const bound = new Set(base), writes = new Set()
      const gather = n => { if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') writes.add(n[1]) }
      walkAst(def, { enter: gather })
      for (const name of writes) {
        if (countName(loop, name) !== countName(def, name)) return null
        bound.add(name)
      }
      return bound
    }
    const hoistable = new Set()
    let changed = true
    while (changed) {
      changed = false
      for (const [name, defs] of cand) {
        if (hoistable.has(name)) continue
        if (defs.every(d => {
          const bound = privateInternalWrites(d, hoistable)
          return bound && motionSafe(d) && pureGiven(d, bound)
        })) { hoistable.add(name); changed = true }
      }
    }
    // Stage 3 — one linear pass over the loop body: each hoistable def is RENAMED to a
    // fresh version and MOVED OUT of the loop (before it), in source order so the cascade's
    // data deps stay intact (c = ox²+… emitted after ox). The cheap arithmetic AND the load
    // both leave the loop; gets stay, rebound to the moved version. (hoistInvariantLoop only
    // snapshots expensive subexprs, not whole invariant assignments — so we do the motion.)
    const curOf = new Map()
    const rewriteGets = (n) => {
      if (!Array.isArray(n)) return n
      if (n[0] === 'local.get' && curOf.has(n[1])) return ['local.get', curOf.get(n[1])]
      return n.map((c, i) => i === 0 ? c : rewriteGets(c))
    }
    const hoisted = []
    const kept = loop.slice(0, 2)  // 'loop' + label
    for (let i = 2; i < loop.length; i++) {
      const s = loop[i]
      if (Array.isArray(s) && s[0] === 'local.set' && hoistable.has(s[1])) {
        const name = s[1], ty = localTypes.get(name)
        const nv = `$${name.replace(/^\$/, '')}__sr${minted++}`
        newDecls.push(['local', nv, ty]); localTypes.set(nv, ty)
        hoisted.push(['local.set', nv, rewriteGets(s[2])])
        curOf.set(name, nv)
      } else {
        kept.push(rewriteGets(s))
      }
    }
    loop.length = 0
    for (const x of kept) loop.push(x)
    parent.splice(idx, 0, ...hoisted)
  }
  const walk = (parent, idx) => {
    const n = parent[idx]
    if (!Array.isArray(n)) return
    // Recurse first so an inner loop's hoists land before we process the outer loop.
    for (let i = 1; i < n.length; i++) walk(n, i)
    if (n[0] === 'loop') processLoop(n, parent, idx)
  }
  for (let i = bodyStart; i < fn.length; i++) walk(fn, i)
  if (newDecls.length) fn.splice(bodyStart, 0, ...newDecls)
}

export function hoistInvariantLoop(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Cheap early-out: no loop ⇒ nothing to hoist (skip the buildRefcount walk).
  let hasLoop = false
  const findLoop = { enter: n => {
    if (!Array.isArray(n) || hasLoop) return false
    if (n[0] === 'loop') { hasLoop = true; return false }
  } }
  for (let i = bodyStart; i < fn.length && !hasLoop; i++) walkAst(fn[i], findLoop)
  if (!hasLoop) return

  // Result wasm type of a hoistable node (for the snap local decl). null ⇒ can't
  // type it ⇒ don't hoist. Param/local types come from the func header.
  const localTypes = new Map()
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (Array.isArray(c) && (c[0] === 'param' || c[0] === 'local') && typeof c[1] === 'string') localTypes.set(c[1], c[2])
  }
  const resultType = (node) => {
    if (!Array.isArray(node)) return null
    const op = node[0]
    if (op === 'select') return resultType(node[1])
    if (op === 'if') {
      // (if (result T) cond (then ...) (else ...)) — type is the result clause.
      for (let i = 1; i < node.length; i++) {
        const c = node[i]
        if (Array.isArray(c) && c[0] === 'result') return c[1]
      }
      return null
    }
    if (op === 'block') {
      for (let i = 1; i < node.length; i++) {
        const c = node[i]
        if (Array.isArray(c) && c[0] === 'result') return c[1]
      }
      return null
    }
    if (op === 'call') {
      // SAFE_OFFSET_CALLS all return i32; READONLY_MEM_CALLS return f64 (NaN-boxed element)
      if (SAFE_OFFSET_CALLS.has(node[1])) return 'i32'
      if (READONLY_MEM_CALLS.has(node[1])) return 'f64'
      if (PURE_CALL_I32.has(node[1])) return 'i32'        // string search/compare → i32
      if (typeof node[1] === 'string' && node[1].startsWith('$math.')) return 'f64'   // transcendentals → f64
      return null
    }
    if (op === 'local.get' || op === 'local.tee') return localTypes.get(node[1]) ?? null
    const dot = op.indexOf('.')
    if (dot < 0) return null
    // Comparisons and `eqz` yield i32 regardless of operand type (i64.eq, f64.lt,
    // i64.eqz, …) — so the operand-type prefix would mistype them. Catch first.
    const m = op.slice(dot + 1)
    if (CMP_MANTISSA.has(m)) return 'i32'
    const p = op.slice(0, dot)
    if (p === 'i32' || p === 'i64' || p === 'f64' || p === 'f32') return p
    return null
  }

  // Collision-proof snap ids: skip EVERY existing $__li id, not just start at the
  // lowest free one. watr can renumber/coalesce locals between the pre- and
  // post-watr optimize phases, leaving a non-contiguous $__li set; a lowest-free +
  // sequential-increment scheme would then re-issue an in-use id (Duplicate local).
  const usedLi = new Set()
  walkAst(fn, { enter: n => {
    if (!Array.isArray(n)) return
    if (n[0] === 'local' && typeof n[1] === 'string' && n[1].startsWith('$__li')) {
      const t = n[1].slice(5); if (/^\d+$/.test(t)) usedLi.add(+t)
    }
  } })
  let snapCounter = 0
  const freshSnap = () => { while (usedLi.has(snapCounter)) snapCounter++; const id = snapCounter++; usedLi.add(id); return `$__li${id}` }
  const newLocals = []
  const refcount = buildRefcount(fn)

  // Alias-analysis substrate for hoisting typed-array PARAM element loads across distinct-base
  // stores. `distinctParams` (stamped by compile/index.js from the param-distinctness pass) is the
  // set of typed-array params PROVEN to be mutually-distinct buffers at every call site. To use it,
  // resolve a load/store address back to the single param it derives from — through `local.get`,
  // `i32.add/sub`, and single-def snap locals ($__li/$__ab from prior ptr-offset hoisting).
  const distinctParams = fn.distinctParams || null
  const baseParamOf = buildBaseParamOf(fn, bodyStart, distinctParams)
  // Stable-header pointer names (compile/index.js stamp) — see loopInvariance's
  // i32.load admission for the length-HEADER hoist this enables.
  const stableHeaderNames = fn.stableHeaderNames || null

  const processLoop = (loopNode, nested) => {
    // Inner loops first (bottom-up) — an inner hoist creates a local.get the
    // outer level can hoist further. Children run in a nested context.
    for (let i = 1; i < loopNode.length; i++)
      if (Array.isArray(loopNode[i])) processNode(loopNode[i], loopNode, i, true)

    // The loop's effect summary + the proven invariance/purity predicate (shared with
    // splitLoopPrivateScratch — see loopInvariance). `locals` is the loop's whole write-set.
    const { pureGiven, locals, hasV128 } = loopInvariance(loopNode, { distinctParams, baseParamOf, stableHeaderNames })

    // Per-subtree local-occurrence counts and write-sets, memoized bottom-up —
    // the tee-privacy check queries them for EVERY candidate node, and the old
    // per-query re-walk (countIn/gatherBound) was quadratic on watr-scale loop
    // bodies (the single largest compile-time hotspot, ~200ms/compile). All
    // queries happen during `collect`, before any splice mutates the loop, so
    // the memo cannot go stale; it is dropped with this processLoop frame.
    const countsMemo = new Map()  // node → Map(local → occurrences in subtree)
    const writesMemoL = new Map() // node → Set(locals written in subtree)
    const EMPTY_COUNTS = new Map(), EMPTY_WRITES = new Set()
    const countsOf = (node) => {
      if (!Array.isArray(node)) return EMPTY_COUNTS
      let m = countsMemo.get(node)
      if (m) return m
      m = new Map()
      const op = node[0]
      if ((op === 'local.get' || op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string')
        m.set(node[1], 1)
      for (let i = 1; i < node.length; i++)
        for (const [k, v] of countsOf(node[i])) m.set(k, (m.get(k) || 0) + v)
      countsMemo.set(node, m)
      return m
    }
    const writesIn = (node) => {
      if (!Array.isArray(node)) return EMPTY_WRITES
      let s = writesMemoL.get(node)
      if (s) return s
      s = new Set()
      if ((node[0] === 'local.set' || node[0] === 'local.tee') && typeof node[1] === 'string') s.add(node[1])
      for (let i = 1; i < node.length; i++) for (const w of writesIn(node[i])) s.add(w)
      writesMemoL.set(node, s)
      return s
    }
    // Whole-loop counts (the former countLocals walk) — one memoized query.
    const localCount = new Map()
    for (let i = 1; i < loopNode.length; i++)
      for (const [k, v] of countsOf(loopNode[i])) localCount.set(k, (localCount.get(k) || 0) + v)

    const isHoistable = (node) => {
      if (!Array.isArray(node)) return false
      const op = node[0]
      // Skip trivial leaves: hoisting a bare get/const buys nothing.
      if (op === 'local.get' || op === 'global.get' || op === 'i32.const' || op === 'i64.const' || op === 'f64.const' || op === 'f32.const') return false
      const bound = writesIn(node)
      // Every local the subtree writes must be private to it (no other use in the
      // loop) — else moving the write to the pre-header changes another reader.
      for (const b of bound) if (localCount.get(b) !== countsOf(node).get(b)) return false
      // Top-level loops: only hoist what V8's wasm tier won't — a HARD_OP or the
      // inline typed-array base decode — and leave plain pure arithmetic to V8's own
      // LICM (which handles single-level loops well). NESTED (inner) loops are
      // different: V8's wasm tier under-hoists invariants out of them (a nested
      // rasterizer/convolution recomputes triangle/row-invariant subexpressions every
      // iteration), so hoist any pure-invariant subtree there. Soundness is unchanged —
      // `pureGiven` already proves the subtree is loop-invariant and side-effect-free.
      return ((nested && !hasV128) || hasHardOp(node) || isPtrBaseDecode(node)) && pureGiven(node, bound)
    }

    // Maximal extraction: take the largest hoistable subtree; don't descend into
    // it. Dedup structurally so a repeated invariant expr shares one snap local.
    const sites = new Map()  // structural key → [{ parent, idx, node }]
    const collect = (node, parent, idx) => {
      if (!parent) return
      if (node[0] === 'loop') return false  // already processed bottom-up
      if (isHoistable(node) && (refcount.get(node) || 0) <= 1 && (refcount.get(parent) || 0) <= 1) {
        // stableNodeKey: hoistable boxed-pointer subtrees carry i64.const NaN-box
        // prefixes (BigInt) that plain JSON.stringify can't serialize, and it also
        // collapses Infinity/-Infinity/NaN→null & -0→0 — both would dedup distinct
        // invariants. (A replacer-based stringify was silently replacer-less
        // in-kernel — the recursive keyer behaves identically host and kernel.)
        const key = stableNodeKey(node)
        let arr = sites.get(key); if (!arr) { arr = []; sites.set(key, arr) }
        arr.push({ parent, idx, node })
        return false
      }
    }
    walkAst(loopNode, { enter: collect })

    const snaps = []
    for (const [, arr] of sites) {
      const type = resultType(arr[0].node)
      if (type == null) continue
      const snapName = freshSnap()
      newLocals.push(['local', snapName, type])
      snaps.push(['local.set', snapName, arr[0].node])  // reuse first node verbatim
      for (const { parent, idx } of arr) parent[idx] = ['local.get', snapName]
    }
    return snaps
  }

  const processNode = (node, parent, idx, nested = false) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'loop') {
      const snaps = processLoop(node, nested)
      if (snaps.length) parent.splice(idx, 0, ...snaps)
      return
    }
    for (let i = 0; i < node.length; i++) processNode(node[i], node, i, nested)
  }

  for (let i = bodyStart; i < fn.length; i++) processNode(fn[i], fn, i, false)
  if (newLocals.length) fn.splice(bodyStart, 0, ...newLocals)
}

/**
 * Narrow an f64 loop bound to i32. `for (let i = 0; i < n; i++)` with an f64
 * param `n` emits `(f64.lt (f64.convert_i32_s $i) (local.get $n))` — an f64
 * convert+compare every iteration that ALSO blocks the lane-vectorizer (it
 * requires an i32-governed trip count). The naive-DSP export shape
 * `(ptr, n) => { for (i = 0; i < n; i++) … }` therefore never vectorized
 * without a hand-written `n|0`. This pass is that annotation, as a proof.
 *
 * When $i is a proven-non-negative i32 counter and $n is loop-invariant:
 *   convert_i32_s(i) < n  ⟺  i < trunc_sat(ceil(n))      for all i ≥ 0
 *   - fractional n rounds up (i < 5.5 ⟺ i < 6); integral n exact
 *   - NaN: ceil→NaN, trunc_sat→0 ⇒ `i < 0` false — matches the false f64 compare
 *     (THIS case is why i ≥ 0 must be proven: a negative i would flip it true)
 *   - n ≤ −2³¹ saturates to INT32_MIN ⇒ always false — matches
 *   - n ≥ 2³¹ saturates to INT32_MAX ⇒ terminates after 2³¹−1 iterations where
 *     the original wrapped $i negative and spun forever — the only divergence,
 *     pathological in both versions (a JS double counter would keep counting).
 * Non-negativity proof: $i is a non-param i32 local whose EVERY write in the
 * function (counters get re-zeroed between loops) is a non-negative i32.const
 * or `$i + positive-const`. Wrap-around past 2³¹ needs 2³¹ agreeing iterations
 * first, so trajectories are identical in every non-pathological program.
 *
 * Snap `(local.set $__lbK (i32.trunc_sat_f64_s (f64.ceil (local.get $n))))`
 * goes in the loop pre-header (re-snapped per outer iteration when nested —
 * trunc_sat/ceil are total, safe even for zero-trip loops); the compare becomes
 * `(i32.lt_s $i $__lbK)` — the exact shape the lane-vectorizer matches.
 * Bottom-up, refcount-guarded, idempotent (rewritten conds no longer match).
 */
export function narrowLoopBound(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Cheap early-out: no loop ⇒ nothing to narrow.
  let hasLoop = false
  const findLoop = { enter: n => {
    if (!Array.isArray(n) || hasLoop) return false
    if (n[0] === 'loop') { hasLoop = true; return false }
  } }
  for (let i = bodyStart; i < fn.length && !hasLoop; i++) walkAst(fn[i], findLoop)
  if (!hasLoop) return

  // Header types. Params are excluded as counters: their init is caller-supplied,
  // so non-negativity is unprovable.
  const localTypes = new Map(), params = new Set()
  for (let i = 2; i < bodyStart; i++) {
    const c = fn[i]
    if (!Array.isArray(c) || typeof c[1] !== 'string') continue
    if (c[0] === 'param') params.add(c[1])
    if (c[0] === 'param' || c[0] === 'local') localTypes.set(c[1], c[2])
  }

  // Every write per local across the WHOLE function — not just in-loop: a counter
  // reused by a later loop is re-zeroed between them, and a negative write
  // anywhere voids the proof.
  const writes = new Map()
  const collectWrites = n => {
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') {
      let arr = writes.get(n[1]); if (!arr) writes.set(n[1], arr = [])
      arr.push(n[2])
    }
  }
  for (let i = bodyStart; i < fn.length; i++) walkAst(fn[i], { enter: collectWrites })

  const constVal = (n) => Array.isArray(n) && n[0] === 'i32.const' ? Number(n[1]) : NaN
  const nonNegCounter = (name) => {
    if (params.has(name) || localTypes.get(name) !== 'i32') return false
    const ws = writes.get(name)
    if (!ws) return true  // never written ⇒ stays at default 0
    return ws.every(v => {
      if (!Array.isArray(v)) return false
      if (v[0] === 'i32.const') return Number(v[1]) >= 0
      if (v[0] !== 'i32.add') return false
      if (Array.isArray(v[1]) && v[1][0] === 'local.get' && v[1][1] === name) return constVal(v[2]) > 0
      if (Array.isArray(v[2]) && v[2][0] === 'local.get' && v[2][1] === name) return constVal(v[1]) > 0
      return false
    })
  }

  // Collision-proof snap ids (same scheme as hoistInvariantLoop's $__li).
  const usedLb = new Set()
  walkAst(fn, { enter: n => {
    if (!Array.isArray(n)) return
    if (n[0] === 'local' && typeof n[1] === 'string' && n[1].startsWith('$__lb')) {
      const t = n[1].slice(5); if (/^\d+$/.test(t)) usedLb.add(+t)
    }
  } })
  let lbCounter = 0
  const freshLb = () => { while (usedLb.has(lbCounter)) lbCounter++; const id = lbCounter++; usedLb.add(id); return `$__lb${id}` }
  const newLocals = []
  const refcount = buildRefcount(fn)

  // `i <  bound` as `(f64.lt (convert i) bound)` or mirrored `(f64.gt bound (convert i))`.
  // `i <= bound` as `(f64.le (convert i) bound)` or mirrored `(f64.ge bound (convert i))`.
  const match = (n) => {
    const lt = n[0] === 'f64.lt', gt = n[0] === 'f64.gt', le = n[0] === 'f64.le', ge = n[0] === 'f64.ge'
    const conv = lt || le ? n[1] : gt || ge ? n[2] : null
    const bnd = lt || le ? n[2] : gt || ge ? n[1] : null
    if (!Array.isArray(conv) || conv[0] !== 'f64.convert_i32_s') return null
    const ig = conv[1]
    if (!Array.isArray(ig) || ig[0] !== 'local.get' || typeof ig[1] !== 'string') return null
    if (!Array.isArray(bnd) || bnd[0] !== 'local.get' || typeof bnd[1] !== 'string') return null
    return { ctr: ig[1], bound: bnd[1], op: le || ge ? 'le' : 'lt' }
  }

  const processLoop = (loopNode) => {
    // Inner loops first — their sites belong to their own pre-header (the bound
    // may be written by THIS loop between inner runs).
    for (let i = 1; i < loopNode.length; i++)
      if (Array.isArray(loopNode[i])) processNode(loopNode[i], loopNode, i)

    // Locals written anywhere in this loop (incl. nested) — bound invariance.
    const written = new Set()
    const recordWrite = n => {
      if (Array.isArray(n) && (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') written.add(n[1])
    }
    for (let i = 1; i < loopNode.length; i++) walkAst(loopNode[i], { enter: recordWrite })

    const sites = []
    const collect = (node, parent) => {
      if (!parent) return
      if (node[0] === 'loop') return false  // already processed bottom-up
      const m = match(node)
      if (m && (refcount.get(node) || 0) <= 1
            && localTypes.get(m.bound) === 'f64' && !written.has(m.bound)
            && nonNegCounter(m.ctr)) { sites.push({ node, m }); return false }
    }
    walkAst(loopNode, { enter: collect })

    // One snap per distinct (bound, op): `i < n` and `i <= n` of the SAME bound
    // need different snapped i32 values (ceil vs floor).
    const snapFor = new Map()
    const snaps = []
    const I32_MIN = -2147483648
    for (const { node, m } of sites) {
      const key = `${m.bound}|${m.op}`
      let snap = snapFor.get(key)
      if (!snap) {
        snap = freshLb()
        snapFor.set(key, snap)
        newLocals.push(['local', snap, 'i32'])
        // `i < n`  ⟺ `i < ceil(n)`: trunc_sat(NaN)=0 makes `i<0` false — matches `i<NaN`;
        //   ±Inf → I32_MAX/I32_MIN, both correct. NaN-safe for free.
        // `i <= n` ⟺ `i <= floor(n)`, BUT trunc_sat(floor(NaN))=0 would make `i<=0` run
        //   one iteration at i=0, while JS (`i<=NaN` is false) runs zero. Guard the NaN
        //   case to I32_MIN (below any non-negative counter ⇒ zero iterations). ±Inf are
        //   already correct (floor(+Inf)→I32_MAX, floor(-Inf)→I32_MIN; Inf==Inf is true).
        snaps.push(['local.set', snap, m.op === 'le'
          ? ['select',
              ['i32.trunc_sat_f64_s', ['f64.floor', ['local.get', m.bound]]],
              ['i32.const', I32_MIN],
              ['f64.eq', ['local.get', m.bound], ['local.get', m.bound]]]
          : ['i32.trunc_sat_f64_s', ['f64.ceil', ['local.get', m.bound]]]])
      }
      node.length = 3
      node[0] = m.op === 'le' ? 'i32.le_s' : 'i32.lt_s'
      node[1] = ['local.get', m.ctr]; node[2] = ['local.get', snap]
    }
    return snaps
  }

  const processNode = (node, parent, idx) => {
    if (!Array.isArray(node)) return
    // Break-block idiom `(block $brk (loop …))`: snaps go BEFORE the block —
    // any statement between the block label and the loop is "foreign content"
    // to the lane-vectorizer's matcher and would defeat the whole point.
    if (node[0] === 'block' && typeof node[1] === 'string' && node.length === 3
        && Array.isArray(node[2]) && node[2][0] === 'loop') {
      const snaps = processLoop(node[2])
      if (snaps.length) parent.splice(idx, 0, ...snaps)
      return
    }
    if (node[0] === 'loop') {
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
 * CSE for `(f64.load offset=K (local.get $X))` over straight-line regions
 * where $X is an i32-typed local (an unboxed pointer in jz's value model).
 *
 * Aos hot path: `let p = rows[i]; xs[i] = p.x + p.y*0.25 + r;
 *                ys[i] = p.y - p.z*0.5;
 *                zs[i] = p.z + p.x*0.125`
 * — emits 6 f64.load on $p (each of x/y/z twice); collapses to 3 unique loads
 * shared via tee'd snap locals.
 *
 * Safety: candidacy is the emit-side `cseSafeLoadBases` whitelist (src/analyze.js),
 * stamped onto the func node as `fn.cseLoadBases`. Every base in it is a
 * bound-once unboxed pointer used solely as a member-read receiver whose
 * allocation kind is disjoint from every store the function performs. So
 * `(f64.store ADDR ...)` anywhere in the body cannot touch addresses reachable
 * via `$X + K` for a whitelisted $X — the proof is carried from emit, where the
 * VAL kinds and binding shapes are still known, never re-guessed at WAT level.
 *
 * Region boundaries that flush the table:
 *   - branch (br/br_if/br_table/return/unreachable)
 *   - non-pure call
 *   - loop / if  (control flow)
 *   - local.set/local.tee on a tracked $X (invalidates that X's entries)
 *   - store whose address tree references a tracked $X (defence-in-depth —
 *     the whitelist already guarantees this never happens)
 * Blocks are treated as transparent — recurse into children.
 */
export function cseScalarLoad(fn) {
  if (!Array.isArray(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return

  // Soundness gate: only the emit-proven non-aliasing bases. Absent the stamp
  // (e.g. a post-watrOptimize re-run on rebuilt nodes) the set is empty and the
  // pass is a strict no-op — never a speculative CSE.
  const bases = fn.cseLoadBases
  if (!(bases instanceof Set) || bases.size === 0) return

  let snapId = nextLocalId(fn, 'cs')
  const newLocals = []

  // CSE table: key `${X}|${K}` → { snapName | null, anchorParent, anchorIdx }
  const table = new Map()

  const invalidateLocal = (X) => {
    for (const key of table.keys()) {
      if (key.startsWith(`${X}|`)) table.delete(key)
    }
  }

  // Scan a node's subtree and return the set of tracked bases referenced via local.get.
  const collectGets = (node, out) => {
    walkAst(node, { enter: n => {
      if (n[0] === 'local.get' && typeof n[1] === 'string' && bases.has(n[1])) { out.add(n[1]); return false }
    } })
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
      // Recurse with a cleared table, then clear after (the compound may have
      // written). SIBLING ARMS ARE EXCLUSIVE PATHS: a CSE anchor minted in the
      // then-arm does not dominate the else-arm — an entry surviving into the
      // sibling reads a $__cs local that was never set on this path (wrong
      // value, or the zero-init). Each then/else arm gets its own fresh table.
      table.clear()
      for (let i = 1; i < node.length; i++) {
        if (Array.isArray(node[i]) && (node[i][0] === 'then' || node[i][0] === 'else')) table.clear()
        walk(node[i], node, i)
      }
      table.clear()
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
      if (Array.isArray(addr) && addr[0] === 'local.get' && typeof addr[1] === 'string' && bases.has(addr[1])) {
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
