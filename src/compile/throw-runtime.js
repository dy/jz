import { ctx, declGlobal } from '../ctx.js'

export const ensureThrowRuntime = (sec) => {
  // A pulled stdlib helper may throw $__jz_err even when no user `throw` set the
  // flag (e.g. __to_num on a Symbol). Detect it from the included stdlib bodies
  // so the $__jz_err tag is always present when something can raise it.
  if (!ctx.runtime.throws && [...ctx.core.includes].some(n => {
    let body = ctx.core.stdlib[n]
    if (typeof body === 'function') ctx.core.stdlib[n] = body = body()   // realized once, as stdlib-pull would
    return typeof body === 'string' && body.includes('(throw ')
  })) ctx.runtime.throws = true
  if (!ctx.runtime.throws) return

  if (!ctx.scope.globals.has('__jz_last_err_bits'))
    declGlobal('__jz_last_err_bits', 'i64')
  if (!sec.tags.some(t => Array.isArray(t) && t[0] === 'tag' && t[1] === '$__jz_err'))
    sec.tags.push(['tag', '$__jz_err', ['param', 'f64']])
  if (ctx.transform.alloc !== false &&
      !sec.tags.some(t => Array.isArray(t) && t[0] === 'export' && t[1] === '"__jz_last_err_bits"'))
    sec.tags.push(['export', '"__jz_last_err_bits"', ['global', '$__jz_last_err_bits']])
  // The host passes integer bits; crossing as f64 would canonicalize boxed NaNs
  // on some engines. The throw itself uses the same private tag as source code.
  if (ctx.runtime.hostThrows) {
    sec.tags.push(['export', '"__jz_err"', ['tag', '$__jz_err']])
    sec.funcs.push(['func', '$__jz_throw_host',
    ['export', '"__jz_throw_host"'], ['param', '$value', 'i64'],
    ['global.set', '$__jz_last_err_bits', ['local.get', '$value']],
    ['throw', '$__jz_err', ['f64.reinterpret_i64', ['local.get', '$value']]]])
  }
}
