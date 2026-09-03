import { ctx, declGlobal } from '../ctx.js'

export const ensureThrowRuntime = (sec) => {
  // A pulled stdlib helper may throw $__jz_err even when no user `throw` set the
  // flag (e.g. __to_num on a Symbol). Detect it from the included stdlib bodies
  // so the $__jz_err tag is always present when something can raise it.
  if (!ctx.runtime.throws && [...ctx.core.includes].some(n => {
    const body = ctx.core.stdlib[n]
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
}
