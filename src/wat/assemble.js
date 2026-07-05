/**
 * Module assembly — WAT section construction, optimization, and finalization.
 *
 * # Stage contract
 *   IN:  per-function WAT IR (from emit), ctx state (includes, scope, closure, etc.)
 *   OUT: assembled module sections via the `sec` object, mutated in place.
 *
 * Extracted from compile.js to separate "per-function compilation" from
 * "module assembly" concerns. All functions receive `sec` (the named-slots
 * section accumulator) and read/write ctx state as needed.
 *
 * @module assemble
 */

import parseWat from 'watr/parse'
import { ctx, inc, resolveIncludes, err, PTR, LAYOUT, HEAP, declGlobal } from '../ctx.js'

// Stdlib WAT templates are fixed text (or feature-keyed text from a factory) —
// `parseWat` of the same string always yields the same tree. Parsing is the
// dominant cost when a program pulls heavy stdlib (Math pow/sqrt, JSON, regex):
// it re-tokenizes ~KB of text every compile. Parse once per distinct resolved
// string, then hand out a deep clone (downstream passes mutate nodes in place).
// Module-level on purpose: the cache persists across compile() calls.
let stdlibParseCache = new Map()  // resolved WAT string → pristine parsed tree
const cloneTemplate = (node) => {
  if (!Array.isArray(node)) return node
  const copy = node.map(cloneTemplate)
  if (node.loc != null) copy.loc = node.loc
  return copy
}
const parseTemplate = (str) => {
  let tmpl = stdlibParseCache.get(str)
  if (tmpl === undefined) stdlibParseCache.set(str, tmpl = parseWat(str))
  return cloneTemplate(tmpl)
}
// Self-host-only: see clearDollar (src/ir.js) — same dangling-arena-pointer hazard,
// and the same fix: swap in a fresh Map, don't just `.clear()` the old one (its
// backing table is itself an arena allocation `_clear` invalidates). Must run every
// compile in a warm-instance loop (see scripts/self.js setupSelf).
export const clearStdlibParseCache = () => { stdlibParseCache = new Map() }
import { T } from '../ast.js'
import { analyzeValTypes, analyzeBody } from '../compile/analyze.js'
import { VAL } from '../reps.js'
import { optimizeFunc, collectVolatileGlobals, collectReachableGlobalWrites, hoistGlobalPtrOffset, stablePtrGlobalNames, hoistConstantPool, specializeMkptr, specializePtrBase, sortStrPoolByFreq, arenaRewindModule, buildPureFuncMap, inlinePureFnsInFn } from '../optimize/index.js'
import { emit, emitVoid } from '../compile/emit.js'
import { mkPtrIR, MAX_CLOSURE_ARITY, MEM_OPS, findBodyStart } from '../ir.js'
import { installHelperCounters, instrumentHelperCounter } from '../helper-counters.js'

// NaN-prefix top-13-bits as BigInt — used by the static-prefix-strip pass
const NAN_PREFIX = BigInt(LAYOUT.NAN_PREFIX)
const TAG_MASK_BIG = BigInt(LAYOUT.TAG_MASK)
const OFFSET_MASK_BIG = BigInt(LAYOUT.OFFSET_MASK)
const TAG_SHIFT_BIG = BigInt(LAYOUT.TAG_SHIFT)
const AUX_SHIFT_BIG = BigInt(LAYOUT.AUX_SHIFT)
const SSO_BIT_BIG = BigInt(LAYOUT.SSO_BIT)

// memory[HEAP.PTR_ADDR] holds the heap pointer only for shared memory (wasm globals are
// per-instance — see module/core.js comment). Non-shared memory uses $__heap.
const heapUsesMem = () => ctx.memory.shared

const heapGetIR = () => heapUsesMem()
  ? ['i32.load', ['i32.const', HEAP.PTR_ADDR]]
  : ['global.get', '$__heap']

const heapSetIR = value => heapUsesMem()
  ? ['i32.store', ['i32.const', HEAP.PTR_ADDR], value]
  : ['global.set', '$__heap', value]

const ARENA_SAFE_CALLS = new Set([
  '$__alloc', '$__alloc_hdr', '$__alloc_hdr_n', '$__mkptr',
  '$__ptr_offset', '$__ptr_type', '$__ptr_aux',
  '$__len', '$__cap', '$__typed_shift', '$__typed_data',
])

function applyArenaRewind(func, fn, safeCallees) {
  if (ctx.transform.optimize?.arenaRewind === false) return false
  if (func.raw || func.sig.params.length !== 0 || func.sig.results.length !== 1) return false
  if (func.sig.ptrKind != null) return false
  if (func.sig.results[0] === 'f64' && func.valResult !== VAL.NUMBER) return false
  if (func.sig.results[0] !== 'f64' && func.sig.results[0] !== 'i32') return false

  const bodyStart = findBodyStart(fn)
  let hasAlloc = false
  let unsafe = false
  const scan = node => {
    if (unsafe || !Array.isArray(node)) return
    const op = node[0]
    if (op === 'global.set' || op === 'return_call' || op === 'call_indirect' || op === 'call_ref') {
      unsafe = true
      return
    }
    if (op === 'call') {
      const name = node[1]
      if (name === '$__alloc' || name === '$__alloc_hdr' || name === '$__alloc_hdr_n') hasAlloc = true
      if (!(safeCallees ?? ARENA_SAFE_CALLS).has(name)) {
        unsafe = true
        return
      }
    }
    for (let i = 1; i < node.length; i++) scan(node[i])
  }
  for (let i = bodyStart; i < fn.length; i++) scan(fn[i])
  if (unsafe || !hasAlloc) return false

  let id = 0
  const hasLocal = name => fn.some(n => Array.isArray(n) && n[0] === 'local' && n[1] === name)
  while (hasLocal(`$${T}heap_save${id}`) || hasLocal(`$${T}arena_ret${id}`)) id++
  const save = `$${T}heap_save${id}`
  const ret = `$${T}arena_ret${id}`
  const restore = () => heapSetIR(['local.get', save])
  const resultType = func.sig.results[0]

  const rewriteReturns = node => {
    if (!Array.isArray(node)) return node
    if (node[0] === 'return' && node.length > 1) {
      return ['block',
        ['result', resultType],
        ['local.set', ret, node[1]],
        restore(),
        ['return', ['local.get', ret]],
        ['unreachable']]
    }
    for (let i = 1; i < node.length; i++) node[i] = rewriteReturns(node[i])
    return node
  }

  const endsWithReturn = fn.at(-1)?.[0] === 'return' || fn.at(-1)?.[0] === 'return_call'
  for (let i = bodyStart; i < fn.length; i++) fn[i] = rewriteReturns(fn[i])
  const newBodyStart = findBodyStart(fn)
  fn.splice(newBodyStart, 0,
    ['local', save, 'i32'],
    ['local', ret, resultType],
    ['local.set', save, heapGetIR()])
  if (!endsWithReturn) {
    const last = fn.pop()
    fn.push(['local.set', ret, last], restore(), ['local.get', ret])
  }
  return true
}

