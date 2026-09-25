// Comprehensive spread operator tests
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run, oracle, funcWat } from './util.js'
import jz, { compile } from '../index.js'
import { belowOpt, levels, onWasi } from './_matrix.js'

// ============================================
// SPREAD IN ARRAY LITERALS
// ============================================

test('spread: [...arr] basic', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    let b = [...a]
    return b.length
  }`)
  is(f(), 3)
})

test('spread: [...a, ...b] concatenate', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    let b = [3, 4]
    let c = [...a, ...b]
    return c.length
  }`)
  is(f(), 4)
})

test('spread: [...a, 5, ...b] mixed', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    let b = [4, 5]
    let c = [...a, 3, ...b]
    return c.length
  }`)
  is(f(), 5)
})

test('spread: [...arr] preserves values', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20, 30]
    let b = [...a]
    return b[0] + b[1] + b[2]
  }`)
  is(f(), 60)
})

test('spread: [...arr] creates new array', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    let b = [...a]
    b.push(3)
    return a.length
  }`)
  is(f(), 2)  // original unchanged
})

test('spread: empty spread', () => {
  const { f } = run(`export let f = () => {
    let a = []
    let b = [...a]
    return b.length
  }`)
  is(f(), 0)
})

// ============================================
// SPREAD IN FUNCTION CALLS WITH REST PARAMS
// ============================================

test('spread: direct and local calls preserve object aliases and missing arguments', () => {
  for (const declaration of [
    'function write(target) { target.value = "changed"; return target }',
    'const write = target => { target.value = "changed"; return target }',
  ]) {
    const src = `export function f(n) {
      ${declaration}
      const target = { value: 7 }
      const args = n === 0 ? [] : n === 1 ? [target] : [target, 99]
      try { return (write(...args) === target) + '|' + target.value }
      catch (e) { return e.name }
    }`
    const js = oracle(src).f
    for (const optimize of levels(0, 1, 2, 3)) {
      const f = jz(src, { optimize }).exports.f
      for (const n of [0, 1, 1, 2, 0]) is(f(n), js(n), `O${optimize}, ${declaration}, ${n} arguments`)
    }
  }
})

test('spread in call: f(...arr) with rest', () => {
  const { f } = run(`export let f = (...args) => args.length`)
  is(f(...[1, 2, 3]), 3)  // JS-side spread into rest function
})

test('spread in call: mixed args with rest', () => {
  const { f } = run(`export let f = (...args) => args[1]`)
  is(f(10, ...[20, 30]), 20)
})

test('spread in WASM call: f(...arr)', () => {
  // Spread inside WASM code calling rest function
  const { f } = run(`export let f = () => {
    let sum = (...nums) => {
      let s = 0
      for (let i = 0; i < nums.length; i++) s += nums[i]
      return s
    }
    let arr = [1, 2, 3]
    return sum(...arr)
  }`)
  is(f(), 6)
})

test('spread in WASM call: mixed', () => {
  const { f } = run(`export let f = () => {
    let sum = (...nums) => {
      let s = 0
      for (let i = 0; i < nums.length; i++) s += nums[i]
      return s
    }
    let arr = [2, 3]
    return sum(1, ...arr, 4)
  }`)
  is(f(), 10)  // 1+2+3+4
})

test('spread in optional call: fn?.(...args) on non-null callable', () => {
  const { f } = run(`export let f = () => {
    let add = (a, b, c) => a + b + c
    let args = [10, 20, 30]
    return add?.(...args)
  }`)
  is(f(), 60)
})

test('spread in optional call: fn?.(...args) on null short-circuits', () => {
  const { f } = run(`export let f = (n) => {
    let add = (a, b, c) => a + b + c
    let fn = n > 0 ? add : null
    let args = [1, 2, 3]
    return fn?.(...args)
  }`)
  is(f(1), 6)
  is(f(0), undefined)
})

test('spread in optional call: mixed positional + spread args', () => {
  const { f } = run(`export let f = () => {
    let sum4 = (a, b, c, d) => a + b + c + d
    let tail = [3, 4]
    return sum4?.(1, 2, ...tail)
  }`)
  is(f(), 10)
})

// ============================================
// SPREAD IN ARRAY METHODS
// ============================================

test('spread: fixed methods preserve positions, empty arguments and typed views', () => {
  const src = `export function f(k) {
    const args = k === 0 ? [] : k === 1 ? [1] : k === 2 ? [1,2] : k === 3 ? [1,undefined] : [1,2,99]
    const a = new Int32Array([7,8,9,10]).subarray(1)
    const b = new BigInt64Array([7n,9221120237041090562n,9221120245631025152n]).subarray(1)
    return [Array.from(a.slice(...args)), Array.from(a.subarray(...args)),
      a.at(...args), b.at(...args), [7,8,9].slice(...args), 'abcd'.slice(...args),
      'abcd'.substring(...args), Array.from(a.slice(...[1], ...[], 2, ...[99]))]
  }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3)) {
    const { f } = run(src, { optimize })
    for (const k of [2,2,0,1,3,4,0,2]) is(f(k), js(k), `O${optimize}, arguments ${k}`)
  }
})

