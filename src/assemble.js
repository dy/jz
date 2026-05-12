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

import { parse as parseWat } from 'watr'
import { ctx, inc, resolveIncludes, PTR, LAYOUT } from './ctx.js'
import { T, VAL, analyzeValTypes } from './analyze.js'
import { optimizeFunc, hoistConstantPool, specializeMkptr, specializePtrBase, sortStrPoolByFreq, arenaRewindModule } from './optimize.js'
import { emit } from './emit.js'
import { mkPtrIR, MAX_CLOSURE_ARITY, MEM_OPS, findBodyStart } from './ir.js'

// NaN-prefix top-13-bits as BigInt — used by the static-prefix-strip pass
const NAN_PREFIX = BigInt(LAYOUT.NAN_PREFIX)
const TAG_MASK_BIG = BigInt(LAYOUT.TAG_MASK)
const OFFSET_MASK_BIG = BigInt(LAYOUT.OFFSET_MASK)
const TAG_SHIFT_BIG = BigInt(LAYOUT.TAG_SHIFT)
const AUX_SHIFT_BIG = BigInt(LAYOUT.AUX_SHIFT)
const SSO_BIT_BIG = BigInt(LAYOUT.SSO_BIT)

const heapGetIR = () => ctx.memory.shared
  ? ['i32.load', ['i32.const', 1020]]
  : ['global.get', '$__heap']

const heapSetIR = value => ctx.memory.shared
  ? ['i32.store', ['i32.const', 1020], value]
  : ['global.set', '$__heap', value]

