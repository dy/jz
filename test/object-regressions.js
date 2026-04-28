import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { run } from './util.js'

test('Regression: Object.assign overwrites existing field from subset schema', () => {
  const { f } = run(`export let f = () => {
    let target = {x: 1, y: 2}
    let patch = {x: 10}
    let out = Object.assign(target, patch)
    return [out.x, target.x, target.y]
  }`)
  const out = f()
  is(out[0], 10)
  is(out[1], 10)
  is(out[2], 2)
})

test('Regression: Object.assign extends target with new fields', () => {
  const { f } = run(`export let f = () => {
    let target = {x: 1}
    let left = {y: 2}
    let right = {z: 3}
    Object.assign(target, left, right)
    return target.x + target.y + target.z
  }`)
  is(f(), 6)
})

test('Regression: mem.write partial object update preserves omitted fields', async () => {
  const r = await WebAssembly.instantiate(compile(`
    export let make = () => ({x: 1, y: 2, z: 3})
    export let read = (o) => [o.x, o.y, o.z]
  `))
  const m = jz.memory(r)
  const ptr = r.instance.exports.make()
  m.write(ptr, { y: 99 })
  const out = r.instance.exports.read(ptr)
  is(out[0], 1)
  is(out[1], 99)
  is(out[2], 3)
})

test('Regression: compile survives focused object mutation cases', () => {
  const wasm = compile(`
    export let f = () => {
      let target = {x: 1}
      Object.assign(target, {y: 2})
      return target.x + target.y
    }
  `)
  ok(wasm instanceof Uint8Array, 'object mutation regression compiles')
})

// Pre-existing bug surfaced while writing slot-type tests:
// `let o = w == 0 ? mkA() : mkB()` where both arms returned narrowed-i32 OBJECT
// pointers used to emit `(f64.convert_i32_s (if (result i32) ...))` — numeric
// convert of the offset rather than NaN-rebox. Subsequent `o.prop` then read
// from invalid memory. Fix: `?:` emit propagates matching ptrKind/ptrAux from
// both arms so downstream `asF64` takes the rebox path.
test('Regression: ?: with two narrowed-OBJECT helpers preserves pointer identity', () => {
  const { f } = run(`
    let mkA = () => ({ x: 11 })
    let mkB = () => ({ x: 22 })
    export let f = (w) => {
      let o = w == 0 ? mkA() : mkB()
      return o.x
    }
  `)
  is(f(0), 11)
  is(f(1), 22)
})

test('Regression: ?: with multi-prop OBJECT branches', () => {
  const { f } = run(`
    let a = () => ({ x: 1, y: 2 })
    let b = () => ({ x: 3, y: 4 })
    export let f = (w) => {
      let o = w == 0 ? a() : b()
      return o.x + o.y
    }
  `)
  is(f(0), 3)
  is(f(1), 7)
})

test('Regression: ?: result fed directly to .prop access', () => {
  const { f } = run(`
    let a = () => ({ x: 7 })
    let b = () => ({ x: 9 })
    export let f = (w) => (w == 0 ? a() : b()).x
  `)
  is(f(0), 7)
  is(f(1), 9)
})

test('Regression: ?: with literal object branches — distinct schemas', () => {
  // Two literal branches with different schemas. Both arms are inline `{}`
  // (no narrowed-call return), so this stresses the ptrKind propagation
  // through the object-literal emit shape rather than the call-result shape.
  const { f } = run(`
    export let f = (w) => {
      let o = w == 0 ? { x: 11, y: 1 } : { x: 22, z: 2 }
      return o.x
    }
  `)
  is(f(0), 11)
  is(f(1), 22)
})

test('Regression: ?: with both arms plain i32 numeric stays numeric', () => {
  // Negative case: neither arm has ptrKind, so the result must remain a plain
  // i32-or-f64 numeric (no NaN-rebox). Pins the "no false propagation" axis.
  const { f } = run(`
    export let f = (w) => {
      let v = w == 0 ? 11 : 22
      return v + 1
    }
  `)
  is(f(0), 12)
  is(f(1), 23)
})