#!/usr/bin/env node
// One-shot LOCAL-OPTIMALITY audit (proof-ladder Tier 2) — is jz's output a
// fixpoint of its OWN rewrite system?
//
// "Minimal theoretical WASM per construct" (research.md) is a local-optimality
// claim: no rewrite jz knows should improve the output further. The sound,
// machine-independent test is IDEMPOTENCE — re-run jz's own optimizer (watr) on
// the finished output and assert it removes nothing. If a SECOND pass shrinks it,
// the pipeline didn't converge: a local rewrite was left on the table.
//
// Why watr and not wasm-opt: a FOREIGN optimizer (wasm-opt -O3) is NOT a valid
// oracle here — it UNROLLS and re-vectorizes, which RAISES the static op count on
// some kernels (biquad/matmul/crc) while lowering it on others, so its delta
// conflates "jz left slack" with "wasm-opt made a different size↔speed trade".
// watr is jz's own rewrite system, so its delta is unconfounded: a drop is a
// rewrite jz's pipeline could have made but didn't.
//
// Not a CI gate (yet): the bare watr/optimize runs DEFAULT settings, which may be
// more aggressive than jz's tier-specific watr config, so a small delta can be a
// config choice rather than a true miss. Run on demand (`npm run audit:fixpoint`);
// a non-fixpoint is a candidate to investigate, not an automatic bug.
import { compile } from '../index.js'
import parseWat from 'watr/parse'
import { optimize as watOptimize } from 'watr/optimize'
import { countOps } from './wat-probe.mjs'

// Kernels spanning the construct space: scalar recurrence, reductions, stencils,
// nested loops, integer bit-twiddling, conditional maps.
const CORPUS = [
  { name: 'biquad (IIR recurrence)', src: `export let f=(x,y,n)=>{ for(let i=2;i<n;i++) y[i]=0.5*x[i]+0.3*x[i-1]-0.2*y[i-1] }` },
  { name: 'dot product (reduction)', src: `export let f=()=>{ const a=new Float64Array(256); let s=0.0; for(let i=0;i<256;i++) s=s+a[i]*a[i]; return s }` },
  { name: 'sum (map + reduction)', src: `export let f=()=>{ const a=new Float64Array(1024); for(let i=0;i<1024;i++) a[i]=i*0.5; let s=0.0; for(let i=0;i<1024;i++) s=s+a[i]; return s }` },
  { name: 'mandelbrot (escape)', src: `export let f=(cx,cy,m)=>{ let zx=0.0,zy=0.0,i=0; while(i<m&&zx*zx+zy*zy<=4.0){ let t=zx*zx-zy*zy+cx; zy=2.0*zx*zy+cy; zx=t; i=i+1|0 } return i|0 }` },
  { name: 'matmul (nested)', src: `export let f=(a,b,c,n)=>{ for(let i=0;i<n;i++) for(let j=0;j<n;j++){ let s=0.0; for(let k=0;k<n;k++) s=s+a[i*n+k]*b[k*n+j]; c[i*n+j]=s } }` },
  { name: 'heat (stencil)', src: `export let f=(u,v,n)=>{ for(let i=1;i<n-1;i++) v[i]=u[i]+0.2*(u[i-1]-2.0*u[i]+u[i+1]) }` },
  { name: 'crc32 (bit-twiddle)', src: `export let f=(b,n)=>{ let c=4294967295; for(let i=0;i<n;i++){ c=c^b[i]; for(let k=0;k<8;k++) c=(c>>>1)^(3988292384&-(c&1)) } return (c^4294967295)>>>0 }` },
  { name: 'saxpy (param arrays)', src: `export let f=(a,x,y,n)=>{ for(let i=0;i<n;i++) y[i]=a*x[i]+y[i] }` },
  { name: 'clamp map (conditional)', src: `export let f=()=>{ const a=new Float64Array(256); for(let i=0;i<256;i++) a[i]=a[i]<0.0?0.0:(a[i]>1.0?1.0:a[i]); return a[0] }` },
  { name: 'fib (recursion)', src: `export let fib=(n)=> n<2 ? n : fib(n-1)+fib(n-2)` },
]

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)

console.log('Local-optimality audit (Tier 2) — is jz output a fixpoint of its own optimizer (watr)?\n')
console.log(`${pad('kernel', 28)} ${padL('jz ops', 7)} ${padL('re-watr', 8)}  verdict`)
console.log('─'.repeat(70))

let fixpoints = 0, checked = 0
const misses = []
for (const { name, src } of CORPUS) {
  let before, after
  try {
    const tree = parseWat(compile(src, { optimize: 'speed', wat: true }))
    before = countOps(tree)
    after = countOps(watOptimize(tree))
  } catch (e) {
    console.log(`${pad(name, 28)} ${padL('ERR', 7)}  ${e.message.slice(0, 36)}`)
    continue
  }
  checked++
  const drop = before - after
  if (drop <= 0) { fixpoints++; console.log(`${pad(name, 28)} ${padL(before, 7)} ${padL(after, 8)}  fixpoint ✓`) }
  else { misses.push({ name, drop }); console.log(`${pad(name, 28)} ${padL(before, 7)} ${padL(after, 8)}  ✗ NOT a fixpoint (−${drop})`) }
}

console.log('─'.repeat(70))
console.log(`\nlocally optimal (fixpoint of jz's own rewrite system): ${fixpoints}/${checked}`)
if (!misses.length) {
  console.log('PASS: every kernel is a watr fixpoint — no local rewrite left on the table.')
} else {
  console.log(`ATTENTION: ${misses.length} kernel(s) are not fixpoints — jz's pipeline didn't run watr to convergence:`)
  for (const m of misses) console.log(`  ${m.name}: a second watr pass removes ${m.drop} more ops`)
  console.log(`(These are CANDIDATES — confirm the delta is speed-relevant, not a default-watr-vs-jz-config size trade, before changing the pipeline. Reduction kernels are the known cluster.)`)
}
