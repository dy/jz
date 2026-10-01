// Symbol tests: unique identities, interning
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile, instantiate } from '../index.js'
import { compile as wasm } from 'watr'
import { run, oracle } from './util.js'
import { levels, onWasi, onKernel } from './_matrix.js'
import { ptrBits, PTR } from '../layout.js'

test('Symbol: interned-only modules do not export an unused identity counter', () => {
  const source = `export function f(){return Symbol.for('shared')}`
  const bytes = compile(source)
  ok(!WebAssembly.Module.exports(new WebAssembly.Module(bytes)).some(e => e.name === '__symbol_id'),
    'only a runtime factory needs the shared counter')
  if (!onWasi() && !onKernel()) {
    const one = jz(source).exports, two = jz(source).exports
    is(one.f() === Symbol.for('shared'), true, 'host registry identity survives without a counter')
    is(one.f() === two.f(), true, 'separate instances agree on the registry identity')
  }
})

test('Symbol: factory and loop invocations retain distinct identities across calls', () => {
  const src = `let previous=Symbol(),saved=Symbol.for('saved')
    function make(){return Symbol('same')}
    export function f(count){
      const first=make();let same=0,prior=first
      for(let i=0;i<count;i++){const next=make();same+=next===prior;prior=next}
      const old=previous;previous=first
      return [same,first===old,first===saved,saved===Symbol.for('saved'),
        first===first,typeof first,!!first,(first??0)===first,JSON.stringify([first])]
    }`
  // Observe identity inside the module; host Symbol decoding is a separate edge.
  for(const optimize of levels(0,1,2,3,'size')) {
    const got=jz(src,{optimize}).exports,want=oracle(src)
    for(const count of [0,0,1,17,0,2])is(got.f(count),want.f(count),`O${optimize}, count ${count}`)
  }
})

test('Symbol: identity carry skips interned atoms and exhaustion never wraps', () => {
  if(onWasi() || onKernel())return
  const wat=compile(`export function f(){return Symbol()===Symbol.for('same')?0:1}`,{wat:true,optimize:0})
  // Expose only the counter in this fixture to reach its otherwise impractical boundaries.
  const mod=instantiate(wasm(wat.replace(/\)\s*$/, '(export "__test_id" (global $__symbol_id)))')))
  const counter=mod.instance.exports.__test_id
  for(const start of [0x7ff8001000000000n,0x7ff80010fffffffen,0x7ff80010ffffffffn,
    0x7ff8001200000008n,0x7ff8400000000008n]) {
    counter.value=start
    is(mod.exports.f(),1,'a fresh runtime atom never equals an interned one')
    is(counter.value,start+((start&0xffffffffn)===0xffffffffn?2n:1n),'carry reserves the zero-offset domain')
  }
  counter.value=0x7ff87ffffffffffdn
  is(mod.exports.f(),1,'the last usable identity remains valid')
  for(let i=0;i<2;i++) {
    let error
    try{mod.exports.f()}catch(e){error=e}
    is(error?.name,'RangeError','exhaustion throws, including repeated calls')
    is(counter.value,0x7ff87ffffffffffen,'neither the tombstone nor a wrapped identity is issued')
  }
})

// === Basic Symbol creation ===

test('Symbol: description conversion follows argument evaluation and preserves throws', () => {
  const src=`export function f(mode){
    let trace='';const symbol=Symbol('inner');
    const description={get toString(){trace+='g';if(mode===2)throw 7;
      return function(){trace+='s';return mode===3?symbol:mode===4||mode===5?{}:'ok'}},
      valueOf(){trace+='v';return mode===5?symbol:'fallback'}};
    function first(){trace+='a';if(mode===1)throw 9;return mode===6?symbol:mode===7?undefined:description}
    function extra(){trace+='b';if(mode===8)throw 11;return {toString(){trace+='!';return 'unused'}}}
    try{const result=Symbol(first(),extra());return[typeof result,trace]}
    catch(e){return[typeof e==='number'?e:e.name,trace]}
  }`
  const ignored=`export function f(mode){let trace='';function extra(){trace+='e';if(mode)throw 7;return 0}
    try{return[Symbol.for('key',extra())===Symbol.for('key'),trace]}catch(e){return[e,trace]}}`
  for(const optimize of levels(0,1,2,3,'size')) {
    for(const source of [src,ignored]) {
      const got=jz(source,{optimize}).exports,want=oracle(source)
      for(const mode of [0,0,1,2,3,4,5,6,7,8,0])is(got.f(mode),want.f(mode),`O${optimize}, conversion ${mode}`)
    }
  }
})

test('Symbol: unique per call', () => {
  const { f } = jz(`export let f = () => {
    let s1 = Symbol('x')
    let s2 = Symbol('x')
    return s1 == s2  // same name, different calls — should be different
  }`).exports
  // Note: Symbols are compared by bit-equality, different call sites = different pointers
  is(f(), false)  // not equal
})

test('Symbol: self-equality', () => {
  const { f } = jz(`export let f = () => {
    let s = Symbol('test')
    return s == s
  }`).exports
  is(f(), true)
})

// === Symbol.for interning ===

