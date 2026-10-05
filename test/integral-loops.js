// A loop indexing by numbers the program cannot prove integers runs, when
// they are int32s, as a copy over names written from `x | 0`
// (plan/integral-loops.js): the same values, so the same results for every
// number, integral or not.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { _compileInProcess } from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, wat, funcWat } from './util.js'
import { ctx } from '../src/ctx.js'
import { T, TYPEOF, walkAst } from '../src/ast.js'
import { createActiveFunction } from '../src/compile/active-function.js'
import { extractRefinements, withRefinements } from '../src/compile/flow-types.js'
import { versionableTypedNest } from '../src/type/loop-versioning-nest.js'
import { VAL } from '../src/reps.js'

test('integral loops: rejected Number ranges stay scoped to unchanged private bindings', () => {
  const type = ['===', ['typeof', 'n'], ['str', 'number']]
  const range = ['&&', type, ['&&', ['>=', 'n', [null, -2147483648]], ['<=', 'n', [null, 2147483647]]]]
  const get = condition => extractRefinements(condition, new Map(), false).get('n')?.excludedNumberRange
  is(get(range), [-2147483648,2147483647], 'the complete failed conjunction excludes fractions too')
  is(get(['&&',['===',['typeof','n'],[undefined,TYPEOF.number]],['&&',['>=','n',[undefined,-2147483648]],['<=','n',[undefined,2147483647]]]]),get(range),'prepared typeof and literal nodes')
  for (const extra of [ ['===','flag',[null,1]], ['()', 'change'], ['=','n',[null,3]], ['<=','other',[null,8]] ])
    is(get(['&&',range,extra]),undefined,'an unrelated failed conjunct cannot exclude the range')
  is(get(range[2]),undefined,'a comparison alone supplies no Number predicate')
  is(get(['&&',type,['>=','n',[null,0]]]),undefined,'one-sided tests stay conservative')
  is(get(['&&',type,['&&',['>=','n',[null,-Infinity]],['<=','n',[null,8]]]]),undefined,'infinite bounds stay conservative')
  const prior = ctx.func, summary = ctx.summary
  try {
    ctx.summary = null
    ctx.func = createActiveFunction({sig:{params:[{name:'n',type:'f64'}]}})
    const refs = extractRefinements(range,new Map(),false), body = [';', ['()', 'use', 'n']]
    for (let round=0;round<2;round++) {
      withRefinements(refs,body,()=>is(ctx.func.refinements.get('n').excludedNumberRange,get(range),'same branch twice'))
      is(ctx.func.refinements.get('n'),undefined,'branch scope restored')
    }
    withRefinements(refs,['=', 'n', [null,3]],()=>is(ctx.func.refinements.get('n'),undefined,'a later assignment invalidates the exclusion'))
    withRefinements(refs,body,()=>{
      withRefinements(new Map([['n',{rlo:0}]]),body,()=>is(ctx.func.refinements.get('n').excludedNumberRange,undefined,'a later positive refinement may conservatively replace the exclusion'))
      is(ctx.func.refinements.get('n').excludedNumberRange,get(range),'nested branch restores the outer exclusion')
    })
    ctx.func.boxed.set('n','cell')
    withRefinements(refs,body,()=>is(ctx.func.refinements.get('n'),undefined,'a captured parameter can change through a call'))
    ctx.func.boxed.delete('n')
    ctx.func.current.params=[]
    withRefinements(refs,body,()=>is(ctx.func.refinements.get('n'),undefined,'module and unbound names do not get a private fact'))
    ctx.func.current.params=[{name:'n',type:'f64'}]
    throws(()=>withRefinements(refs,body,()=>{throw 7}),e=>e===7,'exception propagates')
    is(ctx.func.refinements.get('n'),undefined,'exception restores scope')
    withRefinements(refs,body,()=>is(ctx.func.refinements.get('n').excludedNumberRange,get(range),'A after changed and exceptional scopes'))
  } finally {ctx.func=prior;ctx.summary=summary}
})

