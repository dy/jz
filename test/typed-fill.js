// TypedArray.prototype.fill: the first element goes through the element
// writer, the rest are its bytes (module/typedarray.js __typed_fill), so every
// element kind fills alike, and the value converts once before the fill.
import test from 'tst'
import { levels } from './_matrix.js'
import { agree, oracle } from './util.js'
import { is } from 'tst/assert.js'
import jz from '../index.js'

const sum = 'const sum = (a) => { let h = 0; for (let i = 0; i < a.length; i++) h = h * 31 + a[i]; return h }\n'
const pool = `const pick = (k, n) => [new Float32Array(n), new Float64Array(n), new Float32Array(2 * n).subarray(n, 2 * n), new Float64Array(3 * n).subarray(n, 2 * n),
  new Int16Array(n), new Uint8Array(n), new Uint8ClampedArray(n), new Int32Array(n), new Uint32Array(n), new Int8Array(n), new Uint16Array(n)][k % 11]
`
const src = `${sum}${pool}
export let all = (k) => { const a = pick(k, 37); a.fill(3.75); return sum(a) }
export let range = (k) => { const a = pick(k, 37); a.fill(-2.5, 5, 30); return sum(a) }
export let fromEnd = (k) => { const a = pick(k, 37); a.fill(300.5, -9, -2); return sum(a) }
export let empty = (k) => { const a = pick(k, 37); a.fill(9, 30, 5); return sum(a) }
export let last = (k) => { const a = pick(k, 37); a.fill(7, 36); return sum(a) }
export let missing = (k) => { const a = pick(k, 9); a.fill(undefined); return sum(a) }
export let text = (k) => { const a = pick(k, 9); a.fill('12'); return sum(a) }
export let flag = (k) => { const a = pick(k, 9); a.fill(true, 2); return sum(a) }
export let returned = (k) => { const a = pick(k, 5); const b = a.fill(2); b[0] = 9; return sum(a) }
export let known = (k) => { const a = new Float64Array(k + 20); a.fill(1.25, 3); const b = new Uint8Array(k + 20); b.fill(257); const c = new Float32Array(33); c.fill(0.1); return sum(a) + sum(b) + sum(c) }
export let zero = (k) => { const a = pick(k, 37); a.fill(9); a.fill(0, 3, 30); return sum(a) }
export let ones = (k) => { const a = pick(k, 37); a.fill(-1, 1); return sum(a) }
export let nan = (k) => { const a = pick(k, 37); a.fill(1); a.fill(NaN, 2, 36); return a[3] !== a[3] ? -1 : sum(a) }
export let negZero = (k) => { const a = pick(k, 37); a.fill(-0, 0, 20); return 1 / a[1] < 0 ? -1 : sum(a) }`
const names = ['all', 'range', 'fromEnd', 'empty', 'last', 'missing', 'text', 'flag', 'returned', 'known', 'zero', 'ones', 'nan', 'negZero']

for (const optimize of levels(0, 2, 3, 'size'))
  test(`typed fill: every element kind at ${optimize}`, () => {
    for (const name of names) for (let k = 0; k < 11; k++) agree(src, name, [k], { optimize }, `${name}(${k})`)
  })

test('typed fill: a BigInt array keeps its BigInt', () => {
  const big = `export let f = (k) => { const a = new BigInt64Array(9); a.fill(5n, 1, 8); let h = 0n; for (let i = 0; i < 9; i++) h = h * 3n + a[i]; return Number(h) + k }`
  for (const optimize of levels(0, 2, 3, 'size')) agree(big, 'f', [3], { optimize }, `at ${optimize}`)
})

