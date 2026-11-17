// Bounds-check versioning: the narrowed loop bound, the char-scan split, the clamp
// peel, guarded loop copies and nests, and the interval walk that proves their reads.
import test from 'tst'
import { almost, is, ok } from 'tst/assert.js'
import { onKernel, levels, belowOpt } from './_matrix.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { narrowLoopBound } from '../src/optimize/licm.js'
import { funcWat, run, oracle, jz, compile } from './util.js'
import { parse, count, walk } from '../scripts/wat-probe.mjs'
import { findFunc, preWatr, compileMain } from './_optimizer.js'

// Unknown Number bounds retain the original loop beside a range-guarded i32
// copy. Explicit word counters use exact wide thresholds in narrowLoopBound.

test('bounded loop copy: Number export-param bound compares in i32, trunc hoisted', () => {
  const body = compileMain(`
    export const main = (n) => {
      let s = 0
      for (let i = 0; i < n; i++) s += 1.5
      return s
    }
  `)
  ok(/trunc_sat_f64_s/.test(body) && /f64\.ceil/.test(body), 'bound rounds and converts before the fast loop')
  const loops = []
  const walk = n => { if (!Array.isArray(n)) return; if (n[0] === 'loop') loops.push(JSON.stringify(n)); else n.forEach(walk) }
  walk(parseWat(body))
  ok(loops.some(n => /i32\.lt_s/.test(n) && !/f64\.(lt|le|gt|ge|convert_i32)|trunc_sat/.test(n)), 'fast loop has no floating counter operation or repeated conversion')
  ok(loops.some(n => /f64\.lt/.test(n)), 'unbounded Numbers retain the original loop')
})

test('narrowLoopBound: unlocks lane-vectorizer for the naive (ptr, n) DSP shape', () => {
  const wat = compile(
    `export let sum = (ptr, n) => { let a = new Float64Array(ptr); let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s }`,
    { wat: true, optimize: 3, alloc: false },
  )
  ok(/f64x2\./.test(wat), 'naive f64-bound typed loop should vectorize without a hand-written |0')
})

test('narrowLoopBound: fractional / NaN / negative / zero bounds match JS', () => {
  const src = `export const main = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i + 1; return s }`
  const js = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i + 1; return s }
  const { main } = run(src)
  for (const n of [10, 5.5, 0.5, 1e-9, 0, -3, NaN]) is(main(n), js(n), `n=${n}`)
})

test('bounded loop copy: negative starts preserve NaN zero-work behavior', () => {
  // i ∈ [-2, …): with bound NaN the f64 compare is false at i=-2 (zero trips);
  // a naive i32 rewrite (NaN→0) would run two iterations.
  const src = `export const main = (n) => { let s = 0; for (let i = -2; i < n; i++) s += 1; return s }`
  const js = (n) => { let s = 0; for (let i = -2; i < n; i++) s += 1; return s }
  const { main } = run(src)
  for (const n of [NaN, -1, 0, 2.5, 3]) is(main(n), js(n), `n=${n}`)
})

// splitCharScan (charCodeAt iteration-range splitting)
// `for (i = 0; i < N; i++) … s.charCodeAt(i) …` with an arbitrary bound paid
// the OOB NaN arm per char (f64 carrier + f64 classifier compares).

test('splitCharScan: main loop narrows the char carrier to i32', () => {
  const wat = compile(`
    export let count = (s, n) => {
      let hits = 0
      for (let i = 0; i < n; i++) {
        const c = s.charCodeAt(i)
        if (c >= 48 && c <= 57) hits++
      }
      return hits
    }
  `, { wat: true, optimize: { watr: false } })
  // two loops (main + OOB tail), and the bound snap goes through math.min
  ok((wat.match(/\(loop /g) || []).length >= 2, 'loop split into main + tail')
  ok(/f64\.min|call \$math\.min/.test(wat), 'main bound is min(N, s.length)')
})

// The main loop's bound, `Math.min(n, s.length)`, has no hull below (n is any Number) but
// rises no further than a string's length, an i32 field: the counter is a word, and the
// char it reads is a raw word too (static.js topOf; lost between 8a84ee53 and 9b2826b7,
// when tokenizer ran its scan on a Number counter with the NaN arm per char).
test('splitCharScan: the main loop counts in a word and reads a raw char', () => {
  const wat = compile(`
    const count = (s, n) => {
      let hits = 0
      for (let i = 0; i < n; i++) {
        const c = s.charCodeAt(i)
        if (c >= 48 && c <= 57) hits++
      }
      return hits
    }
    export let main = (k) => count('a1b22c333', 9 - (k & 3))
  `, { wat: true, optimize: 'speed' })
  const fn = /\(func \$count[\s\S]*?\n  \)/.exec(wat)?.[0] ?? ''
  const first = fn.slice(fn.indexOf('(loop '), fn.indexOf('(loop ', fn.indexOf('(loop ') + 1))
  ok(/\(local \$i i32\)/.test(fn), 'the counter is a word')
  ok(first.length > 0 && !/nan:0x7FF8/.test(first), 'the main loop reads its char without the out-of-range arm')
  ok(/\(i32\.const 48\)/.test(first) && !/f64\.const 48/.test(first), 'the char is classified as a word')
  is(run(`export let main = (k) => { const s = 'a1b22c333'; let hits = 0; for (let i = 0; i < 9 - (k & 3); i++) { const c = s.charCodeAt(i); if (c >= 48 && c <= 57) hits++ } return hits }`, { optimize: 'speed' }).main(2), 4, 'the digits counted')
})

test('splitCharScan: integral / fractional / NaN / negative bounds match JS', () => {
  const src = `export let scan = (s, n) => {
    let h = 0
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i)
      h = (h * 31 + (c >= 65 ? 1 : c >= 48 ? 2 : 3)) | 0
    }
    return h
  }`
  const js = (s, n) => {
    let h = 0
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i)
      h = (h * 31 + (c >= 65 ? 1 : c >= 48 ? 2 : 3)) | 0
    }
    return h
  }
  const { scan } = run(src)
  const s = 'a1B2c3'
  // OOB region (n > length) exercises the tail's NaN classification (c≥… false → 3)
  for (const n of [0, 3, 6, 9, 4.5, 7.5, NaN, -1]) is(scan(s, n), js(s, n), `n=${n}`)
})