test('integral loops: impossible typed twins disappear without losing SIMD or Number fallbacks', () => {
  const src=`export function f(a,n){let s=0;for(let i=0;i<n;i++)s+=a[i];return s}`
  for(const optimize of levels(0,1,2,3,'size')) {
    const got=jz(src,{optimize}).exports,host=oracle(src)
    for(const C of [Float64Array,Float32Array]) for(const length of [0,1,8]) {
      const a=C.from({length},(_,i)=>i+0.5)
      for(const n of [0,3,3.5,3,-0,-1,NaN,-Infinity,0,3]) is(got.f(a,n),host.f(a,n),`O${optimize} ${C.name} length${length}, count${n}`)
    }
  }
  if(!belowOpt(2)) {
    const text=wat(src,{optimize:2})
    ok(text.includes('v128'),'the bounded Number copy still vectorizes')
    is((text.match(/\(loop /g)||[]).length,8,'each export keeps vector, tail, checked-word and checked-Number loops only')
    ok(text.includes('f64.lt'),'wide and non-number counts keep their original comparison')
    const prior=ctx.func,summary=ctx.summary
    try {
      ctx.summary=null
      for(const [name,checkedOnly] of [['Uint8Array',false],['Float64Array',true]]) {
        const init=['let',['=','i',[null,0]]],cond=['<','i','n'],step=['++','i'],body=[';', ['+=','s',['[]','a','i']]]
        ctx.func=createActiveFunction({sig:{params:[{name:'n',type:'f64'}]},body:[';',init,['for',init,cond,step,body]]})
        ctx.func.locals=new Map([['i','f64'],['s','f64'],['a','i32']])
        ctx.func.typedElem=new Map([['a','new.'+name]])
        ctx.func.localReps=new Map([['a',{val:VAL.TYPED,ptrKind:VAL.TYPED}]])
        ctx.func.refinements=new Map([['n',{excludedNumberRange:[-2147483648,2147483647]}]])
        const spec=versionableTypedNest(init,cond,step,body,ctx.func.locals)
        ok(spec?.length,'the typed loop admits a bounds guard')
        is(!!spec.checkedOnly,checkedOnly,`${name}: the byte-count ceiling must prove the implication`)
      }
    } finally {ctx.func=prior;ctx.summary=summary}
    for(const [lo,hi,idx,step,expected] of [
      [-2147483648,2147483647,'i','i++',1], [-2147483648,2,'i','i++',2],
      [0,2147483647,'i','i++',2], [-2147483648,2147483647,'i+off','i++',2],
      [-2147483648,2147483647,'i','i+=stride',2],
    ]) {
      const source=`export function f(n,off,stride){const a=new Float64Array(16);
        if(typeof n==='number'&&n>=${lo}&&n<=${hi})return -1;
        else {let s=0,count=0;for(let i=0;i<n;${step}){s+=a[${idx}];if(++count===5)break}return s}}`
      const options={optimize:{level:2,versionIntegralLoops:false,specializeLoops:false}}
      const body=funcWat(wat(source,options),'f')
      is((body.match(/\(loop /g)||[]).length,expected,`${lo}..${hi}, ${idx}, ${step}: only the implied guard is removed`)
      const got=jz(source,options).exports,host=oracle(source)
      for(const n of [0,9,Infinity,2147483648,NaN,9]) for(const [off,stride] of [[0,1],[0.5,1.5],[-1,0],[2147483648,-1]])
        is(got.f(n,off,stride),host.f(n,off,stride),'retained and removed guards preserve their reachable arms')
    }
  }
})

test('integral loops: excluded extents preserve count coercions, writes, captures and offsets', () => {
  const src=`
    export function bounded(n,off){const a=new Float64Array([1,2,3,4,5,6,7,8]),b=new Float32Array([9,10,11]);let s=0,count=0;
      for(let i=0;i<n;i++){s+=a[i+off]+b[i];count++;if(count===5)break}return [s,count]}
    export function inclusive(n){const a=new Float64Array([1,2,3,4]);let s=0,count=0;
      for(let i=0;i<=n;i++){s+=a[i];count++;if(count===5)break}return[s,count]}
    export function initialized(n){const a=new Float64Array([1,2,3,4]);let sum=0,count=0,checks=0;
      if(typeof n==='number'&&n>=-2147483648&&n<=2147483647)return [0,0,0];
      else for(let i=(checks++,0);i<n;i++){sum+=a[i];if(++count===5)break}return[sum,count,checks]}
    export function boundary(n){const a=new Float64Array(4);let sum=0,count=0,last=0;for(let i=2147483646;i<n;i++){last=i;sum+=a[i];if(++count===5)break}return[sum,count,last]}
    export function coercion(n){let calls=0;const a=new Float64Array([1,2,3,4]);const bound={valueOf(){calls++;return n}};let s=0,count=0;
      for(let i=0;i<bound;i++){s+=a[i];count++;if(count===5)break}return[s,count,calls]}
    export function reassigned(n){const a=new Float64Array([1,2,3,4]);let s=0;
      if(typeof n==='number'&&n>=-2147483648&&n<=2147483647)return -1;
      else {n=3.5;for(let i=0;i<n;i++)s+=a[i]}return s}
    export function captured(n){const a=new Float64Array([1,2,3,4]);let s=0;const change=()=>{n=3.5};
      if(typeof n==='number'&&n>=-2147483648&&n<=2147483647)return -1;
      else {change();for(let i=0;i<n;i++)s+=a[i]}return s}
    export function partial(n){const a=new Float64Array(16);let count=0;
      if(typeof n==='number'&&n>=-2147483648&&n<=8)return -1;
      else for(let i=0;i<n;i++){a[i]=i;count++;if(count===5)break}return[a[4],count]}
  `
  for(const optimize of levels(0,1,2,3,'size')) {
    const got=jz(src,{optimize}).exports,host=oracle(src)
    for(const n of [0,3,3.5,3,-0,-1,NaN,Infinity,-Infinity,2147483647,2147483648,-2147483649,4294967296,'3',true,null,undefined,0,3]) {
      for(const name of ['inclusive','boundary','initialized','coercion','reassigned','captured','partial']) is(got[name](n),host[name](n),`O${optimize} ${name}(${n})`)
      for(const off of [-1,0,0.5,1,2147483648]) is(got.bounded(n,off),host.bounded(n,off),`O${optimize} offset${off},count${n}`)
    }
  }
})

// a ring buffer's cursor and a tap count read back from a state record
const fir = `const st = { p: 0, taps: 5 }
const h = new Float64Array(9).map((_, i) => 1 / (i + 1)), buf = new Float64Array(9)
export let set = (p, taps) => { st.p = p; st.taps = taps }
export let run = (n) => { let N = st.taps, p = st.p, out = 0
  for (let i = 0; i < n; i++) { buf[p] = i * 0.5; let acc = 0, idx = p
    for (let k = 0; k < N; k++) { acc += buf[idx] * h[k]; idx = idx === 0 ? N - 1 : idx - 1 }
    out += acc; p = (p + 1) % N }
  st.p = p; return out }
export let cursor = () => st.p`

test('integral loops: while counter copies preserve full entries, bounds and landing values', () => {
  for (const [cmp, step] of [['<', 'i++'], ['<=', 'i++'], ['<', 'i+=3'], ['<', 'i++;if(count&1)i++']]) {
    const src = `export function run(start, n) {
      const a = new Int32Array([2, 3, 5, 7, 11, 13, 17, 19]), out = []
      let i = start, count = 0
      while (i ${cmp} n) {
        out.push(i, a[i & 7]); count++
        if (count > 4) break
        ${step}
      }
      return [out, i, 1 / i]
    }`
    const host = oracle(src)
    for (const optimize of levels(0, 1, 2, 3, 'size')) {
      const got = jz(src, { optimize }).exports
      for (const [start, n] of [[0, 0], [0, 3], [0, 2.5], [0, 3], [-0, 0], [-0, 2], [-3, -1],
        [2147483645, 2147483647], [2147483646, 2147483648], [-2147483648, -2147483645],
        [-2147483649, -2147483646], [4294967296, 4294967299], [0.5, 3], [NaN, 2],
        [0, NaN], [0, -Infinity], [0, Infinity], [Infinity, Infinity], [0, 0], [0, 3]])
        is(got.run(start, n), host.run(start, n), `O${optimize}: ${start} ${cmp} ${n}, ${step}`)
    }
  }
})

test('integral loops: global bounds snapshot only while their value remains stable', () => {
  for (const loop of ['for (let i=0; i<N; i++)', 'let i=0; while(i<N)']) {
    const step = loop.startsWith('let') ? 'i++' : ''
    for (const change of ['', 'if (i===0) N=1', 'if(i===0) change()', 'sum+=box.x', 'sum+=box', 'sum+=Math.abs(box)']) {
      const src = `let N = 0
        function change(){N=1}
        const box = {get x(){N=1;return 1},valueOf(){N=1;return 1}}
        export function run(n) {
          N=n; const a=new Int32Array([2,3,5,7,11,13,17,19]);let sum=0,count=0
          ${loop} { sum+=a[i&7];count++;${change};${step};if(count>4)break }
          return [sum,count,N]
        }`
      const host = oracle(src)
      for (const optimize of levels(0, 1, 2, 3, 'size')) {
        const got = jz(src, { optimize }).exports
        for (const n of [0, 3, 2.5, 3, -1, -0, NaN, Infinity, 2147483648, 0, 3])
          is(got.run(n), host.run(n), `O${optimize}: ${loop}, ${change || 'stable'}, n=${n}`)
      }
    }
  }
})

test('integral loops: loop guards add no coercions and retain an integer fast copy', () => {
  const src = `export function run(start, n) {
    let checks=0, count=0, i=start
    const bound={valueOf(){checks++;return n}}
    while(i<bound){count++;i++;if(count>4)break}
    return [checks,count,i,1/i]
  }`
  const host = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const got = jz(src, { optimize }).exports
    for (const [start,n] of [[0,0],[0,3],[-0,2],[0.5,3],[4294967296,4294967298],[0,NaN],[0,0],[0,3]])
      is(got.run(start,n),host.run(start,n), `O${optimize}: object bound ${start}, ${n}`)
  }
  if (!belowOpt(2)) {
    const source = `let N=0;export function set(n){N=n}
      export function f(){const a=new Int32Array(16);let i=0,s=0;while(i<N){s+=a[i];i++}return s}`
    // Check source carrier names before watr can coalesce them with pointer locals.
    const text = funcWat(wat(source, {optimize:{level:3,watr:false}}), 'f')
    ok(/\(local \$i\S*int\d+ i32\)/.test(text), 'the guarded copy holds its counter in an integer local')
    ok(/i32\.(?:lt|ge)_s/.test(text), 'the guarded loop compares integer counters')
    ok(text.includes('f64.lt') || text.includes('f64.ge'), 'the original full Number bound keeps its fallback')
  }
})

test('integral loops: every cursor and count agrees with JS, integral or not', () => {
  for (const optimize of levels(0, 2, 3)) {
    const js = oracle(fir)
    const m = jz(fir, { optimize }).exports
    for (const [p, taps] of [[0, 5], [3, 9], [2.5, 5], [-0, 5], [NaN, 4], [2 ** 31, 3], [-1, 5], [4, 0], [1, 2.5], [-3, 7]]) {
      js.set(p, taps); m.set(p, taps)
      for (const n of [0, 1, 7]) {
        const a = js.run(n), b = m.run(n)
        ok(Object.is(a, b), `run(${n}) with p=${p}, taps=${taps} at ${optimize}: ${b} for ${a}`)
        ok(Object.is(js.cursor(), m.cursor()), `cursor after, p=${p}, taps=${taps} at ${optimize}: ${m.cursor()} for ${js.cursor()}`)
      }
    }
  }
})

test('integral loops: fixed nonnumeric writes keep identity in either loop arm', () => {
  const src = `export function run(n) {
    let text='', value={i:-1}, flag=false;const initial=value
    for(let i=0;i<n;i++){text+='ab';value={i};flag=!flag;if(i===2)break}
    return[text,value.i,flag,initial.i,value===initial]
  }`
  const js = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const { run } = jz(src, { optimize }).exports
    for (const n of [0, 1, 1, 2.25, -1, 2147483648, NaN, Infinity, 0])
      is(run(n), js.run(n), `O${optimize}: ${n}`)
  }
})