test('spread: Map.set and Set.add consume one argument list', () => {
  const src = `export function f(k) {
    const args = k === 0 ? [] : k === 1 ? [7] : k === 2 ? [7,true] : [7,9,11]
    const m = new Map(), s = new Set()
    const mr = m.set(...args), sr = s.add(...args)
    return [mr === m, sr === s, m.size, m.get(7), m.has(undefined),
      s.size, s.has(7), s.has(9), s.has(undefined)]
  }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3)) {
    const { f } = run(src, { optimize })
    for (const k of [2,2,0,1,3,0,2]) is(f(k), js(k), `O${optimize}, arguments ${k}`)
  }
})

test('spread: fixed methods share iterable normalization and literal argument lowering', () => {
  const src = `export function f(k) {
    const a = new Int32Array([7,8,9]), maybe = k ? [1,2] : null
    let error
    try { a.at(...new BigInt64Array([1n])) } catch(e) { error=e.name }
    return [Array.from(a.slice(...new Set([1,2]))), Array.from(a.slice(...'12')),
      Array.from(a.slice(...new Uint8Array([1,2]))), Array.from(a.slice(...[,2])),
      new Set(maybe).size, new Map(k ? [[1,2]] : null).size, error]
  }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3)) {
    const { f } = run(src, { optimize })
    for (const k of [0,0,1,0]) is(f(k), js(k), `O${optimize}, iterable ${k}`)
  }
  const wat = compile(`export function f(){return new Int32Array([7,8,9]).slice(...[1,2])[0]}`, { wat: true })
  ok(!wat.includes('$__to_num'), 'literal numeric arguments retain their numeric proof')
  const body = funcWat(wat, 'f')
  ok(body && !body.includes('(loop'), 'literal argument list needs no iteration loop')
})

test('spread: fixed methods capture receiver and arguments before conversions', () => {
  const src = `export function f(k) {
    let trace = ''
    const a = new Int32Array([7,8,9]), args = [1]
    const start = { valueOf() { trace += 'v'; return 1 } }
    function receiver() { trace += 'r'; return a }
    function first() { trace += 'a'; return start }
    function tail() { trace += 'b'; if (k === 1) throw 1; return [2] }
    function extra() { trace += 'c'; args[0] = 2; return 99 }
    try {
      const b = receiver().slice(first(), ...tail(), extra())
      const c = a.slice(...args, (args[0] = 0, 3))
      return [trace, Array.from(b), Array.from(c)]
    } catch (e) { return [trace] }
  }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3)) {
    const { f } = run(src, { optimize })
    for (const k of [0,0,1,0]) is(f(k), js(k), `O${optimize}, effects ${k}`)
  }
})

test('spread: fixed methods distinguish missing from explicit undefined arguments', () => {
  const src = `export function f(k) {
    const args = k === 0 ? [1] : k === 1 ? [1,undefined] : []
    const a = new Date(12345678)
    const time = a.setUTCSeconds(...args)
    function add(a,b) { return a === undefined ? 100 : a+b }
    function plus(a,b) { return a+b }
    const reduceArgs = k === 0 ? [add] : [add,undefined]
    const sum = new Int32Array([7,8,9]).reduce(...reduceArgs)
    const nullableArgs = k === 0 ? [plus] : [plus,undefined]
    return [time, sum, new Int32Array([7,8,9]).reduce(...nullableArgs)]
  }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3)) {
    const { f } = run(src, { optimize })
    for (const k of [0,0,1,2,0]) is(f(k), js(k), `O${optimize}, omission ${k}`)
  }
})

