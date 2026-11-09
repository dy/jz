// A loop indexing by numbers the program cannot prove integers runs, when
// they are int32s, as a copy over names written from `x | 0`
// (plan/integral-loops.js): the same values, so the same results for every
// number, integral or not.
import test from 'tst'
import parseWat from 'watr/parse'
import { is, ok, throws } from 'tst/assert.js'
import { belowOpt, levels, onWasi } from './_matrix.js'
import { oracle, wat, funcWat, run, compileInProcess, jz } from './util.js'
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
  // the filter loop: five coefficient products (the coefficients read before
  // it, nothing in it writing them), a sample in and out, no string test
  ok(loops.some(l => (l.match(/f64\.mul/g) || []).length >= 5 && /f32\.store/.test(l) && !/call \$__(is_str_key|add_slow|to_num)/.test(l)), 'a copy of the filter loop adds Numbers')
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

// A copy declares the words it names anew inside its own block, so no guard of an
// enclosing loop reads one. IMA ADPCM's block loop around its word and channel
// loops (decode-wav's `decodeImaWav`, its channels made by a loop) took the cursor
// word of the copy inside into its own guard, a name no scope there declares: the
// module did not compile.
test('integral loops: a guard reads no word a copy inside it declared', () => {
  const src = `const RAW = new Uint8Array(2048)
    for (let i = 0; i < 2048; i++) RAW[i] = (i * 53 + 7) & 255
    export let f = (nCh, ba, spb) => {
      let nBlocks = Math.floor(RAW.length / ba), ch = []
      for (let c = 0; c < nCh; c++) ch.push(new Float32Array(nBlocks * spb))
      for (let blk = 0; blk < nBlocks; blk++) {
        let base = blk * ba, outBase = blk * spb, cnt = new Int32Array(nCh).fill(1)
        let p = base + nCh * 4, nWords = Math.ceil((spb - 1) / 8)
        for (let w = 0; w < nWords; w++)
          for (let c = 0; c < nCh; c++, p += 4) {
            let out = ch[c]
            for (let n = 0; n < 4; n++) if (cnt[c] < spb) out[outBase + cnt[c]++] = RAW[p + n]
          }
      }
      let h = 0
      for (let c = 0; c < nCh; c++) for (let i = 0; i < ch[c].length; i++) h = (Math.imul(h, 31) + ch[c][i]) | 0
      return h
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    for (const a of [[2, 200, 100], [3, 96, 40], [1, 256, 505], [2, 64.5, 113]]) is(m.f(...a), js.f(...a), `f(${a}) at ${optimize}`)
  }
})

// A bound that closures only read holds one value through a loop that does not
// write it: the frame count each channel's array is made of (`Array.from(…, () =>
// new Float32Array(frames))`, decode-wav's 24-bit loop) bounds a copy whose counter
// and cursor are words, as a bound no closure mentions does.
test('integral loops: a bound a closure only reads bounds a copy of words', () => {
  const src = `const RAW = new Uint8Array(600)
    for (let i = 0; i < 600; i++) RAW[i] = (i * 37 + 11) & 255
    export let f = (nCh, bs) => {
      let frames = Math.floor(RAW.length / bs)
      let ch = Array.from({ length: nCh }, () => new Float32Array(frames))
      for (let c = 0; c < nCh; c++) { let x = ch[c], k = c * 3; for (let i = 0; i < frames; i++) { x[i] = (RAW[k] | RAW[k + 1] << 8 | RAW[k + 2] << 16) << 8 >> 8; k += 6 } }
      let h = 0
      for (let c = 0; c < nCh; c++) for (let i = 0; i < frames; i++) h = (h * 31 + ch[c][i]) | 0
      return h
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    for (const a of [[2, 6], [2, 6.5], [1, 3], [3, 9], [2, 1e9], [2, 7]]) is(m.f(...a), js.f(...a), `f(${a}) at ${optimize}`)
  }
  if (belowOpt(2)) return
  const text = wat(src, { optimize: 2 })
  const loops = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    loops.push(text.slice(at, end))
  }
  const inner = loops.filter(l => !/\(loop/.test(l.slice(5)) && /f32\.store/.test(l) && /load8_u/.test(l))
  ok(inner.some(l => !/trunc_sat|i64\.|f64\.add/.test(l)), 'a copy of the sample loop counts and indexes in words')
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
// The Number sums, differences and products inside the loops of a module's text
// (a guard's `1 / x > 0`, a -0 test, divides). A loop the typed-bounds versioning
// split is read in its fast arm (`label.fN`): the checked twin keeps the Number
// path of a read past the end.
const loopFloats = (text) => {
  const loops = []
  const walk = (n) => { if (!Array.isArray(n)) return; if (n[0] === 'loop') { loops.push(n); return } for (const c of n) walk(c) }
  walk(parseWat(text))
  const labels = new Set(loops.map(n => n[1]))
  let k = 0
  for (const n of loops) {
    if (!/\.f\d+$/.test(n[1]) && [...labels].some(l => l.startsWith(n[1] + '.f'))) continue
    k += (JSON.stringify(n).match(/"f64\.(?:add|sub|mul)"/g) || []).length
  }
  return k
}
// the Number arithmetic in the innermost loops of a module's text
const leafFloats = (text) => {
  let k = 0
  const inner = (n) => Array.isArray(n) && (n[0] === 'loop' || n.some(inner))
  const walk = (n) => { if (!Array.isArray(n)) return; if (n[0] === 'loop' && !n.some(inner)) { k += (JSON.stringify(n).match(/"f64\.(?:add|sub|mul)"/g) || []).length; return } for (const c of n) walk(c) }
  walk(parseWat(text))
  return k
}
// the wide (i64) arithmetic and comparisons in the innermost loops of a module's text
// (a loop around a version tests the version's guard, in i64 where the budget's ends may pass the word)
const loopWide = (text) => {
  let k = 0
  const inner = (n) => Array.isArray(n) && (n[0] === 'loop' || n.some(inner))
  const walk = (n) => { if (!Array.isArray(n)) return; if (n[0] === 'loop' && !n.some(inner)) { k += (JSON.stringify(n).match(/"i64\.(?:add|sub|mul|lt_s|gt_s|le_s|ge_s)"/g) || []).length; return } for (const c of n) walk(c) }
  walk(parseWat(text))
  return k
}
const planned = (src, name) => { compileInProcess(src, { optimize: 'speed' }); return ctx.funcs.list.find(f => f.name === name)?.body }
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

test('integral loops: optimize.coldTrap throws the version\'s number where the loop as written would run', () => {
  // A guard failing on the input a copy was meant for runs the loop as written,
  // cold, with nothing to show for it but time. The diagnostic replaces that arm
  // with a throw of the version's number: a gallery page or a kernel driven
  // under it names the guard that fails instead of hiding it.
  const src = `let W = 0, grid, queue, QN = 0
    export let resize = (w) => { W = w; grid = new Int32Array(w * w); queue = new Int32Array(w * w); QN = w * w; let i = 0; while (i < QN) { queue[i] = i; i++ } return grid }
    export let relax = (n) => {
      let done = 0, qHead = 0, gw = W
      while (done < n) {
        let c = queue[qHead]
        qHead++; if (qHead >= QN) qHead = 0
        let gx = c % gw
        if (gx > 0) grid[c] += 1
        done++
      }
      return qHead
    }`
  if (belowOpt(2)) return
  // (the cursor's budget: a count of pops within the queue's length runs the copy; past it, the ring as written)
  const m = jz(src, { optimize: { level: 3, coldTrap: true } }).exports, js = oracle(src)
  m.resize(4); js.resize(4)
  is(m.relax(9), js.relax(9), 'pops within the queue run the copy')
  throws(() => m.relax(40), 'pops past the queue fail the guard, and the trap names it')
  const plain = jz(src, { optimize: { level: 3 } }).exports
  plain.resize(4)
  is(plain.relax(40), js.relax(40), 'without the diagnostic the ring runs as written')
})

test('integral loops: a divisor of fractions alone is no name of the guard', () => {
  // Binning a float by a width read from a float array (`(data[i] / w) | 0`):
  // the quotient of a fraction is a float's whatever the divisor, so holding
  // `w` to an int32 buys no word's division, and the test fails for every
  // fractional width, where the loop runs. Fireflies' neighbour grid divides
  // a position by a fractional cell so: its copy never ran.
  const src = `let N = 0, st = new Float64Array(1), data, hist = new Int32Array(16)
    export let setup = (n, w) => {
      N = n; st[0] = w; data = new Float64Array(n)
      let i = 0
      while (i < n) { data[i] = (i * 7.25) % 40; i++ }
      i = 0
      while (i < 16) { hist[i] = 0; i++ }
    }
    export let bin = () => {
      let w = st[0], i = 0
      while (i < N) {
        let b = (data[i] / w) | 0
        if (b >= 0 && b < 16) hist[b] = hist[b] + 1
        i++
      }
      let h = 0
      i = 0
      while (i < 16) { h = h * 31 + hist[i] | 0; i++ }
      return h
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [n, w] of [[50, 2.5], [50, 4], [9, 0.75], [0, 3], [20, -2], [7.5, 2.5], [30, NaN], [30, Infinity]]) {
      m.setup(n, w); js.setup(n, w)
      is(m.bin(), js.bin(), `${n} by ${w} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const m = jz(src, { optimize: { level: 3, coldTrap: true } }).exports
  m.setup(50, 2.5); js.setup(50, 2.5)
  is(m.bin(), js.bin(), 'a fractional width runs the copy')
})

test('integral loops: an end moved by a literal past the type\'s extreme is no end', () => {
  // `g = (x / cell) | 0` is any int32; `if (g >= cols) g = cols - 1` bounds it
  // above alone, its floor `min(cols - 1, -2^31)`, and `c = g - 1` moves that
  // floor past -2^31: a test of it holds for no value and left the loop as
  // written, cold, on every run. The hull of `c` is none instead.
  const src = `let count = 0, cols = 1, st, pos, head, next, out
    export let setup = (n, cell) => {
      count = n; st = new Float64Array(1); st[0] = cell
      pos = new Float64Array(n); next = new Int32Array(n); out = new Float64Array(n)
      cols = Math.ceil(100 / cell) | 0; head = new Int32Array(cols)
      let c = 0
      while (c < cols) { head[c] = -1; c++ }
      let i = 0
      while (i < n) { pos[i] = (i * 37.25) % 100; let g = (pos[i] / cell) | 0; if (g >= cols) g = cols - 1; next[i] = head[g]; head[g] = i; i++ }
      return out
    }
    export let near = () => {
      let cell = st[0], i = 0
      while (i < count) {
        let xi = pos[i]
        let g = (xi / cell) | 0
        if (g >= cols) g = cols - 1
        let s = 0.0, c = g - 1
        while (c <= g + 1) {
          if (c >= 0 && c < cols) {
            let j = head[c]
            while (j >= 0) { if (j !== i) s += pos[j] - xi; j = next[j] }
          }
          c++
        }
        out[i] = s
        i++
      }
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [n, cell] of [[50, 7.5], [50, 10], [3, 40], [0, 5]]) {
      const got = m.setup(n, cell), want = js.setup(n, cell)
      m.near(); js.near()
      is(Array.from(got), Array.from(want), `${n} by ${cell} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const m = jz(src, { optimize: { level: 3, coldTrap: true } }).exports
  const got = m.setup(50, 7.5), want = js.setup(50, 7.5)
  m.near(); js.near()
  is(Array.from(got), Array.from(want), 'the copy runs')
})

test('integral loops: a self-call\'s argument reading its own parameter ends the fraction check', () => {
  // `walk(n, x)` calling `walk(n - 1, x * 0.5)`: whether `x` is a fraction asks its
  // call sites, one of which passes an expression of `x` itself; the check once
  // recursed without end (stdlib-special in the benchmark corpus). An argument is
  // read in its caller's scope: a local there is unknown, a fraction visible there counts.
  const src = `let acc = new Float64Array(8)
    let walk = (n, x) => { let i = 0; while (i < n) { acc[i] += x; i++ } if (n > 1) walk(n - 1, x * 0.5) }
    export let run = (n) => { walk(n, 1.0); return acc[0] }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    is(m.run(4), js.run(4), `at ${optimize}`)
  }
})

test('integral loops: a stream position entering from an element steps inside an index, its coordinates by bytes and 16-bit words', () => {
  // glyfparse's outline decode: `r` enters each glyph from an Int32Array (no
  // literal, no hull), steps inside `stream[r++]` and by `r += 2`; `x` steps by
  // a byte either way or by a 16-bit word. The copy holds both as words under
  // the budget of the glyph's point count; a stream too short, an offset too
  // far, a point count of zero run the loop as written.
  const src = `let NG = 0, stream, off, pts
    export let setup = (ng, len) => {
      NG = ng; stream = new Uint8Array(len); off = new Int32Array(ng); pts = new Int32Array(ng)
      for (let i = 0; i < len; i++) stream[i] = (i * 37 + 11) & 255
      for (let g = 0; g < ng; g++) { off[g] = g * 9; pts[g] = 3 + (g & 3) }
    }
    export let poke = (g, o, n) => { off[g] = o; pts[g] = n }
    export let scan = () => {
      let h = 0
      for (let g = 0; g < NG; g++) {
        let r = off[g]
        const np = pts[g]
        let x = 0
        for (let i = 0; i < np; i++) {
          const f = stream[r++]
          if (f & 2) { const d = stream[r++]; x = (f & 16) ? x + d : x - d }
          else if (!(f & 16)) { x = x + (((stream[r] << 8) | stream[r + 1]) << 16 >> 16); r += 2 }
          h = (h ^ x) | 0
        }
      }
      return h
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [ng, len] of [[8, 200], [8, 40], [1, 3], [0, 10], [4, 30]]) {
      m.setup(ng, len); js.setup(ng, len)
      is(m.scan(), js.scan(), `${ng} glyphs over ${len} bytes at ${optimize}`)
    }
    m.setup(4, 200); js.setup(4, 200)
    for (const [g, o, n] of [[1, 2147483640, 3], [2, -5, 2], [0, 190, 6], [3, 0, 0], [3, 2.5, 2]]) {
      m.poke(g, o, n); js.poke(g, o, n)
      is(m.scan(), js.scan(), `glyph ${g} at ${o} with ${n} points at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const body = planned(src, 'scan')
  const word = (n) => Array.isArray(n) && n[0] === '=' && typeof n[1] === 'string' && Array.isArray(n[2]) && n[2][0] === '|' && Array.isArray(n[2][2]) && n[2][2][1] === 0
  ok(countNodes(body, n => word(n) && Array.isArray(n[2][1]) && n[2][1][0] === '+' && n[2][1][1] === n[1] && Array.isArray(n[2][1][2]) && n[2][1][2][1] === 1) >= 1, 'the position steps by its word after the statement that read it')
  ok(countNodes(body, n => word(n) && Array.isArray(n[2][1]) && n[2][1][0] === '?:') >= 1, 'the coordinate steps by its word either way')
  ok(countNodes(body, n => Array.isArray(n) && (n[0] === 'for' || n[0] === 'while')) >= 3, 'the inner loop has its copy and its loop as written')
})

test('integral loops: a version placed as the one statement of a block stays a block', () => {
  // A nest whose inner loop is the body of the outer one (prepare keeps it a
  // block holding the loop): the inner version's arms go into that slot as the
  // block's statements, not a block in a block, which reads as an object.
  const src = `const N = 300
    export let main = (limit) => {
      const src = new Uint8Array(N)
      for (let i = 0; i < N; i++) src[i] = (i * 7) & 255
      let acc = 0, ip = 4
      while (ip < limit) {
        const start = ip - 3
        for (let j = start; j <= ip - 1; j++) {
          for (let len = 0; len < 8; len++) acc += src[j + len]
        }
        ip += 5
      }
      return acc
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const limit of [5, 100, 150, 294, 295, 310]) ok(Object.is(m.main(limit), js.main(limit)), `${limit} at ${optimize}: ${m.main(limit)} vs ${js.main(limit)}`)
  }
})

test('integral loops: an index shifted to the word\'s extreme is no element of the proof, so no guard that cannot hold', () => {
  // A box blur reads `src[(row + xi) << 2]`: the shifted index spans every
  // int32, so a test of its ends against the length (`-2147483648 >= 0`) fails
  // on every run and left the nest as written, cold. The element stays outside
  // the hull proof; the guard holds the dimensions and the copy runs.
  const src = `export let hblur = (src, dst, w, h, r) => {
      const win = 2 * r + 1
      for (let y = 0; y < h; y++) {
        const row = y * w
        for (let x = 0; x < w; x++) {
          let sr = 0, sg = 0
          for (let k = -r; k <= r; k++) {
            let xi = x + k
            if (xi < 0) xi = 0
            else if (xi >= w) xi = w - 1
            const p = (row + xi) << 2
            sr += src[p]; sg += src[p + 1]
          }
          const o = (row + x) << 2
          dst[o] = (sr / win) | 0
          dst[o + 1] = (sg / win) | 0
        }
      }
      return dst[5]
    }`
  const js = oracle(src)
  const image = (w, h) => { const a = new Uint8Array(w * h * 4); for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 255; return a }
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [w, h, r] of [[8, 4, 1], [16, 3, 4], [5, 5, 0]]) {
      const a = image(w, h), b = new Uint8Array(a.length), c = image(w, h), d = new Uint8Array(c.length)
      is(m.hblur(a, b, w, h, r), js.hblur(c, d, w, h, r), `${w}×${h} r=${r} at ${optimize}`)
      is(Array.from(b), Array.from(d), `image ${w}×${h} r=${r} at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  const body = planned(src, 'hblur')
  is(countNodes(body, n => Array.isArray(n) && n[0] === '>=' && Array.isArray(n[1]) && n[1][0] == null && n[1][1] < 0), 0, 'no test of a negative literal end')
  // (the guard holds for integer dimensions: the copy runs, the trap never fires)
  const m = jz(src, { optimize: { level: 3, coldTrap: true } }).exports
  const a = image(8, 4), b = new Uint8Array(a.length)
  is(m.hblur(a, b, 8, 4, 1), js.hblur(image(8, 4), new Uint8Array(a.length), 8, 4, 1), 'the copy runs for integer dimensions')
})

test('integral loops: a loop over integer parameters and a peel\'s integer segment ends runs as written', () => {
  // The dimensions enter from immutable integer module bindings (`hblur(img, tmp,
  // W, H, R)` under `const W = 512`), the segment ends are the least and most of
  // them: every bound an integer by its writes. The loop as written runs over
  // integers already; a copy would guard what the emitter proves, and leave the
  // loop as written cold beside it. With no version, the channel lift takes the
  // interior segment.
  const src = `const W = 64, H = 8, R = 2
    const hblur = (src, dst, w, h, r) => {
      const win = 2 * r + 1
      for (let y = 0; y < h; y++) {
        const row = y * w
        for (let x = 0; x < w; x++) {
          let sr = 0, sg = 0, sb = 0, sa = 0
          for (let k = -r; k <= r; k++) {
            let xi = x + k
            if (xi < 0) xi = 0
            else if (xi >= w) xi = w - 1
            const p = (row + xi) << 2
            sr += src[p]; sg += src[p + 1]; sb += src[p + 2]; sa += src[p + 3]
          }
          const o = (row + x) << 2
          dst[o] = (sr / win) | 0
          dst[o + 1] = (sg / win) | 0
          dst[o + 2] = (sb / win) | 0
          dst[o + 3] = (sa / win) | 0
        }
      }
    }
    export let main = () => {
      const img = new Uint8Array(W * H * 4), out = new Uint8Array(W * H * 4)
      for (let i = 0; i < img.length; i++) img[i] = (i * 37 + 11) & 255
      hblur(img, out, W, H, R)
      let sum = 0
      for (let i = 0; i < out.length; i++) sum = (sum * 31 + out[i]) | 0
      return sum
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) is(jz(src, { optimize }).exports.main(), js.main(), `at ${optimize}`)
  if (belowOpt(2)) return
  const body = planned(src, 'hblur')
  // (the segments ending at the least of the radius and the width, and at the width, run as written;
  // the interior's end is a difference of them, which the emitter may widen: that segment takes a copy)
  const counterOf = (n) => n[0] === 'for' && Array.isArray(n[1]) && n[1][0] === 'let' && Array.isArray(n[1][1]) ? n[1][1][1] : null
  is(countNodes(body, n => Array.isArray(n) && counterOf(n) === 'y' && n.cold === true), 0, 'the nest over the dimensions runs as written')
  is(countNodes(body, n => Array.isArray(n) && n[0] === 'while' && n.cold === true), 1, 'one segment, under a difference, takes a copy')
  // (the kernel is spliced into its one caller: the lift's loop is in the module)
  ok(/__bmpx\d/.test(wat(src, { optimize: 'speed' })), 'the channel lift takes the interior segment')
})

test('integral loops: a scan whose counter steps inside an index and in a nested run over a byte takes a copy of integer words', () => {
  // A glyph parser's flag scan: `flags[p++] = f`, and a repeat count read from the
  // stream drives an inner loop stepping `p` again. The counter's advance over one
  // round is bounded by the byte (at most 256), so the copy runs under a guard
  // holding the bound below the word's top by that much; the counter is a word
  // stepped as wraps, and the stream cursor a word with its budget. The loop as
  // written, where `p` is a Number, runs only for a count past that bound.
  const src = `const parse = (stream, counts, flags) => {
      let h = 0
      for (let g = 0; g < counts.length; g++) {
        const np = counts[g]
        let r = g << 6, p = 0
        while (p < np) {
          const f = stream[r++]
          flags[p++] = f
          if (f & 8) { let rep = stream[r++]; while (rep > 0) { flags[p++] = f; rep-- } }
        }
        for (let i = 0; i < np; i++) h = Math.imul(h ^ flags[i], 16777619)
      }
      return h
    }
    export let main = (n) => {
      const stream = new Uint8Array(4096), counts = new Int32Array(n), flags = new Uint8Array(512)
      for (let i = 0; i < stream.length; i++) stream[i] = (i * 37 + 11) & 255
      for (let g = 0; g < n; g++) counts[g] = (g * 13) % 300
      return parse(stream, counts, flags)
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const n of [0, 1, 7, 40, 64]) is(m.main(n), js.main(n), `${n} at ${optimize}`)
  }
  if (belowOpt(2)) return
  // (the loop as written replaced by a trap: what remains is the copies, and their loops compute in words)
  is(loopFloats(wat(src, { optimize: { level: 3, coldTrap: true } })), 0, 'no Number arithmetic in the copies\' loops')
  const m = jz(src, { optimize: { level: 3, coldTrap: true } }).exports
  for (const n of [1, 7, 40]) is(m.main(n), js.main(n), `the copies run for ${n} glyphs`)
})

test('integral loops: a counter stepped by a byte-sized run takes a copy with a budget of the byte', () => {
  // `p += run` over a run of a byte plus one advances by at least 1 and at most 256
  // a round, and the inner fill runs at most that often: the bounds come from the
  // element's range, so the loop over a count of unknown integrality takes its copy,
  // its counter and the byte cursor words of it.
  const src = `const rle = (bytes, out, n) => {
      let r = 0, p = 0
      while (p < n) {
        const run = bytes[r++] + 1, v = bytes[r++]
        for (let k = 0; k < run; k++) out[p + k] = v
        p += run
      }
      return p
    }
    export let main = (n) => {
      const bytes = new Uint8Array(2048), out = new Uint8Array(4096)
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 29 + 3) & 255
      let s = rle(bytes, out, n)
      for (let i = 0; i < out.length; i++) s = Math.imul(s ^ out[i], 16777619)
      return s
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const n of [0, 1, 300, 2000, 2.5]) is(m.main(n), js.main(n), `${n} at ${optimize}`)
  }
  if (belowOpt(2)) return
  is(loopFloats(wat(src, { optimize: { level: 3, coldTrap: true } })), 0, 'no Number arithmetic in the copy\'s loops')
  const m = jz(src, { optimize: { level: 3, coldTrap: true } }).exports
  for (const n of [1, 300, 2000]) is(m.main(n), js.main(n), `the copy runs for ${n}`)
})

test('integral loops: a sum of int32s past the word takes a copy that tests it and leaves for the loop as written', () => {
  // A DP row's cells: `up + 1` over an int32 element, `diag + (… ? 0 : 1)` over a
  // name every write of which is an element, `prev[j - 1] + 1`. No hull holds the
  // sums within int32, so the loop as written computed them wide. The copy tests
  // the wide side before each statement (`up > 2147483646`), bailing to the loop
  // as written, resumed at the copy's counter, where the result would leave the
  // word; under the tests the sums are words. A row with a cell at the word's
  // top bails and computes as written: the same values either way.
  const src = `const LB = 64
    const scan = (a, b, prev, n) => {
      for (let i = 1; i <= n; i++) {
        let diag = prev[0]
        prev[0] = i
        const ai = a[i - 1]
        for (let j = 1; j <= LB; j++) {
          const up = prev[j]
          const sub = diag + (ai === b[j - 1] ? 0 : 1)
          let m = up + 1
          const ins = prev[j - 1] + 1
          if (ins < m) m = ins
          if (sub < m) m = sub
          diag = up
          prev[j] = m
        }
      }
      let h = 0
      for (let j = 0; j <= LB; j++) h = Math.imul(h ^ prev[j], 16777619)
      return h
    }
    export let main = (seed, big) => {
      const a = new Uint8Array(LB), b = new Uint8Array(LB), prev = new Int32Array(LB + 1)
      let s = seed | 0
      for (let i = 0; i < LB; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; a[i] = s & 3; b[i] = (s >> 3) & 3 }
      for (let j = 0; j <= LB; j++) prev[j] = big && j % 5 === 0 ? 2147483647 : j
      return scan(a, b, prev, LB)
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const seed of [1, 7, 12345]) for (const big of [0, 1]) is(m.main(seed, big), js.main(seed, big), `seed ${seed}, big ${big} at ${optimize}`)
  }
  if (belowOpt(2)) return
  // (the loop as written and the resumption replaced by traps: what remains is the copy, computing in words)
  const text = wat(src, { optimize: { level: 3, coldTrap: true } })
  is(loopFloats(text), 0, 'no Number arithmetic in the copy\'s loops')
  is(loopWide(text), 0, 'no wide arithmetic in the copy\'s loops')
  ok(/i32\.gt_s\s*\(local\.get \$[^)]*\)\s*\(i32\.const 2147483646\)/.test(text), 'the copy tests the wide side against the word\'s top less the step')
  const m = jz(src, { optimize: { level: 3, coldTrap: true } }).exports
  is(m.main(7, 0), js.main(7, 0), 'a row within the word runs the copy')
  throws(() => m.main(7, 1), 'a row at the word\'s top leaves the copy, and the trap names it')
})

test('integral loops: a step in an arm of an `if` advances a cursor from zero to the step, so mixed signs budget each way', () => {
  // `if (up) x += 2; else x -= 1`: a round advances x by 2 or by -1, never by their
  // sum. The budget's top is the entry plus the trips times 2: a walk starting near
  // the word's top under a count that would pass it leaves the copy to the loop as
  // written, which sums as Numbers; the copy runs where the ends fit.
  const src = `const walk = (dirs, x0, n) => {
      let x = x0 | 0, acc = 0
      let i = 0
      while (i < n) { if (dirs[i] === 1) x += 2; else x -= 1; acc = (acc + (x & 1023)) | 0; i++ }
      return x + acc
    }
    export let main = (x0, n, all) => {
      const dirs = new Uint8Array(n)
      for (let i = 0; i < n; i++) dirs[i] = all || (i % 3 === 0) ? 1 : 0
      return walk(dirs, x0, n)
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [x0, n, all] of [[0, 100, 0], [0, 100, 1], [2147483000, 400, 1], [2147483000, 400, 0], [-2147483000, 400, 0], [5, 0, 1]]) is(m.main(x0, n, all), js.main(x0, n, all), `${x0} ${n} ${all} at ${optimize}`)
  }
  if (belowOpt(2)) return
  const m = jz(src, { optimize: { level: 3, coldTrap: true } }).exports
  is(m.main(0, 100, 1), js.main(0, 100, 1), 'a walk within the word runs the copy')
  throws(() => m.main(2147483000, 400, 1), 'a walk whose top would pass the word leaves the copy for the loop as written')
})

test('integral loops: a walk stepped up and down under a literal step count takes a copy of words', () => {
  // square tracing: `x++`/`x--`/`y++`/`y--` under `while (steps < MAXCODES)` with
  // MAXCODES a module constant. The count is literal but far past what the emitter
  // unrolls, so the cursors take the copy: a word each, under the guard of its entry
  // plus the count each way. The loop as written, for a start near the word's ends,
  // stays beside it.
  const src = `const W = 64, H = 64, MAXCODES = 4096
    const trace = (bmp, visited, codes, nc, sx, sy) => {
      let x = sx, y = sy, dir = 3, steps = 0
      while (steps < MAXCODES) {
        const inside = x >= 0 && x < W && y >= 0 && y < H && bmp[y * W + x] === 1
        if (inside) { visited[y * W + x] = 1; dir = (dir + 3) & 3 } else dir = (dir + 1) & 3
        if (nc < MAXCODES) codes[nc++] = dir
        if (dir === 0) x++; else if (dir === 1) y++; else if (dir === 2) x--; else y--
        steps++
        if (x === sx && y === sy && dir === 3) break
      }
      return nc
    }
    export let main = (r) => {
      const bmp = new Uint8Array(W * H), visited = new Uint8Array(W * H), codes = new Uint8Array(MAXCODES)
      const R = r | 0
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const dx = x - 32, dy = y - 32; if (dx * dx + dy * dy <= R * R) bmp[y * W + x] = 1 }
      let nc = 0, h = 0
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++)
        if (bmp[y * W + x] === 1 && bmp[y * W + x - 1] === 0 && visited[y * W + x] === 0) { const start = nc; nc = trace(bmp, visited, codes, nc, x, y); h = Math.imul(h ^ (nc - start), 16777619) }
      for (let i = 0; i < nc; i++) h = Math.imul(h ^ codes[i], 16777619)
      return h
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const r of [3, 10, 20, 0]) is(m.main(r), js.main(r), `r ${r} at ${optimize}`)
  }
  if (belowOpt(2)) return
  const text = wat(src, { optimize: { level: 3, coldTrap: true } })
  is(loopFloats(text), 0, 'no Number arithmetic in the copy\'s loops')
  // (`const inside = x >= 0 && … && bmp[y * W + x] === 1; if (inside)`: the `if` tests the
  // condition itself (plan/forward-conditions.js), so the store's index is a word in range)
  is(loopWide(text), 0, 'no wide arithmetic in the copy\'s loops: the arm refines by the condition')
  const m = jz(src, { optimize: { level: 3, coldTrap: true } }).exports
  for (const r of [3, 20]) is(m.main(r), js.main(r), `the copy traces r ${r}`)
})

