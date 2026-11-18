// Integer array literals promoted to typed arrays (promoteIntArrayLiterals), the
// typed-array methods they reach, and reads of arrays whose kind is known.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels, ownedLevels } from './_matrix.js'
import parseWat from 'watr/parse'
import { run, oracle, jz, compile } from './util.js'
import { count, walk } from '../scripts/wat-probe.mjs'
import { findFunc, compileMain } from './_optimizer.js'

test('hoistIndexedConstLiterals: `[consts][i]` reads one shared data segment — no per-evaluation alloc', () => {
  // The Sierpinski-floatbeat shape: three chord tables read per SAMPLE, each a
  // fresh 144 B alloc + stores because the '[' static lowering is module-scope
  // gated. A literal in RECEIVER position of its own read can't escape or be
  // written, so prepare hoists it to a synthetic module const (content-interned)
  // and the static base/len fold applies. 2.42× behind V8 → 0.94× on the beat.
  const src = `export let f = (t) => {
    let k = t >> 2
    let c1 = -[2, 4, 2, 9][k & 3]
    let c2 = [5, 0, 5, 0][k & 3]
    let c3 = [2, 4, 2, 9][(k + 1) & 3]
    return c1 * 100 + c2 * 10 + c3
  }`
  const w = compile(src, { wat: true, optimize: 3 })
  ok(!/call \$__alloc\b/.test(w.split(/(?=\(func \$)/).find(p => p.startsWith('(func $f')) || 'call $__alloc'),
    'no allocation in the reading function')
  const { f } = run(src, { optimize: 3 })
  is(f(0), -146); is(f(4), -398); is(f(8), -141)
  // out-of-bounds still undefined, and a WRITTEN named literal keeps the heap form
  const oob = run(`export let f = (t) => [1, 2][t]`, { optimize: 3 }).f
  is(oob(1), 2); is(oob(7), undefined)
  const wr = run(`export let f = (t) => { let a = [1, 2]; a[0] = t; return a[0] + a[1] }`, { optimize: 3 }).f
  is(wr(5), 7)
  // write-position literal reads are BANNED from the hoist: `[1,2][0] = 99` writes a
  // fresh discarded array — hoisted it would corrupt the shared segment under every
  // read interned to the same content
  const wp = run(`export let f = (k) => { [1, 2][0] = 99; return [1, 2][k] }`, { optimize: 3 }).f
  is(wp(0), 1); is(wp(1), 2)
})

test('arrayElemValType: typed-array .map elides __to_num in callback', () => {
  // Float64Array elements have known type NUMBER → __to_num coercion can be
  // elided in the inlined .map callback param.
  const wat = compile(`
    export const main = () => {
      const a = new Float64Array([1, 2, 3, 4])
      const b = a.map(x => x * 2)
      return b[0] | 0
    }
  `, { wat: true })
  const calls = (wat.match(/\(call \$__to_num/g) || []).length
  is(calls, 0)
})

test('arrayElemValType: typed-array .map runtime correctness', () => {
  const { main } = run(`
    export const main = () => {
      const a = new Float64Array([1, 2, 3, 4])
      const b = a.map(x => x * 2 + 1)
      return (b[0] + b[1] + b[2] + b[3]) | 0
    }
  `)
  // (3 + 5 + 7 + 9) = 24
  is(main(), 24)
})

test('typed-array address fusion: arr[i + k] uses one base plus offsets', () => {
  // Static len + masked idx: the accesses are PROVEN in-bounds (mask class), so the
  // bare loads the fusion peephole matches survive Root F's checked-by-default
  // typed indexing (unprovable single accesses now emit branchless checked selects,
  // which have no shared-base contract).
  const wat = compile(`
    export const main = (idx) => {
      const a = new Float64Array(64)
      const i = idx & 31
      return a[i + 0] + a[i + 1] + a[i + 2] + a[i + 3]
    }
  `, { wat: true, optimize: { watr: false } })
  const body = findFunc(parseWat(wat), '$main'), loads = []
  walk(body, n => { if (n[0] === 'f64.load') loads.push(n) })
  is(loads.length, 4, 'exactly four element loads')
  const base = loads[0]?.at(-1)
  is(base?.[0], 'local.tee', 'first load computes and saves the shared address')
  is(count(base, n => n[0] === 'i32.shl'), 1, 'the element address scales once')
  for (let i = 1; i < loads.length; i++) {
    ok(loads[i].includes(`offset=${i * 8}`), `element ${i} uses its byte offset`)
    is(loads[i].at(-1), ['local.get', base[1]], `element ${i} reads the same address local after slot reuse`)
  }
  const src = `const a=new Float64Array([${Array.from({length:64},(_,i)=>i*.5-7)}]);
    export const main=idx=>{const i=idx&31;return a[i]+a[i+1]+a[i+2]+a[i+3]}`
  const expected = oracle(src).main
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const actual = run(src, { optimize }).main
    for (const idx of [0,0,1,31,32,-1,1.5,2147483648,4294967295,0])
      is(actual(idx), expected(idx), `O${optimize}, shared address at ${idx}`)
  }
})

test('known array at reads header length directly', () => {
  const wat = compile(`
    export const main = () => {
      const a = [10, 20, 30]
      return a.at(-1)
    }
  `, { wat: true, optimize: { watr: false } })
  ok(!/\(call \$__len\b/.test(wat), 'known ARRAY .at should not dispatch through __len')
  ok(/i32\.load/.test(wat), 'negative .at should read the known ARRAY header length')
  const { main } = run(`
    export const main = () => {
      const a = [10, 20, 30]
      return a.at(-1) + a.at(0)
    }
  `)
  is(main(), 40)
})

test('array shift stays O(1)', () => {
  const wat = compile(`
    export const main = () => {
      const a = []
      for (let i = 0; i < 16; i++) a.push(i)
      let s = 0
      for (let i = 0; i < 16; i++) s += a.shift()
      return s
    }
  `, { wat: true, optimize: { watr: false } })
  const helper = wat.match(/\(func \$__arr_shift[\s\S]*?\n  \)/)?.[0] || ''
  ok(helper, 'expected __arr_shift helper to be emitted')
  ok(!/memory\.copy/.test(helper), 'array shift should slide the data pointer instead of copying elements')
})

test('array map/filter reuse receiver pointer for sizing and iteration', () => {
  // Float literals keep the array ARRAY-shaped (int-only would auto-promote to
  // TYPED via plan/literals.js's promoteIntArrayLiterals and route through
  // .typed:map / .typed:filter, which DO call $__len).
  const wat = compile(`
    export const main = () => {
      const a = [1.5, 2.5, 3.5, 4.5]
      const b = a.map(x => x + 1)
      const c = b.filter(x => x > 2)
      return c.length + c[0]
    }
  `, { wat: true, optimize: { watr: false } })
  const mainBody = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  ok(!/\(call \$__len\b/.test(mainBody), 'known ARRAY map/filter should size from the resolved header length')
  const { main } = run(`
    export const main = () => {
      const a = [1.5, 2.5, 3.5, 4.5]
      const b = a.map(x => x + 1)
      const c = b.filter(x => x > 2)
      return c.length * 10 + c[0]
    }
  `)
  is(main(), 42.5)
})

test('known array numeric index skips generic array tag dispatch', () => {
  const wat = compile(`
    export const main = (a) => {
      if (Array.isArray(a)) return a[0]
      return 0
    }
  `, { wat: true, optimize: { watr: false } })
  const mainBody = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  // A known plain ARRAY + numeric key lowers to a monomorphic access: the
  // inline bounds-checked f64.load fast path (`idx < len ? load : undefined`,
  // no call) — or, for back-compat, the `__arr_idx_known` helper.
  if (!onKernel()) ok(/f64\.load/.test(mainBody) || /\((?:return_)?call \$__arr_idx_known\b/.test(mainBody),
    'known ARRAY numeric index should use the monomorphic inline load (or __arr_idx_known helper)')  // self-compile kernel codegen differs; in-process leg owns the shape check
  if (!onKernel()) ok(!/\((?:return_)?call \$__arr_idx\b(?!_known)/.test(mainBody), 'known ARRAY numeric index should skip generic tag-dispatch helper')
  const { main } = run(`
    export const main = (a) => {
      if (Array.isArray(a)) return a[0]
      return 0
    }
  `)
  is(main([7, 8, 9]), 7)
})

test('known array spread skips string/typed item dispatch', () => {
  const wat = compile(`
    const copy = (a) => [...a]
    export const main = () => copy([1, 2, 3])[1]
  `, { wat: true, optimize: { watr: false, sourceInline: false } })
  const copyBody = wat.match(/\(func \$copy[\s\S]*?\n  \)/)?.[0] || ''
  ok(/\(memory\.copy\b/.test(copyBody), 'known ARRAY spread should bulk-copy with memory.copy')
  ok(!/\(call \$__str_idx\b/.test(copyBody), 'known ARRAY spread should skip string indexing')
  ok(!/\(call \$__typed_idx\b/.test(copyBody), 'known ARRAY spread should skip typed/runtime indexing')
  const { main } = run(`
    const copy = (a) => [...a]
    export const main = () => copy([1, 2, 3])[1]
  `)
  is(main(), 2)
})

// promoteIntArrayLiterals (Workstream #4)
//
// `let xs = [intLit, …]` with read-only usage and no shape-changing methods
// gets rewritten to `let xs = new Int32Array([intLit, …])`.

test('promoteIntArrayLiterals: int-only literal with read-only loop → TYPED + SIMD', () => {
  const src = `
    export const main = () => {
      const xs = [1, 2, 3, 4, 5, 6, 7, 8]
      let s = 0
      for (let i = 0; i < xs.length; i++) s += xs[i]
      return s
    }
  `
  const body = compileMain(src)
  ok(/\(local \$xs i32\)/.test(body), 'xs carrier should be promoted from f64 ARRAY to i32 TYPED')
  ok(!/\$__arr_idx_known\b/.test(body), 'promoted TYPED indexing should skip the ARRAY monomorphic helper')
  ok(/i32x4\./.test(body), 'reduction over promoted Int32Array should auto-vectorize via i32x4 SIMD')
  const { main } = run(src)
  is(main(), 36)
})

// Dynamic-index loop suppresses scalarizeFunctionArrayLiterals (which would
// fold const-index reads into per-element locals) so the carrier survives
// to the promotion gate.
const loopSum = (lit) => `
    export const main = (k) => {
      const xs = ${lit}
      let s = 0
      for (let i = 0; i < xs.length; i++) s += xs[i + (k & 0)]
      return s
    }
  `

test('promoteIntArrayLiterals: float element disqualifies', () => {
  const src = loopSum('[1, 2, 3, 4, 5, 6, 7, 8.5]')
  const body = compileMain(src)
  // Propagation can remove the carrier local; the element lane must stay f64.
  ok(/\(f64.load\b/.test(body) && !/i32x4\./.test(body), 'float elements retain f64 loads')
  const { main } = run(src)
  is(main(0), 36.5)
})

// -0 is no i32 (static.js intLiteralValue): as words the array read +0 back
test('promoteIntArrayLiterals: a -0 element keeps its sign', () => {
  const src = `export let f = (i) => { const V = [-0, 0, 1, 2]; return 1 / V[i & 3] }`
  for (const optimize of levels(false, true, 'speed')) is(jz(src, { optimize }).exports.f(0), -Infinity, `1 / V[0] at ${optimize}`)
})

test('promoteIntArrayLiterals: negative literals are i32-valid', () => {
  const src = loopSum('[-1, -2, -3, -4, -5, -6, -7, -8]')
  const body = compileMain(src)
  ok(/\(local \$xs i32\)/.test(body), 'unary-minus on int literals stays i32-promotable')
  const { main } = run(src)
  is(main(0), -36)
})

test('promoteIntArrayLiterals: .push disqualifies (length mutation)', () => {
  const src = `
    export const main = () => {
      const xs = [1, 2, 3]
      xs.push(4)
      return xs.length
    }
  `
  // Isolate the storage decision from subsequent removal of its carrier local.
  // (the box is a Number, or its bits where the function reads it only as bits: int-narrow.js narrowBoxedLocals)
  const body = compileMain(src, { propagateLocals: false })
  ok(/\(local \$xs (?:f64|i64)\)/.test(body), '.push needs growable ARRAY storage; promotion must skip')
  const { main } = run(src)
  is(main(), 4)
})

// A test the summary decides folds before promotion (plan/fold-kind-tests.js):
// the promoted literal never meets it.
test('promoteIntArrayLiterals: Array.isArray disqualifies (typed arrays return false)', () => {
  const decided = `
    export const main = () => {
      const xs = [1, 2, 3]
      return Array.isArray(xs) ? xs.length : -1
    }
  `
  is(run(decided).main(), 3, 'a decided test folds, its answer kept')
  const src = `
    const isArr = (v) => Array.isArray(v)
    export const main = () => {
      const xs = [1, 2, 3]
      return (isArr(xs) ? xs.length : -1) + (isArr(7) ? 100 : 0)
    }
  `
  const body = compileMain(src, { propagateLocals: false })
  ok(/\(local \$xs (?:f64|i64)\)/.test(body), 'Array.isArray would flip true→false under promotion')
  const { main } = run(src)
  is(main(), 3)
})

test('promoteIntArrayLiterals: element write disqualifies', () => {
  const src = `
    export const main = (k) => {
      const xs = [1, 2, 3, 4, 5]
      xs[k & 0] = 9
      let s = 0
      for (let i = 0; i < xs.length; i++) s += xs[i]
      return s
    }
  `
  const body = compileMain(src)
  ok(/\(local \$xs (?:f64|i64)\)/.test(body), 'element writes break v1 read-only assumption')
  const { main } = run(src)
  is(main(0), 23)
})

test('promoteIntArrayLiterals: bare-name escape disqualifies', () => {
  const src = `
    const sumArr = (a) => {
      let s = 0
      for (let i = 0; i < a.length; i++) s += a[i]
      return s
    }
    export const main = () => {
      const xs = [1, 2, 3]
      return sumArr(xs)
    }
  `
  const body = compileMain(src, { propagateLocals: false })
  ok(/\(local \$xs (?:f64|i64)\)/.test(body), 'escape to callee with unknown receiver shape disqualifies')
  const { main } = run(src)
  is(main(), 6)
})

test('promoteIntArrayLiterals: closure-capture disqualifies', () => {
  // The inliner folds a local arrow wherever every call folds; a bare
  // reference to it (`pick`) keeps it a real captured closure for the gate.
  const src = `
    export const main = (k) => {
      let count = 0
      const xs = [1, 2, 3, 4, 5]
      const at = (i) => { count = count + 1; return xs[i] }
      const pick = k < 0 ? at : at
      let s = 0
      for (let i = 0; i < xs.length; i++) s += pick((i + (k & 0)) | 0)
      return s + count
    }
  `
  const body = compileMain(src)
  ok(/\(local \$xs (?:f64|i64)\)/.test(body), 'capture into nested arrow disqualifies (shape unknown to inner)')
  const { main } = run(src)
  is(main(0), 20)
})

test('promoteIntArrayLiterals: spread receiver disqualifies', () => {
  // Dynamic-index loop keeps xs alive past scalarizeFunctionArrayLiterals;
  // the `[...xs]` spread is then the deciding disqualifier on the still-live
  // candidate.
  const src = `
    export const main = (k) => {
      const xs = [1, 2, 3, 4, 5]
      let s = 0
      for (let i = 0; i < xs.length; i++) s += xs[i + (k & 0)]
      const ys = [...xs]
      return s + ys[0]
    }
  `
  const body = compileMain(src)
  ok(/\(local \$xs (?:f64|i64)\)/.test(body), '...spread expands generically over ARRAY; disqualify')
  const { main } = run(src)
  is(main(0), 16)
})

test('promoteIntArrayLiterals: .map promotes (.typed:map emits TYPED result; downstream re-dispatches via VAL.TYPED)', () => {
  // .typed:map returns a TYPED carrier; subsequent .filter/.slice/[idx] on
  // that carrier route through .typed:* emitters via emit.js:2211 lookup.
  const src = `
    export const main = () => {
      const xs = [1, 2, 3, 4]
      const ys = xs.map(x => x + 1)
      return ys.length + ys[0]
    }
  `
  const body = compileMain(src)
  ok(!/\(local \$xs f64\)/.test(body), 'xs is consumed as static data; no f64 local')
  ok(/\(local \$ys i32\)/.test(body), 'ys is unboxed i32 TYPED ptr')
  const { main } = run(src)
  is(main(), 6)
})

test('promoteIntArrayLiterals: .filter promotes (.typed:filter emits same-element-type TYPED)', () => {
  const src = `
    export const main = () => {
      const xs = [1, 2, 3, 4]
      const ys = xs.filter(x => x > 2)
      return ys.length
    }
  `
  const body = compileMain(src)
  ok(!/\(local \$xs f64\)/.test(body), 'xs is consumed as static data; no f64 local')
  const { main } = run(src)
  is(main(), 2)
})

test('promoteIntArrayLiterals: string-literal key disqualifies (NaN-coercion would return a[0] instead of undefined)', () => {
  // `a[k]` where k is a string literal: after promotion to Int32Array,
  // `i32.trunc_sat_f64_s(NaN-boxed-string) = 0` silently returns a[0] = 1
  // instead of undefined.
  const src = `
    export const str_key = () => {
      const a = [1, 2, 3]
      const k = 'x'
      return a[k]  // must be undefined, not 1
    }
    export const num_key = () => {
      const a = [1, 2, 3]
      const k = 1
      return a[k]  // must be 2
    }
  `
  const body = compileMain(src)
  ok(/\(local \$a f64\)/.test(body) || !/\(local \$a i32\)/.test(body),
    'string-keyed read must prevent promotion of a to TYPED')
  const { str_key, num_key } = run(src)
  is(str_key(), undefined, 'a[k] where k="x" must return undefined, not 1')
  is(num_key(), 2, 'a[k] where k=1 must return 2')
})

test('promoteIntArrayLiterals: unknown-type param key disqualifies (string at runtime → NaN-coerce)', () => {
  // `a[k]` where k is a function parameter of unknown type: the caller may
  // pass a string.
  const src = `
    export const test_str = (k) => {
      const a = [10, 20, 30]
      return a[k]
    }
    export const test_num = (k) => {
      const a = [10, 20, 30]
      return a[k]
    }
  `
  const { test_str, test_num } = run(src)
  is(test_str('x'), undefined, 'string key on promoted-candidate array must return undefined')
  is(test_num(1), 20, 'numeric key on same array still returns the element')
})

test('.typed:forEach: side effect via captured slot (typed receiver via direct ctor)', () => {
  // `arr` is a tracked TypedArray binding via `new Float64Array([…])`, so
  // `.forEach` routes through .typed:forEach (emit.js:2211 dispatch).
  const { main } = run(`
    let total = 0
    let arr = new Float64Array([1, 2, 3, 4])
    arr.forEach(x => total += x)
    export const main = () => total
  `)
  is(main(), 10)
})

test('.typed:reduce: seeded and unseeded (typed receiver)', () => {
  const { seeded, unseeded } = run(`
    let arr = new Float64Array([1, 2, 3, 4])
    export const seeded = () => arr.reduce((a, b) => a + b, 10)
    export const unseeded = () => arr.reduce((a, b) => a + b)
  `)
  is(seeded(), 20)
  is(unseeded(), 10)
})

test('.typed:indexOf / .typed:includes (typed receiver)', () => {
  const { hit, miss, included } = run(`
    let arr = new Int32Array([10, 20, 30, 40])
    export const hit = () => arr.indexOf(30)
    export const miss = () => arr.indexOf(99)
    export const included = () => arr.includes(20) ? 1 : 0
  `)
  is(hit(), 2)
  is(miss(), -1)
  is(included(), 1)
})

test('.typed:find / .typed:findIndex (typed receiver)', () => {
  const { find, findIdx } = run(`
    let arr = new Float64Array([1, 2, 3, 4])
    export const find = () => arr.find(x => x > 2)
    export const findIdx = () => arr.findIndex(x => x > 2)
  `)
  is(find(), 3)
  is(findIdx(), 2)
})

test('.typed:some / .typed:every (typed receiver)', () => {
  const { some, everyT, everyF } = run(`
    let arr = new Float64Array([1, 2, 3, 4])
    export const some = () => arr.some(x => x > 3) ? 1 : 0
    export const everyT = () => arr.every(x => x > 0) ? 1 : 0
    export const everyF = () => arr.every(x => x > 2) ? 1 : 0
  `)
  is(some(), 1)
  is(everyT(), 1)
  is(everyF(), 0)
})

test('.typed:filter preserves element type', () => {
  const { main } = run(`
    let arr = new Int32Array([1, 2, 3, 4, 5])
    let out = arr.filter(x => x > 2)
    export const main = () => out.length * 100 + out[0] + out[1] * 10 + out[2] * 1000
  `)
  // [3, 4, 5] → length=3, [0]=3, [1]=4, [2]=5 → 3*100 + 3 + 4*10 + 5*1000 = 5343
  is(main(), 5343)
})

test('.typed:slice with negative and OOB indices', () => {
  const { mid, neg, oob, full } = run(`
    let arr = new Float64Array([10, 20, 30, 40, 50])
    export const mid = () => { let s = arr.slice(1, 4); return s.length * 1000 + s[0] + s[1] * 10 + s[2] * 100 }
    export const neg = () => { let s = arr.slice(-2); return s.length * 1000 + s[0] + s[1] * 10 }
    export const oob = () => { let s = arr.slice(2, 99); return s.length * 1000 + s[0] }
    export const full = () => arr.slice().length
  `)
  is(mid(), 3000 + 20 + 300 + 4000)  // [20, 30, 40]
  is(neg(), 2000 + 40 + 500)          // [40, 50]
  is(oob(), 3000 + 30)                 // [30, 40, 50]
  is(full(), 5)                        // [10,20,30,40,50]
})

test('promoteIntArrayLiterals: a .filter().map() chain answers as an Array\'s does', () => {
  // The map of a filter's result is no promoted map: the summary holds the
  // filter's array to no count (an index past what it kept is undefined), so a
  // walk over it may miss and its map's elements are not known words.
  const src = `
    export const main = () => {
      const xs = [1, 2, 3, 4, 5]
      const ys = xs.filter(x => x > 2).map(x => x * 10)
      return ys.length * 100 + ys[0] + ys[1] * 10 + ys[2] * 1000
    }
    export const past = () => { const xs = [1, 2, 3, 4, 5], ys = xs.filter(x => x > 4); return [ys[0], ys[1], ys.length] }
    export const halves = () => { const xs = [1, 2, 3]; return xs.filter(x => x > 1).map(x => x / 2) }
  `
  // [3,4,5].filter(>2) → [3,4,5]; *10 → [30,40,50] → 3*100 + 30 + 40*10 + 50*1000 = 50_730
  for (const optimize of ownedLevels(0, 1, 2, 'speed')) {
    const { main, past, halves } = run(src, { optimize })
    is(main(), 50730, `the chain at ${optimize}`)
    is(past(), [5, undefined, 1], `an index past what the filter kept, at ${optimize}`)
    is(halves(), [1, 1.5], `a map of fractions is an Array of them, at ${optimize}`)
  }
})

// What a `.slice`, `.map` or `.filter` of the literal makes is a typed array
// once the literal is one: an Array wherever the program can tell (a return, an
// argument, an element, a spread), and an Array's map keeps what an Int32Array
// cannot (a fraction, a boolean, a sum past the word, an unsigned word, -0).
test('promoteIntArrayLiterals: a derived array is an Array where it is told from one, and a map keeps its values', () => {
  const forms = {
    sum: 'return xs.map(x => x + 1)', halves: 'return xs.map(x => x / 2)', tests: 'return xs.map(x => x > 1)', wide: 'return xs.map(x => x * 2147483647)',
    unsigned: 'return xs.map(x => (x - 2) >>> 0)', negated: 'return xs.map(x => -(x - 1))', words: 'return xs.map(x => x & 2)', kept: 'return xs.filter(x => x > 1)',
    tail: 'return xs.slice(1)', argument: 'return keep(xs.filter(x => x > 1))', element: 'return [xs.slice(1), 1][0]', spread: 'return [...xs.map(x => x * 2)]',
    named: 'const d = xs.map(x => x / 2); return d', chain: 'const d = xs.filter(x => x > 1).map(x => x + 0.5); return d', twice: 'const d = xs.slice(1), e = d.map(x => x > 2); return e',
    read: 'const d = xs.map(x => x / 2); return [d[0], d[1], d.length]', inside: 'const d = xs.map(x => x * 2); let s = 0; for (let i = 0; i < d.length; i++) s += d[i]; return [s]',
  }
  const src = `const keep = (a) => a\n` + Object.entries(forms).map(([name, body]) => `export let ${name} = () => { const xs = [1, 2, 3, 4]; ${body} }`).join('\n')
  const want = oracle(src)
  for (const optimize of ownedLevels(0, 1, 2, 'speed')) {
    const got = run(src, { optimize })
    for (const name in forms) {
      const g = got[name](), w = want[name]()
      ok(Array.isArray(g), `${name} at ${optimize}: an Array`)
      ok(g.length === w.length && g.every((v, i) => Object.is(v, w[i])), `${name} at ${optimize}: ${g}, node ${w}`)
    }
  }
})

test('promoteIntArrayLiterals: hole disqualifies', () => {
  // Sparse literal: [1, , 3] — middle slot is a hole. intLiteralValue returns null for non-literal
  // elements, so the candidate gate skips it.
  const src = `
    export const main = () => {
      const xs = [1, , 3]
      return xs.length + xs.indexOf(3)
    }
  `
  const body = compileMain(src, { propagateLocals: false })
  ok(/\(local \$xs (?:f64|i64)\)/.test(body), 'holes break dense int contract; disqualify')
  const { main } = run(src)
  is(main(), 5)
})

test('promoteIntArrayLiterals: ++/-- on element disqualifies', () => {
  const src = `
    export const main = (k) => {
      const xs = [1, 2, 3, 4, 5]
      xs[k & 0]++
      let s = 0
      for (let i = 0; i < xs.length; i++) s += xs[i]
      return s
    }
  `
  const body = compileMain(src)
  ok(/\(local \$xs (?:f64|i64)\)/.test(body), 'element increment is a mutation; disqualify')
  const { main } = run(src)
  is(main(0), 16)
})

test('promoteIntArrayLiterals: large int-only literal stays promoted (length / index combo)', () => {
  // 16-element literal with bitwise reduction: promotion + SIMD path covers
  // both `arr.length` (TYPED-aware via __len) and `arr[i]` (.typed:[]).
  const src = `
    export const main = () => {
      const xs = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768]
      let acc = 0
      for (let i = 0; i < xs.length; i++) acc |= xs[i]
      return acc
    }
  `
  const body = compileMain(src)
  ok(/\(local \$xs i32\)/.test(body), 'large int-only literal still promotes')
  const { main } = run(src)
  is(main(), 65535)
})
