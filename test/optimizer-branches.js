// Branches and selects: if-conversion, the select gate, condition chains, range
// tests fused to one compare, truthiness, and values a statement drops.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { onKernel, levels, belowOpt, ownedLevels } from './_matrix.js'
import { fusedRewrite } from '../src/optimize/peephole.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { funcWat, run, oracle, jz, compile } from './util.js'
import { parse, count, walk } from '../scripts/wat-probe.mjs'
import { findFunc } from './_optimizer.js'
import { guardTables } from '../src/optimize/guard-tables.js'

test('if-conversion: `if (cond) x = cheapPure` → branchless select (speed tier)', () => {
  // A data-dependent guarded scalar update (min/max/clamp reduction) becomes a `select` instead
  // of a branch — kills misprediction in hot loops (levenshtein's DP min, ~27% faster). Bit-exact
  // vs the branchy form.
  const SRC = `
    const reduce = (xs, n) => {
      let m = xs[0]
      for (let i = 1; i < n; i++) { const v = xs[i]; if (v < m) m = v; if (v > 1000) m = m + 1 }
      return m
    }
    export const main = () => {           // two distinct calls so reduce stays its own function to inspect
      const xs = new Int32Array(64)
      let s = 12345 | 0
      for (let i = 0; i < 64; i++) { s = (s * 1103515245 + 12345) | 0; xs[i] = (s >>> 8) & 0x3ff }
      return (reduce(xs, 64) + reduce(xs, 63)) | 0
    }
  `
  const grab = (wat) => funcWat(wat, 'reduce')
  // Root F versioning wraps the loop in a guard `if` with a cold checked twin —
  // the if-conversion contract holds within the FAST arm.
  const fastArm = (fn) => fn.includes('(else') ? fn.slice(0, fn.indexOf('(else')) : fn
  const fn = fastArm(grab(compile(SRC, { wat: true, optimize: { level: 'speed' } })))
  ok(/\bselect\b/.test(fn), 'guarded update lowered to select at speed tier')
  is(/\(if\b\s*$|\(if\s+\(/m.test(fn.slice(fn.indexOf('(loop'))), false, 'no branch left for the guarded update')
  // Default tier keeps the branch (select is speed-only). Pin level 2 so
  // JZ_TEST_OPTIMIZE=3 can't flip this half to speed (cf. test/perf.js threshold pin).
  const fnD = grab(compile(SRC, { wat: true, optimize: 2 }))
  ok(/\(if\b/.test(fnD), 'default tier keeps the branch (select is a speed-tier trade)')
  // Bit-exact regardless of tier.
  const ref = (() => { const xs = []; let s = 12345 | 0; for (let i = 0; i < 64; i++) { s = (s * 1103515245 + 12345) | 0; xs[i] = (s >>> 8) & 0x3ff }
    const r = (n) => { let m = xs[0]; for (let i = 1; i < n; i++) { const v = xs[i]; if (v < m) m = v; if (v > 1000) m = m + 1 } return m }; return (r(64) + r(63)) | 0 })()
  is(jz(SRC, { optimize: { level: 'speed' } }).exports.main(), ref, 'speed-tier result bit-exact')
  is(jz(SRC).exports.main(), ref, 'default-tier result bit-exact')
})

test('if→select: load-bearing condition + postfix x++ → branchless select (heapsort child-pick)', () => {
  // The sift-down child pick `if (a[c] < a[c+1]) c++` is the canonical unpredictable branch. Wins
  // on Cranelift/x86, which keep the branch where V8/arm64 if-converts it itself. Bit-exact
  // everywhere.
  const SRC = `
    const pick = (a, n) => {
      let hits = 0
      for (let i = 0; i < n - 1; i++) { let c = i; if (a[c] < a[c + 1]) c++; hits = hits + c }
      return hits
    }
    export const main = () => {           // two distinct calls so pick stays its own function to inspect
      const a = new Float64Array(64)
      let s = 1 | 0
      for (let i = 0; i < 64; i++) { s = (s * 1103515245 + 12345) | 0; a[i] = (s >>> 8) & 0xff }
      return (pick(a, 64) + pick(a, 63)) | 0
    }
  `
  const grab = (wat) => funcWat(wat, 'pick')
  const fn = grab(compile(SRC, { wat: true, optimize: { level: 'speed' } }))
  ok(/\bselect\b/.test(fn), 'load-bearing child-pick lowered to select at speed tier')
  const fnD = grab(compile(SRC, { wat: true, optimize: 2 }))
  ok(/\(if\b/.test(fnD), 'default tier keeps the branch (select is a speed-tier trade)')
  const ref = (() => { const a = []; let s = 1 | 0; for (let i = 0; i < 64; i++) { s = (s * 1103515245 + 12345) | 0; a[i] = (s >>> 8) & 0xff }
    const pick = (n) => { let hits = 0; for (let i = 0; i < n - 1; i++) { let c = i; if (a[c] < a[c + 1]) c++; hits = hits + c } return hits }; return (pick(64) + pick(63)) | 0 })()
  is(jz(SRC, { optimize: { level: 'speed' } }).exports.main(), ref, 'speed-tier bit-exact')
  is(jz(SRC).exports.main(), ref, 'default-tier bit-exact')
})

test('if→select: a condition that MUTATES a var the value arm reads is NOT converted (reorder safety)', () => {
  // `select` evaluates its arms BEFORE its condition; the branch evaluates the condition FIRST. Here
  // the condition assigns `x` and the value arm reads `x` — converting would read x stale. The gate
  // must keep the branch.
  const SRC = `
    const f = (a, n) => {
      let x = 0, acc = -1
      for (let i = 0; i < n; i++) { if ((x = x + a[i]) > 100) acc = x }   // cond writes x; value arm reads x
      return acc
    }
    export const main = () => {           // two call sites keep f standalone
      const a = new Int32Array(32)
      for (let i = 0; i < 32; i++) a[i] = (i * 7) & 31
      return (f(a, 32) + f(a, 32)) | 0
    }
  `
  // (at the speed tier watr splices f into main all the same: its loop is there)
  const grab = (wat) => funcWat(wat, 'f', 'main')
  // fast arm only: the versioned checked twin reads via branchless selects — the
  // reorder-safety contract is about the guarded UPDATE in the hot loop
  let fn = grab(compile(SRC, { wat: true, optimize: { level: 'speed' } }))
  if (fn.includes('(else')) fn = fn.slice(0, fn.indexOf('(else'))
  is(/\bselect\b/.test(fn), false, 'side-effecting condition keeps the branch (not folded to select)')
  const ref = (() => { const a = []; for (let i = 0; i < 32; i++) a[i] = (i * 7) & 31
    const f = (n) => { let x = 0, acc = -1; for (let i = 0; i < n; i++) { if ((x = x + a[i]) > 100) acc = x } return acc }; return (f(32) + f(32)) | 0 })()
  is(jz(SRC, { optimize: { level: 'speed' } }).exports.main(), ref, 'speed-tier bit-exact')
  is(jz(SRC).exports.main(), ref, 'default-tier bit-exact')
})

test('if→select: f64 ternary with pure arms+cond → branchless select (sign/clamp kernels)', () => {
  // `(h & 1) === 0 ? x : -x` (noise's gradient) lowers to (if (result f64) PURE_COND (then x)
  // (else -x)); both arms and the cond are pure, so fold to a branchless select — the cmov
  // LLVM/clang emit for every `cond ? a : b`, killing the misprediction on data-random conds.
  const SRC = `
    const grad = (h, x, y) => { const u = (h & 1) === 0 ? x : -x; const v = (h & 2) === 0 ? y : -y; return u + v }
    export const main = () => {
      let s = 0.0
      for (let i = 0; i < 16; i++) s = s + grad(i, i * 0.5, i * 0.25) + grad(i + 1, i * 0.3, i * 0.7)
      return (s * 1000) | 0
    }
  `
  const wat = compile(SRC, { wat: true, optimize: { level: 'speed' } })   // grad (small leaf) inlines into main
  const m = funcWat(wat, 'main')
  ok(/\bselect\b/.test(m), 'gradient sign-select lowered to branchless select')
  is(/\(if \(result f64\)/.test(m), false, 'no f64 conditional branch left')
  const ref = (() => { const g = (h, x, y) => { const u = (h & 1) === 0 ? x : -x; const v = (h & 2) === 0 ? y : -y; return u + v }
    let s = 0.0; for (let i = 0; i < 16; i++) s = s + g(i, i * 0.5, i * 0.25) + g(i + 1, i * 0.3, i * 0.7); return (s * 1000) | 0 })()
  is(jz(SRC, { optimize: { level: 'speed' } }).exports.main(), ref, 'grad result bit-exact vs JS')
})

test('if→select: short-circuit || with a side-effecting cond is NOT folded (regression: tee reorder)', () => {
  // `a || b` lowers to (if (result f64) is_truthy(local.tee $t a) (then $t)(else b)) — the cond
  // hides a tee the then-arm reads. wasm `select` evaluates its arms BEFORE the cond, so folding
  // would read $t stale.
  const SRC = `export const f = (a, b) => a || b
    export const main = () => { let n = 0; if (f(0, 5) === 5) n = n + 1; if (f(7, 9) === 7) n = n + 2; if (f(false, 3) === 3) n = n + 4; return n }`
  is(jz(SRC).exports.main(), 7, '|| short-circuit stays correct (0||5=5, 7||9=7, false||3=3)')
})

// Regressions for the former duplicated truthiness expansion: it omitted
// false, then boxed BigInt zero.

test('truthiness: || sees boolean false through a boxed local as falsy', () => {
  const src = `
    export let go = (s) => {
      let v = s === 'no' ? false : s
      return (v || 'fb') + ''
    }
    export let chain = (s) => {
      let a = s === 'x' ? s : false
      let b = a || ''
      let c = b || 0
      let d = c || null
      return (d || 'end') + ''
    }
  `
  for (const opt of levels(false, 1, 2, 3)) {
    const r = run(src, { optimize: opt })
    is(r.go('no'), 'fb', `go falsy @opt ${opt}`)
    is(r.go('yes'), 'yes', `go truthy @opt ${opt}`)
    is(r.chain('q'), 'end', `chain all-falsy @opt ${opt}`)
    is(r.chain('x'), 'x', `chain truthy @opt ${opt}`)
  }
})

test('truthiness: BigInt origins without literals share runtime and optimized predicates', () => {
  // No BigInt literal or BigInt() call: the values originate in typed storage
  // and DataView. Include a NaN-box-shaped payload, signed zero/NaN Numbers,
  // side-effectful callees and repeated use of the same instance.
  const src = `export function f(k) {
    const a=new BigInt64Array(3),d=new DataView(a.buffer)
    if(k){d.setUint32(8,1,true);d.setUint32(20,2146959362,true)}
    const xs=[a[0],a[1],a[2],false,'',0,-0,NaN,null,undefined]
    let calls=0
    function next(){calls++;return xs[k?1:0]}
    const chosen=next()||'fallback',negated=!next(),condition=next()?1:0
    return [a.filter(x=>x).length,a.some(x=>x),a.every(x=>x),a.findIndex(x=>x),a.findLastIndex(x=>x),
      xs.filter(x=>x).length,xs.some(x=>x),xs.every(x=>x),chosen,negated,condition,calls,
      Boolean(d.getBigInt64(0,true)),Boolean(d.getBigUint64(8,true))]
  }`
  const js = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const { f } = run(src, { optimize })
    for (const k of [0,0,1,0,1]) is(f(k), js(k), `O${optimize}, BigInt predicates ${k}`)
  }
  const scalar = compile('export function f(n){return n>0}')
  ok(!WebAssembly.Module.exports(new WebAssembly.Module(scalar)).some(e => e.kind === 'memory'),
    'scalar boolean exports retain the memory-free path')
})

// Dead-value drop simplification (drop of a pure op over a tee collapses to
// the bare store; drop of a control-flow value stays whole).
test('a dropped value: comma-update loop (j++, k+=step) stays correct', () => {
  // The discarded old value of `j++` is dead; eliminating it must not change the
  // loop. j:0..7, k=3j → sum += 1003j → 1003·28 = 28084.
  const { main } = run(`export let main = () => {
    let sum = 0
    for (let j = 0, k = 0; j < 8; j++, k += 3) sum = (sum + j * 1000 + k) | 0
    return sum
  }`)
  is(main(), 28084)
})

test('a dropped value: dropped ternary runs exactly one branch', () => {
  // A ternary whose value is discarded must execute ONE arm — the drop
  // simplification must not flatten an `if`/ternary's branches into both side
  // effects.
  const { main } = run(`export let main = () => {
    let x = 0, y = 0
    for (let i = 0; i < 10; i++) (i & 1) ? (x = x + 1) : (y = y + 1)
    return x * 100 + y
  }`)
  is(main(), 505)   // 5·100 + 5, NOT 1010 (both arms)
})

test('a dropped value: dropped ternary-in-condition compiles (seed 192 regression)', () => {
  for (const opt of levels(2, 'speed')) {
    const { main } = run(`export let main = () => {
      let r = 0
      if ((Math.ceil(1)) ? 0 : 0) { r = 1 } else { r = 2 }
      return r
    }`, { optimize: opt })
    is(main(), 2, `opt ${opt}`)
  }
})

test('range-check fusion: x>=LO && x<=HI on an i32 → single unsigned compare', () => {
  // The classic scanner/bounds optimization (what native compilers + V8 emit):
  // `d >= 48 && d <= 57` collapses to `(d - 48) <=u 9` — one subtract + one unsigned
  // compare instead of two signed compares, an AND, and a short-circuit branch. Fires
  // only for an i32 operand (`d` via `|0`; a `charCodeAt` byte in real scanners) — a
  // fractional f64 would mis-fuse, so untyped operands keep the ordered-compare form.
  const wat = compile(`export let f = (c) => { let d = c | 0; return (d >= 48 && d <= 57) ? 1 : 0 }`, { wat: true, optimize: 'speed' })
  ok(/i32\.le_u/.test(wat), 'expected fused unsigned compare')
  const watOr = compile(`export let f = (c) => { let d = c | 0; return (d < 48 || d > 57) ? 1 : 0 }`, { wat: true, optimize: 'speed' })
  ok(/i32\.gt_u/.test(watOr), 'expected fused unsigned outside-range compare')
  // Untyped f64 operand must NOT fuse (fractional values would be mis-classified).
  const watF64 = compile(`export let f = (c) => (c >= 48 && c <= 57) ? 1 : 0`, { wat: true, optimize: 'speed' })
  ok(!/i32\.le_u/.test(watF64), 'untyped f64 keeps the ordered compare (no unsigned fuse)')
})

test('range-check fusion: fused-path correctness across boundaries (i32 operand)', () => {
  const cases = [
    'd>=48 && d<=57', 'd>97 && d<122', '48<=d && d<=57', 'd<=57 && d>=48',
    'd>=-3 && d<=3', '(d>=65 && d<=90) || (d>=97 && d<=122)',
    'd<48 || d>57', 'd<=47 || d>=58',
    'd>=100 && d<=50',   // empty range — must stay false
    'd<48 || d<57',      // non-fusable (both upper) — must stay correct
  ]
  for (const expr of cases) {
    const { f } = run(`export let f = (c) => { let d = c | 0; return ${expr} ? 1 : 0 }`)
    const js = new Function('c', `const d = c | 0; return (${expr}) ? 1 : 0`)
    for (let c = -10; c <= 200; c++) is(f(c), js(c), `${expr} @ c=${c}`)
  }
})

test('range-check fusion: recurses across a left-deep &&/|| chain — every adjacent pair fuses', () => {
  // `&&` parses left-deep (subscript's binary() combinator), so a 2-D bounds test `x>=0
  // && x<W && y>=0 && y<H` is `((x>=0 && x<W) && y>=0) && y<H` — the y-pair straddles
  // an intervening `&&` node (y>=0 is that node's right child, y<H is the outer call's
  // `b`), not immediate AST siblings the way the x-pair is. This is the 2D-bounds-check
  // shape from trace.js and any scanner/raster code with more than one range test
  // chained.
  const wat = compile(
    `export let f = (x, y) => { let xi = x|0, yi = y|0; let W = 512|0, H = 512|0; return (xi >= 0 && xi < W && yi >= 0 && yi < H) ? 1 : 0 }`,
    { wat: true, optimize: 'speed' })
  is((wat.match(/i32\.le_u/g) || []).length, 2, 'both x-pair and y-pair fused to one i32.le_u each')
  ok(!/i32\.ge_s|i32\.lt_s/.test(wat), 'no leftover signed range compares once both pairs fuse')

  // || twin: x<0 || x>=W || y<0 || y>=H (the outside-range complement).
  const watOr = compile(
    `export let f = (x, y) => { let xi = x|0, yi = y|0; let W = 512|0, H = 512|0; return (xi < 0 || xi >= W || yi < 0 || yi >= H) ? 1 : 0 }`,
    { wat: true, optimize: 'speed' })
  is((watOr.match(/i32\.gt_u/g) || []).length, 2, 'both x-pair and y-pair fused to one i32.gt_u each (|| twin)')
  ok(!/i32\.lt_s|i32\.ge_s/.test(watOr), 'no leftover signed range compares once both pairs fuse (|| twin)')

  // 3-conjunct: an x-pair plus one trailing unpaired comparison (yi>=0 alone, no
  // partner) — the unpaired conjunct must NOT force-fuse with anything and must stay
  // a plain signed compare, ANDed onto the fused x-pair.
  const wat3 = compile(
    `export let f = (x, y) => { let xi = x|0, yi = y|0; let W = 512|0; return (xi >= 0 && xi < W && yi >= 0) ? 1 : 0 }`,
    { wat: true, optimize: 'speed' })
  is((wat3.match(/i32\.le_u/g) || []).length, 1, 'only the x-pair fuses')
  ok(/i32\.ge_s/.test(wat3), 'the unpaired yi>=0 conjunct stays a plain signed compare')

  // Interleaved non-range conjunct BETWEEN the two fusable pairs — evaluation order
  // and short-circuit semantics are absolute: the non-range conjunct must not be
  // reordered, and must not block fusion of the pairs that remain adjacent to each
  // other on either side of it.
  const srcInterleaved = `export let f = (x, y) => { let xi = x|0, yi = y|0; let W = 512|0, H = 512|0; return (xi >= 0 && xi < W && (yi|0)!==999 && yi >= 0 && yi < H) ? 1 : 0 }`
  const watI = compile(srcInterleaved, { wat: true, optimize: 'speed' })
  is((watI.match(/i32\.le_u/g) || []).length, 2, 'both range pairs fuse around the interleaved non-range conjunct')
  const { f: fI } = run(srcInterleaved, { optimize: 'speed' })
  const jsI = (x, y) => { const xi = x | 0, yi = y | 0; return (xi >= 0 && xi < 512 && (yi | 0) !== 999 && yi >= 0 && yi < 512) ? 1 : 0 }
  for (const x of [-1, 0, 511, 512]) for (const y of [-1, 0, 511, 512, 999]) is(fI(x, y), jsI(x, y), `interleaved @ x=${x} y=${y}`)

  // Boundary-value differential vs JS for the 2-pair, 4-pair, 3-conjunct and ||-twin
  // shapes above — x/y at -1, 0, W-1, W (and a wider sweep) for every shape.
  const shapes = {
    '2-pair':     { src: (x, y) => `let xi = x|0; let W = 512|0; return (xi >= 0 && xi < W) ? 1 : 0`, js: (x) => { const xi = x | 0; return (xi >= 0 && xi < 512) ? 1 : 0 } },
    '4-pair':     { src: () => `let xi = x|0, yi = y|0; let W = 512|0, H = 512|0; return (xi >= 0 && xi < W && yi >= 0 && yi < H) ? 1 : 0`, js: (x, y) => { const xi = x | 0, yi = y | 0; return (xi >= 0 && xi < 512 && yi >= 0 && yi < 512) ? 1 : 0 } },
    '3-conjunct': { src: () => `let xi = x|0, yi = y|0; let W = 512|0; return (xi >= 0 && xi < W && yi >= 0) ? 1 : 0`, js: (x, y) => { const xi = x | 0, yi = y | 0; return (xi >= 0 && xi < 512 && yi >= 0) ? 1 : 0 } },
    'or-4-pair':  { src: () => `let xi = x|0, yi = y|0; let W = 512|0, H = 512|0; return (xi < 0 || xi >= W || yi < 0 || yi >= H) ? 1 : 0`, js: (x, y) => { const xi = x | 0, yi = y | 0; return (xi < 0 || xi >= 512 || yi < 0 || yi >= 512) ? 1 : 0 } },
  }
  for (const [name, { src, js }] of Object.entries(shapes)) {
    const { f } = run(`export let f = (x, y) => { ${src()} }`, { optimize: 'speed' })
    for (const x of [-1, 0, 511, 512]) for (const y of [-1, 0, 511, 512])
      is(f(x, y), js(x, y), `${name} @ x=${x} y=${y}`)
  }
})

test('range-check fusion: untyped f64 chain never fuses, even across a multi-pair chain', () => {
  // The base fuse restricts to an i32 operand (a fractional f64 would mis-classify —
  // `(x-LO) <=u (HI-LO)` only holds for integer wraparound). The chain recursion must
  // preserve that restriction at every level, not just the first pair: an untyped f64
  // 4-conjunct chain must keep every comparison in its ordered signed/f64 form.
  const src = `export let f = (x, y) => (x >= 0 && x < 512 && y >= 0 && y < 512) ? 1 : 0`
  const wat = compile(src, { wat: true, optimize: 'speed' })
  ok(!/i32\.le_u/.test(wat), 'f64 chain never fuses to the unsigned form, at any chain depth')
  const { f } = run(src, { optimize: 'speed' })
  const js = (x, y) => (x >= 0 && x < 512 && y >= 0 && y < 512) ? 1 : 0
  for (const x of [-1, 0, 511, 511.5, 512, NaN, -0]) for (const y of [-1, 0, 511, 511.5, 512, NaN, -0])
    is(f(x, y), js(x, y), `f64 chain @ x=${x} y=${y}`)
})

test('pure boolean chains lower eagerly while effectful RHS stays short-circuited', () => {
  const pure = `export let f=(a,b,c)=>a>0&&b>0&&c>0`
  const wat = compile(pure, { wat: true, optimize: { level: 'speed', watr: false } })
  const fw = wat.split('(func $f')[1]?.split('(func ')[0] || ''
  ok((fw.match(/i32\.and/g) || []).length >= 2, 'pure boolean chain uses branchless i32.and')
  ok(!/\(if/.test(fw), 'pure chain has no short-circuit control frame')
  const effect = `export let f=(x)=>{let n=0;const y=x>0&&++n>0;return n*10+(y|0)}`
  const f = run(effect, { optimize: 'speed' }).f
  is(f(0), 0, 'false lhs does not evaluate effectful rhs')
  is(f(1), 11, 'true lhs evaluates effectful rhs once')
})

test('pure comparison pairs stay eager beside calls and preserve short-circuit effects', () => {
  for (const op of ['&&', '||']) {
    const src = `export function f(a,b) { const v=a>0${op}b<1; return Math.sqrt(v ? 4 : 9) }`
    const f = findFunc(parse(src, { level: 'speed', watr: false }), '$f')
    ok(count(f, n => n[0] === (op === '&&' ? 'i32.and' : 'i32.or')) > 0, `${op}: comparisons remain eager in a call-bearing body`)
    const actual = run(src, { optimize: 'speed' }).f, expected = oracle(src).f
    for (const a of [-1, 0, 1, NaN, Infinity]) for (const b of [-1, 0, 1, NaN, Infinity])
      is(actual(a, b), expected(a, b))
    const effect = `export function f(x) { let n=0; const v=x>0${op}++n>0; return n*10+Math.sqrt(v ? 4 : 9) }`
    const g = run(effect, { optimize: 'speed' }).f, js = oracle(effect).f
    for (const x of [0, 1, 1, NaN, -1]) is(g(x), js(x), `${op}: the RHS runs only when required`)
    const guarded = `export function f(x) { return Math.sqrt((x>0${op}null.value>0) ? 4 : 9) }`
    const h = run(guarded, { optimize: 'speed' }).f
    is(h(op === '&&' ? 0 : 1), op === '&&' ? 3 : 2, `${op}: skipped access does not throw`)
    throws(() => h(op === '&&' ? 1 : 0), /null|property|properties|TypeError/, `${op}: evaluated null access throws`)
  }
})

test('source-inlined call-free boolean leaves stay eager inside call-bearing callers', () => {
  const src = `
    const leaf=(r,g,b,a)=>{return r===g&&g===b&&b===a&&a>0}
    export let f=(m,k)=>{let r=k|0,g=k|0,b=m|0,a=k|0;const z=Math.sin(m)
      let s=0,i=0;while(i<2){s+=leaf(r,g,b,a)|0;i++}return s+(z>2?1:0)}`
  const tree = parse(src, { level: 'speed', watr: false })
  const f = findFunc(tree, '$f')
  let ands = 0, leafCalls = 0
  walk(f, n => { if (n[0] === 'i32.and') ands++; if (n[0] === 'call' && n[1] === '$leaf') leafCalls++ })
  is(leafCalls, 0, 'leaf is source-inlined')
  ok(ands >= 3, 'its pure comparison chain remains branchless after entering a call-bearing body')
  const ex = run(src, { optimize: 'speed' }).f
  is(ex(2, 2), 2, 'true chain exact')
  is(ex(3, 2), 0, 'false chain exact')
})

test('select-gate cost veto: div-bearing ternary stays if/else, cheap ternary keeps select', () => {
  // SYNTH DISSECTED WITH MEASURED SHARES (2026-07-25): the '?:' select gate (emit.js) and
  // the post-watr f64 if→select fold (optimize/index.js) both chose `select` purely on
  // isPureIR — which admits f64.div/f64.sqrt (non-trapping, so "pure", but 10-40+ cycle
  // latency). The synth ADSR envelope's 4-way cascade (t/ATTACK : .../DECAY : SUSTAIN :
  // .../RELEASE) got compiled to chained `select`s that eagerly pay for THREE f64.div
  // every sample regardless of which arm is live — measured ~8% slower than a branch.
  // hasExpensiveOp (ir.js, consulted as `eagerSelectOK` in emit.js) vetoes any arm whose
  // subtree contains f64.div/f64.sqrt, recursively — so a cascade with a div ANYWHERE
  // compiles entirely to nested if/else. A cheap ternary (no div/sqrt in either arm) must
  // still take `select` — the noise lane's gradient sign-flip flagship, here reproduced as
  // a tiny leaf inlined directly into a multiply (the shape that lets stripCanon clear its
  // NaN-canon guard so the arms are pure AND cheap).
  const divCascade = `export const f = (t) => t < 100 ? t / 3 : t < 200 ? t / 5 : t < 300 ? t / 7 : t * 2`
  const jsDiv = (t) => t < 100 ? t / 3 : t < 200 ? t / 5 : t < 300 ? t / 7 : t * 2
  for (const optimize of levels(2, 3, 'speed')) {
    const tree = parse(divCascade, optimize)
    const fn = findFunc(tree, '$f')
    is(count(fn, n => n[0] === 'select'), 0, `O${JSON.stringify(optimize)}: div-bearing cascade never selects`)
    ok(count(fn, n => n[0] === 'if') >= 1, `O${JSON.stringify(optimize)}: div-bearing cascade compiles as if/else`)
  }
  for (const optimize of levels(false, 2, 3, 'speed')) {
    const { f } = run(divCascade, { optimize })
    for (const t of [50, 150, 250, 350]) is(f(t), jsDiv(t), `O${JSON.stringify(optimize)} t=${t}: div cascade exact`)
  }

  const gradient = `
    const grad = (h, x) => { const hh = h | 0; const xx = x + 0.0; return (hh & 1) === 0 ? xx : -xx }
    export const f = (h, x, scale) => { const s = scale + 0.0; return grad(h, x) * s }`
  const jsGrad = (h, x, scale) => (((h | 0) & 1) === 0 ? x : -x) * scale
  for (const optimize of levels(2, 3, 'speed')) {
    const tree = parse(gradient, optimize)
    const fn = findFunc(tree, '$f')
    ok(count(fn, n => n[0] === 'select') >= 1, `O${JSON.stringify(optimize)}: cheap sign-flip ternary keeps select`)
  }
  for (const optimize of levels(false, 2, 3, 'speed')) {
    const { f } = run(gradient, { optimize })
    for (const [h, x, scale] of [[0, 3, 2], [1, 3, 2], [2, -5.5, 1.5], [3, 7, -2]])
      is(f(h, x, scale), jsGrad(h, x, scale), `O${JSON.stringify(optimize)} h=${h}: gradient select exact`)
  }
})

test('select-gate FLAG veto: nested-if load-bearing cond stays if/else, plain-compare cond keeps select', () => {
  // SHAPES + SORT DISSECTED (2026-07-26): a DIFFERENT axis from the arm-cost veto above —
  // this one is about the select's CONDITION, not its arms. Sort's "pick larger child"
  // (heapify's `if (child + 1 < n && a[child] < a[child + 1]) child++`, if-converted to a
  // select-fed ternary by boolConvertToSelect) is the exact measured repro: branch-form
  // surgery on this shape closed a 1.115x gap vs zig-wasm. dataDependentFlag (ir.js) +
  // selectCondOK (emit.js) veto scoped to nested-if conds that carry a memory load; a
  // plain multi-compare flag (noise's `(h & 1) === 0` class) never builds this shape and
  // must keep `select`.
  const heap = new Float64Array([5, 1, 8, 3, 9, 2, 7, 4])
  const pickChild = `
    export const f = (n, child) => {
      const a = new Float64Array([5, 1, 8, 3, 9, 2, 7, 4])
      return (child + 1 < n && a[child] < a[child + 1]) ? child + 1 : child
    }`
  const jsPick = (n, child) => (child + 1 < n && heap[child] < heap[child + 1]) ? child + 1 : child
  // `child` is an EXPORTED param — a JS caller can pass it any value (a string, undefined,
  // …), so `child + 1`/`child < n` genuinely runtime-dispatch on its NaN-boxed carrier
  // (audit fix, 2026-08: foldStrDispatchF64 used to unsoundly strip that live dispatch off
  // the real emitted function, which is what let this pin assert "zero `select` ANYWHERE in
  // the function" — the atom-decode ladder that dispatch legitimately lowers to now
  // resurfaces as nested `select`s of its own, unrelated to the select-gate veto under test
  // here).
  const topExpr = (fn) => { const last = fn[fn.length - 1]; return Array.isArray(last) && last[0] === 'return' ? last[1] : last }
  for (const optimize of levels(2, 3, 'speed')) {
    // Inspect the branch result before the independent arena epilogue moves
    // it into a return local; the runtime checks below use the full preset.
    const tree = parse(pickChild, { level: optimize, arenaRewind: false })
    const fn = findFunc(tree, '$f') || findFunc(tree, '$f$exp')
    const top = topExpr(fn)
    // if/else, or its jump-chain form (chainConditions lowers the value-if
    // whose test holds the `&&` diamond to a result block with one branch per operand)
    ok(Array.isArray(top) && (top[0] === 'if' || top[0] === 'block'), `O${JSON.stringify(optimize)}: nested-if load-bearing flag never selects`)
    ok(count(fn, n => n[0] === 'if' || n[0] === 'br_if') >= 1, `O${JSON.stringify(optimize)}: compiles as branches`)
  }
  for (const optimize of levels(false, 2, 3, 'speed')) {
    const { f } = run(pickChild, { optimize })
    for (const [n, child] of [[8, 0], [8, 1], [8, 2], [8, 3], [8, 6], [8, 7], [5, 3], [1, 0]])
      is(f(n, child), jsPick(n, child), `O${JSON.stringify(optimize)} n=${n} child=${child}: pick-larger-child exact`)
  }

  // Plain-comparison flag (both && operands cheap comparisons, no memory load) must keep
  // select — the veto is scoped to load-bearing nested-if conds only, not comparison
  // chains in general (which either collapse to i32.and upstream or never touch memory).
  const plainFlag = `export const f = (x, y, z) => (x > 0 && y < 10) ? z + 1.0 : z - 1.0`
  const jsPlain = (x, y, z) => (x > 0 && y < 10) ? z + 1.0 : z - 1.0
  for (const optimize of levels(2, 3, 'speed')) {
    const tree = parse(plainFlag, optimize)
    const fn = findFunc(tree, '$f') || findFunc(tree, '$f$exp')
    ok(count(fn, n => n[0] === 'select') >= 1, `O${JSON.stringify(optimize)}: plain-compare flag keeps select`)
  }
  for (const optimize of levels(false, 2, 3, 'speed')) {
    const { f } = run(plainFlag, { optimize })
    for (const [x, y, z] of [[1, 5, 2], [-1, 5, 2], [1, 20, 2], [-1, 20, 2]])
      is(f(x, y, z), jsPlain(x, y, z), `O${JSON.stringify(optimize)}: plain-flag select exact`)
  }
})

// watr lowers `&&`/`||` in a condition position to branch chains: one conditional
// branch per operand, no value diamond, no phi.
test('condition chains: short-circuit tests branch per operand, evaluating each once', () => {
  if (onKernel()) return
  const src = `let log = 0
  const a = (x) => { log = log * 10 + 1; return x > 0 }
  const b = (x) => { log = log * 10 + 2; return x > 1 }
  const c = (x) => { log = log * 10 + 3; return x > 2 }
  export let f = (x) => {
    log = 0
    let r = 0
    if (a(x) && b(x) && c(x)) r += 1; else r += 10
    if (a(x) || b(x)) r += 100
    if ((a(x) && b(x)) || c(x)) r += 1000; else r += 10000
    let i = 0
    while (a(i) && i < x) i++
    return r * 100000 + i * 1000 + (log % 1000)
  }`
  const w = compile(src, { wat: true, optimize: { level: 3, watr: false, sourceInline: false } })
  const body = funcWat(w, 'f')
  ok(!/\(if\s*\(result i32\)\s*\(local\.tee/.test(body), 'no value diamond in the function')
  // A condition's operands are boolean questions asked in place (toBool):
  // each one branches to the next, no operand is boxed, none is tested
  // through the generic truthiness, and each call runs once per test (the
  // while loop's rotated test repeats its own).
  ok(!body.includes('__is_truthy'), 'no generic truthiness in the chain')
  is((body.match(/\(call \$b[\s)]/g) || []).length, 3, 'b is called once per test')
  is((body.match(/\(call \$c[\s)]/g) || []).length, 2, 'c is called once per test')
  const ref = oracle(src).f
  for (const O of ownedLevels(0, 1, 2, 3, 'fast', 'size')) for (const x of [0, 1, 2, 3, 5]) is(jz(src, { optimize: O }).exports.f(x), ref(x), `O${O} x=${x}`)
})

// A call made as a statement, or under `void`, drops its value folded, `(drop (call …))`: a `drop` written flat
// among a function's statements is stack code, and the optimizer leaves the whole function's
// structure alone, its condition chains among them (a sweep's `isnan(x) || x === Infinity`
// stayed a value diamond, tested again: stdlib's exp, 0.88x the time with chains on x64).
test('condition chains: a statement call drops its value folded, so its function takes the chains', () => {
  const src = `const isnan = (x) => x !== x
  let seen = 0
  function note(v, d) { if (d > 0) return note(v + 1, d - 1); seen = (seen + v) | 0; return seen }
  export let f = (xs) => {
    let s = 0, t = 0
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]
      if (isnan(x) || x === Infinity || x === -Infinity) t++
      else s += x
    }
    note(t, 2)
    return s + t
  }
  export let g = (x) => { const u = void note(x, 1); return u === undefined ? x : -x }
  export let total = () => seen`
  const xs = new Float64Array([1.5, NaN, Infinity, -Infinity, -0, 3, NaN, 1e300])
  for (const optimize of levels(false, 1, 2, 3, 'speed', 'size')) {
    const m = run(src, { optimize }), host = oracle(src)
    is(m.f(xs), host.f(xs), `the sum at ${optimize}`)
    is(m.g(3), host.g(3), `void at ${optimize}`)
    is(m.total(), host.total(), `and the note at ${optimize}`)
  }
  if (belowOpt(2)) return
  const text = compile(src, { wat: true, optimize: 'speed' }), body = funcWat(text, 'f')
  ok(!/\)\s+drop\b/.test(body) && !/\)\s+drop\b/.test(funcWat(text, 'g')), 'no drop written flat, of a call or of a void')
  ok(!/\(if\s*\(result i32\)\s*\(local\.tee/.test(body), 'no value diamond in the loop test')
})

test('peephole: a word tested against both ends of a range is one unsigned test, two ranges a bit apart one test of the word with the bit', () => {
  // `c >= 65 && c <= 90` (a letter), `x > -6 && x < 6`, and the letters of either case `[65, 90] | [97, 122]`
  const conds = [
    ['(i32.and (i32.ge_s (local.get $x) (i32.const 65)) (i32.le_s (local.get $x) (i32.const 90)))', 1, 0],
    ['(i32.and (i32.gt_s (local.get $x) (i32.const -6)) (i32.gt_s (i32.const 6) (local.get $x)))', 1, 0],
    ['(i32.or (i32.or (i32.and (i32.ge_s (local.get $x) (i32.const 65)) (i32.le_s (local.get $x) (i32.const 90))) (i32.and (i32.ge_s (local.get $x) (i32.const 97)) (i32.le_s (local.get $x) (i32.const 122)))) (i32.eq (local.get $x) (i32.const 95)))', 1, 1],
    ['(i32.or (i32.and (i32.ge_s (local.get $x) (i32.const 48)) (i32.le_s (local.get $x) (i32.const 57))) (i32.and (i32.ge_s (local.get $x) (i32.const 65)) (i32.le_s (local.get $x) (i32.const 70))))', 2, 0],
    ['(i32.and (i32.ge_s (local.get $x) (i32.const 9)) (i32.le_s (local.get $x) (i32.const 3)))', 0, 0],
  ]
  for (const [k, [cond, folds, cased]] of conds.entries()) {
    const fn = parseWat(`(func $f (export "f") (param $x i32) (result i32) ${cond})`)
    const instantiate = f => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(['module', f]))).exports.f
    const before = instantiate(fn)
    fusedRewrite(fn)
    const after = instantiate(fn)
    const text = JSON.stringify(fn)
    is((text.match(/i32\.(le|lt)_u/g) || []).length, folds, `condition ${k}: ${folds} range test(s)`)
    is((text.match(/"i32\.or",\["local\.get"/g) || []).length, cased, `condition ${k}: ${cased ? 'the case bit' : 'no case bit'}`)
    for (const x of [-2147483648, -6, -5, -1, 0, 3, 5, 6, 9, 31, 47, 48, 57, 58, 64, 65, 70, 71, 90, 91, 95, 96, 97, 122, 123, 2147483647])
      is(after(x), before(x), `condition ${k}: x=${x}`)
  }
})

test('peephole: a word tested against zero and a constant bound is one unsigned test', () => {
  // `x >= 0 && x < W && y >= 0 && y < H`, the tests in any order, both spellings
  const conds = [
    '(i32.and (i32.and (i32.and (i32.ge_s (local.get $x) (i32.const 0)) (i32.lt_s (local.get $x) (i32.const 512))) (i32.ge_s (local.get $y) (i32.const 0))) (i32.lt_s (local.get $y) (i32.const 300)))',
    '(i32.and (i32.and (i32.gt_s (local.get $x) (i32.const -1)) (i32.gt_s (local.get $y) (i32.const -1))) (i32.and (i32.le_s (local.get $x) (i32.const 511)) (i32.gt_s (i32.const 300) (local.get $y))))',
    '(i32.and (i32.ge_s (local.get $x) (i32.const 0)) (i32.lt_s (local.get $y) (i32.const 300)))',
  ]
  for (const [k, cond] of conds.entries()) {
    const fn = parseWat(`(func $f (export "f") (param $x i32) (param $y i32) (result i32) ${cond})`)
    const instantiate = f => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(['module', f]))).exports.f
    const before = instantiate(fn)
    fusedRewrite(fn)
    const after = instantiate(fn)
    const text = JSON.stringify(fn)
    is((text.match(/i32\.lt_u/g) || []).length, k < 2 ? 2 : 0, `condition ${k}: a pair per word folds, a lone test stays`)
    for (const x of [-2147483648, -1, 0, 1, 299, 300, 511, 512, 2147483647]) for (const y of [-1, 0, 299, 300])
      is(after(x, y), before(x, y), `condition ${k}: x=${x} y=${y}`)
  }
})

// A run of guarded exits on one word is a dispatch, and it takes a table
// (src/optimize/guard-tables.js): the list form writes an else-if chain and a
// switch's entry past LEN links as such a run, which watr's chainTable, reading
// the else-if chain, does not match. A switch or an else-if of 65 cases or more
// went from one br_table to none at the default and speed levels, a compare a
// case: a switch of 200 ran 4.6 times slower. Each program here answers as Node,
// with the tables it should have, at both levels.
test('guard tables: a dispatch past LEN keeps its table', () => {
  const J = (n, f, sep) => Array.from({ length: n }, (_, i) => f(i)).join(sep)
  const loop = (k, idx = `i % ${k}`) => `\nexport let f = (n) => { let a = 1; for (let i = 0; i < n; i++) a = step(${idx}, a); return a }`
  const arm = i => `(a * ${(i % 5) + 1} + ${i}) % 65521`
  const cases = [
    ['a switch of 100 returns', `function step(op, a) { switch (op) { ${J(100, i => `case ${i}: return ${arm(i)};`, ' ')} } return a }` + loop(100), 1],
    ['a switch of 100 breaks and a default', `function step(op, a) { switch (op) { ${J(100, i => `case ${i}: a = ${arm(i)}; break;`, ' ')} default: a = 0 } return a }` + loop(101), 1],
    ['an else-if of 100 returns', `function step(op, a) { ${J(100, i => `if (op === ${i}) return ${arm(i)}`, '\n else ')}\n return a }` + loop(100), 1],
    ['an else-if of 100 assignments', `function step(op, a) { ${J(100, i => `if (op === ${i}) a = ${arm(i)}`, '\n else ')}\n else a = 7\n return a }` + loop(103), 1],
    ['a ?: chain of 100 returned', `function step(op, a) { return ${J(100, i => `op === ${i} ? ${arm(i)} :`, ' ')} a }` + loop(100), 1],
    ['keys with holes', `function step(op, a) { switch (op) { ${J(100, i => `case ${i + (i >> 1)}: return ${arm(i)};`, ' ')} } return a + 1 }` + loop(150), 1],
    ['negative keys', `function step(op, a) { switch (op) { ${J(100, i => `case ${i - 50}: return ${arm(i)};`, ' ')} } return a }` + loop(100, 'i % 100 - 50'), 1],
    ['keys too sparse for a table', `function step(op, a) { switch (op) { ${J(100, i => `case ${i * 7}: return ${arm(i)};`, ' ')} } return a + 1 }` + loop(700), 0],
    // (the loop stands twice, a copy for an integer counter and one for any number:
    // the inner switch takes a table in each, the outer in the first, as on main)
    ['a switch in a case of another', `function step(op, a) { switch (op) { ${J(70, i => i === 3 ? `case 3: switch (a & 127) { ${J(80, j => `case ${j}: return ${arm(j)} + 1;`, ' ')} } return 9;` : `case ${i}: return ${arm(i)};`, ' ')} } return a }` + loop(70), 3],
  ]
  for (const optimize of [true, 'speed']) for (const [name, src, tables] of cases) {
    const w = compile(src, { optimize, wat: true })
    is((String(w).match(/br_table/g) || []).length, tables, `${name} at ${optimize === true ? 'the default' : optimize}: br_table count`)
    const want = oracle(src).f, got = run(src, { optimize }).f
    for (const n of [0, 1, 7, 151, 400]) is(got(n), want(n), `${name} at ${optimize === true ? 'the default' : optimize}: f(${n})`)
  }
})

// The pass on hand-written runs: a first test that writes the word, `br_if` arms,
// a key in a pooled global, a repeated key (the run ends before it), and the runs it
// leaves: an arm branching by depth (a new block would move it), and light arms
// that load (chainTable's gate: the compare chain predicts better).
test('guard tables: the run, the words and the gates', () => {
  const module = (arms) => `(module (memory 1) (global $k6 i32 (i32.const 6))
    (func $g (param i32) (result i32) (i32.add (local.get 0) (i32.const 1000)))
    (func $f (export "f") (param $x i32) (result i32) (local $s i32)
      (block $out
        (if (i32.eqz (local.tee $s (i32.sub (local.get $x) (i32.const 10)))) (then (return (i32.const 100))))
        ${arms}
        (return (i32.const -1)))
      (i32.const 7)))`
  const run = (tree) => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(tree))).exports.f
  const tables = (tree) => { let k = 0; walk(tree, n => { if (n[0] === 'br_table') k++ }); return k }
  const check = (name, arms, want) => {
    const src = module(arms), before = run(parseWat(src)), tree = guardTables(parseWat(src))
    is(tables(tree), want, `${name}: tables`)
    const after = run(tree)
    for (let x = -3; x < 30; x++) is(after(x), before(x), `${name}: f(${x})`)
    return tree
  }
  const tree = check('a run', `(if (i32.eq (local.get $s) (i32.const 1)) (then (return (i32.const 101))))
    (br_if $out (i32.eq (local.get $s) (i32.const 2)))
    (if (i32.eq (i32.const 3) (local.get $s)) (then (return (i32.const 103))))
    (if (i32.eq (local.get $s) (i32.const 5)) (then (return (call $g (local.get $s)))))
    (if (i32.eq (local.get $s) (global.get $k6)) (then (return (i32.const 106))))
    (if (i32.eq (local.get $s) (i32.const 6)) (then (return (i32.const 999))))
    (if (i32.eq (local.get $s) (i32.const 7)) (then (return (i32.const 107))))`, 1)
  const out = findFunc(tree, '$f').find(n => Array.isArray(n) && n[0] === 'block')
  is(out[2][0], 'local.set', 'the first test\'s write comes first')
  is(out[4][0], 'if', 'the repeated key and what follows it stay ifs')
  check('an arm that branches by depth', `(if (i32.eq (local.get $s) (i32.const 1)) (then (br 1)))
    (if (i32.eq (local.get $s) (i32.const 2)) (then (return (i32.const 102))))
    (if (i32.eq (local.get $s) (i32.const 3)) (then (return (i32.const 103))))
    (if (i32.eq (local.get $s) (i32.const 4)) (then (return (i32.const 104))))`, 0)
  check('light arms that load', [1, 2, 3, 4, 5].map(k => `(if (i32.eq (local.get $s) (i32.const ${k})) (then (return (i32.load (i32.const ${k * 4})))))`).join(' '), 0)
  check('arms that do more', [1, 2, 3, 4, 5].map(k => `(if (i32.eq (local.get $s) (i32.const ${k})) (then (i32.store (i32.const 0) (local.get $x)) (return (i32.load (i32.const ${k * 4})))))`).join(' '), 1)
  // a table nests a block an arm: 1,100 arms take a table a 512 of their keys
  const wide = guardTables(parseWat(module(Array.from({ length: 1099 }, (_, i) => `(if (i32.eq (local.get $s) (i32.const ${i + 1})) (then (return (call $g (i32.const ${i})))))`).join(' '))))
  is(tables(wide), 3, 'three tables')
  const f = run(wide)
  for (const x of [10, 11, 530, 1109, 1110, 2000, -1]) is(f(x), x === 10 ? 100 : x > 10 && x < 1110 ? 1000 + x - 11 : -1, `1,100 arms: f(${x})`)
})
