/**
 * Early-exit iteration family: .some/.every/.findIndex/.find/
 * .findLastIndex/.findLast, all built from one factory (init value, exit
 * test, value on match, optional reverse walk). Pure move from
 * module/array.js (pipeline-minimality) — single cluster, matches the
 * collection.js probe-family shape (one parametrized generator, several
 * adjacent call sites, all sharing it).
 *
 * @module array/early-exit
 */
import { typed, temp, freshId, truthyIR, UNDEF_NAN } from '../../src/ir.js'
import { ctx } from '../../src/ctx.js'
import { callbackLoop, hoistArrayValue, makeCallback, callbackArgReps, callbackElem, idxArg, arrArg } from './callback.js'

export const registerEarlyExit = () => {
  // Early-exit callback iterator: init value, exit test, value on match.
  const earlyExitMethod = ({ tag, init, test, onMatch, reverse, visitMissing }) => (arr, fn, thisArg) => {
    const recv = hoistArrayValue(arr)
    const r = temp(tag)
    const exit = `$exit${freshId(ctx)}`
    const reps = callbackArgReps(arr), mayMiss = visitMissing && (!recv.fixed || !recv.dense)
    if (mayMiss) reps[0] = null
    const cb = makeCallback(fn, reps, mayMiss ? null : callbackElem(arr), thisArg)
    const loop = callbackLoop(recv, (_ptr, _len, i, item) => [
      ['if', test(cb, i, item, recv),
        ['then', ['local.set', `$${r}`, onMatch(cb, i, item)], ['br', exit]]]
    ], undefined, undefined, reverse, { visitMissing })
    return typed(['block', ['result', 'f64'],
      recv.setup,
      cb.setup, cb.check,
      ['local.set', `$${r}`, init],
      ['block', exit, ...loop],
      ['local.get', `$${r}`]], 'f64')
  }

  ctx.core.emit['.some'] = earlyExitMethod({
    tag: 'sr',
    init: ['f64.const', 0],
    test: (cb, i, item, recv) => truthyIR(cb.call([item, idxArg(cb, i), arrArg(cb, recv.value)])),
    onMatch: () => ['f64.const', 1],
  })

  ctx.core.emit['.every'] = earlyExitMethod({
    tag: 'ev',
    init: ['f64.const', 1],
    test: (cb, i, item, recv) => ['i32.eqz', truthyIR(cb.call([item, idxArg(cb, i), arrArg(cb, recv.value)]))],
    onMatch: () => ['f64.const', 0],
  })

  ctx.core.emit['.findIndex'] = earlyExitMethod({
    tag: 'fi', visitMissing: true,
    init: ['f64.const', -1],
    test: (cb, i, item, recv) => truthyIR(cb.call([item, idxArg(cb, i), arrArg(cb, recv.value)])),
    onMatch: (_cb, i) => ['f64.convert_i32_s', ['local.get', `$${i}`]],
  })

  ctx.core.emit['.find'] = earlyExitMethod({
    tag: 'ff', visitMissing: true,
    init: ['f64.reinterpret_i64', ['i64.const', UNDEF_NAN]],
    test: (cb, i, item, recv) => truthyIR(cb.call([item, idxArg(cb, i), arrArg(cb, recv.value)])),
    onMatch: (_cb, _i, item) => item,
  })

  ctx.core.emit['.findLastIndex'] = earlyExitMethod({
    tag: 'fli', visitMissing: true,
    init: ['f64.const', -1],
    test: (cb, i, item, recv) => truthyIR(cb.call([item, idxArg(cb, i), arrArg(cb, recv.value)])),
    onMatch: (_cb, i) => ['f64.convert_i32_s', ['local.get', `$${i}`]],
    reverse: true,
  })

  ctx.core.emit['.findLast'] = earlyExitMethod({
    tag: 'fl', visitMissing: true,
    init: ['f64.reinterpret_i64', ['i64.const', UNDEF_NAN]],
    test: (cb, i, item, recv) => truthyIR(cb.call([item, idxArg(cb, i), arrArg(cb, recv.value)])),
    onMatch: (_cb, _i, item) => item,
    reverse: true,
  })
}