test('Symbol.for: reuses same interned atom', () => {
  const { f } = jz(`export let f = () => {
    let s1 = Symbol.for('shared')
    let s2 = Symbol.for('shared')
    return s1 == s2
  }`).exports
  is(f(), true)  // same name interned = same atom
})

test('Symbol.for: different names are different', () => {
  const { f } = jz(`export let f = () => {
    let s1 = Symbol.for('name1')
    let s2 = Symbol.for('name2')
    return s1 == s2
  }`).exports
  is(f(), false)
})

// === typeof Symbol ===

test('typeof Symbol anonymous', async () => {
  const { exports: { f } } = await jz(`export let f = () => {
    let s = Symbol('test')
    return typeof s
  }`)
  is(f(), 'symbol')
})

test('typeof Symbol.for', async () => {
  const { exports: { f } } = await jz(`export let f = () => {
    let s = Symbol.for('x')
    return typeof s
  }`)
  is(f(), 'symbol')
})

// === Object property access with Symbol keys ===

test('Symbol as object key (compile-time object)', () => {
  const { f } = run(`export let f = () => {
    let sym = Symbol('key')
    let obj = {x: 10}
    return obj.x
  }`)
  is(f(), 10)  // Objects work normally
})

// === Nullish coalescing uses symbol comparison ===

test('Nullish coalescing: regular value vs symbol', () => {
  const { f } = run(`export let f = () => {
    let s = Symbol('test')
    // Symbols are truthy (NaN but pointer), so ?? returns first
    return (s ?? 999) == s ? 1 : 0
  }`)
  is(f(), 1)  // symbols are truthy, so ?? returns first
})

// `typeof Symbol` is 'function' (a function of the target, src/prepare/pre-eval.js
// typeofName), a member of it the target does not serve reads as undefined
// (`Symbol.toStringTag`, `Symbol.iterator`: no well-known symbols; a missing property of
// an object is undefined too), and a call of such a member is still refused.
test('Symbol: the constructor by typeof, its well-known symbols undefined', () => {
  const src = `export let f = () => [typeof Symbol, typeof Symbol('x'), typeof Symbol.toStringTag, typeof Symbol.iterator, Symbol.iterator === undefined, typeof Symbol.for].join(' ')`
  is(jz(src).exports.f(), 'function symbol undefined undefined true function')
  // a feature test of them selects the arm the target has, and the other arm is gone
  const feature = `const hasToStringTag = typeof Symbol === 'function' && typeof Symbol.toStringTag === 'symbol'
    export let f = () => hasToStringTag ? 'tagged' : 'plain'`
  is(jz(feature).exports.f(), 'plain')
  ok(!/toStringTag/.test(compile(feature, { wat: true })), 'the arm of the missing feature is gone')
})


test('Symbol property keys preserve identity, string collisions and presence', () => {
  const src = `
    const s1=Symbol('value'),s2=Symbol('value'),shared=Symbol.for('shared')
    export function f(mode, value) {
      const values=[{},[],new Int32Array(2),new Map(),new Set(),new Date(10),new ArrayBuffer(2)]
      const o=values[mode|0]
      o[s1]=value;o[s2]=9;o[shared]=11;o.NaN=13;o.Symbol=17;o['']=19
      const before=[o[s1],o[s2],o[Symbol.for('shared')],o.NaN,o.Symbol,o[''],s1 in o,s2 in o,Object.hasOwn(o,s1)]
      const removed=delete o[s1]
      const after=[removed,s1 in o,s2 in o,o[s1],o[s2],o.NaN]
      o[s1]=23
      return [before,after,o[s1]]
    }`
  for (const optimize of levels(0,1,2,3,'size')) {
    const got=jz(src,{optimize}).exports,want=oracle(src)
    for (const [mode,value] of [[0,7],[0,7],[1,0],[2,-1],[3,5],[4,6],[5,8],[6,10],[0,3]])
      is(got.f(mode,value),want.f(mode,value),`identity and delete/reinsert O${optimize}, family${mode}`)
  }
})


test('Symbol property keys are copied but excluded from string enumeration', () => {
  const src = `
    const s1=Symbol('value'),s2=Symbol('value')
    function copy(o){return {...o}}
    export function f(mode) {
      const values=[{},[],new Map(),new Set(),new ArrayBuffer(2)]
      const o=values[mode|0];o[s1]=7;o.b=11;o['2']=13;o[s2]=9;o.a=17
      let names='';for(const key in o)names+=key+','
      const a=copy(o),b=Object.assign({},o),{a:removed,...rest}=o
      return [Object.keys(o),Object.values(o),Object.entries(o),names,
        [a[s1],a[s2],a.a],[b[s1],b[s2]],[rest[s1],rest[s2],rest.a],removed]
    }`
  for (const optimize of levels(0,1,2,3,'size')) {
    const got=jz(src,{optimize,sourceInline:false}).exports,want=oracle(src)
    for (const mode of [0,0,1,2,3,4,0])is(got.f(mode),want.f(mode),`copy and enum O${optimize}, family${mode}`)
  }
})


