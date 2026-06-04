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
import { optimizeFunc, resolveOptimize, PASS_NAMES, csePureExprLoop } from '../src/optimize/index.js'
import { optimize as watOptimize } from '../src/wat/optimize.js'
import { run } from './util.js'
import { belowOpt, onWasi } from './_matrix.js'

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
  const wat = jz.compile(`
    const get = (obj) => obj.a
    export const main = (x) => {
      const obj = { a: x }
      return get(obj)
    }
  `, { wat: true, optimize: { watr: false } })
  ok(/\(call \$__alloc_hdr\b/.test(wat), 'call-passed object must remain materialized')
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
  // Either plain `call` or TCO'd `return_call` is fine — both invoke the
  // monomorphic helper. tcoTailRewrite may promote tail-position calls
  // inside the `if` arm to `return_call`.
  ok(/\((?:return_)?call \$__arr_idx_known\b/.test(mainBody), 'known ARRAY numeric index should use monomorphic helper')
  ok(!/\((?:return_)?call \$__arr_idx\b(?!_known)/.test(mainBody), 'known ARRAY numeric index should skip generic tag-dispatch helper')
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
      const x = new Float64Array(64)
      const state = new Float64Array(4)
      const out = new Float64Array(64)
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
  // string aliases
  const balanced = resolveOptimize('balanced')
  for (const n of PASS_NAMES) is(balanced[n], resolveOptimize(2)[n], `'balanced': ${n} matches level 2`)
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

// ── WAT copy-propagation (src/wat/optimize.js) ──────────────────────────────
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