test('integral loops: words stepped on the arms of a dense chain take one select-accumulated step', () => {
  // The copy steps a word as `x = (x + 1) | 0`, which the select accumulation
  // (compile/loop-recurrence.js selectArmUpdatesIn, speed tier) reads as it reads
  // `x++`: `x = (x + (dir === 0 ? 1 : dir === 2 ? -1 : 0)) | 0`, exact since every
  // value a word holds is an int32. A name some write of which may hold a fraction
  // (`x = n / 2`) keeps its chain: `(x + 0) | 0` would drop the fraction.
  const src = `const W = 64, H = 64, MAXCODES = 4096
    const trace = (bmp, codes, nc, sx, sy) => {
      let x = sx, y = sy, dir = 3, steps = 0
      while (steps < MAXCODES) {
        const inside = x >= 0 && x < W && y >= 0 && y < H && bmp[y * W + x] === 1
        if (inside) dir = (dir + 3) & 3; else dir = (dir + 1) & 3
        if (nc < MAXCODES) codes[nc++] = dir
        if (dir === 0) x++; else if (dir === 1) y++; else if (dir === 2) x--; else y--
        steps++
        if (x === sx && y === sy && dir === 3) break
      }
      return nc
    }
    export let main = (r, off) => {
      const bmp = new Uint8Array(W * H), codes = new Uint8Array(MAXCODES)
      const R = r | 0
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const dx = x - 32, dy = y - 32; if (dx * dx + dy * dy <= R * R) bmp[y * W + x] = 1 }
      let nc = 0, h = 0
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++)
        if (bmp[y * W + x] === 1 && bmp[y * W + x - 1] === 0) { const start = nc; nc = trace(bmp, codes, nc, (off | 0) + x, y); h = Math.imul(h ^ (nc - start), 16777619) }
      for (let i = 0; i < nc; i++) h = Math.imul(h ^ codes[i], 16777619)
      return h
    }`
  const frac = `export let f = (n, d0, k) => {
      let x = n / 2, y = 0, d = d0 | 0
      for (let i = 0; i < k; i++) {
        if (d === 0) x = (x + 1) | 0; else if (d === 1) y = (y + 1) | 0; else if (d === 2) x = (x - 1) | 0; else y = (y - 1) | 0
        d = (d + 2) & 3
      }
      return x * 1000 + y
    }`
  const js = oracle(src), jf = oracle(frac)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports, g = jz(frac, { optimize }).exports
    for (const [r, off] of [[3, 0], [20, 0], [10, 2147483600], [0, 0]]) is(m.main(r, off), js.main(r, off), `r ${r} off ${off} at ${optimize}`)
    for (const [n, d0, k] of [[5, 1, 4], [5, 0, 4], [7, 3, 3], [-3, 2, 5], [4, 1, 0]]) is(g.f(n, d0, k), jf.f(n, d0, k), `f(${n}, ${d0}, ${k}) at ${optimize}`)
  }
  if (belowOpt(2)) return
  // (the `if`s of the copy's loops that test the direction: none once the steps are selects)
  const chain = (text) => {
    let k = 0
    const test = n => Array.isArray(n) && (n[0] === 'i32.eqz' || n[0] === 'i32.eq') && n[1]?.[0] === 'local.get' && String(n[1][1]).includes('dir')
    const walk = (n, inLoop) => { if (!Array.isArray(n)) return; if (inLoop && n[0] === 'if' && n.some(test)) k++; for (const c of n) walk(c, inLoop || n[0] === 'loop') }
    walk(parseWat(text), false)
    return k
  }
  const opts = { level: 'speed', coldTrap: true }
  is(chain(wat(src, { optimize: opts })), 0, 'the copy steps its words by selects')
  ok(chain(wat(src, { optimize: { ...opts, selectArmUpdates: false } })) > 0, 'without the pass the steps branch')
  is(loopFloats(wat(src, { optimize: opts })), 0, 'the words stay int32s')
})

