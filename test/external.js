import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onWasi, levels } from './_matrix.js'
import { oracle } from './util.js'

// Helper: compile and run
function run(code, imports = {}) {
  return jz(code, { ...imports }).exports
}

test('Read property from external object', () => {
  if (onWasi()) return  // wasi: external object
  const { getProp } = run(`
    export const getProp = (obj) => {
      return obj.nodeType
    }
  `)

  const mockNode = { nodeType: 1, nodeName: 'DIV' }
  // JZ returns floats or pointers, so we might not be able to just pass 'mockNode' cleanly unless the test sets up externref or something.
  is(getProp(mockNode), 1)
})

test('Read property from external object via literal bracket key', () => {
  if (onWasi()) return  // wasi: external object
  // Regression: `obj['nodeType']` IS `obj.nodeType` — both must reach the
  // host-external read path. The `[]` emitter used to fall to `__dyn_get`
  // (internal HASH only, no external support), so a literal-key bracket read
  // on a host object silently returned undefined while dot access worked.
  const { getDot, getBracket } = run(`
    export const getDot = (obj) => obj.nodeType
    export const getBracket = (obj) => obj['nodeType']
  `)
  const mockNode = { nodeType: 1, nodeName: 'DIV' }
  is(getDot(mockNode), 1, 'dot access (control)')
  is(getBracket(mockNode), 1, 'literal-key bracket access must match dot')
})

test('Read nested properties through every opaque host-object carrier', () => {
  if (onWasi()) return  // wasi: external object
  const { alias, bracket, dot, helper, identityResult, predicate, propertyResult, recursive } = run(`
    let read = obj => obj.a.b
    let identity = obj => obj
    let property = obj => obj.a
    export const alias = obj => { let copy = obj; return copy.a.b }
    export const bracket = obj => obj['a']['b']
    export const dot = obj => obj.a.b
    export const helper = obj => read(obj)
    export const identityResult = obj => identity(obj).a.b
    export const propertyResult = obj => property(obj).b
    export const predicate = obj => obj.type === 'node' && obj.property.type === 'private'
    export const recursive = obj =>
      (obj.type === 'node' && obj.property.type === 'private') ||
      (obj.type === 'chain' && recursive(obj.expression))
  `)
  const value = { a: { b: 42 }, type: 'node', property: { type: 'private' } }
  is(bracket(value), 42, 'chained literal-key bracket reads')
  is(dot(value), 42, 'chained dot reads retain the host-object branch')
  is(alias(value), 42, 'an opaque local alias retains host-object provenance')
  is(helper(value), 42, 'an internal helper parameter accepts the host object')
  is(identityResult(value), 42, 'an opaque identity return remains externally dispatched')
  is(propertyResult(value), 42, 'a helper-returned property can itself be a host object')
  is(predicate(value), true, 'nested host property participates in boolean predicates')
  is(recursive(value), true, 'recursive boolean result preserves the external nested read')
  is(recursive({ type: 'chain', expression: value }), true, 'recursive nested input')
  let reads = 0
  const withGetter = { get a() { reads++; return { b: 42 } } }
  is(dot(withGetter), 42, 'nested getter result')
  is(reads, 1, 'nested host getter runs once')
})

test('Nested external dispatch follows imported results and remains ingress-gated', () => {
  if (onWasi()) return
  let calls = 0
  const { imported } = run(`
    import { load } from 'host'
    export let imported = () => load().a.b
  `, { imports: { host: { load: () => { calls++; return { a: { b: 42 } } } } } })
  is(imported(), 42, 'an imported function result carries a nested host object')
  is(calls, 1, 'the imported receiver expression runs once')

  const ingressWat = compile(`
    let internal = value => value.a.b
    export let f = value => internal(value)
  `, { wat: true, optimize: 0 })
  const start = ingressWat.indexOf('(func $internal')
  const end = ingressWat.indexOf('\n  (func $', start + 1)
  const body = ingressWat.slice(start, end < 0 ? ingressWat.length : end)
  is((body.match(/\$__dyn_get_any/g) || []).length, 2,
    'both reads in an unknown helper chain retain runtime tag dispatch')
  ok(!body.includes('$__dyn_get_expr'),
    'an unknown helper chain does not commit its nested result to the internal dispatcher')

  const nativeWat = compile(`export let f = () => ({ a: { b: 42 } }).a.b`, { wat: true, optimize: 0 })
  ok(!nativeWat.includes('$__ext_prop'),
    'a program with no host ingress does not link external property dispatch')
})

