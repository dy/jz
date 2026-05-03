// Destructuring, optional chaining, typeof
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'

const interp = { __ext_prop:()=>0, __ext_has:()=>0, __ext_set:()=>0, __ext_call:()=>0 }
function run(code) {
  const wasm = compile(code)
  const mod = new WebAssembly.Module(wasm)
  return new WebAssembly.Instance(mod, { env: interp }).exports
}

// ============================================
// Array destructuring
// ============================================

test('destruct: let [a, b] = arr', () => {
  const { f } = run(`export let f = () => {
    let arr = [10, 20, 30]
    let [a, b, c] = arr
    return a + b + c
  }`)
  is(f(), 60)
})

test('destruct: from pointer array', () => {
  const { f } = run(`export let f = () => {
    let pair = [7, 11]
    let [a, b] = pair
    return a * 10 + b
  }`)
  is(f(), 81)  // 7*10 + 11
})

test('destruct: partial array', () => {
  const { f } = run(`export let f = () => {
    let a = [100, 200, 300]
    let [x, y] = a
    return x + y
  }`)
  is(f(), 300)  // only first two elements
})

test('destruct: sparse first element stays nullish', () => {
  const { f } = run(`export let f = () => {
    let [x, y] = [, 7]
    return (x == null) + y
  }`)
  is(f(), 8)
})

test('destruct: inline arrow param nested array pattern', () => {
  const { f } = run(`
    let inspect = ([kind, fields, subkind, supertypes, rec], ctx) =>
      (kind === 'func') + (fields[0].length === 0) + (fields[1].length === 0) + (ctx === 7)
    export let f = () => inspect(['func', [[], []]], 7)
  `)
  is(f(), 4)
})

test('destruct: inline arrow param nested rest pattern', () => {
  const { f } = run(`
    let inspect = ([mod, field, [kind, ...dfn]], ctx) =>
      (mod === 'm') + (field === 'f') + (kind === 'func') + (dfn[0][0] === 'type') + (ctx === 7)
    export let f = () => inspect(['m', 'f', ['func', ['type', 0]]], 7)
  `)
  is(f(), 5)
})

// ============================================
// Object destructuring
// ============================================

test('destruct: let {x, y} = obj', () => {
  const { f } = run(`export let f = () => {
    let o = {x: 3, y: 4}
    let {x, y} = o
    return x * x + y * y
  }`)
  is(f(), 25)
})

test('destruct: object in function', () => {
  const { f } = run(`
    let mag2 = (v) => {
      let {x, y} = v
      return x * x + y * y
    }
    export let f = () => mag2({x: 5, y: 12})
  `)
  is(f(), 169)
})

test('destruct assign: [...rest] = arr', () => {
  const { f } = run(`export let f = () => {
    let rest
    ;[...rest] = [3, 4, 5]
    return rest.length * 10 + rest[2]
  }`)
  is(f(), 35)
})

test('destruct assign: [a = v] default', () => {
  const { f } = run(`export let f = () => {
    let a
    ;[a = 9] = []
    return a
  }`)
  is(f(), 9)
})

test('destruct assign: ({x: a} = obj)', () => {
  const { f } = run(`export let f = () => {
    let a;
    ({x: a} = {x: 7})
    return a
  }`)
  is(f(), 7)
})

test('destruct assign: newline after declaration keeps assignment statement', () => {
  const { f } = run(`export let f = () => {
    let a
    ({x: a} = {x: 8})
    return a
  }`)
  is(f(), 8)
})

test('destruct assign: ({x = v} = obj) default', () => {
  const { f } = run(`export let f = () => {
    let x;
    ({x = 5} = {})
    return x
  }`)
  is(f(), 5)
})

test('destruct assign: ({x: a = v} = obj) alias default', () => {
  const { f } = run(`export let f = () => {
    let a;
    ({x: a = 6} = {})
    return a
  }`)
  is(f(), 6)
})

// ============================================
// Optional chaining
// ============================================

test('optional: ?.prop on valid object', () => {
  const { f } = run(`export let f = () => {
    let o = {x: 42, y: 0}
    return o?.x
  }`)
  is(f(), 42)
})

test('optional: ?.prop on null returns null', () => {
  const { f } = run(`export let f = () => {
    let o = null
    return o?.x
  }`)
  ok(isNaN(f()), '?.prop on null returns null NaN')
})

test('optional: ?.[i] on valid array', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20]
    return a?.[1]
  }`)
  is(f(), 20)
})

test('optional: ?.[i] on null returns null', () => {
  const { f } = run(`export let f = () => {
    let a = null
    return a?.[0]
  }`)
  ok(isNaN(f()), '?.[i] on null returns null NaN')
})

test('optional: ?.[i] on string returns char', () => {
  const { f } = jz(`export let f = () => {
    let s = "ab"
    return s?.[1]
  }`).exports
  is(f(), 'b')
})

test('optional: ?.length on array', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    return a?.length
  }`)
  is(f(), 3)
})

test('optional: ?.length on string', () => {
  const { f } = run(`export let f = () => {
    let s = "abc"
    return s?.length
  }`)
  is(f(), 3)
})

test('optional: ?.length on null returns null', () => {
  const { f } = run(`export let f = () => {
    let a = null
    return a?.length
  }`)
  ok(isNaN(f()), '?.length on null returns null NaN')
})

test('optional: ?.[i] evaluates base once', () => {
  // Base expression should not be re-evaluated in the then branch
  const { f } = run(`export let f = () => {
    let c = 0
    let a = [100, 200]
    let r = a?.[c]
    return r
  }`)
  is(f(), 100)
})

test('optional: ?.prop on dynamic HASH object', () => {
  is(run(`export let f = () => {
    let o = JSON.parse('{"x":1}')
    return o?.x
  }`).f(), 1)
})

// ============================================
// typeof
// ============================================

test('typeof: number', async () => {
  const { exports: { f } } = await jz('export let f = () => typeof 42')
  is(f(), 'number')
})

test('typeof: array (pointer)', async () => {
  const { exports: { f } } = await jz('export let f = () => { let a = [1,2]; return typeof a }')
  is(f(), 'object')
})

test('typeof: object (pointer)', async () => {
  const { exports: { f } } = await jz('export let f = () => { let o = {x: 1}; return typeof o }')
  is(f(), 'object')
})

test('typeof: string SSO', async () => {
  const { exports: { f } } = await jz('export let f = () => { let s = "hi"; return typeof s }')
  is(f(), 'string')
})

test('typeof: string heap', async () => {
  const { exports: { f } } = await jz('export let f = () => { let s = "hello world"; return typeof s }')
  is(f(), 'string')
})