test('integral loops: a walk entering from the counters of the loops around it stands alone, untested', () => {
  // The tracer inlined into its scan declares its cursors from the scan's counters
  // (`let x = sx`, `sx` a `for (let sx = 1; sx < W - 1; sx++)` stepped by its loop
  // alone): int32s within [1, W - 2], never -0. The entry plus the count each way
  // fits the word, so the copy tests nothing and needs no loop as written beside
  // it, whose Number twin held the scan's registers. A start moved by any int32
  // (`(off | 0) + x`) has no such hull: the guard tests the entry, the twin stays.
  const src = (start) => `const W = 64, H = 64, MAXCODES = 4096
    const trace = (bmp, codes, nc, sx, sy) => {
      let x = sx, y = sy, dir = 3, steps = 0
      while (steps < MAXCODES) {
        const inside = x >= 0 && x < W && y >= 0 && y < H && bmp[y * W + x] === 1
        if (inside) dir = (dir + 3) & 3; else dir = (dir + 1) & 3
        if (nc < MAXCODES) codes[nc++] = dir
        if (dir === 0) x++; else if (dir === 1) y++; else if (dir === 2) x--; else y--
        steps++
        if (x === sx && y === sy && dir === 3) break
      }
      return nc
    }
    export let main = (r, off) => {
      const bmp = new Uint8Array(W * H), codes = new Uint8Array(MAXCODES)
      const R = r | 0
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const dx = x - 32, dy = y - 32; if (dx * dx + dy * dy <= R * R) bmp[y * W + x] = 1 }
      let nc = 0, h = 0
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++)
        if (bmp[y * W + x] === 1 && bmp[y * W + x - 1] === 0) { const start = nc; nc = trace(bmp, codes, nc, ${start}, y); h = Math.imul(h ^ (nc - start), 16777619) }
      return h
    }`
  const innermost = (text) => {
    let k = 0
    const inner = (n) => Array.isArray(n) && (n[0] === 'loop' || n.some(inner))
    const walk = (n) => { if (!Array.isArray(n)) return; if (n[0] === 'loop' && !n.slice(1).some(inner)) { k++; return } for (const c of n) walk(c) }
    walk(parseWat(funcWat(text, 'main')))
    return k
  }
  const counts = []
  for (const start of ['x', '(off | 0) + x']) {
    const js = oracle(src(start))
    for (const optimize of levels(0, 2, 'speed')) {
      const m = jz(src(start), { optimize }).exports
      for (const [r, off] of [[3, 0], [10, 0], [20, 0], [0, 0], [10, 1], [10, -2], [10, 2147483000]]) is(m.main(r, off), js.main(r, off), `${start}: r ${r} off ${off} at ${optimize}`)
    }
    if (belowOpt(2)) continue
    const text = wat(src(start), { optimize: 'speed' })
    counts.push(innermost(text))
    if (start === 'x') is(loopFloats(text), 0, 'no Number arithmetic in main\'s loops')
  }
  if (!belowOpt(2)) is(counts[0], counts[1] - 1, 'the walk from the scan\'s counters has no loop as written beside its copy')
})