test('Literal-key bracket on a primitive arg stays undefined (no narrowing)', () => {
  if (onWasi()) return
  // The delegation must preserve polymorphism: a number/string receiver has no
  // such property → undefined, NOT a reinterpret of its bits as an object pointer.
  const { f } = run(`export const f = (x) => x['foo']`)
  is(f(42), undefined, 'number arg → undefined')
  is(f({ foo: 7 }), 7, 'object arg → property value')
})

test('Call method on external object', () => {
  if (onWasi()) return  // wasi: external object
  const { callMethod } = run(`
    export const callMethod = (obj) => {
      return obj.getAttribute('id').length
    }
  `)

  const mockNode = { 
    id: 'main',
    getAttribute(name) { return this[name] }
  }
  is(callMethod(mockNode), 4)
})

test('Set property on external object', () => {
  if (onWasi()) return  // wasi: external object
  const { setProp } = run(`
    export const setProp = (obj, val) => {
      obj.innerHTML = val
    }
  `)

  const mockNode = { innerHTML: '' }
  setProp(mockNode, 'Hello')
  is(mockNode.innerHTML, 'Hello')
})

test('Computed delete reaches host storage and preserves strict failure and reuse', () => {
  if (onWasi()) return
  const src=`export function remove(obj,key){'use strict';return delete obj[key]}
    export function caught(obj,key){'use strict';try{return [delete obj[key],'ok']}catch(e){return e.name}}`
  for (const optimize of levels(0,1,2,3,'size')) {
    const instance=jz(src,{optimize}),{remove,caught}=instance.exports
    let getterCalls=0
    const first={x:1,get accessor(){getterCalls++;return 2}},second={x:9}
    Object.defineProperty(first,'locked',{value:3,configurable:false})
    for (const obj of [first,first,second,first]) {
      is(remove(obj,'x'),true,`host delete O${optimize}`)
      is(Object.hasOwn(obj,'x'),false)
      is(remove(obj,'missing'),true)
    }
    is(remove(first,'accessor'),true)
    is(getterCalls,0,'delete does not read a getter')
    is(caught(first,'locked'),'TypeError','strict nonconfigurable failure is catchable in source')
    is(first.locked,3)
    throws(()=>remove(first,'locked'),TypeError)
    first.x=7
    is(caught(first,'x'),[true,'ok'],'successful call after a throwing call')
    is(Object.hasOwn(first,'x'),false)
    is(caught(null,'x'),'TypeError')
    is(caught(undefined,'x'),'TypeError')
    const array=[2],typed=new Uint8Array([2]),fn=function native(){}
    for(const [obj,key,expected] of [[array,'0',[true,'ok']],[array,'length','TypeError'],
      [typed,'0','TypeError'],[typed,'-0',[true,'ok']],[typed,'length',[true,'ok']],
      [fn,'prototype','TypeError'],[()=>{},'prototype',[true,'ok']]])
      is(caught(instance.memory.External(obj),key),expected,`explicit host ${key}`)
    is(0 in array,false)
    is(typed[0],2)
  }
  const wat=compile(`export function f(){const a={x:1};let key='x';return delete a[key]}`,{wat:true})
  ok(!wat.includes('$__ext_delete'),'closed internal deletion does not link a host import')
})

test('Computed host delete captures its receiver and converts the key once', () => {
  if (onWasi()) return
  const src=`import {load,changed,note} from 'host';
    export function f(mode){'use strict';
      function key(){note('k');return {toString(){note('s');changed();if(mode)throw 7;return 'x'}}}
      try{return delete load()[key()]}catch(e){return e}}`
  for (const optimize of levels(0,1,2,3,'size')) {
    let trace='',current,old
    const {f}=jz(src,{optimize,imports:{host:{load(){trace+='r';return current},
      note(s){trace+=s},changed(){current={x:9}}}}}).exports
    for(const mode of [0,0,1,0]){
      trace='';old=current={x:1}
      is(f(mode),mode?7:true)
      is(trace,'rks')
      is(Object.hasOwn(old,'x'),!!mode)
      is(current.x,9)
    }
  }
})

test('Return external object from JZ', () => {
  if (onWasi()) return  // wasi: external object
  const instance = jz(`
    export const createNode = (doc) => {
      return doc.createElement('div')
    }
  `)
  const mockDoc = {
    createElement(name) { return { nodeName: name.toUpperCase() } }
  }
  const divPtr = instance.exports.createNode(mockDoc)
  const div = instance.memory.read(divPtr)
  is(div.nodeName, 'DIV')
})