for (const method of ['fill', 'copyWithin']) test(`typed ${method}: capture arguments before ordered position coercion`, () => {
  const src = `export function f(mode,n) {
    let log=0, a=new Int32Array(n), saved=a, result, error=0
    for(let i=0;i<n;i++)a[i]=i+1
    function receiver(){log=log*10+9;if(mode===10)throw 99;return a}
    function arg(id,value){log=log*10+id;if(mode===id+6)throw id;return value}
    const first={valueOf(){log=log*10+4;if(mode===1)throw 44;saved[0]=9;return ${method === 'fill' ? 7 : 1}}}
    const second={valueOf(){log=log*10+5;if(mode===2)throw 55;saved[0]=8;if(mode===4)a=new Int32Array([20,21,22,23]);return 1}}
    const third={valueOf(){log=log*10+6;if(mode===3)throw 66;return 3}}
    try {result=receiver().${method}(arg(1,first),arg(2,second),arg(3,third))}catch(e){error=e}
    return[log,error,result===saved,a===saved,Array.from(saved),Array.from(a)]
  }`
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize}).exports.f,want=oracle(src).f
    for(const n of [0,4])for(const mode of [0,0,4,0,1,2,3,7,8,9,10,0])
      is(got(mode,n),want(mode,n),`${method} O${optimize}, mode ${mode}, length ${n}`)
  }
})

test('typed fill and copyWithin: position defaults, primitive conversions and empty ranges', () => {
  const src=`export function fill(start,end){const a=new Float64Array([1,2,3,4]);const b=a.fill(7,start,end);return[b===a,Array.from(a)]}
    export function copy(target,start,end){const a=new Int32Array([1,2,3,4]);const b=a.copyWithin(target,start,end);return[b===a,Array.from(a)]}
    export function replace(index){const base=new Float64Array([9,1,2,3,4,9]),a=base.subarray(1,5);const b=a.with(index,7);return[b===a,Array.from(b),Array.from(base)]}
    export function defaults(){const a=new Float64Array(2);a.fill();return[Array.from(a),Array.from(new Int32Array([1,2,3]).copyWithin(1))]}`
  const answer=(f,...args)=>{try{return['value',f(...args)]}catch(e){return['error',e.name]}}
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize}).exports,want=oracle(src)
    is(got.defaults(),want.defaults(),`missing value and positions O${optimize}`)
    for(const [start,end] of [[undefined,undefined],[null,undefined],['1.9','3.9'],[-Infinity,Infinity],[NaN,NaN],[-0,undefined],[-2,-1],[3,1],[1n,3],[1,3n]]){
      is(answer(got.fill,start,end),answer(want.fill,start,end),`fill positions O${optimize}, ${String(start)}, ${String(end)}`)
      is(answer(got.copy,1,start,end),answer(want.copy,1,start,end),`copy positions O${optimize}, ${String(start)}, ${String(end)}`)
      is(answer(got.replace,start),answer(want.replace,start),`with position O${optimize}, ${String(start)}`)
    }
  }
})

for (const method of ['indexOf','lastIndexOf','includes']) test(`typed ${method}: receiver and arguments precede nonempty offset conversion`, () => {
  const src=`export function f(mode,n){
    let log=0,a=new Int32Array(n),old=a
    for(let i=0;i<n;i++)a[i]=i+1
    function recv(){log=log*10+1;return a}
    function needle(){log=log*10+2;return 7}
    function position(){log=log*10+3;return{valueOf(){log=log*10+4;old[1]=7;a=new Int32Array([9]);if(mode)throw 5;return 1}}}
    let result,error=0;try{result=recv().${method}(needle(),position())}catch(e){error=e}
    return[log,result,error,Array.from(old),Array.from(a)]
  }`
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize}).exports.f,want=oracle(src).f
    for(const n of [0,1,4,4,0])for(const mode of [0,1,0])is(got(mode,n),want(mode,n),`${method} O${optimize} n${n} mode${mode}`)
  }
})