// The tail starts at the string's length (or runs no step): every character it reads
// is NaN, so it classifies nothing.
test('splitCharScan: the tail reads no character past a string\'s end', () => {
  const src = `
    const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95
    const scan = (src, len) => {
      let h = 0x811c9dc5 | 0, number = 0, inNumber = 0, inIdent = 0, tokens = 0
      for (let i = 0; i < len; i++) {
        const c = src.charCodeAt(i)
        if (c >= 48 && c <= 57) { number = ((number * 10) + (c - 48)) | 0; inNumber = 1 }
        else {
          if (inNumber) { h = Math.imul(h ^ number, 0x01000193); tokens++; number = 0; inNumber = 0 }
          if (isAlpha(c)) { if (!inIdent) { h = Math.imul(h ^ c, 0x01000193); tokens++ } inIdent = 1 }
          else { if (c > 32) { h = Math.imul(h ^ c, 0x01000193); tokens++ } inIdent = 0 }
        }
        { const c = 7; h = (h + c) | 0 }
      }
      if (inNumber) { h = Math.imul(h ^ number, 0x01000193); tokens++ }
      return Math.imul(h ^ tokens, 0x01000193) >>> 0
    }
    export let main = (n, k) => {
      let s = ''
      for (let i = 0; i < n; i++) s = s + 'let a_1 = b + 23; '
      return (scan(s, s.length + k) ^ scan(s, s.length - 1)) >>> 0
    }`
  const wat = compile(src, { wat: true, optimize: 'speed' })
  const fn = /\(func \$scan[\s\S]*?\n  \)/.exec(wat)?.[0] ?? ''
  ok(fn.length > 0, 'scan stays a function')
  ok(!/f64\.(ge|le)\b/.test(fn), 'no character is classified as a Number (`c >= 48 && c <= 57` reads no float)')
  const want = oracle(src).main
  const { main } = run(src, { optimize: 'speed' })
  for (const [n, k] of [[0, 0], [0, 3], [1, -2], [3, 0], [3, 2], [3, 2.5], [3, -40], [3, NaN], [4, 0.25]])
    is(main(n, k), want(n, k), `n=${n} k=${k}`)
})

test('splitCharScan: a copy a later pass makes of the main loop leaves the tail where it stopped', () => {
  // unswitch-loops.js copies the main loop for each answer of `flag`, its
  // declarations renamed: the tail reads the bound through a binding declared
  // before both loops, which each copy assigns as it enters
  const src = `export const f = (s, n, flag) => {
    let h = 0
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i)
      if (flag) h = (h * 31 + c) | 0
      else h = (h * 17 - c) | 0
    }
    return h
  }
  export const g = (n, flag) => f('hello world', n, flag) + f('abc', n, !flag)`
  const js = oracle(src)
  for (const optimize of levels(2, 3)) {
    const { g } = run(src, { optimize })
    for (const [n, flag] of [[20, true], [5, false], [11, true], [2.5, true], [NaN, false], [0, true]]) is(g(n, flag), js.g(n, flag), `g(${n}, ${flag}) O${optimize}`)
  }
})

test('splitCharScan: break in body disables the split (a main-loop break must not fall into the tail)', () => {
  const src = `export let find = (s, n) => {
    let at = -1
    for (let i = 0; i < n; i++) {
      if (s.charCodeAt(i) === 66) { at = i; break }
    }
    return at
  }`
  const js = (s, n) => { let at = -1; for (let i = 0; i < n; i++) if (s.charCodeAt(i) === 66) { at = i; break } return at }
  const { find } = run(src)
  for (const n of [0, 2, 6, 10]) is(find('aaBaaa', n), js('aaBaaa', n), `n=${n}`)
})

// A peeled traversal has a tap loop with loads but no clamp conditional,
// alongside edge loops that retain it. Source boundary names may be forwarded.
const stencilPeels = (src, options = {}) => {
  const fn = findFunc(parse(src, { level: 'speed', watr: false, ...options }), '$f')
  let interior = false, edge = false
  walk(fn, n => {
    if (n[0] !== 'loop' || count(n, x => x[0] === 'loop') !== 1 || !count(n, x => x[0] === 'i32.load')) return
    if (count(n, x => x[0] === 'if')) edge = true
    else interior = true
  })
  return interior && edge
}

test('clamp-peel: stencil edge-peel fires + bit-exact + soundness guards bail', () => {
  // A real box-blur stencil (clamp xi=x+k to [0,w-1]) must split into clamp-free
  // interior + edges, bit-exact vs disabled, while dangerous variants (mutated iv /
  // bound / radius, asymmetric tap range) must bail rather than miscompile.
  const lex = (s, opt) => run(s, opt).f
  const ON = { optimize: 'speed' }, OFF = { optimize: { level: 'speed', clampPeel: false } }
  const fires = stencilPeels
  const A = 'let A=new Int32Array(4096);'
  const blur = `${A}export let f=(w,r)=>{let s=0,x=0;while(x<w){let a=0,k=-r;while(k<=r){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095];k++}s=(s+a)|0;x++}return s|0}`
  ok(fires(blur), 'legit stencil peels')
  const blurOn = lex(blur, ON), blurOff = lex(blur, OFF)
  for (const w of [1, 2, 3, 7, 16, 64, 100]) for (const r of [0, 1, 2, 4, 8])
    is(blurOn(w, r), blurOff(w, r), `blur w=${w} r=${r}`)

  // guards must bail (and stay bit-exact) on: non-monotonic iv, mutated bound, asymmetric
  // tap, closure-mutated bound, plus — found by the adversarial panel — a clamp var
  // mutated between its `xi=x+k` source and the clamp (so the clamp guards a DIFFERENT
  // value than the peel assumes), two tap loops sharing the tap var (tapRadius would pick
  // the wrong radius), and an `x++` living inside the tap loop (real outer step ≠ 1).
  const danger = {
    ivJump: `${A}export let f=(w,r)=>{let s=0,x=0;while(x<w){let a=0,k=-r;while(k<=r){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095];k++}s=(s+a)|0;if((x&3)===0)x=x+2;x++}return s|0}`,
    boundMut: `${A}export let f=(w,r)=>{let s=0,x=0;while(x<w){let a=0,k=-r;while(k<=r){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095];k++}s=(s+a)|0;if(s>9000000)w=w-1;x++}return s|0}`,
    asym: `${A}export let f=(w,r)=>{let s=0,x=0;while(x<w){let a=0,k=1-r;while(k<=r){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095];k++}s=(s+a)|0;x++}return s|0}`,
    closBound: `${A}export let f=(w,r)=>{let s=0,x=0;let dec=()=>{w=w-1};while(x<w){let a=0,k=-r;while(k<=r){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095];k++}s=(s+a)|0;if((x&7)===0)dec();x++}return s|0}`,
    ciDec: `${A}export let f=(w,r)=>{let s=0,x=0;while(x<w){let a=0,k=-r;while(k<=r){let xi=x+k;xi=xi-1;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095];k++}s=(s+a)|0;x++}return s|0}`,
    ciNeg: `${A}export let f=(w,r)=>{let s=0,x=0;while(x<w){let a=0,k=-r;while(k<=r){let xi=x+k;xi=0-xi;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095];k++}s=(s+a)|0;x++}return s|0}`,
    // the tap var is the function's, shared by both loops: one the loop body declares
    // is two bindings once the body's list splits (prepare/split-bindings.js), and peels
    twoTaps: `${A}export let f=(w,r)=>{let s=0,x=0,r2=r-1,k=0;while(x<w){let a=0;k=-r;while(k<=r){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095];k++}k=-r2;while(k<=r2){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095];k++}s=(s+a)|0;x++}return s|0}`,
    ivInTap: `${A}export let f=(w,r)=>{let s=0,x=0;while(x<w){let a=0,k=0-r;while(k<=r){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095];k++;x++}s=(s+a)|0}return s|0}`,
  }
  for (const [name, s] of Object.entries(danger)) {
    ok(!fires(s), `${name} must bail`)
    const a = lex(s, ON), b = lex(s, OFF)
    for (const w of [3, 16, 64]) for (const r of [1, 2, 4]) is(a(w, r), b(w, r), `${name} w=${w} r=${r}`)
  }
})