// An indexed write through a dynamic property chain on an EXTERNAL object —
// `o.field[i] = v` where `o` is a plain host object passed as an argument — was a
// silent no-op: each `.field` read materializes an independent copy (`__ext_prop`
// → interop.js `wrapVal` deep-copies a container into fresh wasm memory — no
// identity preserved with the host), so the index-store mutated a copy nobody
// kept — the host object's actual property was never touched. Whole-field
// reassignment (`o.field = arr`) and scalar field writes (`o.gain = v`) worked
// correctly (a direct, non-indexed property SET, not a read-then-mutate). NOT
// the same root cause as the superficially similar "typedArray.set() into a
// dynamically-added struct field" no-op (test/array-methods.js, a DISPATCH gap —
// vt-unknown receivers never reached ANY `.typed:*` emitter at all) — this one is
// a marshaling-identity gap, fixed differently: emitElementAssign
// (src/compile/emit-assign.js) now special-cases `obj.prop[idx] = val` when
// `obj`'s type is unresolved — performs the normal (copy-based) element write,
// then writes the resulting (possibly-relocated) container back onto the SAME
// property via `__hash_set`, whose existing type guard already dispatches
// EXTERNAL receivers to `__ext_set`. Native OBJECT/HASH receivers already
// share storage, so their fields need no write-back. `mem.read` (interop.js)
// already recursively decodes an ARRAY pointer
// back into a real JS array, so the round-trip is correct including one level of
// array-of-arrays nesting (see test/objects.js's two sibling fixes, same root
// cause). Live instance: noise-reduction/deplosive.js `params._lfDetS[0] = lfEnv`
// — envelope-detector state never survived a streaming chunk boundary, silently
// restarting from zero each call.
test('staged external field writes retain their owner, result and evaluation order', () => {
  if (onWasi()) return
  const src = `export function f(o, mode, index) {
    let trace = ''; const original = o
    function receiver() { trace += 'r'; if(mode===3)throw 9; return o }
    function key() { trace += 'k'; if(mode===2)throw 8; return index }
    function value() { trace += 'v'; if(mode===1)throw 7; o={state:[99]}; return [7,9] }
    try { const result = receiver().state[key()] = value(); return [result, trace, original.state[index]] }
    catch(e) { return [e===7, trace] }
  }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const actual = jz(src, { optimize }).exports.f, expected = oracle(src).f
    for (const initial of [[], [1], null, undefined]) {
      const a = {state: initial?.slice()}, b = {state: initial?.slice()}
      if (initial === null) a.state = b.state = null
      for (const [mode, index] of [[0,0], [0,0], [1,2], [2,1], [3,1], [0,5], [0,0]]) {
        is(actual(a, mode, index), expected(b, mode, index), `O${optimize}: result/order mode ${mode}, index ${index}`)
        is(a, b, 'the captured host owner contains the same nested value')
      }
    }
  }
})

test('staged external field updates persist every reference operator', () => {
  if (onWasi()) return
  for (const operation of ['receiver().state[key()] = 9', 'receiver().state[key()] += 2',
    'receiver().state[key()]++', '++receiver().state[key()]', 'receiver().state[key()] ||= 5']) {
    const src = `export function f(o) { let trace='';
      function receiver(){trace+='r';return o} function key(){trace+='k';return 0}
      const result=${operation}; return [result,trace,o.state[0]] }`
    for (const optimize of levels(0, 1, 2, 3, 'size')) {
      const actual = jz(src, { optimize }).exports.f, expected = oracle(src).f
      const a = {state:[0]}, b = {state:[0]}
      for (let i=0; i<3; i++) {
        is(actual(a), expected(b), `O${optimize}: ${operation}, call ${i}`)
        is(a, b, 'the host sees the completed update')
      }
    }
  }
})

test('indexed write through an external-object field persists', () => {
  if (onWasi()) return  // wasi: external object
  const { step } = run(`
    export const step = (o) => {
      if (!o._s) o._s = [0, 0]
      let v = o._s[0] + 21
      o._s[0] = v
      return v
    }
  `)
  const o = {}
  is(step(o), 21)
  is(step(o), 42)  // must see persisted o._s[0] = 21 from the first call
  is(o._s[0], 42)  // and the host-side object must hold the written value
})

test('logical host field updates write back only on the assignment arm', () => {
  if (onWasi()) return
  for (const op of ['||=', '&&=', '??=']) {
    const src = `export function f(o) { return o.state[0] ${op} 9 }`
    for (const optimize of levels(0,1,2,3,'size')) {
      const { exports: { f }, memory } = jz(src, { optimize })
      for (const value of [0, 2, null, undefined]) {
        let gets=0, sets=0, state=[value]
        const o = { get state(){gets++;return state}, set state(v){sets++;state=v} }
        const writes = op === '||=' ? !value : op === '&&=' ? !!value : value == null
        is(f(memory.External(o)), writes ? 9 : value, `O${optimize}: ${op} ${value}`)
        is(gets, 1, 'GetValue reads the host property once')
        is(sets, writes ? 1 : 0, 'only an actual store commits its copied container')
        is(state[0], writes ? 9 : value, 'short circuit preserves the host value')
      }
    }
  }
})

test('staged native field updates preserve getter storage without invoking its setter', () => {
  const src = `export function update(o){return o.state[0] += 2}
    export function f(){let gets=0,sets=0;const a=[3];
      const o={get state(){gets++;return a},set state(v){sets++;throw 7}};
      return [update(o),gets,sets,a[0]]}`
  for (const optimize of levels(0,1,2,3,'size')) {
    const f = jz(src, { optimize }).exports.f
    is(f(), [5,1,0,5], `O${optimize}: the getter's array is already shared`)
    is(f(), [5,1,0,5], 'a fresh instance retains no previous staged owner')
  }
})

