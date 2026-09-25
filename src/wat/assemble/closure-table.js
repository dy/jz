/**
 * Closure funcs section — body dedup, then table finalize + ABI shrink.
 *
 * Split out of assemble.js (pipeline-minimality slice) — pure move, no
 * behavior change. See ../assemble.js for the stage contract and
 * `.work/archive/assemble-outliers.md` §4 for why these two phases share a file
 * (adjacent in call order: dedup runs immediately before finalize,
 * compile/index.js:2894-2896).
 */

import { ctx, resolveIncludes } from '../../ctx.js'
import { walkAst, some } from '../../ast.js'
import { MAX_CLOSURE_ARITY } from '../../ir.js'

/**
 * Phase: closure-body dedup.
 *
 * Two closures with structurally-equal bodies (same shape after alpha-renaming
 * locals/params) are emitted as a single function — duplicates redirect through
 * the elem table to the canonical name. Closure bodies often share shape because
 * the same inner arrow can be instantiated in many places (e.g. parser combinators).
 */
// Module-scope helpers for dedupClosureBodies below — deliberately NOT
// function-scoped consts captured by the nested walk closures: a function-
// scoped binding captured 2-3 arrow levels deep tripped a latent self-compile
// closure-capture defect (reference emitted without declaration,
// 'SENTINELf..._N is not in scope'; banked in .work/archive/todo.md 2026-08-19).
// Module-scope bindings never enter the capture machinery.
const dedupIsSentinel = (v) => v === undefined || v === null ||
  (typeof v === 'number' && !Number.isFinite(v))
const mix = (h, x) => Math.imul(h ^ x, 0x01000193) | 0
const mixStr = (h, str) => {
  for (let i = 0; i < str.length; i++) h = mix(h, str.charCodeAt(i))
  return h
}
const numberBits = new DataView(new ArrayBuffer(8))
const mixNumber = (h, n) => {
  numberBits.setFloat64(0, n || 0, true) // -0 and +0 share the exact comparator's class
  return mix(mix(mix(h, 11), numberBits.getUint32(0, true)), numberBits.getUint32(4, true))
}