test('clamp-peel: for-loop stencils (the bench shape) peel + bit-exact + guards bail', () => {
  // The bench blur uses `for` loops (prepare keeps them as ['for',...]); the peel
  // must normalize them (init + 3 while-loops with the step re-appended), with the
  // same guards.
  const A = 'let A=new Int32Array(4096);'
  const fires = stencilPeels
  const on = (s) => run(s, { optimize: 'speed' }).f, off = (s) => run(s, { optimize: { level: 'speed', clampPeel: false } }).f
  const forBlur = `${A}export let f=(w,r)=>{let s=0;for(let x=0;x<w;x++){let a=0;for(let k=-r;k<=r;k++){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095]}s=(s+a)|0}return s|0}`
  ok(fires(forBlur), 'for-loop stencil peels')
  const forOn = on(forBlur), forOff = off(forBlur)
  for (const w of [0, 1, 2, 3, 7, 8, 16, 64, 100]) for (const r of [0, 1, 2, 4, 8]) is(forOn(w, r), forOff(w, r), `forBlur w=${w} r=${r}`)
  const danger = {
    forStep2: `${A}export let f=(w,r)=>{let s=0;for(let x=0;x<w;x=x+2){let a=0;for(let k=-r;k<=r;k++){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095]}s=(s+a)|0}return s|0}`,
    forBoundMut: `${A}export let f=(w,r)=>{let s=0;for(let x=0;x<w;x++){let a=0;for(let k=-r;k<=r;k++){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095]}s=(s+a)|0;if(s>9000000)w=w-1}return s|0}`,
  }
  for (const [n, s] of Object.entries(danger)) { ok(!fires(s), `${n} bails`); const a = on(s), b = off(s); for (const w of [3, 16, 64]) for (const r of [1, 2, 4]) is(a(w, r), b(w, r), `${n} w=${w} r=${r}`) }
})

test('clamp-peel: guarded Number domains retain fractional, wide and zero-work behavior', () => {
  const cases = [[0, 0, 1], [0, 1, 0], [0, 8, 2], [0, 8, 2],
    [0, 2.5, 1], [.5, 4, 1], [-0, 3, 1], [0, 3, -0], [-2, 3, 1],
    [0, 4, .5], [0, 4, -1], [0, 4, NaN], [0, NaN, 1],
    [2147483646, 2147483649, 1], [4294967294, 4294967297, 0], [0, 8, 2]]
  for (const kind of ['while', 'for']) {
    const inner = `let k=-r;while(k<=r){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;sum+=xi;last=xi;taps++;k++}`
    const src = `export function f(start,w,r){let sum=0,taps=0,last=0,x=start;
      ${kind === 'while' ? `while(x<w){${inner};x++}` : `for(;x<w;x++){${inner}}`}
      return [sum,x,taps,1/last]}`
    const ref = Function(src.replace('export function', 'return function'))()
    for (const optimize of levels(0, 2, 3, 'size', 'speed')) {
      const got = run(src, { optimize }).f
      for (const args of cases) is(got(...args), ref(...args), `${kind} O${optimize}, ${args}`)
    }
  }
  const src = `export function f(mode){let effects=0,sum=0,x=0,w=3,r=1;
    const o={valueOf(){effects++;if(mode===4)throw 7;return 2}};
    if(mode===0)w=0;if(mode===1)w=o;if(mode===2)x=o;if(mode===3||mode===4)r=o;
    try{while(x<w){let k=-r;while(k<=r){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;sum+=xi;k++}x++}}
    catch(e){sum=e}return [sum,x,effects]}`
  const ref = Function(src.replace('export function', 'return function'))()
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) {
    const got = run(src, { optimize, sourceInline: false }).f
    for (const mode of [0, 1, 2, 3, 4, 1]) is(got(mode), ref(mode), `effects O${optimize}, mode=${mode}`)
  }
})

test('clamp-peel: closures from parameter defaults invalidate boundary snapshots', () => {
  if (onKernel()) return
  const src = `const a=new Int32Array(16);export function f(w,r,change=()=>{w--}){
    let sum=0,x=0;while(x<w){let k=-r;while(k<=r){let xi=x+k;
      if(xi<0)xi=0;else if(xi>=w)xi=w-1;sum+=a[xi&15];k++}change();x++}return sum}`
  ok(!stencilPeels(src, { sourceInline: false }), 'the whole frame includes closures in defaults, not only statements in its body')
})

test('clamp-peel: the for initializer runs once in its original lexical scope', () => {
  const src = `export function f(w,r){let starts=0,x=99,sum=0;
    for(let x=(starts++,0);x<w;x++){let k=-r;while(k<=r){let xi=x+k;
      if(xi<0)xi=0;else if(xi>=w)xi=w-1;sum+=xi;k++}}
    return [sum,x,starts]}`
  const ref = Function(src.replace('export function', 'return function'))()
  for (const optimize of levels(0, 2, 3, 'size', 'speed')) {
    const got = run(src, { optimize }).f
    for (const args of [[8,2],[8,2],[0,1],[2.5,1],[3,.5],[8,2]])
      is(got(...args), ref(...args), `O${optimize}, ${args}`)
  }
})

test('clamp-peel: tap dominance, transfer targets and initializer scopes remain exact', () => {
  const clamp = `let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;sum+=xi`
  const bodies = {
    earlyStep: `let k=-r;while(k<=r){k++;${clamp}}`,
    conditionalSeed: `let k=-3;if(mode)k=-r;while(k<=r){${clamp};k++}`,
    afterTap: `let k=-r;while(k<=r){k++}${clamp}`,
    breakOuter: `let k=-r;while(k<=r){${clamp};k++}if(x===2)break`,
    continueOuter: `let k=-r;while(k<=r){${clamp};k++}if(x===2)continue`,
    breakInner: `let k=-r;while(k<=r){${clamp};if(k===0)break;k++}`,
    retained: `let k=-r;while(k<=r){${clamp};k++}hold=()=>x`,
    returnOuter: `let k=-r;while(k<=r){${clamp};k++}if(x===2)return [sum,x]`,
  }
  for (const [name, body] of Object.entries(bodies)) {
    const src = `export function f(mode){let sum=0,hold=()=>0,w=6,r=1,x=20;
      for(let x=0;x<w;x++){${body}}return [sum,x+hold()]}`
    const ref = Function(src.replace('export function', 'return function'))()
    for (const optimize of levels(0, 2, 3, 'size', 'speed')) {
      const got = run(src, { optimize, sourceInline: false }).f
      for (const mode of [0, 1, 0]) is(got(mode), ref(mode), `${name} O${optimize}, mode=${mode}`)
    }
  }
})