test('forward conditions: a boolean declared once for the `if` right after it is the test itself', () => {
  // The `if` then refines its arms by the condition's conjuncts; a boolean read
  // anywhere else, or declared with `let`, or tested later, stays declared.
  const src = `export let f = (a, i, n) => {
      const ok = i >= 0 && i < n && a[i] === 1
      if (ok) a[i] = 2
      const twice = i > 0
      if (twice) a[0] = i
      return twice ? 1 : 0
    }
    export let g = (a, i, n) => {
      let late = i < n
      if (late) a[i] = 3
      const apart = i > 1
      a[1] = 0
      if (apart) a[1] = 1
      return 0
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const [i, n] of [[0, 4], [2, 4], [5, 4], [-1, 4]]) {
      const a = new Int32Array([1, 1, 1, 1]), b = new Int32Array([1, 1, 1, 1])
      is([m.f(a, i, n), m.g(a, i, n), Array.from(a)], [js.f(b, i, n), js.g(b, i, n), Array.from(b)], `${i} ${n} at ${optimize}`)
    }
  }
  const f = planned(src, 'f'), g = planned(src, 'g')
  const decl = (body, name) => countNodes(body, n => Array.isArray(n) && (n[0] === 'const' || n[0] === 'let') && n.slice(1).some(d => Array.isArray(d) && typeof d[1] === 'string' && d[1].startsWith(name)))
  is(decl(f, 'ok'), 0, 'the boolean read once by the if after it is forwarded')
  ok(countNodes(f, n => Array.isArray(n) && n[0] === 'if' && Array.isArray(n[1]) && n[1][0] === '&&') >= 1, 'the if tests the conjunction')
  is(decl(f, 'twice'), 1, 'a boolean read again stays')
  is(decl(g, 'late'), 1, 'a let stays')
  is(decl(g, 'apart'), 1, 'a boolean tested later stays')
})

test('integral loops: an output cursor stepped inside nested loops and expressions takes the copy\'s word under a count the round\'s own test gives', () => {
  // LZ's compressor: `op` steps by `op++` inside an initializer, by `op += 2` in an
  // arm and by `out[op++] = …` in the other, inside `for (b < 8 && ip < n)` under
  // `while (ip < n)`. The round's test entered again makes the inner loop run at
  // least once, its `if (bestLen >= 3)` floors `ip += bestLen` at 3, so `ip` rises
  // by at least one a round: the while has its trips, `op` its budget (at most
  // 1 + 8 × 2 a round), and the copy steps the word, the step of a one-statement
  // arm hoisted into a block after it.
  const src = `const WINDOW = 64, MIN_MATCH = 3, MAX_MATCH = 18
    const compress = (src, n, out) => {
      let op = 0, ip = 0
      while (ip < n) {
        const ctrlPos = op++
        let ctrl = 0
        for (let b = 0; b < 8 && ip < n; b++) {
          let start = ip - WINDOW
          if (start < 0) start = 0
          let maxLen = n - ip
          if (maxLen > MAX_MATCH) maxLen = MAX_MATCH
          let bestLen = 0, bestDist = 0
          for (let j = ip - 1; j >= start; j--) {
            let len = 0
            while (len < maxLen && src[j + len] === src[ip + len]) len++
            if (len > bestLen) { bestLen = len; bestDist = ip - j; if (len >= maxLen) break }
          }
          if (bestLen >= MIN_MATCH) {
            ctrl |= (1 << b)
            const code = ((bestDist - 1) << 4) | (bestLen - MIN_MATCH)
            out[op] = (code >>> 8) & 0xff
            out[op + 1] = code & 0xff
            op += 2
            ip += bestLen
          } else out[op++] = src[ip++]
        }
        out[ctrlPos] = ctrl
      }
      return op
    }
    const N = 512
    export let main = (iters) => {
      const src = new Uint8Array(N), out = new Uint8Array(N * 2 + 64)
      let x = 0x12345678 | 0
      for (let i = 0; i < N; i++) { x = (Math.imul(x, 1103515245) + 12345) | 0; src[i] = i > 64 && (x & 0x70) === 0 ? src[i - 1 - ((x >>> 8) & 63)] : (x >>> 16) & 0xff }
      let h = 0
      for (let it = 0; it < iters; it++) {
        const clen = compress(src, N, out)
        h = Math.imul(h ^ clen, 16777619)
        for (let i = 0; i < clen; i++) h = Math.imul(h ^ out[i], 16777619)
        src[it % N] = (src[it % N] + 1) & 0xff
      }
      return h
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const iters of [0, 1, 3]) is(m.main(iters), js.main(iters), `${iters} at ${optimize}`)
  }
  if (belowOpt(2)) return
  // (the innermost loops compute in words: the output cursor and the match scan alike; a
  // version's guard around them reads its count as a Number once a round)
  const text = wat(src, { optimize: { level: 3, coldTrap: true } })
  is(leafFloats(text), 0, 'no Number arithmetic in the copies\' innermost loops')
  const m = jz(src, { optimize: { level: 3, coldTrap: true } }).exports
  for (const iters of [1, 3]) is(m.main(iters), js.main(iters), `the copies compress ${iters} times`)
})