test('Symbol property keys preserve string-hint conversion and abrupt completion', () => {
  const src = `
    const key=Symbol('key'),other=Symbol('key')
    export function f(mode) {
      let log='';const o={NaN:13}
      const k={get toString(){log+='g';return function(){log+='s';if(mode===2)throw new Error('key');return mode===1?{}:key}},
        valueOf(){log+='v';return other}}
      function receiver(){log+='r';return o}
      function rhs(){log+='x';return 7}
      try{receiver()[k]=rhs();const literal={[k]:11};
        return [o[key],o[other],o.NaN,literal[key],literal[other],k in o,log]}
      catch(e){return [e.message,log,o[key],o[other],o.NaN]}
    }`
  for (const optimize of levels(0,1,2,3,'size')) {
    const got=jz(src,{optimize,sourceInline:false}).exports,want=oracle(src)
    for (const mode of [0,0,1,2,0,1])is(got.f(mode),want.f(mode),`key conversion and recovery O${optimize}, ${mode}`)
  }
})


test('Symbol property keys survive constructors and method conversion', () => {
  const src = `
    const a=Symbol('value'),b=Symbol('value')
    export function f(mode){
      let log='';const key={toString(){log+='s';return mode?{}:a},valueOf(){log+='v';return b}}
      const obj=Object.fromEntries([[a,7],[b,9],['NaN',13],['Symbol',17]])
      obj[key]=21
      const grouped=Object.groupBy([1,2,3],x=>x%2?a:b)
      const map=new Map([[a,7],[b,9]]),set=new Set([a,b,a])
      return [obj[a],obj[b],obj.NaN,obj.Symbol,grouped[a],grouped[b],map.get(a),map.get(b),set.size,log]
    }`
  for (const optimize of levels(0,1,2,3,'size')) {
    const got=jz(src,{optimize,sourceInline:false}).exports,want=oracle(src)
    for(const mode of [0,0,1,0])is(got.f(mode),want.f(mode),`construct and convert O${optimize}, ${mode}`)
  }
})


test('Symbol property keys keep numeric NaNs separate and clone only string keys', () => {
  const src = `
    const a=Symbol('NaN'),b=Symbol('NaN')
    export function f(n){
      const words=new Uint32Array([0,0xfffc8000]),negativeNaN=new Float64Array(words.buffer)[0]
      const o={x:{value:n}};o[a]=7;o[b]=9;o.NaN=11;o[negativeNaN]=13
      const clone=structuredClone(o)
      clone.x.value++
      return [o[a],o[b],o.NaN,o[NaN],String(negativeNaN),clone[a],clone[b],Object.keys(clone),clone.NaN,o.x.value,clone.x.value]
    }`
  for (const optimize of levels(0,1,2,3,'size')) {
    const got=jz(src,{optimize,sourceInline:false}).exports,want=oracle(src)
    for(const n of [0,0,7,-1,0])is(got.f(n),want.f(n),`numeric keys and cloning O${optimize}, ${n}`)
  }
})


test('Symbol property keys preserve empty and durable enumeration across reuse', () => {
  const src = `
    const s=Symbol.for('hidden'),o={}
    export function f(mode){
      if(mode===1)o[s]=7
      if(mode===2)delete o[s]
      const keys=Object.keys(o),values=Object.values(o),entries=Object.entries(o)
      let count=0;for(const key in o)count++
      return [keys,values,entries,count,s in o,o[s],Object.hasOwn(o,s)]
    }`
  for (const optimize of levels(0,1,2,3,'size')) {
    const got=jz(src,{optimize}).exports,want=oracle(src),held=[]
    for(const mode of [0,0,1,1,0,2,0,1]){
      const result=got.f(mode),expected=want.f(mode)
      is(result,expected,`empty/durable O${optimize}, ${mode}`)
      held.push([result,expected])
    }
    for(const [result,expected] of held)is(result,expected,`retained outputs O${optimize}`)
  }
})


test('Symbol property keys never treat identity payloads as string addresses', () => {
  if(onKernel())return
  const src = `export function f(a,b){
    const o={};o[a]=7;o[b]=9;o.NaN=13
    const before=[o[a],o[b],a in o,b in o,Object.hasOwn(o,a)]
    delete o[a]
    const after=[o[a],o[b],a in o,b in o]
    o[a]=21
    return [before,after,o[a],Object.keys(o)]
  }`
  // The raw ABI preserves the actual identity bits. These auxiliary words
  // overlap string-cache/SSO flags; their low words are identities, not pointers.
  const keys=[ptrBits(PTR.ATOM,18,0xf0000010),ptrBits(PTR.ATOM,16384,0x10),
    ptrBits(PTR.ATOM,19,0xf0000011),ptrBits(PTR.ATOM,18,0)]
  const expected=[[7,9,true,true,true],[undefined,9,false,true],21,['NaN']]
  for(const optimize of levels(0,1,2,3,'size')){
    const mod=jz(src,{optimize,sourceInline:false})
    for(const [a,b] of [[0,1],[0,1],[2,3],[1,0],[0,2],[0,1]])
      is(mod.memory.read(mod.instance.exports.f(keys[a],keys[b])),expected,`raw identity O${optimize}, ${a}/${b}`)
  }
})