test('typed set and with: evaluate arguments before conversion and retain the original receiver', () => {
  for(const method of ['set','with']){
    const src=`export function f(mode,n){
      let log=0,a=new Int32Array(n),old=a,result,error=''
      for(let i=0;i<n;i++)a[i]=i+1
      function recv(){log=log*10+1;return a}
      function arg(i,v){log=log*10+i;if(mode===i+5)throw 'arg';return v}
      const pos={valueOf(){log=log*10+4;old[0]=9;a=new Int32Array([8]);if(mode===1)throw 'index';return mode===3?99:1}}
      const value={valueOf(){log=log*10+5;old[0]=7;if(mode===2)throw 'value';return 6}}
      try{result=recv().${method}(${method==='set'?'arg(2,[6]),arg(3,pos)':'arg(2,pos),arg(3,value)'})}catch(e){error=typeof e==='string'?e:e.name}
      return[log,error,result===undefined?[]:Array.from(result),Array.from(old),Array.from(a)]
    }`
    for(const optimize of levels(0,1,2,3,'size')){
      const got=jz(src,{optimize}).exports.f,want=oracle(src).f
      for(const n of [0,4])for(const mode of [0,0,1,2,3,7,8,0])is(got(mode,n),want(mode,n),`${method} O${optimize} n${n} mode${mode}`)
    }
  }
})

test('typed fill and with: BigInt conversion is required for empty and invalid ranges', () => {
  const src=`export function fill(big,n,value,start,end){
    const a=big?new BigInt64Array(n):new Int32Array(n);let error='',same=false
    try{same=a.fill(value,start,end)===a}catch(e){error=e.name}
    return[typeof value,error,same,Array.from(a)]
  }
  export function withValue(big,n,value,index){
    const a=big?new BigInt64Array(n):new Int32Array(n);let error='',result=[]
    try{result=Array.from(a.with(index,value))}catch(e){error=e.name}
    return[typeof value,error,result,Array.from(a)]
  }
  export function hooks(mode,n){
    const a=new BigInt64Array(n);let log=0,error=''
    const value={valueOf(){log=log*10+1;if(mode===1)throw 'value';return mode===2?3:3n}}
    const start={valueOf(){log=log*10+2;if(mode===3)throw 'start';return 1}}
    const end={valueOf(){log=log*10+3;return 2}}
    try{a.fill(value,start,end)}catch(e){error=typeof e==='string'?e:e.name}
    return[log,error,Array.from(a)]
  }`
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize}).exports,want=oracle(src)
    for(const big of [false,true])for(const n of [0,3])for(const value of [0n,-1n,5n,'7','x',true,false,3,NaN,-NaN,Infinity,null,undefined]){
      is(got.fill(big,n,value,2,1),want.fill(big,n,value,2,1),`empty fill O${optimize} ${big} n${n} ${String(value)}`)
      is(got.fill(big,n,value,0,undefined),want.fill(big,n,value,0,undefined),`fill O${optimize} ${big} n${n} ${String(value)}`)
      is(got.withValue(big,n,value,0),want.withValue(big,n,value,0),`with O${optimize} ${big} n${n} ${String(value)}`)
    }
    for(const n of [0,3])for(const mode of [0,1,2,3,0])is(got.hooks(mode,n),want.hooks(mode,n),`BigInt hooks O${optimize} n${n} mode${mode}`)
  }
})

test('typed positions: an always-throwing argument leaves a reusable instance intact', () => {
  const src=`export function f(mode){const a=new Int32Array(3);const fail=()=>{throw 9};let error=0;try{if(mode)a.fill(1,fail());else a.fill(2)}catch(e){error=e}return[error,Array.from(a)]}`
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize}).exports.f,want=oracle(src).f
    for(const mode of [0,1,1,0])is(got(mode),want(mode),`always throw O${optimize} ${mode}`)
  }
})

test('typed search positions: defaults preserve Number and BigInt needle identity', () => {
  const src=`export function f(big,needle,start){const a=big?new BigInt64Array([0n,1n,-1n,1n]):new Float64Array([0,NaN,1,1]);return[typeof needle,a.indexOf(needle,start),a.lastIndexOf(needle,start),a.includes(needle,start),a.lastIndexOf(needle)]}`
  const answer=(f,...args)=>{try{return['value',f(...args)]}catch(e){return['error',e.name]}}
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize}).exports.f,want=oracle(src).f
    for(const big of [false,true])for(const needle of [0,1,NaN,-NaN,undefined,0n,1n,-1n,'1',true])for(const start of [undefined,-Infinity,Infinity,-2,'1.9',1n])
      is(answer(got,big,needle,start),answer(want,big,needle,start),`search O${optimize} ${big} ${String(needle)} ${String(start)}`)
  }
})

