import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel, levels } from './_matrix.js'
import { funcWat, oracle } from './util.js'
import { ctx } from '../src/ctx.js'
import { dictCapacity } from '../src/static.js'
import { stringHash } from '../src/string-data.js'

const TIERS = levels(0, 2, 'speed', 'size')

test('audit: collection fields lower to explicit layout offsets', () => {
  if (onKernel()) return
  const wat = compile('export function f(k){const m=new Map();m.set(k,42);return m.get(k)}', { optimize: 0, wat: true })
  for (const name of ['__map_get', '__map_set']) {
    const body = funcWat(wat, name)
    ok(body.includes('offset=8'), `${name}: key field uses its slot offset`)
    ok(body.includes('offset=16'), `${name}: value field uses its slot offset`)
  }
  const header = funcWat(wat, '__alloc_hdr_n')
  ok(header.includes('offset=8') && header.includes('offset=12'), 'allocated header fields need no address additions')
})

// FNV-1a preimages of the two reserved words and their signed neighbours.
const hashStrings = [[4660, 57487, 23428], [4660, 17474, 50024],
  [4660, 28643, 59466], [4660, 12245, 35047]].map(units => String.fromCharCode(...units))

test('audit: hash sentinels are unsigned words', () => {
  for (let i = 0; i < hashStrings.length; i++) {
    let h = 0x811c9dc5
    for (const ch of hashStrings[i]) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193)
    is(h, [0, 1, -2, -1][i], 'fixture reaches the raw hash boundary')
    is(stringHash(hashStrings[i]), [2, 3, 4294967294, 4294967295][i])
  }
})

test('audit: reserved-neighbour hashes survive collection lifecycles', () => {
  const keys = [1.0000007154885675, 1.0000007154885677, 0, -0, NaN,
    0n, 1n, 4294967294n, 4294967295n, ...hashStrings]
  const literal = k => typeof k === 'bigint' ? `${k}n` : typeof k === 'number' ? String(k) : JSON.stringify(k)
  const src = `export function lifecycle(k) {
    if(typeof k==='bigint')k+=0n;
    const m=new Map(),s=new Set();
    let out=''+m.has(k)+','+s.has(k);
    m.set(k,42);m.set(k,77);s.add(k);s.add(k);
    out+=','+m.size+','+m.get(k)+','+s.size;
    for(let i=0;i<40;i++){m.set('fill'+i,i);s.add('fill'+i)}
    out+=','+m.get(k)+','+m.size+','+s.has(k)+','+s.size;
    let total=0;for(const [key,value] of m)total+=value;
    let count=0;for(const value of s)count++;
    out+=','+total+','+count+','+m.delete(k)+','+s.delete(k);
    out+=','+m.has(k)+','+s.has(k)+','+m.delete(k)+','+s.delete(k);
    m.set(k,99);s.add(k);
    return out+','+m.get(k)+','+s.has(k)+','+m.size+','+s.size
  }
  ${keys.map((k, i) => `export function literal${i}(k){if(typeof k==='bigint')k+=0n;const m=new Map();m.set(${literal(k)},42);m.set(k,77);return m.size*1000+m.get(${literal(k)})}`).join('\n')}`
  const js = oracle(src)
  for (const optimize of TIERS) for (const _compactCollections of [false, true]) {
    const wasm = jz(src, { optimize, _compactCollections }).exports
    for (const k of [...keys, ...keys.slice().reverse()])
      is(wasm.lifecycle(k), js.lifecycle(k), `${optimize}, compact=${_compactCollections}: ${String(k)}`)
    keys.forEach((k, i) => is(wasm[`literal${i}`](k), 1077, 'literal and runtime hashes agree'))
  }
})

test('audit: sentinel-neighbour UTF-16 hashes agree across literals, slices and host dictionaries', () => {
  const src = `export function lookup(o,k){return o[k]}
    export function slices(s){const k=s.slice(1,-1),m=new Map();m.set(k,42);
      return m.get(k)+','+k}
    ${hashStrings.map((k, i) => `export function literal${i}(s){const m=new Map();m.set(${JSON.stringify(k)},42);return m.get(s.slice(1,-1))}`).join('\n')}`
  for (const optimize of TIERS) {
    const { exports, memory } = jz(src, { optimize })
    const obj = Object.fromEntries(hashStrings.map((k, i) => [k, i + 42]))
    const ptr = memory.Hash(obj)
    for (let i = 0; i < hashStrings.length; i++) {
      const k = hashStrings[i]
      is(exports.lookup(ptr, k), obj[k], 'host hash lane matches compiled probing')
      is(exports.slices('[' + k + ']'), '42,' + k, 'runtime slice retains its exact code units')
      is(exports[`literal${i}`]('[' + k + ']'), 42, 'runtime and interned literal agree')
    }
  }
})

