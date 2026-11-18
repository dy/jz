// Loop induction: rotated loops, fractional recurrences, the i%w and (i/w)|0
// strength reduction (loop-SR), counted loops, the array-recurrence unroll and the
// min recurrence.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels, belowOpt, onWasi, ownedLevels } from './_matrix.js'
import { fusedRewrite } from '../src/optimize/peephole.js'
import { ctx } from '../src/ctx.js'
import { T, walkAst } from '../src/ast.js'
import parseWat from 'watr/parse'
import { unrollRecurrence } from '../src/compile/loop-recurrence.js'
import encodeWat from 'watr/compile'
import { run, oracle, compileInProcess, compile } from './util.js'
import { parse, loopCount, count, walk } from '../scripts/wat-probe.mjs'
import { findFunc } from './_optimizer.js'

test('rotateLoops: speed tier rotates a scan loop to a fused conditional back-edge', () => {
  // The lz/qoi class of hot scalar loop. PRE-watr + scoped to $firstGt: rotation is jz's
  // pass; watr's inliner splices stdlib loops (their labels/back-edges) into the module,
  // so a module-wide label-regex sweep reads THEIR shapes, not the user loop's.
  const src = `export const firstGt = (a, n, t) => { let i = 0; while (i < n && a[i] <= t) i++; return i }`
  const backEdges = (opt) => {
    const f = findFunc(parse(src, { ...opt, watr: false }), '$firstGt')
    const labels = new Set(); walk(f, n => { if (n[0] === 'loop' && typeof n[1] === 'string') labels.add(n[1]) })
    let fused = 0, plain = 0
    walk(f, n => { if (n[0] === 'br_if' && labels.has(n[1])) fused++; if (n[0] === 'br' && labels.has(n[1])) plain++ })
    return { fused, plain }
  }
  const rot = backEdges({ level: 'speed' }), ctl = backEdges({ level: 'speed', rotateLoops: false })
  ok(rot.fused >= 1 && rot.plain === 0, 'rotated: fused br_if back-edge, no unconditional br $loop')
  ok(ctl.fused === 0 && ctl.plain >= 1, 'control (rotateLoops off): top-test keeps unconditional br back-edge')
})

test('rotateLoops: semantics preserved across continue / break / nested / match-scan', () => {
  // Rotation duplicates the loop condition (guard + back-edge), keeps eval order, and
  // must NOT rotate a while-continue with no step (continue → loop label, no $cont block).
  // Compare speed-tier WITH rotation against the same tier with it off — bit-identical.
  const src = `export const main = () => {
    let total = 0
    let i = 0, s1 = 0
    while (i < 100) { i++; if ((i & 3) === 0) continue; s1 += i }   // while + continue, no step
    total += s1
    for (let k = 0; k < 100; k++) { if (k % 5 === 0) continue; total += k }   // for + continue + step
    outer: for (let a = 0; a < 20; a++) { for (let b = 0; b < 20; b++) { if (b === 5) continue outer; total += b } }
    let n = 1000; while ((n = n - 1) > 0) { if (n % 7 === 0) total += n }   // side-effecting condition
    let p = 1, m = 0
    while (p < 60 && (p * 7 + 3 & 0xff) !== 0) { p++; m++ }   // scan-until (lz idiom)
    return total + m
  }`
  const withRot = run(src, { optimize: { level: 'speed' } }).main()
  const without = run(src, { optimize: { level: 'speed', rotateLoops: false } }).main()
  is(withRot, without)
})

test('bounded fractional recurrences preserve rounding, zero work and i32 boundaries', () => {
  const cases = [
    ['1', '0.3', 0], ['-0', '-0', 1], ['1', '0.1', 100],
    ['1', '-0.3', 97], ['-3.75', '1.2', 33],
    ['2147483644', '0.25', 33], ['-2147483647', '-0.75', 31],
    ['1', 'Infinity', 3], ['1', '-Infinity', 3], ['1', 'NaN', 3],
  ]
  for (const [start, step, n] of cases) {
    const src = `export function f(flag){let p=${start},s=0;
      for(let i=0;i<${n};i++){s+=p|0;p+=${step}}
      return [s,p,1/p,flag?(p|0):9,flag?(p|0):0]}`
    const js = oracle(src).f
    for (const optimize of levels(0, 2, 3, 'size')) {
      const f = run(src, { optimize }).f
      for (const flag of [0, 0, 1, 0]) is(f(flag), js(flag), `${start} + ${n}*${step}, O${optimize}, flag=${flag}`)
    }
  }
})

test('fractional recurrence proofs require a reset on every nested-loop entry', () => {
  for (const reset of [false, true]) {
    const src = `export function f(flag){let p=1,s=0;
      for(let j=0;j<3;j++){${reset ? 'p=1;' : ''}
        for(let i=0;i<100;i++){s+=p|0;p+=0.3}}
      return [s,p,flag?(p|0):9]}`
    const js = oracle(src).f
    for (const optimize of levels(2, 3, 'size')) {
      const f = run(src, { optimize }).f
      for (const flag of [0, 0, 1, 0]) is(f(flag), js(flag), `reset=${reset}, O${optimize}`)
    }
    if (!onKernel() && !belowOpt(2)) {
      const wat = compile(src, { wat: true, optimize: { level: 2, watr: false, wideAccumulator: false } })
      const body = findFunc(parseWat(wat), '$f')
      const guards = count(body, n => n[0] === 'f64.ne' && n[2]?.[0] === 'f64.const' && n[2][1] === 'inf')
      is(guards === 0, reset, 'only a dominating reset permits removal of the infinity guard')
    }
  }
})