// A counter running down from its entry (`for (k = n - 1; k >= 0; k--)`, a
// predictor adapting its taps from the last one) holds values between the bound
// and that entry: the guard reads the entry at the loop and tests both ends of
// every index (`coefs[k]`, `out[pb - k]`), where no static hull of `n` exists
// (an int32 the program cannot bound) or a static one would fail at run time.
test('versioning: a counter running down is guarded by its entry', () => {
  const src = `
    const adapt = (coefs, out, n, pb, top, del) => {
      for (let k = n - 1; k >= 0; k--) {
        const d = top - out[pb - k], sg = (d > 0) - (d < 0)
        coefs[k] -= sg
        del -= Math.imul(n - k, Math.imul(sg, d) >> 3)
        if (del <= 0) break
      }
      return del
    }
    const cfg = new Int32Array([8, 4000, 7])
    export let go = (x) => {
      const coefs = new Int16Array(32), out = new Int32Array(4096)
      for (let i = 0; i < 4096; i++) out[i] = Math.imul(i, 40503) >> 9
      for (let i = 0; i < 32; i++) coefs[i] = 100 - i * 3
      let h = 0
      for (let r = 0; r < 64; r++) h = (h + adapt(coefs, out, cfg[0] + (x | 0), cfg[1] - r * (x === 9 ? 70 : 1), r - 7, 1 << 20)) | 0
      return h + coefs[3] + coefs[7]
    }`
  const host = oracle(src).go
  for (const optimize of levels(0, 2, 3, 'speed')) {
    const go = jz(src, { optimize }).exports.go
    for (const x of [0, 3, -8, -9, 9, 24, 40]) is(go(x), host(x), `O${optimize}: go(${x})`)
  }
  const wat = compile(src, { optimize: 2, wat: true })
  const loops = []
  for (let from = wat.indexOf('(loop'); from >= 0; from = wat.indexOf('(loop', from + 5)) {
    let depth = 0, i = from
    for (; i < wat.length; i++) { if (wat[i] === '(') depth++; else if (wat[i] === ')' && --depth === 0) break }
    const seg = wat.slice(from, i + 1)
    if (!seg.slice(5).includes('(loop') && /i32\.load16_s/.test(seg) && /i32\.store16/.test(seg)) loops.push(seg)
  }
  ok(loops.some(l => !/i32\.lt_u|i32\.ge_u/.test(l)), 'the adapting loop runs with no bounds test')
})

// The same counter where the walk holds the index to a static hull looser than
// the array: ALAC's predictor (bench/_audiojs/repro/decode/param-range.js, its
// order an int32 of no known range over a 4096-sample frame) bounds a tap `k <=
// 4095` against a 32-entry table.
test('versioning: a counter running down past a loose hull is guarded by its entry', () => {
  const src = `
    function signOf(i) { return (((-i) >>> 31) | (i >> 31)) }

    function unpcBlock(pc1, out, num, coefs, numactive, chanbits, denshift) {
      let chanshift = 32 - chanbits, denhalf = 1 << (denshift - 1)
      out[0] = pc1[0]
      if (numactive === 0) { for (let i = 1; i < num; i++) out[i] = pc1[i]; return }
      if (numactive === 31) {
        let prev = out[0]
        for (let j = 1; j < num; j++) { let del = pc1[j] + prev; prev = (del << chanshift) >> chanshift; out[j] = prev }
        return
      }
      for (let j = 1; j <= numactive; j++) { let del = pc1[j] + out[j - 1]; out[j] = (del << chanshift) >> chanshift }
      let lim = numactive + 1
      for (let j = lim; j < num; j++) {
        let sum1 = 0, pb = j - 1, top = out[j - lim]
        for (let kk = 0; kk < numactive; kk++) sum1 = (sum1 + Math.imul(coefs[kk], out[pb - kk] - top)) | 0
        let del = pc1[j], del0 = del, sg = signOf(del)
        del = (del + top + ((sum1 + denhalf) >> denshift)) | 0
        out[j] = (del << chanshift) >> chanshift
        if (sg > 0) {
          for (let kk = numactive - 1; kk >= 0; kk--) {
            let dd = top - out[pb - kk], sgn = signOf(dd)
            coefs[kk] -= sgn
            del0 -= Math.imul(numactive - kk, (Math.imul(sgn, dd) >> denshift))
            if (del0 <= 0) break
          }
        } else if (sg < 0) {
          for (let kk = numactive - 1; kk >= 0; kk--) {
            let dd = top - out[pb - kk], sgn = signOf(dd)
            coefs[kk] += sgn
            del0 -= Math.imul(numactive - kk, (Math.imul(-sgn, dd) >> denshift))
            if (del0 >= 0) break
          }
        }
      }
    }
    const N = 4096, F = 200
    let pc1 = new Int32Array(N), out = new Int32Array(N), tmp = new Int32Array(N), coefs = new Int16Array(32), cfg = new Int32Array([4096, 8, 9])
    export let setup = () => { let s = 7; for (let i = 0; i < N; i++) { s = (s * 1103515245 + 12345) >>> 0; pc1[i] = (s >>> 20) - 2048 } }
    export let go = () => {
      let num = cfg[0], na = cfg[1], ds = cfg[2], h = 0
      for (let f = 0; f < F; f++) {
        for (let k = 0; k < 8; k++) coefs[k] = 100 - k * 9
        unpcBlock(pc1, tmp, num, null, 31, 16, 0)
        unpcBlock(pc1, out, num, coefs, na, 16, ds)
        h = (h + out[N - 1] + out[N >> 1] + tmp[7]) | 0
      }
      return h
    }`
  const host = oracle(src)
  host.setup()
  const want = host.go()
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    m.setup()
    is(m.go(), want, `O${optimize}: the frames decode as the host's`)
  }
  ok(!/i64\.const 4095/.test(compile(src, { optimize: 2, wat: true })), 'no guard tests the loose hull')
})