test('typed captured values: later arguments cannot replace a numeric shadow', () => {
  const src=`export function fill(mode,n){let x=mode?null:7,s=0;const a=new Int32Array(1);for(let i=0;i<n;i++){s+=x*2;a.fill(x,(x=9,0));break}return[a[0],s,x]}
    export function withValue(mode,n){let x=mode?null:0,s=0;const a=new Int32Array([2,3]);let b=a;for(let i=0;i<n;i++){s+=x*2;b=a.with(x,(x=1,8));break}return[Array.from(b),s,x]}
    export function missing(i){const a=new BigInt64Array([7n]);let error='';try{a.fill(a[i],0,0)}catch(e){error=e.name}return[error,Array.from(a)]}`
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize}).exports,want=oracle(src)
    for(const mode of [0,1])for(const n of [0,1,1,0])for(const name of ['fill','withValue'])is(got[name](mode,n),want[name](mode,n),`${name} shadow O${optimize} ${mode} ${n}`)
    for(const i of [-1,0,1,0])is(got.missing(i),want.missing(i),`missing BigInt O${optimize} ${i}`)
  }
})

test('typed positions: nullish receiver rejection precedes argument evaluation', () => {
  for(const method of ['fill','copyWithin','set','with','indexOf','lastIndexOf','includes']){
    const src=`export function f(mode){let log=0;const a=mode?null:new Int32Array(3);const value=()=>{log++;return{valueOf(){log+=10;return 1}}};let error='';try{a.${method}(${method==='set'?'[2],value()':'value(),value()'})}catch(e){error=e.name}return[log,error]}`
    for(const optimize of levels(0,1,2,3,'size')){
      const got=jz(src,{optimize}).exports.f,want=oracle(src).f
      for(const mode of [1,1,0,1,0])is(got(mode),want(mode),`${method} receiver O${optimize} ${mode}`)
    }
  }
})

test('typed BigInt fill: primitive fallback and numeric NaN payloads reject faithfully', () => {
  const src=`export function f(mode){
    const bits=new ArrayBuffer(8), words=new Uint32Array(bits);words[0]=0;words[1]=4294443013
    const values=[[],[2],{valueOf(){return{}},toString(){return '3'}},{valueOf(){return{}},toString(){return{}}},new Date(0),new Float64Array(bits)[0]]
    const a=new BigInt64Array(2);let error='';try{a.fill(values[mode])}catch(e){error=e.name}
    return[error,Array.from(a)]
  }`
  for(const optimize of levels(0,1,2,3,'size')){
    const got=jz(src,{optimize}).exports.f,want=oracle(src).f
    for(const mode of [0,1,2,3,4,5,2,0])is(got(mode),want(mode),`BigInt primitive O${optimize} ${mode}`)
  }
})

test('typed method arguments: unused arguments run before method coercion', () => {
  for(const [method,args] of [['fill','value,0,2'],['copyWithin','value,0,2'],['set','[7],value'],['with','value,7'],['indexOf','7,value'],['lastIndexOf','7,value'],['includes','7,value']]){
    const src=`export function f(mode){let log=0,a=new Int32Array([1,2,3]),error='';const value={valueOf(){log=log*10+3;return 0}};function ignored(){log=log*10+2;if(mode)throw 'extra';return 1n}try{a.${method}(${args},(log=1),ignored())}catch(e){error=typeof e==='string'?e:e.name}return[log,error,Array.from(a)]}`
    for(const optimize of levels(0,1,2,3,'size')){
      const got=jz(src,{optimize}).exports.f,want=oracle(src).f
      for(const mode of [0,1,1,0])is(got(mode),want(mode),`${method} unused O${optimize} ${mode}`)
    }
  }
})
