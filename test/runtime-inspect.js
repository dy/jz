import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { captureRuntimeInspect } from '../src/compile/func-inspect.js'
import { onKernel } from './_matrix.js'

const inspect = (src, opts = {}) => compile(src, { ...opts, inspect: true }).inspect.runtime

test('runtime inspection: final exports include transitive allocation and host effects', () => {
  if (onKernel()) return
  const src = 'export function f(x){return x*2}'
  const plain = compile(src), first = compile(src, { inspect: true })
  is(first.wasm, plain, 'inspection does not change bytes')
  is(first.inspect.runtime.f, { noAllocation: true, noHostCalls: true, boundedWork: true, maxInstructions: 5 })
  is(inspect('export function f(n){return new Float64Array(n)}').f.noAllocation, null, 'allocation is not certified')
  is(inspect(src), first.inspect.runtime, 'A → allocating B → A has no leaked facts')
  is(inspect(src), first.inspect.runtime, 'A → A')
  const mod = ['module',
    ['func', '$host', ['import', '"env"', '"host"']],
    ['func', '$helper', ['call', '$host']],
    ['func', '$f', ['export', '"f"'], ['call', '$helper']]]
  is(captureRuntimeInspect(mod).f, { noAllocation: null, noHostCalls: null, boundedWork: null, maxInstructions: null })
  is(captureRuntimeInspect(['module']), {}, 'empty module')
})

test('runtime inspection: bounded counters, recursion and unknown work', () => {
  if (onKernel()) return
  const src = 'export function process(a){for(let i=0;i<128;i++)a[i]=a[i]*0.5}'
  for (const optimize of [0, 3]) {
    const r = inspect(src, { optimize, noSimd: true }).process
    is(r.noAllocation, true); is(r.noHostCalls, true); is(r.boundedWork, true)
    ok(Number.isSafeInteger(r.maxInstructions) && r.maxInstructions >= 128, 'conservative instruction bound')
  }
  const get = (body, shared = false) => captureRuntimeInspect(['module', ['func', '$f', ['export', '"f"'], ...body]], shared).f
  is(get([['call', '$f']]).boundedWork, null, 'recursion')
  is(get([['call_indirect', ['type', '$t'], ['i32.const', 0]]]).noHostCalls, null, 'indirect target')
  is(get([['memory.copy', ['i32.const', 0], ['i32.const', 0], ['local.get', '$n']]]).boundedWork, null, 'bulk work')
  is(get([['i32.store', ['i32.const', 0], ['i32.const', 1]]], true).noAllocation, null, 'shared allocator may live in memory')
  const loop = ['loop', '$loop', ['local.set', '$i', ['i32.add', ['local.get', '$i'], ['i32.const', 2]]],
    ['br_if', '$loop', ['i32.lt_u', ['local.get', '$i'], ['i32.const', -1]]]]
  is(get([loop]).boundedWork, null, 'stride may skip the unsigned exit forever')
  loop[2] = ['if', ['local.get', '$c'], ['then', loop[2]]]
  is(get([loop]).boundedWork, null, 'conditional progress')
  is(get([['loop', '$loop', ['br', '$loop']]]).boundedWork, null, 'infinite loop')
})

test('runtime inspection: nondecimal counter immediates cannot forge a work proof', () => {
  const inspectLoop = (step, bound) => captureRuntimeInspect(['module',
    ['func', '$f', ['export', '"f"'], ['local', '$i', 'i32'],
      ['loop', '$loop', ['local.set', '$i', ['i32.add', ['local.get', '$i'], ['i32.const', step]]],
        ['br_if', '$loop', ['i32.lt_u', ['local.get', '$i'], ['i32.const', bound]]]]]]).f.boundedWork
  // Both even strides skip UINT32_MAX forever. Decimal-prefix parsing would
  // read the bound as 0, or the stride as 1, and incorrectly certify the loop.
  is(inspectLoop(2, '0xffffffff'), null)
  is(inspectLoop('1_000', 4294967295), null)
})