// Mirror index in the versioning guard: `inp[N−k]` (symmetric fill — FFT
// log-magnitude, reverse copies) has iv-coefficient −1; affineIdxOfIV used to
// reject a<0 outright, so the versioned FAST arm kept a per-iteration bounds
// check + header load on the mirror store. Extremes now follow the sign of a
// (max at ENTRY, min at maxIv), and the fast arm stores raw.
test('versioning: mirror store a[N−k] joins the guard — raw in the fast arm', () => {
  const src = `
    const fill = (spec, inp, n, half) => {
      let k = 1
      while (k < half) {
        let lm = spec[k] * 2
        inp[k] = lm
        inp[n - k] = lm
        k++
      }
    }
    export let go = (n, m) => {
      const spec = new Float64Array(n >> 1)
      const inp = new Float64Array(m)
      let i = 0
      while (i < (n >> 1)) { spec[i] = i + 1; i++ }
      fill(spec, inp, n, n >> 1)
      return inp[3] * 1000 + (m > n - 3 ? inp[n - 3] : 0)
    }`
  const wat = compile(src, { optimize: 'speed', wat: true })
  // fast arm: a loop body with two f64 stores and NO in-loop header length
  // re-read (i32.load of base−8). The checked twin keeps per-site guards.
  const loops = [...wat.matchAll(/\(loop \$[^\s)]+[\s\S]*?f64\.store[\s\S]*?f64\.store[\s\S]*?br(_if)? \$/g)].map(m => m[0])
  ok(loops.length >= 1, 'two-store loop bodies exist')
  ok(loops.some(l => !/\(i32\.sub[\s\S]{0,60}\(i32\.const 8\)/.test(l)),
    'a versioned two-store body runs without header re-reads (raw mirror store)')
  // behavior: exact on the fast path; an undersized receiver (mirror OOB)
  // falls to the checked twin — in-range writes land, OOB drop silently.
  const { exports } = jz(src, { memory: 64 })
  is(exports.go(16, 16), 8008, 'forward + mirror stores land (fast arm)')
  is(exports.go(16, 8), 8000, 'undersized: checked twin drops the OOB mirror, keeps in-range')
})

// While-loop versioning guard off-by-one: maxIv used the EXCLUSIVE bound, so
// `maxIv < len` failed exactly when len == bound — every half-spectrum /
// tail-increment while loop (cepstrum's log fill, medianUs) silently ran the
// CHECKED arm forever. maxIv is now the true pre-increment max (bound−1);
// only genuinely post-increment accesses widen (cand.post).
test('versioning: len == bound while-loop takes the fast arm at runtime', () => {
  const src = `
    const fill = (spec, inp, n, half) => {
      let k = 1
      while (k < half) {
        let lm = spec[k] * 3
        inp[k] = lm
        inp[n - k] = lm
        k++
      }
    }
    export let go = (n) => {
      const spec = new Float64Array(n >> 1)   // len(spec) == half == bound
      const inp = new Float64Array(n)
      let i = 0
      while (i < (n >> 1)) { spec[i] = i; i++ }
      fill(spec, inp, n, n >> 1)
      let s = 0
      i = 0
      while (i < n) { s += inp[i]; i++ }
      return s
    }`
  // Structural: the versioned guard must NOT compare the raw exclusive bound
  // against len — maxIv arrives as bound−1 (an i64.add … -1 feeding the tvq set).
  const wat = compile(src, { optimize: 'speed', wat: true })
  ok(/local\.tee \$tvq\d*[\s\S]{0,120}i64\.const -1|i64\.add[\s\S]{0,80}i64\.const -1/.test(wat),
    'maxIv computed as bound−1')
  // Behavioral: values exact through the fast arm.
  const { exports } = jz(src, { memory: 64 })
  // forward writes 1..half−1 (k*3) + mirror duplicates: sum = 2*3*Σ(1..half−1)
  const n = 64, half = 32
  is(exports.go(n), 2 * 3 * (half - 1) * half / 2, 'symmetric fill sums exact')
})

// Downward canonical for-loop joins the interval walk: `for (r = A; r >= 0; r--)`
// bounds r ∈ [0, A] — heapify roots, reverse scans. (Upward-only before.)
test('interval walk: downward for-loop proves its reads', () => {
  const src = `
    export let go = () => {
      const a = new Float64Array(64)
      for (let i = 0; i < 64; i++) a[i] = i
      let s = 0
      for (let r = 62; r >= 0; r--) s += a[r + 1]
      return s
    }`
  const wat = compile(src, { optimize: { level: 'size' }, wat: true })
  // -Os with static len: a proven read is a bare f64.load — no checked-read
  // else-arm (undef NaN const/global) may survive in go.
  const go = wat.slice(wat.indexOf('(func $go'))
  is((go.match(/nan:0x/g) || []).length, 0, 'downward-loop read proven — no undef arm')
  const { exports } = jz(src, { memory: 64 })
  is(exports.go(), 63 * 64 / 2, 'reverse scan sums exact')
})

// `&&`-cond while versioning: the LZ match scan `while (len < max &&
// src[j+len] === src[ip+len]) len++` — the countable bound is the LEFTMOST
// conjunct; the comparison conjunct short-circuits after it, so its accesses
// run only at iv < bound (exact pre-increment extents) and can only exit the
// loop early.
test('versioning: &&-cond match-scan while takes the fast arm', () => {
  const src = `
    const scan = (src, n) => {
      let best = 0
      for (let ip = 1; ip < n; ip++) {
        let maxLen = n - ip
        if (maxLen > 18) maxLen = 18
        for (let j = ip - 1; j >= 0; j--) {
          let len = 0
          while (len < maxLen && src[j + len] === src[ip + len]) len++
          if (len > best) best = len
        }
      }
      return best
    }
    export let go = (n) => {
      const buf = new Uint8Array(64)
      for (let i = 0; i < 64; i++) buf[i] = (i * 7) & 15
      return scan(buf, n | 0)
    }`
  const wat = compile(src, { optimize: 'speed', wat: true })
  // a fast-arm scan loop exists: byte loads + eq with NO undef else-arm inside
  const loops = [...wat.matchAll(/\(loop \$[^\s)]+[\s\S]*?i32\.load8_u[\s\S]*?i32\.load8_u[\s\S]*?br(_if)? \$/g)].map(m => m[0])
  ok(loops.length >= 1, 'byte-compare loops exist')
  ok(loops.some(l => !/nan:0x7FF8000200000000/.test(l)),
    'a versioned match-scan body compares raw bytes (no checked-read undef arm)')
  const { exports } = jz(src)
  // period-16 ramp: maxLen-capped 18-byte matches exist → best = min(18, …)
  const jsScan = (buf, n) => {
    let best = 0
    for (let ip = 1; ip < n; ip++) {
      let maxLen = Math.min(n - ip, 18)
      for (let j = ip - 1; j >= 0; j--) {
        let len = 0
        while (len < maxLen && buf[j + len] === buf[ip + len]) len++
        if (len > best) best = len
      }
    }
    return best
  }
  const buf = new Uint8Array(64)
  for (let i = 0; i < 64; i++) buf[i] = (i * 7) & 15
  is(exports.go(64), jsScan(buf, 64), 'match lengths bit-match JS (full)')
  is(exports.go(17), jsScan(buf, 17), 'match lengths bit-match JS (short n)')
})

test('versioning: bound-not-first &&-cond stays checked (fail-closed)', () => {
  // access conjunct BEFORE the bound: it evaluates at iv == bound too — the
  // tight guard would under-cover, so the shape must not version at all.
  const src = `
    export let go = (n) => {
      const a = new Uint8Array(8)
      for (let i = 0; i < 8; i++) a[i] = i
      let len = 0
      while (a[len] < 9 && len < n) len++
      return len * 10 + (a[len] | 0)
    }`
  const wat = compile(src, { optimize: 'speed', wat: true })
  const go = wat.slice(wat.indexOf('(func $go'))
  ok(/i32\.(lt_u|ge_u)/.test(go), 'checked integer comparison retains its bounds guard')
  const { exports } = jz(src, { optimize: 'speed' })
  is(exports.go(100), 80, 'missing element stops the comparison instead of becoming zero')
  is(exports.go(3), 30 + 3, 'bound conjunct still exits at n')
})

test('versioning: ||-cond never versions (accesses run past the bound)', () => {
  // `while (len < n || a[len] < 9)` evaluates the access exactly when the
  // bound conjunct is FALSE (len ≥ n) — no extent is implied; the shape must
  // keep checked reads (only && chains with a leftmost bound may version).
  const src = `
    export let go = (n) => {
      const a = new Uint8Array(8)
      for (let i = 0; i < 8; i++) a[i] = i
      let len = 0
      while (len < n || a[len] < 3) len++
      return len
    }`
  const wat = compile(src, { optimize: 'speed', wat: true })
  const go = wat.slice(wat.indexOf('(func $go'))
  ok(/i32\.(lt_u|ge_u)/.test(go), '||-cond retains the integer read bounds guard')
  const { exports } = jz(src, { optimize: 'speed' })
  is(exports.go(1), 3, 'runs past the bound conjunct until a[len] ≥ 3 (checked semantics)')
  is(exports.go(6), 6, 'bound-first exit exact')
  is(exports.go(8), 8, 'missing element makes the right disjunct false at the boundary')
  is(exports.go(20), 20, 'missing element stays false beyond the boundary')
})

test('interval walk: heapsort proves both sift loops (narrowing + && + range-rhs)', () => {
  const src = `
const heapsort = (a) => {
  const n = a.length
  for (let root = (n >> 1) - 1; root >= 0; root--) {
    let i = root
    let child = 2 * i + 1
    while (child < n) {
      if (child + 1 < n && a[child] < a[child + 1]) child++
      if (a[i] >= a[child]) break
      const t = a[i]; a[i] = a[child]; a[child] = t
      i = child
      child = 2 * i + 1
    }
  }
  for (let end = n - 1; end > 0; end--) {
    const t = a[0]; a[0] = a[end]; a[end] = t
    let i = 0
    let child = 1
    while (child < end) {
      if (child + 1 < end && a[child] < a[child + 1]) child++
      if (a[i] >= a[child]) break
      const u = a[i]; a[i] = a[child]; a[child] = u
      i = child
      child = 2 * i + 1
    }
  }
}
export let main = () => {
  const a = new Float64Array(64)
  for (let i = 0; i < 64; i++) a[i] = ((i * 37) % 64)
  heapsort(a)
  let s = 0
  for (let i = 0; i < 64; i++) s += a[i] * (i + 1)
  return s
}`
  const wat = compile(src, { wat: true, optimize: 'speed' })
  const m = wat.split('(func ').find(c => /^\$main\b/.test(c)) || ''
  is((m.match(/nan:0x7FF80002/g) || []).length, 0, 'every heapsort read/write proven — no undef arms')
  const exportsJs = oracle(src)
  is(run(src, { optimize: 'speed' }).main(), exportsJs.main(), 'sorted checksum bit-matches JS')
})

test('interval walk: a bound written inside the loop stays checked (fail-closed)', () => {
  // `n` grows mid-loop — the cond-∩ refinement must not lock the entry bound
  // in; reads keep their checks and JS OOB semantics (undefined → NaN skips).
  const src = `
export let main = (g) => {
  const a = new Float64Array(8)
  for (let i = 0; i < 8; i++) a[i] = i + 1
  let n = 4
  let s = 0
  let i = 0
  while (i < n) {
    s += a[i]
    if (i === 2 && g) n = 12
    i++
  }
  return s
}`
  // (the miss arm is read by its NaN literal, kept inline: the speed tier pools float literals otherwise)
  const wat = compile(src, { wat: true, optimize: { level: 'speed', poolFloats: false } })
  const m = wat.split('(func ').find(c => /^\$main\b/.test(c)) || ''
  // the miss arm folds to CANONICAL nan (toNumF64's checkedNumRead seam via
  // the += accumulator) — the checked arm itself must survive
  ok(/f64\.const nan/.test(m), 'growing bound: the read keeps its checked arm')
  const exportsJs = oracle(src)
  is(run(src, { optimize: 'speed' }).main(0), exportsJs.main(0), 'g=0 exact')
  ok(Number.isNaN(run(src, { optimize: 'speed' }).main(1)), 'g=1: OOB tail is NaN, matching JS (not raw reads, not undefined)')
})

test('interval walk: branch joins retain both arms through nested control flow', () => {
  const src = `
export function branch(n, flag, mode) {
  const a = new Int32Array([11, 22, 33, 44])
  let i = 1
  if (mode === 0) { if (flag) i = n; else i = 3 }
  else if (mode === 1) { flag ? (i = n) : (i = 3) }
  else if (mode === 2) { flag && (i = n) }
  else { flag || (i = n) }
  return a[i]
}
export function loop(n, flag) {
  const a = new Int32Array([11, 22, 33, 44])
  let i = 0, j = 0
  while (i < n) {
    if (flag) {
      if (i === 1) { j = 5; break }
      j = i
    } else {
      j = i
      if (i++ === 1) continue
    }
    i++
  }
  return a[j]
}`
  const js = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const ex = run(src, { optimize })
    for (const flag of [0, 1]) for (const n of [-1, 0, 1, 3, 4, 7]) {
      for (let mode = 0; mode < 4; mode++)
        is(ex.branch(n, flag, mode), js.branch(n, flag, mode), `${optimize}: branch ${n}/${flag}/${mode}`)
      is(ex.loop(n, flag), js.loop(n, flag), `${optimize}: loop ${n}/${flag}`)
    }
  }
})

