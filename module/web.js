/**
 * web — callable host web globals (`fetch(...)`), bound automatically.
 *
 * Under host:'js' a bare `fetch(url, opts?)` lowers to an `env.fetch` import
 * that interop wires from `globalThis.fetch` with full marshalling — the
 * returned thenable adopts into a jz promise, so `await fetch(url)` works and
 * the Response crosses as an external handle (`.text()`/`.json()` dispatch
 * host-side and are awaitable in turn). No import statement needed.
 *
 * Under host:'wasi' there is no JS host to bind — a warning is emitted and
 * the env import is still declared, so an embedder MAY wire `env.fetch`
 * itself; an unwired module fails at instantiation, not silently.
 *
 * @module web
 */

import { typed, asI64, UNDEF_NAN } from '../src/ir.js'
import { emit, hostImport } from '../src/bridge.js'
import { warn } from '../src/ctx.js'

const ARITY = { fetch: 2 }

export default (ctx) => {
  for (const [name, arity] of Object.entries(ARITY)) {
    ctx.core.emit[name] = (...args) => {
      if (ctx.transform.host === 'wasi')
        warn('host-global', `\`${name}\` binds from the JS host — under host:'wasi' wire env.${name} yourself or instantiation will fail`, {})
      hostImport('env', name, ['func', `$__env_${name}`,
        ...Array.from({ length: arity }, () => ['param', 'i64']), ['result', 'i64']])
      const ir = [`call`, `$__env_${name}`]
      for (let i = 0; i < arity; i++)
        ir.push(args[i] != null ? asI64(emit(args[i])) : ['i64.const', UNDEF_NAN])
      return typed(['f64.reinterpret_i64', ir], 'f64')
    }
  }
}
