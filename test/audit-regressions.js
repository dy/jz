import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel } from './_matrix.js'

const tiers = [0, 2, 'speed', 'size']
const vec = `
function vec(x,y){return {x,y}}
function add(a,b){return vec(a.x+b.x,a.y+b.y)}
function len(v){return Math.sqrt(v.x*v.x+v.y*v.y)}
export function run(n){let acc=vec(0,0);for(let i=0;i<n;i++)acc=add(acc,vec(i,-i));return len(acc)}`

test('audit: recursive mixed values retain identity across numeric comparisons', () => {
  const src = 'export function fib(n){return n<2?n:fib(n-1)+fib(n-2)}'
  for (const optimize of tiers) {
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
      for (const optimize of [2, 'speed']) {
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
    for (const optimize of tiers) {
      const { hof } = jz(src, { optimize, host: 'js' }).exports
      let calls=0
      const f = x => { calls++; return x+1 }
      f.call = () => -100 // Calling a value must not dispatch its .call property.
      is(hof(5,f),15); is(calls,5)
    }
  }
})

test('audit: record recurrence scalarizes without allocations', () => {
  for (const optimize of tiers) {
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
  for (const [body,expected] of cases) for (const optimize of tiers)
    is(jz(`export function result(){${body}}`,{optimize}).exports.result(),expected)
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
  for (const [body, good, bad, expected, failed] of cases) for (const optimize of tiers) {
    const src = `${prefix}export function result(key){calls=0;try{${body}}catch(e){return e===7?200+calls:e.name==='TypeError'?100+calls:-1}}`
    const { result } = jz(src, { optimize }).exports
    is(result(good), expected, 'A: valid call or argument exception')
    is(result(good), expected, 'A again: independent argument effects')
    is(result(bad), failed, 'B: missing/null callee still evaluates arguments')
    is(result(good), expected, 'A after B: recovery preserves behavior')
  }
  for (const optimize of tiers) {
    const { result } = jz('function twice(x){return x*2}export function result(key){const table={twice};return table[key](4)}', { optimize }).exports
    throws(() => result('missing'), TypeError, 'missing entry reaches the host as a TypeError')
    is(result('twice'), 8, 'host error does not poison the next call')
  }
})
