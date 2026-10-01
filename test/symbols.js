// Symbol tests: unique identities, interning
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile, instantiate } from '../index.js'
import { compile as wasm } from 'watr'
import { run, oracle } from './util.js'
import { levels, onWasi, onKernel } from './_matrix.js'

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
