import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel, levels } from './_matrix.js'

const TIERS = levels(0, 2, 'speed', 'size')
const vec = `
function vec(x,y){return {x,y}}
function add(a,b){return vec(a.x+b.x,a.y+b.y)}
function len(v){return Math.sqrt(v.x*v.x+v.y*v.y)}
export function run(n){let acc=vec(0,0);for(let i=0;i<n;i++)acc=add(acc,vec(i,-i));return len(acc)}`

test('audit: recursive mixed values retain identity across numeric comparisons', () => {
  const src = 'export function fib(n){return n<2?n:fib(n-1)+fib(n-2)}'
  for (const optimize of TIERS) {
    const { fib } = jz(src, { optimize }).exports
    for (const v of ['1', '', null, false, true, 0, 1]) is(fib(v), v, `${optimize}: ${JSON.stringify(v)}`)
    is(fib(10), 55)
  }
})

test('audit: Float32 SIMD preserves f64 arithmetic and store rounding', () => {
  const values = [1.0000001192092896, -1.0000001192092896, 0, -0, 1e30, 1e-30, Infinity, -Infinity, NaN]
  // Nine elements exercise both vector chunks and a scalar remainder.
  for (const ctor of ['Float32Array', 'Int16Array', 'Uint8Array', 'Int32Array']) {
    const src = `export function run(k){const a=new ${ctor}([${values.join(',')}]);const b=new Float32Array(a.length);for(let i=0;i<a.length;i++)b[i]=a[i]*k+1;return b}`
    const C = globalThis[ctor], input = new C(values)
    for (const k of [-0.9999998807907104, 1.0000000000000002, -0, Infinity]) {
      const expected = Float32Array.from(input, x => x*k+1)
      for (const optimize of levels(2, 'speed')) {
        const actual = jz(src, { optimize }).exports.run(k)
        for (let i=0;i<expected.length;i++) is(actual[i], expected[i], `${ctor} ${optimize} k=${k} i=${i}`)
      }
    }
  }
})

test('audit: standalone higher-order exports accept host callbacks', () => {
  if (onKernel()) return
  for (const decl of ['export function hof(n,f)', 'export const hof=(n,f)=>']) {
    const src = `${decl}{let s=0;for(let i=0;i<n;i++)s+=f(i);return s}`
    for (const optimize of TIERS) {
      const { hof } = jz(src, { optimize, host: 'js' }).exports
      let calls=0
      const f = x => { calls++; return x+1 }
      f.call = () => -100 // Calling a value must not dispatch its .call property.
      is(hof(5,f),15); is(calls,5)
    }
  }
})

test('audit: record recurrence scalarizes without allocations', () => {
  for (const optimize of TIERS) {
    const { run } = jz(vec, { optimize }).exports
    for (const n of [0,1,2,10,101]) { const s=n*(n-1)/2; is(run(n),Math.sqrt(s*s+s*s)) }
  }
  if (!onKernel()) ok(!compile(vec,{optimize:'speed',wat:true}).includes('(memory'), 'no heap for nonescaping records')
})

test('audit: record replacement preserves swaps, aliases and escaped identity', () => {
  const cases = [
    [`let p={x:1,y:2};for(let i=0;i<3;i++)p={y:p.x,x:p.y};return p.x*10+p.y`,21],
    [`let p={x:1,y:2};const old=p;p={x:3,y:4};return old.x*10+p.y`,14],
    [`let p={x:1,y:2};const get=()=>p.x;p={x:3,y:4};return get()`,3],
    [`let p={x:1,y:2};return (p={x:3,y:4}).y`,4],
    [`let p={x:1,y:2};p={x:3};return p.x`,3],
  ]
  for (const [body,expected] of cases) for (const optimize of TIERS)
    is(jz(`export function result(){${body}}`,{optimize}).exports.result(),expected)
})