test('a comma step in statement position emits one write per counter', () => {
  // `j++, k += 2` computes no value: two plain writes, not a value block whose value is
  // dropped (the stack form that hid the counters from the loop scaffolds).
  const src = `export let f = (a, n) => { let s = 0; for (let j = 0, k = 0; j < n; j++, k += 2) s += a[k] + j; return s }`
  if (!onKernel() && !belowOpt(2)) {
    const wat = compile(src, { wat: true, optimize: { level: 2, watr: false } })
    is(/\(drop\s*\(i32\.sub\s*\(local\.tee/.test(wat), false, 'no dropped postfix value')
    is(/\(block\s*\(result i32\)\s*\(drop/.test(wat), false, 'no value block around the step')
  }
  const js = oracle(src).f
  for (const optimize of levels(0, 2, 3, 'size')) is(run(src, { optimize }).f([1, 2, 3, 4, 5, 6, 7], 3), js([1, 2, 3, 4, 5, 6, 7], 3), `O${optimize}`)
})

test('fractional recurrence bounds read the counter hull: strided steps and guard-bounded trip counts', () => {
  // One derivation of the counter's facts (the emitter's, on the lowering link) bounds any
  // counted loop whose hull is known: a step of 2, a runtime bound a guard caps.
  const sources = [
    `export function f(flag){let p=1,s=0;for(let k=0;k<1000;k+=2){s+=p|0;p+=0.75}return [s,p,flag?(p|0):9]}`,
    `export function f(flag,n){if(n>5000||n<0)return [0];let p=1,s=0;for(let k=0;k<n;k++){s+=p|0;p+=0.75}return [s,p,flag?(p|0):9]}`,
  ]
  for (const src of sources) {
    const js = oracle(src).f
    for (const optimize of levels(0, 2, 3, 'size')) {
      const f = run(src, { optimize }).f
      for (const [flag, n] of [[0, 0], [1, 4999], [0, 17], [1, 5000], [0, -1]]) is(f(flag, n), js(flag, n), `O${optimize}, flag=${flag}, n=${n}`)
    }
    if (!onKernel() && !belowOpt(2)) {
      const wat = compile(src, { wat: true, optimize: { level: 2, watr: false, wideAccumulator: false } })
      const guards = count(findFunc(parseWat(wat), '$f'), n => n[0] === 'f64.ne' && n[2]?.[0] === 'f64.const' && n[2][1] === 'inf')
      is(guards, 0, 'the counted recurrence drops its infinity guards')
    }
  }
})

test('fractional recurrence proofs reject unknown entries, multiple writes and skipped counter steps', () => {
  const sources = [
    `export function f(p){let s=0;for(let i=0;i<5;i++){s+=p|0;p+=0.25}return [s,p]}`,
    `export function f(p){let s=0,x=1;for(let i=0;i<5;i++){s+=x|0;x+=0.25;x=p}return [s,x]}`,
    `export function f(p){let s=0,x=1,i=0,skip=0;while(i<5){s+=x|0;x+=0.25;if(!skip){skip=1;continue}i++}return [s,x]}`,
  ]
  for (const src of sources) {
    const js = oracle(src).f
    for (const optimize of levels(0, 2, 3, 'size')) {
      const f = run(src, { optimize }).f
      for (const p of [0, 0, Infinity, -Infinity, NaN, 2.75, 0]) is(f(p), js(p), `O${optimize}, input=${p}`)
    }
  }
})

test('bounded fractional indices retain their original property keys', () => {
  const src = `export function f(){const a={};a[0.25]=7;a[0.75]=9;
    let p=0.25,s=0;for(let i=0;i<63;i++){s+=a[p]||0;p+=0.5}return [s,p]}`
  const js = oracle(src).f
  for (const optimize of levels(0, 2, 3, 'size')) {
    const f = run(src, { optimize }).f
    is(f(), js(), `O${optimize}`)
    is(f(), js(), `O${optimize}, repeated call`)
  }
})

test('fractional recurrence IR uses trip bounds or finite steps and rejects numeric aliases', () => {
  // The count of passes is the loop's lowering-link fact (loopFacts, src/compile/loop-model.js):
  // Without one, constant-step rounding still proves a finite magnitude enclosure.
  for (const mode of ['bounded', 'alias', 'unlinked']) {
    const fn = parseWat(`(func $f (export "f") (param $again i32) (result i32)
      (local $p f64) (local $i i32) (local $s i32) (local $t f64)
      (local.set $p (f64.const 0.25))
      (block $exit (loop $loop
        (br_if $exit (i32.eqz (i32.lt_s (local.get $i) (i32.const 3))))
        (local.set $s (i32.add (local.get $s)
          (select (i32.wrap_i64 (i64.trunc_sat_f64_s (local.tee $t (local.get $p))))
            (i32.const 0) (f64.ne (local.get $t) (f64.const inf)))))
        (local.set $s (i32.add (local.get $s)
          (select (i32.wrap_i64 (i64.trunc_sat_f64_s (local.get $t)))
            (i32.const 0) (f64.ne (local.get $t) (f64.const inf)))))
        ${mode === 'alias' ? '(local.set 1 (f64.const inf))' : ''}
        (local.set $p (f64.add (local.get $p) (f64.const 0.5)))
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $loop)))
      (local.get $s))`)
    walk(fn, n => {
      if ((n[0] === 'f64.const' || n[0] === 'i32.const') && Number.isFinite(Number(n[1]))) n[1] = Number(n[1])
      if (n[0] === 'local.set' && n[1] === '1') n[1] = 1
    })
    const instantiate = f => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(['module', f]))).exports.f
    const before = instantiate(fn)
    // the facts the pass is handed: each emitted loop's block → what the emitter proved of it
    const links = new WeakMap()
    if (mode !== 'unlinked') walk(fn, n => {
      if (n[0] === 'block' && n[1] === '$exit')
        links.set(n, { plan: { hull: { lo: 0, hi: 2 }, step: 1 }, lowering: { ivName: 'i', guardName: 'i' } })
    })
    fusedRewrite(fn, false, true, links)
    const after = instantiate(fn)
    for (const again of [0, 0, 1, 0]) is(after(again), before(again), `${mode}, again=${again}`)
    const guards = count(fn, n => n[0] === 'f64.ne')
    is(guards === 0, mode !== 'alias', 'trip bounds and finite steps drop guards; numeric aliases retain them')
  }
})

// ── Loop induction strength-reduction (i%w / (i/w)|0 → i32 counters) ──
// src/compile/loop-divmod.js. The pass must be bit-exact vs disabled, for ALL
// w including 0 and negative (the `w>0` guard falls back to the original loop).
const lsrOn = (src) => run(src, { optimize: 'speed' }).f
const lsrOff = (src) => run(src, { optimize: { level: 'speed', loopIVDivMod: false } }).f
const lsrDims = (on, off) => {
  for (const w of [1, 2, 3, 7, 16, 160, 0, -2, -3]) for (const h of [0, 1, 3, 8, -3]) is(on(w, h), off(w, h), `w=${w} h=${h}`)
}

test('loop-SR: grid kernel (both i%w and (i/w)|0) is bit-exact ON vs OFF across dims', () => {
  const src = `export let f=(w,h)=>{ let n=w*h,i=0,a=0; while(i<n){ let x=i%w; let y=(i/w)|0; a=(a*31 + x*7 + y*13)|0; i++ } return a|0 }`
  lsrDims(lsrOn(src), lsrOff(src))
})

test('loop-SR: fires (counter local emitted at speed, absent when disabled)', () => {
  if (onKernel()) return
  const src = `export let f=(w,h)=>{ let n=w*h,i=0,a=0; while(i<n){ let x=i%w; let y=(i/w)|0; a=(a+x+y)|0; i++ } return a|0 }`
  // Local coalescing can reuse the original iv's name for a new counter.
  // Pin the work removed from the fast loop, independent of local spelling.
  const loops = optimize => {
    const found=[]
    const fn=parse(src,optimize).find(n=>n?.[0]==='func' && n.some(x=>x?.[0]==='export' && x[1]==='"f"'))
    walk(fn, n => { if(n[0]==='loop') found.push(n) })
    return found
  }
  const divisions = loop => count(loop,n=>/^(?:f64|i32|i64)\.(?:div|rem)/.test(n[0]) || n[0]==='call' && /__rem/.test(n[1]))
  const on=loops('speed'),off=loops({level:'speed',loopIVDivMod:false})
  ok(on.some(loop=>divisions(loop)===0 && count(loop,n=>n[0]==='i32.add')>0),'fast loop advances counters without division or remainder')
  ok(off.length>0 && off.every(loop=>divisions(loop)>0),'disabled transform keeps division/remainder in every loop')

})

test('loop-SR: w==0 with a w-independent bound (exposes i%0=NaN) falls back, stays exact', () => {
  const src = `export let f=(w,h)=>{ let n=h,i=0,a=0; while(i<n){ let x=i%w; a=(a*31 + x*7)|0; i++ } return a|0 }`
  lsrDims(lsrOn(src), lsrOff(src))
})

test('loop-SR: only-mod, only-div, and non-zero start i0 each bit-exact', () => {
  for (const src of [
    `export let f=(w,h)=>{ let n=w*h,i=0,a=0; while(i<n){ let x=i%w; a=(a+x)|0; i++ } return a|0 }`,
    `export let f=(w,h)=>{ let n=w*h,i=0,a=0; while(i<n){ let y=(i/w)|0; a=(a+y)|0; i++ } return a|0 }`,
    `export let f=(w,h)=>{ let n=w*h,i=3,a=0; while(i<n){ let x=i%w; let y=(i/w)|0; a=(a*31 + x + y)|0; i++ } return a|0 }`,
  ]) lsrDims(lsrOn(src), lsrOff(src))
})

test('loop-SR: bails safely (ON==OFF) on continue / w-mutation / non-unit step', () => {
  for (const src of [
    `export let f=(w,h)=>{ let n=w*h,i=0,a=0; while(i<n){ if((i&7)===0){i++;continue} let x=i%w; a=(a+x)|0; i++ } return a|0 }`,
    `export let f=(w,h)=>{ let n=w*h,i=0,a=0; while(i<n){ let x=i%w; a=(a+x)|0; w=w+1; i++ } return a|0 }`,
    `export let f=(w,h)=>{ let n=w*h,i=0,a=0; while(i<n){ let x=i%w; a=(a+x)|0; i=i+2 } return a|0 }`,
  ]) for (const w of [3, 7, 16, 0, -2]) for (const h of [3, 8]) is(lsrOn(src)(w, h), lsrOff(src)(w, h))
})

test('loop-SR: workflow-found — negative IV start / negative non-multiple start / closure-mutated divisor stay exact', () => {
  // Adversarial cases the 8-family verification surfaced: a negative starting IV makes
  // i%w negative (JS modulo takes the dividend sign) — caught by the `i>=0` guard; a
  // closure mutating w from outside the loop — caught by the closure-mutation bail.
  for (const src of [
    `export let f=(w,h)=>{ let n=w*h,i=-3,a=0; while(i<n){ let x=i%w; let y=(i/w)|0; a=(a*31+x*7+y)|0; i++ } return a|0 }`,
    `export let f=(w,h)=>{ let n=w*h,i=-w,a=0; while(i<n){ let x=i%w; a=(a*31+x)|0; i++ } return a|0 }`,
    `export let f=(w,h)=>{ let n=w*h,i=-w*2,a=0; while(i<n){ let x=i%w; a=(a*31+x)|0; i++ } return a|0 }`,
    `export let f=(w,h)=>{ let n=w*h,i=0,a=0; let dec=()=>{w=w-1}; while(i<n){ let x=i%w; a=(a*31+x)|0; if((i&3)===0)dec(); i++ } return a|0 }`,
    `export let f=(w,h)=>{ let n=w*h,i=0,a=0; let mutW=null; mutW=()=>{w=w-1}; while(i<n){ let x=i%w; a=(a*31+x)|0; mutW(); i++ } return a|0 }`,
  ]) for (const w of [2, 3, 5, 7, 16, 0, -2, -3]) for (const h of [1, 3, 8]) is(lsrOn(src)(w, h), lsrOff(src)(w, h), `w=${w} h=${h}`)
})

test('loop-SR: fractional, wide and signed-zero inputs preserve Number semantics and effects', () => {
  const src = `export function f(start,n,w) {
    let i=start,a=0,last=0
    while(i<n) { let x=i%w; let y=(i/w)|0; last=x; a=(a+x+y)|0; i++ }
    return [a,i,last,1/last]
  }`
  const cases=[[0,6,1.5],[0,10,2.5],[0,2,.5],[0,5,3],[0,5,3],
    [-0,1,2],[.5,3,2],[-2,2,3],[2147483646,2147483649,3],
    [4294967294,4294967297,3],[0,4,4294967296],[0,4,0],[0,4,NaN],[0,4,Infinity],[1,0,2],[0,5,3]]
  for(const compare of ['<','<=']) {
    const source=src.replace('i<n',`i${compare}n`), expected=oracle(source)
    for(const optimize of levels(0,1,2,3,'size')) {
      const actual=run(source,{optimize})
      for(const args of cases) is(actual.f(...args),expected.f(...args),`${compare}, O${optimize}: ${args}`)
    }
  }
  const effect = `export function f(n,kind) {
    let calls=0, sum=0
    const o={valueOf(){calls++;return 2}}
    let w=kind===1?o:2, i=kind===2?o:0, end=kind===3?o:n
    while(i<end){let x=i%w;let y=(i/w)|0;sum=(sum+x+y)|0;i++}
    return [sum,calls]
  }`
  const ref=oracle(effect)
  for(const optimize of levels(0,1,2,3,'size')) {
    const actual=run(effect,{optimize})
    for(const args of [[0,1],[4,1],[4,2],[0,2],[4,3],[0,1]])
      is(actual.f(...args),ref.f(...args),`O${optimize}: coercion ${args}`)
  }
})

test('loop-SR: escaped reads and callee writes keep the original counter domain', () => {
  const cases=[
    `export function f(){let i=0,w=2;const out=[];while(i<3){out.push(()=>i%w);i++}w=3;return out[0]()}`,
    `let w=2;function change(){w=3}export function f(){w=2;let i=0,s=0;while(i<4){let x=i%w;s+=x;change();i++}return s}`,
    `let n=4;function change(){n=2}export function f(){n=4;let i=0,w=2,s=0;while(i<n){let x=i%w;s+=x;change();i++}return s}`,
  ]
  for(const src of cases) for(const optimize of levels(0,1,2,3,'size')) {
    const actual=run(src,{optimize:{level:optimize,sourceInline:false}}),expected=oracle(src)
    for(let repeat=0;repeat<2;repeat++)is(actual.f(),expected.f(),`O${optimize}, repeat=${repeat}`)
  }
})

// A dividend affine in a `for` counter, ascending or descending, through a `const` the
// body declares: its floored quotient and remainder step with the counter.
const loopDivisions = (src, optimize) => {
  const fn = parse(src, optimize).find(n => n?.[0] === 'func' && n.some(x => x?.[0] === 'export' && x[1] === '"f"'))
  const loops = []
  walk(fn, n => { if (n[0] === 'loop') loops.push(n) })
  return loops.map(loop => count(loop, n => /^(?:f64|i32|i64)\.(?:div|rem)/.test(n[0]) || n[0] === 'call' && /__rem/.test(n[1])))
}
test('loop-SR: affine dividends of a for counter are bit-exact ON vs OFF and divide nowhere in the copy', () => {
  const kernels = {
    // a deinterleave's source index: `(i % seg) * ch + ~~(i / seg)`
    deinterleave: `export let f=(n,w)=>{ let a=0; for(let i=0;i<n;i++){ const si=(i%w)*3+~~(i/w); a=(a*31+si)|0 } return a|0 }`,
    // a polyphase gather: a descending dividend, its quotient exact under the remainder test
    gather: `export let f=(n,w,base)=>{ let s=0; for(let k=0;k<n;k++){ const e=base-k; if(e>=0 && e%w===0){ const x=e/w; s=(s*31+x)|0 } } return s|0 }`,
    // floors of a dividend crossing zero
    floor: `export let f=(n,w,base)=>{ let s=0; for(let k=0;k<n;k++) s=(s*31+Math.floor((k-base)/w)+(((k-base)%w)===0?7:0))|0; return s|0 }`,
  }
  const off = { level: 'speed', loopIVDivMod: false }
  for (const [name, src] of Object.entries(kernels)) {
    const on = run(src, { optimize: 'speed' }).f, ref = run(src, { optimize: off }).f, js = oracle(src).f
    for (const w of [1, 2, 3, 7, 16, 0, -3, 2.5, NaN]) for (const n of [0, 1, 5, 40]) for (const base of [0, 9, 31, -4]) {
      is(on(n, w, base), js(n, w, base), `${name}: n=${n} w=${w} base=${base}`)
      is(on(n, w, base), ref(n, w, base), `${name} ON==OFF: n=${n} w=${w} base=${base}`)
    }
    if (onKernel()) continue
    ok(loopDivisions(src, 'speed').some(d => d === 0), `${name}: a loop of the copy divides nowhere`)
    ok(loopDivisions(src, off).every(d => d > 0), `${name}: disabled, every loop divides`)
  }
})

// The copy steps its counters by a branch: a pass carries the remainder's `+ 1` alone, the
// wrap a test the predictor answers once in w passes; a select would carry the test and its choice.
test('loop-SR: the copy steps its counters by a branch, not a select', () => {
  if (onKernel()) return
  const src = `export let f=(n,w)=>{ let a=0; for(let i=0;i<n;i++){ const si=(i%w)*3+~~(i/w); a=(a*31+si)|0 } return a|0 }`
  const fn = parse(src, 'speed').find(n => n?.[0] === 'func' && n.some(x => x?.[0] === 'export' && x[1] === '"f"'))
  const copies = []
  walk(fn, n => { if (n[0] === 'loop' && count(n, m => /^(?:f64|i32|i64)\.(?:div|rem)/.test(m[0]) || m[0] === 'call' && /__rem/.test(m[1])) === 0) copies.push(n) })
  ok(copies.length > 0, 'a loop of the copy divides nowhere')
  ok(copies.every(loop => count(loop, n => n[0] === 'select') === 0 && count(loop, n => n[0] === 'if') > 0), 'its counters step in the arms of a test, no select')
})

// A pass the remainder test turns away does nothing, so the copy runs only the passes it
// admits: the counter starts where the dividend first divides and steps by the divisor.
test('loop-SR: a loop guarded by a divisibility test steps from one admitted pass to the next', () => {
  const kernels = {
    // the upsampling gather of a resampler (upfirdn): a descending dividend, the quotient its index
    gather: `export let f=(n,w,base,from)=>{ let s=0;
      for(let k=from;k<n;k++){ const e=base-k; if(e>=0 && e%w===0){ const x=e/w; s=s*1.5+((k&7)-3)*(x+1) } } return s }`,
    // an ascending dividend, a bound tested with <=, the remainder test first
    rising: `export let f=(n,w,base,from)=>{ let s=0; for(let k=from;k<=n;k++){ const e=k+base; if(e%w===0 && e>-50){ s=(s*31+(e/w)+k)|0 } } return s }`,
    // a decimation's every-w-th pass and a break out of it
    stop: `export let f=(n,w,base,from)=>{ let s=0; for(let k=from;k<n;k++){ if((k-base)%w===0){ s=(s*7+k)|0; if(s>1e6) break } } return s }`,
  }
  const off = { level: 'speed', loopIVDivMod: false }
  for (const [name, src] of Object.entries(kernels)) {
    const on = run(src, { optimize: 'speed' }).f, ref = run(src, { optimize: off }).f, js = oracle(src).f
    for (const w of [1, 2, 3, 5, 16, 0, -3, 2.5, NaN]) for (const n of [0, 1, 12, 40]) for (const base of [0, 9, 31, -4, -40]) for (const from of [0, 3, -7]) {
      is(on(n, w, base, from), js(n, w, base, from), `${name}: n=${n} w=${w} base=${base} from=${from}`)
      is(on(n, w, base, from), ref(n, w, base, from), `${name} ON==OFF: n=${n} w=${w} base=${base} from=${from}`)
    }
    // a counter or a stride past the int32 range runs the loop as written
    for (const [n, w, base, from] of [[2147483647, 7, 2147483640, 2147483600], [2147483647, 2147483000, 5, 2147483640], [-2147483600, 3, 0, -2147483648]])
      is(on(n, w, base, from), js(n, w, base, from), `${name}: wide n=${n} w=${w} base=${base} from=${from}`)
    if (onKernel()) continue
    // the copy's loop steps its counter by the divisor and tests no remainder
    const fn = parse(src, 'speed').find(m => m?.[0] === 'func' && m.some(x => x?.[0] === 'export' && x[1] === '"f"'))
    const loops = []
    walk(fn, m => { if (m[0] === 'loop') loops.push(m) })
    const strided = loops.filter(loop => count(loop, m => /^(?:f64|i32|i64)\.(?:div|rem)/.test(m[0]) || m[0] === 'call' && /__rem/.test(m[1])) === 0 &&
      count(loop, m => m[0] === 'i32.add' && m[1]?.[0] === 'local.get' && m[2]?.[0] === 'local.get') > 0 && count(loop, m => m[0] === 'if' && m.some(c => c?.[0] === 'else')) === 0)
    ok(strided.length > 0, `${name}: a loop of the copy strides`)
  }
  // a pass that does something whatever the remainder, or reads a value of no known kind ahead of the test, keeps every pass
  for (const src of [
    `export let f=(n,w,base)=>{ let s=0,c=0; for(let k=0;k<n;k++){ c++; const e=base-k; if(e>=0 && e%w===0) s=(s*31+e/w+c)|0 } return s }`,
    `export let f=(n,w,base,o)=>{ let s=0; for(let k=0;k<n;k++){ const e=base-k; if(o.t>k && e%w===0) s=(s*31+e/w)|0 } return s }`,
  ]) {
    if (onWasi() && src.includes('o.t')) continue  // wasi: a host object's field
    const on = run(src, { optimize: 'speed' }).f, js = oracle(src).f
    for (const w of [1, 3, 0, -2]) for (const n of [0, 9, 40]) is(on(n, w, 30, { t: 20 }), js(n, w, 30, { t: 20 }), `kept: n=${n} w=${w}`)
  }
})

test('loop-SR: a for loop with continue, a written divisor or a closure keeps its divisions (ON==OFF)', () => {
  for (const src of [
    `export let f=(n,w)=>{ let a=0; for(let i=0;i<n;i++){ if((i&3)===1) continue; a=(a*31+i%w+~~(i/w))|0 } return a|0 }`,
    `export let f=(n,w)=>{ let a=0; for(let i=0;i<n;i++){ a=(a*31+i%w)|0; if(i===3) w=w+1 } return a|0 }`,
    `export let f=(n,w)=>{ let a=0; const bump=()=>{w++}; for(let i=0;i<n;i++){ a=(a*31+i%w)|0; if(i===2) bump() } return a|0 }`,
  ]) {
    const on = run(src, { optimize: 'speed' }).f, js = oracle(src).f
    for (const w of [2, 3, 7, 0, -2]) for (const n of [0, 3, 9]) is(on(n, w), js(n, w), `n=${n} w=${w}`)
  }
})

// A non-negative word's remainder by a positive runtime word divides only past twice the
// divisor: a ring's `(p + 1) % m` is its dividend below m, or m itself at the wrap.
test('remainder: a word by a positive runtime word tests before it divides, exact', () => {
  const src = `export let f=(n,k)=>{ const m=(k&63)+1; let s=0; for(let i=0;i<n;i++) s=(s*7+(i&1023)%m)|0; return s }`
  const js = oracle(src).f
  for (const optimize of levels(1, 2, 3, 'speed')) {
    const f = run(src, { optimize }).f
    for (const k of [0, 1, 2, 15, 16, 63, 64, -1]) for (const n of [0, 1, 15, 16, 17, 100, 2100]) is(f(n, k), js(n, k), `O${optimize}: n=${n} k=${k}`)
  }
  if (onKernel()) return
  const fn = parse(src, 'speed').find(n => n?.[0] === 'func' && n.some(x => x?.[0] === 'export' && x[1] === '"f"'))
  let guarded = 0, bare = 0
  walk(fn, n => {
    if (n[0] === 'if' && n.some(c => c?.[0] === 'else' && JSON.stringify(c).includes('"i32.rem_'))) guarded++
    if (n[0] === 'i32.rem_s' || n[0] === 'i32.rem_u') bare++
  })
  ok(guarded > 0 && bare > 0, 'the remainder sits in the arm past 2m, behind the tests')
})

// ── Array-recurrence unroll (arr[j-1]/arr[j] DP/scan → scalar carry + ×2 unroll) ──
// src/compile/loop-recurrence.js. Must be bit-exact vs disabled across ALL trip counts
// (empty range / 1 / odd / even — the guard + 1-cell tail), and bail (ON==OFF) on any shape
// it must not transform (non-unit step, an aliasing index, a call in the body); a break
// in the body leaves the pair loop as it leaves the loop.
const recOn = (src) => run(src, { optimize: 'speed' }).f
// A counter declared outside the `for` and assigned by its init, read nowhere else, is the
// loop's own (plan/counted-loops.js adoptLoopCounters): the same loop as `for (let i …)`.
test('counted loops: a counter declared outside the for is the loop\'s own', () => {
  const inside = 'export let f = (n) => { let a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = a[i] * 2 + 1; return a[n - 1] }'
  const outside = 'export let f = (n) => { let a = new Float64Array(n); let i = 0; for (i = 0; i < n; i++) a[i] = a[i] * 2 + 1; return a[n - 1] }'
  const after = 'export let f = (n) => { let a = new Float64Array(n); let i = 0; for (i = 0; i < n; i++) a[i] = a[i] * 2 + 1; return a[n - 1] + i }'
  for (const optimize of ownedLevels(2, 3)) {
    ok(/v128/.test(compile(outside, { optimize, wat: true })), 'O' + optimize + ': the loop vectorizes as the one declaring its counter does')
    is(run(outside, { optimize }).f(7), run(inside, { optimize }).f(7), 'O' + optimize + ': the same result')
    is(run(after, { optimize }).f(7), 8, 'O' + optimize + ': a counter read after the loop stays outside: ' + 8)
  }
  // A module binding is read outside the function: the loop counts with it, as written.
  const shared = 'let i = 0\nexport let f = (n) => { for (i = 0; i < n; i++); return 0 }\nexport let g = () => i'
  for (const optimize of ownedLevels(0, 2, 3)) {
    const e = run(shared, { optimize })
    e.f(5)
    is(e.g(), 5, 'O' + optimize + ': a module counter keeps the loop\'s writes: 5')
  }
})

test('rec-unroll: an empty statement in a body is no loop', () => {
  const body = [';', null]
  is(unrollRecurrence(body, new Set()), body, 'the body stays as it is')
})
const recOff = (src) => run(src, { optimize: { level: 'speed', unrollRecurrence: false } }).f

test('rec-unroll: DP recurrence (arr[j-1]→arr[j]) bit-exact ON vs OFF across trip counts', () => {
  for (const src of [
    // single recurrence array, a carried scalar (diag-style), a branch on the IV
    `export let f=(n)=>{ const a=new Int32Array(70); for(let k=0;k<70;k++)a[k]=(k*7)%13|0; let acc=0|0; for(let r=0;r<4;r++){ for(let j=1;j<=n;j++){ const up=a[j]; const ins=a[j-1]+1; let m=up+1; if(ins<m)m=ins; if((r^j)&1)m=m+2; a[j]=m } acc=(acc*31 + a[60])|0 } return acc|0 }`,
    // recurrence array PLUS a second read-only array (must stay a plain load, not get forwarded)
    `export let f=(n)=>{ const a=new Int32Array(70),o=new Int32Array(70); for(let k=0;k<70;k++){a[k]=k|0;o[k]=(k*3)%7|0} let s=0|0; for(let j=1;j<=n;j++){ const t=(a[j-1]+o[j-1])|0; a[j]=t; s=(s+t)|0 } return s|0 }`,
  ]) { const on = recOn(src), off = recOff(src); for (const n of [0, 1, 2, 3, 4, 5, 8, 13, 32, 60]) is(on(n), off(n), `n=${n}`) }
})

// The carry is what a read of the stored element returns: the store's conversion to the
// element type (a Float32Array rounds, an Int32Array wraps), not the value stored.
test('rec-unroll: the carry takes the element type\'s conversion', () => {
  for (const src of [
    `export let f=(n)=>{ const a=new Float32Array(70); a[0]=0.1; for(let j=1;j<=n;j++){ const t=a[j-1]*1.1; a[j]=t } let s=0; for(let k=0;k<70;k++)s=s+a[k]; return s }`,
    `export let f=(n)=>{ const a=new Int32Array(70); a[0]=1000000000; for(let j=1;j<=n;j++){ const t=a[j-1]*1.5; a[j]=t } return a[n] }`,
    `export let f=(n)=>{ const a=new Uint16Array(70); a[0]=1000; for(let j=1;j<=n;j++){ const t=a[j-1]*1.7+0.5; a[j]=t } return a[n] }`,
    `export let f=(n)=>{ const a=new Int8Array(70); a[0]=3; for(let j=1;j<=n;j++){ const t=a[j-1]*2.5; a[j]=t } return a[n] }`,
    // an element type whose conversion has no source form keeps its loop
    `export let f=(n)=>{ const a=new Uint8ClampedArray(70); for(let j=1;j<=n;j++){ const t=a[j-1]+100.5; a[j]=t } let s=0; for(let k=0;k<70;k++)s=(s*31+a[k])|0; return s }`,
  ]) {
    const host = oracle(src).f
    for (const optimize of ownedLevels('speed', 2)) { const f = run(src, { optimize }).f; for (const n of [0, 1, 2, 3, 10, 60]) is(f(n), host(n), `O${optimize} n=${n}`) }
  }
})

// A stored value other than a name (`a[i] = a[i - 1] + …`, a prefix sum or a one-pole filter),
// a Math call in the body: the store's value is named, and the read of the previous cell carried.
test('rec-unroll: a recurrence storing an expression carries it, a Math call notwithstanding', () => {
  for (const src of [
    `export let f=(n)=>{ const a=new Float64Array(70), x=new Float64Array(70); a[0]=0.5; for(let k=0;k<70;k++)x[k]=k*0.25; for(let j=1;j<=n;j++){ a[j]=a[j-1]*0.9+Math.sqrt(x[j]) } return a[n] }`,
    `export let f=(n)=>{ const a=[]; for(let k=0;k<70;k++)a.push(k&3); for(let j=1;j<=n;j++){ a[j]=a[j-1]+j } return a[n] }`,
  ]) {
    const host = oracle(src).f, on = recOn(src), off = recOff(src)
    for (const n of [0, 1, 2, 3, 4, 5, 8, 13, 60]) { is(on(n), host(n), `n=${n}`); is(on(n), off(n), `n=${n} on = off`) }
  }
  if (onKernel()) return
  const src = `export let f=(n)=>{ const u=new Float64Array(70), x=new Float64Array(70); for(let k=0;k<70;k++)x[k]=k; for(let j=1;j<n;j++){ const d=x[j]-x[j-1]; u[j]=u[j-1]+Math.sqrt(d*d+1) } return u[n-1] }`
  compileInProcess(src, { optimize: 'speed' })
  let carried = false
  walkAst(ctx.funcs.list.find(f => f.name === 'f').body, { enter: n => { if ((n[0] === 'let' || n[0] === 'const') && n.slice(1).some(d => Array.isArray(d) && typeof d[1] === 'string' && d[1].startsWith('u' + T) && /rec\d+$/.test(d[1]))) carried = true } })
  ok(carried, 'the previous cell is a carried local')
})

test('rec-unroll: bails (ON==OFF) on non-unit step / aliasing index / call in body, pairs a body with a break', () => {
  for (const src of [
    `export let f=(n)=>{ const a=new Int32Array(70); for(let k=0;k<70;k++)a[k]=k|0; for(let j=1;j<=n;j+=2){ a[j]=a[j-1]+1 } return a[60]|0 }`,
    `export let f=(n)=>{ const a=new Int32Array(70); for(let k=0;k<70;k++)a[k]=k|0; for(let j=1;j<n;j++){ a[j]=(a[j-1]+a[j+1])|0 } return a[60]|0 }`,
    `export let f=(n)=>{ const a=new Int32Array(70); for(let k=0;k<70;k++)a[k]=k|0; for(let j=1;j<=n;j++){ if(j===5)break; a[j]=a[j-1]+1 } return a[60]|0 }`,
    // recurrence read AFTER the store (carry would be stale) — must bail, not miscompile
    `export let f=(n)=>{ const a=new Int32Array(70); for(let k=0;k<70;k++)a[k]=k|0; let acc=0|0; for(let j=1;j<=n;j++){ const t=(a[j-1]+1)|0; a[j]=t; acc=(acc+a[j-1])|0 } return acc|0 }`,
    // loop bound mutated in the body (×2 stride would overshoot) — must bail
    `export let f=(n)=>{ const a=new Int32Array(70); for(let k=0;k<70;k++)a[k]=k|0; let hi=n; for(let j=1;j<=hi;j++){ const t=(a[j-1]+1)|0; a[j]=t; if(j>30)hi=(hi-1)|0 } return a[60]|0 }`,
  ]) for (const n of [0, 1, 2, 3, 8, 13, 40]) is(recOn(src)(n), recOff(src)(n), `n=${n}`)
})

// The recurrence pair and the serial-chain pair start the counter where the loop's
// head does: another declaration of the head may move it or name what the body reads.
test('rec-unroll and chain unroll: the counter starts where the whole head leaves it', () => {
  for (const src of [
    `export let f=(n)=>{ const a=new Float64Array(n); a[0]=100; a[1]=7; for(let j=1,c=(j=2);j<n;j++){ const v=a[j-1]+1; a[j]=v } return a[n-1] }`,
    `export let f=(n)=>{ const b=new Uint8Array(n); for(let k=0;k<n;k++)b[k]=k+1; const t=new Int32Array(256); for(let k=0;k<256;k++)t[k]=k*3+1; let crc=0; for(let i=3,c=(i=0);i<n;i++){ crc=t[(crc^b[i])&255]^(crc>>>8) } return crc }`,
    `export let f=(n)=>{ const b=new Uint8Array(n); for(let k=0;k<n;k++)b[k]=k+1; const t=new Int32Array(256); for(let k=0;k<256;k++)t[k]=k*3+1; let crc=0; for(let i=0,m=255;i<n;i++){ crc=t[(crc^b[i])&m]^(crc>>>8) } return crc }`,
  ]) {
    const host = oracle(src).f
    for (const optimize of ownedLevels(2, 3, 'speed')) { const f = run(src, { optimize }).f; for (const n of [6, 9]) is(f(n), host(n), `O${optimize} n=${n}`) }
  }
})

test('rec-unroll: fires (carry declared at speed, absent when disabled)', () => {
  if (onKernel()) return  // host-codegen SHAPE assertion; bit-exactness above is portable
  const src = `export let f=(n)=>{ const a=new Int32Array(70); for(let k=0;k<70;k++)a[k]=k|0; for(let j=1;j<=n;j++){ const up=a[j]; const ins=a[j-1]+1; let m=up+1; if(ins<m)m=ins; a[j]=m } return a[60]|0 }`
  // the carry is declared after its array (`a` + the renaming separator + `rec<id>`) in the planned
  // body (the sums' copy reads it through a declaration of its own, which the optimizer may fold)
  const carried = (optimize) => {
    compileInProcess(src, { optimize })
    let found = false
    walkAst(ctx.funcs.list.find(f => f.name === 'f').body, { enter: n => { if ((n[0] === 'let' || n[0] === 'const') && n.slice(1).some(d => Array.isArray(d) && typeof d[1] === 'string' && d[1].startsWith('a' + T) && /rec\d+$/.test(d[1]))) found = true } })
    return found
  }
  ok(carried('speed'), 'carry present')
  ok(!carried({ level: 'speed', unrollRecurrence: false }), 'absent when off')
})

test('rec-unroll: the pair loop computes in integers (the plan sweep declares the carry, the summary kinds it)', () => {
  if (onKernel() || belowOpt(2)) return
  // levenshtein's rolling row: `prev` an Int32Array, each cell carried to the next pair
  const src = `
    const LB = 64
    const dist = (a, b, prev) => {
      for (let j = 0; j <= LB; j++) prev[j] = j
      for (let i = 1; i <= LB; i++) {
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
      return prev[LB]
    }
    export let f = (seed) => {
      const a = new Uint8Array(LB), b = new Uint8Array(LB), prev = new Int32Array(LB + 1)
      let s = seed | 0
      for (let i = 0; i < LB; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; a[i] = s & 3; b[i] = (s >> 3) & 3 }
      return dist(a, b, prev)
    }`
  // (the loop as written, where a cell leaves the word, replaced by a trap: the copies remain)
  const wat = compile(src, { wat: true, optimize: { level: 'speed', coldTrap: true } })
  // (the kernel splices into its caller: its carry keeps the array's name)
  ok(/prev\S*rec\d+/.test(wat), 'the carry is declared after its array')
  // every loop over the row computes in integers: no float arithmetic, no truncation
  is(loopCount(parseWat(wat), n => /^(?:f64\.(?:add|sub|lt|gt|le|ge)|i64\.trunc|i32\.trunc|f64\.convert)/.test(n[0])), 0, 'no float arithmetic or conversion in the loops')
  const host = oracle(src).f
  for (const seed of [1, 7, 12345, -3]) is(run(src, { optimize: 'speed' }).f(seed), host(seed), `seed ${seed}`)
})

test('min recurrence (watr): a cell joins the input carried from the cell before it last', () => {
  if (onKernel() || belowOpt(2)) return
  // An integer min recurrence (an edit distance's cell: min(up + 1, left + 1, diag + cost)):
  // min commutes, so the input that carries the previous cell's result joins last and the
  // chain from cell to cell is an add, a compare and a select. watr's scheduler orders the
  // updates, following the carry through the copies the integral copy and the recurrence
  // pair make, in both cells of the pair (the second under the pair's test), whichever
  // order the source wrote them in.
  const src = (first, second) => `
    const LB = 64
    const dist = (a, b, prev) => {
      for (let j = 0; j <= LB; j++) prev[j] = j
      for (let i = 1; i <= LB; i++) {
        let diag = prev[0]
        prev[0] = i
        const ai = a[i - 1]
        for (let j = 1; j <= LB; j++) {
          const up = prev[j]
          const sub = diag + (ai === b[j - 1] ? 0 : 1)
          let m = up + 1
          const ins = prev[j - 1] + 1
          if (${first} < m) m = ${first}
          if (${second} < m) m = ${second}
          diag = up
          prev[j] = m
        }
      }
      return prev[LB]
    }
    export let f = (seed) => {
      const a = new Uint8Array(LB), b = new Uint8Array(LB), prev = new Int32Array(LB + 1)
      let s = seed | 0
      for (let i = 0; i < LB; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; a[i] = s & 3; b[i] = (s >> 3) & 3 }
      return dist(a, b, prev)
    }`
  // The two-deep integer min/max chains of each function, read in evaluation order: whether the
  // outer select takes the input the pair's carried cell (`…rec<N>`) reaches and the inner one an
  // input it does not.
  const chains = (tree) => {
    const out = []
    for (const fn of tree.filter(n => n?.[0] === 'func')) {
      const carried = new Map()
      const ev = (n) => {
        if (!Array.isArray(n)) return false
        if (n[0] === 'local.get') return /rec\d/.test(n[1]) || carried.get(n[1]) === true
        if (n[0] === 'local.set' || n[0] === 'local.tee') { const c = ev(n[2]); carried.set(n[1], c); return c }
        if (n[0] === 'select' && n[2]?.[0] === 'local.tee' && n[2][2]?.[0] === 'select' && /^i32\.[lg][te]_[su]$/.test(n[3]?.[0])) {
          const outer = ev(n[1]), inner = ev(n[2][2][1])
          out.push({ outer, inner })
        }
        let any = false
        for (let i = 1; i < n.length; i++) if (ev(n[i])) any = true
        return any
      }
      ev(fn)
    }
    return out
  }
  for (const [first, second] of [['ins', 'sub'], ['sub', 'ins']]) {
    const found = chains(parseWat(compile(src(first, second), { wat: true, optimize: { level: 'speed', coldTrap: true } })))
    is(found.filter(c => c.outer).length, 2, `${first} first: a chain in each cell of the pair`)
    for (const c of found) ok(c.outer && !c.inner, `${first} first: the carried input joins last`)
    const host = oracle(src(first, second)).f
    for (const seed of [1, 7, 12345, -3]) is(run(src(first, second), { optimize: 'speed' }).f(seed), host(seed), `${first} first: seed ${seed}`)
  }
})