export function buildStartFn(ast, sec, closureFuncs, compilePendingClosures) {
  ctx.func.locals = new Map()
  ctx.func.localReps = null
  ctx.func.boxed = new Map()
  ctx.func.cellTypes = new Set()
  ctx.func.stack = []
  ctx.func.current = { params: [], results: [] }
  // Reserve prepare-generated temp names (for-of `arrVar`/`idx`/`len`,
  // destructure scratch, …) in the __start frame so emit's temp()/tempI32()
  // skip them — the same pre-seed analyzeFuncForEmit gives every function frame.
  // Only T-sentinel names: they're always __start locals (user module-scope
  // bindings become globals and can't contain T). Without this, prepare's
  // `${T}arr${n}` collides with an emit-time tempI32('arr') at the same uniq,
  // declaring the array pointer's local i32 and corrupting it via convert_i32_s.
  const seedGeneratedLocals = (body) => {
    for (const [n, t] of analyzeBody(body).locals)
      if (n.includes(T) && !ctx.func.locals.has(n)) ctx.func.locals.set(n, t)
  }
  analyzeValTypes(ast)
  const normalizeIR = ir => !ir?.length ? [] : Array.isArray(ir[0]) ? ir : [ir]

  // Mark module-scope emission: top-level statements run exactly once, so a constant
  // array/object literal here is a single instance that can safely live in a static
  // data segment (no per-call freshness to violate). Function bodies — compiled
  // separately, and the late closures below — leave this unset and alloc fresh.
  ctx.func.atModuleScope = true
  const moduleInits = []
  if (ctx.module.moduleInits) {
    for (const mi of ctx.module.moduleInits) {
      analyzeValTypes(mi)
      seedGeneratedLocals(mi)
      moduleInits.push(...normalizeIR(emit(mi)))
    }
  }
  seedGeneratedLocals(ast)
  // __start has no result: emit the top-level program in void context so a stray
  // value is dropped. `ast` is normally a `;` statement-sequence (each statement
  // already void-dropped), but jzify unwraps a single-statement program to its
  // bare expression — emitting that in value context leaves a value on the stack
  // and the start function fails validation. emitVoid handles both shapes.
  const init = emitVoid(ast)
  ctx.func.atModuleScope = false

  // Module-scope object literals can create closure bodies while `emit(ast)`
  // runs. Those late closures may pull in stdlib helpers (notably JSON.parse)
  // that affect __start setup, so flush them before deciding which runtime
  // tables __start must initialize. Restore the start-function context after
  // compiling closure bodies; emitClosureBody owns ctx.func.* while it runs.
  const beforeLateClosures = closureFuncs.length
  const startCtx = {
    locals: ctx.func.locals,
    localReps: ctx.func.localReps,
    boxed: ctx.func.boxed,
    stack: ctx.func.stack,
    current: ctx.func.current,
    body: ctx.func.body,
    directClosures: ctx.func.directClosures,
    preboxed: ctx.func.preboxed,
    localProps: ctx.func.localProps,
    uniq: ctx.func.uniq,
    refinements: ctx.func.refinements,
  }
  compilePendingClosures()
  Object.assign(ctx.func, startCtx)

  const boxInit = []
  if (ctx.schema.autoBox) {
    const bt = `${T}box`
    ctx.func.locals.set(bt, 'i32')
    for (const [name, { schemaId, schema }] of ctx.schema.autoBox) {
      inc('__alloc_hdr', '__mkptr')
      boxInit.push(
        ['local.set', `$${bt}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', Math.max(1, schema.length)]]],
        ['f64.store', ['local.get', `$${bt}`],
          ctx.func.names.has(name) ? ['f64.const', 0] : ['global.get', `$${name}`]],
        ...schema.slice(1).map((_, i) =>
          ['f64.store', ['i32.add', ['local.get', `$${bt}`], ['i32.const', (i + 1) * 8]], ['f64.const', 0]]),
        ['global.set', `$${name}`, mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${bt}`])])
    }
  }

  const schemaInit = []
  const hasJpObj = ctx.core.includes.has('__jp_obj') || ctx.core.includes.has('__jp')
  const hasStringify = ctx.core.includes.has('__stringify')
  // Empty object literals register a `[]` schema so their schemaId indexes a
  // valid list entry. But __dyn_get already guards `$__schema_tbl == 0`, so a
  // table holding only empty schemas is pure dead weight there. __json_obj has
  // no such guard — it must read the table whenever stringify is in play.
  const tblConsumed = hasStringify ||
    ctx.core.includes.has('__obj_clone') ||
    ctx.core.includes.has('__dyn_get') ||
    ctx.core.includes.has('__dyn_get_t') ||
    ctx.core.includes.has('__dyn_get_t_h') ||
    ctx.core.includes.has('__dyn_get_expr_t_h') ||
    ctx.core.includes.has('__dyn_get_any') ||
    ctx.core.includes.has('__dyn_get_any_t') ||
    ctx.core.includes.has('__dyn_get_any_t_h') ||
    ctx.core.includes.has('__dyn_get_expr') ||
    ctx.core.includes.has('__dyn_get_expr_t') ||
    ctx.core.includes.has('__dyn_get_or') ||
    // A string runtime-key WRITE `o[k]=v` whose `k` matches a schema field must
    // mirror the value into the fixed schema slot (buildObjectSchemaSetArm), or a
    // later static `o.x` read returns the stale slot. That mirror is gated on
    // `$__schema_tbl != 0`, so a write-only module (no `__dyn_get*`) must still
    // build the table. (needsSchemaTbl below skips it when every schema is empty.)
    ctx.core.includes.has('__dyn_set')
  const needsSchemaTbl = (ctx.schema.list.length && tblConsumed &&
    (hasStringify || ctx.schema.list.some(s => s.length > 0))) ||
    hasJpObj
  if (needsSchemaTbl) {
    const nSchemas = ctx.schema.list.length
    const runtimeReserve = hasJpObj ? 256 : 0
    const stbl = `${T}stbl`
    const sarr = `${T}sarr`
    ctx.func.locals.set(stbl, 'i32')
    ctx.func.locals.set(sarr, 'i32')
    inc('__alloc', '__alloc_hdr', '__mkptr')
    schemaInit.push(
      ['local.set', `$${stbl}`, ['call', '$__alloc', ['i32.const', (nSchemas + runtimeReserve) * 8]]],
      ['global.set', '$__schema_tbl', ['local.get', `$${stbl}`]])
    if (runtimeReserve) {
      schemaInit.push(['global.set', '$__schema_next', ['i32.const', nSchemas]])
    }
    for (let s = 0; s < nSchemas; s++) {
      const keys = ctx.schema.list[s]
      const n = keys.length
      schemaInit.push(
        ['local.set', `$${sarr}`, ['call', '$__alloc_hdr', ['i32.const', n], ['i32.const', n]]])
      for (let k = 0; k < n; k++)
        schemaInit.push(
          ['f64.store', ['i32.add', ['local.get', `$${sarr}`], ['i32.const', k * 8]],
            emit(['str', String(keys[k])])])
      schemaInit.push(
        ['f64.store', ['i32.add', ['local.get', `$${stbl}`], ['i32.const', s * 8]],
          mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${sarr}`])])
    }
  }

  const strPoolInit = []
  if (ctx.runtime.strPool) {
    const total = ctx.runtime.strPool.length
    strPoolInit.push(
      ['global.set', '$__strBase', ['call', '$__alloc', ['i32.const', total]]],
      ['memory.init', '$__strPool', ['global.get', '$__strBase'], ['i32.const', 0], ['i32.const', total]],
      ['data.drop', '$__strPool'],
    )
  }

  const typeofInit = []
  if (ctx.runtime.typeofStrs) {
    for (const s of ctx.runtime.typeofStrs)
      typeofInit.push(['global.set', `$__tof_${s}`, emit(['str', s])])
  }
  const wasiTimers = ctx.features.timers && ctx.transform.host === 'wasi'
  if (moduleInits.length || init?.length || boxInit.length || schemaInit.length || typeofInit.length || strPoolInit.length || wasiTimers) {
    const initIR = normalizeIR(init)
    const startFn = ['func', '$__start']
    for (const [l, t] of ctx.func.locals) startFn.push(['local', `$${l}`, t])
    startFn.push(...strPoolInit, ...typeofInit, ...boxInit, ...schemaInit,
      ...(wasiTimers ? [['call', '$__timer_init']] : []),
      ...moduleInits, ...initIR,
      ...(ctx.features.blockingTimers ? [['call', '$__timer_loop']] : []),
    )
    sec.start.push(startFn, ['start', '$__start'])
  }

  compilePendingClosures()
  if (closureFuncs.length > beforeLateClosures)
    sec.funcs.unshift(...closureFuncs.slice(beforeLateClosures))
}

/**
 * Hoist constant global initializers out of `__start` into immutable inline decls.
 *
 * A top-level `const x = <constant>` for a non-numeric value (atom `true`/`null`/
 * `undefined`/`NaN`, an SSO or static-string NaN-box, a folded pointer) emits a
 * `(global.set $x (f64.const …))` into `__start`, because only *numeric* consts are
 * folded ahead of emit. But the value is a compile-time constant, so it belongs in
 * the decl itself — `(global $x f64 (f64.const …))` — exactly like the numeric path.
 * That drops the store, and when it empties `__start` the start function and its
 * directive go too. Gated to single-assignment user `const`s so we never freeze a
 * binding something else writes.
 */
export function hoistConstGlobalInits(sec) {
  const startFn = sec.start.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === '$__start')
  if (!startFn) return
  const writes = new Map()
  const scan = (node) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'global.set' && typeof node[1] === 'string') writes.set(node[1], (writes.get(node[1]) || 0) + 1)
    for (const c of node) scan(c)
  }
  for (const arr of [sec.funcs, sec.stdlib, sec.start]) for (const fn of arr) scan(fn)
  for (let i = startFn.length - 1; i >= findBodyStart(startFn); i--) {
    const stmt = startFn[i]
    if (!Array.isArray(stmt) || stmt[0] !== 'global.set' || writes.get(stmt[1]) !== 1) continue
    const name = typeof stmt[1] === 'string' && stmt[1][0] === '$' ? stmt[1].slice(1) : null
    const g = name && ctx.scope.globals.get(name)
    const c = stmt[2]
    if (!g || !g.mut || !ctx.scope.consts?.has(name) || !ctx.scope.userGlobals?.has(name)) continue
    if (!Array.isArray(c) || c[0] !== `${g.type}.const`) continue
    ctx.scope.globals.set(name, { ...g, mut: false, init: c[1] })
    startFn.splice(i, 1)
  }
  // Hoisting can empty `__start`. The O2 watr pass prunes a bodyless start, but at
  // O0/O1 nothing else does — drop it (func + directive) here so a const-only module
  // carries no start at all.
  if (findBodyStart(startFn) >= startFn.length)
    for (let j = sec.start.length - 1; j >= 0; j--)
      if (Array.isArray(sec.start[j]) && sec.start[j][1] === '$__start') sec.start.splice(j, 1)
}

/**
 * Phase: closure-body dedup.
 *
 * Two closures with structurally-equal bodies (same shape after alpha-renaming
 * locals/params) are emitted as a single function — duplicates redirect through
 * the elem table to the canonical name. Closure bodies often share shape because
 * the same inner arrow can be instantiated in many places (e.g. parser combinators).
 */
export function dedupClosureBodies(closureFuncs, sec) {
  if (closureFuncs.length <= 1) return
  const canonicalize = (fn) => {
    const localNames = new Set()
    const collect = (node) => {
      if (!Array.isArray(node)) return
      if ((node[0] === 'local' || node[0] === 'param') && typeof node[1] === 'string' && node[1][0] === '$')
        localNames.add(node[1])
      for (const c of node) collect(c)
    }
    collect(fn)
    let counter = 0
    const renameMap = new Map()
    const walk = node => {
      if (typeof node === 'string') {
        if (!localNames.has(node)) return node
        let r = renameMap.get(node)
        if (!r) { r = `$_c${counter++}`; renameMap.set(node, r) }
        return r
      }
      if (!Array.isArray(node)) return node
      return node.map(walk)
    }
    return JSON.stringify(['func', ...fn.slice(2).map(walk)])
  }
  const hashToName = new Map()
  const redirect = new Map()
  const keepSet = new Set()
  for (const fn of closureFuncs) {
    const key = canonicalize(fn)
    const name = fn[1].slice(1)
    const canonical = hashToName.get(key)
    if (canonical) redirect.set(name, canonical)
    else { hashToName.set(key, name); keepSet.add(name) }
  }
  if (!redirect.size) return
  const kept = sec.funcs.filter(fn => {
    if (!Array.isArray(fn) || fn[0] !== 'func') return true
    const name = typeof fn[1] === 'string' && fn[1][0] === '$' ? fn[1].slice(1) : null
    return !name || !redirect.has(name)
  })
  const redirectRefs = node => {
    if (typeof node === 'string') return node[0] === '$' && redirect.has(node.slice(1)) ? `$${redirect.get(node.slice(1))}` : node
    if (!Array.isArray(node)) return node
    for (let i = 0; i < node.length; i++) node[i] = redirectRefs(node[i])
    return node
  }
  for (const fn of kept) redirectRefs(fn)
  ctx.closure.table = ctx.closure.table.map(n => redirect.get(n) || n)
  sec.funcs.length = 0
  sec.funcs.push(...kept)
}

/**
 * Phase: closure-table finalize + ABI shrink.
 */
export function finalizeClosureTable(sec) {
  let indirectUsed = ctx.transform.host === 'wasi'
  const scan = (n) => {
    if (!Array.isArray(n) || indirectUsed) return
    if (n[0] === 'call_indirect') { indirectUsed = true; return }
    for (const c of n) if (Array.isArray(c)) scan(c)
  }
  for (const fn of sec.funcs) { scan(fn); if (indirectUsed) break }
  if (!indirectUsed) for (const fn of sec.start) scan(fn)
  // stdlib values are mixed: WAT-template strings + lazy generator functions.
  // Only the string templates can carry a literal `call_indirect`; a typeof
  // guard skips the generators (where `.includes` is meaningless — and on a jz
  // closure receiver would read the closure pointer as a string, out of bounds).
  if (!indirectUsed) for (const tpl of Object.values(ctx.core.stdlib)) {
    if (typeof tpl === 'string' && tpl.includes('call_indirect')) { indirectUsed = true; break }
  }
  if (indirectUsed) {
    if (!ctx.closure.table) ctx.closure.table = []
    sec.table = [['table', ['export', '"__jz_table"'], ctx.closure.table.length, 'funcref']]
    sec.elem = ctx.closure.table.length ? [['elem', ['i32.const', 0], 'func', ...ctx.closure.table.map(n => `$${n}`)]] : []
    return
  }
  sec.table = []
  sec.elem = []
  sec.types = sec.types.filter(t => !(Array.isArray(t) && t[1] === '$ftN'))
  const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
  const abiOf = new Map()
  for (const cb of (ctx.closure.bodies || [])) {
    const fixedN = cb.params.length - (cb.rest ? 1 : 0)
    abiOf.set(cb.name, {
      needEnv: cb.captures.length > 0,
      needArgc: !!cb.rest,
      usedSlots: cb.rest ? W : fixedN,
      rest: !!cb.rest,
    })
  }
  for (const fn of sec.funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func') continue
    const fnName = typeof fn[1] === 'string' && fn[1][0] === '$' ? fn[1].slice(1) : null
    const abi = abiOf.get(fnName)
    if (!abi) continue
    for (let i = fn.length - 1; i >= 0; i--) {
      const node = fn[i]
      if (!Array.isArray(node) || node[0] !== 'param') continue
      const pname = node[1]
      if (pname === '$__env' && !abi.needEnv) fn.splice(i, 1)
      else if (pname === '$__argc' && !abi.needArgc) fn.splice(i, 1)
      else if (typeof pname === 'string' && pname.startsWith('$__a') && !abi.rest) {
        const idx = parseInt(pname.slice(4), 10)
        if (Number.isFinite(idx) && idx >= abi.usedSlots) fn.splice(i, 1)
      }
    }
  }
  const rewriteCalls = (node) => {
    if (!Array.isArray(node)) return
    for (const c of node) if (Array.isArray(c)) rewriteCalls(c)
    if ((node[0] === 'call' || node[0] === 'return_call') && typeof node[1] === 'string') {
      const callee = node[1].slice(1)
      const abi = abiOf.get(callee)
      if (!abi) return
      const newArgs = []
      if (abi.needEnv) newArgs.push(node[2])
      if (abi.needArgc) newArgs.push(node[3])
      for (let i = 0; i < abi.usedSlots; i++) newArgs.push(node[4 + i])
      node.splice(2, node.length - 2, ...newArgs)
    }
  }
  for (const fn of sec.funcs) rewriteCalls(fn)
  for (const fn of sec.start) rewriteCalls(fn)
}

/**
 * Stdlib funcs actually reachable from the emitted program. Seeds from real
 * `call`/`return_call`/`ref.func` sites in the user funcs, `__start`, and the elem
 * table, then closes transitively over the stdlib call graph (each reached helper's
 * template references). Conservative by construction — a template `$__foo` in a
 * feature-dead branch is kept, never dropped — so it's safe to gate inclusion and the
 * memory/allocator decision on it. An eagerly-`inc`'d helper that nothing calls is
 * absent, which is the whole point.
 */
function reachableStdlib(sec) {
  const stdlib = ctx.core.stdlib
  const reach = new Set(), stack = []
  // Track every reached name (module-namespace `math.sin` included), but only follow
  // those with a stdlib template. Names match `$foo`, `$__foo`, `$math.sin_core` — the
  // dotted module funcs are the ones the `$__`-only regex used to miss, pruning live code.
  const add = (name) => { if (!reach.has(name)) { reach.add(name); if (stdlib[name] != null) stack.push(name) } }
  const scanIR = (node) => {
    if (!Array.isArray(node)) return
    if ((node[0] === 'call' || node[0] === 'return_call' || node[0] === 'ref.func') &&
        typeof node[1] === 'string' && node[1][0] === '$') add(node[1].slice(1))
    for (const c of node) scanIR(c)
  }
  for (const fn of sec.funcs) scanIR(fn)
  for (const fn of sec.start) scanIR(fn)
  for (const e of sec.elem)               // closure table: bare `$fn` func refs
    if (Array.isArray(e)) for (const c of e) if (typeof c === 'string' && c[0] === '$') add(c.slice(1))
  // A stdlib func that self-exports (`(export "__invoke_closure")`) is a host-facing
  // entry point — the JS host calls it directly, so it's a root even when nothing in
  // the wasm calls it. Mirrors treeshake's inline-export rooting.
  for (const n of ctx.core.includes) {
    const v = stdlib[n]
    let t = ''
    try { t = typeof v === 'function' ? v() : v } catch { t = '' }
    if (typeof t === 'string' && t.includes('(export "')) add(n)
  }
  while (stack.length) {
    const v = stdlib[stack.pop()]
    let text = ''
    try { text = typeof v === 'function' ? v() : v } catch { text = '' }
    if (typeof text === 'string') for (const m of text.matchAll(/\$([A-Za-z_][A-Za-z0-9_.]*)/g)) add(m[1])
  }
  return reach
}

// The f64x2 stdlib mirrors the lane vectorizer (optimize/vectorize.js) injects in the LATE 'post'
// pass — after the stdlib was pulled + treeshaken. Keep in sync with that pass's call-rewrite map
// (PPC_CALL2). These are the ONLY helpers appendLateStdlib may add; restricting to them avoids
// touching helpers that live in other module sections (ext-stdlib, imports) where a blind
// referenced-but-absent scan would wrongly re-append and duplicate them.
const LATE_VEC_HELPERS = new Set(['math.sin2', 'math.cos2', 'math.pow2', 'math.atan2_2', 'math.hypot_2', 'math.log_v', 'math.exp_v', 'math.exp2_v', 'math.cbrt_v', 'math.fifthroot_v'])

// A late pass can reference one of the f64x2 mirrors that wasn't present when the stdlib was first
// assembled. Append any referenced-but-missing mirror body (fixpoint over their own calls, though
// the trig mirrors call nothing). moduleArr is mutated in place; non-mirror references are left for
// watr to resolve (a genuine missing helper is the kernel's own pull, already satisfied).
export function appendLateStdlib(moduleArr, pushTarget = moduleArr) {
  const stdlib = ctx.core.stdlib
  const have = new Set()
  for (const n of moduleArr) if (Array.isArray(n) && n[0] === 'func' && typeof n[1] === 'string') have.add(n[1])
  let added = true
  while (added) {
    added = false
    const refs = new Set()
    const scan = (n) => { if (!Array.isArray(n)) return; if ((n[0] === 'call' || n[0] === 'return_call' || n[0] === 'ref.func') && typeof n[1] === 'string' && n[1][0] === '$') refs.add(n[1]); for (const c of n) scan(c) }
    for (const n of moduleArr) scan(n)
    for (const ref of refs) {
      const name = ref.slice(1)
      if (have.has(ref) || !LATE_VEC_HELPERS.has(name) || stdlib[name] == null) continue
      const node = parseTemplate(typeof stdlib[name] === 'function' ? stdlib[name]() : stdlib[name])
      const body = node[0] === 'module' ? node[1] : node
      pushTarget.push(body)
      // Keep the scan array in sync so the fixpoint can resolve a mirror that itself
      // calls another mirror (cbrt_v → log_v/exp_v). When pushTarget IS moduleArr the
      // single push already did this.
      if (pushTarget !== moduleArr) moduleArr.push(body)
      have.add(ref)
      added = true
    }
  }
}

/**
 * Phase: pull stdlib + memory.
 */
export function pullStdlib(sec) {
  installHelperCounters()
  resolveIncludes()

  // Reachability, not inclusion, decides what the output needs. `ctx.core.includes`
  // accumulates everything a module *might* use (eager module-load `inc`s + transitive
  // deps), but a const array / static string literal calls none of it. So we seed from
  // the actual call sites in the emitted funcs + __start (+ elem table) and close
  // transitively over the stdlib call graph. An eagerly-included helper that nothing
  // calls never enters this set — so allocator, memory, and exports reflect real use.
  const reachable = reachableStdlib(sec)
  const realize = (n) => { const v = ctx.core.stdlib[n]; try { return typeof v === 'function' ? v() : v } catch { return '' } }

  // Two distinct needs, kept separate:
  //  · needsAlloc — the program allocates at runtime: an allocator func is reachable,
  //    or shared-mem string literals seed a pool __start allocs. Drives the bump
  //    allocator (`__alloc`/`__alloc_hdr`/`__clear`), the `__heap` pointer, and the
  //    `_alloc`/`_clear` marshalling exports.
  //  · needsMemory — linear memory must merely *exist*: we allocate, OR a literal lives
  //    in a static data segment (a const pointer, no allocator behind it), OR a reached
  //    helper / inline body does a load/store, OR `__ptr_type` is reached (the module
  //    discriminates heap tags — an `instanceof`/`typeof x==='object'` whose argument the
  //    host marshals across the boundary). A data segment with no memory is invalid wasm,
  //    so memory can't be gated on allocation alone.
  const ALLOC_FUNCS = ['__alloc', '__alloc_hdr', '__alloc_hdr_n']
  const needsAlloc = !!ctx.runtime.strPool || ALLOC_FUNCS.some(a => reachable.has(a))
  // Memory ops can be emitted *inline* into user/start funcs (a heap-path char read
  // loads without calling a stdlib helper), so scan the emitted bodies too.
  const hasMemOp = (node) => Array.isArray(node) &&
    ((typeof node[0] === 'string' && MEM_OPS.test(node[0])) || node.some(hasMemOp))
  // `ctx.runtime.data` is never empty here — the number module seeds a static stringify
  // prefix (`NaNInfinity…`) at offset 0; stripStaticDataPrefix removes it when unused, so
  // the real question is whether any data lives *beyond* that strippable prefix.
  // An explicit `{ memory: pages }` / shared-memory option is a caller request to own
  // linear memory (e.g. to marshal host values in), independent of what the wasm itself
  // reaches — honour it even for an otherwise-memoryless program.
  const explicitMemory = ctx.memory.pages > 0 || !!ctx.memory.shared
  const needsMemory = needsAlloc || explicitMemory ||
    (ctx.runtime.data?.length || 0) > (ctx.runtime.staticDataLen || 0) ||
    reachable.has('__ptr_type') ||
    [...reachable].some(n => MEM_OPS.test(realize(n))) ||
    sec.funcs.some(hasMemOp) || sec.start.some(hasMemOp)
  // Emit only what's reachable: drop every eagerly-`inc`'d *internal* helper the program
  // never calls. This is what lets a const-array / static-string / atom module shed the
  // allocator, pointer dispatchers, and length helpers that an array/object module load
  // pulled in wholesale — and it keeps the dead allocator from dangling on the `$__heap`
  // we delete below. Scoped to `__`-prefixed names: module-namespace funcs (`math.sin`)
  // are pulled in on demand, never eagerly, so they're already minimal and never pruned
  // here (guarding against any reachability blind spot in a dotted-name template).
  for (const n of [...ctx.core.includes]) if (n.startsWith('__') && !reachable.has(n)) ctx.core.includes.delete(n)
  // Lazy Eisel-Lemire table injection: only when __dec_to_f64 (correctly-rounded
  // decimal→f64, module/number.js) survived pruning — append its trimmed 131-entry
  // (~2KB) power-of-10 table and declare $__el_tbl = that offset. Must run HERE so
  // dataPages (below) accounts for the addition; keeps it out of programs that never
  // parse decimals at runtime.
  if (ctx.core.includes.has('__dec_to_f64') && ctx.runtime.elTable) {
    const elBefore = ctx.runtime.data.length
    while (ctx.runtime.data.length % 8 !== 0) ctx.runtime.data += '\0'
    const elTblOff = ctx.runtime.data.length
    ctx.runtime.data += ctx.runtime.elTable
    declGlobal('__el_tbl', 'i32', elTblOff, { mut: false })
    ctx.runtime.elTable = null  // prevent double-injection on re-entry (null-sentinel; jz forbids delete)
    // Reachability here OVER-counts __dec_to_f64: a dead inlined helper's `arr[i] | 0`
    // on an untyped param pulls __to_num → __dec_to_f64, landing the table even when no
    // LIVE code parses decimals. Record the appended span (padding + table, always the
    // data tail — it's the last append) so stripDeadElTable can drop it post-lowering,
    // once reachability is exact. See stripDeadElTable.
    ctx.runtime.elTableLen = ctx.runtime.data.length - elBefore
  }
  if (!needsAlloc) { ctx.scope.globals.delete('__heap'); ctx.scope.globals.delete('__heap_reset') }
  if (needsMemory && ctx.module.modules.core) {
    if (needsAlloc) {
      for (const fn of ['__alloc', '__alloc_hdr', '__clear']) ctx.core.includes.add(fn)
      // Late-add of allocators may pull in transitive deps (__alloc → __memgrow,
      // etc.) that the initial resolveIncludes did not yet see; re-resolve.
      // No-op when the alloc trio was already present.
      resolveIncludes()
      // Record the post-init heap top into `__heap_reset` so `__clear` rewinds to
      // just above this module's init-time heap state (e.g. the self-host compiler's
      // GLOBALS/atom tables), not into it. Done here — where `__heap` is known to
      // survive — as the last `__start` action before any non-returning timer loop.
      // No `__start` ⇒ no init allocations ⇒ `__heap_reset`'s data-end seed is right.
      if (!ctx.memory.shared && ctx.scope.globals.has('__heap_reset')) {
        const startFn = sec.start.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === '$__start')
        if (startFn) {
          const capture = ['global.set', '$__heap_reset', ['global.get', '$__heap']]
          const tail = startFn[startFn.length - 1]
          if (Array.isArray(tail) && tail[0] === 'call' && tail[1] === '$__timer_loop') startFn.splice(startFn.length - 1, 0, capture)
          else startFn.push(capture)
        }
      }
      // __dyn_props reset: __clear rewinds the bump arena, but __dyn_props /
      // __dyn_get_cache_off / __dyn_get_cache_props (module/collection.js) cache
      // pointers/offsets INTO that arena across calls — a warm compile-clear-
      // compile loop (self-host kernel: one instance, `_clear()` between compiles)
      // needs them reset too, or a later compile can read a dangling pointer or,
      // worse, alias a stale cached OFFSET onto a freshly-reused arena address
      // (an ABA hazard, not just a dangling one). Only patched in when __dyn_set
      // (the sole writer of __dyn_props) actually SURVIVED reachability pruning
      // (line ~616, just above) — those globals are declared unconditionally
      // whenever the collection module loads, so gating on mere declaration
      // (`ctx.scope.globals.has`) would inject a dead `global.set $__dyn_props`
      // into every such program, wasting bytes and leaking the __dyn_get_cache_*
      // names into WAT text that never otherwise mentions dynamic props (tripping
      // coarse `!/__dyn_get/.test(wat)`-style assertions — see test/closures.js).
      // Both blocks below extend the SAME `__clear` body — accumulate into one
      // shared list and rebuild once, so whichever runs second doesn't clobber the
      // other's addition (a program can need both: dyn-props AND durable-growth
      // relocation both reach here independent of each other).
      const resets = []
      if (ctx.core.includes.has('__dyn_set')) {
        if (ctx.scope.globals.has('__dyn_props')) resets.push(`(global.set $__dyn_props (f64.const 0))`)
        // The membership filter mirrors the table: emptying __dyn_props makes every
        // set bit a stale false-positive — safe, but a warm compile-clear loop would
        // saturate the filter and erode its skip rate. Reset them together.
        if (ctx.scope.globals.has('__dyn_props_filter')) resets.push(`(global.set $__dyn_props_filter (i64.const 0))`)
        if (ctx.scope.globals.has('__dyn_get_cache_off')) resets.push(`(global.set $__dyn_get_cache_off (i32.const -1))`)
        if (ctx.scope.globals.has('__dyn_get_cache_props')) resets.push(`(global.set $__dyn_get_cache_props (f64.const 0))`)
      }
      // Durable relocation heal (collection.js's durableFwdLogIR / core.js's
      // __durable_fwd_log/__durable_fwd_heal): only reachable when some growable
      // ARRAY/HASH/SET/MAP relocation site actually logged a durable→ephemeral
      // forward this build — see durableFwdLogIR's header comment for the full
      // rationale. Must run before the next round can allocate over the logged
      // ephemeral targets, so it belongs in `__clear` alongside the arena rewind
      // (order vs the rewind itself doesn't matter — `_clear` never zeroes memory,
      // only moves the bump pointer — but keeping it grouped with the other resets
      // reads as "finish with this round's bookkeeping, then reclaim its arena").
      if (ctx.core.includes.has('__durable_fwd_log')) {
        // __durable_fwd_heal is called ONLY from this injected `__clear` text — it has
        // no OTHER call site for reachableStdlib (line ~582, already run) to have found
        // it through, so (unlike __durable_fwd_log itself, whose deps() edges at every
        // grow/shift call site make it self-host-robust — see test/selfhost-includes.js)
        // it needs an explicit include here, mirroring the `__alloc`/`__alloc_hdr`/
        // `__clear` late-add just above. `inc()`, not a raw `ctx.core.includes.add()`:
        // the former is what test/selfhost-includes.js's source-scan recognizes as an
        // explicit (self-host-safe) edge. No further resolveIncludes() needed:
        // __durable_fwd_heal's body calls nothing else (raw i32 loads/stores + global
        // get/set only).
        inc('__durable_fwd_heal')
        resets.push(`(call $__durable_fwd_heal)`)
      }
      if (resets.length) ctx.core.stdlib['__clear'] = `(func $__clear
          (global.set $__heap (global.get $__heap_reset))
          ${resets.join('\n          ')})`
    }
    // Initial pages must cover the static data segment (it loads at instantiation), not
    // just the default 1 — otherwise a module whose constants exceed 64 KiB emits a data
    // segment that overflows its own memory. The heap grows past this on demand via
    // __memgrow. (Shared memory loads literals via memory.init into allocated space, so
    // its initial size isn't pinned by the data length.)
    const dataPages = ctx.memory.shared ? 0 : Math.ceil((ctx.runtime.data?.length || 0) / 65536)
    const pages = Math.max(ctx.memory.pages || 1, dataPages)
    const max = ctx.memory.max || 0   // 0 = no maximum (unbounded growth)
    if (ctx.memory.shared) sec.imports.push(['import', '"env"', '"memory"', max ? ['memory', pages, max] : ['memory', pages]])
    else sec.memory.push(max ? ['memory', ['export', '"memory"'], pages, max] : ['memory', ['export', '"memory"'], pages])
    if (needsAlloc && ctx.transform.alloc !== false && ctx.core._allocRawFuncs)
      sec.funcs.push(...ctx.core._allocRawFuncs.map(parseTemplate))
  }

  const stdlibStr = (name) => {
    const v = ctx.core.stdlib[name]
    return typeof v === 'function' ? v() : v
  }
  ctx.core.extImports ??= new Set()
  for (const name of Object.keys(ctx.core.stdlib)) {
    if (name.startsWith('__ext_') && ctx.core.includes.has(name)) {
      const parsed = parseTemplate(stdlibStr(name))
      sec.extStdlib.push(parsed[0] === "module" ? parsed[1] : parsed)
      ctx.core.extImports.add(name)
      ctx.core.includes.delete(name)
    }
  }
  for (const n of ctx.core.includes) if (!ctx.core.stdlib[n]) err(`internal: stdlib '${n}' was requested but never registered (this is a jz bug — feature pulled in something it can't deliver)`)
  sec.stdlib.push(...[...ctx.core.includes].map(n => instrumentHelperCounter(n, parseTemplate(stdlibStr(n)))))
}

export function syncImports(sec) {
  for (const imp of ctx.module.imports) {
    if (!sec.imports.some(i => i[1] === imp[1] && i[2] === imp[2])) sec.imports.push(imp)
  }
}

/**
 * Phase: whole-module + per-function optimization passes.
 */
export function optimizeModule(sec, profiler) {
  const t = profiler?.time ? (name, fn) => profiler.time(`optMod:${name}`, fn) : (_, fn) => fn()
  const cfg = ctx.transform.optimize
  if (!cfg || cfg.specializeMkptr !== false) t('specializeMkptr', () =>
    specializeMkptr([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat)), parseWat))
  if (!cfg || cfg.specializePtrBase !== false) t('specializePtrBase', () =>
    specializePtrBase([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat)), parseWat))
  if (ctx.runtime.strPool && (!cfg || cfg.sortStrPoolByFreq !== false)) t('sortStrPool', () => {
    const poolRef = { pool: ctx.runtime.strPool }
    sortStrPoolByFreq([...sec.funcs, ...sec.stdlib, ...sec.start], poolRef, ctx.runtime.strPoolDedup)
    ctx.runtime.strPool = poolRef.pool
  })
  // (globalTypes backfill gone: declGlobal sets the type at declaration.)
  // Build global name→type map from ctx.scope.globalTypes (keys without $) for promoteGlobals
  const globalTypesMap = ctx.scope.globalTypes ? new Map([...ctx.scope.globalTypes].map(([k, v]) => [`$${k}`, v])) : null
  const allFuncs = [...sec.funcs, ...sec.stdlib, ...sec.start]
  const volatileGlobals = t('volatileGlobals', () => collectVolatileGlobals(allFuncs))
  const reachableWrites = t('reachableWrites', () => collectReachableGlobalWrites(allFuncs))
  // Offset-hoist BEFORE promoteGlobals (inside optimizeFunc): value-promoting a
  // stable-pointee global to a $_pg local would destroy the global.get pattern
  // this pass matches, reverting rfft/diffusion to per-iteration resolves. After
  // the hoist, the surviving global.get count is 1 (the entry snap) — naturally
  // below promoteGlobals' threshold, so the two passes compose either way.
  if (!cfg || cfg.hoistGlobalPtrOffset !== false) t('hoistGlobalPtr', () => {
    const stable = stablePtrGlobalNames()
    if (stable.size) for (const s of allFuncs) hoistGlobalPtrOffset(s, stable, reachableWrites)
  })
  // Build the pure-function map for tryPerPixelColor's Phase-2 lane inline BEFORE the
  // per-function vectorizer runs — the vectorizer is jz lowering (pre-watr), so it needs
  // its inline candidates now, not after watr. Bodies are still clean scalar here.
  if (cfg && cfg.vectorizeLaneLocal === true) {
    const pureFuncMap = buildPureFuncMap(allFuncs)
    if (pureFuncMap.size) {
      cfg._pureFuncMap = pureFuncMap
      // jz semantic inlining (LOWERING) — inline pure user functions into their call sites BEFORE the
      // vectorizer, so it sees the callee arithmetic (the pow/decode a colour helper hides). jz owns
      // this because the decision is purity+type-driven; watr keeps only mechanical residual inlining.
      // Gated to SINGLE-CALLER pure functions: inlining the sole call site is a guaranteed win (removes
      // the call AND the now-dead function, zero size cost). Multi-caller small helpers stay watr's
      // size-gated mechanical job at the speed tier — jz doesn't duplicate that.
      // SMALL single-caller only: inlining a small pure helper (a `spow`/`decode` colour term) into its
      // sole caller exposes its arithmetic to the vectorizer at zero size cost. Inlining a LARGE function
      // (a whole conversion loop) is neutral-to-harmful (worse layout/regalloc, measured on colorpq), and
      // watr's own inlineOnce already handles the mechanical single-caller case — so jz stays out of it.
      // OPT-IN (default off): correct + fuzz-clean, but inlining across the corpus changes a lot of
      // pinned output-shape assertions for no measured bench win (the current regressions are outer-strip/
      // widening recognition + watr wasm-opt-class, not inlining). Kept as the architectural home for
      // semantic inlining, enabled per-compile via `optimize.inlinePureFns: true`, until a real case pays.
      if (cfg.inlinePureFns === true) t('inlinePureFns', () => {
        const callCount = new Map()
        const countCalls = (n) => { if (!Array.isArray(n)) return; if ((n[0] === 'call' || n[0] === 'return_call') && typeof n[1] === 'string') callCount.set(n[1], (callCount.get(n[1]) || 0) + 1); for (let i = 1; i < n.length; i++) countCalls(n[i]) }
        for (const s of allFuncs) countCalls(s)
        const nodeCount = (n) => !Array.isArray(n) ? 0 : 1 + n.reduce((a, c, i) => a + (i > 0 ? nodeCount(c) : 0), 0)
        const INLINE_MAX = 48
        const canInline = new Set([...pureFuncMap.keys()].filter(name =>
          callCount.get(name) === 1 && nodeCount(pureFuncMap.get(name)) <= INLINE_MAX))
        if (canInline.size) { const idRef = { next: 0 }; for (const s of allFuncs) inlinePureFnsInFn(s, pureFuncMap, idRef, canInline) }
      })
    }
  }
  t('optimizeFuncs', () => { for (const s of allFuncs) optimizeFunc(s, cfg, globalTypesMap, volatileGlobals, 'pre', reachableWrites) })
  // The lane vectorizer can inject f64x2 stdlib mirrors ($math.log_v, $math.cos2, …)
  // absent from the already-pulled+treeshaken module. Append any now-referenced mirror
  // body to sec.stdlib — the pre-watr analogue of index.js's post-watr appendLateStdlib.
  if (cfg && cfg.vectorizeLaneLocal === true) t('appendLateStdlib', () => appendLateStdlib(allFuncs, sec.stdlib))
  if (!cfg || cfg.arenaRewind !== false) {
    const safeCallees = arenaRewindModule([...sec.funcs, ...sec.stdlib, ...sec.start])
    const fnByName = new Map()
    for (const fn of sec.funcs) {
      if (Array.isArray(fn) && fn[0] === 'func' && typeof fn[1] === 'string')
        fnByName.set(fn[1], fn)
    }
    for (const func of ctx.func.list) {
      const fn = fnByName.get(`$${func.name}`)
      if (fn) applyArenaRewind(func, fn, safeCallees)
    }
  }
  if (!cfg || cfg.hoistConstantPool !== false)
    hoistConstantPool([...sec.funcs, ...sec.stdlib, ...sec.start], (name, lit) => declGlobal(name, 'f64', lit))

  // Second promoteGlobals pass disabled: promoting hoistConstantPool's __fc*
  // globals regressed the watr perf micro-pin (WASM compile time increased).
  // The __fc* globals are typically read 3-4 times; the local setup overhead
  // in large functions outweighs the per-read savings.  Left as a no-op hook
  // in case future analysis finds a profitable threshold or function-size gate.
  // if (!cfg || cfg.promoteGlobals !== false) {
  //   const globalTypesMap2 = ctx.scope.globalTypes ? new Map([...ctx.scope.globalTypes].map(([k, v]) => [`$${k}`, v])) : null
  //   for (const s of [...sec.funcs, ...sec.stdlib, ...sec.start]) promoteGlobals(s, globalTypesMap2)
  // }

  const dataLen = ctx.runtime.data?.length || 0
  if (dataLen > 1024 && !ctx.memory.shared) {
    const heapBase = (dataLen + 7) & ~7
    // Non-shared memory always carries a $__heap global — start it past the
    // static data so the bump allocator never overwrites a literal. `__heap_reset`
    // seeds to the same data end (its runtime value is overwritten by `__start`'s
    // tail capture for modules that init-allocate; this seed serves modules with no
    // `__start`, where the data end IS the correct rewind point). `__clear` reads
    // `$__heap_reset` directly, so no per-function constant patch is needed.
    declGlobal('__heap', 'i32', heapBase, { export: '__heap' })
    if (ctx.scope.globals.has('__heap_reset')) declGlobal('__heap_reset', 'i32', heapBase)
    if (ctx.scope.globals.has('__heap_start')) declGlobal('__heap_start', 'i32', heapBase)
  }
}

/**
 * Phase: strip the Eisel-Lemire table when it is dead.
 *
 * pullStdlib injects the ~2 KB power-of-10 table whenever `__dec_to_f64` is *reachable*,
 * but that over-counts: a dead inlined helper's `arr[i] | 0` on an untyped param pulls
 * `__to_num` → `__dec_to_f64`, so the table lands even in a module no live code parses
 * decimals in. watr later treeshakes the dead function + its `$__el_tbl` global, but it
 * does NOT treeshake the data segment — so the orphaned table bloated every module ~2 KB.
 *
 * This runs LAST (after every lowering has emitted its call/ref.func — doing it earlier is
 * unsound: refs like `util.clone` are emitted *after* pullStdlib), so a mark-sweep from the
 * real roots (inline-exported funcs, __start, the closure table, globals/tags/table) gives
 * EXACT liveness. If `__dec_to_f64` is dead, truncate the table from the data tail (it is
 * the last append — see pullStdlib). DATA only: the dead function + global are left for
 * watr, which already removes them. Keeps correctly-rounded decimal parsing wherever it is
 * genuinely live (parseFloat, the self-host compiler's `Number()` on source literals).
 */
export function stripDeadElTable(sec) {
  if (!ctx.runtime.elTableLen) return
  const byName = new Map()
  for (const arr of [sec.funcs, sec.stdlib, sec.start])
    for (const f of arr || []) if (Array.isArray(f) && f[0] === 'func' && typeof f[1] === 'string') byName.set(f[1], f)
  const live = new Set(), work = []
  const mark = (ref) => { if (typeof ref === 'string' && byName.has(ref) && !live.has(ref)) { live.add(ref); work.push(ref) } }
  const scan = (n) => {
    if (!Array.isArray(n)) return
    if ((n[0] === 'call' || n[0] === 'return_call' || n[0] === 'ref.func') && typeof n[1] === 'string') mark(n[1])
    for (const c of n) scan(c)
  }
  for (const f of sec.funcs) if (f.some(el => Array.isArray(el) && el[0] === 'export')) mark(f[1])
  for (const f of sec.start) scan(f)
  for (const part of [sec.elem, sec.globals, sec.tags, sec.table]) for (const n of part || []) {
    if (!Array.isArray(n)) continue
    for (const c of n) { if (typeof c === 'string' && c[0] === '$') mark(c); else scan(c) }
  }
  while (work.length) scan(byName.get(work.pop()))
  if (live.has('$__dec_to_f64')) return   // genuinely parses decimals at runtime — keep it
  ctx.runtime.data = ctx.runtime.data.slice(0, ctx.runtime.data.length - ctx.runtime.elTableLen)
  ctx.runtime.elTableLen = 0
}

/**
 * Phase: strip static-data prefix.
 */
export function stripStaticDataPrefix(sec) {
  if (!ctx.runtime.staticDataLen || ctx.core.includes.has('__static_str')) return
  const prefix = ctx.runtime.staticDataLen
  const SHIFTABLE = new Set([PTR.STRING, PTR.OBJECT, PTR.ARRAY, PTR.HASH, PTR.SET, PTR.MAP, PTR.BUFFER, PTR.TYPED, PTR.CLOSURE])
  const data = ctx.runtime.data || ''
  const buf = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i)
  const dv = new DataView(buf.buffer)
  if (ctx.runtime.staticPtrSlots) {
    // u32-half reads/writes — DataView's BigInt accessors are unfaithful in the
    // self-host kernel; the offset lives entirely in the LE low word and the
    // tag/aux fields entirely in the high word, so plain number math suffices.
    for (const slotOff of ctx.runtime.staticPtrSlots) {
      if (slotOff < prefix) continue
      const hi = dv.getUint32(slotOff + 4, true)
      if (((hi >>> 16) & 0xFFF8) !== LAYOUT.NAN_PREFIX) continue
      const ty = (hi >>> 15) & 15
      if (!SHIFTABLE.has(ty)) continue
      if (ty === PTR.STRING && ((hi >>> (LAYOUT.AUX_SHIFT - 32)) & LAYOUT.SSO_BIT)) continue
      const off = dv.getUint32(slotOff, true)
      if (off < prefix) continue
      dv.setUint32(slotOff, off - prefix, true)
    }
  }
  // The intern index (buildInternTable) stores raw static-string ptrs as u32
  // slots — shift each occupied slot like every other static reference, and
  // re-declare the (already-declared) base global at its post-strip position.
  if (ctx.runtime.internTable) {
    const { base, size } = ctx.runtime.internTable
    for (let i = 0; i < size; i++) {
      const slot = base + i * 8 + 4
      const off = dv.getUint32(slot, true)
      if (off >= prefix) dv.setUint32(slot, off - prefix, true)
    }
    ctx.runtime.internTable.base = base - prefix
    declGlobal('__internBase', 'i32', base - prefix, { mut: false })
  }
  let s = ''
  for (let i = prefix; i < buf.length; i++) s += String.fromCharCode(buf[i])
  ctx.runtime.data = s
  if (ctx.runtime.staticPtrSlots) ctx.runtime.staticPtrSlots = ctx.runtime.staticPtrSlots
    .filter(o => o >= prefix).map(o => o - prefix)
  const shift = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 0; i < node.length; i++) {
      const child = node[i]
      if (!Array.isArray(child)) continue
      if (child[0] === 'call' && child[1] === '$__mkptr' &&
        Array.isArray(child[2]) && SHIFTABLE.has(child[2][1]) &&
        Array.isArray(child[4]) && child[4][0] === 'i32.const' &&
        typeof child[4][1] === 'number' && child[4][1] >= prefix) {
        const isSsoString = child[2][1] === PTR.STRING &&
          Array.isArray(child[3]) && child[3][0] === 'i32.const' &&
          typeof child[3][1] === 'number' && (child[3][1] & LAYOUT.SSO_BIT)
        if (!isSsoString) child[4][1] -= prefix
      } else if (typeof child[0] === 'string' && child[0].endsWith('.store') &&
        Array.isArray(child[1]) && child[1][0] === 'i32.const' &&
        typeof child[1][1] === 'number' && child[1][1] >= prefix) {
        child[1][1] -= prefix
      } else if (child[0] === 'f64.const' &&
        typeof child[1] === 'string' && child[1].startsWith('nan:0x')) {
        const bits = BigInt(child[1].slice(4)) | 0x7FF0000000000000n
        if (((bits >> 48n) & 0xFFF8n) === NAN_PREFIX) {
          const ty = Number((bits >> TAG_SHIFT_BIG) & TAG_MASK_BIG)
          if (SHIFTABLE.has(ty) &&
              !(ty === PTR.STRING && ((bits >> AUX_SHIFT_BIG) & SSO_BIT_BIG))) {
            const off = Number(bits & OFFSET_MASK_BIG)
            if (off >= prefix) {
              const hi = bits & ~OFFSET_MASK_BIG
              const newBits = hi | BigInt(off - prefix)
              child[1] = 'nan:0x' + newBits.toString(16).toUpperCase().padStart(16, '0')
            }
          }
        }
      }
      shift(child)
    }
  }
  for (const s of [...sec.funcs, ...sec.stdlib, ...sec.start]) shift(s)
}