test('integral loops: what else the loop writes reads the same after it', () => {
  const src = `const buf = new Float64Array(8)
    export let run = (p0, n, tag) => { let p = p0, s = tag, count = 0, last = null
      for (let i = 0; i < n; i++) { buf[p & 7] = i; buf[p] += i; s += 'ab'[i & 1]; count++; last = i > 2 ? { i } : last; p = (p + 3) % 8 }
      return s + ':' + p + ':' + count + ':' + (last ? last.i : -1) + ':' + buf[2] }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const { run } = jz(src, { optimize }).exports
    for (const [p0, n, tag] of [[1, 6, 'x'], [2.5, 4, 'y'], [-0, 3, ''], [5, 0, 'z'], [NaN, 2, 'w']]) is(run(p0, n, tag), js.run(p0, n, tag), `run(${p0}, ${n}) at ${optimize}`)
  }
})

// `p = q + 1` reads q, which the loop halves: q is no integer, so p is none
// either; the census drops both and stops (it used to re-add q forever)
test('integral loops: a handler reads what the loop wrote before it threw', () => {
  // a copy writes the cursor under a name of its own, which a throw leaves unwritten
  const src = `const buf = new Float64Array(8)
    export let run = (p0, k) => { let p = p0, h = 0
      try { for (let i = 0; i < 8; i++) { h += 1; p = (p + 1) % 5; if (i === k) throw new Error('x'); buf[p] = i } } catch (e) { return h * 100 + p }
      return h }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    for (const [p, k] of [[2, 3], [2, 20], [2.5, 1], [0, 0]]) is(m.run(p, k), js.run(p, k), `run(${p}, ${k}) at ${optimize}`)
  }
})

test('integral loops: an index read through a name the loop writes a fraction to agrees with JS', () => {
  const src = `export let f = (n, p0) => { const a = new Float64Array(4); let p = p0, q = 0.5
    for (let i = 0; i < n; i++) { a[p] += 1; p = q + 1; q = q * 0.5 } return a[0] + a[1] * 10 + a[2] * 100 }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const { f } = jz(src, { optimize }).exports
    for (const [n, p0] of [[0, 0], [1, 0], [3, 2], [4, 1.5]]) is(f(n, p0), js.f(n, p0), `f(${n}, ${p0}) at ${optimize}`)
  }
})

// A filter state read back from storage of mixed kinds (a Float64Array by
// default, a plain list where the caller keeps one): `z1 = s[0]` is of no
// known kind, and each `+` of it asks for a string. Where the state holds
// Numbers the loop runs as a copy whose sums add.
const biquad = `function state() { return new Float64Array(2) }
function section(fc) { const a = Math.exp(-fc); return { b0: 1 - a, b1: 0.1, b2: 0, a1: -a, a2: 0.05 } }
function biquad(data, c, s = state()) {
  let z1 = s[0], z2 = s[1]
  for (let i = 0, l = data.length; i < l; i++) {
    let x = data[i]
    let y = c.b0 * x + z1
    z1 = c.b1 * x - c.a1 * y + z2
    z2 = c.b2 * x - c.a2 * y
    data[i] = y
  }
  s[0] = z1; s[1] = z2
  return data
}
const lp = section(0.3), hp = section(0.1), st = [0, 0], odd = ['1', 0]
const buf = new Float32Array(64)
export let run = (k) => {
  for (let i = 0; i < 64; i++) buf[i] = ((i * 13 + k) % 17) / 8 - 1
  biquad(buf, lp, st)
  const t = biquad(new Float32Array(buf), hp)
  const u = biquad(new Float32Array(3), hp, odd)
  return buf[7] + buf[63] + t[9] + st[0] + ':' + u[0] + u[2] + odd[0]
}`

test('integral loops: a state of unknown kind agrees with JS, a number or not', () => {
  for (const optimize of levels(0, 2, 3)) {
    const js = oracle(biquad)
    const { run } = jz(biquad, { optimize }).exports
    for (const k of [0, 1, 2, 5]) is(run(k), js.run(k), `run(${k}) at ${optimize}`)
  }
})

test('integral loops: where the state holds Numbers the loop adds them', () => {
  if (belowOpt(2)) return
  const text = wat(biquad, { optimize: 2 })
  const loops = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    loops.push(text.slice(at, end))
  }
  // the filter loop: five coefficient reads, a sample in and out, no string test
  ok(loops.some(l => (l.match(/f64\.load/g) || []).length >= 5 && /f32\.store/.test(l) && !/call \$__(is_str_key|add_slow|to_num)/.test(l)), 'a copy of the filter loop adds Numbers')
})

// A callback a factory returns keeps its state on a record, fields added on
// first use: `let keys = state.keys` may be undefined as far as the summary
// knows, and each access in the loop tests it. Where all are present the
// loop, a closure's own, runs as a copy that reads them as the typed arrays
// and the record (read only by its fields) they are.
const stateful = `function makeProcess(tol) {
  return function (mag, state) {
    if (!state.keys) { state.keys = new Float64Array(mag.length); state.acc = new Float64Array(mag.length); state.coef = { g: tol, h: 0.5 } }
    let keys = state.keys, acc = state.acc, coef = state.coef, s = 0, m = mag.length - 1
    while (m > 0) { keys[m] = mag[m] * coef.g + acc[m - 1]; acc[m] = keys[m] * coef.h; s += keys[m]; m -= 1 + (m & 1) }
    return s
  }
}
const p = makeProcess(0.3), st = {}, mag = new Float64Array(16)
export let f = (k) => { for (let i = 0; i < 16; i++) mag[i] = (i * k) % 5; return p(mag, st) }
export let g = (k) => makeProcess(k)(mag, {})`

test('integral loops: a state field that may be missing agrees with JS', () => {
  const js = oracle(stateful)
  for (const optimize of levels(0, 2, 3)) {
    const { f, g } = jz(stateful, { optimize }).exports
    for (const k of [1, 2, 3]) { is(f(k), js.f(k), `f(${k}) at ${optimize}`); is(g(k), js.g(k), `g(${k}) at ${optimize}`) }
  }
})

test('integral loops: where the state is present a copy of the closure loop reads it untested', () => {
  if (belowOpt(2)) return
  const text = wat(stateful, { optimize: 2 })
  const loops = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    loops.push(text.slice(at, end))
  }
  ok(loops.some(l => (l.match(/f64\.store/g) || []).length >= 2 && !/call \$__throw_property_nullish/.test(l)), 'a copy of the loop tests none of them')
})

test('integral loops: the integral copy reads by an i32 index', () => {
  if (belowOpt(2)) return
  const text = wat(fir, { optimize: 2 })
  const loops = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    loops.push(text.slice(at, end))
  }
  // the tap loop: a buffer read and a coefficient read, no float index to convert
  ok(loops.some(l => (l.match(/f64\.load/g) || []).length >= 2 && !/\(loop[\s\S]*\(loop/.test(l) && !/trunc_sat/.test(l)), 'an inner loop indexes without converting a float')
})

test('integral loops: the guard converts no object, and a parameter every call binds to an integer needs none (test/twin-locals.js pins its copy)', () => {
  // `key | 0` in the guard ran valueOf before the loop: once more, and where a loop of no iterations runs none
  const src = `export let f = (n) => { const a = new Float64Array(4); a[0] = 5; let calls = 0
      const key = { valueOf () { calls++; return 0 } }
      let s = 0
      for (let i = 0; i < n; i++) s += a[key]
      return s * 100 + calls }
    const walk = (s, off, n) => { let r = off, t = 0; for (let i = 0; i < n; i++) t += s[r++]; return t }
    export let g = (off) => walk(new Uint8Array(16).fill(3), off | 0, 4)`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    for (const n of [0, 3]) is(m.f(n), js.f(n), `f(${n}) at ${optimize}`)
    is(m.g(2), js.g(2), `g at ${optimize}`)
  }
})

// A counter tested against a name of unknown integrality (`i < n`, n a lag bound
// a caller passes as a float): the counter is an int32 only in a copy where the
// bound is one, the correlation's reads then whole indices (stretch-psola's
// period search ran twice as slow without it).
test('integral loops: a counter bounded by a float of unknown integrality counts in an int32 copy', () => {
  const src = `const d = new Float32Array(96)
    for (let i = 0; i < 96; i++) d[i] = Math.sin(i * 0.37) + (i % 5) * 0.1
    function corr (data, pos, lo, hi) { let best = -1, at = 0
      for (let lag = lo; lag <= hi; lag++) { let s = 0, e = 0, n = hi
        for (let i = 0; i < n; i++) { const b = data[pos + i + lag]; s += data[pos + i] * b; e += b * b }
        const r = e > 0 ? s / Math.sqrt(e) : 0
        if (r > best) { best = r; at = lag } }
      return at * 1000 + best }
    export let f = (pos, lo, hi) => corr(d, pos * 0.5, lo * 0.5, hi * 0.5)`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    for (const a of [[0, 4, 20], [6, 2, 30], [1, 3, 21], [80, 4, 40], [3, 7, 7]]) is(m.f(...a), js.f(...a), `f(${a}) at ${optimize}`)
  }
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 })
  const loops = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    loops.push(text.slice(at, end))
  }
  const inner = loops.filter(l => !/\(loop/.test(l.slice(5)) && /f32\.load/.test(l))
  ok(inner.some(l => !/trunc_sat/.test(l) && !/f64\.convert_i32_s/.test(l)), 'a copy of the correlation indexes by an int32 counter')
})

// A copy writes back what it wrote under names of its own after the loop: a jump
// to a label outside (`continue out`, `break out`) would leave past that, so a
// loop with one keeps its own names.
test('integral loops: a loop that jumps to a label outside it agrees with JS', () => {
  const src = `export let f = (x) => { let s = 0; s = x; out: for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) { if (j > x) continue out; s += 1 } } s = s * 2; return s }
    export let g = (x, n) => { let s = x, p = 0; out: for (let k = 0; k < 3; k++) { for (let i = 0; i < n; i++) { p = (p + 3) % 7; if (p > x) break out; s += p } } return s * 10 + p }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) for (const splitBindings of [true, false]) {
    const m = jz(src, { optimize: typeof optimize === 'number' ? { level: optimize, splitBindings } : optimize }).exports
    for (const x of [0, 1, 3, 7, 2.5]) is([m.f(x), m.g(x, 6)], [js.f(x), js.g(x, 6)], `x = ${x} at ${optimize}${splitBindings ? '' : ', bindings whole'}`)
  }
})


