/**
 * web: the host's globals. Callable web globals (`fetch(...)`), bound
 * automatically, and any global the program names without declaring it.
 *
 * Under host:'js' a bare `fetch(url, opts?)` lowers to an `env.fetch` import
 * that interop wires from `globalThis.fetch` with full marshalling — the
 * returned thenable adopts into a jz promise, so `await fetch(url)` works and
 * the Response crosses as an external handle (`.text()`/`.json()` dispatch
 * host-side and are awaitable in turn). No import statement needed.
 *
 * A name no declaration of its module binds and the target does not resolve
 * (`WritableStream`, `Response`: prepare's `hostFree`) is the host's global of
 * that name, imported as `(import "global" "Name" (global i64))`: interop binds
 * the host's value, or an absent marker where the host has none, whose read is
 * the ReferenceError the read of an undeclared name throws. `typeof` of one
 * answers 'undefined' there instead; `new` of one constructs on the host, and
 * `instanceof` one asks the host for a host value, while a value of the
 * program is no instance of a host class.
 *
 * Under host:'wasi' there is no JS host to bind — a warning is emitted and
 * the env import is still declared, so an embedder MAY wire `env.fetch`
 * itself; an unwired module fails at instantiation, not silently. A global
 * the program does not declare stays unresolved there.
 *
 * @module web
 */

import { typed, asI64, asF64, UNDEF_NAN, temp, tempI64 } from '../src/ir.js'
import { emit, hostImport, storedValue } from '../src/bridge.js'
import { warn, inc, setLinkDemand } from '../src/ctx.js'
import { PTR, LAYOUT, TOMB_NAN, encodePtrHi } from '../layout.js'

const ARITY = { fetch: 2 }

export default (ctx) => {
  for (const [name, arity] of Object.entries(ARITY)) {
    ctx.core.emit[name] = (...args) => {
      if (!ctx.transform.targetProfile.envImports)
        warn('host-global', `\`${name}\` binds from the JS host — under host:'wasi' wire env.${name} yourself or instantiation will fail`, {})
      hostImport('env', name, ['func', `$__env_${name}`,
        ...Array.from({ length: arity }, () => ['param', 'i64']), ['result', 'i64']])
      const ir = [`call`, `$__env_${name}`]
      for (let i = 0; i < arity; i++)
        ir.push(args[i] != null ? asI64(emit(args[i])) : ['i64.const', UNDEF_NAN])
      return typed(['f64.reinterpret_i64', ir], 'f64')
    }
  }

  // The host's global `name`: its import's value (compile/index.js drains
  // ctx.core.hostFree into the imports), the absent marker its ReferenceError.
  const hostGlobal = (name) => {
    setLinkDemand('external')
    ctx.core.hostFree.add(name)
    return ['global.get', `$__hg_${name}`]
  }
  const isExternal = (bits) => ['i32.eq', ['i32.wrap_i64', ['i64.shr_u', bits, ['i64.const', LAYOUT.TAG_SHIFT]]],
    ['i32.const', encodePtrHi(PTR.EXTERNAL, 0) >>> LAYOUT.TAG_SHIFT - 32]]

  ctx.core.emit['__host_global'] = (nameNode) => {
    const name = nameNode[1]
    ctx.runtime.throws = ctx.runtime.userThrows = true
    const v = tempI64('hg'), e = temp('hge')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${v}`, hostGlobal(name)],
      ['if', ['i64.eq', ['local.get', `$${v}`], ['i64.const', TOMB_NAN]],
        ['then',
          ['local.set', `$${e}`, asF64(emit(['()', 'ReferenceError', ['str', `${name} is not defined`]]))],
          ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['local.get', `$${e}`]]],
          ['throw', '$__jz_err', ['local.get', `$${e}`]]]],
      ['f64.reinterpret_i64', ['local.get', `$${v}`]]], 'f64')
  }

  // typeof of the host's global: 'undefined' where the host has none; a host
  // object answers 'function' where the host can call it.
  ctx.core.emit['__host_typeof'] = (nameNode) => {
    const name = nameNode[1]
    inc('__ext_callable')
    const v = tempI64('ht'), t = temp('htv')
    const bits = ['local.get', `$${v}`]
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${v}`, hostGlobal(name)],
      ['if', ['result', 'f64'], ['i64.eq', bits, ['i64.const', TOMB_NAN]],
        ['then', asF64(emit(['str', 'undefined']))],
        ['else', ['if', ['result', 'f64'], isExternal(bits),
          ['then', ['if', ['result', 'f64'], ['call', '$__ext_callable', bits],
            ['then', asF64(emit(['str', 'function']))], ['else', asF64(emit(['str', 'object']))]]],
          ['else', ['block', ['result', 'f64'],
            ['local.set', `$${t}`, ['f64.reinterpret_i64', bits]],
            asF64(emit(['typeof', ['__raw_local', t]]))]]]]]], 'f64')
  }

  // `new C(...args)` of a host constructor: the host constructs (Reflect.construct).
  ctx.core.emit['__host_new'] = (ctor, ...args) => {
    setLinkDemand('external')
    inc('__ext_construct')
    const c = temp('hn')
    const list = ['[', ...args]
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${c}`, asF64(emit(ctor))],
      ['f64.reinterpret_i64', ['call', '$__ext_construct', ['i64.reinterpret_f64', ['local.get', `$${c}`]], asI64(emit(list))]]], 'f64')
  }

  // `v instanceof C` for a host class C: the host answers for a host value; a
  // value of the program is none of its instances (a non-callable C still throws).
  ctx.core.emit['__host_instanceof'] = (val, ctor) => {
    setLinkDemand('external')
    inc('__ext_instanceof')
    const a = temp('hiv')
    return typed(['block', ['result', 'i32'],
      ['local.set', `$${a}`, asF64(storedValue(val))],
      ['call', '$__ext_instanceof', ['i64.reinterpret_f64', ['local.get', `$${a}`]], asI64(emit(ctor))]], 'i32')
  }

  ctx.core.stdlib['__ext_construct'] = '(import "env" "__ext_construct" (func $__ext_construct (param i64 i64) (result i64)))'
  ctx.core.stdlib['__ext_instanceof'] = '(import "env" "__ext_instanceof" (func $__ext_instanceof (param i64 i64) (result i32)))'
  // whether the host can call a host object (interop.js): a host global's typeof
  ctx.core.stdlib['__ext_callable'] = '(import "env" "__ext_callable" (func $__ext_callable (param i64) (result i32)))'
}