test('audit: changing record shapes preserves absent fields and own keys', () => {
  const cases = [
    ['let p={x:1,y:2};p={x:3};return p.y', undefined],
    ['let p={x:1,y:2};p={};return p.y', undefined],
    ['let p={};p={x:3};return p.x', 3],
    ['let p={x:1,y:2};p={z:3};return p.x', undefined],
    ['let p={x:1,y:2};p={y:3,x:4};return p.x*10+p.y', 43],
    ['let p={x:1,y:2};const old=p;p={x:3};return old.y', 2],
    ['let p={x:1,y:2};const get=()=>p.y;p={x:3};return get()', undefined],
    ['let p={x:1,y:2};p={x:3};return Object.keys(p).join()', 'x'],
    ['let p={x:1,y:2};p={x:3,y:undefined};return Object.keys(p).join()', 'x,y'],
    ['let p={x:1,y:2};p={x:3};p.y=4;return p.y', 4],
    ['let p={x:1,y:2};p={x:3};return p.y+1', NaN],
    ['let p={x:1,y:2};p={x:3};return typeof p.y', 'undefined'],
    ['let p={x:1,y:2n};p={x:3};return p.y', undefined],
    ['let p={x:1,y:new Float64Array(1)};p={x:3};return p.y', undefined],
    ['let p={x:1,y:()=>2};p={x:3};return p.y', undefined],
    ['let p={x:1,y:null};p={x:3};return p.y', undefined],
    ['let p={x:1,y:2};p={x:3};p={x:4,y:0};return p.y', 0],
    ['let p={x:1,y:2};p={x:3};p={x:4,y:null};return p.y', null],
    ['let p={x:1,y:2};p={...{x:3}};return p.y', undefined],
    ['let p={x:1};Object.assign(p,{y:2});p={x:3};return p.y', undefined],
    ['let p={x:1};p={x:3};const before=p.y;Object.assign(p,{y:2});return before', undefined],
    ['let p={x:1};p.y=2;p={x:3};return p.y', undefined],
    ['let p={};const before=p.x;p.x=1;return before', undefined],
    ['let p={x:1,y:2};p=null;return p', null],
  ]
  for (const optimize of TIERS) for (const [body, expected] of cases) {
    const { result } = jz(`export function result(){${body}}`, { optimize }).exports
    is(result(), expected, `${optimize}: ${body}`)
    is(result(), expected, 'repeated call preserves absence')
  }
  // Raw BigInt payloads (including NaN-box-shaped bits) must be boxed before
  // either guarded or general schema dispatch can join them with absence.
  for (const value of ['0n', '-1n', '9223372036854775807n', '-9223372036854775808n', '0x7ff8000200000000n']) {
    for (const optimize of TIERS) {
      const { result } = jz(`export function result(which){
        let p={x:1,y:${value}};
        if(which===1)p={z:1,y:3n};if(which===0)p={x:3};return p.y
      }`, { optimize }).exports
      for (const which of [2,2,0,1,0,2]) is(result(which), which === 0 ? undefined : which === 1 ? 3n : BigInt(value.slice(0,-1)))
    }
  }
  for (const optimize of TIERS) {
    const { result } = jz(`function first(a){return a[0]}
      export function result(full){let p={x:1,items:[7]};if(!full)p={x:3};if(full===1)p={x:4,items:[]};return first(p.items)}`, { optimize }).exports
    // Existing absent-array dialect: preserve undefined, never dereference
    // the missing value as an array header. A present empty array is distinct.
    for (const full of [2,2,0,1,2]) is(result(full), full === 2 ? 7 : undefined)
  }
  // A → A → B → A in one instance: neither retained aliases nor a prior
  // allocation may supply the missing field of a newly constructed object.
  for (const optimize of TIERS) {
    const { result } = jz(`let p={x:1,y:2};
      export function result(full){if(full)p={x:3,y:4};else p={x:5};return p.y}`, { optimize }).exports
    for (const full of [true,true,false,true,false,false]) is(result(full), full ? 4 : undefined)
  }
})

test('audit: fixed array lengths survive helpers and record layouts', () => {
  const src = `function make(){const a=[];for(let i=0;i<32;i++){if(i&1)a.push({x:i,y:i*2});else a.push({x:i,z:i*3})}return a}
function count(a){let s=0;for(let i=0;i<a.length;i++)s+=a[i].x;return s}
export function result(){const a=make();return a.length+count(a)}`
  const optimize={level:'speed',sourceInline:false}
  is(jz(src,{optimize}).exports.result(),528)
  if (!onKernel()) {
    const w=compile(src,{optimize:{...optimize,watr:false},wat:true})
    const body=w.slice(w.indexOf('(func $count'),w.indexOf('(func $result'))
    ok(body.includes('(i32.const 32)') || body.includes('(f64.const 32)'), 'constant length reaches count')
    ok(!body.includes('i32.div_s'), 'no record-stride division for known length')
  }
  for (const change of ['a.push(3)', 'a.pop()', 'a.length=0']) {
    const code=`function change(a){${change};return a.length} export function result(){const a=[1,2];return change(a)}`
    is(jz(code,{optimize}).exports.result(),change.includes('push')?3:change.includes('pop')?1:0)
  }
})