test('integral loops: a cursor stepped in a nested loop over a round\'s own count takes the copy\'s word by the round\'s budget', () => {
  // LZ's inflater: `op` steps by `op++` inside `for (k < len)`, `len` a code's field
  // of the round (`(code & 15) + 3`), and by `dst[op++] = …` in the other arm. No
  // name of the loop's gives the inner trips, so the round's advance comes from the
  // budget, which reads the field's range off the round's declarations and the inner
  // version as its loop as written: at most 1 + 8 × 18 a round, under the count of
  // the while's own cursor.
  const src = `const MIN_MATCH = 3
    const inflate = (inp, clen, dst) => {
      let ip = 0, op = 0
      while (ip < clen) {
        const ctrl = inp[ip++]
        for (let b = 0; b < 8 && ip < clen; b++) {
          if (ctrl & (1 << b)) {
            const code = (inp[ip] << 8) | inp[ip + 1]
            ip += 2
            const dist = (code >>> 4) + 1
            const len = (code & 0x0f) + MIN_MATCH
            for (let k = 0; k < len; k++) { dst[op] = dst[op - dist]; op++ }
          } else dst[op++] = inp[ip++]
        }
      }
      return op
    }
    export let main = (clen) => {
      const inp = new Uint8Array(1024), dst = new Uint8Array(8192)
      let x = 0x2545f491 | 0
      for (let i = 0; i < 1024; i++) { x = (Math.imul(x, 1103515245) + 12345) | 0; inp[i] = (x >>> 16) & 0xff }
      const n = inflate(inp, clen, dst) | 0
      let h = n
      for (let i = 0; i < n; i++) h = Math.imul(h ^ dst[i], 16777619)
      return h
    }`
  const js = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    for (const clen of [0, 1, 9, 100, 300]) is(m.main(clen), js.main(clen), `${clen} at ${optimize}`)
  }
  if (belowOpt(2)) return
  // (the innermost loops: a version's guard around them reads the count as a Number once a round)
  const text = wat(src, { optimize: { level: 3, coldTrap: true } })
  is(leafFloats(text), 0, 'no Number arithmetic in the copies\' innermost loops')
  const m = jz(src, { optimize: { level: 3, coldTrap: true } }).exports
  for (const clen of [9, 300]) is(m.main(clen), js.main(clen), `the copies inflate ${clen}`)
})