test('audit: repeated access keys cannot borrow another occurrence\'s bounds', () => {
  const src = `export function run(n){
    const a=new Uint8Array(4),b=new Uint8Array(4);b[0]=77;
    let p=0;while(p<4){a[p++]=1;let rep=n;while(rep>0){a[p++]=2;rep--}}
    return b[0]*1000+a[3]
  }
  export function twins(n){const a=new Uint8Array(4),b=new Uint8Array(4);b[0]=77;
    let i=0;a[i]=1;i=n;a[i]=2;return b[0]*1000+a[0]}
  export function reversed(n){const a=new Uint8Array(4),b=new Uint8Array(4);b[0]=77;
    let i=n;a[i]=2;i=0;a[i]=1;return b[0]*1000+a[0]}`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const name of ['run', 'twins', 'reversed'])
      for (const n of [0, 1, 3, 4, 31, 32, 64, 64, 0])
        is(wasm[name](n), js[name](n), `${optimize}: ${name}(${n}) preserves adjacent storage`)
  }
})

test('audit: affine integer bounds cross helper chains', () => {
  const src = `function pair(a,o){return a[o*2]+a[o*2+1]}
    function forward(a,o){return pair(a,o+1)}
    export function calculate(){const a=new Float64Array(32);for(let i=0;i<32;i++)a[i]=i;
      let s=0;for(let r=0;r<8;r++)s+=forward(a,r);return s}`
  for (const optimize of TIERS) is(jz(src, { optimize }).exports.calculate(), 152)
  if (!onKernel()) {
    const worker = funcWat(compile(src, { optimize: 0, wat: true }), 'pair')
    ok(worker.includes('(param $o i32)'), 'closed helper uses an integer offset')
    ok(!/trunc|convert|__typed_idx/.test(worker), 'proven accesses need no numeric round trips or checked helper')
  }
})

test('audit: proven decimal digits render inline without changing open conversions', () => {
  const src = `function label(n){return 'x'+n}
    export function calculate(){let s='';for(let i=0;i<10;i++)s+=label(i);return s}`
  const js = oracle(src)
  for (const optimize of TIERS) is(jz(src, { optimize }).exports.calculate(), js.calculate())
  if (!onKernel()) {
    const wat = compile(src, { optimize: 'speed', wat: true })
    ok(!/__i32_to_str|__itoa|__ftoa/.test(wat), 'digit-only conversions retain no numeric formatter')
  }
  const open = `export function f(n){return 'x'+n}
    export function effects(){let n=0;const a='x'+n++;return a+','+n}`
  const ref = oracle(open)
  for (const optimize of TIERS) {
    const wasm = jz(open, { optimize }).exports
    for (const n of [-1, -0, 0, 9, 10, 0.5, 2147483648, NaN, Infinity]) is(wasm.f(n), ref.f(n), `${optimize}: ${n}`)
    is(wasm.effects(), ref.effects(), 'conversion evaluates its source once')
  }
})

test('audit: truncated quotient bounds preserve fixed-point remainders and wrapping', () => {
  for (const divisor of [256, -256, 3, 0, 0.000001]) {
    const src = `export function f(x){const n=(x&65535)-32768;
      const q=(n/${divisor})|0;return n-q*${divisor}}`
    const js = oracle(src)
    for (const optimize of TIERS) {
      const wasm = jz(src, { optimize }).exports
      for (const x of [0, 1, 32767, 32768, 32769, 65535]) is(wasm.f(x), js.f(x), `${optimize}: divisor ${divisor}, x=${x}`)
    }
  }
  const src = `export function f(x){const n=(x&65535)+123456;const q=(n/256)|0;return n-q*256}
    export function wrap(x){const n=(x&65535)+2147480000;const q=n>>4;return q*16}`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const x of [0, 1, 32767, 65535]) {
      is(wasm.f(x), js.f(x))
      is(wasm.wrap(x), js.wrap(x), 'signed-shift hull spans the wrap boundary')
    }
  }
  if (!onKernel()) {
    const wat = funcWat(compile(src, { optimize: 'speed', wat: true }), 'f')
    ok(!/f64\.(mul|sub)/.test(wat), 'fixed-point remainder stays in integer arithmetic')
  }
})