test('interval walk: strided companion cursor + packed OR index erase codec bounds checks', () => {
  // A 3→4 codec loop has two coupled induction variables.
  const src = `
const pack = (input, table, out) => {
  let op = 0
  for (let i = 0; i + 3 <= 12; i += 3) {
    const a = input[i], b = input[i + 1]
    out[op] = table[((a & 3) << 4) | (b >>> 4)]
    out[op + 1] = table[a & 63]
    op += 2
  }
  return op
}
export let main = () => {
  const input = new Uint8Array(12), table = new Uint8Array(64), out = new Uint8Array(8)
  for (let i = 0; i < 12; i++) input[i] = i * 17
  for (let i = 0; i < 64; i++) table[i] = i + 1
  return pack(input, table, out) + out[0] + out[7]
}`
  const wat = compile(src, { wat: true, optimize: 'speed' })
  const m = wat.split('(func ').find(c => /^\$main\b/.test(c)) || wat
  ok((m.match(/i32\.lt_u/g) || []).length <= 1, 'codec accesses need no checks (only allocator growth may retain lt_u)')
  const exportsJs = oracle(src)
  is(run(src, { optimize: 'speed' }).main(), exportsJs.main(), 'codec kernel stays exact')
})

test('interval walk: bit-field equality narrows bounded opcode/table indices', () => {
  const src = `
export let main = (tag) => {
  const table = new Int32Array(64)
  for (let i = 0; i < 64; i++) table[i] = i * 3
  tag = tag & 255
  if ((tag & 192) === 0) return table[tag]
  return -1
}`
  const wat = compile(src, { wat: true, optimize: 'speed' })
  const m = wat.split('(func ').find(c => /^\$main\b/.test(c)) || wat
  is((m.match(/nan:0x7FF80002/g) || []).length, 0, 'masked equality proves the 64-slot table read')
  const wasm = run(src, { optimize: 'speed' }).main
  for (const tag of [-1, 0, 1, 63, 64, 127, 255, 256, 0x12340])
    is(wasm(tag), ((tag & 255) < 64 ? (tag & 255) * 3 : -1), `tag=${tag} exact`)
  const negated = src.replace('=== 0', '!== 0')
  ok(/nan:0x7FF80002/.test(compile(negated, { wat: true, optimize: 'speed' })),
    'non-contiguous negated class stays checked')
})