test('builders: reserved capacity preserves push results, layouts and repeated calls', () => {
  const programs = [
    ['const a=[];for(let i=0;i<40;i++)a.push(i);return a', 'a.length+a[39]', 79],
    ['const a=[7];for(let i=0;i<5;i++)a.push(i,i+10);return a', 'a.length+a[0]+a[10]', 32],
    ['const a=[];for(let i=0;i<0;i++)a.push(i);return a', 'a.length', 0],
    ['const a=[];let n=0;for(let i=0;i<40;i++)n+=a.push(i);a.push(n);return a', 'a.length+a[40]', 861],
    ['const a=[];for(let i=0;i<33;i++)a.push({x:i,y:i+1,z:i+2});return a', 'a.length+a[32].x+a[32].z', 99],
    ['const a=[];for(let i=0;i<33;i++){if(i&1)a.push({k:1,x:i,y:i+1});else a.push({k:0,x:i})}return a', 'a.length+a[32].x+a[31].y', 97],
  ]
  for (const optimize of TIERS) for (const [body, value, expected] of programs) {
    const src = `function build(){${body}} export function result(){const a=build();return ${value}}`
    const { result } = jz(src, { optimize }).exports
    for (let i=0;i<3;i++) is(result(), expected, 'fresh builder instance')
    if (!onKernel()) {
      const wat = compile(src, { optimize, wat: true })
      ok(!/\$__arr_grow|\$__arr_push_slot(?:\s|\))|\$__arr_push1/.test(wat), 'proven builder has no growth helper')
    }
  }
})

test('builders: conditional growth, aliases, early exits and induction writes reject fixed capacity', () => {
  const bodies = [
    'const a=[];flag&&a.push(1);return a',
    'const a=[];flag||a.push(1);return a',
    'const a=[];(flag?null:0)??a.push(1);return a',
    'const a=[];for(let i=(a.push(9),0);i<40;i++)a.push(i);return a',
    'const a=[];try{if(flag)throw 1;a.push(3)}catch(e){a.push(4,5)}return a',
    'const a=[];try{if(flag)return a;a.push(3)}finally{a.push(4)}return a',
    'const a=[];for(let i=0;i<4;i++){if(flag)break;a.push(i)}return a',
    'const a=[];const b=a;b.push(7);return a',
    'const a=[];for(let i=0;i<4;i++){a.push(i);if(flag)i++}return a',
    'const a=[];for(let i=0;i<4;i++){if(flag)continue;a.push(i)}return a',
    'const a=[];for(let i=0;i<4;i++)a.push(i);a.length=1;return a',
  ]
  for (const optimize of TIERS) for (const body of bodies) {
    const src = `function build(flag){${body}}export function result(flag){const a=build(flag);let n=a.length;for(let i=0;i<a.length;i++)n=(n*31+a[i])|0;return n}`
    const native = new Function(src.replace('export function result', 'return function result'))()
    const { result } = jz(src, { optimize }).exports
    for (const flag of [true,true,false,true]) is(result(flag), native(flag), `${optimize}: ${body}, flag=${flag}`)
  }
})

test('audit: nullable calls evaluate arguments before throwing and recover', () => {
  const prefix = 'let calls=0;function twice(x){return x*2}function tick(){calls++;return 4}function pick(){calls=calls*10+1;return twice}function mark(){calls=calls*10+2;return 4}'
  const cases = [
    ['const table={};return table[key](tick())', 'x', 'y', 101, 101],
    ['const table=[];return table[key](tick())', 0, 1, 101, 101],
    ['return pick()(...[mark()])+calls', 0, 1, 20, 20],
    ['const o={f:key?twice:null};return o.f(tick())+calls', 1, 0, 9, 101],
    ['const o={f:twice};return o.f(...[(o.f=x=>x+3,4)])', 0, 1, 8, 8],
    ['const table={twice};return table[key](tick())+calls', 'twice', 'missing', 9, 101],
    ['const table=[twice];return table[key](tick())+calls', 0, 1, 9, 101],
    ['const table={twice};return table[key](...[tick()])+calls', 'twice', 'missing', 9, 101],
    ['const table={twice};return table[key](...[])', 'twice', 'missing', NaN, 100],
    ['let f=key?twice:null;return f((calls++,f=x=>x+3,4))+calls', 1, 0, 9, 101],
    ['const table={twice};return table[key]((()=>{calls++;throw 7})())', 'twice', 'missing', 201, 201],
  ]
  for (const [body, good, bad, expected, failed] of cases) for (const optimize of TIERS) {
    const src = `${prefix}export function result(key){calls=0;try{${body}}catch(e){return e===7?200+calls:e.name==='TypeError'?100+calls:-1}}`
    const { result } = jz(src, { optimize }).exports
    is(result(good), expected, 'A: valid call or argument exception')
    is(result(good), expected, 'A again: independent argument effects')
    is(result(bad), failed, 'B: missing/null callee still evaluates arguments')
    is(result(good), expected, 'A after B: recovery preserves behavior')
  }
  for (const optimize of TIERS) {
    const { result } = jz('function twice(x){return x*2}export function result(key){const table={twice};return table[key](4)}', { optimize }).exports
    throws(() => result('missing'), TypeError, 'missing entry reaches the host as a TypeError')
    is(result('twice'), 8, 'host error does not poison the next call')
  }
})
