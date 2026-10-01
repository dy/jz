// An element store whose index the summary cannot bound (`out[k] = v` into an
// array that grew last round, `indices[k] = indices[k + 1]`) stores in place
// when the index is inside the length and asks the helper only past it: the
// helper's growth, its hole fill and its negative-index property write are
// unchanged (emit-assign.js storeArrayPayload).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const fnText = (text, name) => funcWat(text, name + '$exp') || funcWat(text, name)

const src = `const out = []
  export const fill = (n) => { for (let i = 0; i < n; i++) out[i] = i * 2; return out.length }
  export const at = (i) => out[i] === undefined ? -1 : out[i]
  export const shift = (n) => { for (let k = 0; k < n; k++) out[k] = out[k + 1]; return out[0] }
  export const gap = () => { const v = [1]; v[3] = 4; return v.length * 10 + (v[1] === undefined ? 1 : 0) }
  export const neg = () => { const v = [1, 2]; v[-1] = 9; return v.length * 10 + v[0] }`

test('index store: growth, in-place stores, holes and a negative index answer what the host answers', () => {
  for (const optimize of levels(0, 2, 3)) {
    const host = oracle(src), jz = run(src, { optimize })
    const steps = [['fill', 5], ['at', 3], ['at', 5], ['fill', 3], ['at', 4], ['shift', 4], ['at', 0], ['at', 3], ['fill', 8], ['at', 7], ['gap'], ['neg']]
    for (const [name, ...args] of steps) is(jz[name](...args), host[name](...args), `${name}(${args.join(', ')}) at ${optimize}`)
  }
})

test('index store: the in-range store is a plain store, the helper stands behind the bounds test', () => {
  if (belowOpt(2)) return
  const body = fnText(wat(src, { optimize: 2 }), 'fill')
  ok(/f64\.store/.test(body), 'the in-range arm stores directly')
  ok(/call \$__arr_set_idx_ptr/.test(body), 'the helper remains for an index at or past the end')
  ok(/i32\.lt_u/.test(body), 'one unsigned bounds test decides between them')
})

test('index store: possibly absent Number keys retain their named property', () => {
  const source = `export function f(mode) {
    const a = [2, 3]; let index; if (mode) index = 0
    const before = a[index]; let effects = 0
    const assigned = a[index] = (effects++, 19)
    return [before, assigned, a[0], a[index], effects]
  }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const host = oracle(source), wasm = run(source, { optimize })
    for (const mode of [0, 0, 1, 0]) is(wasm.f(mode), host.f(mode), `O${optimize}, mode ${mode}`)
  }
})

test('index store: boxed keys agree across reads, growth and aliases', () => {
  const source = `export function f(mode, count) {
    const a = []; for (let i = 0; i < count; i++) a.push(i + 2)
    const alias = a
    let key
    if (mode === 1) key = 0
    else if (mode === 2) key = null
    else if (mode === 3) key = false
    else if (mode === 4) key = true
    else if (mode === 5) key = 'tag'
    else if (mode === 6) key = 1n
    else if (mode === 7) key = NaN
    const before = a[key]; let effects = 0
    const value = a[key] = (effects++, 19)
    a[8] = 31
    return [before, value, a[key], alias[key], a[0], a[1], a.length, effects]
  }
  export function boolean(n) { const a = [2]; a[n > 0] = 19; return [a[n > 0], a[0], a.length] }
  export function replace(mode) {
    const a = [{ x: 2 }]; let key; if (mode) key = 0
    a[key] = { x: 19 }; return [a[key].x, a[0].x]
  }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const host = oracle(source), wasm = run(source, { optimize })
    for (const count of [0, 1, 2]) for (const mode of [0, 1, 2, 3, 4, 5, 6, 7, 0])
      is(wasm.f(mode, count), host.f(mode, count), `O${optimize}, key ${mode}, length ${count}`)
    for (const mode of [0, 1, 0]) {
      is(wasm.boolean(mode), host.boolean(mode), `O${optimize}: boolean expression ${mode}`)
      is(wasm.replace(mode), host.replace(mode), `O${optimize}: object value ${mode}`)
    }
  }
})

test('index store: receiver, key and RHS are captured before key coercion', () => {
  const source = `export function f(mode) {
    let effects = 0; const a = [2, 3]
    let key = { toString() { effects = effects * 10 + 3; if (mode === 2) throw 7; return mode ? '1' : 'name' } }
    try {
      const assigned = a[(effects = effects * 10 + 1, key)] =
        (effects = effects * 10 + 2, key = { toString() { return 'other' } }, 19)
      return [assigned, a[1], a.name, a.other, effects]
    } catch (e) { return [e, a[1], a.name, a.other, effects] }
  }
  export function rebind(key, rhs) {
    let a = [2, 3]; const old = a, b = [4, 5]
    const v = rhs ? a[key] = (a = b, 19) : a[(a = b, key)] = 19
    return [v, old[key], a[key], old[0], a[0]]
  }`
  for (const level of levels(0, 1, 2, 3, 'size')) {
    // Keep the coercion callback and its captured mutation as an actual call.
    const host = oracle(source), wasm = run(source, { optimize: { level, sourceInline: false } })
    for (const mode of [0, 0, 2, 1, 0]) is(wasm.f(mode), host.f(mode), `O${level}, mode ${mode}`)
    for (const rhs of [0, 1]) for (const key of [undefined, 0, 3, 'x'])
      is(wasm.rebind(key, rhs), host.rebind(key, rhs), `O${level}, rebind ${rhs}, key ${key}`)
  }
})
