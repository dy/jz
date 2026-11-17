// Typed and string reads proved in bounds: read-modify-writes, fetch groups,
// cursors, value hulls and length proofs that fail closed.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels } from './_matrix.js'
import { run, oracle, jz, compile } from './util.js'
import { parse, loopCount } from '../scripts/wat-probe.mjs'
import { findFunc, preWatr } from './_optimizer.js'

test('typed RMW: one guard covers the pure read and ignored OOB store', () => {
  const src = `
const step = (a, i, x) => {
  a[i] = (a[i] + x) | 0
  a[i] = Math.imul(a[i], 3)
  a[i] = a[i] ^ (a[i] >>> 5)
}
export let main = (i) => {
  const a = new Int32Array(4)
  a[0] = 7; a[1] = 11; a[2] = 13; a[3] = 17
  step(a, i, 9)
  return a[0] ^ a[1] ^ a[2] ^ a[3]
}`
  const wat = compile(src, { wat: true, optimize: 'speed' })
  const m = wat.split('(func ').find(c => /^\$main\b/.test(c)) || wat
  // (a host's key of unknown integrality meets the length as its truncation, in i64)
  is((m.match(/i(32|64)\.lt_u/g) || []).length, 3, 'one guard per RMW — no read+write pairs')
  const exportsJs = oracle(src)
  const wasm = run(src, { optimize: 'speed' }).main
  for (const i of [-1, 0, 2, 3, 4, 99]) is(wasm(i), exportsJs.main(i), `RMW i=${i} exact including OOB`)
})