test('integral loops: Number counters cross signed-word boundaries without wrapping', () => {
  const src = `function keep(x) { return x }
    export function up(n) { let out = []; for (let i = 2147483647; i < n; i++) { out.push(i, keep(i % 6)); if (out.length === 4) break } return out }
    export function down(n) { let out = []; for (let i = -2147483648; i > n; i--) { out.push(i, keep(i % 6)); if (out.length === 4) break } return out }
    export function stride(n) { let out = []; for (let i = 2147483646; i < n; i += 3) { out.push(i); if (out.length === 3) break } return out }
    export function observed(n) { let i = 2147483647; if (i < n) i++; const j = i; return [i, j, i < n, i === 2147483648] }
    let counter = 0;
    export function global(n) { counter = 2147483647; let out = []; while (counter < n) { out.push(counter++); if (out.length === 2) break } return out }
  `
  const js = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const m = jz(src, { optimize }).exports
    for (const n of [2147483647, 2147483649, 2147483649, 2147483651, 2147483649, NaN, Infinity, -Infinity])
      for (const name of ['up', 'stride', 'observed', 'global']) is(m[name](n), js[name](n), `${name}(${n}) at ${optimize}`)
    for (const n of [-2147483648, -2147483650, -2147483650, -2147483652, -2147483650, NaN, Infinity, -Infinity])
      is(m.down(n), js.down(n), `down(${n}) at ${optimize}`)
  }
})

test('integral loops: bounded copies preserve fractional bounds, initialization, mutation and exits', () => {
  const src = `
    export function ordinary(n) { let out = []; for (let i = 0; i < n; i++) { out.push(i, n); if (out.length === 6) break } return out }
    export function negative(n) { let out = []; for (let i = -2; i < n; i++) { out.push(i, n); if (out.length === 6) break } return out }
    export function descending(n) { let out = []; for (let i = 2; i > n; i--) { out.push(i, n); if (out.length === 6) break } return out }
    export function inclusive(n) { let out = []; for (let i = 2147483647; i <= n; i++) { out.push(i); if (out.length === 3) break } return out }
    export function changed(n) { let out = []; for (let i = (n = 2147483649, 2147483647); i < n; i++) { out.push(i); if (out.length === 3) break } return out }
    export function captured(n) { let out = [], bound = n; function change() { bound = 2147483650 } for (let i = 2147483647; i < bound; i++) { out.push(i); change(); if (out.length === 3) break } return out }
    export function moving(n) { let out = []; for (let i = 2147483647; i < n; i++) { out.push(i); n = 2147483650; if (out.length === 3) break } return out }
    export function jumped(n) { let out = []; for (let i = 2147483647; i < n; i++) { if (i === 2147483647) continue; out.push(i); break } return out }
    export function fractional(n) { let out = []; for (let i = -0; i < n; i += 0.5) { out.push(i); if (out.length === 3) break } return out }
  `
  const js = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const m = jz(src, { optimize }).exports
    for (const n of [0, 1, 1, 2.5, 1, -0, -1.5, NaN, Infinity, -Infinity, 2147483649])
      for (const name of ['ordinary', 'negative', 'descending', 'inclusive', 'changed', 'captured', 'moving', 'jumped', 'fractional'])
        is(m[name](n), js[name](n), `${name}(${n}) at ${optimize}`)
  }
})

test('integral loops: explicit word counters preserve wrapping and full Number thresholds', () => {
  const functions = [['lt', 'i < n'], ['le', 'i <= n'], ['gtMirror', 'n > i'], ['geMirror', 'n >= i']]
    .flatMap(([name, condition]) => [2147483647, -2].map((start, index) => `export function ${name}${index}(n) { let out = []; for (let i = ${start}; ${condition}; i = (i + 1) | 0) { out.push(i); if (out.length === 3) break } return out }`)).join('\n')
  const js = oracle(functions)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const m = jz(functions, { optimize }).exports
    for (const n of [2147483647, 2147483649, 2147483649, -1.5, 2147483649, -2147483649, -0, NaN, Infinity, -Infinity])
      for (const name of Object.keys(js)) is(m[name](n), js[name](n), `${name}(${n}) at ${optimize}`)
  }
})