test('audit: cursor guards join offsets and retain negative-offset checks', () => {
  const src = `function scan(a,n,start){let r=start|0,s=0;
      for(let i=0;i<n;i++){s+=a[r+-1]+a[r]+a[r+1];r++}return s}
    export function run(n,len,start){const a=new Float64Array(len);
      for(let i=0;i<len;i++)a[i]=i+1;return scan(a,n,start)}`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const args of [[0, 0, 0], [0, 4, 1], [1, 4, 0], [1, 4, 1], [2, 4, 1], [3, 4, 1], [4, 9, 2], [1, 4, -1]])
      is(wasm.run(...args), js.run(...args), `${optimize}: ${args}`)
  }
  if (!onKernel()) {
    const wat = funcWat(compile(src, { optimize: 'speed', wat: true }), 'scan')
    is((wat.match(/i64\.lt_s/g) || []).length, 1, 'one upper extent for all cursor offsets')
    is((wat.match(/i64\.ge_s/g) || []).length, 1, 'one lower extent for all cursor offsets')
  }
})

test('audit: wrap invariants cross loop phases but stop at writes, branches and calls', () => {
  for (const between of ['', 'si=12;', 'if(flag)si=12;', 'bound=2;', 'change();']) {
    const src = `let bound=5;function change(){bound=2}
      export function run(n,flag){bound=n;const a=new Float64Array(8);
        for(let i=0;i<8;i++)a[i]=i+1;
        let si=0,wi=0,s=0;while(wi<3){s+=a[si];si=si+1;if(si>=bound)si=0;wi++}
        ${between}
        let t=0,ai=0;while(ai<7){t+=a[si];si=si+1;if(si>=bound)si=0;ai++}
        return s+t}`
    const js = oracle(src)
    for (const optimize of TIERS) {
      const wasm = jz(src, { optimize }).exports
      for (const n of [0, 1, 2, 5, 8, 9]) for (const flag of [false, true])
        is(wasm.run(n, flag), js.run(n, flag), `${optimize}: ${between} n=${n}, flag=${flag}`)
    }
  }
})

test('audit: parameter bounds cover all sites, effects and open inputs', () => {
  const src = `function twice(x){return x*2}
    function mutate(x){x=0.5;return x*2}
    function fallback(x=0.5){return x*2}
    function rec(x,n){return n?rec(x+1,n-1):x*2}
    export function run(flag,n){
      let x=1; const v=flag?(x=0.5):(x=3);
      let a=twice(x)+twice(v)+twice(n)+mutate(1)+fallback()+rec(1,3);
      const xs=new Uint8Array(0); a+=twice(xs[0]); return a;
    }
    export function effects(flag){let x=1;let y=twice(x++)+twice(x); const v=flag?(x=0.5):(x=3);return y+twice(x)+v}
    export function empty(n){let s=0;for(let i=0;i<n;i++)s+=twice(i);return s}
    export function large(){return twice(1073741824)}
    export function fraction(){return twice(0.25)}
    export function missing(){return twice()}`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const flag of [false, true]) {
      is(wasm.run(flag, 0.25), js.run(flag, 0.25), `${optimize}: missing typed element remains NaN`)
      is(wasm.effects(flag), js.effects(flag), `${optimize}: conditional writes and argument order`)
    }
    for (const n of [0, 1, 4]) is(wasm.empty(n), js.empty(n))
    for (const name of ['large', 'fraction', 'missing']) is(wasm[name](), js[name]())
  }
})

test('audit: call range census preserves evaluation order and poisons unknown sites', () => {
  if (onKernel()) return
  const rows = [
    ['site union', 'return h(-3)+h(7)', [], [-3, 7]],
    ['conditional expression', 'let x=1; const v=flag?(x=2):(x=7); return h(x)+v', [true], [2, 7]],
    ['conditional statement', 'let x=1; flag?(x=2):(x=7); return h(x)', [false], [2, 7]],
    ['compound RHS evaluated once', 'let x=1; x+=++x; return h(x)', [], [3, 3]],
    ['ordered arguments', 'let x=1; return h(x++,h(x++))+h(x)', [], [1, 3]],
    ['unknown forwarded value', 'return h(flag)', [0.25], null],
    ['unknown extra site', 'h(3); return h(flag)', [0.25], null],
    ['missing argument', 'return h()', [], null],
    ['fractional branch', 'let x=1; flag?(x=0.5):(x=7); return h(x)', [true], null],
    ['captured write', 'let x=1; const change=()=>{x=0.5}; change(); return h(x)', [], null],
    ['missing narrow load', 'const a=new Uint8Array(0); const x=a[0];return h(x)', [], null],
    ['positive product overflow', 'return h(1073741823)', [], [1073741823, 1073741823]],
    ['negative product overflow', 'return h(-1073741824)', [], [-1073741824, -1073741824]],
  ]
  for (const [name, body, args, range] of rows) {
    const src = `function h(n){return n*4} export function f(flag){${body}}`
    const wasm = jz(src, { optimize: 0 }).exports
    const rep = ctx.plans.programIndex.parameterAbiOf(ctx.funcs.map.get('h'))?.get(0)
    is(rep?.range ?? null, range, name)
    is(wasm.f(...args), oracle(src).f(...args), `${name}: JS parity`)
  }
})