test('typed RMW: rejected conversion candidates retain checked reads and RHS effects', () => {
  const src = `function step(a, i, x) { a[i] = Math.imul(a[i], x) }
    export function f(mode, index) {
      const a = new Int32Array([7, 11]); let trace = '';
      const x = mode === 0 ? 3 : mode === 1 ? '3' : mode === 2 ? {valueOf(){trace += 'v';a[0] = 41;return 4}}
        : mode === 3 ? undefined : mode === 4 ? 1n : {valueOf(){trace += 'e';throw new Error('operand')}};
      try { step(a, +index, x); return [a[0], a[1], trace] }
      catch(e) { return [e.name, a[0], a[1], trace] }
    }
    export function ignored(index) {
      const a = new Int32Array([7, 11]); let calls = 0; const i = +index;
      function extra(){calls++;a[0] = 41;return 0}
      a[i] = Math.imul(a[i], 3, extra());
      return [a[0], a[1], calls]
    }
    export function callback(index) {
      const a = new Int32Array([7, 11]); let calls = 0; const i = +index;
      function read(){calls++;a[0] = 19;return 5}
      a[i] = (a[i] + read()) | 0;
      return [a[0], a[1], calls]
    }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, { optimize, sourceInline:false }).exports, want = oracle(src)
    const held = []
    for (const mode of [0, 0, 1, 2, 3, 4, 5, 0]) for (const index of [-1, 0, 1, 2, 0]) {
      const actual = got.f(mode, index), expected = want.f(mode, index)
      is(actual, expected, `O${optimize}: mode ${mode}, index ${index}`)
      held.push([actual, expected])
    }
    for (const [actual, expected] of held) is(actual, expected, 'later calls preserve prior results')
    for (const index of [-1, 0, 1, 2, 0]) {
      is(got.ignored(index), want.ignored(index), 'ignored arguments run after the read even for an ignored store')
      is(got.callback(index), want.callback(index), 'a rejected zero-argument call preserves the original read and effects')
    }
  }
})

test('typed fetch bundle: static table length proves an interpreter fetch group', () => {
  const src = `
const exec = (code, reg) => {
  let pc = 0
  while (pc < 3) {
    const o = pc * 3
    const op = code[o], a = code[o + 1], b = code[o + 2]
    if (op === 0) { reg[a] = b; pc++ }
    else if (op === 1) pc = b
    else pc = 3
  }
  return reg[0]
}
export let main = () => {
  const code = new Int32Array(9), reg = new Int32Array(2)
  code[0] = 0; code[1] = 0; code[2] = 37
  code[3] = 1; code[4] = 0; code[5] = 2
  code[6] = 2; code[7] = 0; code[8] = 0
  return exec(code, reg)
}`
  // the tables' heap path: static placement gives them constant bases (test/static-locals.js)
  const wat = compile(src, { wat: true, optimize: preWatr({ level: 'speed', staticLocals: false }) })
  const execWat = wat.split('(func ').find(c => /^\$exec\b/.test(c)) || ''
  ok(execWat.length > 0, 'inspect the fetch worker before backend inlining')
  ok(!/\$[^ )]*tbg/.test(execWat), 'known length and pc hull retire the fetch guard entirely')
  // (the fetch group's base, or the pointer to the instruction the index carries beside it: optimize/jump-pointers.js)
  ok(/i32\.load offset=4 \(local\.get \$__(ab|jp)\d+\)/.test(execWat) &&
    /i32\.load offset=8 \(local\.get \$__(ab|jp)\d+\)/.test(execWat),
  'adjacent fetches share one raw base address')
  is(run(src, { optimize: 'speed' }).main(), 37, 'interpreter result exact')
  const tooShort = src.replace('new Int32Array(9)', 'new Int32Array(8)')
  ok(!/\$[^ )]*tbg/.test(compile(tooShort, { wat: true, optimize: { level: 'speed', staticLocals: false } })), 'undersized code table stays independently checked')
})

test('typedLen: static length flows through param hops and inline aliases', () => {
  // main ctor → runKernel param → helper param (inlined as a bare-name alias):
  // the alias inherits the source's static length, `.length` folds, and the
  // helper's cond-bounded reads prove against the static len.
  const src = `
const acc = (a) => {
  const n = a.length
  let s = 0
  let k = 1
  while (k < n) { s += a[k]; k = 2 * k }
  return s
}
const runKernel = (a, src) => {
  for (let i = 0; i < a.length; i++) a[i] = src[i] * 2
  return acc(a)
}
export let main = () => {
  const src = new Float64Array(32)
  const a = new Float64Array(32)
  for (let i = 0; i < 32; i++) src[i] = i
  return runKernel(a, src)
}`
  const wat = compile(src, { wat: true, optimize: 'speed' })
  const m = wat.split('(func ').find(c => /^\$main\b/.test(c)) || ''
  is((m.match(/nan:0x7FF80002/g) || []).length, 0, 'geometric-cursor reads proven via the alias-carried static len')
  const exportsJs = oracle(src)
  is(run(src, { optimize: 'speed' }).main(), exportsJs.main(), 'value exact')
})

test('all-false SIMD masks guard large pure producer suffixes', () => {
  if (onKernel()) return
  const heavy = Array.from({ length: 72 }, () => 'x=f32x4.add(x,c)').join(';')
  const src = `export let f=(n,hit)=>{let sum=0;let i=0;while(i<n){
    let res=f32x4.splat(-1),k=0;while(k<1){res=f32x4.splat(hit);k++}
    let c=f32x4.splat(0.125),x=f32x4.splat(i);${heavy};
    let v=v128.bitselect(x,f32x4.splat(0),f32x4.ge(res,f32x4.splat(0)))
    sum+=f32x4.lane(v,0);i++}return sum}`
  const onTree = parse(src, { level: 'speed' })
  const fn = findFunc(onTree, '$f') || findFunc(onTree, '$f$exp')
  ok(loopCount(fn, n => n[0] === 'v128.any_true') >= 1,
    'one all-lanes guard dominates the expensive suffix')
  const on = jz(src, { optimize: 'speed' }).exports.f
  const off = jz(src, { optimize: { level: 'speed', maskedSuffixGuard: false } }).exports.f
  for (const args of [[0, -1], [3, -1], [1, 1], [4, 1]])
    is(on(...args), off(...args), `masked suffix on===off ${args}`)

  const dependentFallback = `export let f=(n,hit)=>{let sum=0,i=0;while(i<n){
    let res=f32x4.splat(-1),k=0;while(k<1){res=f32x4.splat(hit);k++}
    let c=f32x4.splat(.125),x=f32x4.splat(i);${heavy};let fb=f32x4.add(x,c)
    let v=v128.bitselect(x,fb,f32x4.ge(res,f32x4.splat(0)))
    sum+=f32x4.lane(v,0);i++}return sum}`
  const depTree = parse(dependentFallback, { level: 'speed', watr: false })
  is(loopCount(findFunc(depTree, '$f'), n => n[0] === 'v128.any_true'), 0,
    'a fallback produced inside the skipped suffix prevents guarding')
})

test('typed postfix index keeps the old index without add/sub cancellation', () => {
  const src = `export let f=()=>{const a=new Uint8Array(1);let i=0;a[i++]=7;a[i++]=9;return a[0]*10+i}`
  is(run(src, { optimize: 'speed' }).f(), 72, 'first store lands, OOB second store is ignored, cursor advances twice')
  const wat = compile(src, { wat: true, optimize: { level: 'speed', watr: false } })
  const fw = wat.split('(func $f')[1]?.split('(func ')[0] || ''
  ok(!/i32\.add[\s\S]{0,100}i32\.sub/.test(fw), 'postfix address does not increment then subtract one')
})

test('monotone cursor budget proves mutually-exclusive codec reads', () => {
  const src = `const dec=(inp,out)=>{let ip=0;for(let p=0;p<4;p++){const tag=inp[ip++];let v=tag;if((tag&1)===0){v+=inp[ip++];v+=inp[ip++];v+=inp[ip++]}else if((tag&2)===0){v+=inp[ip++]}out[p]=v}return ip}
    export let f=()=>{const inp=new Uint8Array(20),out=new Uint8Array(4);for(let i=0;i<20;i++)inp[i]=i;return dec(inp,out)+out[0]+out[3]}`
  const decWat = (s) => {
    const wat = compile(s, { wat: true, optimize: { level: 'speed', watr: false } })
    return wat.split('(func $dec')[1]?.split('(func ')[0] || ''
  }
  is((decWat(src).match(/i32\.lt_u/g) || []).length, 0,
    'max branch advance × trip count fits the static input length')
  const short = src.replace('new Uint8Array(20)', 'new Uint8Array(15)')
  ok(/i32\.lt_u/.test(decWat(short)), 'insufficient capacity keeps each checked read')
  const exportsJs = oracle(src)
  is(run(src, { optimize: 'speed' }).f(), exportsJs.f(), 'budgeted post-increment reads stay exact')

  const rle = `const enc=(inp,out)=>{let op=0,run=0;for(let p=0;p<8;p++){const x=inp[p];if(x===0)run++;else{if(run>0){out[op++]=run;run=0}out[op++]=x;out[op++]=1}}return op}
    export let f=()=>{const inp=new Uint8Array(8),out=new Uint8Array(16);inp[0]=0;inp[1]=3;inp[2]=4;return enc(inp,out)+out[0]+out[1]+out[2]}`
  const encWat = (s) => {
    const wat = compile(s, { wat: true, optimize: { level: 'speed', watr: false } })
    return wat.split('(func $enc')[1]?.split('(func ')[0] || ''
  }
  is((encWat(rle).match(/i32\.lt_u/g) || []).length, 0,
    'credit reset pays for the rare extra RLE output byte')
  ok(/i32\.lt_u/.test(encWat(rle.replace('new Uint8Array(16)', 'new Uint8Array(15)'))),
    'amortized output bound still fails closed one byte short')
  is(run(rle, { optimize: 'speed' }).f(), 10, 'amortized RLE stores stay exact')
})

test('decomposed charCodeAt unswitches SSO vs heap outside leaf byte loops', () => {
  const src = `const scan=(s,n)=>{let h=0;for(let i=0;i<n;i++)h=(h+s.charCodeAt(i))|0;return h}
    export let small=()=>scan('abc',3)
    export let heap=()=>{let s='';for(let i=0;i<16;i++)s=s+'ab';return scan(s,s.length)}`
  const w = compile(src, { wat: true, optimize: { level: 'speed', watr: false } })
  const sw = w.split('(func $scan')[1]?.split('\n  (func ')[0] || ''
  ok(/\$s\$ccsso/.test(sw), 'string parameter is decomposed once at entry')
  is((sw.match(/\(local\.get \$s\$ccsso\)/g) || []).length, 2,
    'representation is tested once per split loop, not once per byte')
  // (the scan's main loop in two versions; its past-the-end tail reads no
  // character, so it takes no representation version)
  ok((sw.match(/\(loop/g) || []).length >= 3, 'SSO and heap loop versions are materialized')
  ok(/i64\.shr_u\s+\(local\.get \$s\$ccp64\)/.test(sw), 'the SSO version reads its units from the payload')
  is((sw.match(/i32\.load16_u/g) || []).length, 1, 'the heap version reads its units from memory, once')
  const ex = run(src, { optimize: 'speed' })
  is(ex.small(), 294, 'SSO loop version stays exact')
  is(ex.heap(), 3120, 'heap loop version stays exact')
})

test('decomposed charCodeAt loads no length where every read is in bounds', () => {
  const src = `const make=()=>{let s='';for(let i=0;i<64;i++)s=s+'let a1 = b + 12;';return s}
    const scan=(src,len)=>{let h=0;for(let i=0;i<len;i++){const c=src.charCodeAt(i);if(c>32)h=(h*31+c)|0}return h}
    export let f=()=>{const src=make(),n=src.length;let h=scan(src,n);for(let i=0;i<8;i++)h=(h+scan(src,n-(i&7)))|0;return h}`
  const sw = compile(src, { wat: true, optimize: 'size' }).split('(func $scan')[1]?.split('\n  (func ')[0] || ''
  ok(/\$src\$ccsso/.test(sw), 'the receiver is decomposed at entry')
  ok(!/\(i32\.load\s/.test(sw), 'no read tests the length: none is loaded')
  const checked = src.replace('src.charCodeAt(i)', 'src.charCodeAt(i+1)')
  const cw = compile(checked, { wat: true, optimize: 'size' }).split('(func $scan')[1]?.split('\n  (func ')[0] || ''
  ok(/\(i32\.load\s/.test(cw), 'a read past the proven range keeps the heap length')
  for (const s of [src, checked]) is(run(s, { optimize: 'size' }).f(), oracle(s).f(), 'reads stay exact')
})

test('checked typed reads preserve their index before a reused guard slot', () => {
  const src = `const a=new Float64Array([4,1,-0,NaN]), out=new Float64Array(1)
    export function f(i){if(a[i]>=3)return -1;return out[0]=a[i]}`
  for (const optimize of levels(0, 2, 'speed', 'size')) {
    const js = oracle(src), wasm = run(src, { optimize })
    for (const i of [-1, 0, 1, 2, 3, 4, 2, 2, 1])
      ok(Object.is(wasm.f(i), js.f(i)), `${optimize}: index ${i}, including missing, signed zero and NaN`)
  }
})

test('a checked typed read used as an index carries its miss outward', () => {
  const src = `export let f=(d)=>{const count=new Int32Array(1),out=new Uint8Array(2);count[0]=1;out[count[d]]=9;return out[0]*10+out[1]}
    export let g=(d)=>{const count=new Uint8Array(1),out=new Uint8Array(256);count[0]=1;out[0]=7;out[1]=9;return out[count[d]]===undefined?-1:out[count[d]]}`
  const { f, g } = run(src, { optimize: 'speed' })
  is(f(0), 9, 'in-range inner read addresses the outer array')
  is(f(-1), 0, 'inner undefined does not become outer index zero')
  is(f(2), 0, 'far inner miss keeps the outer write ignored')
  is(g(0), 9, 'proven-range outer read keeps the in-range value')
  is(g(-1), -1, 'proven-range outer read still preserves inner undefined')
})

test('typed value hulls fail closed on wraparound, aliases, and closure writes', () => {
  const cases = {
    wrap: `const get=(t,i)=>t[i]|0
      export let f=()=>{const idx=new Uint8Array(1),t=new Int32Array(32);idx[0]=-100;t[0]=7;return get(t,idx[0])}`,
    alias: `const get=(t,i)=>t[i]|0
      export let f=()=>{const idx=new Int32Array(1),t=new Int32Array(32);const b=idx;b[0]=999;t[0]=7;return get(t,idx[0])}`,
    closure: `const get=(t,i)=>t[i]|0
      export let f=()=>{const idx=new Int32Array(1),t=new Int32Array(32);const set=()=>{idx[0]=999};set();t[0]=7;return get(t,idx[0])}`,
  }
  for (const [name, src] of Object.entries(cases)) {
    const wat = compile(src, { wat: true, optimize: { level: 'speed', watr: false } })
    // the read stands in `get`, or in `f` once the element argument substitutes into `get`'s pure body
    const getWat = wat.split('(func $get')[1]?.split('(func ')[0] || wat.split('(func $f')[1]?.split('(func ')[0] || ''
    ok(/i32\.lt_u/.test(getWat), `${name}: unproven element hull keeps the bounds check`)
    is(run(src, { optimize: 'speed' }).f(), 0, `${name}: OOB reads retain JS ToInt32 semantics`)
  }
})

test('plain-array length proofs reject conditional growth, aliases, and extending writes', () => {
  const conditional = `const build=(x)=>{const a=[];if(x)a.push(7);return a}
    const get=(a)=>a[0]|0;export let f=(x)=>get(build(x))`
  const wat = compile(conditional, { wat: true, optimize: { level: 'speed', watr: false, sourceInline: false } })
  const getWat = wat.split('(func $get')[1]?.split('(func ')[0] || ''
  ok(/i32\.lt_u/.test(getWat), 'conditional push cannot become a fixed returned length')
  const c = run(conditional, { optimize: 'speed' }).f
  is(c(0), 0, 'empty conditional result stays OOB')
  is(c(1), 7, 'taken conditional push remains visible')

  const alias = `const get=(a)=>a[1]|0;export let f=()=>{const a=[7];const b=a;b.push(9);return get(a)}`
  const extend = `const get=(a)=>a[4]|0;export let f=()=>{const a=[];a[4]=9;return get(a)}`
  is(run(alias, { optimize: 'speed' }).f(), 9, 'alias mutation poisons the literal length')
  is(run(extend, { optimize: 'speed' }).f(), 9, 'indexed extension poisons the literal length')
})

test('finite-domain hash probe requires an immutable domain length', () => {
  const safe = `const count=(keys)=>{const d={};for(let i=0;i<keys.length;i++){const k=keys[i];d[k]=(d[k]|0)+1}return d[keys[0]]|0}
    export let f=()=>{const keys=['a','b','a'];return count(keys)}`
  const grow = `const count=(keys)=>{const d={};for(let i=0;i<8;i++){keys.push('k'+i);const k=keys[i];d[k]=(d[k]|0)+1}return d[keys[0]]|0}
    export let f=()=>{const keys=['a'];return count(keys)}`
  const safeWat = compile(safe, { wat: true, optimize: { level: 'speed', watr: false } })
  const growWat = compile(grow, { wat: true, optimize: { level: 'speed', watr: false } })
  ok(/call \$__hash_slot_eph_fixed/.test(safeWat), 'immutable finite key domain uses the no-growth probe')
  ok(!/call \$__hash_slot_eph_fixed/.test(growWat) && /call \$__hash_slot_eph\b/.test(growWat),
    'growing key source retains the growable probe')
  is(run(safe, { optimize: 'speed' }).f(), 2, 'fixed probe count exact')
  is(run(grow, { optimize: 'speed' }).f(), 1, 'growable fallback terminates and stays exact')

  const repeated = `const rounds=(keys,n)=>{let sum=0;for(let r=0;r<n;r++){const d={};for(let i=0;i<keys.length;i++){const k=keys[i];d[k]=(d[k]|0)+1}sum+=d[keys[0]]|0}return sum}
    export let f=(n)=>{const keys=['a','b','a'];return rounds(keys,n)}`
  const f = run(repeated, { optimize: 'speed' }).f
  for (const n of [1, 5, 2, 20, 0, 3]) is(f(n), n * 2, `reused ephemeral table survives reset/call sequence n=${n}`)
})

test('i32 count slots preserve missing keys, negative counts, and assignment values', () => {
  const negative = `const count=(a,b)=>{const d={};d[a]=(d[a]|0)-1;d[a]=(d[a]|0)-1;return (d[a]|0)*10+(d[b]|0)}
    export let f=()=>count('seen','missing')`
  is(run(negative, { optimize: 'speed' }).f(), -20, 'i32 slots preserve negative bits and missing-key zero')

  // 2^32 is truthy as a JS assignment result but ToInt32(2^32) is zero.
  const src = `const count=(k)=>{const d={};let r=0;if(d[k]=4294967296)r=1;return r+(d[k]|0)}
    export let f=()=>count('x')`
  is(run(src, { optimize: 'speed' }).f(), 1, 'condition observes the original boxed assignment value')
})

test('string bounds: a callee cannot change the receiver or a captured index under the proof', () => {
  const cases = [
    `let s=input; function cut(){s=''}; for(let i=0;i<s.length;i++){cut();return s.charCodeAt(i)}`,
    `let s=input; function cut(){s=''}; function relay(){cut()}; for(let i=0,len=s.length;i<len;i++){relay();return s.charCodeAt(i)}`,
    `let s=input; function cut(x=(s='')){}; for(let i=0;i<s.length;i++){cut();return s.charCodeAt(i)}`,
    `let s=input; const box={get value(){s='';return 0}};for(let i=0;i<s.length;i++){box.value;return s.charCodeAt(i)}`,
    `let s=input; const box={valueOf(){s='';return 0}};for(let i=0;i<s.length;i++){+box;return s.charCodeAt(i)}`,
    `const s=input;for(let i=0;i<s.length;i++){function cut(){i=7}cut();return s.charCodeAt(i)}`,
  ]
  for(const body of cases){
    const src=`export function f(input){${body};return -1}`, want=oracle(src).f
    for(const level of levels(0,1,2,3,'size')){
      const f=run(src,{optimize:{level,sourceInline:false}}).f
      for(const input of ['', 'a', 'a', 'xyz', '', 'z'])is(f(input),want(input),`O${level}, ${JSON.stringify(input)}: ${body}`)
    }
  }
})
