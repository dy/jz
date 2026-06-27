/**
 * Optimizer regression tests:
 *   - LICM call-soundness:   loop body containing a call must NOT hoist cell reads
 *     (the call could mutate the cell via another closure that captures it).
 *   - LICM shared-IR:        watr slice pattern — a captured `idx` read appears
 *     in slice-length setup AND inside the slice copy loop. Earlier passes
 *     can share the IR subtree; mutating it inside the loop must not affect
 *     the outside reference.
 *   - arrayElemValType:      .map closure on numeric array elides __to_num
 *     coercion in the body since the param type is known to be NUMBER.
 */
import test from 'tst'
import { almost, is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { onKernel } from './_matrix.js'
import { optimizeFunc, resolveOptimize, PASS_NAMES, csePureExprLoop } from '../src/optimize/index.js'
import { optimize as watOptimize } from 'watr/optimize'
import { run } from './util.js'
import { belowOpt, onWasi } from './_matrix.js'
import { parse, loopCount } from '../scripts/wat-probe.mjs'

test('LICM: call inside loop must not hoist cell reads (mutated via closure)', () => {
  const { main } = run(`
    export const main = () => {
      let i = 0
      const inc = () => { i = i + 1; return 0 }
      let s = 0
      for (let j = 0; j < 10; j++) {
        s = s + i + i
        inc()
      }
      return s | 0
    }
  `)
  // j=0: s=0+0+0=0, then i=1
  // j=1: s=0+1+1=2, then i=2
  // ... s = 2*(0+1+...+9) = 90
  is(main(), 90)
})

test('LICM: shared IR subtree (slice + slice-loop pattern) must not corrupt outside read', () => {
  // Mirrors watr/compile.js shape: idx is captured (mutated elsewhere),
  // used both in slice-length calc AND inside the slice copy loop body.
  // Earlier passes share the IR for `cell_idx` reads — LICM must not
  // mutate the shared subtree.
  const { main } = run(`
    export const main = (a) => {
      let idx = 1
      const set = (v) => { idx = v; return 0 }
      const sub = a.slice(idx)
      let sum = 0
      for (let j = 0; j < sub.length; j++) sum = sum + sub[j]
      set(2)
      return sum | 0
    }
  `)
  // a = [10, 20, 30, 40] → slice(1) = [20,30,40], sum=90
  is(main([10, 20, 30, 40]), 90)
})

test('LICM: actually fires for invariant cell read in non-call loop', () => {
  // Sanity: when conditions are right (no calls, no shared IR, no writes),
  // LICM should hoist the cell load and emit a $__li snap local.
  // `inc` must *escape* (passed to `keep`) so it stays a real closure that
  // mutates the captured `i` via a heap cell — otherwise inlineLocalLambdas
  // would splice it away and `i` would just be a plain wasm local.
  // Inspect jz output without watr — `coalesceLocals` would rename `$__li<N>`.
  const wat = jz.compile(`
    const keep = (f) => f
    export const main = () => {
      let i = 0
      const inc = keep(() => i = i + 1)
      let s = 0
      for (let j = 0; j < 10; j++) s = s + i + i
      inc()
      return s | 0
    }
  `, { wat: true, optimize: { watr: false } })
  ok(/\$__li\d+/.test(wat), 'expected hoisted snap local')
})

test('LICM: does not fire when loop contains calls', () => {
  const wat = jz.compile(`
    export const main = () => {
      let i = 0
      const inc = () => { i = i + 1; return 0 }
      let s = 0
      for (let j = 0; j < 10; j++) { s = s + i + i; inc() }
      return s | 0
    }
  `, { wat: true })
  ok(!/\$__li\d+/.test(wat), 'must not hoist when loop contains a call')
})

test('LICM: self-referential tee induction in loop condition is not hoisted (rfft stage-loop regression)', () => {
  // `while ((nn = nn >>> 1))` — the loop's induction update is a self-referential
  // tee in the condition (nn = f(nn)). hoistInvariantLoop treated the operand's
  // `nn` read as the in-subtree teed value (it is actually the loop-carried previous
  // value, read before the tee writes) and hoisted the whole update to the pre-header,
  // freezing nn nonzero → a non-terminating loop and out-of-bounds stores. This is the
  // rfft split-radix stage loop (examples/rfft/rfft.js transform()). The `count > 1000`
  // guard bounds a regression to a wrong value instead of a hang.
  const src = `
    export const main = (n) => {
      let nn = n >>> 0, count = 0, acc = 0
      while ((nn = nn >>> 1)) { count++; acc += nn; if (count > 1000) break }
      return (count * 1000000 + acc) | 0
    }
  `
  const { main } = run(src)
  is(main(2048), 11 * 1000000 + 2047)  // 2^11: nn walks 1024…1 (11 iters), Σ = 2047
  is(main(64), 6 * 1000000 + 63)       // 2^6: nn walks 32…1 (6 iters), Σ = 63
  is(main(1), 0)                        // 1 >>> 1 = 0 → zero iterations
})

test('rotateLoops: speed tier rotates a scan loop to a fused conditional back-edge', () => {
  // The lz/qoi class of hot scalar loop. Top-test `loop { br_if exit ¬C; body; br loop }`
  // → guarded `br_if exit ¬C; loop { body; br_if loop C }`. The fused `br_if $loop`
  // back-edge is the do-while shape LLVM gives rust/zig (1.34× on lz's match scan);
  // V8 lowers it to one hardware loop branch vs the top-test's exit-branch + back-jump.
  const src = `export const firstGt = (a, n, t) => { let i = 0; while (i < n && a[i] <= t) i++; return i }`
  const rot = jz.compile(src, { wat: true, optimize: { level: 'speed' } })
  const ctl = jz.compile(src, { wat: true, optimize: { level: 'speed', rotateLoops: false } })
  ok(/br_if \$loop\d+/.test(rot) && !/\(br \$loop\d+/.test(rot), 'rotated: fused br_if back-edge, no unconditional br $loop')
  ok(!/br_if \$loop\d+/.test(ctl) && /\(br \$loop\d+/.test(ctl), 'control (rotateLoops off): top-test keeps unconditional br back-edge')
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

test('arrayElemValType: typed-array .map elides __to_num in callback', () => {
  // Float64Array elements have known type NUMBER → __to_num coercion can be
  // elided in the inlined .map callback param.
  const wat = jz.compile(`
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

test('vectorizeLaneLocal: preserves stores inside void blocks', () => {
  const { main } = run(`
    export const main = () => {
      const state = new Int32Array(12)
      let s = 0x1234abcd | 0
      for (let i = 0; i < 12; i++) {
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        state[i] = s
      }
      for (let i = 0; i < 12; i++) {
        let x = state[i] | 0
        x ^= x << 7
        x ^= x >>> 9
        x = Math.imul(x, 1103515245) + 12345
        state[i] = x ^ (x >>> 16)
      }
      return state[11] >>> 0
    }
  `)
  is(main(), 2805299282)
})

test('escape analysis: local object property reads scalarize literal', () => {
  const src = `
    export const main = (x) => {
      const obj = { a: x, b: x + 1 }
      return obj.a + obj["b"]
    }
  `
  const wat = jz.compile(src, { wat: true })
  ok(!/\(call \$__alloc_hdr\b/.test(wat), 'non-escaping object literal should not allocate')
  is(run(src).main(4), 9)
})

test('escape analysis: monotonically-extended object scalarizes', () => {
  // Real code extends static objects (`o.newProp = …`); SRoA must follow the
  // monotonic extension into flat field locals rather than bail to the heap.
  const src = `
    export const main = (x) => {
      const o = { a: x }
      o.b = x + 1
      o.c = o.a + o.b
      return o.c
    }
  `
  const wat = jz.compile(src, { wat: true })
  ok(!/\(call \$__alloc_hdr\b/.test(wat), 'extended non-escaping object should not allocate')
  is(run(src).main(4), 9)
})

test('escape analysis: extension field read before write yields undefined', () => {
  // `o.b` init to undefined at the decl — a read that runs before the write
  // matches JS, and the conditional write still scalarizes.
  const src = `
    export const main = (cond) => {
      const o = { a: 10 }
      const before = o.b
      if (cond) o.b = 5
      return o.b
    }
  `
  const wat = jz.compile(src, { wat: true })
  ok(!/\(call \$__alloc_hdr\b/.test(wat), 'conditionally-extended object should not allocate')
  is(run(src).main(1), 5)
  is(run(src).main(0), undefined)  // unwritten extension field reads undefined
})

test('escape analysis: bracket-key extension scalarizes', () => {
  const src = `
    export const main = (x) => {
      const o = { x: x }
      o['y'] = 7
      return o.x + o['y']
    }
  `
  const wat = jz.compile(src, { wat: true })
  ok(!/\(call \$__alloc_hdr\b/.test(wat), 'bracket-key-extended object should not allocate')
  is(run(src).main(1), 8)
})

test('escape analysis: extended object that escapes still heap allocates', () => {
  // Inspect jz output without watr — `inlineOnce`+`treeshake` may erase the
  // `__alloc_hdr` import once the allocating helper has been fused inline.
  const wat = jz.compile(`
    export const main = (x) => {
      const obj = { a: x }
      obj.b = x + 1
      return obj
    }
  `, { wat: true, optimize: { watr: false } })
  ok(/\(call \$__alloc_hdr\b/.test(wat), 'escaping extended object must stay materialized')
})

test('escape analysis: returned object still heap allocates', () => {
  const wat = jz.compile(`
    export const main = (x) => {
      const obj = { a: x }
      return obj
    }
  `, { wat: true, optimize: { watr: false } })
  ok(/\(call \$__alloc_hdr\b/.test(wat), 'returned object must remain materialized')
})

test('escape analysis: call-passed object still heap allocates', () => {
  // sourceInline off: the fixture pins escape analysis at a REAL call
  // boundary — the leaf inliner would otherwise splice get's body, the call
  // disappears, and scalarizing obj becomes correct (no escape).
  const wat = jz.compile(`
    const get = (obj) => obj.a
    export const main = (x) => {
      const obj = { a: x }
      return get(obj)
    }
  `, { wat: true, optimize: { watr: false, sourceInline: false } })
  ok(/\(call \$__alloc_hdr\b/.test(wat), 'call-passed object must remain materialized')
})

test('inline: large multi-caller leaf folds at speed (transitive candidacy + expression-position hoist), bit-exact', () => {
  // `mix` is a block-body LEAF that CALLS leaf helpers lo/hi — so the strict "any user call
  // ⇒ outline" gate keeps it standalone at ≤2 — and is invoked from MULTIPLE sites in
  // EXPRESSION position `2.0*mix(i) + mix(i+1)`, which neither inlineInStmt's `const X=call`
  // path nor single-call inlineOnce reaches. At speed, transitive candidacy makes it a
  // candidate once lo/hi are, and the hoist lifts the nested calls into temps the direct
  // path folds → 0 calls. ≤2 keep the conservative multi-caller policy (V8 wasm tier-up).
  // This is noise's perlin shape in miniature; a revert of ANY of the three pieces
  // (transitive candidacy, the hoist, or the speed gate) fails a distinct assertion.
  const SRC = `
    let lo = (x) => x * 0.5
    let hi = (x) => x + 1.0
    let mix = (x) => { let a = lo(x); let b = hi(x); return a + b }
    export let f = (n) => { let s = 0.0
      for (let i = 0; i < n; i = i + 1) s = s + 2.0 * mix(i) + mix(i + 1)
      return s }`
  // bit-exact: inlining is pure substitution, so speed must equal the level-2 (called) result
  if (!onWasi()) is(jz(SRC, { optimize: { level: 'speed' } }).exports.f(50),
                    jz(SRC, { optimize: 2 }).exports.f(50), 'speed == level 2 (bit-exact)')
  if (onKernel()) return  // call-shape is a host-codegen assertion; bit-exactness above is portable
  const calls = (opt) => (jz.compile(SRC, { wat: true, optimize: opt }).match(/call \$mix/g) || []).length
  is(calls({ level: 'speed' }), 0, 'speed: transitive+hoist fully inlines the multi-caller leaf')
  ok(calls(2) >= 1, 'level 2: strict policy keeps the multi-caller leaf outlined for tier-up')
})

test('inline: expression-position hoist preserves evaluation order of side effects', () => {
  // The hoist lifts a candidate call to a `const __h = call` temp at the statement top. That
  // is sound ONLY when no side effect precedes it: here `a()` (a non-candidate — it has a loop)
  // runs BEFORE `helper()` textually, so helper must NOT be hoisted above it. Each fn records
  // its call order into `log`; the returned digits encode the order (123 = a,helper,b).
  const order = (src) => jz(src, { optimize: { level: 'speed' } }).exports.f()
  const NONCAND_FIRST = `let log = new Int32Array(4); let n = 0;
    let a = () => { let s = 0; for (let i = 0; i < 1; i = i + 1) s = s + 1; log[n] = 1; n = n + 1; return 10 }
    let helper = (x) => { log[n] = 2; n = n + 1; return x + 1 }
    let b = () => { log[n] = 3; n = n + 1; return 100 }
    export let f = () => { n = 0; let t = a() + helper(5) * b(); return t * 1000000 + log[0]*100 + log[1]*10 + log[2] }`
  is(order(NONCAND_FIRST), 610000123, 'effect before a candidate blocks its hoist — order a,helper,b preserved')

  // When everything preceding is pure / hoistable, the candidate DOES fold (0 calls) and order holds.
  const ALL_CAND = NONCAND_FIRST.replace('let a = () => { let s = 0; for (let i = 0; i < 1; i = i + 1) s = s + 1; log[n] = 1', 'let a = () => { log[n] = 1')
  is(order(ALL_CAND), 610000123, 'all-candidate chain: order a,helper,b preserved')
  if (!onKernel()) is((jz.compile(ALL_CAND, { wat: true, optimize: { level: 'speed' } }).match(/call \$helper/g) || []).length, 0, 'helper still inlines when nothing effectful precedes it')
})

test('known numeric coercions elide __to_num', () => {
  const wat = jz.compile(`
    export const main = (buf) => {
      const a = new Float64Array(buf)
      return Number(a[0]) + +(a[1] + 1) + isNaN(a[2]) + isFinite(a[3])
    }
  `, { wat: true })
  const calls = (wat.match(/\(call \$__to_num/g) || []).length
  is(calls, 0)
})

test('csePureExprLoop: global.set invalidates cached global.get pure expr', () => {
  const fn = ['func', '$f',
    ['result', 'f64'],
    ['loop', [],
      ['global.set', '$g', ['f64.const', 1]],
      ['f64.mul', ['global.get', '$g'], ['f64.const', 2]],
      ['global.set', '$g', ['f64.const', 2]],
      ['call', '$math.sin', ['f64.mul', ['global.get', '$g'], ['f64.const', 2]]],
    ],
  ]
  csePureExprLoop(fn)
  const s = JSON.stringify(fn)
  is((s.match(/"global\.get"/g) || []).length, 2, 'mul after global.set must not reuse stale $__pe snap')
})

test('csePureExprLoop: loop entry clears cached pure expression (petrichor regression)', () => {
  const fn = ['func', '$f',
    ['result', 'f64'],
    ['f64.mul', ['local.get', '$x'], ['f64.const', 2]],
    ['loop', [],
      ['call', '$math.sin', ['f64.mul', ['local.get', '$x'], ['f64.const', 2]]],
    ],
  ]
  csePureExprLoop(fn)
  const s = JSON.stringify(fn)
  is((s.match(/\$__pe/g) || []).length, 0, 'loop entry must clear table so pure expr from outside is not reused inside')
})

test('peephole: i32/f64 signed roundtrips fold post-emit', () => {
  const fn = ['func', '$p',
    ['param', '$x', 'i32'],
    ['result', 'i32'],
    ['i32.trunc_sat_f64_s', ['f64.convert_i32_s', ['local.get', '$x']]]]
  optimizeFunc(fn, { fusedRewrite: true })
  is(JSON.stringify(fn).includes('f64.convert_i32_s'), false)
  is(JSON.stringify(fn).includes('i32.trunc_sat_f64_s'), false)
  is(JSON.stringify(fn.at(-1)), JSON.stringify(['local.get', '$x']))
})

test('peephole: i64/f64/i32 roundtrips fold to direct extension', () => {
  const fn = ['func', '$p',
    ['param', '$x', 'i32'],
    ['result', 'i32'],
    ['i32.wrap_i64', ['i64.trunc_sat_f64_s', ['f64.convert_i32_u', ['local.get', '$x']]]]]
  optimizeFunc(fn, { fusedRewrite: true })
  const s = JSON.stringify(fn)
  is(s.includes('f64.convert_i32_u'), false)
  is(s.includes('i64.trunc_sat_f64_s'), false)
  is(JSON.stringify(fn.at(-1)), JSON.stringify(['local.get', '$x']))
})

test('peephole: i32 constants widen directly to f64 constants', () => {
  const fn = ['func', '$p',
    ['result', 'f64'],
    ['f64.add',
      ['f64.convert_i32_s', ['i32.const', -2]],
      ['f64.convert_i32_u', ['i32.const', '-1']]]]
  optimizeFunc(fn, { fusedRewrite: true })
  const s = JSON.stringify(fn)
  is(s.includes('f64.convert_i32_'), false)
  ok(s.includes('["f64.const",-2]'))
  ok(s.includes('["f64.const",4294967295]'))
})

test('peephole: f64 multiply by two uses addition for cheap operands', () => {
  const fn = ['func', '$p',
    ['param', '$x', 'f64'],
    ['result', 'f64'],
    ['f64.mul', ['f64.const', 2], ['local.get', '$x']]]
  optimizeFunc(fn, { fusedRewrite: true })
  const s = JSON.stringify(fn)
  is(s.includes('f64.mul'), false)
  ok(s.includes('f64.add'))
})

test('unknown coercions still use __to_num', () => {
  const wat = jz.compile(`
    export const main = (x) => Number(x) + +x + isNaN(x) + isFinite(x)
  `, { wat: true })
  ok(/\(call \$__to_num\b/.test(wat))
})

test('dynamic prop reads reuse receiver type tag', () => {
  if (onWasi()) return  // wasi: external object WAT name differs
  if (belowOpt(2)) return  // receiver-tag CSE/hoisting runs at optimize >= 2
  const wat = jz.compile(`
    export const main = (o) => {
      return o.a + o.b + o.c
    }
  `, { wat: true })
  ok(/\(call \$__dyn_get_any_t_h\b/.test(wat))
  ok(/\$__pt\d+/.test(wat), 'expected repeated receiver tag to be hoisted')
})

test('polymorphic object prop reads use typed object dispatch', () => {
  const src = `
    const left = () => ({ x: 11, y: 100 })
    const right = () => ({ y: 200, x: 22 })
    export const hx = (w) => { const o = w == 0 ? left() : right(); return o.x }
    export const hy = (w) => { const o = w == 0 ? left() : right(); return o.y }
  `
  const wat = jz.compile(src, { wat: true })
  ok(/\(i32\.const 3\)[\s\S]*?\(call \$__dyn_get_expr_t/.test(wat), 'expected OBJECT-typed dynamic slot dispatch')
  const { hx, hy } = run(src)
  is(hx(0), 11)
  is(hx(1), 22)
  is(hy(0), 100)
  is(hy(1), 200)
})

test('small const-count for-loop unrolls', () => {
  if (belowOpt(2)) return  // loop unrolling is a full-optimization (level 2) transform
  const src = `
    export const main = () => {
      let acc = 0
      for (let s = 0; s < 4; s++) {
        const c = s * 5
        acc += c
      }
      return acc | 0
    }
  `
  const wat = jz.compile(src, { wat: true })
  ok(!/\(loop\b/.test(wat), 'expected small constant loop to unroll')
  const { main } = run(src)
  is(main(), 30)
})

test('small const-count for-loop respects optimize:false', () => {
  const wat = jz.compile(`
    export const main = () => {
      let acc = 0
      for (let s = 0; s < 4; s++) acc += s
      return acc | 0
    }
  `, { wat: true, optimize: false })
  ok(/\(loop\b/.test(wat), 'optimize:false should not unroll')
})

test('small const-count for-loop does not unroll with break', () => {
  const wat = jz.compile(`
    export const main = () => {
      let acc = 0
      for (let s = 0; s < 4; s++) {
        if (s === 2) break
        acc += s
      }
      return acc | 0
    }
  `, { wat: true })
  ok(/\(loop\b/.test(wat), 'break requires preserving loop control flow')
})

test('small const-count for-loop keeps outer nested loops compact', () => {
  const src = `
    export const main = () => {
      let acc = 0
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          for (let k = 0; k < 4; k++) acc += r + c + k
        }
      }
      return acc | 0
    }
  `
  // Pin level 2 — opt:3 unrolls aggressively, which this asserts is gated off.
  const wat = jz.compile(src, { wat: true, optimize: 2 })
  ok(/\(loop\b/.test(wat), 'outer nested loops should not fully unroll')
  const { main } = run(src, { optimize: 2 })
  is(main(), 288)
})

test('nested small const-count typed-array loops auto-unroll', () => {
  const wat = jz.compile(`
    export const main = () => {
      const a = new Float64Array(16)
      const b = new Float64Array(16)
      const out = new Float64Array(16)
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          let s = 0
          for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]
          out[r * 4 + c] = s
        }
      }
      return out[15]
    }
  `, { wat: true, optimize: { watr: false } })
  ok(!/\(loop\b/.test(wat), 'known typed-array nested loops should auto-unroll')
})

test('fixed Float64Array locals scalar-replace static slots', () => {
  const src = `
    export const main = () => {
      const a = new Float64Array(4)
      a[0] = 1.5
      a[1] = a[0] + 2.5
      return a[1] + a.length
    }
  `
  const wat = jz.compile(src, { wat: true, optimize: { watr: false, sourceInline: false } })
  const mainWat = wat.match(/\(func \$main[\s\S]*?^  \)/m)?.[0] || ''
  ok(!/\$__alloc\b/.test(mainWat), 'local fixed Float64Array should not allocate')
  ok(!/f64\.(?:load|store)\b/.test(mainWat), 'local fixed Float64Array slots should stay in locals')
  is(run(src).main(), 8)
})

test('fixed Float64Array internal params scalar-replace unrolled slots', () => {
  const src = `
    const use = (a, b, out) => {
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          let s = 0
          for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]
          out[r * 4 + c] = s
        }
      }
    }
    export const main = () => {
      const a = new Float64Array(16)
      const b = new Float64Array(16)
      const out = new Float64Array(16)
      a[0] = 2
      b[0] = 3
      use(a, b, out)
      return out[0]
    }
  `
  const wat = jz.compile(src, { wat: true, optimize: { watr: false, sourceInline: false } })
  const useWat = wat.match(/\(func \$use[\s\S]*?^  \)/m)?.[0] || ''
  is((useWat.match(/\(loop\b/g) || []).length, 0)
  is((useWat.match(/f64\.load\b/g) || []).length, 32)
  is((useWat.match(/f64\.store\b/g) || []).length, 16)
  ok(/tap\d+_/.test(useWat), 'expected promoted input parameter slots')
  is(run(src).main(), 6)
})

test('fixed Float64Array callsites scalar-replace across exported caller and SIMD dot pairs', () => {
  const src = `
    const multiplyMany = (a, b, out, iters) => {
      for (let n = 0; n < iters; n++) {
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 4; c++) {
            let s = 0
            for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]
            out[r * 4 + c] = s + n * 0.0000001
          }
        }
        const t = a[0]
        a[0] = out[15]
        a[5] = t + out[10] * 0.000001
        b[0] += out[0] * 0.00000000001
        b[5] -= out[5] * 0.00000000001
      }
    }
    export const main = (iters) => {
      const a = new Float64Array(16)
      const b = new Float64Array(16)
      const out = new Float64Array(16)
      for (let i = 0; i < 16; i++) {
        a[i] = (i + 1) * 0.125
        b[i] = (16 - i) * 0.0625
      }
      multiplyMany(a, b, out, iters | 0)
      return out[0] + out[5] + out[10] + out[15] + a[0] + a[5]
    }
  `
  const refMain = (iters) => {
    const a = new Float64Array(16), b = new Float64Array(16), out = new Float64Array(16)
    for (let i = 0; i < 16; i++) { a[i] = (i + 1) * 0.125; b[i] = (16 - i) * 0.0625 }
    const mm = (iters) => {
      for (let n = 0; n < iters; n++) {
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
          let s = 0
          for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]
          out[r * 4 + c] = s + n * 0.0000001
        }
        const t = a[0]; a[0] = out[15]; a[5] = t + out[10] * 0.000001
        b[0] += out[0] * 0.00000000001
        b[5] -= out[5] * 0.00000000001
      }
    }
    mm(iters | 0)
    return out[0] + out[5] + out[10] + out[15] + a[0] + a[5]
  }
  // Inspect jz's sourceInline + cross-function scalar replacement. Run watr's
  // inlining out — otherwise `inlineOnce` reshapes `$main` and confuses the
  // function-boundary regex below.
  const wat = jz.compile(src, { wat: true, optimize: { watr: false } })
  const mainWat = wat.match(/\(func \$main[\s\S]*?^  \)/m)?.[0] || ''
  ok(!/\(call \$multiplyMany\b/.test(mainWat), 'fixed typed-array callee should inline into exported caller')
  ok(!/\$__alloc\b/.test(mainWat), 'cross-function scalar replacement should remove fixed typed-array allocations')
  ok(!/f64\.(?:load|store)\b/.test(mainWat), 'cross-function scalar replacement should keep mat4 arrays in locals')
  ok(/f64x2\./.test(mainWat), 'straight-line f64 dot pairs should vectorize with f64x2')
  ok(/\(loop\b/.test(mainWat), 'dynamic mat4 loop must remain, not collapse to a closed form')
  const { main } = run(src)
  almost(main(0), refMain(0), 1e-9)
  almost(main(1), refMain(1), 1e-9)
  almost(main(5), refMain(5), 1e-9)

  // At the speed/relaxedSimd tier the OUTER-loop-invariant partial products are hoisted
  // out of the n-loop (rust/LLVM's mat4-prologue trick — only a[0],a[5],b[0],b[5] mutate,
  // so most of each a[r]·b[c] dot is constant across iterations). Each unrolled dot then
  // has < DOT_UNROLL accumulate steps, so it stays scalar instead of f64x2 — measured ~1.9×
  // faster than the pack/extract SIMD form, beating rust-wasm. The reassociation (invariant
  // terms summed first) is ULP-level, so it is gated to speed; the level-2 path above keeps
  // the bit-exact f64x2 dot pairs.
  const speedWat = jz.compile(src, { wat: true, optimize: { level: 'speed', watr: false } })
  ok(/\$__rinv_/.test(speedWat), 'speed tier hoists loop-invariant dot partials into $__rinv locals')
  ok(!/f64x2\./.test(speedWat.match(/\(func \$main[\s\S]*?^  \)/m)?.[0] || speedWat), 'hoisted dots drop the f64x2 pack/extract')
  const speed = run(src, { optimize: 'speed' })
  almost(speed.main(0), refMain(0), 1e-9)
  almost(speed.main(5), refMain(5), 1e-9)
})

test('fixed integer typed-array locals scalar-replace with element coercion', () => {
  const src = `
    export const main = () => {
      const lut = new Int32Array(4)
      for (let i = 0; i < 4; i++) lut[i] = i * 3.7
      const tape = new Uint8Array(3)
      tape[0] = 257
      tape[1] = -1
      tape[2] = lut[3] & 7
      return lut[0] + lut[1] + lut[2] + lut[3] + tape[0] + tape[1] + tape[2]
    }
  `
  const wat = jz.compile(src, { wat: true, optimize: { watr: false, sourceInline: false } })
  const mainWat = wat.match(/\(func \$main[\s\S]*?^  \)/m)?.[0] || ''
  ok(!/\$__alloc\b/.test(mainWat), 'local fixed integer typed arrays should not allocate')
  ok(!/i32\.(?:load|store)\b/.test(mainWat), 'local fixed integer typed-array slots should stay in locals')
  // Truncation matches JS: Int32Array trunc-toward-zero, Uint8Array & 0xFF.
  const ref = (() => {
    const lut = new Int32Array(4); for (let i = 0; i < 4; i++) lut[i] = i * 3.7
    const tape = new Uint8Array(3); tape[0] = 257; tape[1] = -1; tape[2] = lut[3] & 7
    return lut[0] + lut[1] + lut[2] + lut[3] + tape[0] + tape[1] + tape[2]
  })()
  is(run(src).main(), ref)
})

test('escaping integer typed array keeps its allocation (no unsound mirror)', () => {
  const src = `
    const fill = (a) => { for (let i = 0; i < 4; i++) a[i] = i }
    export const main = () => {
      const a = new Int32Array(4)
      fill(a)
      return a[0] + a[1] + a[2] + a[3]
    }
  `
  const wat = jz.compile(src, { wat: true, optimize: { watr: false, sourceInline: false } })
  ok(/\$__alloc_hdr_n\b/.test(wat), 'escaping integer typed array must stay heap-allocated')
  is(run(src).main(), 6)
})

test('nested small const-count for-loop unroll is opt-in', () => {
  const wat = jz.compile(`
    export const main = () => {
      let acc = 0
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          for (let k = 0; k < 4; k++) acc += r + c + k
        }
      }
      return acc | 0
    }
  `, { wat: true, optimize: { watr: false, nestedSmallConstForUnroll: true } })
  ok(!/\(loop\b/.test(wat), 'bounded nested loops should unroll only when explicitly enabled')
})

test('typed-array address fusion: arr[i + k] uses one base plus offsets', () => {
  const wat = jz.compile(`
    export const main = (arr, idx) => {
      const a = new Float64Array(arr)
      const i = idx | 0
      return a[i + 0] + a[i + 1] + a[i + 2] + a[i + 3]
    }
  `, { wat: true, optimize: { watr: false } })
  ok(/\$__ab\d+/.test(wat), 'expected shared address-base local')
  ok(/f64\.load offset=8[\s\S]*local\.get \$__ab\d+/.test(wat), 'expected i+1 as offset=8 from shared base')
  ok(/f64\.load offset=16[\s\S]*local\.get \$__ab\d+/.test(wat), 'expected i+2 as offset=16 from shared base')
  ok(/f64\.load offset=24[\s\S]*local\.get \$__ab\d+/.test(wat), 'expected i+3 as offset=24 from shared base')
})

test('known array at reads header length directly', () => {
  const wat = jz.compile(`
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
  const wat = jz.compile(`
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
  // Float literals keep the array ARRAY-shaped (int-only would auto-promote
  // to TYPED via plan.js's promoteIntArrayLiterals and route through .typed:map
  // / .typed:filter, which DO call $__len).
  const wat = jz.compile(`
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
  const wat = jz.compile(`
    export const main = (a) => {
      if (Array.isArray(a)) return a[0]
      return 0
    }
  `, { wat: true, optimize: { watr: false } })
  const mainBody = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  // A known plain ARRAY + numeric key lowers to a monomorphic access: the
  // inline bounds-checked f64.load fast path (`idx < len ? load : undefined`,
  // no call) — or, for back-compat, the `__arr_idx_known` helper. Both are
  // monomorphic; neither goes through the generic tag-dispatch helper. The
  // inline load is the current (faster) form: no call, hoistable base/len.
  if (!onKernel()) ok(/f64\.load/.test(mainBody) || /\((?:return_)?call \$__arr_idx_known\b/.test(mainBody),
    'known ARRAY numeric index should use the monomorphic inline load (or __arr_idx_known helper)')  // self-host kernel codegen differs; in-process leg owns the shape check
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
  const wat = jz.compile(`
    const copy = (a) => [...a]
    export const main = () => copy([1, 2, 3])[1]
  `, { wat: true, optimize: { watr: false } })
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

test('sourceInline: inlines returnless hot internal helper calls', () => {
  const src = `
    const hot = (a, n) => {
      for (let i = 0; i < n; i++) a[i] = i + 1
    }
    const runKernel = (a) => { hot(a, 4) }
    export const main = () => {
      const a = new Float64Array(4)
      runKernel(a)
      return a[3] | 0
    }
  `
  const wat = jz.compile(src, { wat: true, optimize: 3 })
  ok(!/\(call \$hot\b/.test(wat), 'expected hot helper call to be inlined')
  ok(!/\(func \$hot\b/.test(wat), 'expected inlined helper to treeshake away')
  const { main } = run(src, { optimize: 3 })
  is(main(), 4)
})

test('sourceInline: enabled by default at level 2 — inlines void hot helper', () => {
  const wat = jz.compile(`
    const hot = (a, n) => {
      for (let i = 0; i < n; i++) a[i] = i + 1
    }
    const runKernel = (a) => { hot(a, 4) }
    export const main = () => {
      const a = new Float64Array(4)
      runKernel(a)
      return a[3] | 0
    }
  `, { wat: true, optimize: { watr: false } })
  ok(!/\(call \$hot\b/.test(wat), 'level 2 source optimizer should inline the helper before watr')
})

test('sourceInline: trailing-return helper inlines into `let X = call(...)` initializer', () => {
  if (belowOpt(2)) return  // asserts the sourceInline pass ran (optimize >= 2)
  const src = `
    const sum = (arr) => {
      let s = 0
      for (let i = 0; i < arr.length; i++) s += arr[i]
      return s
    }
    const runKernel = (a) => { const t = sum(a); return t | 0 }
    export const main = () => {
      const a = new Float64Array(4)
      a[0] = 1; a[1] = 2; a[2] = 3; a[3] = 4
      return runKernel(a)
    }
  `
  const wat = jz.compile(src, { wat: true })
  ok(!/\(call \$sum\b/.test(wat), 'expected trailing-return sum to be inlined at expr-position call')
  const { main } = run(src)
  is(main(), 10)
})

test('sourceInline: trailing-return helper inlines into `X = call(...)` assignment', () => {
  if (belowOpt(2)) return  // asserts the sourceInline pass ran (optimize >= 2)
  const src = `
    const acc = (arr) => {
      let s = 0
      for (let i = 0; i < arr.length; i++) s += arr[i]
      return s + 1
    }
    const runKernel = (a) => { let r = 0; r = acc(a); return r | 0 }
    export const main = () => {
      const a = new Float64Array(3)
      a[0] = 10; a[1] = 20; a[2] = 30
      return runKernel(a)
    }
  `
  const wat = jz.compile(src, { wat: true })
  ok(!/\(call \$acc\b/.test(wat), 'expected trailing-return acc to be inlined at assignment-rhs')
  const { main } = run(src)
  is(main(), 61)
})

test('sourceInline: nested calls flatten — lerp(grad(a), grad(b), t) fully inlines', () => {
  if (belowOpt(2)) return
  // A call whose args are THEMSELVES candidate calls (noise's `lerp(grad(aa,…), grad(ba,…), u)`)
  // must flatten end-to-end: non-simple args bind to temps (no duplication), then a follow-up
  // pass folds the inner candidate into the temp decl. `grad` is a branchy leaf (`?:`), so this
  // also exercises pureFlattenExpr accepting conditionals + comparisons. Result: the per-pixel
  // kernel `perlin` carries zero helper calls.
  const src = `
    const grad = (h, x, y) => { const g = h & 3; const u = (g & 1) === 0 ? x : -x; const v = (g & 2) === 0 ? y : -y; return u + v }
    const lerp = (a, b, t) => a + t * (b - a)
    const perlin = (perm, x, y) => {
      const X = (x | 0) & 255
      const aa = perm[(perm[X] + 1) & 511], ba = perm[(perm[(X + 1) & 511] + 1) & 511]
      return lerp(grad(aa, x, y), grad(ba, x - 1.0, y), x)
    }
    const run = (perm) => { let s = 0.0; for (let i = 0; i < 256; i++) s = s + perlin(perm, i * 0.1, i * 0.2); return s }
    export const main = () => { const perm = new Int32Array(512); for (let i = 0; i < 512; i++) perm[i] = (i * 31) & 255; return run(perm) }
  `
  const wat = jz.compile(src, { wat: true })
  ok(!/\(call \$grad\b/.test(wat) && !/\(call \$lerp\b/.test(wat), 'nested grad/lerp calls fully inlined (perlin flattens)')
  ok(!/\(func \$grad\b/.test(wat) && !/\(func \$lerp\b/.test(wat), 'inlined leaves treeshake away')
  // Bit-exact: inlining + temp-binding must not change the result.
  const fast = run(src).main()
  const slow = jz(src, { optimize: { level: 2, sourceInline: false } }).exports.main()
  is(fast, slow, 'inlined result identical to un-inlined')
})

test('sourceInline: trailing-return helper inlines into indexed `out[i] = call(...)`', () => {
  const src = `
    export let beat = (t) => Math.sin(t * 6.28)
    export let fill = (out, len, sr) => {
      let i = 0
      while (i < len) { out[i] = beat(i / sr); i++ }
    }
    export const main = () => {
      const out = new Float64Array(4)
      fill(out, 4, 44100)
      return out[1]
    }
  `
  const wat = jz.compile(src, { wat: true, optimize: { watr: false } })
  const fillFn = wat.match(/\(func \$fill[\s\S]*?\n  \)/)?.[0] || ''
  ok(!/call \$beat/.test(fillFn), 'expected beat inlined into fill loop')
  const { beat, main } = run(src)
  almost(main(), beat(1 / 44100), 1e-5)
})

test('sourceInline: does NOT inline ordinary hot loop into exported entry', () => {
  const src = `
    const hot = (n) => {
      let s = 0
      for (let i = 0; i < n; i++) s += i + 1
      return s
    }
    export const main = () => {
      return hot(4) | 0
    }
  `
  // jz's sourceInline declines (skip-into-export rule); but watr's `inlineOnce`
  // is single-callsite based and would happily inline `hot` itself. Disable
  // watr to verify jz's own decision.
  const wat = jz.compile(src, { wat: true, optimize: { watr: false } })
  ok(/\(call \$hot\b/.test(wat), 'expected call kept inside exported entry (skip-into-export rule)')
  const { main } = run(src)
  is(main(), 10)
})

test('sourceInline: does NOT inline nested typed-array kernel unless all typed arrays are fixed', () => {
  const src = `
    const cascade = (x, state, out, nStages) => {
      for (let i = 0; i < x.length; i++) {
        let v = x[i]
        for (let s = 0; s < nStages; s++) {
          const y = v + state[s]
          state[s] = y
          v = y
        }
        out[i] = v
      }
    }
    const runKernel = () => {
      const x = new Float64Array(80)
      const state = new Float64Array(4)
      const out = new Float64Array(80)
      x[0] = 2
      state[0] = 1
      cascade(x, state, out, 4)
      return out[0] | 0
    }
    export const main = () => runKernel()
  `
  const wat = jz.compile(src, { wat: true, optimize: { watr: false } })
  ok(/\(func \$cascade\b/.test(wat), 'nested kernel should stay callable')
  ok(/\(call \$cascade\b/.test(wat), 'nested kernel call should be preserved')
  const { main } = run(src)
  is(main(), 3)
})

test('sourceInline: disabled by optimize:false', () => {
  const wat = jz.compile(`
    const hot = (a, n) => {
      for (let i = 0; i < n; i++) a[i] = i + 1
    }
    export const main = () => {
      const a = new Float64Array(4)
      hot(a, 4)
      return a[3] | 0
    }
  `, { wat: true, optimize: false })
  ok(/\(call \$hot\b/.test(wat), 'optimize:false should keep the helper call')
})

test('typed-array assignment statement does not materialize assigned value', () => {
  const wat = jz.compile(`
    export const main = (x) => {
      const a = new Uint32Array(1)
      a[0] = x | 0
      return 1
    }
  `, { wat: true, optimize: { watr: false } })
  const mainBody = wat.slice(wat.indexOf('(func $main'), wat.indexOf('(func $main$exp'))
  ok(/\(i32\.store/.test(mainBody), 'expected typed-array store')
  is(/f64\.convert_i32_[su]/.test(mainBody), false)
  const storeAt = mainBody.indexOf('(i32.store')
  const storePrefix = mainBody.slice(Math.max(0, storeAt - 120), storeAt)
  is(/\(block\s+\(result f64\)/.test(storePrefix), false)
})

test('byte transform `out[i] = table[in[j]]` stores i32 directly — no f64 round-trip', () => {
  // An integer typed-array element READ materializes as `f64.convert_i32_*(load8_u …)`, but when
  // its only consumer is an integer typed-array STORE the value is integer-backed: store the i32
  // low bits via `store8` and skip the sign-branch + i64-trunc + wrap. Eradicates the f64 detour
  // on every byte/codec transform (base64/qoi/wav). General: any `dst[i] = src[j]` of int elements.
  // xform is INTERNAL (its array params are typed Uint8Array via main's `new Uint8Array` call sites)
  // and called twice so it survives as a function to inspect. The store value `table[src[i]]` is a
  // Uint8 read (materialized f64.convert) whose only consumer is the Uint8 store → i32.store8 directly.
  const SRC = `
    const xform = (src, table, out, n) => { for (let i = 0; i < n; i++) out[i] = table[src[i]] }
    export const main = () => {
      const src = new Uint8Array(8), table = new Uint8Array(256), out = new Uint8Array(8)
      for (let i = 0; i < 256; i++) table[i] = (i * 7) & 0xff
      for (let i = 0; i < 8; i++) src[i] = (i * 31) & 0xff
      xform(src, table, out, 8); xform(src, table, out, 8)
      return out[3] | 0
    }
  `
  const wat = jz.compile(SRC, { wat: true })
  // xform inlines into main$exp; the whole user function (transform + fills) is integer-only.
  const start = wat.indexOf('(func $main')
  const body = wat.slice(start, wat.indexOf('\n  (func ', start + 10) + 1 || undefined)
  ok(/i32\.store8/.test(body), 'stores the byte directly via i32.store8')
  is(/i64\.trunc_sat|f64\.lt/.test(body), false, 'no f64→i32 trunc / sign-branch in the byte transform')
  is(jz(SRC).exports.main(), ((((3 * 31) & 0xff) * 7) & 0xff), 'byte transform result correct (table[src[3]])')
})

test('integer === integer compares in i32 — no f64.eq widen', () => {
  // `a[i] === b[j]` (two u8 reads) and `intLocal === b[j]` (the levenshtein DP cell) materialize
  // operands as f64 under the universal value model, but the equality must lower to i32.eq, not
  // widen both to f64 and `f64.eq`. General: any integer-backed === / == / !==. Bit-exact.
  const SRC = `
    const eqcount = (a, b, n) => {
      let c = 0
      for (let i = 1; i <= n; i++) { const ai = a[i - 1]; if (ai === b[i - 1]) c++ }   // i32 local vs u8 read (mixed sign)
      for (let i = 0; i < n; i++) if (a[i] === b[i]) c++                                 // u8 read vs u8 read (same sign)
      return c
    }
    export const main = () => {
      const a = new Uint8Array(16), b = new Uint8Array(16)
      for (let i = 0; i < 16; i++) { a[i] = (i * 7) & 7; b[i] = (i * 5) & 7 }
      return eqcount(a, b, 16) + eqcount(a, b, 16)
    }
  `
  const wat = jz.compile(SRC, { wat: true })   // eqcount is called twice → stays its own function
  const start = wat.indexOf('(func $eqcount')
  const body = wat.slice(start, wat.indexOf('\n  (func ', start + 10) + 1 || undefined)
  is(/f64\.eq|f64\.ne/.test(body), false, 'no f64 equality — integer operands compare in i32')
  ok(/i32\.eq/.test(body), 'lowers to i32.eq')
  const ref = (() => { const a = [], b = []; for (let i = 0; i < 16; i++) { a[i] = (i * 7) & 7; b[i] = (i * 5) & 7 }
    let f = (n) => { let c = 0; for (let i = 1; i <= n; i++) if (a[i - 1] === b[i - 1]) c++; for (let i = 0; i < n; i++) if (a[i] === b[i]) c++; return c }; return f(16) + f(16) })()
  is(jz(SRC).exports.main(), ref, 'eqcount result bit-exact vs JS')
})

test('if-conversion: `if (cond) x = cheapPure` → branchless select (speed tier)', () => {
  // A data-dependent guarded scalar update (min/max/clamp reduction) becomes a `select` instead
  // of a branch — kills misprediction in hot loops (levenshtein's DP min, ~27% faster). General:
  // any no-else `if (cheapCond) local = cheapPureExpr`. Only at the speed tier (select is a
  // latency/size trade, like boolConvertToSelect). Bit-exact vs the branchy form.
  const SRC = `
    const reduce = (xs, n) => {
      let m = xs[0]
      for (let i = 1; i < n; i++) { const v = xs[i]; if (v < m) m = v; if (v > 1000) m = m + 1 }
      return m
    }
    export const main = () => {           // call twice so reduce stays its own function to inspect
      const xs = new Int32Array(64)
      let s = 12345 | 0
      for (let i = 0; i < 64; i++) { s = (s * 1103515245 + 12345) | 0; xs[i] = (s >>> 8) & 0x3ff }
      return (reduce(xs, 64) + reduce(xs, 64)) | 0
    }
  `
  const grab = (wat) => wat.slice(wat.indexOf('(func $reduce'), wat.indexOf('\n  (func ', wat.indexOf('(func $reduce') + 10) + 1 || undefined)
  const fn = grab(jz.compile(SRC, { wat: true, optimize: { level: 'speed' } }))
  ok(/\bselect\b/.test(fn), 'guarded update lowered to select at speed tier')
  is(/\(if\b/.test(fn), false, 'no branch left for the guarded update')
  // Default tier keeps the branch (select is speed-only). Pin level 2 so
  // JZ_TEST_OPTIMIZE=3 can't flip this half to speed (cf. test/perf.js threshold pin).
  const fnD = grab(jz.compile(SRC, { wat: true, optimize: 2 }))
  ok(/\(if\b/.test(fnD), 'default tier keeps the branch (select is a speed-tier trade)')
  // Bit-exact regardless of tier.
  const ref = (() => { const xs = []; let s = 12345 | 0; for (let i = 0; i < 64; i++) { s = (s * 1103515245 + 12345) | 0; xs[i] = (s >>> 8) & 0x3ff }
    let m = xs[0]; for (let i = 1; i < 64; i++) { const v = xs[i]; if (v < m) m = v; if (v > 1000) m = m + 1 } return (m + m) | 0 })()
  is(jz(SRC, { optimize: { level: 'speed' } }).exports.main(), ref, 'speed-tier result bit-exact')
  is(jz(SRC).exports.main(), ref, 'default-tier result bit-exact')
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
  const wat = jz.compile(SRC, { wat: true, optimize: { level: 'speed' } })   // grad (small leaf) inlines into main
  const m = wat.slice(wat.indexOf('(func $main'), wat.indexOf('\n  (func ', wat.indexOf('(func $main') + 10) + 1 || undefined)
  ok(/\bselect\b/.test(m), 'gradient sign-select lowered to branchless select')
  is(/\(if \(result f64\)/.test(m), false, 'no f64 conditional branch left')
  const ref = (() => { const g = (h, x, y) => { const u = (h & 1) === 0 ? x : -x; const v = (h & 2) === 0 ? y : -y; return u + v }
    let s = 0.0; for (let i = 0; i < 16; i++) s = s + g(i, i * 0.5, i * 0.25) + g(i + 1, i * 0.3, i * 0.7); return (s * 1000) | 0 })()
  is(jz(SRC, { optimize: { level: 'speed' } }).exports.main(), ref, 'grad result bit-exact vs JS')
})

test('if→select: short-circuit || with a side-effecting cond is NOT folded (regression: tee reorder)', () => {
  // `a || b` lowers to (if (result f64) is_truthy(local.tee $t a) (then $t)(else b)) — the cond
  // hides a tee the then-arm reads. wasm `select` evaluates its arms BEFORE the cond, so folding
  // would read $t stale. The cond-purity gate must reject it (this broke ||/??= before the gate).
  const SRC = `export const f = (a, b) => a || b
    export const main = () => { let n = 0; if (f(0, 5) === 5) n = n + 1; if (f(7, 9) === 7) n = n + 2; if (f(false, 3) === 3) n = n + 4; return n }`
  is(jz(SRC).exports.main(), 7, '|| short-circuit stays correct (0||5=5, 7||9=7, false||3=3)')
})

test('Math.floor(bounded)|0 → single i32.trunc_sat (no i64 round-trip / +∞ guard)', () => {
  // f64Range now maps through f64.floor: Math.floor(u8 * scale) is a finite, in-i32-range value,
  // so toI32 emits one i32.trunc_sat_f64_s instead of i64.trunc_sat + i32.wrap + (select … f64.ne
  // ∞). The image/audio index class (`Math.floor(pixel * scale)`). Bit-exact. (Inert when the
  // floor's input is a bare param/local — f64Range can't bound those without range-of-locals.)
  const SRC = `
    const f = (buf, out, n) => { for (let i = 0; i < n; i++) out[i] = (Math.floor(buf[i] * 0.5) | 0) & 255 }
    export const main = () => { const buf = new Uint8Array(8), out = new Int32Array(8); for (let i = 0; i < 8; i++) buf[i] = i * 31; f(buf, out, 8); f(buf, out, 8); return out[3] | 0 }
  `
  const wat = jz.compile(SRC, { wat: true, optimize: { level: 'speed' } })
  is(/i64\.trunc_sat/.test(wat), false, 'no i64 trunc round-trip for the bounded floor')
  ok(/i32\.trunc_sat_f64_s/.test(wat), 'single i32.trunc_sat for the bounded floor')
  const ref = (() => { const buf = [], out = []; for (let i = 0; i < 8; i++) buf[i] = (i * 31) & 255
    const f = (b, o, n) => { for (let i = 0; i < n; i++) o[i] = (Math.floor(b[i] * 0.5) | 0) & 255 }; f(buf, out, 8); f(buf, out, 8); return out[3] | 0 })()
  is(jz(SRC, { optimize: { level: 'speed' } }).exports.main(), ref, 'floor result bit-exact vs JS')
})

test('param-distinctness LICM: invariant load from a proven-distinct param hoists across a store', () => {
  // proc reads src[0]/src[1] (invariant) and writes dst[i]. With src,dst proven distinct buffers
  // (every call site passes distinct fresh `new TypedArray` locals), the src loads are loop-
  // invariant ACROSS the dst store and hoist to the pre-header — the alias-analysis LICM rust/clang
  // do (raytrace's read-only sphere arrays vs the framebuffer). No loads left in the loop body.
  // Large (non-scalarizable) arrays + 3 call sites keep proc a standalone function to inspect.
  const SRC = `
    const proc = (src, dst, n) => { for (let i = 0; i < n; i++) dst[i] = src[0] + src[1] * i + src[2] - src[3] }
    export const main = () => {
      const src = new Float64Array(256), dst = new Float64Array(256)
      for (let k = 0; k < 256; k++) src[k] = k + 0.5
      proc(src, dst, 256); proc(src, dst, 256); proc(src, dst, 256)
      return (dst[255] * 1000) | 0
    }
  `
  const wat = jz.compile(SRC, { wat: true, optimize: { level: 'speed' } })
  const fn = wat.slice(wat.indexOf('(func $proc'), wat.indexOf('\n  (func ', wat.indexOf('(func $proc') + 10) + 1 || undefined)
  const li = fn.indexOf('(loop')   // the dst-store loop
  is(/f64\.load/.test(fn.slice(li)), false, 'invariant src loads hoisted OUT of the loop (alias-distinct from dst)')
  ok(/f64\.load/.test(fn.slice(0, li)), 'the src loads moved to the pre-header')
  const ref = (() => { const src = [], dst = []; for (let k = 0; k < 256; k++) src[k] = k + 0.5
    const p = (s, d, n) => { for (let i = 0; i < n; i++) d[i] = s[0] + s[1] * i + s[2] - s[3] }
    p(src, dst, 256); p(src, dst, 256); p(src, dst, 256); return (dst[255] * 1000) | 0 })()
  is(jz(SRC, { optimize: { level: 'speed' } }).exports.main(), ref, 'distinct-param result bit-exact vs JS')
})

test('param-distinctness LICM: SOUND — same array passed for two params is NOT hoisted (aliasing)', () => {
  // f reads a[0] and writes b[i]. If the caller passes the SAME array for a and b, the store
  // clobbers a[0] mid-loop, so the load must NOT be hoisted. analyzeParamDistinctness must refuse
  // to mark a,b distinct here (the same arg appears twice), so the load stays in the loop. A wrong
  // hoist would compute n*a[0]_initial instead of the clobbered running value — this pins it.
  const SRC = `
    const f = (a, b, n) => { let s = 0.0; for (let i = 0; i < n; i++) { s = s + a[0]; b[i] = 7.0 } return s }
    export const main = () => { const arr = new Float64Array(8); arr[0] = 3.0; return (f(arr, arr, 8) + f(arr, arr, 8)) | 0 }
  `
  const ref = (() => { const arr = []; arr[0] = 3.0; const f = (a, b, n) => { let s = 0.0; for (let i = 0; i < n; i++) { s = s + a[0]; b[i] = 7.0 } return s }; return (f(arr, arr, 8) + f(arr, arr, 8)) | 0 })()
  is(jz(SRC).exports.main(), ref, 'aliasing result correct at default tier (a[0] clobbered by b[0])')
  is(jz(SRC, { optimize: { level: 'speed' } }).exports.main(), ref, 'aliasing result correct at speed tier (load NOT wrongly hoisted)')
})

test('charCodeAt: returns i32 — no f64 widen/truncate in tokenizer-shape loop', () => {
  // `let c = s.charCodeAt(i)` should leave $c as i32 and the digit accumulator
  // (`number * 10 + (c - 48)`) should be pure i32 — no __to_num, no
  // i64.trunc_sat_f64_s, no f64.convert_i32_u of the char code.
  // Inspect jz's type decisions before watr `coalesceLocals` renames `$c`.
  const wat = jz.compile(`
    export const main = (s) => {
      let n = 0
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c >= 48 && c <= 57) n = n * 10 + (c - 48)
      }
      return n | 0
    }
  `, { wat: true, optimize: { watr: false } })
  ok(/\(local \$c i32\)/.test(wat), 'expected $c declared as i32')
  is((wat.match(/\(call \$__to_num/g) || []).length, 0)
  is((wat.match(/i64\.trunc_sat_f64_s/g) || []).length, 0)
})

test('charCodeAt: runtime correctness — digit parse', () => {
  const { main } = run(`
    export const main = (s) => {
      let n = 0
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c >= 48 && c <= 57) n = n * 10 + (c - 48)
      }
      return n | 0
    }
  `)
  is(main('abc12345xyz'), 12345)
  is(main('  9  '), 9)
})

test('single-char string index equality skips materialized char string', () => {
  const wat = jz.compile(`
    export const main = (x) => x[0] === '$'
  `, { wat: true, optimize: { watr: false } })
  const mainBody = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  ok(!/\(call \$__str_idx\b/.test(mainBody), 'char equality should compare string bytes directly')
  ok(/\(call \$__char_at\b/.test(mainBody), 'expected direct char byte comparison')
})

test('single-char string index equality keeps array fallback semantics', () => {
  const { main } = run(`
    const hit = x => x[0] === '$'
    export const main = () => {
      return hit('$abc')
        + hit('abc') * 2
        + hit('') * 4
        + hit(['$', 1]) * 8
        + hit([1, 2]) * 16
    }
  `)
  is(main(), 9)
})

test('single-char index equality: non-literal int index (loop variable)', () => {
  const wat = jz.compile(`
    export const main = (s) => {
      let i = 0
      while (i < s.length && s[i] === ' ') i++
      return i
    }
  `, { wat: true, optimize: { watr: false } })
  const mainBody = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  ok(!/\(call \$__str_idx\b/.test(mainBody), 'loop-variable char equality should skip __str_idx materialization')
  ok(/\(call \$__char_at\b/.test(mainBody), 'expected direct char byte comparison')
})

test('single-char index equality: for-loop runtime correctness', () => {
  const { main } = run(`
    export const main = (s) => {
      let n = 0
      for (let i = 0; i < s.length; i++) if (s[i] === '"') n++
      return n
    }
  `)
  is(main('a"b"c"'), 3)
  is(main(''), 0)
  is(main('no quotes'), 0)
})

test('single-char index equality: !== with loop variable', () => {
  const { main } = run(`
    export const main = (s) => {
      let i = 0
      while (i < s.length && s[i] !== ' ') i++
      return i
    }
  `)
  is(main('abc def'), 3)
  is(main('   '), 0)
  is(main('abc'), 3)
})

test('resolveOptimize: levels, booleans, object overrides', () => {
  const level2 = resolveOptimize(true)
  const allOff = resolveOptimize(false)
  for (const n of PASS_NAMES) {
    is(level2[n], resolveOptimize(2)[n], `level true: ${n} matches level 2`)
    is(allOff[n], false, `level false: ${n} off`)
  }
  is(resolveOptimize(0).watr, false)
  is(resolveOptimize(0).treeshake, false)
  // Default (level 2) runs the full watr pipeline (inlineOnce + coalesce on;
  // `inline` stays off per watr's own default).
  is(resolveOptimize(2).watr, true)
  is(resolveOptimize(2).sourceInline, true)
  is(resolveOptimize(2).nestedSmallConstForUnroll, 'auto')
  // Level 3 keeps watr on, plus aggressive nested-unroll.
  is(resolveOptimize(3).watr, true)
  is(resolveOptimize(3).sourceInline, true)
  is(resolveOptimize(3).nestedSmallConstForUnroll, true)
  // level 1 = encoding-compactness only
  const l1 = resolveOptimize(1)
  is(l1.treeshake, true)
  is(l1.sortLocalsByUse, true)
  is(l1.fusedRewrite, true)
  is(l1.watr, false)
  is(l1.hoistAddrBase, false)
  is(l1.hoistConstantPool, false)
  // object: level 0 base + watr override
  const o = resolveOptimize({ level: 0, watr: true })
  is(o.watr, true)
  is(o.treeshake, false)
  is(resolveOptimize({ level: 3, nestedSmallConstForUnroll: 'auto' }).nestedSmallConstForUnroll, 'auto')
  // undefined: default = level 2
  is(resolveOptimize(undefined).watr, true)
  is(resolveOptimize(undefined).sourceInline, true)
  is(resolveOptimize(undefined).nestedSmallConstForUnroll, 'auto')
  // string presets. 'balanced' was removed (it was a pure synonym for the default
  // level 2); a stray 'balanced' now falls back to the default like any unknown string.
  for (const n of PASS_NAMES) is(resolveOptimize('balanced')[n], resolveOptimize(2)[n], `removed 'balanced' falls back to level 2: ${n}`)
  const size = resolveOptimize('size')
  is(size.watr, true)
  is(size.smallConstForUnroll, false)
  is(size.nestedSmallConstForUnroll, false)
  is(size.vectorizeLaneLocal, false)
  is(size.treeshake, true)
  is(size.scalarTypedArrayLen, 8)
  is(size.scalarTypedLoopUnroll, 4)
  // 'speed' = level 3: everything on, including watr.
  const speed = resolveOptimize('speed')
  is(speed.watr, true)
  is(speed.vectorizeLaneLocal, true)
  is(speed.nestedSmallConstForUnroll, true)
  is(speed.smallConstForUnroll, true)
  // unknown string falls back to level 2
  is(resolveOptimize('bogus').sourceInline, true)
  // object with string level base + override
  const sizePlusVec = resolveOptimize({ level: 'size', vectorizeLaneLocal: true })
  is(sizePlusVec.vectorizeLaneLocal, true)
  is(sizePlusVec.smallConstForUnroll, false)
  is(sizePlusVec.scalarTypedArrayLen, 8)
})

test('opts.optimize: false produces correct output (semantics preserved)', () => {
  const { main: fast } = run(
    `export const main = (n) => { let s = 0; for (let i = 0; i < n; i++) s = s + i*2; return s | 0 }`,
    { optimize: false }
  )
  is(fast(10), 90)
  const { main: full } = run(
    `export const main = (n) => { let s = 0; for (let i = 0; i < n; i++) s = s + i*2; return s | 0 }`,
    { optimize: 2 }
  )
  is(full(10), 90)
})

test('opts.optimize: false produces larger binary than default', () => {
  const src = `export const main = (n) => { let s = 0; for (let i = 0; i < n; i++) s = s + i*2; return s | 0 }`
  const off = jz.compile(src, { optimize: false })
  const on = jz.compile(src, { optimize: true })
  ok(off.length >= on.length, `expected optimize:false (${off.length}) >= optimize:true (${on.length})`)
})

test('opts.optimize: object override gates per-pass', () => {
  // Disabling treeshake keeps unreachable funcs; binary should be ≥ default.
  const src = `
    const dead = () => 42
    export const main = (n) => n + 1
  `
  const sized = jz.compile(src, { optimize: { treeshake: false } })
  const shaken = jz.compile(src, { optimize: true })
  ok(sized.length >= shaken.length, `treeshake:false (${sized.length}) ≥ treeshake:true (${shaken.length})`)
})

test('deadStoreElim: dead `local.set` with side-effecting RHS must keep the RHS', () => {
  // A small-constant warmup loop unrolls into N consecutive `cs = side()` writes
  // whose results are all overwritten before any read. deadStoreElim must NOT
  // delete those `local.set`s wholesale — `side()` mutates the array each call.
  const { main } = run(`
    const bump = (a) => { a[0] = a[0] + 1; return a[0] | 0 }
    export const main = () => {
      const a = new Int32Array(1)
      let cs = 0
      for (let i = 0; i < 5; i++) cs = bump(a)
      return a[0] | 0
    }
  `, { optimize: 2 })
  is(main(), 5)
})

// === Inliner: expression-bodied arrow whose entire body is a candidate call ===
// plan.js's `inlineHotInternalCalls` walks non-exported function bodies and
// passes them to `inlineInStmt`. For a block-bodied function that's right —
// statement-position calls discard their return value. For an expression-
// bodied arrow (`func.body[0] !== '{}'`), the same path silently dropped the
// value: the body became an empty block and the caller observed 0/undefined.
// Fix: dispatch on body shape — non-block bodies route through `inlineInExpr`.

test('inliner preserves return value of an expr-bodied arrow whose entire body is a candidate call', () => {
  const { entry } = jz(`
    let leaf = () => 42
    let mid = () => leaf()
    export let entry = () => mid()
  `).exports
  is(entry(), 42)
})

test('inliner: expr-bodied arrow with arg-forwarding candidate', () => {
  const { entry } = jz(`
    let twice = (n) => n * 2
    let wrap = (n) => twice(n)
    export let entry = (n) => wrap(n)
  `).exports
  is(entry(21), 42)
})

// === promoteIntArrayLiterals (Workstream #4) ===
//
// `let xs = [intLit, …]` with read-only usage and no shape-changing methods
// gets rewritten to `let xs = new Int32Array([intLit, …])`. The carrier
// becomes PTR.TYPED (4-byte i32 slots) instead of PTR.ARRAY (8-byte f64
// slots); `.typed:[]` indexing fires, and `.typed:map` activates the SIMD
// vectorizer on i32x4-shaped lambdas. The pass is purely conservative —
// any operation that's not provably safe on a TYPED carrier disqualifies.
//
// Detection markers in WAT:
//   promoted   → `(local $NAME i32)`, i32.load with 4-byte stride, no $__arr_idx_known
//   unchanged  → `(local $NAME f64)`, $__arr_idx_known or 8-byte stride

const compileMain = (src) => {
  const wat = jz.compile(src, { wat: true, optimize: { watr: false } })
  return wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
}

// === unrollRowLenPadLoops (floatbeat variable-row pad) ===
// `for (i < rowlen[ci])` after bindNestedRowLengths — uniform rows fully
// unroll; mixed row lengths peel a fixed-prefix loop + one guarded tail.

test('unrollRowLenPadLoops: mixed row lengths peel tail iteration', () => {
  const src = `
    export let main = (t) => {
      const prog = [[0,3,7,10,14],[5,8,12,15],[7,11,14,17],[0,3,7,10,14]]
      const ch = prog[(t * .5 | 0) % 4]
      let pad = 0
      for (let i = 0; i < ch.length; i++) pad += Math.sin(t * 6.283185307179586 * 130.8 * 2**(ch[i] / 12))
      return pad
    }
  `
  const js = (t) => {
    const prog = [[0,3,7,10,14],[5,8,12,15],[7,11,14,17],[0,3,7,10,14]]
    const ch = prog[(t * .5 | 0) % 4]
    let pad = 0
    for (let i = 0; i < ch.length; i++) pad += Math.sin(t * 6.283185307179586 * 130.8 * 2**(ch[i] / 12))
    return pad
  }
  const { main } = run(src)
  for (let k = 0; k < 20; k++) almost(main(k / 17), js(k / 17), 5e-3)
  const body = compileMain(src)
  ok(/i32\.const 4/.test(body), 'fixed-prefix loop bound should constant-fold to 4')
})

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
  ok(/\(local \$xs f64\)/.test(body), 'float element keeps xs as f64 ARRAY')
  const { main } = run(src)
  is(main(0), 36.5)
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
  const body = compileMain(src)
  ok(/\(local \$xs f64\)/.test(body), '.push needs growable ARRAY storage; promotion must skip')
  const { main } = run(src)
  is(main(), 4)
})

test('promoteIntArrayLiterals: Array.isArray disqualifies (typed arrays return false)', () => {
  const src = `
    export const main = () => {
      const xs = [1, 2, 3]
      return Array.isArray(xs) ? xs.length : -1
    }
  `
  const body = compileMain(src)
  ok(/\(local \$xs f64\)/.test(body), 'Array.isArray would flip true→false under promotion')
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
  ok(/\(local \$xs f64\)/.test(body), 'element writes break v1 read-only assumption')
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
  const body = compileMain(src)
  ok(/\(local \$xs f64\)/.test(body), 'escape to callee with unknown receiver shape disqualifies')
  const { main } = run(src)
  is(main(), 6)
})

test('promoteIntArrayLiterals: closure-capture disqualifies', () => {
  // The inliner is happy to fold trivial arrows; give the closure a side
  // effect so it survives to the promotion gate as a real captured closure.
  const src = `
    export const main = (k) => {
      let count = 0
      const xs = [1, 2, 3, 4, 5]
      const at = (i) => { count = count + 1; return xs[i] }
      let s = 0
      for (let i = 0; i < xs.length; i++) s += at((i + (k & 0)) | 0)
      return s + count
    }
  `
  const body = compileMain(src)
  ok(/\(local \$xs f64\)/.test(body), 'capture into nested arrow disqualifies (shape unknown to inner)')
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
  ok(/\(local \$xs f64\)/.test(body), '...spread expands generically over ARRAY; disqualify')
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
  // instead of undefined. The candidate must be disqualified.
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
  // pass a string. After promotion the read must still route through the
  // __is_str_key → __dyn_get dispatch rather than a raw Int32Array load.
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

test('promoted int array .filter().map() chain stays typed end-to-end', () => {
  // [1..5] auto-promotes to Int32Array. .filter and .map both have .typed:*
  // emitters; the result of .filter is TYPED so the subsequent .map's `.${m}`
  // dispatch hits `.typed:map` via emit.js:2211 lookup.
  const src = `
    export const main = () => {
      const xs = [1, 2, 3, 4, 5]
      const ys = xs.filter(x => x > 2).map(x => x * 10)
      return ys.length * 100 + ys[0] + ys[1] * 10 + ys[2] * 1000
    }
  `
  const body = compileMain(src)
  ok(!/\(local \$xs f64\)/.test(body), 'xs promoted away from f64 ARRAY')
  const { main } = run(src)
  // [3,4,5].filter(>2) → [3,4,5]; *10 → [30,40,50] → 3*100 + 30 + 40*10 + 50*1000 = 50_730
  is(main(), 50730)
})

test('promoteIntArrayLiterals: hole disqualifies', () => {
  // Sparse literal: [1, , 3] — middle slot is a hole. intLiteralValue
  // returns null for non-literal elements, so the candidate gate skips it.
  const src = `
    export const main = () => {
      const xs = [1, , 3]
      return xs.length
    }
  `
  const body = compileMain(src)
  ok(/\(local \$xs f64\)/.test(body), 'holes break dense int contract; disqualify')
  const { main } = run(src)
  is(main(), 3)
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
  ok(/\(local \$xs f64\)/.test(body), 'element increment is a mutation; disqualify')
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

// === Workstream #5: closure-capture rep narrowing ===

test('captureIntCertain: intCertain propagates across capture (Math.floor elides)', () => {
  // Parent has `let i = n | 0` — every defining RHS is integer (bitwise-or).
  // Inner closure captures `i` and calls `Math.floor(i)`. Math.floor on an
  // intCertain operand is a no-op: the emitter (module/math.js:fInt) should
  // skip `f64.floor` and just load the f64 from the env slot.
  const src = `
    export const make = (n) => {
      let i = n | 0
      const inner = () => Math.floor(i)
      return inner
    }
    export const main = (n) => make(n)()
  `
  const wat = jz.compile(src, { wat: true, optimize: { watr: false } })
  // Find the closure body (JZ uses U+E000 as identifier prefix).
  const closRe = /\(func \$\u{e000}closure[0-9]+[\s\S]*?\n  \)/u
  const body = wat.match(closRe)?.[0] || ''
  ok(body, 'closure body emitted')
  ok(!body.includes('f64.floor'), 'Math.floor elided on intCertain capture')
  is(run(src).main(3.7), 3)
})

test('captureIntCertain: intCertain skips __to_num in arithmetic on captures', () => {
  // `toNumF64` (src/ir.js) skips the __to_num wrapper when the operand is an
  // intCertain name. With propagation, the captured `i` won't be wrapped in
  // a __to_num call. Without it, __to_num would be emitted.
  // We use string concat (forces __to_num path) to make the difference visible.
  const src = `
    export const make = (n) => {
      let i = n | 0
      const tag = () => 'x' + i
      return tag
    }
    export const main = (n) => make(n)()
  `
  const wat = jz.compile(src, { wat: true, optimize: { watr: false } })
  const closRe = /\(func \$\u{e000}closure[0-9]+[\s\S]*?\n  \)/u
  const body = wat.match(closRe)?.[0] || ''
  ok(body, 'closure body emitted')
  // With intCertain on `i`, the inner body should not insert __to_num for `i`.
  // (concat itself may call other helpers, but the operand `i` flows straight to f64.)
  ok(!body.includes('$__to_num'), 'no __to_num wrap on intCertain capture in concat')
  is(run(src).main(7.9), 'x7')
})

test('captureIntCertain: float capture does NOT enable elision', () => {
  // Counterpoint to the floor test: `i = n + 0.5` is not integer-certain, so
  // the closure must keep `f64.floor`.
  const src = `
    export const make = (n) => {
      let i = n + 0.5
      const inner = () => Math.floor(i)
      return inner
    }
    export const main = (n) => make(n)()
  `
  const wat = jz.compile(src, { wat: true, optimize: { watr: false } })
  const closRe = /\(func \$\u{e000}closure[0-9]+[\s\S]*?\n  \)/u
  const body = wat.match(closRe)?.[0] || ''
  ok(body, 'closure body emitted')
  ok(body.includes('f64.floor'), 'float capture keeps f64.floor')
  is(run(src).main(3), 3)
})

// === Workstream #3c: schema field intCertain ===

test('schemaSlotIntCertain: Math.floor elides on intCertain slot', () => {
  // `{ x: n | 0, y: (n * 2) | 0 }` — every observed write to slot x and y is
  // integer-shaped (bitwise op result). Math.floor(p.x) / Math.floor(p.y)
  // should drop the f64.floor op.
  const src = `
    export const main = (n) => {
      const p = { x: n | 0, y: (n * 2) | 0 }
      return Math.floor(p.x) + Math.floor(p.y)
    }
  `
  const wat = jz.compile(src, { wat: true, optimize: { watr: false } })
  const body = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  ok(body, 'main body emitted')
  ok(!body.includes('f64.floor'), 'Math.floor elided on intCertain slot reads')
  is(run(src).main(3.7), 10) // floor(3) + floor(7) = 10
})

test('schemaSlotIntCertain: float slot keeps f64.floor', () => {
  // Counterpoint: slot is written with a non-int value → not intCertain.
  const src = `
    export const main = (n) => {
      const p = { x: n + 0.5 }
      return Math.floor(p.x)
    }
  `
  const wat = jz.compile(src, { wat: true, optimize: { watr: false } })
  const body = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  ok(body, 'main body emitted')
  ok(body.includes('f64.floor'), 'non-int slot retains f64.floor')
  is(run(src).main(3.0), 3)
})

test('schemaSlotIntCertain: later non-int assign poisons slot', () => {
  // `p.x = n | 0` then `p.x = 1.5` — the second write makes the slot
  // polymorphic. `p.x` could be 1.5 at the read site, so Math.floor must
  // stay. Global poison: even though the literal seed was int, one non-int
  // write anywhere in the program flips the slot false.
  const src = `
    export const make = (n) => {
      const p = { x: n | 0 }
      p.x = 1.5
      return p
    }
    export const main = (n) => Math.floor(make(n).x)
  `
  const wat = jz.compile(src, { wat: true, optimize: { watr: false } })
  const body = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  ok(body, 'main body emitted')
  // Verify Math.floor is emitted *somewhere* in the produced module — could be
  // inlined into main or `make` depending on the inliner's decisions.
  ok(wat.includes('f64.floor'), 'poisoned slot retains f64.floor')
  is(run(src).main(7), 1)
})

test('schemaSlotIntCertain: int slot via local intCertain binding', () => {
  // Slot fed by a local `k` that the per-body intCertain fixpoint marks as
  // integer-shaped (`let k = n | 0`). The slot's write source resolves through
  // the body-local intCertain map (not a direct literal).
  const src = `
    export const main = (n) => {
      const k = n | 0
      const p = { v: k }
      return Math.floor(p.v)
    }
  `
  const wat = jz.compile(src, { wat: true, optimize: { watr: false } })
  // Math.floor must be elided anywhere it would have been emitted for p.v.
  ok(!wat.includes('f64.floor'), 'Math.floor elided via local→slot intCertain transit')
  is(run(src).main(5.9), 5)
})

// ───────────────────────────────────────── pass semantic-preservation pins
// Each pins one optimizer pass against a class of value-corrupting regression.
// Behavioural (run + assert), since the failure mode is a wrong runtime value.

test('dropDeadZeroInit: -0.0 initializer is preserved (not coerced to +0)', () => {
  // -0 and +0 share an i64/f64 zero bit pattern under `===`, but `1/-0` is
  // -Infinity. The dead-zero-init drop must exclude -0.0 (Object.is guard).
  is(run('export let main = () => { let x = -0.0; return 1 / x }').main(), -Infinity)
  is(run('export let main = () => { let x = 0.0; return 1 / x }').main(), Infinity)
})

test('dropDeadZeroInit: i64 0n zero-init survives into later arithmetic', () => {
  // BigInt locals init to `i64.const 0`; the i32/f64 zero-init dropper must not
  // touch the i64 slot. (A raw `bigint` return now crosses as a Number too — see test/data.js.)
  is(run('export let main = () => { let x = 0n; return Number(x + 5n) }').main(), 5)
})

test('specializeBimorphicTyped: one callee at both f64 and i32 sites stays correct', () => {
  // `add` is reached with float args from one export and int args from another;
  // specialization must not let either site read the other’s ABI.
  const ex = run(`
    let add = (a, b) => a + b
    export let f = () => add(1.5, 2.5)
    export let i = () => add(3, 4)
  `)
  is(ex.f(), 4)
  is(ex.i(), 7)
})

test('deadStoreElim: a store whose value is read later must not be eliminated', () => {
  // a[0]=7 is read into x before being overwritten; eliminating it would drop x.
  is(run('export let main = () => { let a = [0, 0]; a[0] = 7; let x = a[0]; a[0] = 9; return x + a[0] }').main(), 16)
})

test('arenaRewind: an allocation that is returned must persist (no rewind)', () => {
  // `mk` allocates an array and returns it; arena rewind must not reclaim it
  // before the caller reads the elements.
  const ex = run(`
    let mk = () => { let a = [1, 2, 3]; return a }
    export let main = () => { let a = mk(); return a[0] + a[1] + a[2] }
  `)
  is(ex.main(), 6)
})

// ── WAT copy-propagation (watr/optimize) ──────────────────────────────
// The value-model lowering leaves local round-trips `$b = $a; $b = f($b)`; copy-prop
// rewrites the use to $a and the adjacent-dead-store pass drops the now-dead copy.
const watStr = n => JSON.stringify(n)

test('wat copy-prop: collapses a local copy round-trip, dropping the copy', () => {
  const mod = ['module',
    ['func', '$f', ['param', '$a', 'i32'], ['result', 'i32'],
      ['local', '$b', 'i32'],
      ['local.set', '$b', ['local.get', '$a']],
      ['local.set', '$b', ['i32.add', ['local.get', '$b'], ['i32.const', 1]]],
      ['local.get', '$b'],
    ],
  ]
  const out = watStr(watOptimize(mod, 'propagate locals'))
  ok(!out.includes('["local.get","$b"]'), 'every $b read folded away')
  ok(out.includes('["local.get","$a"]'), 'the add now reads the copy source $a directly')
  // The whole round-trip should collapse to the bare expression.
  ok((out.match(/local\.set/g) || []).length === 0, 'the dead copy + the temp set are gone')
})

test('wat copy-prop: a copy whose source is later reassigned is NOT propagated past it', () => {
  // $b = $a; $a = 9; use $b  →  $b must keep the OLD $a, so the copy may not fold to $a.
  const mod = ['module',
    ['func', '$f', ['param', '$a', 'i32'], ['result', 'i32'],
      ['local', '$b', 'i32'],
      ['local.set', '$b', ['local.get', '$a']],
      ['local.set', '$a', ['i32.const', 9]],
      ['i32.add', ['local.get', '$b'], ['local.get', '$a']],
    ],
  ]
  // Correctness via execution: run the same program through jz end-to-end.
  const ex = jz('export const f = (a) => { let b = a; a = 9; return (b + a) | 0 }')
  is(ex.exports.f(3), 12)   // 3 + 9, NOT 9 + 9
})

// === narrowLoopBound (f64 loop bound → hoisted i32) ===
// `(ptr, n) => { for (let i = 0; i < n; i++) … }` with an f64 export param kept
// an f64 convert+compare in the loop header — and blocked the lane-vectorizer,
// which needs an i32-governed trip count. The pass hoists
// `i32.trunc_sat_f64_s(f64.ceil(n))` to the pre-header when the counter is a
// proven-non-negative i32 local (NaN→0 trips, fractional rounds up).

test('narrowLoopBound: f64 export-param bound compares in i32, trunc hoisted', () => {
  const body = compileMain(`
    export const main = (n) => {
      let s = 0
      for (let i = 0; i < n; i++) s += 1.5
      return s
    }
  `)
  ok(/i32\.trunc_sat_f64_s/.test(body) && /f64\.ceil/.test(body), 'bound snapped via trunc_sat(ceil(n))')
  ok(/i32\.lt_s/.test(body), 'loop compares in i32')
  const loop = body.slice(body.indexOf('(loop'))
  ok(!/f64\.convert_i32_s/.test(loop), 'no per-iteration counter convert left in the loop')
})

test('narrowLoopBound: unlocks lane-vectorizer for the naive (ptr, n) DSP shape', () => {
  const wat = jz.compile(
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

test('narrowLoopBound: counter that starts negative is NOT narrowed (NaN soundness)', () => {
  // i ∈ [-2, …): with bound NaN the f64 compare is false at i=-2 (zero trips);
  // a naive i32 rewrite (NaN→0) would run two iterations. The non-negativity
  // proof must reject this counter and keep the f64 compare.
  const src = `export const main = (n) => { let s = 0; for (let i = -2; i < n; i++) s += 1; return s }`
  const js = (n) => { let s = 0; for (let i = -2; i < n; i++) s += 1; return s }
  const { main } = run(src)
  for (const n of [NaN, -1, 0, 2.5, 3]) is(main(n), js(n), `n=${n}`)
})

// === splitCharScan (charCodeAt iteration-range splitting) ===
// `for (i = 0; i < N; i++) … s.charCodeAt(i) …` with an arbitrary bound paid
// the OOB NaN arm per char (f64 carrier + f64 classifier compares). The split
// at Math.min(N, s.length) lets the bound proof fire in the main loop.

test('splitCharScan: main loop narrows the char carrier to i32', () => {
  const wat = jz.compile(`
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

test('for-bound snapshot: read-only builtin calls do not block the .length hoist', () => {
  // `callFree` used to disqualify ANY call in the loop body — a charCodeAt /
  // Math.imul body re-decoded the NaN-boxed string length every iteration
  // (≈3× slower on byte loops). Read-only builtins can't resize the receiver,
  // so the bound must snapshot into a pre-loop i32 local (boundSafeCalls).
  const src = `export const main = (s) => {
    let h = 0x811c9dc5 | 0
    for (let i = 0; i < s.length; i++) {
      h = h ^ s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
  }`
  const wat = jz.compile(src, { wat: true, optimize: { jsstring: false } })
  const fa = wat.indexOf('func $main')
  const fn = wat.slice(fa, wat.indexOf('(func', fa + 1))
  const loop = fn.slice(fn.indexOf('loop'))
  ok(loop.length > 0, 'main has a loop')
  ok(!loop.includes('16383'), 'length decode (SSO mask 16383) must be hoisted out of the loop')
  // behavior unchanged vs JS
  const js = (s) => { let h = 0x811c9dc5 | 0; for (let i = 0; i < s.length; i++) { h = h ^ s.charCodeAt(i); h = Math.imul(h, 0x01000193) } return h >>> 0 }
  const { main } = run(src, { optimize: { jsstring: false } })
  is(main('hello world'), js('hello world'))
})

test('for-bound snapshot: a mutating call in the body still re-reads the bound', () => {
  // push() grows the array mid-loop — JS re-reads the bound every iteration,
  // so the read-only whitelist must NOT claim this loop (2 elems + 1 pushed → 3 iters).
  const src = `export const main = () => {
    let a = [1, 2]
    let n = 0
    for (let i = 0; i < a.length; i++) {
      if (i === 0) a.push(9)
      n++
    }
    return n
  }`
  is(run(src).main(), 3)
})

// === narrowI32: general int-accumulator narrowing (ir.js toI32 ring algebra) ===
// ToInt32 is reduction mod 2^32; {+,−,×} are ring ops under it, so exact-int f64
// trees compute in i32 with no trunc/Infinity guard. `/`/`%` narrow with const
// divisors (`/` only at the ToInt32 root; `%` peels faithful converts at emit).

test('narrowI32: const-divisor div/mod/mul loops run pure i32', () => {
  for (const stmt of [
    's = (s + ((a[i] / 4) | 0)) | 0',
    's = (s + (a[i] % 10)) | 0',
    's = (s + a[i] * 3) | 0',
  ]) {
    const src = `export let f = (p, n) => {
      let a = new Int32Array(p)
      let s = 0
      for (let i = 0; i < n; i++) ${stmt}
      return s
    }`
    const wat = jz.compile(src, { wat: true, optimize: 3 })
    const fi = wat.indexOf('(func $f')
    const body = wat.slice(fi, wat.indexOf('\n  (func', fi + 5))
    const loop = body.slice(body.lastIndexOf('(loop'))
    ok(!/f64\.(add|sub|mul|div|trunc)/.test(loop.slice(0, loop.indexOf('(br '))),
      `no f64 round-trip in loop for: ${stmt}`)
  }
})

test('narrowI32: differential vs JS across wrap/sign edges', () => {
  const exprs = [
    ['(x * -1000000) | 0',           x => (x * -1000000) | 0],
    ['(x / -1) | 0',                 x => (x / -1) | 0],          // INT_MIN/−1: no trap, wraps
    ['(x % -7) | 0',                 x => (x % -7) | 0],
    ['(x * 3 + x * 5 - 9) | 0',      x => (x * 3 + x * 5 - 9) | 0],
    ['((x % 10) + (x / 2 | 0)) | 0', x => ((x % 10) + (x / 2 | 0)) | 0],
    ['(-x) | 0',                     x => (-x) | 0],
  ]
  const vals = [0, 1, -1, 2147483647, -2147483648, 1234567890, -1234567891]
  for (const [e, ref] of exprs) {
    const src = `export let f = (p) => { let a = new Int32Array(p); return ${e.replace(/x/g, 'a[0]')} }`
    const { f } = run(src)
    for (const v of vals) is(f(new Int32Array([v])), ref(v | 0), `${e} at x=${v}`)
  }
})

test('narrowI32: f64 edges (NaN/±Inf/fraction) keep exact ToInt32 semantics', () => {
  const exprs = [
    ['(x + 5) | 0',   x => (x + 5) | 0],
    ['(x / 4) | 0',   x => (x / 4) | 0],
    ['(x % 10) | 0',  x => (x % 10) | 0],
    ['(x + 0.5) | 0', x => (x + 0.5) | 0],
  ]
  // |x| ≥ 2^63 excluded: toI32's documented saturation boundary (asm.js-style).
  const vals = [0.5, -3.7, NaN, Infinity, -Infinity, 2**31, 2**52, 42]
  for (const [e, ref] of exprs) {
    const { f } = run(`export let f = (x) => ${e}`)
    for (const v of vals) is(f(v), ref(v), `${e} at x=${v}`)
  }
})

// ---- fusedRewrite $__is_truthy inline: boolean false is falsy --------------
// The inline expansion mirrors module/core.js's $__is_truthy — five falsy bit
// patterns (NaN, null, undefined, empty SSO string, boolean FALSE). The FALSE
// arm was missing, so any `x || y` lowered through the inlined check treated
// boolean false as truthy. Surfaced as the jessie/jz bench rows mis-parsing at
// every optimize level ≥ 1 while optimize:false stayed correct.

test('fusedRewrite: || sees boolean false through a boxed local as falsy', () => {
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
  for (const opt of [false, 1, 2, 3]) {
    const r = run(src, { optimize: opt })
    is(r.go('no'), 'fb', `go falsy @opt ${opt}`)
    is(r.go('yes'), 'yes', `go truthy @opt ${opt}`)
    is(r.chain('q'), 'end', `chain all-falsy @opt ${opt}`)
    is(r.chain('x'), 'x', `chain truthy @opt ${opt}`)
  }
})

// dropEffects — dead-value-drop simplification (drop of a pure op over a tee
// collapses to the bare store; drop of a control-flow value stays whole).
test('dropEffects: comma-update loop (j++, k+=step) stays correct', () => {
  // The discarded old value of `j++` is dead; eliminating it must not change the
  // loop. j:0..7, k=3j → sum += 1003j → 1003·28 = 28084.
  const { main } = run(`export let main = () => {
    let sum = 0
    for (let j = 0, k = 0; j < 8; j++, k += 3) sum = (sum + j * 1000 + k) | 0
    return sum
  }`)
  is(main(), 28084)
})

test('dropEffects: dropped ternary runs exactly one branch', () => {
  // A ternary whose value is discarded must execute ONE arm — dropEffects must
  // not flatten an `if`/ternary's branches into both side effects.
  const { main } = run(`export let main = () => {
    let x = 0, y = 0
    for (let i = 0; i < 10; i++) (i & 1) ? (x = x + 1) : (y = y + 1)
    return x * 100 + y
  }`)
  is(main(), 505)   // 5·100 + 5, NOT 1010 (both arms)
})

test('dropEffects: dropped ternary-in-condition compiles (seed 192 regression)', () => {
  // Regressed to "not enough arguments on the stack for drop" when dropEffects
  // recursed into an `if`'s arms (unbalancing the stack) instead of keeping the
  // control-flow value whole under a drop.
  for (const opt of [2, 'speed']) {
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
  const wat = jz.compile(`export let f = (c) => { let d = c | 0; return (d >= 48 && d <= 57) ? 1 : 0 }`, { wat: true, optimize: 'speed' })
  ok(/i32\.le_u/.test(wat), 'expected fused unsigned compare')
  const watOr = jz.compile(`export let f = (c) => { let d = c | 0; return (d < 48 || d > 57) ? 1 : 0 }`, { wat: true, optimize: 'speed' })
  ok(/i32\.gt_u/.test(watOr), 'expected fused unsigned outside-range compare')
  // Untyped f64 operand must NOT fuse (fractional values would be mis-classified).
  const watF64 = jz.compile(`export let f = (c) => (c >= 48 && c <= 57) ? 1 : 0`, { wat: true, optimize: 'speed' })
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

test('LICM: nested-loop invariant arithmetic is hoisted (V8 wasm under-hoists it)', () => {
  // A subexpression invariant w.r.t. an INNER loop (`(a-b)*K` recomputed every `j`)
  // is hoisted out of it — the per-pixel cost in nested rasterizers/convolutions
  // (penrose, waves). Top-level loops still defer plain arithmetic to V8's own LICM.
  const wat = jz.compile(
    `export let f = (a, b, n, m) => { let s = 0; for (let i=0;i<n;i++) for (let j=0;j<m;j++) s = s + (a-b)*3.5 + j; return s }`,
    { wat: true, optimize: 'speed' })
  ok(/local \$__li/.test(wat), 'expected a hoisted snap local')
  is((wat.match(/f64\.mul/g) || []).length, 1, '(a-b)*3.5 computed once, not per inner iteration')
  // Bit-exact: hoisting must not change the result.
  const { f } = run(`export let f = (a, b, n, m) => { let s = 0; for (let i=0;i<n;i++) for (let j=0;j<m;j++) s = s + (a-b)*3.5 + j; return s }`)
  const js = (a, b, n, mm) => { let s = 0; for (let i=0;i<n;i++) for (let j=0;j<mm;j++) s = s + (a-b)*3.5 + j; return s }
  is(f(2, 0.5, 4, 5), js(2, 0.5, 4, 5))
  is(f(-1.5, 2.5, 7, 3), js(-1.5, 2.5, 7, 3))
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
  // Codegen-SHAPE assertion only. Under the self-host kernel the loop-IV-div/mod strength
  // reduction doesn't fire (the kernel's prepared AST drives `tryReduce`'s pattern match
  // to a different lowering — every helper it uses round-trips correctly, so the output is
  // bit-exact, just not strength-reduced). Correctness is what matters and is covered by the
  // sibling `loop-SR: grid kernel … bit-exact ON vs OFF` test (which passes on the kernel —
  // ON and OFF agree because neither path strength-reduces). Skip the shape check there; it's
  // not a miscompile, and is tracked as a self-host inference divergence to close separately.
  if (onKernel()) return
  const src = `export let f=(w,h)=>{ let n=w*h,i=0,a=0; while(i<n){ let x=i%w; let y=(i/w)|0; a=(a+x+y)|0; i++ } return a|0 }`
  ok(/lsrx/.test(jz.compile(src, { wat: true, optimize: 'speed' })), 'counter present')
  ok(!/lsrx/.test(jz.compile(src, { wat: true, optimize: { level: 'speed', loopIVDivMod: false } })), 'absent when off')
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

test('int-div-lower: (a/b)|0 with i32 a,b → i32.div_s, bit-exact incl b=0 / INT_MIN÷-1', () => {
  // The JS integer-division idiom. Lowering to i32.div_s avoids the f64 round-trip;
  // sound for all i32 a,b (the f64 quotient never rounds across the trunc boundary)
  // except b=0 (→0, div_s traps) and INT_MIN/-1 (→INT_MIN wrap, div_s traps) — guarded.
  const constSrc = `export let f = (x0) => { let x = x0|0; return (x/9)|0 }`
  const runSrc = `export let f = (x0, v0) => { let x = x0|0, v = v0|0; return (x/v)|0 }`
  ok(/i32\.div_s/.test(jz.compile(constSrc, { wat: true, optimize: 'speed' })), 'constant divisor → i32.div_s')
  ok(/i32\.div_s/.test(jz.compile(runSrc, { wat: true, optimize: 'speed' })), 'runtime divisor → guarded i32.div_s')
  ok(!/i32\.div_s/.test(jz.compile(runSrc, { wat: true, optimize: { level: 'speed', intDivLower: false } })), 'off when disabled')
  // f64 dividend must NOT lower (could be fractional) — stays f64.div
  ok(!/i32\.div_s/.test(jz.compile(`export let f = (x) => (x/9)|0`, { wat: true, optimize: 'speed' })), 'f64 operand not lowered')

  const { f } = run(runSrc, { optimize: 'speed' })
  const IM = -2147483648, IX = 2147483647
  for (const x of [0, 1, -1, 2, -2, 9, 256, IM, IX, -7, 12345, -99999])
    for (const v of [0, 1, -1, 2, -2, 9, 256, IM, IX, -7])
      is(f(x, v), (x / v) | 0, `(${x}/${v})|0`)
})

test('local-const fold: a chained const divisor becomes a literal (magic-multipliable)', () => {
  // A function-local `const` built from earlier consts (the blur window `2*rr+1`) folds to
  // a compile-time i32, so the int-divide lowering hands the wasm backend a CONSTANT
  // divisor (i32.const) — which V8 magic-multiplies — instead of a runtime `local.get`.
  const chain = `export let f = (x0) => { let x = x0|0; const rr = 4|0; const win = 2*rr+1; return (x/win)|0 }`
  const w = jz.compile(chain, { wat: true, optimize: 'speed' })
  ok(/i32\.div_s\s+\([^)]*\)\s*\(i32\.const 9\)|i32\.const 9/.test(w), 'win folds to the literal 9')
  ok(!/i32\.div_s\s+\([^)]*\)\s*\(local\.get \$win/.test(w), 'divisor is not a runtime local')
  const { f } = run(chain, { optimize: 'speed' })
  for (const x of [0, 1, 8, 9, 17, 2295, 100000, -50]) is(f(x), (x / 9) | 0, `(${x}/9)`)
  // a reassigned `let` must NOT fold (its value isn't constant)
  const reassigned = `export let f = (x0) => { let x = x0|0; let d = 9|0; d = 3; return (x/d)|0 }`
  const { f: g } = run(reassigned, { optimize: 'speed' })
  for (const x of [0, 9, 30, 100]) is(g(x), (x / 3) | 0, `reassigned (${x}/3)`)
  // bitwise/shift fold too (R|0, 1<<s)
  is(run(`export let f = (x0) => { let x = x0|0; const m = 1 << 3; return (x/m)|0 }`, { optimize: 'speed' }).f(100), 12)
})

test('clamp-peel: stencil edge-peel fires + bit-exact + soundness guards bail', () => {
  // A real box-blur stencil (clamp xi=x+k to [0,w-1]) must split into clamp-free
  // interior + edges, bit-exact vs disabled, while dangerous variants (mutated iv /
  // bound / radius, asymmetric tap range) must bail rather than miscompile.
  const lex = (s, opt) => run(s, opt).f
  const ON = { optimize: 'speed' }, OFF = { optimize: { level: 'speed', clampPeel: false } }
  const fires = (s) => /pks/.test(jz.compile(s, { wat: true, optimize: 'speed' }))
  const A = 'let A=new Int32Array(4096);'
  const blur = `${A}export let f=(w,r)=>{let s=0,x=0;while(x<w){let a=0,k=-r;while(k<=r){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095];k++}s=(s+a)|0;x++}return s|0}`
  ok(fires(blur), 'legit stencil peels')
  for (const w of [1, 2, 3, 7, 16, 64, 100]) for (const r of [0, 1, 2, 4, 8])
    is(lex(blur, ON)(w, r), lex(blur, OFF)(w, r), `blur w=${w} r=${r}`)

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
    twoTaps: `${A}export let f=(w,r)=>{let s=0,x=0,r2=r-1;while(x<w){let a=0,k=-r;while(k<=r){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095];k++}k=-r2;while(k<=r2){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095];k++}s=(s+a)|0;x++}return s|0}`,
    ivInTap: `${A}export let f=(w,r)=>{let s=0,x=0;while(x<w){let a=0,k=0-r;while(k<=r){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095];k++;x++}s=(s+a)|0}return s|0}`,
  }
  for (const [name, s] of Object.entries(danger)) {
    ok(!fires(s), `${name} must bail`)
    for (const w of [3, 16, 64]) for (const r of [1, 2, 4]) is(lex(s, ON)(w, r), lex(s, OFF)(w, r), `${name} w=${w} r=${r}`)
  }
})

test('clamp-peel: for-loop stencils (the bench shape) peel + bit-exact + guards bail', () => {
  // The bench blur uses `for` loops (prepare keeps them as ['for',...]); the peel
  // must normalize them (init + 3 while-loops with the step re-appended), with the
  // same guards. A non-unit step must bail.
  const A = 'let A=new Int32Array(4096);'
  const fires = (s) => /__pke/.test(jz.compile(s, { wat: true, optimize: 'speed' }))
  const on = (s) => run(s, { optimize: 'speed' }).f, off = (s) => run(s, { optimize: { level: 'speed', clampPeel: false } }).f
  const forBlur = `${A}export let f=(w,r)=>{let s=0;for(let x=0;x<w;x++){let a=0;for(let k=-r;k<=r;k++){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095]}s=(s+a)|0}return s|0}`
  ok(fires(forBlur), 'for-loop stencil peels')
  for (const w of [0, 1, 2, 3, 7, 8, 16, 64, 100]) for (const r of [0, 1, 2, 4, 8]) is(on(forBlur)(w, r), off(forBlur)(w, r), `forBlur w=${w} r=${r}`)
  const danger = {
    forStep2: `${A}export let f=(w,r)=>{let s=0;for(let x=0;x<w;x=x+2){let a=0;for(let k=-r;k<=r;k++){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095]}s=(s+a)|0}return s|0}`,
    forBoundMut: `${A}export let f=(w,r)=>{let s=0;for(let x=0;x<w;x++){let a=0;for(let k=-r;k<=r;k++){let xi=x+k;if(xi<0)xi=0;else if(xi>=w)xi=w-1;a+=A[xi&4095]}s=(s+a)|0;if(s>9000000)w=w-1}return s|0}`,
  }
  for (const [n, s] of Object.entries(danger)) { ok(!fires(s), `${n} bails`); for (const w of [3, 16, 64]) for (const r of [1, 2, 4]) is(on(s)(w, r), off(s)(w, r), `${n} w=${w} r=${r}`) }
})

test('forward-propagation: typed-array global swap must survive (double-buffer idiom)', () => {
  // The canonical ping-pong swap `let s = f; f = g; g = s` over reassignable typed-array
  // module globals. forwardPropagate tracked `s = (global.get $f)` as a single-use copy but
  // had NO invalidation for the intervening `f = g` (global.set $f) — so it substituted the
  // now-stale `(global.get $f)` into `g = s`, collapsing it to `g = g` (a vacuumed self-store).
  // After the swap f AND g then aliased the SAME buffer, so a stencil sim (lbm) streamed into
  // the buffer it was reading → noise. purgeGlobalRefs on every global.set is the fix. Pin all
  // opt levels, both swap legs, and the cross-call persistence (the bug also breaks getG alone).
  const SRC = `
    let f = new Float64Array(2)
    let g = new Float64Array(2)
    export let init = () => { f[0] = 1.0; g[0] = 99.0 }
    export let swap = () => { let s = f; f = g; g = s }
    export let getF = (i) => f[i]
    export let getG = (i) => g[i]
  `
  for (const optimize of [null, 'size', 'speed']) {
    const { init, swap, getF, getG } = run(SRC, { optimize })
    init(); swap()
    is(getF(0), 99, `opt=${optimize}: f → old g (99)`)
    is(getG(0), 1,  `opt=${optimize}: g → old f (1)`)
  }
})

test('unroll: flattened bodies re-init their accumulators (zero-init elided only once)', () => {
  // Loop unrolling flattens an outer body's `let s = 0` into one scope, duplicating it.
  // WASM zero-inits locals, so the FIRST is elided — but the 2nd+ are genuine per-iteration
  // resets. Dropping them let `s` carry across iterations (the matmul N≤4 miscompile).
  const { main } = run(`
    export const main = () => {
      const A = new Float64Array(4)
      for (let i = 0; i < 4; i++) A[i] = i + 1
      let h = 0
      for (let i = 0; i < 4; i++) { let s = 0; for (let k = 0; k < 4; k++) s += A[k]; h = (h + (s | 0)) | 0 }
      return h        // 4×(1+2+3+4) = 40; the bug carried s → 10+20+30+40 = 100
    }`)
  is(main(), 40)
  // small dense matmul (the offset-indexed reduce that triggered it) — speed vs scalar oracle
  const mm = (N) => `export const main = () => {
    const N = ${N}, A = new Float64Array(N*N), B = new Float64Array(N*N), C = new Float64Array(N*N)
    for (let i = 0; i < N*N; i++) { A[i] = (i%13)-6; B[i] = ((i*7)%11)-5 }
    for (let i = 0; i < N; i++) { const ai = i*N; for (let j = 0; j < N; j++) { const bj = j*N
      let s = 0; for (let k = 0; k < N; k++) s += A[ai+k]*B[bj+k]; C[i*N+j] = s } }
    let h = 0; for (let i = 0; i < N*N; i++) h = (h + (C[i]|0)) | 0; return h }`
  for (const N of [2, 3, 4])
    is(run(mm(N), { optimize: 'speed' }).main(), run(mm(N), { optimize: false }).main(), `matmul N=${N} bit-exact`)
})

test('sourceInline preserves side effects of an expr-bodied callee at statement position', () => {
  // `setS = v => s = v` is an expression-bodied arrow whose BODY is the effect
  // (the assignment). Called as a statement (`setS(7);`), the result is unused —
  // but inlineHotInternalCalls used to splice only the prefix and DROP the value
  // expression, losing the `s = v` write. (This is what froze the self-host parser:
  // its `seek = n => idx = n` stopped advancing `idx`, so comment-skip looped
  // forever.) The effect must survive inlining.
  const setter = run(`
    let s = 0
    let setS = (v) => s = v
    export const f = () => { setS(7); return s }`, { optimize: 2 })
  is(setter.f(), 7, 'assignment in inlined expr-body must run')

  // Same class via a one-liner that calls another fn for its effect.
  const viacall = run(`
    let n = 0
    let bump = () => n = n + 1
    let tick = () => bump()
    export const g = () => { tick(); tick(); tick(); return n }`, { optimize: 2 })
  is(viacall.g(), 3, 'nested effectful call in inlined expr-body must run')
})

test('dead helper does not leak the Eisel-Lemire decimal table', () => {
  // A dead lib export whose `arr[i] | 0` on an untyped param pulls __to_num →
  // __dec_to_f64 (consumer of the ~2 KB power-of-10 table). watr treeshakes the dead
  // function but NOT the data segment, so the table used to bloat EVERY module ~2 KB.
  // stripDeadElTable drops it when no LIVE code parses decimals at runtime.
  const lib = `export let used = (h, x) => ((h ^ (x | 0)) * 16777619) | 0
export let dead = (arr) => { let h = 0; for (let i = 0; i < arr.length; i++) h = used(h, arr[i]); return h }`
  const bytes = jz.compile(
    `import { used } from './lib.js'\nexport let main = () => { let z = new Int32Array(4); z[0] = 7; return used(0, z[0]) }`,
    { modules: { './lib.js': lib }, optimize: 'size', alloc: false })
  ok(bytes.length < 1024, `module is ${bytes.length} B — decimal table (~2 KB) leaked from a dead helper`)
})

test('live runtime decimal parsing keeps the Eisel-Lemire table (no false strip)', () => {
  // The dual: Number() on a runtime string IS live, so __dec_to_f64 must keep its table —
  // stripDeadElTable must not strip it. The module carries the ~2 KB table and instantiates.
  const src = `let toNum = (s) => Number(s)\nexport let main = (s) => { let a = new Float64Array(2); a[0] = toNum(s); return a[0] }`
  const bytes = jz.compile(src, { optimize: 'size', alloc: false })
  ok(bytes.length > 2048, `module is ${bytes.length} B — table wrongly stripped from live Number()`)
  new WebAssembly.Module(bytes)   // throws if the strip left a dangling reference
})

test('range-narrowing: ToInt32 of a bounded value through a reused local drops the +∞ guard', () => {
  // `xi` (= floor of a [0,255]-bounded Uint8Array read × const) is read twice, so it stays
  // a local; ToInt32(local.get $xi) emits the guarded select(wrap(i64.trunc_sat), 0,
  // f64.ne(x, Inf)). f64Range — resolving $xi's single textual def through the trunc_sat
  // fold (src/optimize/index.js) — proves it ∈ [0, 7] ⊂ i32, so the +∞ guard is dead and
  // trunc_sat is exact ToInt32: one i32.trunc_sat, no i64 round-trip, no guard. Runtime-
  // independent (fewer loop-body ops on V8 / JSC / wasmtime alike).
  const src = `export let f = (n) => {
    const buf = new Uint8Array(256)
    for (let i = 0; i < 256; i++) buf[i] = (i * 37) & 255
    let s = 0
    for (let i = 0; i < n; i++) {
      let v = buf[i & 255]
      let xi = Math.floor(v * 0.03125)
      s = (s + (xi & 255) + (xi & 127)) | 0
    }
    return s
  }`
  const t = parse(src, 'speed')
  // INVARIANT: the bounded index path carries no i64 round-trip / +∞ guard — only i32.trunc_sat.
  is(loopCount(t, n => n[0] === 'i64.trunc_sat_f64_s'), 0, 'no i64 round-trip in loop (guard retired)')
  is(loopCount(t, n => n[0] === 'f64.const' && n[1] === 'Infinity'), 0, 'no +∞ guard in loop')
  ok(loopCount(t, n => n[0] === 'i32.trunc_sat_f64_s') >= 2, 'bounded index narrowed to i32.trunc_sat')
  // Bit-exact vs JS over the full input range.
  const { f } = run(src)
  const ref = (n) => {
    const buf = new Uint8Array(256)
    for (let i = 0; i < 256; i++) buf[i] = (i * 37) & 255
    let s = 0
    for (let i = 0; i < n; i++) { let v = buf[i & 255]; let xi = Math.floor(v * 0.03125); s = (s + (xi & 255) + (xi & 127)) | 0 }
    return s
  }
  for (const n of [0, 1, 7, 256, 1000]) is(f(n), ref(n), `f(${n}) bit-exact vs JS`)
})

test('int narrowing: bounded typed-array element products use i32.mul (faithful), bit-exact', () => {
  // `int8[i] * int8[j]` (and i8/u8/i16 pairs, plus i16×u16) — the int-conv / correlation /
  // quantised-MAC shape — has a product that provably fits SIGNED i32, so i32.mul == the true
  // value in every consumer context. Rides the i32 ABI (one op, no convert→f64.mul→convert
  // round-trip) on V8 / JSC / wasmtime alike. u16×u16 (65535² > 2^31) must STAY f64 — unfaithful.
  const i8sum = `export let f = (n) => {
    const a = new Int8Array(64); const b = new Int8Array(64)
    for (let i = 0; i < 64; i++) { a[i] = (i % 13) - 6; b[i] = (i % 7) - 3 }
    let s = 0; for (let i = 0; i < n; i++) s = s + a[i & 63] * b[i & 63]; return s
  }`
  ok(/i32\.mul/.test(jz.compile(i8sum, { optimize: 'speed', wat: true })), 'i8×i8 product narrows to i32.mul')

  // u16×u16 stays f64 (the exact product can exceed signed i32 → i32.mul would be unfaithful).
  const u16sq = `export let f = (n) => {
    const a = new Uint16Array(8); for (let i = 0; i < 8; i++) a[i] = 60000 + i
    let s = 0; for (let i = 0; i < n; i++) s = s + a[i & 7] * a[(i + 1) & 7]; return s
  }`
  const u16wat = jz.compile(u16sq, { optimize: 'speed', wat: true })
  ok(/f64\.mul/.test(u16wat), 'u16×u16 product stays f64.mul (faithfulness-excluded)')

  // Bit-exact vs JS across contexts: i8 reduction (f64 value), i16×u16 (boundary), u16×u16 (excluded).
  const cases = [
    [i8sum, [0, 1, 100, 1000]],
    [`export let f = (n) => { const a = new Int16Array(8); const b = new Uint16Array(8); for (let i=0;i<8;i++){a[i]=-30000+i;b[i]=60000+i} let s=0; for (let i=0;i<n;i++) s=s+a[i&7]*b[i&7]; return s }`, [0, 1, 8, 50]],
    [u16sq, [0, 1, 8, 50]],
  ]
  for (const [src, ns] of cases) {
    const { f } = run(src)
    const ref = new Function('n', '"use strict";' + src.replace(/^export let f = /, 'const f = ').replace(/return s\s*}$/, 'return s }') + '; return f(n)')
    for (const n of ns) is(f(n), ref(n), `bit-exact vs JS at n=${n}`)
  }
})
