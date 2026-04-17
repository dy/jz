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