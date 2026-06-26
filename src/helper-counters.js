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
// specializeMkptr/specializePtrBase, …) never enters the function and is NOT counted. So
// the numbers are a relative ranking / lower bound for picking hot helpers, not exact
// operation counts. Good enough to choose targets; don't read them as call totals.
export function instrumentHelperCounter(helper, fn) {
  const counter = ctx.transform.helperCounters && helperCounterName(helper)
  if (!counter || !Array.isArray(fn) || fn[0] !== 'func') return fn
  fn.splice(findBodyStart(fn), 0,
    ['global.set', `$${counter}`, ['i64.add', ['global.get', `$${counter}`], ['i64.const', 1]]])
  return fn
}
