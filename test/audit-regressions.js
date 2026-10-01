import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { instantiate } from '../interop.js'
import { belowOpt, onKernel, levels } from './_matrix.js'
import { funcWat, oracle, agree } from './util.js'
import { ctx } from '../src/ctx.js'
import { dictCapacity } from '../src/static.js'
import { stringHash } from '../src/string-data.js'
import parseWat from 'watr/parse'

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
      for(let i=0;i<len;i++)a[i]=i+1;return scan(a,n,start)}
    export function step(n){const a=new Float64Array([10,20,30]);let i=n|0;
      const v=a[i++ + -1];return (v===undefined?-1000:v)+i*10}`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const args of [[0, 0, 0], [0, 4, 1], [1, 4, 0], [1, 4, 1], [2, 4, 1], [3, 4, 1], [4, 9, 2], [1, 4, -1],
      [0, 0, -2147483648], [1, 4, -2147483648], [1, 4, 2147483647], [2, 4, 2147483647]])
      is(wasm.run(...args), js.run(...args), `${optimize}: ${args}`)
    for (const n of [0, 0, 1, 2, 3, 0, 2147483647, -2147483648])
      is(wasm.step(n), js.step(n), `${optimize}: step(${n}) evaluates its index once`)
  }
  if (!onKernel()) {
    // pre-watr: `run` releases what it made as it returns, so its call of `scan` is one watr inlines;
    // one loop: its int32 copy (plan/integral-loops.js) guards its own extents alike
    const wat = funcWat(compile(src, { optimize: { level: 'speed', watr: false, versionIntegralLoops: false }, wat: true }), 'scan')
    ok(wat.length > 0, 'inspect cursor extents before backend inlining')
    // Saturating conversions in the checked twin can compare against the
    // signed-word endpoints too. Count only the loop's entry condition.
    const entry = parseWat(wat).find(n => Array.isArray(n) && n[0] === 'if')
    ok(entry, 'cursor loop has an entry guard')
    const guard = JSON.stringify(entry[1])
    is((guard.match(/i64\.lt_s/g) || []).length, 1, 'one upper extent for all cursor offsets')
    is((guard.match(/i64\.ge_s/g) || []).length, 1, 'one lower extent for all cursor offsets')
    const addresses = []
    const loads = n => {
      if (!Array.isArray(n)) return
      if (n[0] === 'f64.load') addresses.push(n[n.length - 1])
      for (let i = 1; i < n.length; i++) loads(n[i])
    }
    loads(entry[2])
    is(addresses.length, 3, 'inspect all cursor reads in the fast arm')
    ok(addresses.every(a => !/trunc_sat_f64_s|i64\.lt_s/.test(JSON.stringify(a))), 'proved negative offsets use word arithmetic in the fast arm')
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

test('audit: proven typed element bounds survive scalar locals and cached reads', () => {
  const src = `
    function gather(a,b,n){let s=0;for(let i=0;i<n;i++){
      const v=a[i&15];s+=b[v]+v*v}return s}
    function repeat(a,n){let s=0;for(let i=0;i<n;i++)s+=a[3]*a[3];return s}
    export function run(n){const a=new Int32Array(16),b=new Float64Array(16);
      for(let i=0;i<16;i++){a[i]=i;b[i]=i+1}return gather(a,b,n)+repeat(a,n)}`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const n of [0, 1, 16, 17, 17, 2, 0])
      is(wasm.run(n), js.run(n), `${optimize}: bounded elements, ${n} iterations`)
  }
  if (!onKernel()) {
    const wat = compile(src, { optimize: 'speed', wat: true })
    ok(wat.includes('i32.mul') && !wat.includes('f64.mul'),
      'bounded squares use integer multiplication, including after helper inlining')
  }
})

test('audit: typed element bounds require presence and respect stored width', () => {
  const rows = [
    ['empty', 'Int32Array', '[]', 0],
    ['negative index', 'Int32Array', '[3,4]', -1],
    ['past final element', 'Int32Array', '[3,4]', 2],
    ['signed store wraps', 'Int8Array', '[255]', 0],
    ['unsigned store wraps', 'Uint8Array', '[-1]', 0],
    ['large square', 'Int32Array', '[46341]', 0],
    ['unsigned high bit', 'Uint32Array', '[2147483648]', 0],
    ['float payload', 'Float64Array', '[1.5]', 0],
  ]
  const src = rows.map(([, ctor, values, idx], k) => `
    function square${k}(a,n){let s=0;for(let i=0;i<n;i++)s+=a[${idx}]*a[${idx}];return s}
    export function f${k}(n){return square${k}(new ${ctor}(${values}),n)}`).join('\n')
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (let k=0;k<rows.length;k++) for (const n of [0, 1, 2, 2, 0])
      is(wasm[`f${k}`](n), js[`f${k}`](n), `${optimize}: ${rows[k][0]}, ${n} iterations`)
  }
})

test('audit: bounded element products preserve negative zero', () => {
  const src = `
    function product(a,n){let s=1;for(let i=0;i<n;i++){const v=a[i&3];s=v*(v-4)}return s}
    function negate(a,n){let s=1;for(let i=0;i<n;i++){const v=a[i&3];s=v*-1}return s}
    export function p(n){return product(new Int32Array([0,1,2,3]),n)}
    export function q(n){return negate(new Int32Array([0,1,2,3]),n)}`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const name of ['p','q']) for (const n of [0,1,2,4,5,5,0])
      ok(Object.is(wasm[name](n), js[name](n)), `${optimize}: ${name}(${n}) preserves zero sign`)
  }
})

test('audit: integer products preserve zero sign through every numeric carrier', () => {
  const rows = [
    ['word times zero', '', '(x|0)*0'],
    ['zero times word', '', '0*(x|0)'],
    ['word times negative zero', '', '(x|0)*-0'],
    ['negative zero times word', '', '-0*(x|0)'],
    ['masked times negative', '', '(x&255)*-1'],
    ['negative times masked', '', '-1*(x&255)'],
    ['signed and unsigned words', '', '(x>>24)*(y&15)'],
    ['signed bytes', 'const a=new Int8Array([x,y]);', 'a[0]*a[1]'],
    ['signed shorts', 'const a=new Int16Array([x,y]);', 'a[0]*a[1]'],
    ['effectful zero factor', '', '((count++,x)|0)*0'],
    ['effectful negative zero factor', '', '-0*((count++,x)|0)'],
    ['compound assignment', 'let z=x&255;', '(z*=-1)'],
    ['compound zero factor', 'let z=x|0;', '(z*=0)'],
    ['compound negative zero factor', 'let z=x|0;', '(z*=-0)'],
  ]
  const src = rows.map(([, setup, product], i) => `
    export function f${i}(x,y){let count=0;${setup}const v=${product};
      const a0=[v],o={v},t=new Float64Array([v]),t32=new Float32Array([v]);
      return [v,1/v,a0[0],1/a0[0],o.v,1/o.v,t[0],1/t[0],t32[0],1/t32[0],count]}
  `).join('\n')
  const js = oracle(src)
  const inputs = [[-2147483648,0],[-1,0],[0,-1],[0,0],[1,0],
    [2147483647,-1],[-1,1],[NaN,Infinity],[-0,1],[1,-0],[0,-1]]
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const wasm = jz(src, {optimize}).exports
    for (let i=0;i<rows.length;i++) for (const args of inputs) {
      const actual=wasm[`f${i}`](...args), expected=js[`f${i}`](...args)
      for (let k=0;k<expected.length;k++)
        ok(Object.is(actual[k],expected[k]), `${optimize}: ${rows[i][0]}, ${args}, carrier ${k}`)
    }
  }
  if (!onKernel() && !belowOpt(2)) {
    const wat = compile(`export function positive(x,y){return (x&255)*(y&255)}
      export function square(x){const v=x>>24;return v*v}`, {optimize:2,wat:true})
    for (const name of ['positive','square']) {
      const body = funcWat(wat, name) || funcWat(wat, `${name}$exp`)
      ok(body.includes('i32.mul') && !body.includes('f64.mul'), `${name}: faithful products retain integer multiplication`)
    }
  }
})

test('audit: integer negation preserves zero sign and the signed boundary', () => {
  const src = `
    function neg(v){return -v}
    function local(a,i){const v=a[i&3];const n=-v;return n}
    function assigned(a,i){let n=1;for(let k=0;k<2;k++){const v=a[i&3];n=-v}return n}
    export function direct(i){return neg(i|0)}
    export function stored(i){return local(new Int32Array([0,1,-1,-2147483648]),i)}
    export function update(i){return assigned(new Int32Array([0,1,-1,-2147483648]),i)}
    export function unsigned(i){return -(i>>>0)}
    export function bounded(i){const v=(i&7)+1;return -v}`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const name of ['direct','stored','update','unsigned','bounded'])
      for (const i of [0,0,1,2,3,-2147483648,2147483647,0])
        ok(Object.is(wasm[name](i),js[name](i)), `${optimize}: ${name}(${i}) preserves sign and magnitude`)
  }
  if (!onKernel()) {
    const wat = compile('export function f(x){const v=(x&7)+1;return -v}', {optimize: 2,wat:true})
    ok(wat.includes('i32.sub') && !wat.includes('f64.neg'), 'proven nonzero negation stays integer')
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

test('audit: compile-time integer conversion wraps beyond i64 during self-hosting', () => {
  const values = [1e30, -1e30, 2 ** 63 + 2048, -(2 ** 63 + 2048), 2 ** 64 + 8192, 1.5, Infinity, -Infinity, NaN]
  const ctors = ['Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array']
  const literals = values.join(',')
  const expressions = values.flatMap(v => [`(${v})|0`, `(${v})>>>0`, `1<<(${v})`, `~(${v})`])
  const source = ctors.map((ctor, i) => `export function c${i}(){return new ${ctor}([${literals}])}`).join('\n') +
    `\nexport function bits(){return [${expressions.join(',')}]}`
  const expected = values.flatMap(v => [v | 0, v >>> 0, 1 << v, ~v])
  for (const optimize of TIERS) {
    const exports = jz(source, { optimize }).exports
    for (let repeat = 0; repeat < 2; repeat++) {
      for (let i = 0; i < ctors.length; i++) {
        const actual = exports[`c${i}`](), want = new globalThis[ctors[i]](values)
        for (let k = 0; k < values.length; k++) is(actual[k], want[k], `${ctors[i]} ${optimize} ${values[k]}`)
      }
      const actual = exports.bits()
      for (let i = 0; i < expected.length; i++) is(actual[i], expected[i], `bitwise ${optimize} ${expressions[i]}`)
    }
  }
})

// The README's "bitwise operands under 2^63": a bitwise operator converts its
// operand through a saturating i64 truncation (src/ir/numeric.js toI32), exact
// under 2^63 and for every nonfinite; past it the operand reads as -1, or as 0
// when negative. No compare per conversion pays for the wrap modulo 2^32.
test('audit: a bitwise operand converts as JS under 2^63 and saturates past it', () => {
  const src = `export let or0 = (x) => x | 0
    export let shr0 = (x) => x >>> 0
    export let and = (x) => x & 0xffff
    export let not = (x) => ~x
    export let shl = (x) => x << 1
    export let xor = (x) => x ^ 5
    export let imul = (x) => Math.imul(x, 3)`
  const want = oracle(src), ops = ['or0', 'shr0', 'and', 'not', 'shl', 'xor', 'imul']
  const exact = [0, -0, 1.5, -1.5, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 4e9, -4e9, 2 ** 53 + 2, 1e18, -1e18, 2 ** 62, 2 ** 63 - 1024, -(2 ** 63), Infinity, -Infinity, NaN]
  const past = [2 ** 63, 2 ** 63 + 2048, 2 ** 64 + 8192, 1e20, 1e300, -(2 ** 63 + 2048), -1e20, -1e300]
  for (const optimize of TIERS) {
    const got = jz(src, { optimize }).exports
    for (const x of exact) for (const op of ops) is(got[op](x), want[op](x), `${op}(${x}) at ${optimize}`)
    for (const x of past) for (const op of ops) is(got[op](x), want[op](x > 0 ? -1 : 0), `${op}(${x}) at ${optimize} is ${op}(${x > 0 ? -1 : 0})`)
  }
})

// A string operand need not be a literal: a local that holds one makes `+` a
// concatenation and `<` a comparison of strings, whatever the other operand's
// kind (src/compile/param-numeric.js isStr). A parameter beside it keeps its
// runtime dispatch: read as a number, 'b' was NaN and 'a' < 'm' was false.
test('audit: a local that holds a string concatenates and compares as one', () => {
  const src = `export let acc = (a, b, c) => { const s = ""; const s1 = s + a; const s2 = s1 + b; const s3 = s2 + c; return s3 }
    export let pre = (a, b) => { const p = "p:"; return p + a + b }
    export let post = (a, b) => { const p = ":p"; const q = a + p; return q + b }
    export let lt = (x) => { const m = "m"; return x < m ? 1 : 0 }
    export let ge = (x) => { const m = "m"; return m >= x ? 1 : 0 }
    export let built = (x, y) => { const m = "m" + y; return x > m ? 1 : 0 }`
  const want = oracle(src)
  const values = [1, -0.5, 'a', 'z', '-', '10', '9', true, null, undefined]
  for (const optimize of TIERS) {
    const got = jz(src, { optimize }).exports
    for (const a of values) for (const b of values) {
      is(got.acc(a, b, 2), want.acc(a, b, 2), `acc(${String(a)}, ${String(b)}, 2) at ${optimize}`)
      is(got.pre(a, b), want.pre(a, b), `pre(${String(a)}, ${String(b)}) at ${optimize}`)
      is(got.post(a, b), want.post(a, b), `post(${String(a)}, ${String(b)}) at ${optimize}`)
      is(got.built(a, b), want.built(a, b), `built(${String(a)}, ${String(b)}) at ${optimize}`)
    }
    for (const x of values) for (const f of ['lt', 'ge']) is(got[f](x), want[f](x), `${f}(${String(x)}) at ${optimize}`)
  }
})

// A sum whose value is read as a string is a concatenation: its operands are read as
// strings, and a parameter among them is no number at the boundary (src/summary
// demand, `STR`). Read as a number, `s + s` was NaN and `.slice` read it as an address.
test('audit: a parameter summed and then read as a string is a string', () => {
  const src = `export let twice = (s) => { const x = s + s; return x.slice(1) }
    export let inline = (s, t) => (s + t).slice(1)
    export let chain = (s, t) => { const a = s + '-'; const b = a + t; const c = b + b; return c.length }
    export let helper = (s) => { const x = s + s; return cut(x) }
    const cut = (v) => v.charCodeAt(0) + v.length
    export let fixed = (a, b) => (a + b).toFixed(1)`
  const want = oracle(src)
  for (const optimize of TIERS) {
    const got = jz(src, { optimize }).exports
    for (const [s, t] of [['ab', 'cd'], ['', 'x'], ['+1', '0']]) {
      is(got.twice(s), want.twice(s), `twice('${s}') at ${optimize}`)
      is(got.inline(s, t), want.inline(s, t), `inline('${s}', '${t}') at ${optimize}`)
      is(got.chain(s, t), want.chain(s, t), `chain('${s}', '${t}') at ${optimize}`)
      is(got.helper(s + 'q'), want.helper(s + 'q'), `helper('${s}q') at ${optimize}`)
    }
    // a member a number has is no read as a string: the operands stay numbers
    is(got.fixed(1.25, 2), want.fixed(1.25, 2), `fixed(1.25, 2) at ${optimize}`)
  }
})

// A store reads its key before its value (PutValue): a value whose call moves what the
// key reads stores where the key was (module/typedarray.js). The typed store took the
// value first and read the key after it.
test('audit: a typed store reads its key before a value that moves it', () => {
  const src = `const OUT = new Float64Array(4), AT = new Int32Array(1)
    let at = 0
    const step = (v) => { at += 1; AT[0] += 1; let s = 0; for (let i = 0; i < 3; i++) s += v; return s }
    export let global = (x) => { at = 0; OUT.fill(0); OUT[at] = step(x); return OUT[0] * 100 + OUT[1] + at }
    export let element = (x) => { AT[0] = 0; OUT.fill(0); OUT[AT[0]] = step(x); return OUT[0] * 100 + OUT[1] + AT[0] }
    export let local = (x) => { let k = 0; OUT.fill(0); OUT[k] = (k = 2, x * 3); return OUT[0] * 100 + OUT[2] + k }
    export let twice = (x) => { at = 0; OUT.fill(0); OUT[at] = step(x); OUT[at] = step(x + 1); return OUT[0] * 10000 + OUT[1] * 100 + OUT[2] + at }`
  const want = oracle(src)
  for (const optimize of TIERS) {
    const got = jz(src, { optimize }).exports
    for (const x of [3, 0.5, -2]) for (const f of ['global', 'element', 'local', 'twice']) is(got[f](x), want[f](x), `${f}(${x}) at ${optimize}`)
  }
})

// A call that passes a BigInt and a Number to one operator throws when it runs, at every
// level: spliced into its caller the operator was one the compiler rejects (plan/inline.js).
test('audit: a call that mixes a BigInt and a Number throws when it runs', () => {
  const src = `function sub(a, b) { return a - b }
    function scale(a, k) { const d = a * 2n; return d << k }
    export function mixed(c) { return c ? sub(3n, 1n) : sub(3, 1) }
    export function returned() { return sub(3n, 1) }
    export function declared() { const r = sub(3n, 1); return r }
    export function stored(o) { let r = 0n; r = sub(1, 3n); return r }
    export function shifted() { return scale(5n, 2n) }`
  for (const optimize of TIERS) {
    const e = jz(src, { optimize }).exports
    is(e.mixed(1), 2n, `a BigInt pair at ${optimize}`)
    is(e.mixed(0), 2, `a Number pair at ${optimize}`)
    is(e.shifted(), 40n, `a BigInt body at ${optimize}`)
    for (const f of ['returned', 'declared', 'stored']) throws(() => e[f](), /Cannot mix BigInt/, `${f} at ${optimize}`)
  }
})

test('audit: constant parameters preserve conditional mixed-domain errors and argument effects', () => {
  for (const op of ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '+=', '-=', '*=', '&=', '<<=']) {
    const src = `let trace = 0
      function value() { trace = trace * 10 + 1; return 3n }
      function mix(a, b) { trace = trace * 10 + 2; return a ${op} b }
      export function f(go) {
        trace = 0
        try { if (go) mix(value(), 1) }
        catch (e) { return [trace, e instanceof TypeError] }
        return [trace, false]
      }`
    const host = oracle(src).f
    for (const optimize of TIERS) {
      const f = jz(src, { optimize }).exports.f
      for (const go of [0, 1, 1, 0]) is(f(go), host(go), `${op}(${go}) at ${optimize}`)
    }
  }
})

test('audit: constant parameters preserve a guarded Number-or-BigInt domain', () => {
  const src = `let trace = 0
    function value(c) { trace = trace * 10 + 1; return c === 2 ? 3 : 3n }
    function mix(a, k) {
      trace = trace * 10 + 2
      if (typeof a === 'bigint') return a - k
      return a + k
    }
    export function f(c) {
      trace = 0
      try { const result = c ? mix(value(c), 1) : 0; return [trace, result] }
      catch (e) { return [trace, e instanceof TypeError] }
    }`
  const host = oracle(src).f
  for (const optimize of TIERS) {
    const f = jz(src, { optimize }).exports.f
    for (const c of [0, 1, 1, 2, 0, 2]) is(f(c), host(c), `guarded input ${c} at ${optimize}`)
  }
})

// A closure stored beside the fields of an object a literal nested (`ns.inner.parse = f`
// where the literal declared no `parse`) runs when the member is called
// (src/summary/index.js): its body is reached and its parameter bound. Unreached, a
// binding of its body had no kind and a BigInt shifted as an i32.
test('audit: a closure stored beside a nested object\'s fields is reached by its call', () => {
  const src = `function parseNum(n) {
      const b = typeof n === 'string' ? BigInt(n) : n
      const m = b >> 7n
      return m
    }
    function scale(v) { const half = v * 0.5; const s = "v" + half; return s }
    const ns = { inner: {}, deep: { er: {} } }
    ns.inner.parse = parseNum
    ns.deep.er.scale = scale
    export let f = (s) => { const nodes = []; nodes.push(s); return ns.inner.parse(nodes.shift()) }
    export let g = (v) => ns.deep.er.scale(v)`
  const want = oracle(src)
  for (const optimize of TIERS) {
    const got = jz(src, { optimize }).exports
    for (const s of ['900', '-129', '0', '9223372036854775807']) is(got.f(s), want.f(s), `f('${s}') at ${optimize}`)
    for (const v of [3, -0.5, 1e21]) is(got.g(v), want.g(v), `g(${v}) at ${optimize}`)
  }
})

test('audit: runtime integer conversion is exact for every element store', () => {
  // The exact ToInt32 kernel's regions: |x| < 2⁶³ (saturating i64 truncation is
  // exact), the shifted-significand band up to 2⁸⁴, multiples of 2³² beyond,
  // plus fractions, signed zero and nonfinite inputs — each stored through every
  // integer element kind, DataView setter, Atomics lane and String.fromCharCode.
  const values = [1e30, -1e30, 4e9, -4e9, 2 ** 63, 2 ** 63 + 2048, -(2 ** 63 + 2048), 2 ** 63 - 1024, 2 ** 64 + 8192,
    3e19, 2 ** 83 + 2 ** 31, -(2 ** 83 + 2 ** 31), 2 ** 84, 2 ** 84 + 2 ** 32 + 1, 2 ** 53 + 2, 2 ** 31, 2 ** 32 - 1, 2 ** 32,
    1.5, -1.5, 255.9, -0.9, 0, -0, Infinity, -Infinity, NaN]
  const ctors = ['Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array']
  const ops = ['store', 'fill', 'from', 'set', 'map']
  const src = ctors.map((ctor, i) => `
    export function store${i}(x){const a=new ${ctor}(2);a[1]=x;return a[1]}
    export function fill${i}(x){return new ${ctor}(3).fill(x)[2]}
    export function from${i}(x){return ${ctor}.from([x,x])[1]}
    export function set${i}(x){const a=new ${ctor}(2);a.set([x],1);return a[1]}
    export function map${i}(x){return new ${ctor}(2).map(()=>x)[1]}`).join('\n') + `
    function put(a,x){a[0]=x;return a[0]}
    export function generic(k,x){return put(k?new Int16Array(1):new Uint8Array(1),x)}
    let calls=0
    function next(x){calls++;return x}
    export function once(x){const a=new Int8Array(1);calls=0;a[0]=next(x);return a[0]*1000+calls}
    export function dv(x,le,off){const d=new DataView(new ArrayBuffer(16));d.setInt32(off,x,le);d.setUint16(off+8,x,le);return [d.getInt32(off,le),d.getUint16(off+8,le),d.getUint8(off)]}
    export function atomic(x){const a=new Int32Array(2);const r=Atomics.store(a,1,x);return [a[1],r,Atomics.add(a,1,x),a[1]]}
    export function unit(x){const s=String.fromCharCode(x,x+1);return s.charCodeAt(0)*65536+s.charCodeAt(1)}`
  const want = oracle(src)
  for (const optimize of TIERS) {
    const got = jz(src, { optimize }).exports
    for (let repeat = 0; repeat < 2; repeat++) for (const x of values) {
      for (let i = 0; i < ctors.length; i++) for (const op of ops)
        is(got[`${op}${i}`](x), want[`${op}${i}`](x), `${ctors[i]}.${op} ${optimize} ${x}`)
      for (const k of [0, 1]) is(got.generic(k, x), want.generic(k, x), `generic ${k} ${optimize} ${x}`)
      is(got.once(x), want.once(x), `side effect once ${optimize} ${x}`)
      for (const le of [true, false]) for (const off of [0, 3])
        is(got.dv(x, le, off), want.dv(x, le, off), `dataview le=${le} off=${off} ${optimize} ${x}`)
      is(got.atomic(x), want.atomic(x), `atomics ${optimize} ${x}`)
      is(got.unit(x), want.unit(x), `fromCharCode ${optimize} ${x}`)
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
    // A missing array throws; a present empty array yields undefined.
    for (const full of [2,2,0,1,2]) {
      if (full === 0) throws(() => result(full), TypeError)
      else is(result(full), full === 2 ? 7 : undefined)
    }
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

test('audit: Atomics.store evaluates receiver, index and value in order', () => {
  const src = `export function f(){let n=0;const a=new Int32Array(1);Atomics.store(a,n++,n++);return n*10+a[0]}`
  for (const optimize of TIERS) is(jz(src, { optimize }).exports.f(), 21)
})

test('audit: intrinsic calls retain excess argument effects before the operation', () => {
  const src = `
    export function f(){let n=0;const m=new Map();m.set('x',1);const r=m.delete('x',n++,m.set('x',2));return [n,r,m.has('x')]}
    export function g(){let n=0;const m=new Map();m.set('x',1);try{m.delete('x',bad())}catch(e){n++}return [n,m.has('x')]}
    function bad(){throw 1}
    export function h(){let n=0;const s=new Set();s.add(1);const r=s.has(1,n++,s.delete(1));return [n,r]}
  `
  const expected = oracle(src)
  for (const optimize of TIERS) {
    const got = jz(src, { optimize }).exports
    for (const name of ['f', 'g', 'h']) is(got[name](), expected[name](), `${name} ${optimize}`)
  }
})


test('audit: missing record methods throw after argument evaluation', () => {
  for (const optimize of TIERS) for (const init of [
    'let p={x:1,y:()=>2};p={x:3}',
    'let p={x:3}',
    'let p={y:42}',
    'let p={y:()=>2};p.y=undefined',
  ]) {
    agree(`export function f(){let n=0;${init};try{p.y(n++,n+=2)}catch(e){return [n,e instanceof TypeError]}}`, 'f', [], { optimize })
    agree(`export function f(){let n=0;${init};try{p.y(...[n++,n+=2])}catch(e){return [n,e instanceof TypeError]}}`, 'f', [], { optimize })
    agree(`export function f(){${init};try{p.y((()=>{throw 42})())}catch(e){return e}}`, 'f', [], { optimize })
  }
})

test('audit: caught internal errors use ordinary Error identity', () => {
  const src = `
    function fail(mode) {
      if(mode===0) JSON.parse('x')
      if(mode===1) { const a=[1]; a.with(2,0) }
      if(mode===2) BigInt('z')
      if(mode===3) decodeURIComponent('%')
      if(mode===4) { const a=new Int32Array(1); Atomics.load(a,-1) }
      if(mode===5) throw 300
      if(mode===6) throw null
      if(mode===7) throw NaN
      if(mode===8) throw -0
      if(mode===10) { const o={a:1}; o.b=o; JSON.stringify(o) }
      if(mode===11) { let a=null; const [x]=a }
      if(mode===12) btoa('\u{1F600}')
    }
    export function f(mode) {
      let first, n=0
      try {
        try { fail(mode) } catch(e) { first=e; throw e }
        finally { n++ }
      } catch(e) {
        return [n,Object.is(first,e),typeof e,e instanceof Error,
          e instanceof SyntaxError,e instanceof RangeError,e instanceof URIError,
          // TypeError-class codes, and btoa's name outside the modeled classes,
          // must reach the host with the same identity the host itself gives them.
          e instanceof TypeError]
      }
      return [n]
    }
    export function distinct() {
      let a,b
      try { JSON.parse('x') } catch(e) { a=e }
      try { JSON.parse('x') } catch(e) { b=e }
      a.message='changed'
      return [a!==b,a.message,b.message,a instanceof SyntaxError,b instanceof SyntaxError]
    }`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const mode of [0,0,1,2,3,4,5,6,7,8,9,10,11,12,0]) is(wasm.f(mode), js.f(mode), `opt=${optimize}, mode=${mode}`)
    is(wasm.distinct(), [true,'changed','Unexpected token in JSON',true,true])
  }
})


test('audit: shared-memory catches materialize Error fields', () => {
  if (onKernel()) return
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 128, shared: true })
  const { f } = jz(`export function f(){try{let a=[1];a.with(5,2)}catch(e){return [e.name,e.message,e instanceof RangeError]}}`, { sharedMemory: true, memory }).exports
  is(f(), ['RangeError','Invalid index',true])
  is(f(), ['RangeError','Invalid index',true])
})

test('audit: canonical TypeErrors link where static data cannot grow', () => {
  if (onKernel()) return
  // A shared or imported memory cannot extend static data after the start
  // function's copy length is fixed, so the lazy helper carries whatever the
  // string emitter yields there instead of demanding a static literal.
  const src = 'export function f(o){ return o.length }'
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 64, shared: true })
  for (const opts of [{ sharedMemory: true, memory }, { importMemory: true }, {}])
    for (const optimize of levels(0, 2)) {
      const bytes = compile(src, { ...opts, optimize })
      ok(bytes.byteLength > 0, `links under ${JSON.stringify(Object.keys(opts))} ${optimize}`)
    }
  // The nullish read still reaches the host as a TypeError on an ordinary build.
  for (const optimize of TIERS)
    is(jz('export function f(o){ try { return o.length } catch(e){ return [e.name, e instanceof TypeError] } }', { optimize })
      .exports.f(undefined), ['TypeError', true], `nullish length ${optimize}`)
})

test('audit: an unresolved coercion slot is not an absent method', () => {
  const src = `export function f(){
    let check=()=>0
    check.same=(a,b)=>{if(a!==b)throw 'mismatch'}
    var object={valueOf:()=> '1',toString:()=>0}
    check.same(Number(object),1)
    var object={valueOf:()=>({}),toString:()=> '0'}
    check.same(Number(object),0)
    return Number(object)
  }`
  for (const optimize of TIERS) agree(src, 'f', [], { optimize })
  const variants = [
    'o={valueOf:()=>({})}',
    'o={valueOf:()=>({}),toString:undefined}',
    'o={valueOf:()=>({}),toString:()=>"42"}',
  ]
  for (const replacement of variants) for (const optimize of TIERS) {
    agree(`export function f(){let o={valueOf:()=>1,toString:()=>"2"};${replacement};try{return [Number(o),String(o)]}catch(e){return e instanceof TypeError}}`, 'f', [], { optimize })
  }
})


test('audit: nullish member reads fail before call arguments', () => {
  const src='export function f(p){let n=0;const q=()=>1;if(p===1)return q();try{p.y(n++)}catch(e){return [n,e instanceof TypeError]}}'
  for (const optimize of TIERS) for (const p of [null,undefined,11,1]) agree(src, 'f', [p], { optimize })
})


test('audit: a catch links the error decoder only when its binding is read', () => {
  if (onKernel()) return
  // Coded transport is observable only through the binding, so a handler that
  // never reads it must link no decoder: no class names, no message table.
  const body = 'try { return JSON.parse(x).a } catch'
  const linked = (src) => {
    const bytes = Buffer.from(compile(`export function f(x){ ${src} }`, { optimize: 'size' }))
    return ['SyntaxError', 'Unexpected token in JSON', 'is not a function']
      .some(t => bytes.includes(Buffer.from(t, 'utf16le')))
  }
  for (const handler of ['{ return 0 }', '(e) { return 0 }', '(e) { return x.length }'])
    ok(!linked(`${body} ${handler}`), `no decoder: catch ${handler}`)
  for (const handler of ['(e) { return e.message }', '(e) { return e instanceof SyntaxError }', '(e) { throw e }'])
    ok(linked(`${body} ${handler}`), `decoder linked: catch ${handler}`)
  // The narrowing is size-only: catching, and every Error identity, still hold.
  const src = 'export function f(x){ let n=0; try { JSON.parse(x) } catch(e) { n=1 } try { JSON.parse(x) } catch(e) { return [n, e.name, e instanceof SyntaxError] } }'
  for (const optimize of TIERS) is(jz(src, { optimize }).exports.f('{bad'), [1, 'SyntaxError', true], `identity ${optimize}`)
})

test('audit: dead class-call guards leave no error-message data', () => {
  if (onKernel()) return
  const src='class Box{run(x){return x+1}} export function f(n){const a=[];for(let i=0;i<n;i++)a.push(new Box());let v=0;for(let i=0;i<a.length;i++)v=a[i].run(v);return v}'
  for (const optimize of [2, 'size', 3]) {
    const bytes=compile(src, {optimize})
    for (const text of ['Cannot read properties', 'is not a function', 'TypeError'])
      ok(!Buffer.from(bytes).includes(Buffer.from(text,'utf16le')), 'dead '+text)
    agree(src, 'f', [3], {optimize})
  }
})

test('audit: catch without a binding does not materialize an Error', () => {
  const src='export function f(s){try{JSON.parse(s);return 1}catch{return 7}}'
  for (const optimize of TIERS) {
    const bytes=compile(src, {optimize})
    const {f}=instantiate(bytes).exports
    for (const s of ['', '', '{}', '{', '{}']) is(f(s), s==='{}' ? 1 : 7, 'empty/repeated/error/success recovery')
    if (!onKernel()) ok(!compile(src, {optimize,wat:true}).includes('$__catch_error'), 'no error materializer')
  }
})

test('audit: typed local storage preserves missing values through copies and gathers', () => {
  for (const ctor of ['Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array']) {
    const bodies = [
      'return a[i]',
      'return +a[i]',
      'const v=a[i];return v',
      'let v=0;v=a[i];return v',
      'const v=a[i],w=v;return w',
      'const v=a[i];return b[v]',
      'const v=a[i];return v*v+b[v]',
      'const v=a[i];return v===undefined',
      'const v=a[i];return v===0 ? 7 : v+1',
      'const v=a[i];return v??9',
      'return b[a[i]]',
      'const v=a[i];return b[v|0]',
    ]
    const src = bodies.map((body, k) => `function read${k}(a,b,i){${body}}
      export function f${k}(i,n){return read${k}(new ${ctor}(n===0?[]:[2,1]),new Float64Array([7,8,9]),i)}`).join('\n')
    const js = oracle(src)
    for (const optimize of TIERS) {
      const wasm = jz(src, { optimize }).exports
      for (const [i,n] of [[0,0],[0,0],[0,2],[1,2],[2,2],[-1,2],[0,0],[0,2]])
        for (let k=0;k<bodies.length;k++)
          ok(Object.is(wasm[`f${k}`](i,n), js[`f${k}`](i,n)), `${ctor} ${optimize}: ${bodies[k]}, i=${i}, n=${n}`)
    }
  }
})

// An integer element used as an index is that integer: a Uint16Array read
// indexes a table without a round trip through f64 (the WAV decoder's
// `x[i] = T[s[k]]`), and an unsigned element past 2^31 names no element.
test('audit: an integer element indexes as its integer, an unsigned one past 2^31 included', () => {
  const src = `
    function dec(s, T, x) { for (let i = 0; i < x.length; i++) x[i] = T[s[i]] }
    export function f(n) { const s = new Uint16Array(n), T = new Float32Array(65536), x = new Float32Array(n)
      for (let u = 0; u < 65536; u++) T[u] = u / 2
      for (let i = 0; i < n; i++) s[i] = i * 4099
      dec(s, T, x); let q = 0; for (let i = 0; i < n; i++) q += x[i]; return q }
    export function big(i) { const k = new Uint32Array([1, 4294967295, 2147483648, 2147483647]), T = new Float64Array([5, 6, 7]); return T[k[i]] }`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const n of [0, 1, 64]) is(wasm.f(n), js.f(n), `${optimize}: table decode of ${n}`)
    for (const i of [0, 1, 2, 3, 4, -1]) ok(Object.is(wasm.big(i), js.big(i)), `${optimize}: T[k[${i}]]`)
  }
  if (!onKernel()) {
    const f = compile(src, { optimize: 'speed', wat: true }).match(/\(func \$f[\s\S]*?\n  \(func/)[0]
    ok(!f.includes('f64.convert_i32_u'), 'the element reaches the index as i32, no f64 round trip')
  }
})

test('audit: stored typed reads cannot borrow a loop or another receiver length', () => {
  const src = `function gather(a,b,n){let s=0;for(let i=0;i<n;i++){const v=a[i];s+=b[v]+v*v}return s}
    export function f(n){return gather(new Int32Array([0,1]),new Float64Array([7,8]),n)}
    export function twin(n){let a=new Int32Array([2,1]),i=0,s=0;
      for(i=0;i<a.length;i++){const v=a[i];s+=v}i=n;const v=a[i];return v}
    export function rebound(n){let a=new Int32Array([2,1]);if(n)a=new Int32Array(0);const v=a[0];return v}
    export function view(i){const a=new Uint32Array([7,4294967295,2147483648,8]).subarray(1,3);const v=a[i];return v}
    export function viewNeg(i){const a=new Uint32Array([7,4294967295,2147483648,8]).subarray(1,3);const v=a[i];return -v}
    const arrow=(a,i)=>a[i];export function arrowRead(i){return arrow(new Int32Array([2,1]),i)}`
  const js=oracle(src)
  for (const optimize of TIERS) {
    const wasm=jz(src,{optimize}).exports
    for (const name of ['f','twin','rebound','view','viewNeg','arrowRead']) for(const i of [0,0,1,2,3,-1,0])
      ok(Object.is(wasm[name](i),js[name](i)), `${optimize}: ${name}(${i})`)
  }
})

test('audit: unsigned typed locals retain magnitude and comparison domains', () => {
  const bodies = [
    'const v=a[i&3];return -v',
    'const v=a[i&3];return v+1',
    'const v=a[i&3];const w=v;return w',
    'let v=0;v=a[i&3];return v',
    'let v=a[i&3];if(i>0)v=-1;return v',
    'const v=a[i&3];return v===-1',
    'const v=a[i&3];return v!==-1',
    'const v=a[i&3];return v>0',
    'const v=a[i&3];return v<=2147483648',
    'const v=a[i&3];return v<4294967295',
    'const v=a[i&3];return v>=1',
    'const v=a[i&3];return v===(i|0)',
    'const v=a[i&3];let w=v;w++;return w',
  ]
  const compare='export function compare(x){const u=x>>>0;return u>1}'
  const src=bodies.map((body,k)=>`export function f${k}(i){const a=new Uint32Array([4294967295,2147483648,0,1]);${body}}`).join('\n')+'\n'+compare
  const js=oracle(src)
  for(const optimize of TIERS){
    const wasm=jz(src,{optimize}).exports
    for(let k=0;k<bodies.length;k++)for(const i of [0,0,1,2,3,-1,2147483647,0])
      ok(Object.is(wasm[`f${k}`](i),js[`f${k}`](i)), `${optimize}: ${bodies[k]}, i=${i}`)
    for(const x of [-2147483649,-1,-0,0,1,1.5,2,2147483647,2147483648,4294967295,4294967296,NaN,Infinity,-Infinity])
      is(wasm.compare(x),js.compare(x),`${optimize}: (uint32 ${x}) > 1`)
  }
  if(!onKernel()){
    const wat=compile(compare,{optimize:2,wat:true})
    // Zero-extension also permits a signed i64 comparison without a float
    // round trip; the magnitude and sign boundary are checked above.
    ok(/i32\.(gt_u|ge_u)|i64\.(gt_s|ge_s)\s+\(i64\.extend_i32_u/.test(wat),'unsigned comparison stays in integer registers')
    ok(!/f64\.convert_i32/.test(wat),'unsigned comparison needs no float conversion')
  }
})

test('audit: integer comparison peeling preserves signed and unsigned boundaries', () => {
  const src=`export function f(x,y){const s=x|0,u=y>>>0;
    return [s===u,s!==u,s<u,s>u,s<=u,s>=u,s<2147483648,s>=2147483648,
      u===-1,u>4294967295,u<=4294967295,u===4294967295]}`
  const js=oracle(src)
  for(const optimize of TIERS){
    const wasm=jz(src,{optimize}).exports
    for(const x of [-2147483648,-1,0,1,2147483647])
      for(const y of [0,1,2147483647,2147483648,4294967295])
        is(wasm.f(x,y),js.f(x,y), `${optimize}: signed ${x}, unsigned ${y}`)
  }
})

test('audit: checked integer comparisons preserve misses, signedness and operand order', () => {
  for (const ctor of ['Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float64Array']) {
    const src = `export function f(i,x,n){
      const a=new ${ctor}(n?[0,-1,2147483647,2147483648,4294967295,NaN]:[]),s=x|0,u=x>>>0;
      return [a[i]===s,a[i]!==s,a[i]<s,a[i]<=s,a[i]>s,a[i]>=s,
        a[i]===u,a[i]!==u,a[i]<u,a[i]<=u,a[i]>u,a[i]>=u,
        s===a[i],s!==a[i],s<a[i],s>=a[i],a[i]===undefined]
    }
    export function order(d){const a=new ${ctor}([1,2]);let i=d|0;
      return [a[i++]===i,i,a[d]===(i=9),i,(i=0)===a[(i=1,d)],i]}`
    const js = oracle(src)
    for (const optimize of TIERS) {
      const e = jz(src, { optimize }).exports
      for (const n of [0, 1]) for (const i of [-1, 0, 1, 2, 3, 4, 5, 6])
        for (const x of [-2147483648, -1, 0, 2147483647, 4294967295])
          is(e.f(i,x,n), js.f(i,x,n), `${ctor} ${optimize}: i=${i}, x=${x}, n=${n}`)
      for (const d of [-1, 0, 1, 2]) is(e.order(d), js.order(d), `${ctor} ${optimize}: order ${d}`)
    }
  }
  if (!onKernel()) {
    const src = `function cmp(a,i,x){return a[i]!==x}
      export function f(i,x){return cmp(new Int32Array([1,2]),i|0,x|0)}`
    const body = funcWat(compile(src, { optimize: { level: 'speed', sourceInline: false, watr: false }, wat: true }), 'cmp')
    ok(body.includes('i32.load'), 'comparison reads the integer element')
    ok(!/f64\.convert_i32/.test(body), 'checked integer comparison stays in integer registers')
  }
})

test('audit: checked integer comparisons coerce objects instead of comparing pointer words', () => {
  const src = `export function f(i){
    const a=new Int32Array([1]),b={valueOf(){return 1}};
    return [a[i]==b,a[i]!=b,a[i]===b,b==a[i],b!=a[i],b===a[i]]
  }
  export function effects(i){
    let trace=0;
    const a=new Int32Array([1]),b={valueOf(){trace=trace*10+2;return 1}};
    const eq=a[(trace=trace*10+1,i)]==b;
    const lt=b<a[(trace=trace*10+3,i)];
    return [eq,lt,trace]
  }`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const e = jz(src, { optimize }).exports
    for (const i of [-1, 0, 1, 0]) {
      is(e.f(i), js.f(i), `${optimize}: object comparison at ${i}`)
      is(e.effects(i), js.effects(i), `${optimize}: conversion order at ${i}`)
    }
  }
})

test('audit: cached global typed lengths survive empty, nullish and replacement lifecycles', () => {
  const src = `let a;
    export function reset(n,view){const b=new Int32Array(n+2);a=view?b.subarray(1,n+1):new Int32Array(n);for(let i=0;i<n;i++)a[i]=i+7}
    export function clear(v){a=v?null:undefined}
    export function read(n,k){let s=0;for(let i=0;i<n;i++)s+=a[k]|0;return s}
    export function write(n,k){for(let i=0;i<n;i++)a[k]=(a[k]|0)+1;return 1}
    function change(n){reset(n,0)}
    export function changing(){let s=0;for(let i=0;i<4;i++){change(i);s+=a[1]|0}return s}`
  for (const optimize of TIERS) {
    const e = jz(src, { optimize }).exports, js = oracle(src)
    is(e.read(0,0), 0, `${optimize}: uninitialized zero-work read`)
    is(e.write(0,0), 1, `${optimize}: uninitialized zero-work write`)
    throws(() => e.read(1,0), TypeError, `${optimize}: uninitialized read throws TypeError`)
    for (const nil of [0, 1]) {
      e.clear(nil); js.clear(nil)
      is(e.read(0,0), 0, `${optimize}: nullish zero-work read`)
      is(e.write(0,0), 1, `${optimize}: nullish zero-work write`)
      throws(() => e.read(1,0), TypeError, `${optimize}: nullish read throws TypeError`)
      throws(() => e.write(1,0), TypeError, `${optimize}: nullish write throws TypeError`)
    }
    for (const view of [0, 1]) for (const n of [0, 3, 3, 1, 0, 4]) {
      e.reset(n,view); js.reset(n,view)
      for (const k of [-1, 0, n-1, n]) {
        is(e.read(3,k), js.read(3,k), `${optimize}: ${view ? 'view' : 'owned'} length ${n}, read ${k}`)
        is(e.write(2,k), js.write(2,k))
        is(e.read(3,k), js.read(3,k), 'element writes remain visible through the cached base')
      }
    }
    is(e.changing(), js.changing(), 'callee replacement invalidates both base and length')
  }
  if (!onKernel()) {
    const src = `let a=new Int32Array(0);export function reset(n){a=new Int32Array(n)}
      function write(n,k){for(let i=0;i<n;i++)a[k]=(a[k]|0)+1}
      export function f(n,k){write(n|0,k|0);return 1}`
    const body = funcWat(compile(src, { optimize: { level: 'speed', sourceInline: false, watr: false }, wat: true }), 'write')
    ok(body.includes('(loop'), 'the fixture retains its write loop')
    const loop = body.slice(body.indexOf('(loop'))
    is((loop.match(/\(i32\.load/g) || []).length, 2, 'both loop versions load only elements, not the allocation header')
  }
})

test('audit: dependent integer reads keep the checked index in integer registers', () => {
  const src = `let trace=0;
    function make(){trace=trace*10+1;return new Int32Array([4,2])}
    export function order(i){trace=0;const yes=make()[(trace=trace*10+2,i)]<3;return [yes,trace]}
    export function f(i,n){const a=new Int32Array([7,11,13]),b=new Int32Array(n?[2,-1,3]:[]);
      return [a[b[i]]|0,a[b[i]]===undefined]}
    export function word(i){const a=new Int32Array([7,11,13]),b=new Int32Array([2,-1,3]);return a[b[i]]|0}`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const e = jz(src, { optimize }).exports
    for (const i of [-1, 0, 1, 2, 3, 0]) {
      is(e.order(i), js.order(i), `${optimize}: receiver and index effects on hit or miss`)
      for (const n of [0, 1]) is(e.f(i,n), js.f(i,n), `${optimize}: nested index ${i}, length ${n ? 3 : 0}`)
      is(e.word(i), js.word(i))
    }
  }
  if (!onKernel()) {
    const source = `function word(a,b,i){return a[b[i]]===13}
      export function f(i){return word(new Int32Array([7,11,13]),new Int32Array([2,-1,3]),i|0)}`
    const body = funcWat(compile(source, { optimize: { level: 'speed', sourceInline: false, watr: false }, wat: true }), 'word')
    ok(body.includes('i32.load'), 'the fixture retains its dependent loads')
    ok(!/f64\.convert_i32|trunc_sat_f64/.test(body), 'dependent integer load has no float round trip')
  }
})

test('audit: word-only helper parameters normalize at the call boundary', () => {
  const src=`function word(v){return v&7}
    function identity(v){return v}
    function capture(v){const read=()=>v;return read()}
    function compare(v){return v===undefined}
    export function f(i){const a=new Int32Array([11,2]),v=a[i];return [word(3),word(v),word(i/2),identity(v),capture(v),compare(v)]}`
  const js=oracle(src)
  for(const optimize of TIERS){
    const wasm=jz(src,{optimize:{level:optimize,sourceInline:false}}).exports
    for(const i of [0,0,1,2,-1,0])is(wasm.f(i),js.f(i), `${optimize}: index ${i}`)
  }
  if(!onKernel()){
    const body=funcWat(compile(src,{optimize:{level:'speed',sourceInline:false,watr:false},wat:true}),'word')
    ok(body.includes('i32.and'),'the word helper remains a real function')
    ok(!/f64|trunc_sat/.test(body),'mixed integer, fraction and missing inputs normalize before the word-only helper')
  }
})

test('audit: checked integer locals normalize only at word consumers', () => {
  for (const ctor of ['Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array']) {
    const src=`function word(a,i,j){const v=a[i],out=new Uint8Array(3);
      out[j++]=v;if(v&8){out[j++]=v}for(let k=0;k<2;k++)out[k]=v;
      return [v&255,v>>>0,out[0],out[1],out[2],j]}
    export function f(i,j,n){const a=new ${ctor}(n?[255,-1,2147483648,4294967295]:[]);
      return word(a.subarray(0),i,j)}
    export function observed(i){const a=new ${ctor}([255,-1]),v=a[i],out=new Int32Array(1);
      return [out[0]=v,v===undefined,v&255]}
    export function float(i){const a=new ${ctor}([255,-1]),v=a[i],out=new Float64Array(1);
      out[0]=v;return [out[0],v&255]}
    export function clamped(i){const a=new ${ctor}([255,-1]),v=a[i],out=new Uint8ClampedArray(1);
      out[0]=v;return [out[0],v&255]}
    export function named(i){const a=new ${ctor}([255,-1]),v=a[i],out=new Int32Array(1);
      out.extra=v;return [out.extra,v&255]}
    export function capture(i){const a=new ${ctor}([255,-1]),v=a[i],read=()=>v;
      return [read(),v&255]}
    export function reassigned(i){const a=new ${ctor}([255,-1]);let v=a[i];v+=1;return v&255}`
    const js=oracle(src)
    for(const optimize of TIERS){
      const wasm=jz(src,{optimize}).exports
      for(const n of [0,1,0,1])for(const i of [-1,0,0,1,2,3,4])for(const j of [-1,0,3])
        is(wasm.f(i,j,n),js.f(i,j,n),`${ctor} ${optimize}: word ${i}, ${j}, ${n}`)
      for(const name of ['observed','float','clamped','named','capture','reassigned'])for(const i of [0,0,1,2,-1,0])
        is(wasm[name](i),js[name](i),`${ctor} ${optimize}: ${name}(${i})`)
    }
  }
  if(!onKernel()){
    // Bound the destination index so this codegen check isolates the loaded
    // value's word consumers; an unbounded j+1 needs separate index arithmetic.
    const src=`function word(a,out,i,j){const v=a[i];out[j]=v;out[j+1]=v;return v&7}
      export function f(i,j){return word(new Uint32Array([4294967295]),new Int8Array(2),i|0,j&1)}`
    const body=funcWat(compile(src,{optimize:{level:'speed',sourceInline:false,watr:false},wat:true}),'word')
    ok(body.includes('i32.load')&&body.includes('i32.store8'),'checked load and stores survive')
    ok(!/f64|__to_int32|trunc_sat/.test(body),'word-only local needs no float round trip or conversion helper')
  }
})

// A missing element read as zero is exact where every use answers undefined
// and zero alike: `rep > 0`, and the decrement only that test's true arm runs.
// Each decline would change a result on a miss: `>= 0` holds for zero, an
// unguarded or do-body step turns undefined to NaN, `!== 0` fails for zero.
test('audit: checked integer locals keep words where a miss meets only tests zero answers alike', () => {
  const src=`function run(s,off,n){let r=off,p=0,h=0;const out=new Uint8Array(64)
      while(p<n){const f=s[r++];out[p++&63]=f;if(f&8){let rep=s[r++];while(rep>0){out[p++&63]=f;rep--}}}
      for(let i=0;i<64;i++)h=h*31+out[i]|0
      return [h,p,r]}
    export function f(off,n){const s=new Uint8Array(12);for(let i=0;i<12;i++)s[i]=(i*3+7)&15;return run(s,off|0,n|0)}
    export function notBlind(i){const a=new Uint8Array([3]),v=a[i];return v>=0?1:2}
    export function unguarded(i){const a=new Uint8Array([3]);let v=a[i];v--;return v&255}
    export function doBody(i){const a=new Uint8Array([3]);let v=a[i],t=0;do{t++;v--}while(v>0);return [t,v&255]}
    export function strict(i){const a=new Uint8Array([3]);let v=a[i],t=0;if(v===3)t=1;if(v!==0)t+=2;while(v>1){v-=2;t+=4}return [t,v&255]}`
  const js=oracle(src)
  for(const optimize of TIERS){
    const wasm=jz(src,{optimize}).exports
    for(const off of [-2,0,5,11,12,20])for(const n of [0,3,10,40])
      is(wasm.f(off,n),js.f(off,n),`${optimize}: flags ${off}, ${n}`)
    for(const name of ['notBlind','unguarded','doBody','strict'])for(const i of [-1,0,1])
      is(wasm[name](i),js[name](i),`${optimize}: ${name}(${i})`)
  }
  if(!onKernel()){
    const wat=compile(src,{optimize:'speed',wat:true}),body=funcWat(wat,'run')||funcWat(wat,'f')
    ok(/\(local \$[^\s)]*rep i32\)/.test(body),'the repeat count stays a word')
  }
})

test('audit: word-store demand preserves key effects, throws and assignment values', () => {
  const src=`export function f(i){const a=new Int32Array([7]),v=a[i],out=new Int32Array(2);let calls=0;
    const key={toString(){calls++;out[1]=99;return 'extra'}};
    out[key]=v;return [calls,out.extra,out[1],v&255]}
    export function observed(i){const a=new Int32Array([7]),v=a[i],out=new Int32Array(1);
      const write=()=>out[0]=v;return [write(),v&7]}
    export function throwing(i){const a=new Int32Array([7]),v=a[i];let out=new Int32Array(1);out=null;
      try{out[0]=v}catch(e){return e.name}return v&7}`
  const js=oracle(src)
  for(const optimize of TIERS){
    const wasm=jz(src,{optimize}).exports
    for(const name of ['f','observed','throwing'])for(const i of [0,0,1,-1,0])
      is(wasm[name](i),js[name](i),`${optimize}: ${name}(${i})`)
  }
})

test('audit: bounded numeric conversions retain missing and nonfinite values', () => {
  for (const ctor of ['Int32Array','Uint32Array','Float64Array']) {
    const src=`export function f(i,n){
      const a=new ${ctor}(n ? [7,-2147483648,2147483647,4294967295,NaN,Infinity,-Infinity,1e30] : []);
      const v=a[i], b=new Int32Array(3);
      b[0]=v;b[1]=v+1;b[2]=v*2;
      return [v,b[0],b[1],b[2]]
    }`
    const js=oracle(src)
    for(const optimize of TIERS){
      const wasm=jz(src,{optimize}).exports
      for(const n of [0,1,0,1])for(const i of [-1,0,0,1,2,3,4,5,6,7,8])
        is(wasm.f(i,n),js.f(i,n),`${ctor} ${optimize}: i=${i}, n=${n}`)
    }
  }
  if(!onKernel()){
    const src=`export function f(i){const a=new Int32Array([7,-2147483648,2147483647]);
      const v=a[i],b=new Int32Array(1);b[0]=v;return [v,b[0]]}`
    const wat=compile(src,{optimize:2,wat:true})
    ok(!wat.includes('$__to_int32'),'bounded payload or missing read needs no arbitrary-number conversion helper')
  }
})

// An integer element store converts its value by ToInt32. Over checked reads
// of integer elements (a length the compiler does not know: the adaptive
// filter taps of a TTA decoder, `qm[i] -= dx[i]`) the value is a bounded
// integer or the NaN of a miss, and the inline wrap is exact; the helper that
// recovers the low word past 2^63 stays for values of no known range.
test('audit: an integer element store over checked integer reads converts inline', () => {
  const src=`let a=new Int32Array(4),b=new Int32Array(4),u=new Uint32Array(4),f=new Float64Array(4)
    a[0]=2147483647;b[0]=-2147483648;a[1]=-2147483648;b[1]=2147483647;a[2]=5;b[2]=9
    u[0]=4294967295;u[1]=4294967294;f[0]=1e19;f[1]=-3.9e19;f[2]=2.5e300
    export let g=(k)=>{
      let q=new Int32Array(8),r=new Uint8Array(8),s=new Int16Array(8)
      for(let i=0;i<4;i++)q[i]=a[i]-b[i]
      q[4]=a[k+5]-b[0];q[5]=u[0]+u[1];q[6]=f[0]+f[1];q[7]=f[2]*2
      for(let i=0;i<4;i++){r[i]=a[i]+b[i]*3;s[i]=u[i]-a[i]}
      r[4]=f[k]-1;s[4]=f[1]-f[0]
      return [...q,...r,...s].join()
    }`
  const js=oracle(src)
  for(const optimize of TIERS){
    const wasm=jz(src,{optimize}).exports
    for(const k of [0,1])is(wasm.g(k),js.g(k),`${optimize}: k=${k}`)
  }
  const taps=`let mk=()=>({qm:new Int32Array(8),dx:new Int32Array(8)})
    let st=[mk(),mk()]
    let step=(ch,v)=>{let {qm,dx}=ch;for(let i=0;i<8;i++){dx[i]=(v+i)|0;qm[i]-=dx[i]}return qm[3]}
    export let t=(v)=>[step(st[v&1],v),step(st[v&1],v)].join()`
  ok(!compile(taps,{optimize:2,wat:true}).includes('$__to_int32'),'a difference of integer elements converts inline')
  for(const v of [3,2147483647,-2147483648])is(jz(taps).exports.t(v),oracle(taps).t(v),`and wraps as JavaScript does: ${v}`)
})

test('audit: range folding includes a local\'s implicit zero value', () => {
  const src='export function f(p){let x=0;if(p)x=0.5;return (4294967297*(1-2*x))|0}'
  const js=oracle(src)
  for(const optimize of TIERS){
    const wasm=jz(src,{optimize}).exports
    for(const p of [0,0,1,0,1])is(wasm.f(p),js.f(p),`${optimize}: conditional assignment ${p}`)
  }
})

test('audit: a break to a labeled block leaves with what was assigned by then', () => {
  // The binding read past the block is assigned on the path that falls through it, not on
  // the one the `break` takes: the read finds undefined there, and its sum is no number.
  const src = `export let past = (c) => { let r; lab: { if (c) break lab; r = 1 } return r + 1 }
    export let each = (c) => { let r; lab: { if (c) { r = 5; break lab } r = 1 } return r + 1 }
    export let loop = (c) => { let r; out: { for (let i = 0; i < 3; i++) { if (i === c) break out; r = i } r = 9 } return r + 1 }
    export let bare = (c) => { let r; lab: { if (c) break lab; r = 1 } return r }`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const name of ['past', 'each', 'loop', 'bare']) for (const c of [0, 1, 2, 7])
      is(wasm[name](c), js[name](c), `${optimize}: ${name}(${c})`)
  }
})

test('audit: a truth value prints as its name', () => {
  // Boolean.prototype.toString (ES2024 20.3.3.2)
  const src = `export let of = (x) => (x > 0).toString()
    export let held = (x) => { const b = x > 0; return b.toString().length * 10 + String(b).length }
    export let lit = () => true.toString() + false.toString()
    export let maybe = (x) => { const o = x > 0 ? true : undefined; try { return o.toString() } catch (e) { return 'thrown' } }`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const name of ['of', 'held', 'lit', 'maybe']) for (const x of [1, -1])
      is(wasm[name](x), js[name](x), `${optimize}: ${name}(${x})`)
  }
})

test('audit: a test of Object.prototype answers a truth value beside a literal one', () => {
  // `o.hasOwnProperty( k )` on an object of a known shape was a value of no known kind to
  // the summary and a 0 or 1 to the emitter: joined with `false` it surfaced as a number.
  const src = `const own = (o, k) => (o === void 0 || o === null) ? false : o.hasOwnProperty(k)
    export let arm = () => { const o = { a: 1 }; return [own(o, 'a'), own(o, 'c'), own(null, 'a')] }
    function own2(value, property) { if (value === void 0 || value === null) { return false } return value.hasOwnProperty(property) }
    export let ret = () => { const o = { a: 1 }; return [own2(o, 'a'), own2(o, 'c'), own2(null, 'a')] }
    export let held = (x) => { const o = { a: x }; const t = o.hasOwnProperty('a'); const u = x > 0 ? t : o.hasOwnProperty('b'); return [t, u, typeof t, t === true ? 1 : 0, o.toString(), typeof o.valueOf()] }`
  const js = oracle(src)
  for (const optimize of TIERS) {
    const wasm = jz(src, { optimize }).exports
    for (const name of ['arm', 'ret']) is(wasm[name](), js[name](), `${optimize}: ${name}`)
    for (const x of [1, -1]) is(wasm.held(x), js.held(x), `${optimize}: held(${x})`)
  }
})

test('audit: the class of a value that is no number or a truth value', () => {
  // Object.prototype.toString.call( v ) over a value of no known kind: NaN is a Number, true a Boolean
  const src = `export let f = () => [1, 's', [1, 2], { a: 1 }, null, undefined, true, false, 2.5, NaN, 0].map((v) => Object.prototype.toString.call(v)).join(' ')`
  const want = oracle(src).f()
  for (const optimize of TIERS) is(jz(src, { optimize }).exports.f(), want, `${optimize}`)
})