const ARENA_SAFE_CALLS = new Set([
  '$__alloc', '$__alloc_hdr', '$__mkptr',
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
      if (name === '$__alloc' || name === '$__alloc_hdr') hasAlloc = true
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
  ctx.func.repByLocal = null
  ctx.func.boxed = new Map()
  ctx.func.stack = []
  ctx.func.current = { params: [], results: [] }
  analyzeValTypes(ast)
  const normalizeIR = ir => !ir?.length ? [] : Array.isArray(ir[0]) ? ir : [ir]

  const moduleInits = []
  if (ctx.module.moduleInits) {
    for (const mi of ctx.module.moduleInits) {
      analyzeValTypes(mi)
      moduleInits.push(...normalizeIR(emit(mi)))
    }
  }
  const init = emit(ast)

  // Module-scope object literals can create closure bodies while `emit(ast)`
  // runs. Those late closures may pull in stdlib helpers (notably JSON.parse)
  // that affect __start setup, so flush them before deciding which runtime
  // tables __start must initialize. Restore the start-function context after
  // compiling closure bodies; emitClosureBody owns ctx.func.* while it runs.
  const beforeLateClosures = closureFuncs.length
  const startCtx = {
    locals: ctx.func.locals,
    repByLocal: ctx.func.repByLocal,
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
        ['local.set', `$${bt}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', Math.max(1, schema.length)], ['i32.const', 8]]],
        ['f64.store', ['local.get', `$${bt}`],
          ctx.func.names.has(name) ? ['f64.const', 0] : ['global.get', `$${name}`]],
        ...schema.slice(1).map((_, i) =>
          ['f64.store', ['i32.add', ['local.get', `$${bt}`], ['i32.const', (i + 1) * 8]], ['f64.const', 0]]),
        ['global.set', `$${name}`, mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${bt}`])])
    }
  }

  const schemaInit = []
  const hasJpObj = ctx.core.includes.has('__jp_obj') || ctx.core.includes.has('__jp')
  const needsSchemaTbl = (ctx.schema.list.length && (
    ctx.core.includes.has('__stringify') ||
    ctx.core.includes.has('__dyn_get') ||
    ctx.core.includes.has('__dyn_get_t') ||
    ctx.core.includes.has('__dyn_get_t_h') ||
    ctx.core.includes.has('__dyn_get_expr_t_h') ||
    ctx.core.includes.has('__dyn_get_any') ||
    ctx.core.includes.has('__dyn_get_any_t') ||
    ctx.core.includes.has('__dyn_get_expr') ||
    ctx.core.includes.has('__dyn_get_expr_t') ||
    ctx.core.includes.has('__dyn_get_or'))) ||
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
        ['local.set', `$${sarr}`, ['call', '$__alloc_hdr', ['i32.const', n], ['i32.const', n], ['i32.const', 8]]])
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
  if (!indirectUsed) for (const s of Object.keys(ctx.core.stdlib)) {
    if (ctx.core.stdlib[s]?.includes?.('call_indirect')) { indirectUsed = true; break }
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
 * Phase: pull stdlib + memory.
 */
export function pullStdlib(sec) {
  resolveIncludes()

  const needsMemory = [...ctx.core.includes].some(n => ctx.core.stdlib[n] && MEM_OPS.test(ctx.core.stdlib[n]))
  if (!needsMemory) ctx.scope.globals.delete('__heap')
  if (needsMemory && ctx.module.modules.core) {
    for (const fn of ['__alloc', '__alloc_hdr', '__clear']) if (!ctx.core.includes.has(fn)) ctx.core.includes.add(fn)
    const pages = ctx.memory.pages || 1
    if (ctx.memory.shared) sec.imports.push(['import', '"env"', '"memory"', ['memory', pages]])
    else sec.memory.push(['memory', ['export', '"memory"'], pages])
    if (ctx.transform.alloc !== false && ctx.core._allocRawFuncs)
      sec.funcs.push(...ctx.core._allocRawFuncs.map(s => parseWat(s)))
  }

  const stdlibStr = (name) => {
    const v = ctx.core.stdlib[name]
    return typeof v === 'function' ? v() : v
  }
  ctx.core.extImports ??= new Set()
  for (const name of Object.keys(ctx.core.stdlib)) {
    if (name.startsWith('__ext_') && ctx.core.includes.has(name)) {
      const parsed = parseWat(stdlibStr(name))
      sec.extStdlib.push(parsed[0] === "module" ? parsed[1] : parsed)
      ctx.core.extImports.add(name)
      ctx.core.includes.delete(name)
    }
  }
  for (const n of ctx.core.includes) if (!ctx.core.stdlib[n]) console.error("MISSING stdlib:", n)
  sec.stdlib.push(...[...ctx.core.includes].map(n => parseWat(stdlibStr(n))))
}

export function syncImports(sec) {
  for (const imp of ctx.module.imports) {
    if (!sec.imports.some(i => i[1] === imp[1] && i[2] === imp[2])) sec.imports.push(imp)
  }
}

/**
 * Phase: whole-module + per-function optimization passes.
 */
export function optimizeModule(sec) {
  const cfg = ctx.transform.optimize
  if (!cfg || cfg.specializeMkptr !== false)
    specializeMkptr([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat)), parseWat)
  if (!cfg || cfg.specializePtrBase !== false)
    specializePtrBase([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat)), parseWat)
  if (ctx.runtime.strPool && (!cfg || cfg.sortStrPoolByFreq !== false)) {
    const poolRef = { pool: ctx.runtime.strPool }
    sortStrPoolByFreq([...sec.funcs, ...sec.stdlib, ...sec.start], poolRef, ctx.runtime.strPoolDedup)
    ctx.runtime.strPool = poolRef.pool
  }
  // Backfill globalTypes for runtime globals declared only in ctx.scope.globals
  // (e.g., __schema_tbl, __strBase). Parses the WAT string to infer i32/f64/i64.
  if (ctx.scope.globals) {
    for (const [name, wat] of ctx.scope.globals) {
      if (!wat || ctx.scope.globalTypes.has(name)) continue
      const m = wat.match(/\(global\s+\$?\S+\s+(?:\(mut\s+)?(i32|i64|f64|f32)/)
      if (m) ctx.scope.globalTypes.set(name, m[1])
    }
  }
  // Build global name→type map from ctx.scope.globalTypes (keys without $) for promoteGlobals
  const globalTypesMap = ctx.scope.globalTypes ? new Map([...ctx.scope.globalTypes].map(([k, v]) => [`$${k}`, v])) : null
  for (const s of [...sec.funcs, ...sec.stdlib, ...sec.start]) optimizeFunc(s, cfg, globalTypesMap)
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
    hoistConstantPool([...sec.funcs, ...sec.stdlib, ...sec.start], (name, wat) => ctx.scope.globals.set(name, wat))

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
    ctx.scope.globals.set('__heap', `(global $__heap (mut i32) (i32.const ${heapBase}))`)
    ctx.scope.globalTypes.set('__heap', 'i32')
    if (ctx.scope.globals.has('__heap_start')) {
      ctx.scope.globals.set('__heap_start', `(global $__heap_start (mut i32) (i32.const ${heapBase}))`)
      ctx.scope.globalTypes.set('__heap_start', 'i32')
    }
    for (const s of sec.stdlib)
      if (s[0] === 'func' && s[1] === '$__clear')
        for (let i = 2; i < s.length; i++)
          if (Array.isArray(s[i]) && s[i][0] === 'global.set' && Array.isArray(s[i][2]) && s[i][2][0] === 'i32.const')
            s[i][2][1] = `${heapBase}`
  }
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
    for (const slotOff of ctx.runtime.staticPtrSlots) {
      if (slotOff < prefix) continue
      const bits = dv.getBigUint64(slotOff, true)
      if (((bits >> 48n) & 0xFFF8n) !== NAN_PREFIX) continue
      const ty = Number((bits >> TAG_SHIFT_BIG) & TAG_MASK_BIG)
      if (!SHIFTABLE.has(ty)) continue
      if (ty === PTR.STRING && ((bits >> AUX_SHIFT_BIG) & SSO_BIT_BIG)) continue
      const off = Number(bits & OFFSET_MASK_BIG)
      if (off < prefix) continue
      const hi = bits & ~OFFSET_MASK_BIG
      dv.setBigUint64(slotOff, hi | BigInt(off - prefix), true)
    }
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
