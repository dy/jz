import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run } from './util.js'
import { compile } from '../index.js'

test('Regression: Compiler crash on toString / native methods as property lookup', () => {
  // Parsing a file with an object property named a native method (.toString) previously crashed src/prepare.js
  // if GENERIC_METHOD_MODULES / STATIC_METHOD_MODULES implicitly matched Object.prototype
  const src = `
    export let test = () => {
      let o = { toString: 1 }
      return o.toString
    }
  `
  let wasm
  try {
    wasm = compile(src)
    ok(wasm instanceof Uint8Array, 'Successfully compiled')
  } catch (e) {
    ok(false, `Compiler threw an error: ${e.message}`)
  }
})

test('Regression: Dynamic property access on function / closures returns undefined (NaN sentinel)', () => {
  // __hash_get was failing out of bounds (RuntimeError) due to missing allocation header on PTR.CLOSURE
  const { test } = run(`
    export let test = () => {
      let f = () => 1
      return f.prop
    }
  `)
  is(test(), null, 'missing property on function returns NaN / undefined')
})

test('Regression: Dynamic property access on string returns undefined', () => {
  // __hash_get was failing out of bounds due to missing capacity header on PTR.SSO / PTR.STRING
  const { test } = run(`export let test = () => "foo".prop`)
  is(test(), null, 'missing property on string returns NaN / undefined')
})

test('Regression: Dynamic property assignment on string silently exits (does not crash)', () => {
  const { test } = run(`export let test = () => { let s = "foo"; s.prop = 42; return s.prop }`)
  is(test(), 42, 'assigning property to string fails gracefully')
})