test('integral loops: a number carried through a nested loop keeps its value across the outer loop', () => {
  // The inner copy renames what it writes; the loop around runs it again, so
  // the copy writes the originals back (this once reset `s` every row).
  const src = `let px
    export let init = (n) => { px = new Float64Array(n); return px }
    export let f = (W, H) => {
      let s = 0.5, j = 0, py = 0
      while (py < H) {
        let qx = 0
        while (qx < W) { s = s + qx; px[j] = s; j++; qx++ }
        py++
      }
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    for (const [w, h] of [[4, 3], [1, 5], [3, 1], [0, 2], [2.5, 2], [2, 2.5]]) {
      const got = m.init(16), want = js.init(16)
      m.f(w, h); js.f(w, h)
      is(Array.from(got), Array.from(want), `${w}×${h} at ${optimize}`)
    }
  }
})

test('integral loops: a nest over module dimensions is one version, its pixel cursor a word', () => {
  // The outer copy decides the inner bound once, holds the inner fast arm alone
  // (the loop as written keeps the inner loop as written), and budgets the
  // cursor stepped per pixel by the trips of both levels: `j` runs as i32.
  const src = `let W = 0, H = 0, px
    export let resize = (w, h) => { W = w; H = h; px = new Uint32Array(w * h); return px }
    export let frame = (t) => {
      let j = 0, py = 0
      while (py < H) {
        let qx = 0
        while (qx < W) {
          let x = 0.5, L = 0, ai = 0
          while (ai < 160) { x = 3.7 * x * (1 - x); L = L + Math.log(Math.abs(1 - 2 * x)); ai++ }
          px[j] = (L > 0 ? 255 : 0) | (255 << 24)
          j++; qx++
        }
        py++
      }
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [w, h] of [[6, 4], [3, 2.5], [0, 3], [5, 1]]) {
      const got = m.resize(w, h), want = js.resize(w, h)
      m.frame(0); js.frame(0)
      is(Array.from(got), Array.from(want), `${w}×${h} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const frame = funcWat(wat(src, { optimize: 'speed' }), 'frame')
  ok(/\(local \$jint\d+ i32\)/.test(frame), 'the pixel cursor is carried as a word')
  const loops = (frame.match(/\(loop /g) || []).length
  ok(loops <= 24, `one version of the nest (${loops} loops; a version per level squares them)`)
})

test('integral loops: a raster nest\'s row base and derived index are words, so the stencil lifts', () => {
  // `rowC = y * w`, `c = rowC + x`, `xW = x === 0 ? w - 1 : x - 1`: integers of the
  // counter and of names the guard holds to int32s, reaching an element index.
  // Their hulls over the loop are expressions of what the guard reads; where
  // they fit i32 the copy declares each as its word, and the typed-bounds
  // versioning reads an affine index of words: the 5-point stencil lifts. The
  // loop as written keeps every other input (a fractional width reads past the
  // row as JS does).
  const src = `let W = 0, H = 0, uA, uB
    export let resize = (w, h) => { W = w; H = h; uA = new Float64Array(w * h); uB = new Float64Array(w * h); for (let i = 0; i < uA.length; i++) uA[i] = i % 7; return uB }
    export let step = () => {
      let w = W, h = H, y = 0
      while (y < h) {
        let yN = y === 0 ? h - 1 : y - 1, yS = y === h - 1 ? 0 : y + 1
        let rowC = y * w, rowN = yN * w, rowS = yS * w, x = 0
        while (x < w) {
          let xW = x === 0 ? w - 1 : x - 1, xE = x === w - 1 ? 0 : x + 1
          let c = rowC + x
          uB[c] = uA[rowN + x] + uA[rowS + x] + uA[rowC + xW] + uA[rowC + xE] - 4 * uA[c]
          x++
        }
        y++
      }
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [w, h] of [[0, 0], [1, 1], [3, 5], [7, 1], [1, 7], [16, 12], [6.5, 4], [5, NaN]]) {
      const got = m.resize(w, h), want = js.resize(w, h)
      m.step(); js.step()
      is(Array.from(got).map(v => Number.isNaN(v) ? 'NaN' : v), Array.from(want).map(v => Number.isNaN(v) ? 'NaN' : v), `${w}×${h} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const step = funcWat(wat(src, { optimize: 'speed' }), 'step')
  ok((step.match(/v128\.load/g) || []).length >= 4 && /f64x2\.add/.test(step), 'the neighbour stencil lifts to f64x2 (the row base and the derived index are words)')
})

test('integral loops: a ring counter is a cursor with a floor, and a loop under a literal bound guards nothing', () => {
  // `si = si + 1; if (si >= N) si = 0` steps up by a literal and resets to one:
  // its advance over the loop is the trips times the step, from the higher of
  // its entry and the reset. A loop under a literal bound counts its trips
  // without a guard of the bound; a cursor entering from a literal, or from the
  // hull a copy just before left it in, runs as a word with no test at all. The
  // pixel loop then holds two plain inner loops, and the iterated-map reduction
  // lifts it.
  const src = `let W = 0, H = 0, px, SEQLEN = 5, seq
    export let resize = (w, h) => { W = w; H = h; px = new Uint32Array(w * h); seq = new Int32Array(8); seq[2] = 1; seq[4] = 1; return px }
    export let setSeq = (bits, len) => { if (len < 2) len = 2; if (len > 6) len = 6; SEQLEN = len; let i = 0; while (i < len) { seq[i] = (bits >> i) & 1; i++ } }
    export let frame = (ox, oy, span) => {
      let j = 0, py = 0
      while (py < H) {
        let b = 2.5 + oy + py * span, qx = 0
        while (qx < W) {
          let a = 2.5 + ox + qx * span, x = 0.5, si = 0, wi = 0
          while (wi < 80) { let r = seq[si] < 1 ? a : b; x = r * x * (1 - x); si = si + 1; if (si >= SEQLEN) si = 0; wi++ }
          let L = 0, ai = 0
          while (ai < 160) { let r = seq[si] < 1 ? a : b; let d = Math.abs(r * (1 - 2 * x)); x = r * x * (1 - x); if (d > 0) L = L + Math.log(d); si = si + 1; if (si >= SEQLEN) si = 0; ai++ }
          px[j] = (L < 0 ? 255 : 0) | (255 << 24)
          j++; qx++
        }
        py++
      }
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [w, h, bits, len] of [[6, 4, 0b10100, 5], [3, 2, 0b1, 2], [5, 1, 0b111, 3.5], [4, 3, 0b10, NaN], [0, 3, 0b1, 4]]) {
      const got = m.resize(w, h), want = js.resize(w, h)
      m.setSeq(bits, len); js.setSeq(bits, len)
      m.frame(0.1, 0.2, 0.03); js.frame(0.1, 0.2, 0.03)
      is(Array.from(got), Array.from(want), `${w}×${h} seq ${len} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const frame = funcWat(wat(src, { optimize: 'speed' }), 'frame')
  ok(/call \$math\.log_v/.test(frame) && /f64x2\.mul/.test(frame), 'the iterated-map reduction lifts the pixel loop (log → $math.log_v)')
  ok(/\(local \$si\S* i32\)/.test(frame) && !/\(local \$si\S* f64\)/.test(frame), 'the ring counter is a word in every copy')
})

// The copy's words, read off the planned body: the plan pass rewrites in place,
// so the function's body after a compile holds the copies it made.
const planned = (src, name) => { _compileInProcess(src, { optimize: 'speed' }); return ctx.funcs.list.find(f => f.name === name)?.body }
const countNodes = (node, pred) => { let k = 0; walkAst(node, { enter: n => { if (pred(n)) k++ } }); return k }
const isWordOf = (n, pred) => Array.isArray(n) && n[0] === '|' && n.length === 3 && Array.isArray(n[2]) && n[2][0] == null && n[2][1] === 0 && pred(n[1])

test('integral loops: a density scatter under a range test indexes by a word', () => {
  // `row = (…) | 0; if (row >= 0 && row < H) dens[row * W + col]++`: the test
  // bounds `row`, the guard holds W and H to int32s and tests the product's
  // hull, and the copy declares the index as its word (an `imul` of words):
  // the hot loop stores through an i32 index, where a Number index converted
  // and checked on every count. The loop as written keeps fractional sizes.
  const src = `let W = 0, H = 0, dens
    export let resize = (w, h) => { W = w; H = h; dens = new Uint32Array(w * h); return dens }
    export let frame = (r0, r1) => {
      let n = W * H, i = 0
      while (i < n) { dens[i] = 0; i++ }
      let col = 0
      while (col < W) {
        let r = r0 + (col / W) * (r1 - r0), x = 0.5, k = 0
        while (k < 40) { x = r * x * (1 - x); k++ }
        k = 0
        while (k < 60) {
          x = r * x * (1 - x)
          let row = (x * H) | 0
          if (row >= 0 && row < H) { let idx = row * W + col; dens[idx] = dens[idx] + 1 }
          k++
        }
        col++
      }
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [w, h] of [[8, 6], [1, 1], [0, 4], [5, 2.5], [7.5, 3], [3, NaN]]) {
      const got = m.resize(w, h), want = js.resize(w, h)
      m.frame(2.9, 3.9); js.frame(2.9, 3.9)
      is(Array.from(got), Array.from(want), `${w}×${h} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const body = planned(src, 'frame')
  ok(countNodes(body, n => isWordOf(n, e => Array.isArray(e) && e[0] === '+' && Array.isArray(e[1]) && e[1][0] === '()' && e[1][1] === 'math.imul')) >= 1, 'the index is a word of an imul of words')
})

test('integral loops: a deposit behind an early return reads its cell as a word', () => {
  // lorenz's `dep`: spliced into the polyline loop, `if (ix < 1 || ix >= W - 1 || …) return`
  // leaves its sequel with each test's negation; `c = iy * W + ix` is a word there.
  const src = `let W = 0, H = 0, energy
    export let resize = (w, h) => { W = w; H = h; energy = new Float32Array(w * h); return energy }
    let dep = (ix, iy, add) => {
      if (ix < 1 || ix >= W - 1 || iy < 1 || iy >= H - 1) return
      let c = iy * W + ix
      energy[c] = energy[c] + add
      energy[c - 1] = energy[c - 1] + add * 0.25; energy[c + 1] = energy[c + 1] + add * 0.25
      energy[c - W] = energy[c - W] + add * 0.25; energy[c + W] = energy[c + W] + add * 0.25
    }
    export let frame = (t) => {
      let s = 0
      while (s < 200) { let fx = 1.5 + 0.03 * s * (W - 3), fy = 1.5 + Math.sin(s * 0.17 + t) * 0.5 * (H - 3) + 0.5 * (H - 3); dep(fx | 0, fy | 0, 0.05); s++ }
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [w, h] of [[16, 12], [3, 3], [2, 2], [0, 5], [9.5, 7], [6, NaN]]) {
      const got = m.resize(w, h), want = js.resize(w, h)
      m.frame(0.3); js.frame(0.3)
      is(Array.from(got), Array.from(want), `${w}×${h} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const body = planned(src, 'frame')
  ok(countNodes(body, n => isWordOf(n, e => Array.isArray(e) && e[0] === '+' && Array.isArray(e[1]) && e[1][0] === '()' && e[1][1] === 'math.imul')) >= 1, 'the cell is a word of an imul of words')
})

test('integral loops: a queue\'s module cursors and its elements run as words of the copy', () => {
  // sandpile's relax: `c = queue[qHead]; qHead++; if (qHead >= QN) qHead = 0` with the
  // cursors module bindings. The loop runs no user code and nothing in it can throw,
  // so the copy steps its own words and stores them back; the ring's reset bounds
  // them whatever the trips; the element read at a proven index is a word too.
  const src = `let Gw = 0, grid, inq, queue, qHead = 0, qTail = 0, qCount = 0, QN = 0
    export let resize = (w) => { Gw = w | 0; let n = Gw * Gw; QN = n; grid = new Int32Array(n); inq = new Int32Array(n); queue = new Int32Array(n); qHead = 0; qTail = 0; qCount = 0; return grid }
    let push = (c) => { if (inq[c] === 0) { inq[c] = 1; queue[qTail] = c; qTail++; if (qTail >= QN) qTail = 0; qCount++ } }
    export let drop = (c, n) => { grid[c] += n; if (grid[c] >= 4) push(c) }
    export let relax = (budget) => {
      let done = 0, gw = Gw
      while (qCount > 0 && done < budget) {
        let c = queue[qHead]
        qHead++
        if (qHead >= QN) qHead = 0
        qCount--
        inq[c] = 0
        if (grid[c] >= 4) {
          let gx = c % gw, gy = (c / gw) | 0
          let topples = grid[c] >> 2
          grid[c] -= topples * 4
          done += topples
          if (gx > 0) { let nb = c - 1; grid[nb] += topples; if (grid[nb] >= 4) push(nb) }
          if (gx < gw - 1) { let nb = c + 1; grid[nb] += topples; if (grid[nb] >= 4) push(nb) }
          if (gy > 0) { let nb = c - gw; grid[nb] += topples; if (grid[nb] >= 4) push(nb) }
          if (gy < gw - 1) { let nb = c + gw; grid[nb] += topples; if (grid[nb] >= 4) push(nb) }
          if (grid[c] >= 4) push(c)
        }
      }
      return done
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [w, k] of [[9, 400], [4, 60], [1, 5], [12, 2000]]) {
      const got = m.resize(w), want = js.resize(w)
      m.drop((w * w) >> 1, k); js.drop((w * w) >> 1, k)
      for (let r = 0; r < 5; r++) is(m.relax(50), js.relax(50), `relax ${w} ${k} round ${r} at ${optimize}`)
      is(Array.from(got), Array.from(want), `grid ${w} ${k} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const body = planned(src, 'relax')
  ok(countNodes(body, n => isWordOf(n, e => Array.isArray(e) && e[0] === '[]' && /^queue/.test(e[1]))) >= 1, 'the popped cell is a word of the queue element')
  ok(countNodes(body, n => isWordOf(n, e => Array.isArray(e) && e[0] === '+' && typeof e[1] === 'string' && /^qHead/.test(e[1]))) >= 1, 'the head cursor steps as a word')
  const relax = funcWat(wat(src, { optimize: 'speed' }), 'relax')
  ok(/global\.set \$qHead/.test(relax) && /global\.set \$qTail/.test(relax), 'the copy stores the cursors back')
})

test('integral loops: a union-find\'s find loops are one with the copy that proves their roots', () => {
  // percolation: `find` spliced twice per union, its root a moving index of its own
  // loop. In the sweep's copy the root enters as a word (the cell index, an imul of
  // words) and stays one (`parent[parent[r]] | 0`), so the find loops need no test
  // of their own there: the copy holds their fast arms alone.
  const src = `let W = 0, H = 0, parent, rnk, r
    export let resize = (w, h) => { W = w; H = h; parent = new Int32Array(w * h); rnk = new Int32Array(w * h); r = new Float64Array(w * h); let i = 0; while (i < w * h) { r[i] = ((i * 7919) % 101) / 101; i++ } return parent }
    let find = (i) => { let cur = i; while (parent[cur] !== cur) { let pp = parent[parent[cur]] | 0; parent[cur] = pp; cur = pp } return cur }
    let union = (a, b) => { let ra = find(a), rb = find(b); if (ra === rb) return; if (rnk[ra] < rnk[rb]) { let t = ra; ra = rb; rb = t } parent[rb] = ra; rnk[ra] = rnk[ra] + rnk[rb] }
    export let frame = (p) => {
      let w = W, h = H, n = w * h, i = 0
      while (i < n) { if (r[i] < p) { parent[i] = i; rnk[i] = 1 } else parent[i] = -1; i++ }
      let y = 0
      while (y < h) {
        let x = 0
        while (x < w) {
          let idx = y * w + x
          if (parent[idx] >= 0) {
            if (x < w - 1 && parent[idx + 1] >= 0) union(idx, idx + 1)
            if (y < h - 1 && parent[idx + w] >= 0) union(idx, idx + w)
          }
          x++
        }
        y++
      }
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [w, h] of [[12, 9], [1, 1], [2, 2], [0, 3], [5, 4.5]]) {
      const got = m.resize(w, h), want = js.resize(w, h)
      m.frame(0.6); js.frame(0.6)
      is(Array.from(got), Array.from(want), `${w}×${h} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const body = planned(src, 'frame')
  // the aliases the guards capture (`n === (n$ = n | 0)`): the sweep's dimensions, never a find's root
  const captures = countNodes(body, n => n[0] === '===' && Array.isArray(n[2]) && n[2][0] === '=' && typeof n[2][1] === 'string' && isWordOf(n[2][2], e => typeof e === 'string'))
  ok(captures <= 4, `the find loops take no capture of their own (${captures} captures)`)
})

test('integral loops: a rounded coordinate under a range test is an integer there', () => {
  // swarm's hairline: `ix = Math.floor(fx)` is an integer or not finite; inside
  // `if (ix >= 0 && ix < W && iy >= 0 && iy < H)` it is finite within the test's
  // hull, so `ink[iy * W + ix]` reads its word.
  const src = `let W = 0, H = 0, ink
    export let resize = (w, h) => { W = w; H = h; ink = new Float64Array(w * h); return ink }
    let dep = (ix, iy, a) => { if (ix >= 0 && ix < W && iy >= 0 && iy < H) ink[iy * W + ix] += a }
    export let trace = (ax, ay, bx, by) => {
      let dx = bx - ax, dy = by - ay
      let n = (Math.sqrt(dx * dx + dy * dy) * 2 | 0) + 1, k = 0
      while (k < n) {
        let fx = ax + dx * k / n - 0.5, fy = ay + dy * k / n - 0.5
        let ix = Math.floor(fx), iy = Math.floor(fy), ux = fx - ix, uy = fy - iy
        dep(ix, iy, (1 - ux) * (1 - uy)); dep(ix + 1, iy, ux * (1 - uy)); dep(ix, iy + 1, (1 - ux) * uy); dep(ix + 1, iy + 1, ux * uy)
        k++
      }
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [w, h, line] of [[20, 14, [1.2, 2.5, 17.8, 11.1]], [3, 3, [-2, -1, 5, 6]], [0, 2, [0, 0, 1, 1]], [7.5, 5, [0.5, 0.5, 6, 4]], [4, 4, [NaN, 1, 2, 2]]]) {
      const got = m.resize(w, h), want = js.resize(w, h)
      m.trace(...line); js.trace(...line)
      is(Array.from(got).map(v => Number.isNaN(v) ? 'NaN' : v), Array.from(want).map(v => Number.isNaN(v) ? 'NaN' : v), `${w}×${h} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const body = planned(src, 'trace')
  ok(countNodes(body, n => isWordOf(n, e => Array.isArray(e) && e[0] === '+' && Array.isArray(e[1]) && e[1][0] === '()' && e[1][1] === 'math.imul')) >= 1, 'the deposit indexes by a word of an imul of words')
})

test('integral loops: a hull end at the word\'s extreme opens, so no guard that cannot hold', () => {
  // sandpile's relax: `c = queue[qHead]` is any int32, so `nb = c - gw` fits one
  // signed word only for a width at most zero. A test of that end
  // (`-2147483648 - gw >= -2147483648`) fails on every run and leaves the loop
  // as written, cold. The copy takes the element as its word and leaves the
  // difference a Number.
  const src = `let W = 0, grid, queue, QN = 0
    export let resize = (w) => { W = w; grid = new Int32Array(w * w); queue = new Int32Array(w * w); QN = w * w; let i = 0; while (i < QN) { queue[i] = i; i++ } return grid }
    export let relax = (n) => {
      let done = 0, qHead = 0, gw = W
      while (done < n) {
        let c = queue[qHead]
        qHead++; if (qHead >= QN) qHead = 0
        let gx = c % gw
        let nb = c - gw
        if (gx > 0 && nb >= 0) grid[nb] += 1
        done++
      }
      return qHead
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [w, n] of [[4, 30], [7, 100], [1, 5], [3, 0], [2.5, 9]]) {
      const got = m.resize(w), want = js.resize(w)
      is(m.relax(n), js.relax(n), `relax ${w} ${n} at ${optimize}`)
      is(Array.from(got), Array.from(want), `grid ${w} ${n} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const body = planned(src, 'relax')
  ok(countNodes(body, n => isWordOf(n, e => Array.isArray(e) && e[0] === '[]')) >= 1, 'the popped cell is a word')
  is(countNodes(body, n => isWordOf(n, e => Array.isArray(e) && e[0] === '-')), 0, 'the difference of an int32 element and a width is no word')
  is(countNodes(body, n => Array.isArray(n) && (n[0] === '-' || n[0] === '+') && Array.isArray(n[1]) && n[1][0] == null && Math.abs(n[1][1]) >= 2147483647), 0, 'no test at the extreme')
})

test('integral loops: a module binding reset before every step of it is the loop\'s scratch, not a cursor', () => {
  // maze's generation: the loop steps `qt` only after `qt = 0` (the solve's
  // start, inlined), on the round that ends generation; `qt` is undefined until
  // then. A cursor's guard holds its entry value to an int32, which undefined
  // fails on every generation frame, leaving the loop as written: cold. With
  // nothing of its entry value stepped, `qt` is no cursor: the copy writes it
  // as written, and its entry value stays what it was.
  const src = `let GX = 0, stack, sp = 0, q, qt, vis
    export let resize = (n) => { GX = n; stack = new Int32Array(n + 1); vis = new Int32Array(n + 1); q = new Int32Array(n + 1); sp = 1; stack[0] = 0; return vis }
    export let step = (rounds) => {
      let k = 0
      while (k < rounds) {
        if (sp === 0) { qt = 0; q[qt] = 7; qt++; break }
        let c = stack[sp - 1]
        if (vis[c] === 0 && c + 1 < GX) { vis[c] = 1; stack[sp] = c + 1; sp++ } else sp--
        k++
      }
      return k
    }
    export let tail = () => typeof qt === 'number' ? qt : -1`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [n, rounds] of [[5, 3], [5, 4], [5, 100], [1, 2], [8, 1], [4, 7.5]]) {
      const got = m.resize(n), want = js.resize(n)
      is([m.step(rounds), m.tail(), Array.from(got)], [js.step(rounds), js.tail(), Array.from(want)], `${n} ${rounds} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const body = planned(src, 'step')
  ok(countNodes(body, n => Array.isArray(n) && n[0] === 'while' && n.cold === true) >= 1, 'the loop has a copy')
  is(countNodes(body, n => Array.isArray(n) && n[0] === 'typeof' && n[1] === 'qt'), 0, 'no test of what the loop enters with')
})

test('integral loops: a float clamped then truncated indexes by a word, its drift held to a Number', () => {
  // dithering's sweep: `ysf = y + offY` clamped into [0, H - 1], `yi = ysf | 0`,
  // `yi1 = yi + 1` clamped again: hulls the walk holds, so `sb[yi * W + x]`
  // and `sb[yi1 * W + x]` are words of the copy. `offY = lpy / adx` is a
  // fraction: the guard holds it to a Number, never to an int32 (a test that
  // would fail on every run).
  const src = `let W = 0, H = 0, sb, out
    export let resize = (w, h) => { W = w; H = h; sb = new Float64Array(w * h); out = new Float64Array(w * h); let i = 0; while (i < w * h) { sb[i] = i * 0.5; i++ } return out }
    export let sweep = (lpy, adx, col) => {
      let offY = lpy / adx, x = col | 0
      let y = 0
      while (y < H) {
        let ysf = y + offY
        if (ysf < 0.0) ysf = 0.0
        if (ysf > H - 1) ysf = H - 1
        let yi = ysf | 0
        let yi1 = yi + 1; if (yi1 > H - 1) yi1 = H - 1
        let yf = ysf - yi
        out[y * W + x] = sb[yi * W + x] * (1.0 - yf) + sb[yi1 * W + x] * yf
        y++
      }
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [w, h, lpy, adx, col] of [[5, 6, 1.5, 2, 2], [5, 6, -2.5, 1, 0], [3, 3, 100, 1, 1], [4, 4, -100, 3, 3], [4, 2.5, 0.5, 2, 1], [2, 2, NaN, 1, 0], [3, 3, 1, 0, 1]]) {
      const got = m.resize(w, h), want = js.resize(w, h)
      m.sweep(lpy, adx, col); js.sweep(lpy, adx, col)
      is(Array.from(got).map(v => Number.isNaN(v) ? 'NaN' : v), Array.from(want).map(v => Number.isNaN(v) ? 'NaN' : v), `${w}×${h} ${lpy}/${adx} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const body = planned(src, 'sweep')
  ok(countNodes(body, n => isWordOf(n, e => Array.isArray(e) && e[0] === '+' && Array.isArray(e[1]) && e[1][0] === '()' && e[1][1] === 'math.imul')) >= 3, 'the three indexes are words')
  is(countNodes(body, n => Array.isArray(n) && n[0] === '|' && typeof n[1] === 'string' && (n[1] === 'offY' || n[1].startsWith('offY' + T))), 0, 'the drift is held to no int32')
})

test('integral loops: a parameter some call passes a fraction is held to no int32', () => {
  // dwa's rings: `(c + a * 255 + 0.5) | 0` with a = 0.95. An int32 test of `a`
  // fails on every such call and leaves the loop as written, cold.
  const src = `let px
    export let resize = (n) => { px = new Int32Array(n); return px }
    let blend = (n, a) => { let i = 0; while (i < n) { px[i] = (px[i] + a * 255 + 0.5) | 0; i++ } }
    export let frame = (n, k) => { blend(n, 0.35); blend(n, k) }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [n, k] of [[8, 1], [8, 0.5], [3, -2.25], [0, 1], [5.5, 2]]) {
      const got = m.resize(n), want = js.resize(n)
      m.frame(n, k); js.frame(n, k)
      is(Array.from(got), Array.from(want), `${n} ${k} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  for (const name of ['blend', 'frame']) {
    const body = planned(src, name)
    if (!body) continue
    is(countNodes(body, n => Array.isArray(n) && n[0] === '|' && typeof n[1] === 'string' && (n[1] === 'a' || n[1].startsWith('a' + T))), 0, `${name}: the blend factor is held to no int32`)
  }
})

test('integral loops: an inner copy\'s hull tests lift to the outer guard at the counter\'s ends, one version of the nest', () => {
  // error diffusion: the row's word `idx = py * W + qx` and `r = idx + W` have
  // hulls over the outer counter `py`. Tested per row inside the outer copy,
  // the nest is a loop, a test and a loop, which no later pass reads as a nest;
  // tested at py's ends in the outer guard, the copy holds the inner copy alone.
  const src = `let W = 0, H = 0, gray, px
    export let resize = (w, h) => { W = w; H = h; gray = new Float64Array(w * h); px = new Uint32Array(w * h); let i = 0; while (i < w * h) { gray[i] = (i % 7) / 7; i++ } return px }
    export let frame = () => {
      let py = 0
      while (py < H) {
        let qx = 0
        while (qx < W) {
          let idx = py * W + qx
          let old = gray[idx], on = old >= 0.5 ? 1 : 0, e = (old - on) / 48
          if (qx + 1 < W) gray[idx + 1] = gray[idx + 1] + e * 7
          if (py + 1 < H) {
            let r = idx + W
            if (qx - 1 >= 0) gray[r - 1] = gray[r - 1] + e * 3
            gray[r] = gray[r] + e * 5
          }
          px[idx] = on ? 255 : 0
          qx++
        }
        py++
      }
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [w, h] of [[6, 5], [1, 1], [0, 3], [4.5, 2], [3, 0]]) {
      const got = m.resize(w, h), want = js.resize(w, h)
      m.frame(); js.frame()
      is(Array.from(got), Array.from(want), `${w}×${h} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const body = planned(src, 'frame')
  const hasCold = (n) => Array.isArray(n) && (n.cold === true || n.some(hasCold))
  is(countNodes(body, n => Array.isArray(n) && n[0] === 'if' && n.length === 4 && hasCold(n[3])), 1, 'one guard for the nest')
})

test('integral loops: a walk over links is a word of the copy, a missed link ending it', () => {
  // fireflies' neighbour gather: `let j = head[c]; while (j >= 0) { … j = next[j] }`
  // over int32 arrays. Every write of `j` is an element, an integer or a miss:
  // undefined, which fails `j >= 0` and ends the walk. The copy reads a missed
  // link as -1, the same end, and walks by an i32: no conversion per link.
  const src = `let N = 0, head, next, val, out
    export let resize = (n) => {
      N = n; head = new Int32Array(4); next = new Int32Array(n); val = new Float64Array(n); out = new Float64Array(4)
      let i = 0
      while (i < 4) { head[i] = -1; i++ }
      i = 0
      while (i < n) { let c = i % 4; next[i] = head[c]; head[c] = i; val[i] = i * 0.5; i++ }
      return out
    }
    export let sum = (c, k) => {
      let j = head[c], s = 0.0, n = 0
      while (j >= 0) {
        if (j !== k) { s += val[j]; n++ }
        j = next[j]
      }
      out[c] = n > 0 ? s / n : 0.0
      return n
    }
    export let poke = (i, v) => { next[i] = v }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [n, c, k] of [[10, 0, 4], [10, 3, 100], [7, 2, 2], [1, 0, 0], [0, 1, 0], [5.5, 1, 1]]) {
      const got = m.resize(n), want = js.resize(n)
      is(m.sum(c, k), js.sum(c, k), `sum ${n} ${c} ${k} at ${optimize}`)
      is(Array.from(got), Array.from(want), `out ${n} ${c} ${k} at ${optimize}`)
    }
    // a link past the array: a miss ends the walk as written
    const got = m.resize(6), want = js.resize(6)
    m.poke(1, 99); js.poke(1, 99)
    is([m.sum(1, 7), Array.from(got)], [js.sum(1, 7), Array.from(want)], `missed link at ${optimize}`)
    m.poke(5, 2147483647); js.poke(5, 2147483647)
    is(m.sum(1, 7), js.sum(1, 7), `far link at ${optimize}`)
    is(m.sum(2.5, 0), js.sum(2.5, 0), `a fractional head at ${optimize}`)
  }
  if (belowOpt(2)) return
  const body = planned(src, 'sum')
  ok(countNodes(body, n => Array.isArray(n) && n[0] === '?:' && Array.isArray(n[3]) && n[3][0] == null && n[3][1] === -1) >= 1, 'the copy reads a missed link as -1')
  ok(countNodes(body, n => Array.isArray(n) && n[0] === 'while' && n.cold === true) >= 1, 'the walk as written is the other arm')
})

test('integral loops: a nest under inclusive bounds lifts its inner product tests to the outer guard', () => {
  // the 3×3 cell search: `while (cy <= gy + 1) { while (cx <= gx + 1) { let cell = cy * cols + cx … } }`.
  // The cell's product is tested at cy's ends (the bound itself, under `<=`)
  // in the outer guard: nothing is tested between the loops, one nest for every
  // later pass; the walk over links keeps its own test of its entry.
  const src = `let cols = 0, rows = 0, head, next, seen, px, py, out
    export let resize = (c, r, n) => {
      cols = c; rows = r; head = new Int32Array(c * r); seen = new Int32Array(c * r); next = new Int32Array(n); px = new Float64Array(n); py = new Float64Array(n); out = new Float64Array(n)
      let i = 0
      while (i < c * r) { head[i] = -1; i++ }
      i = 0
      while (i < n) { px[i] = (i * 7) % c; py[i] = (i * 3) % r; let cell = py[i] * c + px[i]; next[i] = head[cell]; head[cell] = i; i++ }
      return out
    }
    export let gather = (n) => {
      let i = 0
      while (i < n) {
        let gx = px[i] | 0, gy = py[i] | 0
        if (gx < 0) gx = 0; else if (gx >= cols) gx = cols - 1
        if (gy < 0) gy = 0; else if (gy >= rows) gy = rows - 1
        let s = 0.0, cy = gy - 1
        while (cy <= gy + 1) {
          if (cy >= 0 && cy < rows) {
            let cx = gx - 1
            while (cx <= gx + 1) {
              if (cx >= 0 && cx < cols) {
                let cell = cy * cols + cx
                seen[cell] = seen[cell] + 1
                let j = head[cell]
                while (j >= 0) { if (j !== i) s += px[j] - px[i]; j = next[j] }
              }
              cx++
            }
          }
          cy++
        }
        out[i] = s
        i++
      }
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [c, r, n] of [[4, 3, 20], [1, 1, 5], [5, 5, 0], [3, 2, 7.5]]) {
      const got = m.resize(c, r, n), want = js.resize(c, r, n)
      m.gather(n); js.gather(n)
      is(Array.from(got), Array.from(want), `${c}×${r} ${n} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const body = planned(src, 'gather')
  const hasCold = (n) => Array.isArray(n) && (n.cold === true || n.some(hasCold))
  const guards = []
  walkAst(body, { enter: n => { if (Array.isArray(n) && n[0] === 'if' && n.length === 4 && hasCold(n[3])) guards.push(n) } })
  // the cy loop's guard holds the product tests; no guard sits inside its copy but the walk's own
  const product = (g) => countNodes(g[1], n => Array.isArray(n) && n[0] === '*') >= 1
  const outer = guards.find(g => product(g) && countNodes(g[1], n => Array.isArray(n) && n[0] === '()' && n[1] === 'math.min') >= 1)
  ok(outer, 'the outer guard tests the cell at the counter\'s ends')
  is(guards.filter(g => product(g) && outer[2].includes(g) === false && countNodes(outer, n => n === g) > 0 && g !== outer).length, 0, 'no product test between the loops')
})