export function dedupClosureBodies(closureFuncs, sec) {
  if (closureFuncs.length <= 1) return
  // Rename-invariant rolling hash + exact compare on hash collision.
  // The previous key was JSON.stringify of every closure's fully-renamed tree
  // -- measured at 810.76 MB of transient string churn on the jz x jz
  // region-live self-compile, 99.2% of the buildStartFn window
  // (.work/evidence.md 2026-08-19 attribution verdict). The hash walk copies
  // no IR and hashes f64 words without formatting them; the exact comparator
  // runs only within a hash bucket, preserving the dedup groups.
  // INVARIANT (grouping parity with the old stringify key): undefined, null,
  // NaN and +/-Infinity all serialized to the same JSON token 'null', so they
  // form ONE equivalence class in both the hash and the comparator below --
  // collapsing them differently would split/merge groups and change output.
  const localNamesOf = (fn) => {
    const names = new Map()
    walkAst(fn, { enter: node => {
      if ((node[0] === 'local' || node[0] === 'param') && typeof node[1] === 'string' && node[1][0] === '$' && !names.has(node[1]))
        names.set(node[1], names.size)
    } })
    return names
  }
  const hashOf = (fn, locals) => {
    const walk = (node, h) => {
      if (typeof node === 'string') {
        const ordinal = locals.get(node)
        if (ordinal !== undefined) return mix(mix(h, 5), ordinal)
        return mixStr(mix(h, 7), node)
      }
      if (dedupIsSentinel(node)) return mix(h, -2)
      if (typeof node === 'number') return mixNumber(h, node)
      if (typeof node === 'boolean') return mix(mix(h, 29), node ? 1 : 0)
      if (!Array.isArray(node)) return mixStr(mix(h, 17), String(node))
      h = mix(h, 19)
      for (const c of node) h = walk(c, h)
      return mix(h, 23)
    }
    let h = 0x811c9dc5 | 0
    for (let i = 2; i < fn.length; i++) h = walk(fn[i], h)
    return h
  }
  // A local's declaration ordinal gives its canonical name. Alpha-equivalent
  // trees have corresponding declarations, so hashing and exact equality can
  // share that one map instead of allocating a renaming map for each walk.
  const equalBodies = (fa, la, fb, lb) => {
    if (fa.length !== fb.length) return false
    const eq = (a, b) => {
      const as = typeof a === 'string', bs = typeof b === 'string'
      if (as || bs) {
        if (!as || !bs) return false
        const ra = la.get(a), rb = lb.get(b)
        return ra !== undefined || rb !== undefined ? ra === rb : a === b
      }
      const aa = Array.isArray(a), ba = Array.isArray(b)
      if (aa || ba) {
        if (!aa || !ba || a.length !== b.length) return false
        for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false
        return true
      }
      if (dedupIsSentinel(a) || dedupIsSentinel(b)) return dedupIsSentinel(a) && dedupIsSentinel(b)
      return a === b
    }
    for (let i = 2; i < fa.length; i++) if (!eq(fa[i], fb[i])) return false
    return true
  }
  const buckets = new Map()  // hash -> [{ fn, locals, name }]
  const redirect = new Map()
  for (const fn of closureFuncs) {
    const locals = localNamesOf(fn)
    const h = hashOf(fn, locals)
    const name = fn[1].slice(1)
    let bucket = buckets.get(h)
    if (!bucket) buckets.set(h, bucket = [])
    let canonical = null
    for (const cand of bucket) {
      if (equalBodies(fn, locals, cand.fn, cand.locals)) { canonical = cand.name; break }
    }
    if (canonical) redirect.set(name, canonical)
    else bucket.push({ fn, locals, name })
  }
  if (!redirect.size) return
  const kept = sec.funcs.filter(fn => {
    if (!Array.isArray(fn) || fn[0] !== 'func') return true
    const name = typeof fn[1] === 'string' && fn[1][0] === '$' ? fn[1].slice(1) : null
    return !name || !redirect.has(name)
  })
  // Retired onto walkAst (pipeline-minimality slice, `.work/archive/assemble-outliers.md`
  // §5): the hand-rolled recursion only ever rewrote bare `$name` STRING
  // children in place, never needed to see a node's own opcode slot as
  // anything but an inert string — an `enter` scan over every child
  // (including index 0, matching the original's unconditional loop; index 0
  // is always the opcode string here, never a redirect-map hit) is the same
  // single top-down pass, byte-identical.
  for (const fn of kept) walkAst(fn, { enter: n => {
    for (let i = 0; i < n.length; i++) {
      const c = n[i]
      if (typeof c === 'string' && c[0] === '$' && redirect.has(c.slice(1))) n[i] = `$${redirect.get(c.slice(1))}`
    }
  } })
  ctx.closure.table = ctx.closure.table.map(n => redirect.get(n) || n)
  sec.funcs.length = 0
  sec.funcs.push(...kept)
}

/**
 * Phase: closure-table finalize + ABI shrink.
 */
