import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { run } from './util.js'

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

test('Regression: external method returning typed array spreads into array', () => {
  const host = { bytes() { return new Uint8Array([65, 66, 67]) } }
  const { exports } = jz(`export let test = (h) => {
    let out = []
    out.push(...h.bytes())
    return [out.length, out[0], out[2]]
  }`)
  const result = exports.test(host)
  is(result[0], 3)
  is(result[1], 65)
  is(result[2], 67)
})

test('Regression: external method returning typed array supports direct indexing', () => {
  const host = { bytes() { return new Uint8Array([65, 66, 67]) } }
  const { exports } = jz(`export let test = (h) => {
    let bytes = h.bytes()
    return [bytes.length, bytes[0], bytes[2]]
  }`)
  const result = exports.test(host)
  is(result[0], 3)
  is(result[1], 65)
  is(result[2], 67)
})

test('Regression: array literal spread copies external typed array values', () => {
  const host = { bytes() { return new Uint8Array([65, 66, 67]) } }
  const { exports } = jz(`export let test = (h) => {
    let out = [...h.bytes()]
    return [out.length, out[0], out[2]]
  }`)
  const result = exports.test(host)
  is(result[0], 3)
  is(result[1], 65)
  is(result[2], 67)
})

test('Regression: imported function returning array with props keeps numeric indexing', () => {
  const { exports } = jz(`
    import { make } from './m.js'
    export let test = () => {
      let out = make()
      return [out.length, out[0], out[1], out._s]
    }
  `, {
    modules: {
      './m.js': `
        export const make = () => {
          let out = [97, 98]
          out._s = true
          out.valueOf = () => 'x'
          return out
        }
      `,
    },
  })
  const result = exports.test()
  is(result[0], 2)
  is(result[1], 97)
  is(result[2], 98)
  is(result[3], 1)
})

test('Regression: computed array receiver for indexing evaluates once', () => {
  const { test } = run(`
    export let test = () => {
      let count = 0
      let input = [[1]]
      let first = input.map(item => {
        count += 1
        return item.shift()
      })[0]
      return count * 10 + (first == first ? first : 9)
    }
  `)
  is(test(), 11)
})

test('Regression: ternary only evaluates the live branch', () => {
  const { test } = run(`
    export let test = () => {
      let bytes = []
      let buf = ''
      let code = null
      const commit = () => bytes.push(97)
      code != null ? (commit(), bytes.push(code)) : buf += 'a'
      return [bytes.length, buf.length]
    }
  `)
  const result = test()
  is(result[0], 0)
  is(result[1], 1)
})