// A divisor of an index's remainder or truncated quotient (a deinterleave's
// `buf[(i % seg) * 2 + ~~(i / seg)]`, the segment a typed length's half) is a
// word above zero in the copy: the hardware divides there, and a segment of
// zero runs the loop as written, whose indexes are NaN.
test('integral loops: an index divided by a segment length divides in words, a zero segment runs as written', () => {
  const src = `const fill = (n) => { const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = i * 7 - 3; return a }
    const deint = (a) => {
      const len = a.length, seg = Math.floor(len / 2)
      let s = 0
      for (let i = 0; i < len; i++) s += a[(i % seg) * 2 + ~~(i / seg)]
      return s
    }
    export let go = (n) => deint(fill(n))`
  const host = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const m = run(src, { optimize })
    for (const n of [0, 1, 2, 3, 10, 101]) ok(Object.is(m.go(n), host.go(n)), `O${optimize}: go(${n})`)
  }
  if (belowOpt(2)) return
  const body = funcWat(wat(src, { optimize: 2 }), 'go')
  // (signed or, the index and the segment proven no less than zero and above it, unsigned: optimize/unsigned-div.js)
  ok(/i32\.div_[su]/.test(body) && /i32\.rem_[su]/.test(body), 'the copy divides in words')
})

// A while counting down (`while (i > n)`, every write of i a decrement) is a
// counter of the copy as one counting up is: from the bound to its entry, the
// guard holding the bound above the word's floor by the loop's descent.
test('integral loops: down-counting while counters preserve full entries, bounds and landing values', () => {
  for (const [cmp, step] of [['>', 'i--'], ['>=', 'i--'], ['>', 'i-=3'], ['>', 'i = i - 1;if(count&1)i--']]) {
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
      for (const [start, n] of [[0, 0], [3, 0], [2.5, 0], [3, 0.5], [0, -0], [2, -0], [-1, -3],
        [-2147483645, -2147483648], [-2147483646, -2147483649], [2147483647, 2147483645],
        [2147483648, 2147483646], [4294967299, 4294967296], [3, 0.5], [NaN, 2],
        [2, NaN], [0, Infinity], [0, -Infinity], [-Infinity, -Infinity], [5, 5], [3, 0]])
        is(got.run(start, n), host.run(start, n), `O${optimize}: ${start} ${cmp} ${n}, ${step}`)
    }
  }
})

// A walk to an end tested by equality, its cursor stepped by one unit one way
// (plan/counted-loops.js unitWalks), runs under `<` or `>` where the cursor and
// the end are integers, the cursor at or before the end: a scan alternating
// direction by row (a falling-sand automaton's) indexes its cells by words both
// ways, and every other start runs the loop as written.
test('integral loops: a walk to an end tested by equality indexes by words both ways', () => {
  const src = `let W = 0, H = 0, cell
    export let resize = (w, h) => { W = w; H = h; cell = new Int32Array(w * h > 0 ? w * h : 0); for (let i = 0; i < cell.length; i++) cell[i] = (i * 7) % 5 }
    export let scan = (p) => {
      let w = W, h = H, s = 0, y = h - 2
      while (y >= 0) {
        let ltr = ((y + p) & 1) === 0
        let x = ltr ? 0 : w - 1, xend = ltr ? w : -1, dxs = ltr ? 1 : -1
        while (x !== xend) {
          let c = y * w + x
          if (cell[c] === 1) s += x
          else if (cell[c] === 3) cell[c] = 2
          x += dxs
        }
        y--
      }
      return s
    }
    let k = new Int32Array([0, 1, 2, 3, 4, 3, 2, 1])
    export let walk = (x, e, d) => { let s = 0, n = 0; while (x !== e) { s += k[x & 7] * 3 + x; x += d; if (++n > 99) return -1 } return [s, x, 1 / x] }
    export let up = (x, e) => { let s = 0, n = 0; while (x != e) { s = s * 3 + k[x & 7]; x++; if (++n > 99) return -1 } return [s, x] }
    export let down = (x, e) => { let s = 0, n = 0; while (e !== x) { if (k[x & 7] === 4) { x--; continue } s += k[x & 7]; x = x - 1; if (++n > 99) return -1 } return [s, x] }
    export let stop = (x, e, d) => { let s = 0; while (x !== e) { if (k[x & 7] === 3) break; s += x; x += d } return [s, x] }
    export let read = (x, e) => { let s = 0, n = 0; while (x !== e) { s += k[(x++) & 7]; if (++n > 99) return -1 } return [s, x] }
    export let back = (x, e, d) => { let s = 0, n = 0; while (e !== x) { s += k[x & 7] + x; x = x - d; if (++n > 99) return -1 } return [s, x] }`
  const host = oracle(src)
  const ints = [0, 1, 5, -3, -0, 40, 2147483600, 2147483647, -2147483648, 4294967296, 9007199254740990]
  const others = [[0.5, 3, 1], [0, 3, -1], [5, 3, 1], [NaN, 3, 1], [0, 2.5, 1], [0, 3, 2], [0, 3, 0.5], [3, 0, 1], [-0, 0, 1], [Infinity, Infinity, 1]]
  for (const optimize of levels(0, 2, 'speed')) {
    const m = jz(src, { optimize }).exports
    // (a fractional or negative width never meets its row's end, in JS as here)
    for (const [w, h] of [[6, 4], [5, 5], [0, 3], [1, 3], [7, 2.5], [3, 0], [4, -1]])
      for (const p of [0, 1]) { m.resize(w, h); host.resize(w, h); is(m.scan(p), host.scan(p), `O${optimize}: scan ${w}×${h} (${p})`) }
    for (const x of ints) for (const e of ints) {
      if (!(Math.abs(x - e) < 90)) continue
      for (const d of [1, -1]) if ((e - x) * d >= 0) {
        is(m.walk(x, e, d), host.walk(x, e, d), `O${optimize}: walk ${x} → ${e} by ${d}`)
        is(m.stop(x, e, d), host.stop(x, e, d), `O${optimize}: stop ${x} → ${e} by ${d}`)
        is(m.back(x, e, -d), host.back(x, e, -d), `O${optimize}: back ${x} → ${e} by ${-d}`)
      }
      if (x <= e) { is(m.up(x, e), host.up(x, e), `O${optimize}: up ${x} → ${e}`); is(m.read(x, e), host.read(x, e), `O${optimize}: read ${x} → ${e}`) }
      if (x >= e) is(m.down(x, e), host.down(x, e), `O${optimize}: down ${x} → ${e}`)
    }
    for (const [x, e, d] of others) {
      is(m.walk(x, e, d), host.walk(x, e, d), `O${optimize}: walk ${x} → ${e} by ${d}`)
      is(m.back(x, e, -d), host.back(x, e, -d), `O${optimize}: back ${x} → ${e} by ${-d}`)
      // (a stride past the end with no break to stop it never ends, in JS as here)
      if (x === x && d !== 2) is(m.stop(x, e, d), host.stop(x, e, d), `O${optimize}: stop ${x} → ${e} by ${d}`)
      is(m.up(x, e), host.up(x, e), `O${optimize}: up ${x} → ${e}`)
      is(m.read(x, e), host.read(x, e), `O${optimize}: read ${x} → ${e}`)
      is(m.down(e, x), host.down(e, x), `O${optimize}: down ${e} → ${x}`)
    }
  }
  if (belowOpt(2)) return
  const scan = funcWat(wat(src, { optimize: 'speed' }), 'scan')
  ok(/\(i32\.add \(local\.get \$x[^\s)]*int\d+\) \(i32\.const 1\)/.test(scan), 'the rightward cursor steps as a word')
  ok(/\(i32\.sub \(local\.get \$x[^\s)]*int\d+\) \(i32\.const 1\)/.test(scan), 'the leftward cursor steps as a word')
})

