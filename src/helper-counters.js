import { ctx, declGlobal, inc } from './ctx.js'
import { findBodyStart } from './ir.js'

export const HELPER_COUNTERS = [
  ['__eq', 'eq'],
  ['__same_value_zero', 'same_value_zero'],
  ['__is_truthy', 'is_truthy'],
  ['__ptr_type', 'ptr_type'],
  ['__ptr_offset', 'ptr_offset'],
  ['__len', 'len'],
  ['__length', 'length'],
  ['__typed_idx', 'typed_idx'],
  ['__str_len', 'str_len'],
  ['__str_eq', 'str_eq'],
  ['__str_eq_cold', 'str_eq_cold'],
  ['__str_hash', 'str_hash'],
  ['__map_hash', 'map_hash'],
  ['__hash_get_local', 'hash_get_local'],
  ['__hash_set_local', 'hash_set_local'],
  ['__ihash_get_local', 'ihash_get_local'],
  ['__ihash_set_local', 'ihash_set_local'],
  ['__dyn_get', 'dyn_get'],
  ['__dyn_get_t', 'dyn_get_t'],
  ['__dyn_get_t_h', 'dyn_get_t_h'],
  ['__dyn_get_expr', 'dyn_get_expr'],
  ['__dyn_get_expr_t', 'dyn_get_expr_t'],
  ['__dyn_get_expr_t_h', 'dyn_get_expr_t_h'],
  ['__dyn_get_any', 'dyn_get_any'],
  ['__dyn_get_any_t', 'dyn_get_any_t'],
  ['__dyn_get_any_t_h', 'dyn_get_any_t_h'],
  ['__dyn_set', 'dyn_set'],
  ['__arr_grow', 'arr_grow'],
  ['__arr_grow_known', 'arr_grow_known'],
  ['__arr_push1', 'arr_push1'],
  ['__arr_shift', 'arr_shift'],
  ['__alloc', 'alloc'],
  ['__alloc_hdr', 'alloc_hdr'],
  ['__alloc_hdr_n', 'alloc_hdr_n'],
  ['__memgrow', 'memgrow'],
]

const COUNTER_BY_HELPER = new Map(HELPER_COUNTERS.map(([helper, label]) => [helper, `__hc_${label}`]))
const LABEL_BY_WAT_HELPER = new Map(HELPER_COUNTERS.map(([helper, label]) => [`$${helper}`, label]))

export const HELPER_SITE_PREFIX = '__hcs_'

export const helperCounterName = helper => COUNTER_BY_HELPER.get(helper)

export function installHelperCounters() {
  if (!ctx.transform.helperCounters) return
  for (const counter of COUNTER_BY_HELPER.values()) {
    if (!ctx.scope.globals.has(counter)) declGlobal(counter, 'i64', 0, { export: counter })
  }
  ctx.core.stdlib.__helper_counts_reset = `(func $__helper_counts_reset (export "__helper_counts_reset")
${[...COUNTER_BY_HELPER.values()].map(counter => `    (global.set $${counter} (i64.const 0))`).join('\n')})`
  inc('__helper_counts_reset')
}

// Bump the helper's counter once on entry. NOTE the semantics: this counts FUNCTION
// ENTRIES at runtime — a call site that jz inlined or specialized away (fusedRewrite,
// specializeMkptr, …) never enters the function and is NOT counted. So
// the numbers are a relative ranking / lower bound for picking hot helpers, not exact
// operation counts. Good enough to choose targets; don't read them as call totals.
export function instrumentHelperCounter(helper, fn) {
  const counter = ctx.transform.helperCounters && helperCounterName(helper)
  if (!counter || !Array.isArray(fn) || fn[0] !== 'func') return fn
  fn.splice(findBodyStart(fn), 0,
    ['global.set', `$${counter}`, ['i64.add', ['global.get', `$${counter}`], ['i64.const', 1]]])
  return fn
}

const safeExportPart = name => String(name || 'anon')
  .replace(/^\$/, '')
  .replace(/[^A-Za-z0-9_.-]+/g, '_')
  .slice(0, 80) || 'anon'

const helperSiteFilter = () => {
  const opt = ctx.transform.helperCallsites
  if (opt === true) return null
  const raw = Array.isArray(opt) ? opt : String(opt || '').split(',')
  const labels = raw.map(s => String(s).trim()).filter(Boolean).map(s => s.replace(/^\$?__/, ''))
  return labels.length ? new Set(labels) : null
}

const funcResults = fn => {
  const out = []
  if (!Array.isArray(fn) || fn[0] !== 'func') return out
  for (let i = 2; i < fn.length; i++) {
    const n = fn[i]
    if (Array.isArray(n) && n[0] === 'result') out.push(...n.slice(1))
  }
  return out
}

const bumpCounter = counter =>
  ['global.set', `$${counter}`, ['i64.add', ['global.get', `$${counter}`], ['i64.const', 1]]]

// Profiling-only helper-callsite counters. Unlike instrumentHelperCounter(), this
// answers "which compiled function executed the helper call?" by wrapping each
// final `(call $__helper ...)` with a tiny counter block:
//   (block (result T) (global.set $__hcs_N ...) (call $__helper ...))
//
// This intentionally runs after whole-module optimization. The profile should
// observe final codegen, while production output remains byte-identical because
// ctx.transform.helperCallsites is build-time opt-in.
export function instrumentHelperCallsites(funcs) {
  if (!ctx.transform.helperCallsites) return 0
  const only = helperSiteFilter()

  const resultsByName = new Map()
  for (const fn of funcs) {
    if (Array.isArray(fn) && fn[0] === 'func' && typeof fn[1] === 'string')
      resultsByName.set(fn[1], funcResults(fn))
  }

  let id = 0
  const wrap = (node, owner) => {
    if (!Array.isArray(node)) return node
    for (let i = 1; i < node.length; i++) node[i] = wrap(node[i], owner)

    if (node[0] !== 'call' || typeof node[1] !== 'string') return node
    const label = LABEL_BY_WAT_HELPER.get(node[1])
    if (!label) return node
    if (only && !only.has(label) && !only.has(node[1].replace(/^\$?__/, ''))) return node
    const results = resultsByName.get(node[1])
    if (!results) return node

    const counter = `${HELPER_SITE_PREFIX}${id++}`
    const ownerPart = safeExportPart(owner)
    declGlobal(counter, 'i64', 0, { export: `${counter}:${label}:${ownerPart}` })
    const block = ['block']
    for (const type of results) block.push(['result', type])
    block.push(bumpCounter(counter), node)
    return block
  }

  for (const fn of funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func' || typeof fn[1] !== 'string') continue
    const bodyStart = findBodyStart(fn)
    for (let i = bodyStart; i < fn.length; i++) fn[i] = wrap(fn[i], fn[1])
  }
  return id
}
