import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { compile } from '../index.js'
import { memory, wrap, toModule, offset, UNDEF_NAN } from '../interop.js'
import { TOMB_NAN } from '../layout.js'

const TOMB = BigInt(TOMB_NAN)
const sameArray = (got, want, label) => {
  is(got.length, want.length, `${label}: length`)
  is(Object.keys(got), Object.keys(want), `${label}: present indices`)
  for (const key of Object.keys(want)) {
    if (Array.isArray(want[key])) sameArray(got[key], want[key], `${label}[${key}]`)
    else ok(Object.is(got[key], want[key]), `${label}[${key}]: value`)
  }
}

test('array holes interop: encode and decode preserve absent and undefined cells', () => {
  const mem = memory()
  const a = [, undefined, -0, NaN, [, undefined, 3]], b = [undefined, , 9]
  for (const value of [[], new Array(1), [undefined], a, a, b, [], a]) {
    const box = mem.Array(value), view = new DataView(mem.buffer)
    for (let i = 0; i < value.length; i++) {
      const bits = view.getBigInt64(offset(box) + i * 8, true)
      is(bits === TOMB, !(i in value), `index ${i}: only absence stores the hole marker`)
      if (i in value && value[i] === undefined) is(bits, UNDEF_NAN, 'present undefined keeps its value marker')
    }
    sameArray(mem.read(box), value, 'round trip')
  }
  sameArray(mem.read(mem.Array('ab')), ['a', 'b'], 'string array-like input')
  const inherited = Object.create({ 1: 8 }); inherited.length = 3; inherited[2] = undefined
  sameArray(mem.read(mem.Array(inherited)), [, 8, undefined], 'inherited indexed values still copy in')
})

test('array holes interop: staged writes preserve holes across growth and failed inputs', () => {
  const mem = memory(), box = mem.Array([1, 2, 3, 4])
  const long = 'x'.repeat(70000), a = [, undefined, long, -0], b = [undefined, 5, , 7]
  for (const value of [[], new Array(1), a, a, b, [], a]) {
    mem.write(box, value)
    sameArray(mem.read(box), value, 'rewrite')
  }
  const bad = { length: 4, 0: 'y'.repeat(90000), get 1() { throw Error('staging failed') } }
  throws(() => mem.write(box, bad), /staging failed/)
  sameArray(mem.read(box), a, 'failed staging leaves every old cell and length intact')
  throws(() => mem.write(box, new Array(5)), /capacity/)
  sameArray(mem.read(box), a, 'capacity failure leaves the sparse value intact')
  let reads = 0
  const source = { length: 4, get 0() { reads++; delete this[1]; this[2] = undefined; return 6 }, 1: 8 }
  mem.write(box, source)
  is(reads, 1, 'a present getter runs once')
  sameArray(mem.read(box), [6, , undefined, ,], 'each later presence test sees the earlier getter effect')
  mem.write(box, b)
  sameArray(mem.read(box), b, 'the same destination remains reusable after errors')
})

test('array holes interop: Array+ copy-back preserves identity and follows sparse forwarding', () => {
  // Exercise the boundary against the compiler's real Array+ contract, with
  // controlled raw exports that write the reserved cell states directly.
  const module = toModule(compile('export function change(a, mode) { if (mode) a[0] = undefined; return a }'))
  const contract = JSON.parse(new TextDecoder().decode(WebAssembly.Module.customSections(module, 'jz:i64exp')[0]))
  is(contract.find(e => e.name === 'change').t['0'], 'Array+', 'the fixture uses boxed array copy-back')
  const mem = memory()
  const change = (box, rawMode) => {
    const mode = mem.read(rawMode), base = offset(box)
    if (mode === 1) {
      const view = new DataView(mem.buffer), n = view.getInt32(base - 8, true)
      if (n > 0) view.setBigInt64(base, TOMB, true)
      if (n > 1) view.setBigInt64(base + 8, UNDEF_NAN, true)
      if (n > 2) view.setFloat64(base + 16, 9, true)
    } else if (mode === 2) {
      const moved = mem.Array([, undefined, 8, , 10])
      mem.alloc(70000)
      const view = new DataView(mem.buffer)
      view.setInt32(base - 8, offset(moved), true)
      view.setInt32(base - 4, -1, true)
    } else if (mode === 3) {
      const view = new DataView(mem.buffer), child = offset(view.getBigInt64(base, true))
      view.setBigInt64(child, TOMB, true)
      view.setBigInt64(child + 8, UNDEF_NAN, true)
    }
    return box
  }
  const api = wrap({ module, exports: { memory: mem, change } })
  const a = [1, 2, 3], b = [4, 5], empty = []
  for (const [value, mode, expected] of [
    [empty, 0, []], [a, 0, [1, 2, 3]], [a, 1, [, undefined, 9]],
    [a, 1, [, undefined, 9]], [b, 1, [, undefined]], [empty, 1, []],
    [a, 2, [, undefined, 8, , 10]], [a, 0, [, undefined, 8, , 10]],
  ]) {
    ok(api.change(value, mode) === value, 'returning the argument preserves host identity')
    sameArray(value, expected, `mode ${mode}`)
  }
  const child = [4, 5, 6], nested = [child, , undefined]
  ok(api.change(nested, 3) === nested && nested[0] === child, 'nested arrays keep their original identities')
  sameArray(nested, [[, undefined, 6], , undefined], 'nested sparse copy-back')
})