// A closure's loop bounded by a binding of the function it captures that
// nothing writes (decode-dsd's stage 1: `const { C, tables } = st` in the
// factory, `i < C` in the `push` it returns) gets the copy a bound it binds
// gets: the copy reads the capture once, which is what every read of it is.
// Every number agrees, integral or not; a capture some code writes stays out.
test('integral loops: a closure bounded by a capture nothing writes', () => {
  const src = `const ring = (st) => { const { C, t } = st; return (k) => { let s = 0; for (let i = 0; i < C; i++) s += t[(i + k) & 7] + i; return s } }
    const moved = (st) => { let { C, t } = st; const bump = () => { C += 0.5 }; return (k) => { let s = 0; bump(); for (let i = 0; i < C; i++) s += t[(i + k) & 7]; return s } }
    export const run = (C, k) => ring({ C, t: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]) })(k)
    export const runMoved = (C, k) => { const p = moved({ C, t: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]) }); p(k); return p(k) }`
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const got = jz(src, { optimize }).exports
    for (const [C, k] of [[0, 0], [5, 1], [5.5, 2], [-3, 0], [NaN, 0], [12, 3], [2.5, 0]]) {
      is(got.run(C, k), host.run(C, k), `O${optimize}: run(${C}, ${k})`)
      is(got.runMoved(C, k), host.runMoved(C, k), `O${optimize}: runMoved(${C}, ${k})`)
    }
  }
  if (belowOpt(2)) return
  // (watr off: the closure, called directly now, would join its one caller, the copy's names shared with its locals)
  const w = wat(src, { optimize: { level: 2, watr: false } })
  // (a closure is named `$` + T + `closure<n>`, the copy's counter `i` + T + `int<n>`: prepare's binding mark)
  ok(w.split(/\n(?=  \(func )/).some(f => f.startsWith(`  (func $${T}closure`) && f.includes(`(local $i${T}int`)), 'the closure counts an int32 copy')
})

// A counter entering from a name (`for (let j = lim; j < num; j++)`, a
// predictor's history past its order) under a bound of unknown integrality
// (`num`, a count `>>> 0` made) gets the copy a literal start gets: its start
// is the name's word, tested as an int32, the bound rounded once. A loop
// nested around another that reads those names took no copy without it.
// The values are the same for every start and bound, integral or not.
test('integral loops: a counter entering from a name counts in a word', () => {
  const src = `function pred(out, num, order) {
      let lim = order + 1, s = 0
      for (let j = lim; j < num; j++) {
        let top = out[j - lim], acc = 0
        for (let q = 1; q < lim; q++) { acc = (acc + Math.imul(out[j - q] - top, q)) | 0; if (acc > 100000) break }
        out[j] = (out[j] + (acc >> 4)) | 0
        s = (s + out[j]) | 0
      }
      return s
    }
    export const run = (n, k) => {
      const num = n >>> 0, order = k & 7, out = new Int32Array(64)
      for (let i = 0; i < 64; i++) out[i] = Math.imul(i, 40503) >> 7
      return pred(out, num, order) + pred(out, num, 3)
    }
    export const runAt = (n, k, a) => pred(new Int32Array(64).fill(a), n, k)`
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const got = jz(src, { optimize }).exports
    for (const [n, k] of [[0, 0], [3, 0], [3.5, 1], [10, 2], [12.25, 7], [64, 7], [70, 5], [900, 3], [7, -2], [5, 2147483647], [NaN, 1]])
      is(got.run(n, k), host.run(n, k), `O${optimize}: run(${n}, ${k})`)
    for (const [n, k] of [[20, 2.5], [20, -1], [9.5, 3], [-4, 1], [30, 2147483646], [NaN, 0], [20, NaN]])
      is(got.runAt(n, k, 5), host.runAt(n, k, 5), `O${optimize}: runAt(${n}, ${k})`)
  }
  if (belowOpt(2)) return
  compileInProcess(src)
  const body = ctx.funcs.list.find(f => f.name === 'pred')?.body
  let copy = false
  walkAst(body, { enter: n => { if (n[0] === 'for' && n[1]?.[1]?.[1]?.startsWith?.(`j${T}`) && String(n[1][1][1]).includes(`${T}int`) && String(n[2]?.[2]).includes(`${T}bound`)) copy = true } })
  ok(copy, 'the counter counts in a word of the copy, under the rounded bound')
})

// A head declaring names beside its counter and stepping them in its update
// (decode-wav's `for (let x = ch[c], i = 0, k = c * 3; i < frames; i++, k += nCh * 3)`)
// reads as the loop over its counter alone; a cursor stepped by a stride of the
// header record, an integer the program cannot prove, is a word of the copy
// under one test of the stride and the cursor's ends, read once before the loop.
const deinterleave = `export function f(src, o) {
  const raw = src instanceof Uint8Array ? src : new Uint8Array(src), nCh = o.channels, frames = Math.floor(raw.length / (nCh * 3))
  const ch = Array.from({ length: nCh > 0 && nCh < 9 ? nCh : 0 }, () => new Float32Array(frames > 0 ? frames : 0))
  let s = 0
  for (let c = 0; c < ch.length; c++) for (let x = ch[c], i = 0, k = c * 3; i < frames; i++, k += nCh * 3) {
    x[i] = ((raw[k] | raw[k + 1] << 8 | raw[k + 2] << 16) << 8 >> 8) / 8388608
    s += x[i]
  }
  return s
}`

