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
import { optimizeFunc, resolveOptimize, PASS_NAMES } from '../src/optimize.js'
import { run } from './util.js'

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
  // LICM should hoist the cell load and emit a $__sc snap local.
  // `inc` must *escape* (passed to `keep`) so it stays a real closure that
  // mutates the captured `i` via a heap cell — otherwise inlineLocalLambdas
  // would splice it away and `i` would just be a plain wasm local.
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
  `, { wat: true })
  ok(/\$__sc\d+/.test(wat), 'expected hoisted snap local')
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
  ok(!/\$__sc\d+/.test(wat), 'must not hoist when loop contains a call')
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

test('escape analysis: returned object still heap allocates', () => {
  const wat = jz.compile(`
    export const main = (x) => {
      const obj = { a: x }
      return obj
    }
  `, { wat: true })
  ok(/\(call \$__alloc_hdr\b/.test(wat), 'returned object must remain materialized')
})

test('escape analysis: call-passed object still heap allocates', () => {
  const wat = jz.compile(`
    const get = (obj) => obj.a
    export const main = (x) => {
      const obj = { a: x }
      return get(obj)
    }
  `, { wat: true })
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
  const wat = jz.compile(`
    export const main = (o) => {
      return o.a + o.b + o.c
    }
  `, { wat: true })
  ok(/\(call \$__dyn_get_any_t\b/.test(wat))
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
  const wat = jz.compile(src, { wat: true })
  ok(/\(loop\b/.test(wat), 'outer nested loops should not fully unroll')
  const { main } = run(src)
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
  const wat = jz.compile(src, { wat: true })
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
  ok(/\$__alloc_hdr\b/.test(wat), 'escaping integer typed array must stay heap-allocated')
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
  const wat = jz.compile(`
    export const main = () => {
      const a = [1, 2, 3, 4]
      const b = a.map(x => x + 1)
      const c = b.filter(x => x > 2)
      return c.length + c[0]
    }
  `, { wat: true, optimize: { watr: false } })
  const mainBody = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  ok(!/\(call \$__len\b/.test(mainBody), 'known ARRAY map/filter should size from the resolved header length')
  const { main } = run(`
    export const main = () => {
      const a = [1, 2, 3, 4]
      const b = a.map(x => x + 1)
      const c = b.filter(x => x > 2)
      return c.length * 10 + c[0]
    }
  `)
  is(main(), 33)
})

test('known array numeric index skips generic array tag dispatch', () => {
  const wat = jz.compile(`
    export const main = (a) => {
      if (Array.isArray(a)) return a[0]
      return 0
    }
  `, { wat: true, optimize: { watr: false } })
  const mainBody = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] || ''
  ok(/\(call \$__arr_idx_known\b/.test(mainBody), 'known ARRAY numeric index should use monomorphic helper')
  ok(!/\(call \$__arr_idx\b/.test(mainBody), 'known ARRAY numeric index should skip generic tag-dispatch helper')
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
  ok(/\(call \$__arr_idx_known\b/.test(copyBody), 'known ARRAY spread should read via monomorphic array helper')
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
  const wat = jz.compile(src, { wat: true })
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
  const wat = jz.compile(`
    export const main = (s) => {
      let n = 0
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c >= 48 && c <= 57) n = n * 10 + (c - 48)
      }
      return n | 0
    }
  `, { wat: true })
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

test('resolveOptimize: levels, booleans, object overrides', () => {
  const level2 = resolveOptimize(true)
  const allOff = resolveOptimize(false)
  for (const n of PASS_NAMES) {
    is(level2[n], resolveOptimize(2)[n], `level true: ${n} matches level 2`)
    is(allOff[n], false, `level false: ${n} off`)
  }
  is(resolveOptimize(0).watr, false)
  is(resolveOptimize(0).treeshake, false)
  is(resolveOptimize(2).watr, false)
  is(resolveOptimize(2).sourceInline, true)
  is(resolveOptimize(2).nestedSmallConstForUnroll, 'auto')
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
  is(resolveOptimize(undefined).watr, false)
  is(resolveOptimize(undefined).sourceInline, true)
  is(resolveOptimize(undefined).nestedSmallConstForUnroll, 'auto')
  // string aliases
  const balanced = resolveOptimize('balanced')
  for (const n of PASS_NAMES) is(balanced[n], resolveOptimize(2)[n], `'balanced': ${n} matches level 2`)
  const size = resolveOptimize('size')
  is(size.watr, false)
  is(size.smallConstForUnroll, false)
  is(size.nestedSmallConstForUnroll, false)
  is(size.vectorizeLaneLocal, false)
  is(size.treeshake, true)
  is(size.scalarTypedArrayLen, 8)
  is(size.scalarTypedLoopUnroll, 4)
  const speed = resolveOptimize('speed')
  is(speed.watr, false)
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