test('spread: fixed methods retain regex identity and handle missing required arguments', () => {
  const src = `export function f(k) {
    const a = new Int32Array([7,8]), args = k ? [7] : []
    const positions = k ? [1,3] : []
    const cb = x => x+1, callbacks = k ? [cb] : []
    const r = /7/g, text = k ? ['7'] : []
    let typed, array, empty
    try { typed = Array.from(a.map(...callbacks)) } catch(e) { typed = e.name }
    try { array = [7,8].map(...callbacks) } catch(e) { array = e.name }
    try { new Int32Array(0).map(...[]) } catch(e) { empty = e.name }
    return [a.includes(...args), a.indexOf(...args), a.lastIndexOf(...args),
      Array.from(a.with(...positions)), typed, array, empty, r.test(...text), r.test(...text), /undefined/.exec(...[])?.[0]]
  }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3)) {
    const { f } = run(src, { optimize })
    for (const k of [0,0,1,0]) is(f(k), js(k), `O${optimize}, required ${k}`)
  }
})

test('spread: nullable receivers throw before spreads and ignore surplus only after evaluation', () => {
  const src = `export function f(k) {
    let trace=''
    const xs=[new Int32Array([7,8])]
    function args(){trace+='a';if(k===2)throw 1;return k===3?null:[1]}
    function extra(){trace+='b';return 9}
    try { const a=xs[k===1?1:0];return [a.at(...args(),...[],extra()),trace] }
    catch(e){return [e===1?'one':e.name,trace]}
  }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3)) {
    const { f } = run(src, { optimize })
    for (const k of [0,0,1,2,3,0]) is(f(k), js(k), `O${optimize}, abrupt ${k}`)
  }
})

test('spread: callbacks validate before empty loops without a function elsewhere in the module', () => {
  const src = `export function f(k) {
    const a = new Int32Array(0), args = k ? [undefined] : []
    try { a.map(...args); return 'returned' } catch(e) { return e.name }
  }`
  for (const optimize of levels(0, 1, 2, 3)) {
    const { f } = run(src, { optimize })
    for (const k of [0,0,1,0]) is(f(k), 'TypeError', `O${optimize}, callback ${k}`)
  }
})

test('spread: callback families reject absent and noncallable values before iteration', () => {
  const methods = ['map', 'filter', 'forEach', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'reduce']
  const sources = ['Array.from({length:n},()=>7)', 'new Int32Array(n)', 'new BigInt64Array(n)']
  const src = sources.flatMap((source, c) => methods.map((method, m) => `
    export function f${c}_${m}(k,n) {
      const a=${source}; let calls=0
      const cb=x=>{calls++;return ${c === 2 ? '1n' : '1'}}, args=k===0?[]:k===1?[undefined]:k===2?[null]:k===3?[7]:k===4?[{}]:[cb]
      try { a.${method}(...args); return ['ok',calls] } catch(e) { return [e.name,calls] }
    }`)).join('\n')
  const js = oracle(src)
  for (const optimize of levels(0, 1, 2, 3)) {
    const wasm = run(src, { optimize })
    for (const name of Object.keys(js))
      for (const [k,n] of [[5,2],[5,2],[0,0],[1,0],[2,0],[3,0],[4,0],[1,1],[5,0],[5,2]])
        is(wasm[name](k,n), js[name](k,n), `O${optimize}, ${name}(${k},${n})`)
  }
})