test('integral loops: a head beside its counter reads as the loop over it, a record stride a cursor word', () => {
  const host = oracle(deinterleave)
  const raw = new Uint8Array(601)
  for (let i = 0, v = 7; i < raw.length; i++) { v = (v * 1103515245 + 12345) >>> 0; raw[i] = v >>> 24 }
  // wasi: js-object arg (the loops' words below hold on every host)
  if (!onWasi()) for (const optimize of levels(0, 2, 3)) {
    const { f } = jz(deinterleave, { optimize }).exports
    for (const channels of [1, 2, 3, 2.5, -1, 0, NaN, '2', 7])
      is(f(raw, { channels }), host.f(raw, { channels }), `O${optimize}: ${typeof channels} ${channels} channels`)
  }
  if (belowOpt(2)) return
  const fn = funcWat(wat(deinterleave, { optimize: 2 }), 'f')
  const seg = (from) => { let d = 0, i = from; for (; i < fn.length; i++) { if (fn[i] === '(') d++; else if (fn[i] === ')' && --d === 0) break } return fn.slice(from, i + 1) }
  const loops = []
  for (let at = fn.indexOf('(loop'); at >= 0; at = fn.indexOf('(loop', at + 5)) loops.push(seg(at))
  // (the one float add left is the sum of the samples)
  ok(loops.some(l => (l.match(/i32\.load8_u/g) || []).length === 3 && !/\(loop/.test(l.slice(5)) && !/trunc_sat/.test(l) && (l.match(/f64\.add/g) || []).length <= 1),
    'a sample loop steps its cursor in a word: no float step or truncation of it')
  // (the word's stride is no literal: the bounds guard takes the cursor's extent by it, test/dyn-keys.js)
  ok(loops.some(l => (l.match(/i32\.load8_u/g) || []).length === 3 && !/\(loop/.test(l.slice(5)) && !/i32\.(ge|lt)_u/.test(l)),
    'a sample loop reads its three bytes unchecked')
})

// The head stays as written where the loop over its counter would change what
// runs: a `continue` takes the update's steps, a step or a declaration reading the
// counter sees it where the head put it, and steps before the counter's run first.
test('integral loops: a head kept as written where reading it over its counter would change it', () => {
  const src = `export const cont = (a, o) => { let s = 0; for (let i = 0, k = 0; i < a.length; i++, k += o.s) { if (i % 3 === 0) continue; s += a[k] | 0 } return s }
    export const readsI = (a, o) => { let s = 0; for (let i = 0, k = 0; i < a.length; i++, k += i) s += (a[k] | 0) + o.s; return s }
    export const declI = (a, o) => { let s = 0; for (let i = 1, k = i * o.s; i < a.length; i++, k += o.s) s += a[k] | 0; return s }
    export const before = (a, o) => { let s = 0; for (let x = a, i = 0, k = 0; i < a.length; k += o.s, i++) s += (x[k] | 0) * (i + 1); return s }`
  const host = oracle(src)
  const a = Array.from({ length: 40 }, (_, i) => (i * 7) % 11)
  if (onWasi()) return  // wasi: js-object arg
  for (const optimize of levels(0, 2, 3))
    for (const [name, fn] of Object.entries(jz(src, { optimize }).exports))
      for (const s of [1, 2, 0.5, -1]) is(fn(a, { s }), host[name](a, { s }), `O${optimize}: ${name} by ${s}`)
})

// A stride visibly a fraction (resample's `phase += step`, `step` a quotient) is no
// cursor's: its guard would fail on every run, the loop as written running cold.
// A head whose other names the loop only reads (the bound a string scan's lowering
// declares, `min(len, s.length)`) keeps its form; the tokenizer bench case holds
// its speed, which a copy of such a head lost (43 µs → 63 µs).
test('integral loops: a fractional stride keeps the loop, a scan the head its lowering wrote', () => {
  const src = `export const phase = (a, o) => { let s = 0; const step = o.up / o.dn; for (let k = 0, p = 1; k < 20; k++, p += step) s += a[p | 0] | 0; return s }
    const scan = (src, len) => { let h = 0, tokens = 0; for (let i = 0; i < len; i++) { const c = src.charCodeAt(i); if (c > 32) { h = (h * 31 + c) | 0; tokens++ } } return h + tokens }
    const SRC = 'let alpha_12 = beta + 12345; if (alpha_12 >= 99) total = 1;'
    export const scanAt = (k) => { let src = ''; for (let r = 0; r < 4; r++) src = src + SRC; const n = src.length; return scan(src, n - (k & 7)) ^ scan(src, n - (k & 3)) }`
  const host = oracle(src)
  const a = Array.from({ length: 64 }, (_, i) => i * 3 % 17)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    if (!onWasi()) for (const [up, dn] of [[3, 2], [1, 1], [5, 4]]) is(m.phase(a, { up, dn }), host.phase(a, { up, dn }), `O${optimize}: phase ${up}/${dn}`)   // wasi: js-object arg
    for (const k of [0, 5, 13]) is(m.scanAt(k), host.scanAt(k), `O${optimize}: scan at ${k}`)
  }
  if (belowOpt(2)) return
  compileInProcess(src)
  const names = (f) => { const out = new Set(); walkAst(ctx.funcs.list.find(g => g.name === f)?.body, { enter: n => { for (const x of n) if (typeof x === 'string') out.add(x) } }); return [...out] }
  ok(!names('phase').some(n => n.includes(`${T}stride`)), 'no word for a fractional stride')
})

test('integral loops: a stride cursor enters tested, an accumulator by a stride keeps the loop', () => {
  // `t` enters a run of a whole stride where the loop as written left it after a run of
  // a fractional one (`o.k * i`, 0.5 at i = 1); `s += step` indexes nothing, a word of it buys nothing
  const src = `export const pick = (src, o, n, m) => { const a = src instanceof Uint8Array ? src : new Uint8Array(src); let s = 0, t = 0; for (let i = 0; i < n; i++) { const w = o.k * i; for (let j = 0; j < m; j++, t += w) s += a[t] ?? 100 } return s + t }
    export const sum = (step) => { let s = 0; for (let i = 0; i < 10; i++) s += step; return s }`
  const host = oracle(src)
  const a = new Uint8Array(64).map((_, i) => i * 7 % 23)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    if (!onWasi()) for (const k of [0.5, 1, 2, 1.5]) is(m.pick(a, { k }, 5, 3), host.pick(a, { k }, 5, 3), `O${optimize}: pick by ${k}`)   // wasi: js-object arg
    for (const step of [1, 2.5, -3]) is(m.sum(step), host.sum(step), `O${optimize}: sum by ${step}`)
  }
  if (belowOpt(2)) return
  compileInProcess(src)
  const names = (f) => { const out = new Set(); walkAst(ctx.funcs.list.find(g => g.name === f)?.body, { enter: n => { for (const x of n) if (typeof x === 'string') out.add(x) } }); return [...out] }
  ok(names('pick').some(n => n.includes(`${T}stride`)), 'a word for the index stride')
  ok(!names('sum').some(n => n.includes(`${T}stride`)), 'no word for an accumulator')
})

test('integral loops: a loop stepped by a literal counts its trips, a cursor of a short loop inside it a word of its copy', () => {
  // a frame's slices (QOA's shape): `slice += 20` around a loop over the channels
  // stepping the stream cursor; the copy is the outer loop's, one guard for the
  // frame, not one per slice around two channels (0.23x of V8 as a kernel, 0.94x)
  const src = `export const frames = (src, p) => { const b = src instanceof Uint8Array ? src : new Uint8Array(src)
    const ch = b[p], samples = b[p + 1] << 8 | b[p + 2]; let o = 3, s = 0
    for (let slice = 0; slice < samples; slice += 20) for (let c = 0; c < ch; c++, o += 4) s = (s + b[o] + b[o + 1]) | 0
    return s + o }`
  const host = oracle(src)
  const b = new Uint8Array(4096).map((_, i) => i * 7 % 251)
  const head = (ch, samples, p = 0) => { const a = b.slice(); a[p] = ch; a[p + 1] = samples >> 8; a[p + 2] = samples & 255; return a }
  for (const optimize of levels(0, 2, 3))
    for (const [ch, samples] of [[2, 100], [2, 101], [1, 19], [3, 20], [0, 400], [5, 0], [255, 65535]]) {
      const a = head(ch, samples)
      is(jz(src, { optimize }).exports.frames(a, 0), host.frames(a, 0), `O${optimize}: ${ch} channels, ${samples} samples`)
    }
  if (belowOpt(2)) return
  compileInProcess(src)
  const names = new Set()
  walkAst(ctx.funcs.list.find(g => g.name === 'frames')?.body, { enter: n => { for (const x of n) if (typeof x === 'string') names.add(x) } })
  ok([...names].some(n => n.startsWith('slice') && n.includes('int')), 'the slice loop is copied')
})
