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
// CI gate: the second pass re-runs watr with the SAME options `compile()` itself
// resolved for this tier (`resolveWatrOpts`, index.js) — not watr's bare defaults.
// watr's bare defaults lean size (outline/tailmerge/rettail ON: fold repeated
// code into out-of-line calls), which the 'speed' tier deliberately disables
// (measured 1.433→1.316 self-host slowdown with them on — see resolveWatrOpts'
// `watrProfile` comment). Comparing against bare defaults made every kernel with
// duplicated NaN-box tag-classification code (any exported fn boundary-boxing a
// param) look like a miss, when it was watr running a DIFFERENT rewrite system
// than the one jz configured — not jz leaving a rewrite on the table. Matching
// the options closes the false positives; a delta that survives THIS comparison
// is real waste, so this script exits non-zero on any.
import { compile, resolveWatrOpts } from '../index.js'
import { resolveOptimize } from '../src/optimize/index.js'
import parseWat from 'watr/parse'
import { optimize as watOptimize } from 'watr/optimize'
import { countOps, loopCount } from './wat-probe.mjs'

// HOT-PATH metric: ops lexically inside a `(loop …)`. Local optimality that matters
// for SPEED lives in the loop body — whole-module deltas are dominated by
// speed-neutral control-flow restructuring (watr's brif: block+br_if → if/then) and
// module-level inlineOnce, neither of which jz's pipeline does (brif is neutral;
// re-inlining would reintroduce the rebox/unbox the post phase folded). So the verdict
// gates on LOOP-BODY convergence; whole-module is reported as secondary context.
const loopOps = (tree) => loopCount(tree, (n) => typeof n[0] === 'string')
// "Real" hot-path work = anything that isn't control-flow/local plumbing. A loop-body
// delta made up ONLY of these is watr's brif restructuring (block+br_if+eqz → if/then)
// — speed-neutral, not waste. A delta touching arithmetic/memory/SIMD is real.
const NEUTRAL = new Set(['block', 'loop', 'if', 'then', 'else', 'br', 'br_if', 'br_table',
  'result', 'i32.eqz', 'local.get', 'local.set', 'local.tee', 'nop', 'drop', 'end'])
const realLoopOps = (tree) => loopCount(tree, (n) => typeof n[0] === 'string' && !NEUTRAL.has(n[0]))

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

// The exact watr config the 'speed' tier resolves to (index.js's compile() builds
// this per-compile from live ctx; the two ctx-only refinements — function count
// for the unroll2 partial-unroll gate, JS-boundary vectorized-fn pins — don't
// change the verdict for this single-function corpus, so the cfg-only call is
// a faithful stand-in).
const SPEED_WATR_OPTS = resolveWatrOpts(resolveOptimize('speed'))

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)

console.log('Local-optimality audit (Tier 2) — is jz output a fixpoint of its own optimizer (watr)?\n')
console.log(`${pad('kernel', 28)} ${padL('loop', 5)} ${padL('re-watr', 8)} ${padL('module', 8)}  verdict`)
console.log('─'.repeat(74))

let fixpoints = 0, checked = 0
const misses = []
for (const { name, src } of CORPUS) {
  let lb, lbAfter, realDrop, modDrop
  try {
    const tree = parseWat(compile(src, { optimize: 'speed', wat: true }))
    lb = loopOps(tree)
    const re = watOptimize(tree, SPEED_WATR_OPTS)
    lbAfter = loopOps(re)
    realDrop = realLoopOps(tree) - realLoopOps(re)   // hot-path arithmetic/memory/SIMD only
    modDrop = countOps(tree) - countOps(re)          // whole-module, secondary
  } catch (e) {
    console.log(`${pad(name, 28)} ${padL('ERR', 5)}  ${e.message.slice(0, 36)}`)
    misses.push({ name, drop: `ERR: ${e.message.slice(0, 60)}` })
    continue
  }
  checked++
  const drop = lb - lbAfter
  const note = realDrop <= 0 && drop > 0 ? `(−${drop} brif, neutral)` : modDrop > 0 ? `module −${modDrop}` : ''
  // A loop is "converged for speed" iff no REAL (non-control-flow) op is removable.
  if (realDrop <= 0) { fixpoints++; console.log(`${pad(name, 28)} ${padL(lb, 5)} ${padL(lbAfter, 8)} ${padL(modDrop > 0 ? '−' + modDrop : '0', 8)}  loop fixpoint ✓ ${note}`) }
  else { misses.push({ name, drop: realDrop }); console.log(`${pad(name, 28)} ${padL(lb, 5)} ${padL(lbAfter, 8)} ${padL('−' + modDrop, 8)}  ✗ LOOP not a fixpoint (−${realDrop} real)`) }
}

console.log('─'.repeat(74))
console.log(`\nhot-loop locally optimal (loop body is a watr fixpoint): ${fixpoints}/${checked}`)
if (!misses.length) {
  console.log('PASS: every kernel\'s loop body is a watr fixpoint — no hot-path rewrite left on the table.')
  console.log('(Whole-module `−N` deltas above are speed-neutral: watr brif restructuring + module-level inlineOnce that jz\'s pipeline deliberately skips.)')
} else {
  console.log(`ATTENTION: ${misses.length} kernel(s) have a non-fixpoint LOOP BODY — real per-iteration waste:`)
  for (const m of misses) console.log(`  ${m.name}: a second watr pass removes ${m.drop} more loop-body ops`)
  console.log(`(These are genuine hot-path candidates, measured under jz's OWN speed-tier watr config — see resolveWatrOpts in index.js — so this is not a config-choice artifact.)`)
  process.exitCode = 1
}