test('staged host field stores retain BigInt assignment results', () => {
  if (onWasi()) return
  const src = 'export function f(o){return o.state[0]=0x7ff8000500000000n}'
  for (const optimize of levels(0,1,2,3,'size')) {
    const { exports: { f }, memory } = jz(src, { optimize })
    for (let i=0; i<2; i++) {
      const o={state:[0]}
      is(f(memory.External(o)), 0x7ff8000500000000n, `O${optimize}: boxed result bits survive write-back`)
      is(o.state, [0x7ff8000500000000n], 'the host retains the same BigInt value')
    }
  }
})

// A typed array stored onto an EXTERNAL object was a LIVE VIEW into the module's
// own linear memory, not a host-owned copy (interop.js `mem.read`'s TYPED branch:
// `new Ctor(mem.buffer, off, len)`). When a later call grows memory (the bump
// allocator never frees), Memory.grow() detaches the old ArrayBuffer; the next
// read-back of that field re-marshaled the stale view and jz's fast-path bulk copy
// threw a raw uncaught TypeError ("...detached ArrayBuffer"). Real hazard for any
// streaming DSP that stashes typed-array state on a params object across chunks
// (noise-reduction gate.js `params._lab` — crashes on the call where cumulative
// allocation first crosses a page). Fixed narrowly at `__ext_set` (interop.js) —
// NOT in `mem.read` itself, which stays a live view for its other callers (a
// function-return-value peek, or explicit `instance.memory.read(ptr)`, where a
// live view is the documented, intentional behavior — test/external.js's own
// "Return external object from JZ" above relies on it). `__ext_set` specifically
// persists onto a REAL, long-lived host object property, so it now `.slice()`s
// any decoded TypedArray view into an independent, host-owned copy before
// storing it — TypedArray's own same-ctor copy, exactly `new Ctor(view)` with no
// manual size/offset bookkeeping, and a no-op for every other decoded value shape.
test('typed-array field on an external object survives memory growth', () => {
  if (onWasi()) return  // wasi: external object
  const { step } = run(`
    export const step = (o, growBy) => {
      let junk = new Float64Array(growBy)
      junk[0] = 1
      if (!o.buf) o.buf = new Float32Array(4)
      let b = o.buf
      return b.length
    }
  `)
  const o = {}
  is(step(o, 10), 4)
  is(step(o, 200000), 4)  // forces Memory.grow(); read-back of o.buf must not throw or see a detached view
})

// a host object that matches no layout stays a host reference: `in`, the
// builtins that list it, a copy and JSON.stringify go through the host, where
// each saw nothing (null)
test('A host object lists, copies and serializes as JS', () => {
  if (onWasi()) return
  const src = `export const run = (o, g) => JSON.stringify([Object.keys(o), Object.values(o), Object.entries(o),
    (() => { const r = []; for (const k in o) r.push(k); return r })(), 'a' in o, 'z' in o,
    { ...o, c: 3 }, Object.assign({ c: 3 }, o), JSON.stringify({ o, n: [o] }, null, g)])`
  const host = () => ({ a: 1, b: 'x', f() {}, d: { e: [1, { h: true }] } })
  const js = new Function(src.replace('export const run = ', 'return '))()
  const { run } = jz(src).exports
  for (const g of [undefined, 2, '--']) is(run(host(), g), js(host(), g), `gap ${g}`)
})