test('audit: fixed calls evaluate excess arguments before entering the callee', () => {
  const src = `function zero(){return 10} function one(x){return x}
    function pair(x){return [x,x+1]} function host(){} host.method=x=>x;
    function boom(){throw 7}
    export function calculate(){let n=1; const a=one(n++,n++),z=zero(n++);
      const [b,c]=pair(n++,n++);const m=host.method(n++,n++);
      return a+z+b+c+m+n}
    export function throwing(){let n=0;try{one(n++,boom())}catch(e){return n+e}}
    export function missing(){return one()*4}`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const name of ['calculate', 'throwing', 'missing']) is(wasm[name](), js[name](), `${optimize}: ${name}`)
    is(wasm.calculate(), js.calculate(), `${optimize}: repeated call after failure`)
  }
})

test('audit: constant conditional lengths cross calls without folding unknown conditions', () => {
  const src = `const A=5,B=9;
    function scan(a){return a.length+a[7]}
    export function calculate(){const a=new Float64Array(A>B?A:B);a[7]=3;return scan(a)}`
  for (const optimize of TIERS) is(jz(src, { optimize }).exports.calculate(), 12)
  if (!onKernel()) {
    const worker = funcWat(compile(src, { optimize: 0, wat: true }), 'scan')
    ok(!/\(if|__typed_idx|i32\.load/.test(worker), 'constant conditional size eliminates length and bounds loads')
  }
  const dynamic = `const A=5,B=9;
    function scan(a){return a.length+a[7]}
    export function run(flag){let n=0;const a=new Float64Array((n++,flag)?A:B);return scan(a)+n}
    ` + 'export function boolText(){return `value=${A>B}`}'
  const js = oracle(dynamic)
  for (const optimize of TIERS) {
    const wasm = jz(dynamic, { optimize }).exports
    for (const flag of [true, false]) is(wasm.run(flag), js.run(flag), `${optimize}: unknown/effectful condition`)
    is(wasm.boolText(), js.boolText(), `${optimize}: comparisons retain boolean identity`)
  }
})

test('audit: dictionary capacity hints round non-power-of-two domains and preserve reuse', () => {
  for (const keys of [[], ['a'], ['a','b'], ['a','b','c','d','e']]) {
    const src = `export function run(n){const keys=${JSON.stringify(keys)};let sum=0;
      for(let t=0;t<n;t++){const counts={};for(let i=0;i<keys.length;i++){
        const k=keys[i];counts[k]=(counts[k]||0)+t+i+1;sum+=counts[k]}
        for(let i=0;i<keys.length;i++)sum+=counts[keys[i]]}return sum}`
    const js = oracle(src)
    for (const optimize of TIERS) {
      const wasm = jz(src, { optimize }).exports
      for (const n of [0, 1, 3, 3, 1, 0]) is(wasm.run(n), js.run(n), `${optimize}: ${keys.length} keys, ${n} iterations`)
    }
  }
  for (const length of [0, 1, 2, 5, 0x2000000]) {
    const cap = dictCapacity(length)
    ok(cap >= Math.max(2, length * 4) && !(cap & (cap - 1)), 'capacity covers the domain with a power-of-two mask')
    ok(cap * 28 + 16 < 0x100000000, 'entry storage and header cannot wrap wasm32')
  }
  for (const length of [null, -1, 0.5, 0x2000001, 0x20000000, Infinity])
    is(dictCapacity(length), null, 'unrepresentable capacity keeps ordinary growth')
})

test('audit: fill-helper intervals retain typed-store coercion and unknown-write guards', () => {
  const src = `const N=260;
    function fill(a,n){for(let i=0;i<n;i++)a[i]=i-130}
    function gather(table,indices){let s=0;for(let i=0;i<indices.length;i++)s+=table[indices[i]];return s}
    function overwrite(a,x){a[0]=x}
    export function run(x){const a=new Uint8Array(N>256?N:256),t=new Float64Array(256);
      for(let i=0;i<t.length;i++)t[i]=i;fill(a,N);overwrite(a,x);return gather(t,a)}
    export function miss(x){const a=new Int32Array(4),t=new Float64Array(4);
      fill(a,4);overwrite(a,x);return gather(t,a)}`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const x of [0, -1, 255, 256, 0.5]) {
      is(wasm.run(x), js.run(x), `${optimize}: wrapped stores, unknown overwrite ${x}`)
      is(wasm.miss(x), js.miss(x), `${optimize}: negative gather remains checked ${x}`)
    }
  }
})
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