test('callbacks: receiver and reducer seed evaluate before callback validation', () => {
  const src = `export function f(k) {
    let trace=''
    function receiver(){trace+='r';return new Int32Array(0)}
    function callback(){trace+='c';return undefined}
    function seed(){trace+='s';if(k)throw 7;return 1}
    let reduced, mapped, plain, right
    try { receiver().reduce(callback(),seed()) } catch(e) { reduced=e===7?'seven':e.name }
    const reduceTrace=trace;trace=''
    try { receiver().map(callback()) } catch(e) { mapped=e.name }
    const mapTrace=trace;trace=''
    try { [].reduce(callback(),seed()) } catch(e) { plain=e===7?'seven':e.name }
    const plainTrace=trace;trace=''
    try { [].reduceRight(callback(),seed()) } catch(e) { right=e===7?'seven':e.name }
    return [reduced,reduceTrace,mapped,mapTrace,plain,plainTrace,right,trace]
  }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3)) {
    const { f } = run(src, { optimize })
    for (const k of [0,0,1,0]) is(f(k), js(k), `O${optimize}, effects ${k}`)
  }
})

test('typed findLast: reverse traversal observes mutations and stops at a match or throw', () => {
  const src = `export function f(n,k) {
    const a=new Int32Array(n),b=new BigInt64Array(n)
    let trace='',bigTrace='',error
    const value=a.findLast((x,i)=>{trace+=i;if(i===2)a[1]=7;return x===7})
    try { b.findLastIndex((x,i)=>{bigTrace+=i;if(k)throw 7;return i===1}) }
    catch(e){error=e}
    return [value,trace,bigTrace,error]
  }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3)) {
    const { f } = run(src, { optimize })
    for (const [n,k] of [[3,0],[3,0],[0,0],[1,0],[3,1],[0,1],[3,0]])
      is(f(n,k), js(n,k), `O${optimize}, reverse ${n}/${k}`)
  }
})

test('spread: bulk push and unshift consume arguments before mutating one captured receiver', () => {
  for (const method of ['push', 'unshift']) {
    const src = `export function f(n,k) {
      let a=[7],target=a,values=[],trace=''
      for(let i=0;i<n;i++)values.push(i)
      function receiver(){trace+='r';return a}
      function tail(){trace+='t';values[0]=9;a=[99];return k?a:[]}
      const length=receiver().${method}(1,...values,tail().length,...values)
      return [a,target,length,trace]
    }
    export function alias(k) {
      let a=[7,8],target=a,b=k?[2,3]:[]
      const length=a.${method}(...(a=b))
      return [a,target,length]
    }
    export function self() {
      const a=[7,8]
      const first=a.${method}(1,...a)
      const length=a.${method}(...a,...a)
      const empty=[],zero=empty.${method}(...empty)
      return [a,first,length,empty,zero]
    }`
    const js = oracle(src)
    for (const optimize of levels(0,1,2,3,'size')) {
      const wasm = run(src, { optimize })
      for (const [n,k] of [[0,0],[0,0],[3,1],[33,0],[1,1],[0,0]])
        is(wasm.f(n,k), js.f(n,k), `${method} O${optimize}, arguments ${n}/${k}`)
      for (const k of [0,0,1,0]) is(wasm.alias(k), js.alias(k), `${method} O${optimize}, alias ${k}`)
      is(wasm.self(), js.self(), `${method} O${optimize}, self alias`)
    }
  }
})

test('spread: bulk mutations retain empty calls, abrupt arguments and tagged values', () => {
  for (const method of ['push', 'unshift']) {
    const src = `export function f(k) {
      const a=[7],empty=[],big=new BigInt64Array(2)
      let calls=0,error
      function later(){calls++;return 8}
      const plain=a.${method}(),zero=a.${method}(...empty)
      try {a.${method}(1,...(k?null:empty),later())} catch(e){error=e.name}
      const length=a.${method}(...big,true,undefined,'')
      return [a,plain,zero,length,calls,error]
    }`
    const js = oracle(src).f
    for (const optimize of levels(0,1,2,3,'size')) {
      const { f } = run(src, { optimize })
      for (const k of [0,0,1,0]) is(f(k), js(k), `${method} O${optimize}, abrupt ${k}`)
    }
  }
})

