// for-in / generic-dispatch deopt: correctness + the perf-cliff guards.
//
// for-in over a static-schema object used to lower to a per-iteration Object.keys
// allocation + a dynamic `o[k]` get — 8–9× slower than V8 and an unbounded heap
// leak. It now (a) unrolls over the static schema with key-literal substitution so
// `o[k]` folds to a schema slot, or (b) when it can't unroll (break/continue, a
// closure capturing the key, a computed-write object), falls back to a loop whose
// key array is a pooled static constant (`__keys_ro`) — never a per-iteration alloc.
//
// This file is the regression detector: a differential correctness sweep across
// object shapes and body forms (diffed against the SAME source run as JS), machine-
// independent codegen pins (no dynamic dispatch survives an unrollable for-in), and
// a behavioral pin (a hot for-in does not grow memory). Objects are kept LOCAL to
// the exported fn — matching the existing for-in suite — so the cases also hold
// under the hostless WASI boundary (module-global heap init is a separate axis).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, onWasi } from './_matrix.js'
import jz, { compile } from '../index.js'

// Extract one WAT function body by paren-matching (slicing on the next `(func`
// overruns into later functions — e.g. lifted closures — and gives false positives).
function funcWat(wat, name) {
  const start = wat.indexOf(`(func $${name}`)
  if (start < 0) return ''
  let depth = 0
  for (let i = start; i < wat.length; i++) {
    if (wat[i] === '(') depth++
    else if (wat[i] === ')' && --depth === 0) return wat.slice(start, i + 1)
  }
  return wat.slice(start)
}

// Run `src` as jz-wasm and as JS, assert equal. `src` must export `run`, which
// takes a (possibly ignored) parameter — a no-arg export is the reserved void
// command entry under the WASI boundary, so every case is parameterized.
function diff(src, arg = 0) {
  const jsRun = new Function(`${src.replace(/export\s+let\s+run\s*=/, 'let run =')}\nreturn run`)()
  const { exports } = jz(src)
  const want = jsRun(arg), got = exports.run(arg)
  is(got, want, src.replace(/\s+/g, ' ').trim().slice(0, 80))
  return got
}

// ── Correctness sweep: for-in body forms over a static schema (these unroll) ──
test('for-in deopt: value sum / key concat / mixed over static schema', () => {
  diff('export let run=(z)=>{let o={a:1,b:2,c:3,d:4}; let s=0; for(let k in o) s+=o[k]; return s}')
  diff('export let run=(z)=>{let o={x:1,y:2,z:3}; let r=""; for(let k in o) r=r+k; return r}')
  diff('export let run=(z)=>{let o={a:10,b:20,c:30}; let s=0; for(let k in o){ if(k==="b") s+=o[k] } return s}')
  diff('export let run=(n)=>{let o={a:1,b:2,c:3,d:4}; let s=0; for(let i=0;i<n;i++){for(let k in o) s+=o[k]} return s}', 5)
})

test('for-in deopt: body forms that must NOT unroll still compute correctly', () => {
  // break / continue (can't unroll — must keep loop semantics)
  diff('export let run=(z)=>{let o={a:1,b:2,c:3,d:4}; let s=0; for(let k in o){ if(o[k]===2) break; s+=o[k] } return s}')
  diff('export let run=(z)=>{let o={a:1,b:2,c:3,d:4}; let s=0; for(let k in o){ if(o[k]===2) continue; s+=o[k] } return s}')
  // a closure capturing the loop key (cloneWithSubst skips `=>` bodies → no unroll)
  diff('export let run=(z)=>{let o={a:1,b:2,c:3}; let s=0; for(let k in o){ let f=()=>o[k]; s+=f() } return s}')
})

test('for-in deopt: key count above the unroll cap still correct (pooled loop)', () => {
  const k16 = 'abcdefghijklmnop'.split('').map((c, i) => `${c}:${i + 1}`).join(',')
  const k20 = k16 + ',q:17,r:18,s:19,t:20'
  diff(`export let run=(z)=>{let o={${k16}}; let s=0; for(let k in o) s+=o[k]; return s}`)   // 16 = cap → unrolls
  diff(`export let run=(z)=>{let o={${k20}}; let s=0; for(let k in o) s+=o[k]; return s}`)   // 20 > cap → pooled loop
})

test('for-in deopt: computed-key writes enumerate via fallback (not the static pool)', () => {
  // Empty-literal dict grown by computed writes is a true HASH — enumerate dynamically.
  diff('export let run=(z)=>{let ks=["p","q","r"]; let o={}; for(let i=0;i<3;i++) o[ks[i]]=i+1; let s=0; for(let k in o) s+=o[k]; return s}')
})

// ── Codegen pins (machine-independent): an unrollable for-in leaves no dispatch ──
test('for-in deopt: static-schema for-in unrolls — no __keys_ro, no __dyn_get', () => {
  if (belowOpt(1)) return   // unroll is an optimization pass
  const wat = compile('export let run=(n)=>{let o={a:1,b:2,c:3}; let s=0; for(let i=0;i<n;i++){for(let k in o) s+=o[k]} return s}', { wat: true })
  const body = funcWat(wat, 'run')
  ok(!body.includes('__keys_ro'), 'no runtime key array (unrolled)')
  ok(!body.includes('$__dyn_get'), 'no dynamic property get (folded to slots)')
})

test('for-in deopt: fallback for-in keeps an allocation-free pooled key array', () => {
  // A for-in whose body breaks can't unroll, but its key array must still be the
  // pooled __keys_ro constant — never the allocating Object.keys / emitStringArray.
  const wat = compile('export let run=()=>{let o={a:1,b:2,c:3}; let s=0; for(let k in o){ if(o[k]===2) break; s+=o[k] } return s}', { wat: true })
  const body = funcWat(wat, 'run')
  ok(!body.includes('__keys_ro'), 'keys pooled to a static constant, not built at runtime')
})

// ── Behavioral pin: a hot for-in does not grow memory (the OOM-cliff guard) ──
test('for-in deopt: hot for-in is allocation-free (no memory growth)', () => {
  if (onWasi()) return   // the JS memory codec is the js-host path
  const { exports, memory } = jz('export let run=(n)=>{let o={a:1,b:2,c:3,d:4}; let s=0; for(let i=0;i<n;i++){for(let k in o) s+=o[k]} return s}')
  exports.run(1000)
  const before = memory.buffer.byteLength
  exports.run(2_000_000)
  is(memory.buffer.byteLength, before, 'no heap growth across 2M for-in iterations')
})
