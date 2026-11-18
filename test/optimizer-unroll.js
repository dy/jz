// Loop unrolling (constant counts, recursion, unrollTrips, serial chains, spliced
// kernels) and the scalar replacement of the fixed typed arrays it exposes.
import test from 'tst'
import { almost, is, ok, throws } from 'tst/assert.js'
import { onKernel, levels, belowOpt, ownedLevels } from './_matrix.js'
import parseWat from 'watr/parse'
import { compileJzAt } from '../bench/_lib/compile.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import encodeWat from 'watr/compile'
import { splitLoopPrivateScratch } from '../src/optimize/licm.js'
import { unrollTrips } from '../src/optimize/unroll-trips.js'
import { funcWat, run, oracle, jz, compile } from './util.js'
import { parse, loopCount, count, walk } from '../scripts/wat-probe.mjs'
import { findFunc } from './_optimizer.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('recursionUnroll: non-zero acc init fuses as += (shared-acc reset bug)', () => {
  // watr's count(): `let s = 1; for(..) s += cnt(n[i]); return s`.
  const src = `
    const cnt = (n) => { if (!Array.isArray(n)) return 1; let s = 1; for (let i = 0; i < n.length; i++) s += cnt(n[i]); return s }
    const sum = (n) => { if (!Array.isArray(n)) return n; let s = 0; for (let i = 0; i < n.length; i++) s += sum(n[i]); return s }
    export let f = (d) => cnt(['op', ['a', 'b'], ['c', 1], d ? [['x'], 'y'] : 'z'])
    export let g = () => sum([1, [2, 3], [4, [5, 6]]])`
  for (const optimize of levels(false, 2, 3, 'speed')) {
    const { f, g } = jz(src, { optimize }).exports
    is(Number(f(0)), 9, `cnt flat tail optimize:${JSON.stringify(optimize)}`)
    is(Number(f(1)), 12, `cnt nested tail optimize:${JSON.stringify(optimize)}`)
    is(Number(g()), 21, `zero-init acc stays exact optimize:${JSON.stringify(optimize)}`)
  }
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
  const wat = compile(src, { wat: true })
  ok(!/\(loop\b/.test(wat), 'expected small constant loop to unroll')
  const { main } = run(src)
  is(main(), 30)
})