test('spread: bulk mutations retain relocated receivers across loop iterations', () => {
  for (const method of ['push','unshift']) for (const receiver of ['a','box.a','receiver()']) {
    const src = `export function f(n){
      const a=[],box={a},b=[1,2,3,4]
      function receiver(){return a}
      for(let i=0;i<n;i++)${receiver}.${method}(...b)
      return [a.length,a[n],a[0],a[a.length-1]]
    }`
    const js = oracle(src).f
    for (const optimize of levels(0,1,2,3,'size')) {
      const { f } = run(src, { optimize })
      for (const n of [0,1,16,256,256,0]) is(f(n),js(n),`${method} ${receiver} O${optimize}, growth ${n}`)
    }
  }
})

test('spread: .push(...values)', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    a.push(2, 3, 4)
    return a.length
  }`)
  is(f(), 4)
})

test('spread: [...a].length after push', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    a.push(2, 3)
    let b = [...a]
    return b.length
  }`)
  is(f(), 3)
})

// ============================================
// SPREAD IN METHOD CALLS WITH VARIADIC
// ============================================

test('spread: string.concat(...strings)', () => {
  const { f } = run(`export let f = () => {
    let parts = ["b", "c"]
    return "a".concat(...parts).length
  }`)
  is(f(), 3)
})

test('spread: Object.assign(...objects)', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1}
    let b = {y: 2}
    let c = {z: 3}
    Object.assign(a, b, c)
    return a.x + a.y + a.z
  }`)
  is(f(), 6)
})

test('spread: expression-bodied arrow returns object spread', () => {
  const { f } = run(`export let f = () => {
    let rows = [{x: 1}, {x: 2}]
    let out = rows.map((row) => ({...row, y: row.x + 10}))
    return out[0].y + out[1].y
  }`, { jzify: true })
  is(f(), 23)
})

test('spread: object spread from unknown-schema parameter', () => {
  const { f } = run(`export let f = (row) => {
    let out = {...row, ok: 10}
    return out.ok
  }`, { jzify: true })
  is(f({x: 1}), 10)
})

test('spread: object spread stores explicit boolean properties', () => {
  const { f } = run(`export let f = () => {
    let row = {x: 1}
    let out = {...row, ok: false}
    return out.ok ? 1 : 2
  }`, { jzify: true })
  is(f(), 2)
})

// ============================================
// EDGE CASES
// ============================================

test('spread: nested arrays', () => {
  const { f } = run(`export let f = () => {
    let a = [[1, 2], [3, 4]]
    let b = [...a]
    return b.length
  }`)
  is(f(), 2)
})

test('spread: single element', () => {
  const { f } = run(`export let f = () => {
    let a = [42]
    let b = [...a]
    return b[0]
  }`)
  is(f(), 42)
})

test('spread: chain spreads', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    let b = [2]
    let c = [3]
    let d = [...[...a, ...b], ...c]
    return d.length
  }`)
  is(f(), 3)
})

test('spread: short local array literals scalarize through spread and reads', () => {
  if (belowOpt(1)) return  // asserts scalarization eliminated array materialization (optimize >= 1)
  const wat = compile(`export let run = (n) => {
    let s = 0
    for (let i = 0; i < n; i++) {
      let a = [i, i+1]
      let b = [i+2, i+3]
      let c = [...a, 99, ...b]
      s = s + c[0] + c[2] + c[4]
    }
    return s
  }`, { wat: true })
  const start = wat.indexOf('(func $run')
  const end = wat.indexOf('\n  (func', start + 1)
  const body = wat.slice(start, end)
  ok(!/__arr|__alloc_hdr|__mkptr|__len|__typed_idx/.test(body), 'hot spread concat should not materialize arrays')
})