test('versioned nest: inner-unrolled level keeps its assumptions (fast arm raw)', () => {
  // The biquad cascade shape: outer sample loop versioned at the top, inner
  // stage loop (const trip) unrolls INSIDE the arms. Assumptions are top-owned
  // now; the fast arm must be sentinel-free while the checked twin keeps the
  // exact semantics (guard-fail = OOB reads undefined).
  const src = `
const proc = (x, coeffs, state, nStages, out) => {
  const n = x.length
  for (let i = 0; i < n; i++) {
    let v = x[i]
    for (let s = 0; s < nStages; s++) {
      const c = s * 5
      const sb = s * 4
      const b0 = coeffs[c + 0], b1 = coeffs[c + 1], b2 = coeffs[c + 2], a1 = coeffs[c + 3], a2 = coeffs[c + 4]
      const x1 = state[sb + 0], x2 = state[sb + 1], y1 = state[sb + 2], y2 = state[sb + 3]
      const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      state[sb + 0] = v; state[sb + 1] = x1; state[sb + 2] = y; state[sb + 3] = y1
      v = y
    }
    out[i] = v
  }
}
export let run = (n, nStages) => {
  const x = new Float64Array(n), out = new Float64Array(n)
  const coeffs = new Float64Array(nStages * 5), state = new Float64Array(nStages * 4)
  for (let i = 0; i < nStages * 5; i++) coeffs[i] = (i % 7) * 0.1 - 0.2
  for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.3)
  proc(x, coeffs, state, nStages, out)
  let t = 0
  for (let i = 0; i < n; i++) t += out[i]
  return t
}`
  const jsExports = oracle(src)
  for (const optimize of levels(0, 2, 'speed')) {
    const r = run(src, { optimize }).run(64, 8)
    almost(r, jsExports.run(64, 8), 1e-9, `O${optimize}: cascade values JS-exact`)
  }
  // Structural: the guarded fast arm carries ZERO checked-read sentinels.
  const wat = compile(src, { wat: true, optimize: 'speed' })
  // proc inlines into run (single caller), so the cascade lives in `run` itself.
  // Named, not "whichever function has the most f64.mul": the math helpers this
  // program also pulls in (Math.sin seeds the input) carry long polynomials, and
  // one of them outranked the kernel the moment those series grew.
  const fn = funcWat(wat, 'run')
  const guardAt = (() => { const i = fn.indexOf('i64.lt_s'); return i >= 0 ? i : fn.indexOf('i64.le_s') })()
  ok(guardAt > 0, 'versioned guard present')
  const thenAt = fn.indexOf('(then', guardAt)
  const elseAt = (() => {   // matching else at the same paren depth as the then
    let d = 0
    for (let i = thenAt; i < fn.length; i++) {
      if (fn[i] === '(') d++
      else if (fn[i] === ')' && --d === 0) return fn.indexOf('(else', i)
    }
    return -1
  })()
  ok(elseAt > thenAt, 'both arms present')
  const fastArm = fn.slice(thenAt, elseAt)
  ok(!/nan:0x7FF8000200000000/.test(fastArm), 'fast arm carries no checked-read sentinels')
})

test('versioned nest: an inner scan reading the outer iv lifts to one guard at the nest entry', () => {
  // The LZ match scan: a decreasing loop over candidate positions `j`, an inner
  // while comparing bytes at `j + len` and `ip + len`.
  const src = `
const N = 300
const scan = (src) => {
  let ip = 0, total = 0
  while (ip < N) {
    let start = ip - 64
    if (start < 0) start = 0
    let maxLen = N - ip
    if (maxLen > 18) maxLen = 18
    let best = 0
    for (let j = ip - 1; j >= start; j--) {
      let len = 0
      while (len < maxLen && src[j + len] === src[ip + len]) len++
      if (len > best) best = len
    }
    total += best
    ip += best > 2 ? best : 1
  }
  return total
}
export let main = () => {
  const src = new Uint8Array(N)
  for (let i = 0; i < N; i++) src[i] = (i * 7) & 3
  return scan(src)
}`
  const jsExports = oracle(src)
  // `main`, not `run`: `run` is the reserved void WASI command entry (_matrix.js).
  for (const optimize of levels(0, 2, 'speed')) is(run(src, { optimize }).main(), jsExports.main(), `O${optimize}: scan total JS-exact`)
  const wat = compile(src, { wat: true, optimize: 'speed' })
  const fn = wat.split('(func ').find(f => f.includes('load8_u')) || ''
  ok(/i64\.l[te]_s/.test(fn), 'versioned guard present')
  // The guard sits at the `j` nest's entry (once per `ip`), so the loop that
  // directly encloses the innermost scan carries no i64 extent compare.
  const loops = []
  for (let at = fn.indexOf('(loop '); at >= 0; at = fn.indexOf('(loop ', at + 1)) {
    let d = 0
    for (let i = at; i < fn.length; i++) {
      if (fn[i] === '(') d++
      else if (fn[i] === ')' && --d === 0) { loops.push({ at, end: i, text: fn.slice(at, i) }); break }
    }
  }
  const innermost = loops.filter(L => !L.text.slice(6).includes('(loop '))
  const enclosing = innermost.map(I => loops.filter(L => L !== I && L.at < I.at && L.end > I.end).sort((x, y) => (x.end - x.at) - (y.end - y.at))[0]).filter(Boolean)
  ok(enclosing.length > 0 && enclosing.every(L => !/i64\.(l[te]|g[te])_s/.test(L.text)), 'one guard at the nest entry, none per outer iteration')
})

test('cursor-versioning: monotone stream cursor guards fast-arm bare loads, checked else preserves OOB semantics', () => {
  // glyfparse's `stream[r++]` shape: `r` is a body-advanced CURSOR (not the
  // loop's own iv) read across a countable loop's iterations — the affine
  // model can't hull it (its per-iteration advance isn't iv-linear), so it
  // needs its own MONOTONE CURSOR candidate kind. K = per-iteration max
  // advance (here `r++` contributes 1, `r += 2` contributes 2 → K=3); the
  // guard is `entryR + K·trips + K0 < len`, once per loop entry.
  const src = `
const cursorScan = (stream, out, n) => {
  let r = 0
  let h = 0
  for (let i = 0; i < n; i++) {
    const d = stream[r++]
    const v = (d + stream[r] + stream[r + 1]) | 0
    out[i] = v
    h = (h + v) | 0
    r += 2
  }
  return h
}
export let run = (n, len) => {
  const stream = new Uint8Array(len)
  for (let i = 0; i < len; i++) stream[i] = (i * 7 + 3) & 0xff
  const out = new Int32Array(n)
  return cursorScan(stream, out, n)
}`
  const jsExports = oracle(src)
  // n=20 → K=3, K0max=1: the guard needs entryR(0) + 3·20 + 1 < len, i.e.
  // len ≥ 62 to PASS. len=30 forces a REAL runtime OOB partway through (the
  // checked arm's exact semantics must survive); len=61 fails the (sound but
  // conservative — the guard's K·trips over-approximates the true max index
  // by 2) guard despite every access staying actually in-bounds — the checked
  // arm must still compute the identical answer either way.
  for (const [n, len] of [[20, 30], [20, 61], [20, 62], [20, 70], [0, 5], [1, 3]]) {
    const truth = jsExports.run(n, len)
    for (const optimize of levels(0, 2, 'speed'))
      is(run(src, { optimize }).run(n, len), truth, `n=${n} len=${len} O${optimize}: exact (checked semantics through guard-fail preserved)`)
  }
  // Structural: the guarded fast arm's cursor reads are bare loads (no bounds
  // check idiom); the checked twin keeps its guarded reads.
  const wat = compile(src, { wat: true, optimize: preWatr({ level: 'speed', specializeLoops: false }) })
  const fn = wat.split('(func ').find(f => f.startsWith('$cursorScan')) || ''
  ok(fn.length > 0, 'inspect the cursor worker before backend inlining')
  // Find the complete guarded loop, not the first wide comparison: exact
  // Number thresholds and individual checked reads also use wide compares.
  const versions = []
  walk(parseWat(`(func ${fn}`), n => {
    if (n[0] !== 'if') return
    const fast = n.find(x => Array.isArray(x) && x[0] === 'then')
    const checked = n.find(x => Array.isArray(x) && x[0] === 'else')
    if (!fast || !checked || !count(fast, x => x[0] === 'loop')) return
    if (count(fast, x => x[0] === 'i32.load8_u') === 3 &&
        !count(fast, x => /^(i32|i64)\.(lt|ge)_u$|^select$/.test(x[0]))) versions.push([fast, checked])
  })
  ok(versions.length > 0, 'a complete fast loop has three bare cursor loads and no bounds-check idiom')
  ok(versions.every(([, checked]) => count(checked, x => /^(i32|i64)\.(lt|ge)_u$|^select$/.test(x[0])) > 0), 'each checked twin keeps guarded reads')

})