export function finalizeClosureTable(sec) {
  // callIndirectSeen: the TRUE fact — does ANYTHING in the actually-compiled,
  // reachability-resolved output really execute `call_indirect (type $ftN)`?
  // NEVER seeded by preserveClosureTable (unlike `indirectUsed` below): a WASM
  // table needs no type-section entry to be walked/called from OUTSIDE this
  // module (an embedder invoking exports.__jz_table.get(i)(...) doesn't touch
  // this module's own `call_indirect`), so keeping the table alive for an
  // external caller (preserveClosureTable's actual job) never implies `$ftN`
  // itself must exist — only an IN-MODULE call_indirect does. Drives $ftN's
  // presence in sec.types alone, at the end of this function, independent of
  // every other decision below (table/elem preservation, per-closure ABI
  // shrink) which legitimately DO stay gated on preserveClosureTable.
  const isCallIndirect = n => n[0] === 'call_indirect'
  let callIndirectSeen = sec.funcs.some(fn => some(fn, isCallIndirect))
  if (!callIndirectSeen) callIndirectSeen = sec.start.some(fn => some(fn, isCallIndirect))
  // Reached templates can be lazy (timer signatures depend on the settled
  // closure ABI). Resolve them before deciding whether the indirect type and
  // table are needed. The stdlib pull still realizes its templates after
  // allocator demand is settled.
  if (!callIndirectSeen) {
    resolveIncludes()
    for (const [name, tpl] of Object.entries(ctx.core.stdlib)) {
      if (!ctx.core.includes.has(name)) continue
      const text = typeof tpl === 'function' ? tpl() : tpl
      if (typeof text === 'string' && text.includes('call_indirect')) { callIndirectSeen = true; break }
    }
  }
  // indirectUsed: whether TABLE/ELEM/uniform-ABI must be preserved — real
  // call_indirect usage OR host:'wasi' preserveClosureTable's own reason
  // (an embedder may walk/call __jz_table from outside this module — see
  // callIndirectSeen's own doc for why that never implies $ftN must exist).
  const indirectUsed = callIndirectSeen || ctx.transform.targetProfile.preserveClosureTable
  // $ftN itself: present iff genuinely used, full stop — independent of every
  // branch below. Regressed 71 native tests once as a `.size`-on-ctx.closure.
  // types gate at the EARLIER push site (src/compile/index.js) that only
  // fired for a literally-minted closure, missing the generic-dynamic-dispatch
  // (tryGenericEmitter/tryDynamicPropCall) call_indirect users; then
  // regressed EVERY host:'wasi' compile once reverted to a bare module-loaded
  // truthiness check there, because preserveClosureTable used to also gate
  // OFF the $ftN-stripping `else` branch below, so wasi never reached it.
  // This is the one, sufficient, correctly-scoped fix: unconditional, driven
  // by callIndirectSeen alone, every host, every branch.
  if (!callIndirectSeen) sec.types = sec.types.filter(t => !(Array.isArray(t) && t[1] === '$ftN'))
  else if (!sec.types.some(t => Array.isArray(t) && t[1] === '$ftN')) {
    const params = [['param', 'f64'], ['param', 'i32']]
    for (let i = 0; i < (ctx.closure.width ?? MAX_CLOSURE_ARITY); i++) params.push(['param', 'f64'])
    if (ctx.closure.receiver) params.push(['param', 'f64'])
    sec.types.push(['type', '$ftN', ['func', ...params, ['result', 'f64']]])
  }
  if (indirectUsed) {
    if (!ctx.closure.table) ctx.closure.table = []
    sec.table = [['table', ...(ctx.transform.alloc === false || !ctx.transform.targetProfile.exportClosureTable ? [] : [['export', '"__jz_table"']]),
      ctx.closure.table.length, 'funcref']]
    sec.elem = ctx.closure.table.length ? [['elem', ['i32.const', 0], 'func', ...ctx.closure.table.map(n => `$${n}`)]] : []
    return
  }
  sec.table = []
  sec.elem = []
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
  const rewriteCalls = (node) => walkAst(node, { exit: n => {
    if ((n[0] === 'call' || n[0] === 'return_call') && typeof n[1] === 'string') {
      const callee = n[1].slice(1)
      const abi = abiOf.get(callee)
      if (!abi) return
      const newArgs = []
      if (abi.needEnv) newArgs.push(n[2])
      if (abi.needArgc) newArgs.push(n[3])
      for (let i = 0; i < abi.usedSlots; i++) newArgs.push(n[4 + i])
      if (ctx.closure.receiver) newArgs.push(n[4 + W])
      n.splice(2, n.length - 2, ...newArgs)
    }
  } })
  for (const fn of sec.funcs) rewriteCalls(fn)
  for (const fn of sec.start) rewriteCalls(fn)
}