// ============================================
// OBJECT SPREAD
// ============================================

test('spread: {...obj} basic', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1, y: 2}
    let b = {...a}
    return b.x + b.y
  }`)
  is(f(), 3)
})

test('spread: {...a, z: 3} add prop', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1, y: 2}
    let b = {...a, z: 3}
    return b.x + b.y + b.z
  }`)
  is(f(), 6)
})

test('spread: {...a, x: 10} override', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1, y: 2}
    let b = {...a, x: 10}
    return b.x + b.y
  }`)
  is(f(), 12)
})

test('spread: {...a, ...b} merge', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1}
    let b = {y: 2}
    let c = {...a, ...b}
    return c.x + c.y
  }`)
  is(f(), 3)
})

test('spread: {...a, ...b} override order', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1, y: 2}
    let b = {x: 10, y: 20}
    let c = {...a, ...b}
    return c.x + c.y
  }`)
  is(f(), 30)
})

test('spread: {x: 0, ...a} prefix override', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 5, y: 6}
    let b = {x: 0, ...a}
    return b.x + b.y
  }`)
  is(f(), 11)  // a.x overrides the 0
})

test('spread: nested object-literal source schema', () => {
  // Module-level literal trees + spread of nested `.left.required` walks the
  // captured shape (recordGlobalRep + shapeOfObjectLiteralAst) so each spread
  // source resolves a schema instead of falling to runtime.
  const { f } = run(`
    let groups = {
      left: {
        required: {a: 1, b: 2},
        optional: {c: 3}
      },
      right: {
        required: {d: 4},
        optional: {e: 5}
      }
    }
    let merged = {
      ...groups.left.required,
      ...groups.left.optional,
      ...groups.right.required,
      ...groups.right.optional
    }
    export let f = () => merged.a + merged.e
  `)
  is(f(), 6)
})

test('spread: nested var-assigned object-literal source schema with jzify', () => {
  const { f } = run(`
    var groups = {
      left: {
        required: {a: 1, b: 2},
        optional: {c: 3}
      },
      right: {
        required: {d: 4},
        optional: {e: 5}
      }
    }
    var merged = {
      ...groups.left.required,
      ...groups.left.optional,
      ...groups.right.required,
      ...groups.right.optional
    }
    export let f = () => merged.b + merged.d
  `, { jzify: true })
  is(f(), 6)
})

test('spread: var-assigned defaults provide source schema with jzify', () => {
  const { f } = run(`
    var defaults = {x: 1, y: 2}
    export let f = (json) => {
      var merged = {...defaults, ...JSON.parse(json)}
      return merged.x * 10 + merged.y
    }
  `, { jzify: true })
  is(f('{"x":4,"y":7}'), 47)
})

// ============================================
// OBJECT REST DESTRUCTURING
// ============================================

test('spread: let {x, ...rest} = obj', () => {
  const { f } = run(`export let f = () => {
    let o = {x: 1, y: 2, z: 3}
    let {x, ...rest} = o
    return x + rest.y + rest.z
  }`)
  is(f(), 6)
})

test('spread: ({x, ...rest} = obj) assignment', () => {
  const { f } = run(`export let f = () => {
    let o = {x: 1, y: 2, z: 3}
    let x, rest
    ;({x, ...rest} = o)
    return x + rest.y + rest.z
  }`)
  is(f(), 6)
})

test('spread: {a: alias, ...rest} with rename', () => {
  const { f } = run(`export let f = () => {
    let o = {a: 10, b: 20, c: 30}
    let {a: first, ...rest} = o
    return first + rest.b + rest.c
  }`)
  is(f(), 60)
})

test('spread: rest gets only remaining props', () => {
  const { f } = run(`export let f = () => {
    let o = {a: 1, b: 2, c: 3, d: 4}
    let {a, b, ...rest} = o
    return a + b + rest.c + rest.d
  }`)
  is(f(), 10)
})