test('small const-count for-loop respects optimize:false', () => {
  const wat = compile(`
    export const main = () => {
      let acc = 0
      for (let s = 0; s < 4; s++) acc += s
      return acc | 0
    }
  `, { wat: true, optimize: false })
  ok(/\(loop\b/.test(wat), 'optimize:false should not unroll')
})

test('small const-count for-loop does not unroll with break', () => {
  const wat = compile(`
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
  const wat = compile(src, { wat: true, optimize: 2 })
  ok(/\(loop\b/.test(wat), 'outer nested loops should not fully unroll')
  const { main } = run(src, { optimize: 2 })
  is(main(), 288)
})

test('nested small const-count typed-array loops auto-unroll', () => {
  const wat = compile(`
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

test('unrolled scalar scratch keeps per-copy SSA and hoists invariant compounds', () => {
  if (belowOpt(3) || onKernel()) return
  // Any small typed-index loop nested in a larger loop has this shape: each
  // unrolled copy defines scalar scratch from invariant table entries, then a
  // varying expression consumes it.
  const src = `
    const kernel = (out, x, y, rr, n) => {
      for (let p = 0; p < n; p++) {
        let sum = 0.0
        for (let s = 0; s < 2; s++) {
          const ox = -x[s], oy = -y[s]
          const c = ox * ox + oy * oy - rr[s] * rr[s]
          const b = ox * p + oy
          sum += b * b - c
        }
        out[p] = sum
      }
    }
    export let main = (n) => {
      const out = new Float64Array(64), x = new Float64Array(2)
      const y = new Float64Array(2), rr = new Float64Array(2)
      x[0] = 1.25; x[1] = 2.5; y[0] = 3.5; y[1] = 4.75
      rr[0] = 0.5; rr[1] = 0.75
      kernel(out, x, y, rr, n)
      return out[(n - 1) & 63]
    }`
  const opts = { level: 'speed', watr: false, sourceInline: false, versionTypedBounds: false }
  const onTree = parse(src, { ...opts, splitScratch: true })
  const offTree = parse(src, { ...opts, splitScratch: false })
  const muls = tree => loopCount(findFunc(tree, '$kernel'), n => n[0] === 'f64.mul')
  ok(muls(onTree) < muls(offTree), 'invariant per-copy products leave the outer loop')

  const on = jz(src, { optimize: { ...opts, splitScratch: true } }).exports.main
  const off = jz(src, { optimize: { ...opts, splitScratch: false } }).exports.main
  for (const n of [0, 1, 7, 64]) is(on(n), off(n), `SSA-LICM on===off at n=${n}`)
})

test('a small typed-index loop unrolls around a closure that writes a binding of its body', () => {
  if (onKernel()) return
  // The unroller names each copy's block-scoped bindings anew so the per-copy
  // scratch stays single-def (splitScratch).
  const src = `
    class Ctx {
      #ls
      constructor() { this.#ls = [] }
      on(f) { this.#ls.push(f) }
      make() { const buf = { len: 4, data: new Float64Array(4) }; for (let i = 0; i < 4; i++) buf.data[i] = i * 0.5; return buf }
      go() { const buf = this.make(); const ls = this.#ls; for (let i = 0; i < ls.length; i++) ls[i]({ buf }) }
    }
    const render = () => {
      const ctx = new Ctx()
      let out = null
      ctx.on((e) => { out = e.buf })
      ctx.go()
      return out
    }
    const sum = (b) => { let h = 0; for (let i = 0; i < b.len; i++) h += b.data[i]; return h }
    const run = () => {
      let out
      const samples = new Float64Array(3)
      for (let i = 0; i < 3; i++) { out = render(); samples[i] = i }
      return sum(out) + samples[2]
    }
    export let main = () => run()`
  is(jz(src, { optimize: { level: 'speed' } }).exports.main(), 5, 'the copy reads what the closure wrote')
})

test('unrolled scalar scratch includes lowered temporaries without changing their lifetime', () => {
  if (onKernel()) return
  const scratch = '$\uE000ul0'
  const cases = [
    ['invariant', '(local.set $tmp (i32.add (local.get $x) (i32.const 1)))', '', true],
    ['loop-carried', '(local.set $tmp (i32.add (local.get $tmp) (local.get $x)))', '', false],
    ['conditional', '(if (i32.eqz (local.get $i)) (then (local.set $tmp (local.get $x))))', '', false],
    ['live after loop', '(local.set $tmp (local.get $x))', '(local.get $tmp)', false],
    ['may trap', '(local.set $tmp (i32.div_s (i32.const 12) (local.get $x)))', '', false],
    // (the flat form a multi-value result unpacks into: the value is pushed before the set)
    ['flat set', '(local.get $x) (local.set $tmp)', '', false]
  ]
  for (const [name, init, afterLoop, moves] of cases) {
    const source = `(module (func $f (export "f") (param $n i32) (param $x i32) (result i32)
      (local $i i32) (local $tmp i32) (local ${scratch} i32) (local $out i32)
      (block $done (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
        ${init}
        (local.set ${scratch} (i32.mul (local.get $tmp) (local.get $tmp)))
        (local.set $out (i32.add (local.get $out) (local.get ${scratch})))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
      ${afterLoop ? `(i32.add (local.get $out) ${afterLoop})` : '(local.get $out)'}))`
    const ast = parseWat(source), fn = findFunc(ast, '$f')
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports.f
    splitLoopPrivateScratch(fn)
    is(loopCount(fn, n => n[0] === 'i32.mul'), moves ? 0 : 1, name)
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports.f
    // Repeated and changing calls, including a zero-work call whose unused
    // division would trap if it were moved outside the loop.
    for (const [n, x] of [[0, 0], [1, 3], [1, 3], [4, -2], [0, 3], [3, 1]])
      is(after(n, x), before(n, x), `${name}: n=${n}, x=${x}`)
    if (name === 'may trap') throws(() => after(1, 0), WebAssembly.RuntimeError)
  }
})

test('unrolled scalar scratch moves each invariant definition, as SSA would', () => {
  if (onKernel()) return
  // A def moves out of the loop where its value is invariant read at the versions before it,
  // whatever the name's other defs are: an unrolled sum's invariant prefix (`s = 0; s = s +
  // x * x`) moves and the def after a varying one stays. A name defined under a test or in an
  // inner loop, or read after the loop, keeps every def where it is.
  const S = '$ul0'
  const get = n => `(local.get ${n})`, set = (n, v) => `(local.set ${n} ${v})`
  const cases = [
    ['invariant, then varying, then a read', 0, [set(S, `(i32.mul ${get('$x')} ${get('$x')})`), set(S, `(i32.add ${get(S)} ${get('$i')})`),
      set('$out', `(i32.add ${get('$out')} ${get(S)})`)]],
    ['a read between two defs', 1, [set(S, `(i32.mul ${get('$x')} ${get('$x')})`), set('$out', `(i32.add ${get('$out')} ${get(S)})`),
      set(S, `(i32.mul ${get(S)} ${get('$i')})`), set('$out', `(i32.xor ${get('$out')} ${get(S)})`)]],
    ['an invariant def after a varying one', 1, [set(S, `(i32.add ${get('$i')} (i32.const 7))`), set('$out', `(i32.add ${get('$out')} ${get(S)})`),
      set(S, `(i32.mul ${get('$x')} ${get('$x')})`), set('$out', `(i32.add ${get('$out')} ${get(S)})`),
      set(S, `(i32.add ${get(S)} ${get('$i')})`), set(S, `(i32.mul ${get(S)} ${get(S)})`), set('$out', `(i32.xor ${get('$out')} ${get(S)})`)]],
    ['a def under a test', 1, [set(S, `(i32.mul ${get('$x')} ${get('$x')})`), `(if ${get('$i')} (then ${set(S, `(i32.add ${get(S)} (i32.const 1))`)}))`,
      set('$out', `(i32.add ${get('$out')} ${get(S)})`)]],
    ['a def in an inner loop', 1, [set(S, `(i32.mul ${get('$x')} ${get('$x')})`), set('$j', '(i32.const 0)'),
      `(block $in (loop $inner (br_if $in (i32.ge_s ${get('$j')} ${get('$i')})) ${set(S, `(i32.add ${get(S)} ${get('$j')})`)} ${set('$j', `(i32.add ${get('$j')} (i32.const 1))`)} (br $inner)))`,
      set('$out', `(i32.add ${get('$out')} ${get(S)})`)]],
    ['a name read after the loop', 1, [set(S, `(i32.mul ${get('$x')} ${get('$x')})`), set('$out', `(i32.add ${get('$out')} ${get(S)})`)], get(S)],
  ]
  for (const [name, stays, body, afterLoop] of cases) {
    const source = `(module (func $f (export "f") (param $n i32) (param $x i32) (result i32)
      (local $i i32) (local $j i32) (local ${S} i32) (local $out i32)
      (block $done (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
        ${body.join('\n        ')}
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
      ${afterLoop ? `(i32.add (local.get $out) ${afterLoop})` : '(local.get $out)'}))`
    const ast = parseWat(source), fn = findFunc(ast, '$f')
    const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports.f
    splitLoopPrivateScratch(fn)
    is(loopCount(fn, n => n[0] === 'i32.mul'), stays, `${name}: ${stays} of its products stay in the loop`)
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports.f
    for (const [n, x] of [[0, 0], [0, 5], [1, 3], [4, -2], [5, 65537], [3, 1]])
      is(after(n, x), before(n, x), `${name}: n=${n}, x=${x}`)
  }
  // The sum's `0 + x` moves with the add kept: x = -0 gives +0, as before.
  const ast = parseWat(`(module (func $f (export "f") (param $n i32) (param $a f64) (result f64)
    (local $i i32) (local ${S} f64) (local $out f64)
    (local.set $out (f64.const 7))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      ${set(S, '(f64.const 0)')} ${set(S, `(f64.add ${get(S)} (f64.mul ${get('$a')} (f64.const 2)))`)} ${set('$out', get(S))}
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (local.get $out)))`), fn = findFunc(ast, '$f')
  splitLoopPrivateScratch(fn)
  is(loopCount(fn, n => n[0] === 'f64.add' || n[0] === 'f64.mul'), 0, 'the invariant sum leaves the loop')
  is(count(fn, n => n[0] === 'f64.add'), 1, 'its add is kept')
  const f = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports.f
  for (const [n, a, want] of [[1, -0, 0], [2, -0, 0], [0, -0, 7], [1, -3, -6], [1, NaN, NaN]]) ok(Object.is(f(n, a), want), `0 + (${a} * 2) over ${n} rounds`)
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
  const wat = compile(src, { wat: true, optimize: { watr: false, sourceInline: false } })
  const mainWat = wat.match(/\(func \$main[\s\S]*?^  \)/m)?.[0] || ''
  ok(!/\$__alloc\b/.test(mainWat), 'local fixed Float64Array should not allocate')
  ok(!/f64\.(?:load|store)\b/.test(mainWat), 'local fixed Float64Array slots should stay in locals')
  is(run(src).main(), 8)
})

test('scalar typed stores preserve assignment results and convert compound writes', () => {
  for (const Ctor of ['Float64Array', 'Float32Array', 'Int32Array', 'Uint8Array']) {
    for (const expression of ['a[0]=value', 'a[0]+=value', 'a[0]||=value']) {
      const src = `export function main(mode){let calls=0;const a=new ${Ctor}(1);
        const value=mode===0?'4':mode===1?null:mode===2?undefined:mode===3?-0:mode===4?1.00000001:
          mode===5?4294967297:mode===6?{valueOf(){calls++;return 3}}:{valueOf(){calls++;throw 7}};
        try{const result=(${expression});return[typeof result,result===value,typeof result==='object'?'object':result,a[0],calls]}
        catch(e){return['error',e,a[0],calls]}}`
      const js = oracle(src).main
      for (const optimize of levels(0,1,2,3,'size')) {
        const f = run(src, {optimize}).main
        for (const mode of [0,0,1,2,3,4,5,6,7,0]) is(f(mode),js(mode), `${Ctor} ${expression}, O${optimize}, mode=${mode}`)
      }
    }
  }
  // Discarded compound writes still convert concatenation to the stored number.
  const src = `export function main(mode){const a=new Float64Array(1);const v=mode?'4':2;
    a[0]+=v; a[0]+=v; return[a[0],typeof a[0]]}`
  const js = oracle(src).main
  for (const optimize of levels(0,1,2,3,'size')) {
    const f=run(src,{optimize}).main
    for (const mode of [0,0,1,0,1]) is(f(mode),js(mode), `discarded +=, O${optimize}, mode=${mode}`)
  }
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
  const wat = compile(src, { wat: true, optimize: { watr: false, sourceInline: false } })
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
  const wat = compile(src, { wat: true, optimize: { watr: false } })
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

  // At the speed/relaxedFloat tier the OUTER-loop-invariant partial products are hoisted
  // out of the n-loop (rust/LLVM's mat4-prologue trick — only a[0],a[5],b[0],b[5] mutate,
  // so most of each a[r]·b[c] dot is constant across iterations). Each unrolled dot then
  // has < DOT_UNROLL accumulate steps, so it stays scalar instead of f64x2 — measured ~1.9×
  // faster than the pack/extract SIMD form, beating rust-wasm. The reassociation (invariant
  // terms summed first) is ULP-level, so it is gated to speed; the level-2 path above keeps
  // the bit-exact f64x2 dot pairs.
  // (The partials' local is a name of the split after it: the products the n-loop keeps are counted, 23 without the hoist.)
  const speedWat = compile(src, { wat: true, optimize: { level: 'speed', watr: false, coalesceLocals: false } })
  const products = wat => loopCount(findFunc(parseWat(wat), '$main'), n => n[0] === 'f64.mul')
  is(products(speedWat), 9, 'speed tier hoists loop-invariant dot partials out of the n-loop')
  // (a precision trade, not an engine feature: an engine without relaxed SIMD keeps it)
  is(products(compile(src, { wat: true, optimize: { level: 'speed', watr: false, coalesceLocals: false, relaxedSimd: false } })), 9, 'relaxedSimd:false keeps the hoist')
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
  const wat = compile(src, { wat: true, optimize: { watr: false, sourceInline: false } })
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
  // (static placement, test/static-locals.js, would make it a static block: the heap path is pinned here)
  const wat = compile(src, { wat: true, optimize: { watr: false, sourceInline: false, staticLocals: false } })
  ok(/\$__alloc_hdr_n\b/.test(wat), 'escaping integer typed array must stay heap-allocated')
  is(run(src).main(), 6)
})

test('nested small const-count for-loop unroll is opt-in', () => {
  const wat = compile(`
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
// The unroller's size gate reads the body after the integer narrowing: nqueens' `avail`
// is a Number with its conversions before it (112 nodes against the gate of 110; 90 after).
test('recursion unroll: the size gate reads the narrowed body', () => {
  // The specimen as the harness compiles it: the solver's arguments come from the
  // kernel's Int32Array of sizes, so its parameters are words and the unroll is due.
  const wat = compileJzAt({ id: 'nqueens', js: join(ROOT, 'bench/nqueens/nqueens.js') }, { level: 'speed' }, (code, opts) => compile(code, { ...opts, wat: true }))
  ok(/_ru2/.test(wat), 'two levels of the call are unrolled into the solver')
})

// An innermost loop of 4 to 16 iterations known at compile time is its body written out once per
// iteration at speed: V8 writes out only loops of fewer than four, and otherwise keeps the exit
// test and the counter's step on every copy.
test('unrollTrips: a loop of 4 to 16 known iterations is written out at speed', () => {
  const src = `export let f = (n) => {
    const src = new Uint8Array(256), out = new Int32Array(256)
    for (let i = 0; i < 256; i++) src[i] = (i * 37 + 11) & 255
    const r = 4
    let t = 0
    for (let x = 0; x < n; x++) {
      let s = 0
      for (let k = -r; k <= r; k++) s += src[(x + k) & 255]
      let w = 0
      for (let k = 0; k < 17; k++) w += src[(x * 3 + k) & 255]
      out[x & 255] = (s / 9) | 0
      t += out[x & 255] + w
    }
    return t
  }`
  const host = oracle(src).f
  for (const optimize of ownedLevels('speed', 2, 'size')) { const f = run(src, { optimize }).f; for (const n of [0, 1, 7, 300]) is(f(n), host(n), `O${optimize} n=${n}`) }
  if (onKernel()) return
  const f = parseWat(compile(src, { wat: true, optimize: 'speed' })).find(n => Array.isArray(n) && n[0] === 'func' && n[1] === '$f')
  let loads = 0, loops = 0
  walk(f, n => {
    if (n[0] === 'i32.load8_u') loads++
    if (n[0] === 'loop' && !JSON.stringify(n.slice(2)).includes('"loop"') && JSON.stringify(n).includes('i32.load8_u')) loops++
  })
  ok(loads >= 9, `the nine taps read their bytes in a row (${loads} byte reads)`)
  ok(loops >= 1, 'the loop of seventeen stays a loop')
})

// The loops `unrollTrips` writes out, and the ones it leaves: four to sixteen trips by the wasm
// words' arithmetic, a counter stepped once by a literal and set on the straight path in, no
// other branch to the head, at most 300 instructions written out (LLVM's -O3 full-unroll bar).
test('unrollTrips: which loops it writes out', () => {
  const g = n => ['local.get', n], c = v => ['i32.const', String(v)], set = (n, v) => ['local.set', n, v]
  const step = (n, s) => set(n, ['i32.add', g(n), c(s)])
  const work = set('$s', ['i32.add', g('$s'), ['i32.load8_u', ['i32.add', g('$p'), g('$k')]]])
  const fn = (...body) => ['module', ['func', '$f', ['param', '$p', 'i32'], ['local', '$k', 'i32'], ['local', '$s', 'i32'], ['local', '$n', 'i32'], ...body]]
  const top = (k0, cmp, hi, s = 1, body = [work]) => fn(set('$k', c(k0)), ['block', '$b', ['loop', '$l', ['br_if', '$b', [cmp, g('$k'), c(hi)]], ...body, step('$k', s), ['br', '$l']]])
  const loops = m => JSON.stringify(m).split('"loop"').length - 1
  const reads = m => JSON.stringify(m).split('"i32.load8_u"').length - 1
  const nine = unrollTrips(top(-4, 'i32.gt_s', 4))
  is([loops(nine), reads(nine)], [0, 9], 'k from -4 through 4: nine copies')
  is(loops(unrollTrips(top(0, 'i32.ge_s', 3))), 1, 'three trips: V8 writes those out itself')
  is(loops(unrollTrips(top(0, 'i32.ge_s', 16))), 0, 'sixteen trips')
  is(loops(unrollTrips(top(0, 'i32.ge_s', 17))), 1, 'seventeen trips stay a loop')
  is(loops(unrollTrips(top(0, 'i32.ge_s', 20, 2))), 0, 'a step of two: ten trips')
  is(loops(unrollTrips(top(2147483644, 'i32.lt_s', 0))), 0, 'a counter that wraps: four trips to the negative words')
  is(loops(unrollTrips(top(-4, 'i32.gt_s', 4, 1, Array(6).fill(work)))), 1, 'nine copies of six statements pass 300 instructions')
  is(loops(unrollTrips(top(-4, 'i32.gt_s', 4, 1, [['br_if', '$l', g('$s')], work]))), 1, 'a branch to the head stays')
  is(loops(unrollTrips(top(-4, 'i32.gt_s', 4, 1, [['br_if', '$b', g('$s')], work]))), 1, 'a break stays')
  is(loops(unrollTrips(top(-4, 'i32.gt_s', 4, 1, [['if', g('$s'), ['then', set('$s', c(0))]], work]))), 1, 'a choice in the body stays: its branch would stand in every copy')
  is(loops(unrollTrips(top(-4, 'i32.gt_s', 4, 1, [work, ['if', g('$s'), ['then', set('$k', c(0))]]]))), 1, 'a counter written elsewhere stays')
  is(loops(unrollTrips(fn(['block', '$b', ['loop', '$l', ['br_if', '$b', ['i32.gt_s', g('$p'), c(4)]], work, step('$p', 1), ['br', '$l']]]))), 1, 'a counter from a parameter stays')
  is(loops(unrollTrips(fn(set('$k', c(0)), ['loop', '$o', ['block', '$b', ['loop', '$l', ['br_if', '$b', ['i32.ge_s', g('$k'), c(8)]], work, step('$k', 1), ['br', '$l']]], ['br_if', '$o', g('$s')]]))), 2,
    'a counter set above an enclosing loop stays: another iteration\'s value arrives')
  const counted = ['block', '$b', ['loop', '$l', ['br_if', '$b', ['i32.ge_s', g('$k'), c(8)]], work, step('$k', 1), ['br', '$l']]]
  is(loops(unrollTrips(fn(['if', g('$p'), ['then', set('$k', c(0))], ['else', structuredClone(counted)]]))), 1, 'a counter set in the then arm is unknown in the else arm')
  is(loops(unrollTrips(fn(set('$k', c(0)), ['if', g('$p'), ['then', ['nop']], ['else', structuredClone(counted)]]))), 0, 'one set before the choice reaches either arm')
  // the rotated form, stepped in its test against a bound a local holds, a labelled block in the body
  const rot = unrollTrips(fn(set('$n', ['i32.add', ['i32.sub', c(4), ['local.tee', '$k', c(-4)]], c(1)]), set('$k', c(0)),
    ['block', '$b', ['br_if', '$b', ['i32.ge_s', g('$k'), g('$n')]], ['loop', '$l', ['block', '$x', work],
      ['br_if', '$l', ['i32.lt_s', ['local.tee', '$k', ['i32.add', g('$k'), c(1)]], g('$n')]]]]))
  is([loops(rot), reads(rot)], [0, 9], 'a bottom test against a local bound of nine: nine copies')
  is(new Set(JSON.stringify(rot).match(/\$x_u\d+/g)).size, 9, 'each copy names its block afresh')
  is(JSON.stringify(rot).split('"$k"').length - 1, 2 + 2 + 9 * 3, 'each copy keeps the step the test made')
  // the counter set in the guard's test (watr sinks a counter's first set into its first read): the
  // way into the loop is the one the guard did not take, past the set
  const guarded = (k0) => fn(set('$n', c(9)), ['block', '$b', ['br_if', '$b', ['i32.ge_s', k0, g('$n')]], ['loop', '$l', work,
    ['br_if', '$l', ['i32.lt_s', ['local.tee', '$k', ['i32.add', g('$k'), c(1)]], g('$n')]]]])
  is(loops(unrollTrips(guarded(['local.tee', '$k', c(0)]))), 0, 'a counter the guard\'s test sets: nine copies')
  is(loops(unrollTrips(guarded(['local.tee', '$k', ['if', ['result', 'i32'], g('$p'), ['then', c(0)], ['else', c(1)]]]))), 1, 'one it sets from a choice stays')
})

test('unroll: flattened bodies re-init their accumulators (zero-init elided only once)', () => {
  // Loop unrolling flattens an outer body's `let s = 0` into one scope, duplicating it. WASM
  // zero-inits locals, so the FIRST is elided — but the 2nd+ are genuine per-iteration
  // resets.
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

test('small strided outer control loop specializes nested typed kernels', () => {
  const src = `const pass=(a,out)=>{for(let shift=0;shift<32;shift+=8){for(let i=0;i<16;i++)out[i]=(a[i]>>>shift)&255}}
    export let f=()=>{const a=new Uint32Array(16),out=new Uint32Array(16);a[0]=0x12345678;pass(a,out);return out[0]}`
  // the arrays' heap path: static placement folds their bases into the byte loads' offsets
  const wat = compile(src, { wat: true, optimize: { level: 'speed', watr: false, staticLocals: false } })
  const pw = wat.split('(func $pass')[1]?.split('(func ')[0] || ''
  ok(!/local\.get \$shift/.test(pw), 'outer induction is fully specialized')
  // each variant fixes its byte: a constant shift, or the byte's own load (narrowByteLoads)
  ok((pw.match(/i32\.shr_u|i32\.load8_u offset=[123]\b/g) || []).length >= 3, 'four radix/lane variants remain as constant shifts')
  is(run(src, { optimize: 'speed' }).f(), 0x12, 'last specialized pass stays exact')
})

test('serial-chain unroll: crc-class loop pairs iterations, values exact', () => {
  // Address-carried scalar chain (`crc = table[(crc ^ buf[i]) & 255] ^ ...`)
  // is non-vectorizable, so the speed tier pairs iterations (×2 + tail) to
  // halve loop overhead. Values must be exact for even AND odd trip counts
  // (the tail iteration), and the paired body shows two chained lookups per
  // backedge.
  const src = `
const mkTable = () => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c | 0
  }
  return t
}
export let crc = (len) => {
  const table = mkTable()
  const buf = new Uint8Array(len)
  for (let i = 0; i < len; i++) buf[i] = (i * 37 + 11) & 0xff
  let c = -1
  for (let i = 0; i < len; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) | 0
}`
  const jsExports = oracle(src)
  for (const optimize of levels(0, 2, 'speed'))
    for (const n of [0, 1, 63, 64])
      is(run(src, { optimize }).crc(n), jsExports.crc(n), `O${optimize} n=${n}: crc exact (tail + pair arms)`)
  // Structural: at speed, the paired main loop carries TWO chained table
  // lookups between backedges (the ×2 unroll fired).
  const wat = compile(src, { wat: true, optimize: 'speed' })
  const hot = wat.split('(func ').sort((a, b) =>
    (b.match(/i32\.xor/g) || []).length - (a.match(/i32\.xor/g) || []).length)[0] || ''
  const loops = hot.split('(loop')
  const paired = loops.some(l => {
    const seg = l.split('(loop')[0]
    return (seg.match(/i32\.load\b/g) || []).length >= 2 && (seg.match(/i32\.xor/g) || []).length >= 4
  })
  ok(paired, 'a loop body carries two chained table lookups (×2 unroll engaged)')
})

test('an unrolled strided kernel spliced through a closure takes its canonical counted form', () => {
  // stdlib's ddot shape (an offset helper, a remainder loop, a main loop
  // unrolled by a module constant) spliced into a closure that is itself
  // spliced: the fresh names are summarized before the counted-loop rewrite
  // reads them, so the main loop rerolls and its reduction vectorizes.
  if (onKernel()) return
  const src = `function offset(N, stride) {
      if (stride > 0) return 0
      return (1 - N) * stride
    }
    var M = 5
    function dot(N, x, sx, ox, y, sy, oy) {
      var s = 0, ix = ox, iy = oy, m, i
      if (N <= 0) return s
      if (sx === 1 && sy === 1) {
        m = N % M
        if (m > 0) for (i = 0; i < m; i++) { s += x[ix] * y[iy]; ix += 1; iy += 1 }
        if (N < M) return s
        for (i = m; i < N; i += M) { s += x[ix] * y[iy] + x[ix + 1] * y[iy + 1] + x[ix + 2] * y[iy + 2] + x[ix + 3] * y[iy + 3] + x[ix + 4] * y[iy + 4]; ix += M; iy += M }
        return s
      }
      for (i = 0; i < N; i++) { s += x[ix] * y[iy]; ix += sx; iy += sy }
      return s
    }
    function dot2(N, x, sx, y, sy) {
      if (N <= 0) return 0
      return dot(N, x, sx, offset(N, sx), y, sy, offset(N, sy))
    }
    export let main = (n) => {
      const x = new Float64Array(n), y = new Float64Array(n)
      for (let i = 0; i < n; i++) { x[i] = i % 7; y[i] = (n - i) % 5 }
      const out = new Float64Array(64)
      const sweep = () => { for (let i = 0; i < 64; i++) out[i] = dot2(n - (i & 7), x, 1, y, 1) }
      sweep(); sweep()
      let t = 0
      for (let i = 0; i < 64; i++) t += out[i]
      return t
    }`
  const wat = compile(src, { wat: true, optimize: { level: 'speed' } })
  ok((wat.match(/\(loop \$__simd_loop/g) || []).length >= 2, 'the main loops vectorize, not only a remainder loop')
  is(jz(src, { optimize: { level: 'speed' } }).exports.main(1000), oracle(src).main(1000))
})

test('an unrolled float sum keeps its grouping where floats are JavaScript\'s', () => {
  // `s += t0 + t1 + t2 + t3 + t4` rolled to `s += t` adds `(s + t0) + t1`… where the source
  // added `s + ((((t0 + t1) + t2) + t3) + t4)`: another rounding, the lanes' reordering alone
  // (relaxedFloat). Rolled at level 2, stdlib's ddot answered other than JavaScript.
  if (onKernel()) return
  const src = `var M = 5
    function dot(N, x, y) {
      var s = 0, ix = 0, iy = 0, m = N % M, i
      for (i = 0; i < m; i++) { s += x[ix] * y[iy]; ix += 1; iy += 1 }
      for (i = m; i < N; i += M) { s += x[ix] * y[iy] + x[ix + 1] * y[iy + 1] + x[ix + 2] * y[iy + 2] + x[ix + 3] * y[iy + 3] + x[ix + 4] * y[iy + 4]; ix += M; iy += M }
      return s
    }
    export let main = (n) => {
      const x = new Float64Array(n), y = new Float64Array(n)
      for (let i = 0; i < n; i++) { x[i] = (i * 0.37) % 7.3 - 3.1; y[i] = 1 / (i + 1.5) - (i % 11) * 0.013 }
      return dot(n, x, y)
    }`
  const host = oracle(src)
  for (const optimize of ownedLevels(2, { level: 'speed', relaxedFloat: false })) {
    const m = jz(src, { optimize }).exports
    for (const n of [7, 20, 1000, 1023]) is(m.main(n), host.main(n), `${JSON.stringify(optimize)}: main(${n}) bit for bit`)
  }
})

test('a neighborhood walk over literals unrolls like a count from zero', () => {
  // `for (g = -1; g <= 1; g++)` (a 3×3 stencil, a cell's neighbors) counts
  // three trips: each copy reads its literal, negative or not, and the loop
  // and its counter are gone.
  if (onKernel()) return
  const src = `export let f = (a, i) => { let s = 0; for (let g = -1; g <= 1; g++) s += a[(i + g) & 7] * g; return s }`
  const wat = funcWat(compile(src, { wat: true, optimize: { level: 'speed' } }), 'f')
  ok(!/\(loop/.test(wat), 'the walk unrolls')
  const a = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8])
  for (const level of ownedLevels(0, 2, 'speed')) is(jz(src, { optimize: { level } }).exports.f(a, 3), 2, `O${level}`)
})