test('versioned nest: an inner guard that reads the top counter is bounded by its extent, in either direction', () => {
  // The lz shape scans DOWN (`j--`), and an inner guard lifted to the nest entry
  // once read the counter's entry value — its maximum going down, so the upper
  // bound held, and its MINIMUM going up, so an ascending scan's `src[j + len]`
  // read past the array unchecked (jz returned a sum where JS returns NaN). The
  // last window is the one whose entry is in bounds and whose later iterations
  // are not — a later checked out-of-bounds read would mask the unchecked one.
  const mk = (header, first, last) => `const N = 300
export let main = () => {
  const src = new Uint8Array(N)
  for (let i = 0; i < N; i++) src[i] = (i * 7) & 255
  let acc = 0, ip = ${first}
  while (ip < ${last}) {
    const start = ip - 3
    ${header} {
      for (let len = 0; len < 8; len++) acc += src[j + len]
    }
    ip += 5
  }
  return acc
}`
  const cases = {
    up: mk('for (let j = start; j <= ip - 1; j++)', 4, 295),
    down: mk('for (let j = ip - 1; j >= start; j--)', 4, 295),
    downBelowZero: mk('for (let j = ip - 1; j >= start; j--)', 1, 12),
  }
  for (const [name, src] of Object.entries(cases)) {
    const expected = oracle(src).main()
    for (const optimize of levels(0, 2, 'speed'))
      ok(Object.is(run(src, { optimize }).main(), expected), `${name} at O${optimize}: ${run(src, { optimize }).main()} vs ${expected}`)
    if (belowOpt(2) || onKernel()) continue
    // (one test of the window's last index, `j + 7 < length`, covers the inner loop's eight reads;
    // where the counter's own extent is known, the last window's, `j0 + (n - 1) + 7`, covers every window's)
    const text = compile(src, { wat: true, optimize: 'speed' }).replace(/\s+/g, ' ')
    ok(/\(i(32|64)\.lt_s \(i\1\.add (?:\(i\1\.add )?\(i\1\.const (?:7|0x0*7)\)/.test(text), `${name}: the inner guard still lifts`)
  }
})


test('narrowLoopBound: a threshold no larger than a word is an i32', () => {
  // `i < Math.min(n, len)` (a char scan's bound): every write of the threshold a minimum with an
  // int32; `i <= n` needs one below the top word (`floor(n) + 1` is the threshold), a literal here
  for (const [compare, reverse] of [['lt', false], ['le', false], ['gt', true], ['ge', true]]) {
    const i = ['f64.convert_i32_s', ['local.get', '$i']], n = ['local.get', '$b'], strict = compare === 'lt' || compare === 'gt'
    const fn = ['func', '$f', ['export', '"f"'], ['param', '$i', 'i32'], ['param', '$n', 'f64'], ['param', '$k', 'i32'], ['result', 'i32'], ['local', '$b', 'f64'],
      ['local.set', '$b', ['f64.min', ['local.get', '$n'], strict ? ['f64.convert_i32_s', ['local.get', '$k']] : ['f64.const', 2147483646]]],
      ['loop', '$loop', ['return', [`f64.${compare}`, ...(reverse ? [n, i] : [i, n])]]], ['i32.const', 0]]
    narrowLoopBound(fn)
    const m = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(['module', fn]))).exports
    const text = JSON.stringify(fn)
    ok(text.includes('i32.trunc_sat_f64_s') && !text.includes('i64.'), `${compare}: one word threshold`)
    for (const value of [-2147483648, -2, -1, 0, 1, 2147483646, 2147483647])
      for (const bound of [NaN, -Infinity, -1e30, -2147483649, -2147483648, -2.5, -2, -0, 0.5, 2147483646.5, 2147483647, 1e30, Infinity])
        for (const k of [-2147483648, -1, 0, 3, 2147483646, 2147483647]) {
          const b = Math.min(bound, strict ? k : 2147483646)
          is(m.f(value, bound, k), Number(strict ? value < b : value <= b), `${compare} i=${value}, n=${bound}, k=${k}`)
        }
  }
  // a minimum with infinity, or with a parameter alone, is no bound: the wide threshold stays
  for (const other of [['f64.const', 'inf'], ['local.get', '$n']]) {
    const fn = ['func', '$f', ['param', '$i', 'i32'], ['param', '$n', 'f64'], ['result', 'i32'], ['local', '$b', 'f64'],
      ['local.set', '$b', ['f64.min', ['local.get', '$n'], other]],
      ['loop', '$loop', ['return', ['f64.lt', ['f64.convert_i32_s', ['local.get', '$i']], ['local.get', '$b']]]], ['i32.const', 0]]
    narrowLoopBound(fn)
    ok(JSON.stringify(fn).includes('i64.trunc_sat_f64_s'), `min with ${other[1]}: the wide threshold`)
  }
})

test('narrowLoopBound: raw i32 comparisons preserve every Number threshold', () => {
  for (const [compare, reverse] of [['lt', false], ['le', false], ['gt', true], ['ge', true]]) {
    const i = ['f64.convert_i32_s', ['local.get', '$i']], n = ['local.get', '$n']
    const fn = ['func', '$f', ['export', '"f"'], ['param', '$i', 'i32'], ['param', '$n', 'f64'], ['result', 'i32'],
      ['loop', '$loop', ['return', [`f64.${compare}`, ...(reverse ? [n, i] : [i, n])]]], ['i32.const', 0]]
    narrowLoopBound(fn)
    const m = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(['module', fn]))).exports
    ok(JSON.stringify(fn).includes('i64.trunc_sat_f64_s'), 'one exact wide threshold')
    for (const value of [-2147483648, -2, -1, 0, 1, 2147483646, 2147483647])
      for (const bound of [NaN, -Infinity, -1e30, -2147483649, -2147483648, -2.5, -2, -0, 0.5, 2147483646.5, 2147483647, 2147483647.5, 2147483648, 1e30, Infinity])
        is(m.f(value, bound), Number(compare === 'lt' || compare === 'gt' ? value < bound : value <= bound), `${compare} i=${value}, n=${bound}`)
  }
})