// Second-class a′: a multi-prop spread `{ ...src, k }` whose source schema is
// unknown at analysis time must be HASH-typed (src/kind.js VT['{}'] → VAL.HASH),
// so its result reads go through the hash path — NOT a schema-slot f64.load that
// could match an UNRELATED ambient schema and OOB/mis-read. This was the
// self-compile crash class behind `{ ...func.sig, params, results }`. Pins the type
// + the read shape; runs under test:wasm.
test('spread: multi-prop unknown-schema spread is HASH — no ambient-schema slot misdispatch', () => {
  // `ambient` registers a schema [extra, other]; if the spread result were
  // mistyped OBJECT, `c.extra` could resolve to ambient slot 0 (a raw f64.load).
  const { f } = run(`
    let ambient = { extra: 0, other: 0 }
    export let f = () => { let src = { a: 1, b: 2 }; let c = { ...src, extra: 7 }; return c.extra * 100 + c.a * 10 + c.b }
  `)
  is(f(), 712) // extra=7, a=1, b=2 — all read from the HASH, none from a schema slot
  const wat = compile(`export let h = (src) => { let c = { ...src, extra: 7 }; return c.extra }`, { optimize: 0, wat: true })
  ok(/\$__hash_new/.test(wat), 'unknown-source multi-prop spread builds a HASH (emitDynamicSpread)')
  ok(/\$__hash_get|\$__dyn_get/.test(wat), 'spread result read uses the HASH/dyn path, not a raw schema slot')
})

test('spread: rest-param spread through export-only unknown callee', () => {
  const src = `export let generate = (fn, N, ...params) => {
    let w = new Float64Array(N)
    for (let i = 0; i < N; i++) w[i] = fn(i, N, ...params)
    return w
  }
  export let invoke = (fn, ...params) => fn(...params)`
  for (const optimize of levels(0, 1, 2, 3)) {
    // No internal caller supplies a known closure: this stays an open call.
    const ex = run(src, { optimize })
    is(Array.from(ex.generate(null, 0)), [], `O${optimize}: zero work never calls null`)
    let name
    try { ex.generate(null, 1) } catch (e) { name = e.name }
    is(name, 'TypeError', `O${optimize}: a non-callable fails when reached`)
    if (onWasi()) continue // Host callbacks belong to the JS boundary.
    const js = oracle(src)
    const a = (i, n, scale = 1, bias = 0) => i * scale + n + bias
    const b = (i, n, ...rest) => rest.reduce((sum, x) => sum + x, i - n)
    for (const args of [[a, 1], [a, 3, 2, 5], [a, 3, 2, 5], [b, 2, 1, 2, 3, 4, 5, 6, 7, 8, 9], [a, 0]])
      is(Array.from(ex.generate(...args)), Array.from(js.generate(...args)), `O${optimize}: repeated and changed callbacks retain argument order`)
    const collect = (...args) => args.map(x => String(x)).join('|')
    for (const args of [[], [1], [false, null, undefined, 'text', 5, 6, 7, 8, 9], []])
      is(ex.invoke(collect, ...args), js.invoke(collect, ...args), `O${optimize}: empty, short and spilled argument lists`)
  }
})

test('unshift: multi-arg inserts in argument order, returns new length', () => {
  // ES: a.unshift(1,2,3) -> [1,2,3,...existing], returns the new length. The
  // old emitter silently DROPPED every argument past the first — in the
  // self-compile kernel that broke assemble.js's own
  // `inject.unshift(setBase, ...stores)`, the last byte-parity ordering
  // divergence (.work/archive/todo.md, INSTRUMENTED-KERNEL SESSION).
  const r = run(`
    export let go = () => {
      const a = [9]
      const n = a.unshift(1, 2, 3)
      const b = [9, 8, 7]
      b.unshift(0)
      return JSON.stringify(a) + '|' + n + '|' + b.join('')
    }
  `)
  is(r.go(), '[1,2,3,9]|4|0987')
})

test('unshift: spread args land in argument order', () => {
  // Scalar and spread arguments must retain their source order when prepended:
  // `a.unshift(1, ...ys)` yields [1, ...ys, ...a]. Kernel instance:
  // assemble.js `inject.unshift(setBase, ...snapSlots)` — the gsnap reorder.
  const r = run(`
    export let go = () => {
      const ys = [2, 3]
      const a = [9]
      a.unshift(1, ...ys)
      const b = [9]
      b.unshift(...ys)
      const zs = [5]
      const c = [9]
      c.unshift(1, ...ys, 4, ...zs)
      return JSON.stringify(a) + '|' + JSON.stringify(b) + '|' + JSON.stringify(c)
    }
  `)
  is(r.go(), '[1,2,3,9]|[2,3,9]|[1,2,3,4,5,9]')
})

test('spread into a fixed-arity function fills its parameters from the array', () => {
  const { exports } = jz(`const mat3 = (m, x, y, z) => [x * m[0] + y * m[1] + z * m[2], x * m[3] + y * m[4] + z * m[5], x * m[6] + y * m[7] + z * m[8]]
    const M = [1, 0, 0, 0, 2, 0, 0, 0, 3]
    let add3 = (a, b, c) => a + b * 10 + c * 100
    let pair = (a, b) => [a + 1, b + 1]
    export let a = (v) => mat3(M, ...v)[2]
    export let b = (v) => add3(...v)
    export let c = (v) => add3(1, ...v)
    export let d = (v) => add3(...v, 5)
    export let e = (v) => pair(...v)[1]
    export let f = () => add3(...[7])
    export let g = (lms) => { const [X, Y, Z] = mat3(M, ...lms); return X + Y * 10 + Z * 100 }`)
  is(exports.a([1, 2, 3]), 9)
  is(exports.b([1, 2, 3]), 321)
  is(exports.c([2, 3]), 321)
  is(exports.d([1, 2]), 521)
  is(exports.e([1, 2]), 3)
  ok(Number.isNaN(exports.f()), 'missing parameters are undefined')
  is(exports.g([1, 2, 3]), 941)
})

test('spread into a method: the source is staged once, by its kind', () => {
  // A string source counts characters and reads a character per element; a
  // Set iterates its keys; an unknown source decides at runtime. The staging
  // is one for `push`'s bulk path, the per-element loop and an array literal.
  const src = `const app = (a, s) => { a.push(...s); return a.length }
    const pre = (a, s) => { a.unshift(...s); return a.length }
    export let f = () => {
      const r = []
      const a = ['q']; a.unshift(...'xy'); r.push(a.join(''))
      const b = ['q']; b.push(...'xy'); r.push(b.join(''))
      const c = ['q']; c.push(7, ...'xy'); r.push(c.join(''))
      const d = ['q']; d.unshift(7, ...'xy'); r.push(d.join(''))
      const e = ['q']; r.push(app(e, 'xy') + e.join(''))
      const g = ['q']; r.push(pre(g, 'xy') + g.join(''))
      const h = ['q']; const s = new Set([7, 8]); h.unshift(...s); r.push(h.join(''))
      const k = ['q']; k.push(...new Set([7, 8])); r.push(k.join(''))
      return r.join('|')
    }`
  const expected = oracle(src).f()
  for (const optimize of levels(0, 1, 2)) is(jz(src, { optimize }).exports.f(), expected, `O${optimize}`)
})

test('spread into a method: a program without a string of its own compiles', () => {
  // Copying spread elements needs no ToPropertyKey dispatch or incidental
  // string-module dependency.
  const src = `const a = []; for (let i = 0; i < 1000; i++) a.push(i)
    const t = [1, 2]
    const run = (i) => { a.unshift(...t); a.shift(); return a.shift() }
    export let probe = (n) => run(n)`
  for (const optimize of levels(0, 1, 2)) is(jz(src, { optimize }).exports.probe(0), 2, `O${optimize}`)
  const w = compile(src, { wat: true })
  ok(!/__is_str_key/.test(w), 'the loop reads its elements by index')
})
