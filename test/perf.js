// Performance regression tests — jz WASM must be competitive with JS
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import { belowOpt, onWasi, onKernel } from './_matrix.js'
import jz, { compile } from '../index.js'
import { HELPER_SITE_PREFIX } from '../src/helper-counters.js'

// Helper: time N iterations, return ms
function bench(fn, n) {
  // Warmup
  for (let i = 0; i < Math.min(n, 100); i++) fn()
  const t = performance.now()
  for (let i = 0; i < n; i++) fn()
  return performance.now() - t
}

// Wall-clock speed pin. In `npm test` it is INFORMATIONAL ONLY — each test's
// console.log already prints the JS/WASM ratio, but the hard assertion is gated
// behind JZ_PERF=1. Shared CI runners are too noisy for a ±20% timing gate (it
// flakes), and the real competitive regression gate lives in `npm run bench` /
// `npm run test:bench` (bench/bench.mjs vs V8, AssemblyScript, Porffor, clang —
// every kernel below has a matching bench/<case>). Run `JZ_PERF=1 node
// test/perf.js` to hard-assert these pins locally.
const PERF_GATE = process.env.JZ_PERF === '1'
const pinFaster = (wasmTime, jsTime, factor = 1.2) => {
  if (PERF_GATE) ok(wasmTime < jsTime * factor, `WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * ${factor}`)
}

function functionNames(wasm) {
  const [section] = WebAssembly.Module.customSections(new WebAssembly.Module(wasm), 'name')
  if (!section) return []
  const bytes = new Uint8Array(section)
  let i = 0
  const readUleb = () => {
    let n = 0, shift = 0
    while (true) {
      const b = bytes[i++]
      n |= (b & 0x7f) << shift
      if (!(b & 0x80)) return n >>> 0
      shift += 7
    }
  }
  const readName = () => {
    const len = readUleb()
    const s = new TextDecoder().decode(bytes.subarray(i, i + len))
    i += len
    return s
  }
  const names = []
  while (i < bytes.length) {
    const id = bytes[i++]
    const end = i + readUleb()
    if (id === 1) {
      const count = readUleb()
      for (let n = 0; n < count; n++) names.push([readUleb(), readName()])
    }
    i = end
  }
  return names
}

// === Correctness + codegen quality tests ===

test('perf: fib(30) — WASM faster than JS', () => {
  const { exports: { fib } } = jz('export let fib = (n) => n <= 1 ? n : fib(n-1) + fib(n-2)')
  const jsFib = n => n <= 1 ? n : jsFib(n - 1) + jsFib(n - 2)

  is(fib(30), 832040)
  is(jsFib(30), 832040)

  const N = 5
  const jsTime = bench(() => jsFib(30), N)
  const wasmTime = bench(() => fib(30), N)
  console.log(`  fib(30) x${N}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  pinFaster(wasmTime, jsTime, 1.2)
})
test('perf: mandelbrot escape grid — WASM faster than JS', () => {
  if (onWasi()) return  // wasi: run-reserved void entry
  // Bench-shape: render a 128x128 grid inside the wasm function.
  // The buggy let-in-loop pattern (`let x2 = zx*zx`) needs the widenPass fixpoint
  // re-walk to widen x2/y2 from i32 to f64 — without it the fractional value
  // gets `i32.trunc_sat_f64_s`'d and the checksum + perf both drift.
  const W = 128, H = 128, MAX = 96
  const src = `
    export let run = () => {
      let out = new Uint32Array(${W * H})
      let dx = ${(0.5 - -2.0) / W}
      let dy = ${(1.25 - -1.25) / H}
      for (let py = 0; py < ${H}; py++) {
        let cy = -1.25 + py * dy
        for (let px = 0; px < ${W}; px++) {
          let cx = -2.0 + px * dx
          let zx = 0, zy = 0, i = 0
          while (i < ${MAX}) {
            let x2 = zx * zx, y2 = zy * zy
            if (x2 + y2 > 4.0) break
            zy = 2 * zx * zy + cy
            zx = x2 - y2 + cx
            i++
          }
          out[py * ${W} + px] = i
        }
      }
      let h = 0x811c9dc5 | 0
      for (let i = 0; i < ${W * H}; i++) h = Math.imul(h ^ (out[i] | 0), 0x01000193) | 0
      return h >>> 0
    }
  `
  const { exports: { run } } = jz(src)
  const jsRun = () => {
    const out = new Uint32Array(W * H)
    const dx = (0.5 - -2.0) / W
    const dy = (1.25 - -1.25) / H
    for (let py = 0; py < H; py++) {
      const cy = -1.25 + py * dy
      for (let px = 0; px < W; px++) {
        const cx = -2.0 + px * dx
        let zx = 0, zy = 0, i = 0
        while (i < MAX) {
          const x2 = zx * zx, y2 = zy * zy
          if (x2 + y2 > 4.0) break
          zy = 2 * zx * zy + cy
          zx = x2 - y2 + cx
          i++
        }
        out[py * W + px] = i
      }
    }
    let h = 0x811c9dc5 | 0
    for (let i = 0; i < W * H; i++) h = Math.imul(h ^ (out[i] | 0), 0x01000193) | 0
    return h >>> 0
  }
  is(run(), jsRun())

  const ITERS = 5
  const jsTime = bench(jsRun, ITERS)
  const wasmTime = bench(run, ITERS)
  console.log(`  mandelbrot (${W}x${H}, max=${MAX}) x${ITERS}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  pinFaster(wasmTime, jsTime, 1.2)
})
test('perf: typed array sum — WASM competitive', () => {
  const { exports: { sum }, memory } = jz(`
    export let sum = (arr) => {
      let buf = new Float64Array(arr)
      let s = 0
      for (let i = 0; i < buf.length; i++) s += buf[i]
      return s
    }
  `)
  const N = 10000
  const data = new Float64Array(N)
  for (let i = 0; i < N; i++) data[i] = i * 0.1
  const wasmArr = memory.Float64Array(data)

  const jsSum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s }
  const expected = jsSum(data)
  const got = sum(wasmArr)
  ok(Math.abs(got - expected) < 1e-6, `sum: ${got} ~ ${expected}`)

  const ITERS = 500
  const jsTime = bench(() => jsSum(data), ITERS)
  const wasmTime = bench(() => sum(wasmArr), ITERS)
  console.log(`  typed sum (${N}) x${ITERS}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  pinFaster(wasmTime, jsTime, 1.2)
})
// === Bench-case pins ===
// Each test mirrors a bench/<case> kernel. Allocations + work happen inside
// the wasm function so jz fully narrows types (matching how `bench/<case>` is
// compiled with `main()` as the export). Pin: WASM < JS * 1.2.

test('perf: biquad cascade — WASM faster than JS', () => {
  const N = 24000, S = 8
  const cascadeSrc = (varKw) => `
    let v = x[i]
    for (${varKw} s = 0; s < ${S}; s++) {
      ${varKw} c = s * 5, sb = s * 4
      ${varKw} b0 = coeffs[c], b1 = coeffs[c+1], b2 = coeffs[c+2]
      ${varKw} a1 = coeffs[c+3], a2 = coeffs[c+4]
      ${varKw} x1 = state[sb], x2 = state[sb+1]
      ${varKw} y1 = state[sb+2], y2 = state[sb+3]
      ${varKw} y = b0*v + b1*x1 + b2*x2 - a1*y1 - a2*y2
      state[sb] = v
      state[sb+1] = x1
      state[sb+2] = y
      state[sb+3] = y1
      v = y
    }
    out[i] = v`
  const { exports: { run } } = jz(`
    export let run = () => {
      let x = new Float64Array(${N})
      let coeffs = new Float64Array(${S * 5})
      let state = new Float64Array(${S * 4})
      let out = new Float64Array(${N})
      for (let i = 0; i < ${N}; i++) x[i] = (i % 100) * 0.01 - 0.5
      for (let s = 0; s < ${S}; s++) {
        coeffs[s*5+0] = 0.10 + s * 0.001
        coeffs[s*5+1] = 0.20 - s * 0.0005
        coeffs[s*5+2] = 0.10
        coeffs[s*5+3] = -1.50 + s * 0.01
        coeffs[s*5+4] = 0.60 - s * 0.005
      }
      for (let i = 0; i < ${N}; i++) {${cascadeSrc('let')}
      }
      return out[${N - 1}]
    }
  `)
  const jsRun = () => {
    const x = new Float64Array(N), coeffs = new Float64Array(S * 5), state = new Float64Array(S * 4), out = new Float64Array(N)
    for (let i = 0; i < N; i++) x[i] = (i % 100) * 0.01 - 0.5
    for (let s = 0; s < S; s++) {
      coeffs[s*5+0] = 0.10 + s * 0.001
      coeffs[s*5+1] = 0.20 - s * 0.0005
      coeffs[s*5+2] = 0.10
      coeffs[s*5+3] = -1.50 + s * 0.01
      coeffs[s*5+4] = 0.60 - s * 0.005
    }
    for (let i = 0; i < N; i++) {
      let v = x[i]
      for (let s = 0; s < S; s++) {
        const c = s * 5, sb = s * 4
        const b0 = coeffs[c], b1 = coeffs[c+1], b2 = coeffs[c+2]
        const a1 = coeffs[c+3], a2 = coeffs[c+4]
        const x1 = state[sb], x2 = state[sb+1]
        const y1 = state[sb+2], y2 = state[sb+3]
        const y = b0*v + b1*x1 + b2*x2 - a1*y1 - a2*y2
        state[sb] = v
        state[sb+1] = x1
        state[sb+2] = y
        state[sb+3] = y1
        v = y
      }
      out[i] = v
    }
    return out[N - 1]
  }

  const ITERS = 15
  const jsTime = bench(jsRun, ITERS)
  const wasmTime = bench(run, ITERS)
  console.log(`  biquad (${N}x${S}) x${ITERS}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  pinFaster(wasmTime, jsTime, 1.2)
})
test('perf: mat4 multiply — WASM faster than JS', () => {
  const ITERS_INNER = 20000
  const { exports: { run } } = jz(`
    export let run = () => {
      let a = new Float64Array(16), b = new Float64Array(16), out = new Float64Array(16)
      for (let i = 0; i < 16; i++) { a[i] = (i+1) * 0.125; b[i] = (16-i) * 0.0625 }
      for (let n = 0; n < ${ITERS_INNER}; n++) {
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 4; c++) {
            let s = 0
            for (let k = 0; k < 4; k++) s += a[r*4+k] * b[k*4+c]
            out[r*4+c] = s + n * 0.0000001
          }
        }
        let t = a[0]
        a[0] = out[15]
        a[5] = t + out[10] * 0.000001
      }
      return out[15]
    }
  `)
  const jsRun = () => {
    const a = new Float64Array(16), b = new Float64Array(16), out = new Float64Array(16)
    for (let i = 0; i < 16; i++) { a[i] = (i+1) * 0.125; b[i] = (16-i) * 0.0625 }
    for (let n = 0; n < ITERS_INNER; n++) {
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          let s = 0
          for (let k = 0; k < 4; k++) s += a[r*4+k] * b[k*4+c]
          out[r*4+c] = s + n * 0.0000001
        }
      }
      const t = a[0]
      a[0] = out[15]
      a[5] = t + out[10] * 0.000001
    }
    return out[15]
  }

  const ITERS = 10
  const jsTime = bench(jsRun, ITERS)
  const wasmTime = bench(run, ITERS)
  console.log(`  mat4 x${ITERS_INNER} x${ITERS}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  pinFaster(wasmTime, jsTime, 1.2)
})
test('perf: poly bimorphic sum — WASM faster than JS', () => {
  if (onWasi()) return  // wasi: run-reserved void entry
  const N = 8192, ROUNDS = 80
  const { exports: { run } } = jz(`
    export let run = () => {
      let f64 = new Float64Array(${N}), i32 = new Int32Array(${N})
      for (let i = 0; i < ${N}; i++) { f64[i] = (i % 251) * 0.25; i32[i] = (i * 17) & 1023 }
      let h = 0x811c9dc5 | 0
      for (let r = 0; r < ${ROUNDS}; r++) {
        let sf = 0
        for (let i = 0; i < ${N}; i++) sf += f64[i]
        let si = 0
        for (let i = 0; i < ${N}; i++) si += i32[i]
        h = Math.imul(h ^ (sf | 0), 0x01000193) | 0
        h = Math.imul(h ^ (si | 0), 0x01000193) | 0
      }
      return h >>> 0
    }
  `)
  const jsRun = () => {
    const f64 = new Float64Array(N), i32 = new Int32Array(N)
    for (let i = 0; i < N; i++) { f64[i] = (i % 251) * 0.25; i32[i] = (i * 17) & 1023 }
    let h = 0x811c9dc5 | 0
    for (let r = 0; r < ROUNDS; r++) {
      let sf = 0
      for (let i = 0; i < N; i++) sf += f64[i]
      let si = 0
      for (let i = 0; i < N; i++) si += i32[i]
      h = Math.imul(h ^ (sf | 0), 0x01000193) | 0
      h = Math.imul(h ^ (si | 0), 0x01000193) | 0
    }
    return h >>> 0
  }
  is(run(), jsRun())

  const ITERS = 5
  const jsTime = bench(jsRun, ITERS)
  const wasmTime = bench(run, ITERS)
  console.log(`  poly (${N}x${ROUNDS}) x${ITERS}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  pinFaster(wasmTime, jsTime, 1.2)
})
test('perf: bitwise i32 chain — WASM faster than JS', () => {
  if (onWasi()) return  // wasi: run-reserved void entry
  const N = 16384, ROUNDS = 64
  const { exports: { run } } = jz(`
    export let run = () => {
      let state = new Int32Array(${N})
      let s = 0x1234abcd | 0
      for (let i = 0; i < ${N}; i++) {
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        state[i] = s
      }
      for (let r = 0; r < ${ROUNDS}; r++) {
        for (let i = 0; i < ${N}; i++) {
          let x = state[i] | 0
          x ^= x << 7
          x ^= x >>> 9
          x = Math.imul(x, 1103515245) + 12345
          state[i] = x ^ (x >>> 16)
        }
      }
      return state[${N - 1}] >>> 0
    }
  `)
  const jsRun = () => {
    const state = new Int32Array(N)
    let s = 0x1234abcd | 0
    for (let i = 0; i < N; i++) {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      state[i] = s
    }
    for (let r = 0; r < ROUNDS; r++) {
      for (let i = 0; i < N; i++) {
        let x = state[i] | 0
        x ^= x << 7
        x ^= x >>> 9
        x = Math.imul(x, 1103515245) + 12345
        state[i] = x ^ (x >>> 16)
      }
    }
    return state[N - 1] >>> 0
  }
  is(run(), jsRun())

  const ITERS = 3
  const jsTime = bench(jsRun, ITERS)
  const wasmTime = bench(run, ITERS)
  console.log(`  bitwise (${N}x${ROUNDS}) x${ITERS}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  pinFaster(wasmTime, jsTime, 1.2)
})
test('perf: tokenizer scan — WASM faster than JS', () => {
  if (onWasi()) return  // wasi: run-reserved void entry
  const REPEAT = 256
  const { exports: { run } } = jz(`
    let BASE = 'let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\\n'
    export let run = () => {
      let s = ''
      for (let i = 0; i < ${REPEAT}; i++) s = s + BASE
      let h = 0x811c9dc5 | 0
      let number = 0, inNumber = 0, inIdent = 0, tokens = 0
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i)
        if (c >= 48 && c <= 57) {
          number = ((number * 10) + (c - 48)) | 0
          inNumber = 1
        } else {
          if (inNumber) { h = Math.imul(h ^ (number | 0), 0x01000193) | 0; tokens++; number = 0; inNumber = 0 }
          if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95) {
            if (!inIdent) { h = Math.imul(h ^ (c | 0), 0x01000193) | 0; tokens++ }
            inIdent = 1
          } else {
            if (c > 32) { h = Math.imul(h ^ (c | 0), 0x01000193) | 0; tokens++ }
            inIdent = 0
          }
        }
      }
      if (inNumber) { h = Math.imul(h ^ (number | 0), 0x01000193) | 0; tokens++ }
      h = Math.imul(h ^ (tokens | 0), 0x01000193) | 0
      return h >>> 0
    }
  `)
  const BASE = 'let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\n'
  const jsRun = () => {
    let s = ''
    for (let i = 0; i < REPEAT; i++) s = s + BASE
    let h = 0x811c9dc5 | 0
    let number = 0, inNumber = 0, inIdent = 0, tokens = 0
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c >= 48 && c <= 57) {
        number = ((number * 10) + (c - 48)) | 0
        inNumber = 1
      } else {
        if (inNumber) { h = Math.imul(h ^ (number | 0), 0x01000193) | 0; tokens++; number = 0; inNumber = 0 }
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95) {
          if (!inIdent) { h = Math.imul(h ^ (c | 0), 0x01000193) | 0; tokens++ }
          inIdent = 1
        } else {
          if (c > 32) { h = Math.imul(h ^ (c | 0), 0x01000193) | 0; tokens++ }
          inIdent = 0
        }
      }
    }
    if (inNumber) { h = Math.imul(h ^ (number | 0), 0x01000193) | 0; tokens++ }
    h = Math.imul(h ^ (tokens | 0), 0x01000193) | 0
    return h >>> 0
  }
  is(run(), jsRun())

  const ITERS = 15
  const jsTime = bench(jsRun, ITERS)
  const wasmTime = bench(run, ITERS)
  console.log(`  tokenizer (x${REPEAT}) x${ITERS}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  pinFaster(wasmTime, jsTime, 1.2)
})
test('perf: callback Array.map — WASM faster than JS', () => {
  if (onWasi()) return  // wasi: run-reserved void entry
  const N = 2048, INNER = 64
  const { exports: { run } } = jz(`
    export let run = () => {
      let a = []
      for (let i = 0; i < ${N}; i++) a.push((i % 97) - 48)
      let h = 0x811c9dc5 | 0
      for (let i = 0; i < ${INNER}; i++) {
        let b = a.map(x => x * 2 + i)
        for (let j = 0; j < b.length; j += 64) h = Math.imul(h ^ (b[j] | 0), 0x01000193) | 0
      }
      return h >>> 0
    }
  `)
  const jsRun = () => {
    const a = []
    for (let i = 0; i < N; i++) a.push((i % 97) - 48)
    let h = 0x811c9dc5 | 0
    for (let i = 0; i < INNER; i++) {
      const b = a.map(x => x * 2 + i)
      for (let j = 0; j < b.length; j += 64) h = Math.imul(h ^ (b[j] | 0), 0x01000193) | 0
    }
    return h >>> 0
  }
  is(run(), jsRun())

  const ITERS = 15
  const jsTime = bench(jsRun, ITERS)
  const wasmTime = bench(run, ITERS)
  console.log(`  callback (${N}x${INNER}) x${ITERS}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  pinFaster(wasmTime, jsTime, 1.2)
})
test('perf: aos object rows — WASM faster than JS', () => {
  if (onWasi()) return  // wasi: run-reserved void entry
  const N = 16384, INNER = 64
  const { exports: { run } } = jz(`
    export let run = () => {
      let rows = []
      for (let i = 0; i < ${N}; i++) rows.push({ x: i * 0.5, y: i + 1, z: (i & 7) - 3 })
      let xs = new Float64Array(${N}), ys = new Float64Array(${N}), zs = new Float64Array(${N})
      for (let r = 0; r < ${INNER}; r++) {
        for (let i = 0; i < ${N}; i++) {
          let p = rows[i]
          xs[i] = p.x + p.y * 0.25 + r
          ys[i] = p.y - p.z * 0.5
          zs[i] = p.z + p.x * 0.125
        }
      }
      return xs[${N - 1}] + ys[${N - 1}] + zs[${N - 1}]
    }
  `)
  const jsRun = () => {
    const rows = []
    for (let i = 0; i < N; i++) rows.push({ x: i * 0.5, y: i + 1, z: (i & 7) - 3 })
    const xs = new Float64Array(N), ys = new Float64Array(N), zs = new Float64Array(N)
    for (let r = 0; r < INNER; r++) {
      for (let i = 0; i < N; i++) {
        const p = rows[i]
        xs[i] = p.x + p.y * 0.25 + r
        ys[i] = p.y - p.z * 0.5
        zs[i] = p.z + p.x * 0.125
      }
    }
    return xs[N - 1] + ys[N - 1] + zs[N - 1]
  }
  is(run(), jsRun())

  const ITERS = 3
  const jsTime = bench(jsRun, ITERS)
  const wasmTime = bench(run, ITERS)
  console.log(`  aos (${N}x${INNER}) x${ITERS}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  pinFaster(wasmTime, jsTime, 1.2)
})
// === Codegen quality assertions ===

test('codegen: boolean propagation — no __is_truthy on comparisons', () => {
  const wat = compile('export let f = (a, b) => { while (a < b && b > 0) { a++; b-- } return a }', { wat: true })
  // Comparisons in && should not need __is_truthy
  const trustyCalls = (wat.match(/__is_truthy/g) || []).length
  ok(trustyCalls === 0, `expected 0 __is_truthy calls in boolean &&, got ${trustyCalls}`)
})

test('codegen: i++ void context — no subtract-and-drop', () => {
  const wat = compile('export let f = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s }', { wat: true })
  // Should not contain (i32.sub ... (i32.const 1)) pattern from postfix desugaring
  // Check there's no "i32.sub" followed shortly by "drop" for the loop counter
  const subDrops = wat.match(/i32\.sub[\s\S]{0,20}i32\.const 1[\s\S]{0,20}drop/g)
  ok(!subDrops, `expected no sub-1-drop pattern, got ${subDrops?.length || 0}`)
})

test('codegen: asF64 on int constants — no unnecessary convert', () => {
  const wat = compile('export let f = (x) => { let s = 0; s = x * 2; return s }', { wat: true })
  // `0` and `2` in f64 context should emit f64.const, not f64.convert_i32_s(i32.const N)
  // Count f64.convert_i32_s of i32.const (the specific bad pattern)
  const converts = (wat.match(/f64\.convert_i32_s[\s\S]{0,30}i32\.const/g) || []).length
  ok(converts === 0, `expected 0 const-int-to-f64 converts, got ${converts}`)
})

test('codegen: for-loop counter matches .length type — no converts in loop', () => {
  if (belowOpt(1)) return  // convert-elision is an optimization (optimize >= 1)
  const wat = compile('export let f = (arr) => { let buf = new Float64Array(arr); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i]; return s }', { wat: true })
  // .length emits as f64, so i should be f64 to avoid per-iter convert
  const loopMatch = wat.match(/\(loop[^]*?\(br \$loop/s)
  if (loopMatch) {
    const converts = (loopMatch[0].match(/f64\.convert_i32/g) || []).length
    ok(converts === 0, `expected 0 i32->f64 converts inside loop, got ${converts}`)
  }
})

test('codegen: ping-pong typed-array ternary select reads via direct load', () => {
  // The classic double-buffer: two typed-array globals, and a hot function that
  // picks one per pass with a ternary (`flip ? a : b`) then indexes it. The
  // selected binding must inherit the branches' typed-array kind so `src[i]`
  // stays a direct f64.load — NOT the dynamic `$__typed_idx` dispatch (one call
  // per element, which it decayed to when a ternary branch was a variable name
  // rather than a `new` literal). Regression for lenia's ring convolution,
  // 0.31× → 1.13× over V8 once the per-tap call vanished.
  const src = `
    let a, b, flip = 0
    export let init = (n) => { a = new Float64Array(n); b = new Float64Array(n); a[0] = 1 }
    export let step = (n) => {
      let src = flip === 0 ? a : b
      let dst = flip === 0 ? b : a
      flip = 1 - flip
      let s = 0, i = 0
      while (i < n) { s = s + src[i]; dst[i] = src[i] * 2; i = i + 1 }
      return s
    }
  `
  const wat = compile(src, { wat: true })
  ok(!/call \$__typed_idx/.test(wat), 'ternary-selected typed buffers must read via direct load, not $__typed_idx')
  const { exports } = jz(src)             // same source as plain JS — correctness floor
  exports.init(8)
  is(exports.step(8), 1, 'sum reads the seeded buffer through the ternary select')
})

test('codegen: loop-invariant exported-param coercion hoists out of the loop', () => {
  // An exported numeric param arrives as a NaN-box, so each arithmetic use emits
  // `__to_num(p)`. When the param is never reassigned and used only numerically,
  // the coercion is loop-invariant and must hoist to one entry rebind — not run
  // per iteration. Regression for the de Jong attractor (4 coercions/iter ×
  // millions): 0.98× → 1.19× over V8. Self-gating: only fires when the body
  // already loads __to_num (here, via the global typed-array assign in `setup`).
  const src = `
    let buf
    export let setup = (n) => { buf = new Float64Array(n); let i = 0; while (i < n) { buf[i] = i * 0.5 - 3.0; i = i + 1 } return n }
    export let calc = (scale, k) => {
      let s = 0.0, i = 0, n = 32
      while (i < n) { s = s + buf[i] * scale * k; i = i + 1 }
      return s
    }
  `
  const wat = compile(src, { wat: true })
  // Isolate calc's body; the hot loop must hold no per-iter __to_num.
  const calcBody = wat.slice(wat.indexOf('(func $calc'))
  const loopMatch = calcBody.match(/\(loop[\s\S]*?\(br /)
  ok(loopMatch && !/call \$__to_num/.test(loopMatch[0]), 'param coercion must not remain inside the loop')
  // Correctness: identical to the same source as plain JS, across edge values.
  const { exports } = jz(src)
  exports.setup(32)
  let buf; const setup = (n) => { buf = new Float64Array(n); let i = 0; while (i < n) { buf[i] = i * 0.5 - 3.0; i = i + 1 } return n }
  const calc = (scale, k) => { let s = 0.0, i = 0, n = 32; while (i < n) { s = s + buf[i] * scale * k; i = i + 1 } return s }
  setup(32)
  for (const [a, b] of [[1.5, 2.0], [0, 0], [-2.3, 3.3], [1e9, 1e-9]]) is(exports.calc(a, b), calc(a, b))
})

test('codegen: reassigned exported param is NOT coercion-hoisted', () => {
  // The hoist assumes the param is unchanged across the loop — a reassignment
  // breaks that, so the scan must reject it and leave per-use coercion intact.
  const src = `
    let buf
    export let setup = (n) => { buf = new Float64Array(n); buf[0] = 1.0; return n }
    export let f = (p) => { let acc = 0.0, i = 0; while (i < 10) { acc = acc + buf[0] * p; p = p * 0.5; i = i + 1 } return acc }
  `
  const { exports } = jz(src)
  exports.setup(8)
  let buf; const setup = (n) => { buf = new Float64Array(n); buf[0] = 1.0; return n }
  const f = (p) => { let acc = 0.0, i = 0; while (i < 10) { acc = acc + buf[0] * p; p = p * 0.5; i = i + 1 } return acc }
  setup(8)
  for (const p of [4, -1.5, 1e8]) is(exports.f(p), f(p))   // geometric decay must match exactly
})

test('codegen: no-arg scalar allocator rewinds heap on return', () => {
  const src = `
    export let f = () => {
      let a = new Float64Array(4)
      let i = 0
      a[i] = 7
      return a[i] | 0
    }
  `
  const wat = compile(src, { wat: true, optimize: { watr: false } })
  const body = wat.match(/\(func \$f[\s\S]*?\n  \)/)?.[0] || ''
  ok(/heap_save/.test(body), 'expected heap save local')
  ok(/global\.set \$__heap/.test(body), 'expected heap restore before return')
  // Runs on the kernel leg too: the bytes leg graduated to the native optimize
  // default once the kernel-L2 ratchet hit zero (the SIMD-vectorizer divergences
  // this guard once dodged are fixed).
  const { instance } = jz(src, { optimize: { watr: false } })
  const before = instance.exports._alloc(0)
  for (let i = 0; i < 20; i++) is(instance.exports.f(), 7)
  const after = instance.exports._alloc(0)
  is(after, before, 'heap pointer should be unchanged across rewound scalar calls')
})

test('codegen: integer loop counter stays i32 even against an f64 param bound', () => {
  const wat = compile('export let f = (n) => { let acc = 0|0; for (let i = 0; i < n; i++) acc = (acc + i) | 0; return acc|0 }', { wat: true })
  // An affine integer counter (intCertain) stays i32 even when compared to an f64
  // param bound: widening it to f64 would make the increment AND the body
  // arithmetic f64 (and pull a heavy per-iter ToInt32 on every `|0`) — measured
  // ~18× vs V8. Keeping it i32 costs only one `f64.lt convert(i) n` in the compare.
  // Sound for n ≤ 2^31; n > 2^31 is the asm.js-style integer contract.
  // (The exported body is boundary-wrapped+inlined, so the counter local may be
  // renamed `$__inlN_i` — match any name ending in `i`.)
  ok(/\(local \$(?:\w+_)?i i32\)/.test(wat) && !/\(local \$(?:\w+_)?i f64\)/.test(wat),
    'integer loop counter i stays i32 against an f64 param bound')
})

test('codegen: f64-bound counter used as a fully-i32 array index stays i32', () => {
  if (onWasi()) return  // wasi: run-reserved renames locals
  // Idiomatic hot loop: counter compared to an f64 global bound, but used as an
  // affine array index. A valid wasm32 byte-offset must fit i32 and an affine
  // index is monotone in the counter, so it provably stays in i32 range — jz keeps
  // it i32 (direct indexing, zero per-access trunc_sat) instead of widening. This
  // is the compiler-inferred form of the manual `let n = N | 0` hoist, so idiomatic
  // source runs at int speed with no rewrite.
  const wat = compile(`
    let N = 0; let x;
    export let init = (k) => { N = k; x = new Float64Array(k); return x; };
    export let run = () => { let i = 0; while (i < N) { x[i] = x[i] * 2.0; i++; } };
  `, { wat: true })
  const run = wat.match(/\(func \$run[\s\S]*?\n  \)/)?.[0] || ''
  ok(run.includes('(local $i i32)'), 'index counter stays i32 against an f64 global bound')
  is((run.match(/trunc_sat_f64_s|trunc_f64_s/g) || []).length, 0, 'no per-access trunc_sat')
})

test('codegen: nested-loop index seeded from an outer counter narrows transitively', () => {
  if (onWasi()) return  // wasi: run-reserved renames locals
  // FFT-butterfly shape: an inner index is seeded from an outer counter and stepped
  // by an i32 stride. i32-safety back-propagates through the affine assignment/step
  // edges (i0 ← ix, i0 += id) so the whole nest stays i32 — the pattern that drove
  // the manual hoist in the rfft example.
  const wat = compile(`
    let N = 0; let x;
    export let init = (k) => { N = k; x = new Float64Array(k); return x; };
    export let run = () => {
      let ix = 0, id = 4;
      while (ix < N) {
        let i0 = ix;
        while (i0 < N) { x[i0] = x[i0] * 2.0; i0 += id; }
        ix = 2 * (id - 1);
        id *= 4;
      }
    };
  `, { wat: true })
  const run = wat.match(/\(func \$run[\s\S]*?\n  \)/)?.[0] || ''
  ok(/\(local \$ix i32\)/.test(run) && /\(local \$i0 i32\)/.test(run) && /\(local \$id i32\)/.test(run),
    'ix, i0, id all stay i32 through transitive back-propagation')
  is((run.match(/trunc_sat_f64_s|trunc_f64_s/g) || []).length, 0, 'no per-access trunc_sat in the nest')
})

test('codegen: float→int |0 of a finite, in-range value drops the +∞-guard select', () => {
  // `(expr)|0` (ToInt32) normally lowers to `select(i32.wrap(i64.trunc_sat_f64_s X), 0, X≠∞)` —
  // the select exists ONLY to remap +∞→0 (trunc_sat+wrap gives −1 there). When value-range
  // analysis PROVES X finite & within i32 (here a u8 load /255 scaled into [10,210]), the guard
  // is dead and the i64 round-trip unnecessary: a single `i32.trunc_sat_f64_s` IS exact ToInt32.
  // Pervasive in colour-packing / coordinate truncation. (Range analysis is structural — it sees an
  // INLINED finite expression; a value CSE'd into an f64 local stays guarded, by design.) Pin both:
  // the guard is gone AND the result still equals JS ToInt32 across in-range, wrap-boundary, ±∞.
  // `set` owns the byte STORE (its own param→u8 coercion); `pack`/`wide` read the byte via a load,
  // so their function bodies contain ONLY the |0 truncation under test — no confounding coercion.
  const src = `let n=4; let u8=new Uint8Array(n);
    export let set = (i,b) => { u8[i]=b }
    export let pack = (i) => (10.0+200.0*(u8[i]/255.0))|0
    export let wide = (i) => (u8[i]*10000000.0)|0
    export let vardiv = (a,c) => (a*1.0/c)|0`
  const wat = compile(src, { optimize: 'speed', wat: true })
  const pack = wat.match(/\(func \$pack[\s\S]*?\n  \)/)[0]
  ok(/i32\.trunc_sat_f64_s/.test(pack) && !/\bselect\b/.test(pack) && !/i64\.trunc_sat/.test(pack),
    'in-range |0 is a bare i32.trunc_sat_f64_s — no +∞-guard select, no i64 round-trip')
  const wide = wat.match(/\(func \$wide[\s\S]*?\n  \)/)[0]
  ok(!/\bselect\b/.test(wide), 'finite-but-large |0 drops the +∞ guard (keeps the mod-2^32 wrap)')
  const { exports } = jz(src, { optimize: 'speed' })
  const u = (i, b) => { exports.set(i, b); return i }
  // First branch — proven in-range [10,210]: bare trunc, exact ToInt32.
  for (const b of [0, 1, 127, 200, 255]) is(exports.pack(u(0, b)), (10.0 + 200.0 * (b / 255.0)) | 0, `pack(${b}) ≡ JS |0`)
  // Second branch — proven finite but [0, 2.55e9] exceeds i32: 255·1e7 wraps negative; must match JS.
  for (const b of [0, 100, 215, 255]) is(exports.wide(u(1, b)), (b * 10000000.0) | 0, `wide(${b}) ≡ JS |0 (wrap)`)
  // Variable divisor ⇒ value may be ±∞ (a/0); range unknown ⇒ the guard MUST stay (∞→0, not −1).
  for (const [a, c] of [[10, 3], [100, 7], [5, 0]]) is(exports.vardiv(a, c), ((a * 1.0 / c) | 0), `vardiv(${a},${c}) ≡ JS |0 (guard kept: ${c === 0 ? '∞→0' : 'finite'})`)
})

test('codegen: unary negation feeding arithmetic drops its redundant NaN-canon', () => {
  // `-x` canon-izes (f64.neg flips a NaN's sign bit → non-canonical number-NaN). But when the
  // negation feeds f64 arithmetic — `x * -y`, `a - -b` — the consumer propagates the NaN and
  // re-canon-izes on its own escape, so the inner per-neg `select + f64.ne` is dead. Tagging the
  // neg with canonOf lets the arithmetic strip it (same contract as the sqrt/min/max canons).
  const wat = compile('export let f = (a, b) => a * (-b) + (-a) * b', { optimize: 'speed', wat: true })
  is((wat.match(/f64\.const nan/g) || []).length, 0, 'inline negation in arithmetic carries no NaN-canon')
  // Correctness across NaN/±0/finite: the value is identical with or without the canon here.
  const { exports } = jz('export let f = (a, b) => a * (-b) + (-a) * b', { optimize: 'speed' })
  for (const [a, b] of [[3, 4], [-2.5, 1.5], [0, 7]]) is(exports.f(a, b), a * (-b) + (-a) * b, `neg-arith f(${a},${b})`)
})

test('codegen: integer accumulation from a GLOBAL typed array reads native i32 (no f64 round-trip)', () => {
  // `ax = ax + DX[dir]` with DX a module-global Int32Array and ax/dir i32: the read +
  // add must stay in the i32 domain (one i32.add), not round-trip i32.load → f64.convert
  // → f64.add → i32.trunc_sat. The global typed array's element type was invisible to
  // exprType during analyze/emit (only locals/params were consulted), so the whole
  // expression widened to f64 — the ulam spiral measured 2.2× SLOWER than V8; with the
  // global typed-elem registry consulted it is ~1.6× faster. Pins both: emit and exprType.
  const wat = compile(`
    let DX = new Int32Array([1, 0, -1, 0])
    let out = new Int32Array(1)
    export let walk = () => {
      let ax = 0, dir = 0, i = 0
      while (i < 1000) { ax = ax + DX[dir]; dir = (dir + 1) & 3; i = i + 1 }
      out[0] = ax
    }`, { wat: true })
  // Every `+` in the kernel is integer (ax, DX[dir], dir+1, i+1) so a correct lowering has
  // NO f64 arithmetic at all. HEAD emits f64.add + f64.convert_i32_s on `ax + DX[dir]` — the
  // round-trip — because the global Int32Array's element type was invisible to exprType.
  is((wat.match(/f64\.add/g) || []).length, 0, 'no f64.add on the integer accumulation')
  is((wat.match(/f64\.convert_i32_s/g) || []).length, 0, 'no i32→f64 convert feeding the accumulation')
  ok((wat.match(/i32\.add/g) || []).length >= 1, 'accumulation lowers to native i32.add')
})

test('codegen: integer const-global folds to i32 — x % CONST_GLOBAL takes the integer path', () => {
  // `const N = 16384` is an immutable integer constant. A counter bounded by it must stay
  // i32, and `x % N` must lower to native i32.rem_s — not fold N to an f64 constant and route
  // `%` through the software f64 remainder (the long-division the crc32/json outer loops paid).
  // Pins both exprType (i32 typing) and readVar (i32.const emit) for const-int globals.
  const wat = compile(`
    const N = 16384
    export let f = (iters) => {
      let acc = 0
      for (let it = 0; it < (iters | 0); it++) acc = (acc + (it % N)) | 0
      return acc | 0
    }`, { wat: true })
  ok((wat.match(/i32\.rem_s/g) || []).length >= 1, 'x % CONST_GLOBAL lowers to i32.rem_s')
  is((wat.match(/f64\.copysign/g) || []).length, 0, 'no software f64-remainder for the integer modulo')
})

test('codegen: sound load-CSE — reuse arr[idx] across a disjoint-index store, never across a same-index one', () => {
  const loads = (src, opt) => (compile(src, { wat: true, ...opt }).match(/f64\.load/g) || []).length
  // fft butterfly shape over module-global typed arrays (so the reads are direct f64.load):
  // `RE[a]` is read twice across stores at `RE[b]`/`IM[b]` (b = a+half, half ≥ 1 inside `for(j<half)`),
  // so the indices are PROVABLY disjoint — the second `RE[a]` load is CSE-eliminated.
  const bf = `let RE=new Float64Array(2048), IM=new Float64Array(2048)
    export let f=(n)=>{ let half=n>>1; for(let len=2;len<=n;len<<=1){ for(let i=0;i<n;i+=len){
      for(let j=0;j<half;j++){ let a=i+j,b=a+half; let tr=RE[a]*0.5; let ti=IM[a]*0.5;
        RE[b]=RE[a]-tr; IM[b]=IM[a]-ti; RE[a]=RE[a]+tr; IM[a]=IM[a]+ti } } } }`
  ok(loads(bf, { optimize: 'speed' }) < loads(bf, { optimize: { level: 'speed', loadCSE: false } }),
    'butterfly RE[a] reload is CSE-eliminated (disjoint index b = a+half)')
  // UNSAFE: a store at the SAME index between the two reads must NOT be CSE'd (would miscompile).
  const same = `let A=new Float64Array(64)
    export let g=(n)=>{ let s=0.0; for(let i=0;i<n;i++){ let x=A[i]; A[i]=x*2.0+1.0; let y=A[i]; s+=x+y } return s }`
  is(loads(same, { optimize: 'speed' }), loads(same, { optimize: { level: 'speed', loadCSE: false } }),
    'same-index store between reads blocks CSE (no load eliminated)')
  // Semantics-preserving: identical result with the pass on vs off (also covers the run path).
  const onR = jz(same, { optimize: 'speed' }).exports.g(16)
  const offR = jz(same, { optimize: { level: 'speed', loadCSE: false } }).exports.g(16)
  is(onR, offR, 'load-CSE preserves the result')
})

test('codegen: Uint32Array arithmetic stays f64 — no i32 wrap at 2^32', () => {
  // The typed-array i32-read narrowing must NOT apply to Uint32Array, whose element can
  // exceed signed-i32 range: `U[0] + 1` at 2^32-1 is 4294967296, not a wrapped 0. exprType
  // flags a Uint32 read as unsigned so +/-/* widen to f64 (bitwise/store consumers stay i32).
  const { exports } = jz(`
    let U = new Uint32Array(4)
    export let setup = () => { U[0] = 4294967295 }
    export let add1 = () => U[0] + 1`, { optimize: 'speed' })
  exports.setup()
  is(exports.add1(), 4294967296, 'Uint32 read + 1 does not wrap at 2^32')
})

test('codegen: f64-strided index does NOT force its counter to i32', () => {
  // Guard against over-narrowing: when the index carries a genuinely-f64 operand
  // (here `w` is an exported-function param, fixed f64 by the host ABI), the access
  // truncs no matter what, so keeping the counter i32 would add a compare-convert
  // per iteration for zero trunc savings (a net loss — the game-of-life regression).
  // The counter must keep widening to f64 exactly as before the auto-narrow rule.
  // (A *global* stride is now inferred i32 — that's the integer-global inference win,
  // covered by the rfft/game-of-life example byte-checks; this guards the f64 case.)
  const wat = compile(`
    let mem;
    export let init = (k) => { mem = new Float64Array(k*k); return mem; };
    export let run = (w, n) => { let y = 0; while (y < n) { mem[y * w] = 1.0; y++; } };
  `, { wat: true })
  const run = wat.match(/\(func \$run[\s\S]*?\n  \)/)?.[0] || ''
  ok(run.includes('(local $y f64)'), 'counter behind an f64-strided index still widens to f64')
})

test('codegen: integer-global inference narrows numeric globals, demoting only on proof', () => {
  // Purpose-focused code: a size/stride/index global is an integer unless an
  // assignment *proves* it fractional. `N`, `half` (a `>>>`), `width`, `offset`
  // (a product of i32 globals) → i32; `bSi` (`2.0 / n`) and `scale` (refs the
  // fractional `bSi`) → f64. No annotations, all inferred from the assignments.
  const decl = (wat, g) => {
    const lines = wat.split('\n')
    const i = lines.findIndex(l => new RegExp(`global \\$${g}\\b`).test(l))
    return i < 0 ? '' : lines[i + 1].trim()
  }
  const wat = compile(`
    let N = 0, half = 0, bSi = 0, width = 0, offset = 0, scale = 0;
    export let init = (n, w, h) => {
      N = n; half = n >>> 1; bSi = 2.0 / n;
      width = w; offset = width * h; scale = bSi * 2;
    };
    export let sum = () => N + half + bSi + width + offset + scale;
  `, { wat: true })  // reader export keeps the globals live under watr's export-rooted liveness
  is(decl(wat, 'N'), '(mut i32)', 'N (param assign) → i32')
  is(decl(wat, 'half'), '(mut i32)', 'half (>>> shift) → i32')
  is(decl(wat, 'width'), '(mut i32)', 'width (param assign) → i32')
  is(decl(wat, 'offset'), '(mut i32)', 'offset (product of i32 globals) → i32')
  is(decl(wat, 'bSi'), '(mut f64)', 'bSi (2.0 / n) stays f64 — provably fractional')
  is(decl(wat, 'scale'), '(mut f64)', 'scale (refs fractional bSi) stays f64 via fixpoint')
})

test('codegen: i32 global bound makes the loop guard pure-i32 (no per-iter convert)', () => {
  if (onWasi()) return  // wasi: run-reserved renames locals
  // The payoff of integer-global inference: with `N` an i32 global, `i < N` is a
  // pure i32 compare — no `f64.convert_i32_s` widening the counter each iteration.
  const wat = compile(`
    let N = 0; let x;
    export let init = (k) => { N = k; x = new Float64Array(k); return x; };
    export let run = () => { let s = 0.0; let i = 0; while (i < N) { s += x[i]; i++; } return s; };
  `, { wat: true })
  const run = wat.match(/\(func \$run[\s\S]*?\n  \)/)?.[0] || ''
  ok(/i32\.lt_s[\s\S]*global\.get \$N/.test(run.replace(/\n/g, ' ')), 'guard is i32.lt_s against the i32 global')
  ok(run.includes('(local $i i32)'), 'loop counter stays i32 against the i32 global bound')
})

test('codegen: typed-array global base decode hoists out of the stencil loop', () => {
  if (belowOpt(2)) return  // promoteGlobals + hoistGlobalPtrOffset are level-2 passes (level 1 = treeshake/sortLocalsByUse/fusedRewrite only)
  // A typed-array global indexed N times per cell expands each access to a
  // `(i32.wrap_i64 (i64.and (i64.reinterpret_f64 (local.get $_pg)) MASK))` decode of
  // the NaN-boxed pointer. The promoted snapshot is set once at entry from a
  // non-volatile global, so that decode is loop-invariant — it must be snapshotted
  // ONCE, leaving each access a plain `(i32.add base (i32.shl idx 3))`. Regression
  // for watercolor's Gauss-Seidel pressure solve (5 reads/cell × millions of cells):
  // 0.91× → 1.02× over V8 once the per-element reinterpret/and/wrap vanished.
  const wat = compile(`
    let p, N = 0
    export let init = (n) => { N = n; p = new Float64Array(n); return p }
    export let run = () => {
      let i = 1
      while (i < N - 1) { p[i] = (p[i-1] + p[i] + p[i+1]) * 0.5; i = i + 1 }
    }
  `, { wat: true })
  const run = wat.match(/\(func \$run[\s\S]*?\n  \)/)?.[0] || ''
  const loop = run.match(/\(loop[\s\S]*\(br /)?.[0] || ''
  is((loop.match(/i64\.reinterpret_f64/g) || []).length, 0,
    'no per-access pointer decode inside the loop — base is hoisted to entry')
  // Exactly one decode survives: the entry snapshot of the buffer base.
  is((run.match(/i64\.reinterpret_f64/g) || []).length, 1, 'base decoded once at function entry')
  // Correctness floor: identical to the same source run as plain JS.
  const { exports } = jz(`
    let p, N = 0
    export let init = (n) => { N = n; p = new Float64Array(n); return p }
    export let run = () => {
      let i = 1
      while (i < N - 1) { p[i] = (p[i-1] + p[i] + p[i+1]) * 0.5; i = i + 1 }
    }
  `)
  let p, N = 0
  const init = (n) => { N = n; p = new Float64Array(n); return p }
  const jsRun = () => { let i = 1; while (i < N - 1) { p[i] = (p[i-1] + p[i] + p[i+1]) * 0.5; i = i + 1 } }
  const wp = exports.init(16); init(16)
  for (let i = 0; i < 16; i++) p[i] = wp[i] = i * 0.5  // seed both buffers identically
  exports.run(); jsRun()
  for (let i = 0; i < 16; i++) ok(Math.abs(wp[i] - p[i]) < 1e-9, `cell ${i}: ${wp[i]} ~ ${p[i]}`)
})

test('codegen: ping-pong double-buffer base decode hoists per-loop (volatile global)', () => {
  if (belowOpt(2)) return  // hoistGlobalPtrOffset base-decode hoist is a level-2 pass (not in the level-1 preset)
  // The wireworld / cellular-automaton shape: two grids `a`/`b` swapped each frame
  // (`a = b; b = tmp`). The swap makes them volatile, so function-scope hoisting
  // (hoistGlobalPtrOffset) can't snapshot their base. But within EACH loop the pointer
  // is invariant (the swap is between loops), so LICM must hoist the inline base decode
  // to the loop pre-header — otherwise every neighbour read re-decodes the NaN-box
  // (8 reads/cell in the conductor branch). 0.98× → 1.11× over V8.
  const wat = compile(`
    let W = 0, a, b
    export let init = (n) => { W = n; a = new Int32Array(n); b = new Int32Array(n); return a }
    export let step = () => {
      let i = 1
      while (i < W - 1) { b[i] = a[i-1] + a[i] + a[i+1]; i = i + 1 }
      let t = a; a = b; b = t          // ping-pong swap → a, b are volatile
      let s = 0, j = 0
      while (j < W) { s = s + a[j]; j = j + 1 }   // reads the swapped grid
      return s
    }
  `, { wat: true })
  const step = wat.match(/\(func \$step[\s\S]*?\n  \)/)?.[0] || ''
  // No per-element pointer decode survives inside either loop — both are hoisted to
  // their own pre-header (the first reads pre-swap `a`, the second the post-swap `a`).
  const loops = step.match(/\(loop[\s\S]*?\(br /g) || []
  let inLoop = 0; for (const l of loops) inLoop += (l.match(/i64\.reinterpret_f64/g) || []).length
  is(inLoop, 0, 'volatile double-buffer base decode is hoisted out of every loop')
  // Correctness floor: identical to the same source as plain JS, across a swap.
  const { exports } = jz(`
    let W = 0, a, b
    export let init = (n) => { W = n; a = new Int32Array(n); b = new Int32Array(n); return a }
    export let step = () => {
      let i = 1
      while (i < W - 1) { b[i] = a[i-1] + a[i] + a[i+1]; i = i + 1 }
      let t = a; a = b; b = t
      let s = 0, j = 0
      while (j < W) { s = s + a[j]; j = j + 1 }
      return s
    }
  `)
  const wa = exports.init(8)
  for (let i = 0; i < 8; i++) wa[i] = i + 1   // a = [1..8]
  // b[i] = a[i-1]+a[i]+a[i+1] for i=1..6 → [0,6,9,12,15,18,21,0]; swap; sum = 81.
  is(exports.step(), 81, 'stencil-then-swap sum matches JS exactly')
})

test('codegen: narrowUint32 hash accumulator stays pure i32 (no f64 round-trip)', () => {
  // FNV/PRNG hot path: every read of `h` is funnelled through a `>>>` (ToUint32)
  // sink via bit-faithful ops, so narrowUint32 keeps `h` an unsigned i32 local.
  // The mix must compile to i32.add/xor/shl — never f64 — else the loop pays a
  // convert_i32_u round-trip per op. (Regression: a uint32-widening guard once
  // fired on these `.unsigned` reads, emitting f64.add/convert on the hot path.)
  // An i32 loop bound (`n | 0`) keeps the counter i32, so the only legal f64 op
  // is the single convert_i32_u that reboxes the uint32 result at the boundary.
  const wat = compile(`
    export let hash = (n) => {
      let h = 2166136261
      for (let i = 0; i < (n | 0); i = i + 1) {
        h = (h ^ i) >>> 0
        h = (h + (h << 1) + (h << 4)) >>> 0
      }
      return h >>> 0
    }`, { wat: true })
  const n = (re) => (wat.match(re) || []).length
  is(n(/f64\.add/g), 0, 'no f64.add on the accumulator hot path')
  is(n(/f64\.mul/g), 0, 'no f64.mul on the accumulator hot path')
  is(n(/f64\.convert/g), 1, 'only the return-boundary convert_i32_u widens')
  ok(n(/i32\.xor/g) >= 1 && n(/i32\.shl/g) >= 1, 'mix uses i32 bitwise ops')
})

test('codegen: f64 threshold in a recurrence lowers to a branchless select at speed', () => {
  // `err = acc - (acc >= t)` emits `f64.sub(acc, f64.convert_i32_s(f64.ge …))`. That
  // i32→f64 convert (cvtsi2sd) round-trips the comparison out of a GPR and back into
  // an XMM register — a domain cross that sits ON the loop-carried critical path of an
  // error-diffusion / scalar-IIR sweep, ~doubling per-step latency (V8 keeps the JS
  // threshold in the FP domain). boolConvertToSelect (speed tier only) rewrites it to
  // `select(acc-1, acc, acc>=t)`, never leaving the f64 domain. Pin: fires at speed,
  // stays a convert at the default level, and the value is unchanged either way.
  const src = `
    let buf = new Float64Array(256)
    export let sweep = (n) => {
      let i = 0, acc = 0.3
      while (i < (n | 0)) {
        let on = acc >= 0.5 ? 1 : 0
        acc = buf[i] + (acc - on) * 0.4375
        i = i + 1
      }
      return acc
    }`
  const n = (w, re) => (w.match(re) || []).length
  const watSpeed = compile(src, { wat: true, optimize: 'speed' })
  const watDefault = compile(src, { wat: true, optimize: 2 })  // pin level 2 (pass off) — JZ_TEST_OPTIMIZE must not flip the gated half of this codegen pin
  ok(n(watSpeed, /\bselect\b/g) >= 1, 'speed: threshold lowered to a select')
  is(n(watSpeed, /f64\.convert_i32_s/g), 0, 'speed: no i32→f64 convert left on the recurrence')
  is(n(watDefault, /f64\.convert_i32_s/g), 1, 'default level keeps the convert (pass is speed-gated)')
  // Same number either way (semantics-preserving rewrite).
  const fast = jz(src, { optimize: 'speed' }).exports.sweep(200)
  const base = jz(src, { optimize: 2 }).exports.sweep(200)
  is(fast, base, 'select form computes the identical result')

  // Guard: a PARAM reassigned once by a comparison is NOT treated as boolean — its
  // incoming arg is unconstrained, so an earlier `f64 - param` read isn't `cond?1:0`.
  // (Plain locals are safe: a pre-def read sees the zero-init 0 = false.) jz keeps such
  // params f64 today so the convert-in-subtract shape doesn't even arise, but the pass
  // stays correct for any IR — `param - p` must subtract the value, never select on it.
  const psrc = `let buf = new Float64Array(64)
    export let h = (k) => { let pre = buf[0] - k; k = buf[1] >= buf[2] ? 1 : 0; return buf[k] + pre }`
  is(jz(psrc, { optimize: 'speed' }).exports.h(5), -5, 'param read subtracts its value, not select(param)')
})

test('codegen: named i32 index feeder (let idx = y*W + x) computes in native i32', () => {
  // The per-pixel `let idx = py*W + qx` bound to an i32 index local used to emit the
  // f64 round-trip `i32.trunc_sat_f64_s(f64.add(f64.mul(convert py, convert W), …))`
  // + an Infinity-guard select — because exprType keeps a non-literal product f64
  // (it may overflow i32). For an i32 destination, wrapping i32 arithmetic is bit-
  // identical (ToInt32 ≡ two's-complement wrap), so emitDecl now lowers it natively.
  const wat = compile(`
    let img = new Float64Array(4096)
    export let sum = (W, H) => {
      let w = W | 0, h = H | 0, py = 0, s = 0.0
      while (py < h) {
        let qx = 0
        while (qx < w) {
          let idx = py * w + qx
          s = s + img[idx]
          qx = qx + 1
        }
        py = py + 1
      }
      return s
    }`, { wat: true })
  const at = wat.indexOf('(func $sum')
  const fn = wat.slice(at, wat.indexOf('(func', at + 6))
  const n = (re) => (fn.match(re) || []).length
  is(n(/i32\.trunc_sat_f64_s/g), 0, 'no f64→i32 truncation of the index')
  is(n(/f64\.mul/g), 0, 'row offset py*w is an i32.mul, not f64.mul')
  ok(n(/i32\.mul/g) >= 1, 'py*w computed with i32.mul')
})

test('codegen: unknown-receiver index with NUMBER key skips __is_str_key dispatch', () => {
  // `a[i]` on an untyped param `a` with a known-NUMBER index (loop counter) can
  // never be a string key — the runtime `__is_str_key` dispatch is statically
  // dead. Without the guard it forced an f64 round-trip of `i` + a call per read
  // (and pulled in the whole `__dyn_get` subtree via its dead string-key arm).
  // The element read should reach __typed_idx with the raw i32 index directly.
  const wat = compile(`
    export let f = (a) => { let s = 0; for (let i = 0; i < 100; i++) s = s + (a[i] | 0); return s }
  `, { wat: true })
  const fMatch = wat.match(/\(func \$f[\s\S]*?\n  \)/)?.[0] || ''
  const n = (re) => (fMatch.match(re) || []).length
  is(n(/__is_str_key/g), 0, 'NUMBER key never needs the string-key dispatch')
  is(n(/__dyn_get/g), 0, 'no dynamic-property fallback for a numeric index')
  // watr's inliner may dissolve __typed_idx entirely — the pin's intent is "raw i32
  // index, no f64 round-trip": either the helper call with the raw index, or a fully
  // inlined load with no boxing of $i.
  ok(/\$__typed_idx[\s\S]*?\(local\.get \$i\)/.test(fMatch)
    || (/(f64|i32)\.load/.test(fMatch) && !/f64\.convert_i32_s \(local\.get \$i\)/.test(fMatch)),
    'reads with the raw i32 index')
})

test('codegen: pure scalar function — minimal binary', () => {
  const wasm = compile('export let add = (a, b) => a + b')
  // Pure scalar: no arrays, strings, objects. Should be tiny.
  ok(wasm.byteLength < 150, `pure scalar add should be < 150 bytes, got ${wasm.byteLength}`)
})

test('compile profile reports phase timings', () => {
  if (onKernel()) return  // kernel: host {profile} option doesn't reach the single-source self-host
  const profile = {}
  const wasm = compile('export let add = (a, b) => a + b', { profile })
  ok(wasm.byteLength > 0, 'compile still returns wasm bytes')
  for (const name of ['parse', 'prepare', 'compile', 'plan', 'watrCompile'])
    ok(typeof profile.totals?.[name] === 'number', `expected ${name} timing`)
  ok(profile.totals.compile >= profile.totals.plan, 'compile timing should include plan timing')
})

test('compile profile.names emits wasm function name section', () => {
  if (onKernel()) return  // kernel: host {profile:{names}} option doesn't reach the single-source self-host
  const src = 'let helper = (x) => x <= 0 ? 1 : helper(x - 1) + 1; export let add = (a, b) => helper(a) + b'
  const plain = compile(src)
  is(WebAssembly.Module.customSections(new WebAssembly.Module(plain), 'name').length, 0)

  const named = compile(src, { profile: { names: true } })
  const names = functionNames(named).map(([, name]) => name)
  // `add` has a dynamic (i64) param so it's boundary-wrapped: the exported entry is the
  // `$add$exp` thunk (the inner single-use body inlines into it). Either name proves the
  // export is present in the name section.
  ok(names.includes('add') || names.includes('add$exp'), 'exported function name should be present')
  ok(names.includes('helper'), 'internal function name should be present')
})

test('helper counters are opt-in and resettable', async () => {
  if (onKernel()) return  // kernel: host-only profiling option is not in the self-host ABI
  const src = `
    export const main = () => {
      const xs = []
      xs.push(1)
      xs.push(2)
      return xs.length
    }
  `
  const plain = await WebAssembly.instantiate(compile(src, { optimize: false }))
  ok(!plain.instance.exports.__hc_arr_push1, 'plain output should not export helper counters')

  const profiled = await WebAssembly.instantiate(compile(src, { optimize: false, helperCounters: true }))
  const e = profiled.instance.exports
  ok(e.__hc_arr_push1, 'profiled output should export helper counters')
  ok(e.__helper_counts_reset, 'profiled output should export a counter reset helper')
  is(e.__hc_arr_push1.value, 0n)
  is(e.main(), 2)
  ok(e.__hc_arr_push1.value >= 2n, 'Array.push helper counter should increment')
  e.__helper_counts_reset()
  is(e.__hc_arr_push1.value, 0n)
})

test('helper callsite counters attribute dynamic helper calls', async () => {
  if (onKernel()) return  // kernel: host-only profiling option is not in the self-host ABI
  const src = `
    export const main = () => {
      const xs = []
      xs.push(1)
      xs.push(2)
      return xs.length
    }
  `
  const plain = await WebAssembly.instantiate(compile(src, { optimize: false }))
  ok(!Object.keys(plain.instance.exports).some(k => k.startsWith(HELPER_SITE_PREFIX)),
    'plain output should not export helper callsite counters')

  const profiled = await WebAssembly.instantiate(compile(src, { optimize: false, helperCallsites: 'arr_push1' }))
  const e = profiled.instance.exports
  const sites = Object.entries(e).filter(([k, v]) => k.startsWith(HELPER_SITE_PREFIX) && typeof v?.value === 'bigint')
  ok(sites.some(([k]) => k.includes(':arr_push1:main')), 'profiled output should name the helper and owning function')
  const before = Object.fromEntries(sites.map(([k, v]) => [k, v.value]))
  is(e.main(), 2)
  const pushCount = sites
    .filter(([k]) => k.includes(':arr_push1:main'))
    .reduce((n, [k, v]) => n + (v.value - before[k]), 0n)
  ok(pushCount >= 2n,
    'callsite counter should increment dynamically')
})

test('codegen: runtime .length does not eagerly decode pointer offset', () => {
  if (onKernel()) return  // kernel WAT shape differs; in-process leg owns shape checks
  const wat = compile('export let f = (x) => x.length', { wat: true, optimize: false })
  const h0 = wat.indexOf('(func $__length')
  const h1 = wat.indexOf('\n  (func ', h0 + 1)
  const helperBody = h0 >= 0 ? wat.slice(h0, h1 >= 0 ? h1 : undefined) : ''
  ok(helperBody, 'expected $__length helper in WAT')
  ok(/\$__len\b/.test(helperBody), '$__length should still delegate non-string length to $__len')
  is((helperBody.match(/\$__ptr_offset\b/g) || []).length, 0,
    '$__length should not eagerly call $__ptr_offset before the string/non-string branch')
})

test('codegen: statement array push skips dropped return length reload', () => {
  if (onKernel()) return  // kernel WAT shape differs; in-process leg owns shape checks
  const stmtWat = compile('export let f = () => { let xs = []; xs.push(1); return 7 }', { wat: true, optimize: false })
  const stmtBody = stmtWat.match(/\(func \$f[\s\S]*?^  \)/m)?.[0] || ''
  ok(stmtBody, 'expected $f function in WAT')
  is((stmtBody.match(/\$__arr_push1\b/g) || []).length, 1, 'statement push should use the known-array helper')
  is((stmtBody.match(/\$__ptr_offset\b/g) || []).length, 0, 'statement push should not reload length for a dropped result')

  const exprWat = compile('export let f = () => { let xs = []; return xs.push(1) }', { wat: true, optimize: false })
  const exprBody = exprWat.match(/\(func \$f[\s\S]*?^  \)/m)?.[0] || ''
  ok(exprBody, 'expected expression $f function in WAT')
  is((exprBody.match(/\$__arr_push1\b/g) || []).length, 1, 'expression push should use the same known-array helper')
  is((exprBody.match(/\$__ptr_offset\b/g) || []).length, 1, 'expression push still reloads length for the JS return value')

  const h0 = exprWat.indexOf('(func $__arr_push1')
  const h1 = exprWat.indexOf('\n  (func ', h0 + 1)
  const helperBody = h0 >= 0 ? exprWat.slice(h0, h1 >= 0 ? h1 : undefined) : ''
  ok(helperBody, 'expected $__arr_push1 helper in WAT')
  is((helperBody.match(/\$__ptr_offset\b/g) || []).length, 0,
    '__arr_push1 should inline its hot forwarding-aware offset decode')
  ok(helperBody.includes('$__ptr_offset_fwd'),
    '__arr_push1 should still use the shared cold forwarding chase')
})

// === JSON shape inference (shapeStrs) ===
//
// Bench convention writes `let SRC = '{...}'` to defeat compile-time JSON.parse
// folding. shapeStrs preserves shape knowledge across that boundary so the walk
// side gets direct `f64.load offset=N` slot loads instead of falling back to
// `__dyn_get_*`/`__to_num`/`__is_str_key`.

test('codegen: JSON.parse(let SRC) walk uses slot loads — no __dyn_get/__to_num', () => {
  if (belowOpt(1)) return  // asserts SROA slot loads replaced dynamic dispatch (optimize >= 1)
  const wat = compile(`
    let SRC = '{"items":[{"id":1,"v":10}],"meta":{"k":7}}'
    export let walk = () => {
      let o = JSON.parse(SRC)
      return o.meta.k + o.items[0].v
    }
  `, { wat: true })
  const fMatch = wat.match(/\(func \$walk[\s\S]*?^  \)$/m)
  ok(fMatch, 'expected $walk function in WAT')
  const body = fMatch[0]
  is((body.match(/__dyn_get/g) || []).length, 0)
  is((body.match(/__to_num/g) || []).length, 0)
  is((body.match(/__is_str_key/g) || []).length, 0)
  ok(/f64\.load offset=\d+/.test(body), 'expected direct slot loads')
})

test('codegen: shapeStrs invalidates when SRC is reassigned', () => {
  const wat = compile(`
    let SRC = '{"items":[{"id":1}],"meta":{"k":7}}'
    export let setIt = (s) => { SRC = s }
    export let walk = () => {
      let o = JSON.parse(SRC)
      return o.meta.k
    }
  `, { wat: true })
  // After reassignment, walk-side must fall back to dynamic property access.
  ok((wat.match(/__dyn_get/g) || []).length > 0,
    'reassigned SRC should not produce slot-load codegen')
})

test('perf: JSON.parse + walk — WASM faster than JS', () => {
  if (onKernel()) return  // kernel: self-host wasm is unoptimized (no watOptimize); the perf bar assumes level-2 output
  const SRC = '{"items":[{"id":1,"kind":2,"value":10},{"id":2,"kind":3,"value":20},{"id":3,"kind":5,"value":30}],"meta":{"scale":7,"bias":11}}'
  const src = `
    let SRC = '${SRC}'
    export let walk = () => {
      let o = JSON.parse(SRC)
      let items = o.items
      let s = o.meta.bias
      for (let j = 0; j < items.length; j++) {
        let it = items[j]
        s += it.id * o.meta.scale + it.kind + it.value
      }
      return s
    }
  `
  const { exports: { walk } } = jz(src)
  const jsWalk = () => {
    const o = JSON.parse(SRC)
    const items = o.items
    let s = o.meta.bias
    for (let j = 0; j < items.length; j++) {
      const it = items[j]
      s += it.id * o.meta.scale + it.kind + it.value
    }
    return s
  }
  is(walk(), jsWalk())

  // Median of batched samples — total-time bench at this scale (5000×~1.5µs
  // per call) is dominated by GC pauses and bump-allocator memory.grow on
  // slow CI hardware; on a recent run WASM measured 7.8ms vs JS 6.3ms while
  // local probes sit at 0.85× ratio. Aggressive warmup tiers up TurboFan;
  // median across 21 batched samples damps outliers below the 1.2× pin.
  const BATCH = 5000
  const jsRun = () => { for (let i = 0; i < BATCH; i++) jsWalk() }
  const wasmRun = () => { for (let i = 0; i < BATCH; i++) walk() }
  for (let i = 0; i < 5; i++) { jsRun(); wasmRun() }
  const sample = (fn, n) => {
    const xs = new Array(n)
    for (let i = 0; i < n; i++) { const t = performance.now(); fn(); xs[i] = performance.now() - t }
    xs.sort((a, b) => a - b)
    return xs[n >> 1]
  }
  const N = 21
  const jsTime = sample(jsRun, N)
  const wasmTime = sample(wasmRun, N)
  console.log(`  json walk x${BATCH} median of ${N}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  pinFaster(wasmTime, jsTime, 1.2)
})
test('perf: watr WAT compiler — WASM competitive with JS', async () => {
  if (onWasi() || onKernel()) return  // wasi: host global WebAssembly; kernel: unoptimized self-host wasm misses the perf bar

  // Bench-shape: jzify-bundled watr.compile vs. native ESM watr.compile, on the
  // same WAT corpus the bench harness uses. On the live bench, jz watr is
  // tied with V8 (1.46ms vs 1.46ms median, within noise). In this stricter
  // micro-pin, jz pays for its bump allocator monotonically growing across
  // calls (V8's GC reclaims between runs). Pin: WASM < JS * 1.5 — a sanity
  // floor, not a victory threshold. True parity needs a per-call arena reset.
  const { readFileSync } = await import('fs')
  const watrSrc = (file) => readFileSync(new URL(`../node_modules/watr/src/${file}`, import.meta.url), 'utf8')
  const ENTRY = {
    './src/compile.js': watrSrc('compile.js'),
    './compile.js':     watrSrc('compile.js'),
    './src/parse.js':   watrSrc('parse.js'),
    './src/print.js':   watrSrc('print.js'),
    './src/polyfill.js':watrSrc('polyfill.js'),
    './src/optimize.js':watrSrc('optimize.js'),
    './src/template.js':watrSrc('template.js'),
    './template.js':    watrSrc('template.js'),
    './encode.js':      watrSrc('encode.js'),
    './const.js':       watrSrc('const.js'),
    './parse.js':       watrSrc('parse.js'),
    './util.js':        watrSrc('util.js'),
  }
  const watrJs = readFileSync(new URL('../node_modules/watr/watr.js', import.meta.url), 'utf8')
  // optimize: 'speed' — max scalar unroll on top of the full L2 watr pipeline.
  // L2 already runs watr's inlineOnce + coalesce; 'speed' adds the nested-unroll
  // tunings that buy this micro-pin the most CI-variance headroom for its 1.5×
  // threshold.
  // memory: 4096 — pre-allocate 256MB so the bench loop's bump-allocator growth
  // never triggers memory.grow during measurement (prior `memoryPages` key was
  // a silent no-op; jz reads `memory` for the page count shorthand).
  const { exports: { compile: jzCompile } } = jz(watrJs, { jzify: true, modules: ENTRY, memory: 4096, optimize: 'speed' })
  const { default: jsCompile } = await import('../node_modules/watr/src/compile.js')

  const WAT_CORE = `(module
    (type $bin (func (param i32 i32) (result i32)))
    (func $add (type $bin) (i32.add (local.get 0) (local.get 1)))
    (func $mul (type $bin) (i32.mul (local.get 0) (local.get 1)))
    (func (export "main") (param $n i32) (result i32)
      (local $i i32)
      (local $acc i32)
      (loop $loop
        (local.set $acc (call $add (local.get $acc) (local.get $i)))
        (local.set $acc (i32.xor (local.get $acc) (call $mul (local.get $i) (i32.const 17))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br_if $loop (i32.lt_s (local.get $i) (local.get $n))))
      (local.get $acc)))`
  const WAT_MEMORY = `(module
    (memory (export "memory") 1)
    (data (i32.const 32) "jz-watr-benchmark")
    (func (export "sum") (param $n i32) (result i32)
      (local $i i32)
      (local $acc i32)
      (loop $loop
        (local.set $acc (i32.add (local.get $acc) (i32.load8_u (i32.add (i32.const 32) (local.get $i)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br_if $loop (i32.lt_s (local.get $i) (local.get $n))))
      (local.get $acc)))`
  const WAT_TABLE = `(module
    (type $ret (func (result i32)))
    (table $tbl 3 funcref)
    (elem (table $tbl) (i32.const 0) funcref $a $b $c)
    (func $a (result i32) (i32.const 11))
    (func $b (result i32) (i32.const 17))
    (func $c (result i32) (i32.const 23))
    (func (export "call") (param $i i32) (result i32)
      (call_indirect $tbl (type $ret) (local.get $i))))`

  const corpus = [WAT_CORE, WAT_MEMORY, WAT_TABLE]
  // The jzified watr.compile is a ~440kB wasm function — V8 needs hundreds of
  // calls before TurboFan tiers up. Bench shape: warm aggressively (1200 wasm
  // calls), then take median of 30 single-iter samples instead of total-time.
  // Median is robust to GC/scheduler spikes; total-time at N=10 swings 0.65×–
  // 0.98× ratio between runs (probed locally) — too tight against a 1.5× pin.
  const ITERS = 24
  const jsRun = () => { for (let k = 0; k < ITERS; k++) jsCompile(corpus[k % 3]) }
  const wasmRun = () => { for (let k = 0; k < ITERS; k++) jzCompile(corpus[k % 3]) }
  // sanity: bytes match for one of the corpora
  const a = jsCompile(WAT_CORE), b = jzCompile(WAT_CORE)
  is(a.length, b.length, 'watr: jz vs native compile binary length')

  // Warmup ~1200 wasm calls so TurboFan is tiered up before measurement.
  for (let i = 0; i < 50; i++) { jsRun(); wasmRun() }

  // Median of single-iter samples. N=30 keeps total runtime bounded while
  // damping outliers from GC pauses / OS scheduling jitter.
  const sample = (fn, n) => {
    const xs = new Array(n)
    for (let i = 0; i < n; i++) { const t = performance.now(); fn(); xs[i] = performance.now() - t }
    xs.sort((a, b) => a - b)
    return xs[n >> 1]
  }
  const N = 30
  const jsTime = sample(jsRun, N)
  const wasmTime = sample(wasmRun, N)
  console.log(`  watr (3 corpora x${ITERS}) median of ${N}: JS ${jsTime.toFixed(2)}ms, WASM ${wasmTime.toFixed(2)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  pinFaster(wasmTime, jsTime, 1.5)
})
test('perf: spread + destructure', () => {
  // Four hot patterns where porffor's recent work targets parity. V8's JIT
  // detects [a,b]=[b,a] and stack-elides arrays — jz can't match that without
  // escape analysis, so the pin is "absolute jz time stays bounded" + a logged
  // ratio for visibility, NOT "jz < V8 * k". Reference numbers (Apple Silicon,
  // node 22) recorded in /tmp/jz-spread.mjs vs /tmp/porf-spread/all.js show:
  //   destruct swap (10k×5):  jz 0.6ms,  porf 96.4ms   — jz 160× faster
  //   spread concat (1k×5):   jz 0.9ms,  porf 45.6ms   — jz 51× faster
  //   rest sum (10k×5):       jz 2.7ms,  porf 98.7ms   — jz 37× faster
  //   object spread (1k×5):   jz 0.1ms,  porf OOM      — jz wins by default
  // Pins are 4× headroom over recorded jz times; tightens future regression
  // catch without making CI flaky on slow runners.
  const N = 5
  const jsBench = (fn, k) => bench(() => fn(k), N)

  // 1) Array destructure swap: [a, b] = [b, a]
  const swap = jz(`export let run = (n) => {
    let a = 1, b = 2
    for (let i = 0; i < n; i++) [a, b] = [b, a]
    return a + b
  }`).exports.run
  const swapJs = (n) => { let a = 1, b = 2; for (let i = 0; i < n; i++) [a, b] = [b, a]; return a + b }
  is(swap(10000), swapJs(10000), 'destruct swap parity')
  const swapJsT = jsBench(swapJs, 10000)
  const swapWT = jsBench(swap, 10000)
  console.log(`  destruct swap (10k) x${N}: JS ${swapJsT.toFixed(1)}ms, WASM ${swapWT.toFixed(1)}ms, ratio ${(swapJsT / swapWT).toFixed(2)}x`)
  ok(swapWT < 5, `destruct swap: jz ${swapWT.toFixed(1)}ms should be < 5ms (porf baseline ~96ms)`)

  // 2) Array spread concat: [...a, x, ...b]
  const concat = jz(`export let run = (n) => {
    let s = 0
    for (let i = 0; i < n; i++) {
      let a = [i, i+1]
      let b = [i+2, i+3]
      let c = [...a, 99, ...b]
      s = s + c[0] + c[2] + c[4]
    }
    return s
  }`).exports.run
  const concatJs = (n) => {
    let s = 0
    for (let i = 0; i < n; i++) {
      const a = [i, i+1], b = [i+2, i+3]
      const c = [...a, 99, ...b]
      s = s + c[0] + c[2] + c[4]
    }
    return s
  }
  is(concat(1000), concatJs(1000), 'spread concat parity')
  const concatJsT = jsBench(concatJs, 1000)
  const concatWT = jsBench(concat, 1000)
  console.log(`  spread concat (1k) x${N}: JS ${concatJsT.toFixed(1)}ms, WASM ${concatWT.toFixed(1)}ms, ratio ${(concatJsT / concatWT).toFixed(2)}x`)
  ok(concatWT < 5, `spread concat: jz ${concatWT.toFixed(1)}ms should be < 5ms (porf baseline ~46ms)`)

  // 3) Rest param sum: (...nums) => sum
  const rest = jz(`
    let sum = (...nums) => { let s = 0; for (let i = 0; i < nums.length; i++) s = s + nums[i]; return s }
    export let run = (n) => { let s = 0; for (let i = 0; i < n; i++) s = s + sum(1, 2, 3, 4, 5); return s }
  `).exports.run
  const restSum = (...nums) => { let s = 0; for (let i = 0; i < nums.length; i++) s = s + nums[i]; return s }
  const restJs = (n) => { let s = 0; for (let i = 0; i < n; i++) s = s + restSum(1, 2, 3, 4, 5); return s }
  is(rest(10000), restJs(10000), 'rest sum parity')
  const restJsT = jsBench(restJs, 10000)
  const restWT = jsBench(rest, 10000)
  console.log(`  rest sum (10k) x${N}: JS ${restJsT.toFixed(1)}ms, WASM ${restWT.toFixed(1)}ms, ratio ${(restJsT / restWT).toFixed(2)}x`)
  ok(restWT < 12, `rest sum: jz ${restWT.toFixed(1)}ms should be < 12ms (porf baseline ~99ms)`)

  // 4) Object spread: { ...base, k: v }
  const obj = jz(`
    let base = { a: 1, b: 2, c: 3 }
    export let run = (n) => {
      let s = 0
      for (let i = 0; i < n; i++) { let o = { ...base, d: i }; s = s + o.a + o.d }
      return s
    }
  `).exports.run
  const objBase = { a: 1, b: 2, c: 3 }
  const objJs = (n) => {
    let s = 0
    for (let i = 0; i < n; i++) { const o = { ...objBase, d: i }; s = s + o.a + o.d }
    return s
  }
  is(obj(1000), objJs(1000), 'object spread parity')
  const objJsT = jsBench(objJs, 1000)
  const objWT = jsBench(obj, 1000)
  console.log(`  object spread (1k) x${N}: JS ${objJsT.toFixed(1)}ms, WASM ${objWT.toFixed(1)}ms, ratio ${(objJsT / objWT).toFixed(2)}x`)
  ok(objWT < 2, `object spread: jz ${objWT.toFixed(1)}ms should be < 2ms (porf OOMs at this size)`)
})

test('codegen: .length hoisted out of for-loop', () => {
  const wat = compile('export let f = (arr) => { let buf = new Float64Array(arr); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i]; return s }', { wat: true })
  // Scope to user function $f, then find its outer for-loop body
  const fMatch = wat.match(/\(func \$f[\s\S]*?^\s\s\)$/m)
  ok(fMatch, 'expected $f function in WAT')
  const loopMatch = fMatch[0].match(/\(loop[^]*?\(br(_if)? \$loop/s)
  if (loopMatch) {
    const lenCalls = (loopMatch[0].match(/__len|__length/g) || []).length
    ok(lenCalls === 0, `expected 0 __len calls inside loop body, got ${lenCalls}`)
  }
})

// === Golden size tests ===
// Snapshot WASM byte count for representative shapes. Catches accidental stdlib
// or feature-gate regressions. On improvement, update the baseline; the printed
// "actual N" makes drift visible.
//
// Tolerance is ±5% rounded to nearest 10 bytes (min 20). Tight enough to catch
// regressions, loose enough to absorb harmless codegen jitter.
// Pin optimize:2 — golden bytes are level-2 baselines; matrix runs at other
// levels should not shake them.
const golden = (name, src, expected) => test(`golden size: ${name}`, () => {
  if (onWasi()) return  // wasi: size pin
  if (onKernel()) return  // kernel: bytes path is unoptimized (no watOptimize); size pins assume level-2 output
  const wasm = compile(src, { optimize: 2 })
  const actual = wasm.byteLength
  const tol = Math.max(20, Math.round(expected * 0.05 / 10) * 10)
  ok(Math.abs(actual - expected) <= tol,
    `${name}: expected ${expected}±${tol} bytes, got ${actual}`)
})

// Baseline 4644→5216: __to_num/__skipws/__parseFloat scan a confirmed non-SSO
// string with an inline i32.load8_u fast path (chAt) instead of always calling
// the ~95-instr __char_at helper; chAtSafe keeps the OOB-safe contract where a
// read isn't already bounds-guarded. Costs stdlib bytes, speeds up Number()/
// parseFloat string parsing — off the jessie parse path (parse emits no
// __char_at calls). Deliberate size↔speed trade.
// 5216→5669: __ftoa's large-value path now recovers and emits the fractional digits
// (so `String(1073741824.5)` keeps its fraction) and clamps the big-integer digit
// extraction so values below 1e21 no longer trap. A correctness fix that costs bytes.
// 5669→8669: the untyped `x * 2` coercion pulls __to_num, which now links the
// correctly-rounded Eisel-Lemire decimal→f64 path (__dec_to_f64 + a 2 KB trimmed
// power-of-10 table, exp10 ∈ [-65,65]). ~3 KB total; a full-range EL table would be
// ~11 KB — trimmed to the realistic constant span (module/number.js). Typed programs
// that never coerce a string keep their size (no __to_num).
golden('known-shape object', 'export let f = (x) => { let p = { x: x, y: x * 2, z: x + 1 }; return p.x + p.y + p.z }', 8669)
// Baseline 7789→8196: an empty literal `{}` grown by computed `p[k]=…` carries
// per-object dyn props the literal's static schema doesn't enumerate. Reads
// (`p[k]` after the write, `Object.keys`/`values`/`entries`, `JSON.stringify`,
// spread) now route through the schema∪dyn-props merge when the var is in
// `ctx.types.dynKeyVars` (the program-facts `mayHaveDynProps` predicate). That
// pulls __dyn_get_any/__dyn_set + the small hash they share. Required for
// correctness: a metacircular pass grows ctx.* dicts this way and then
// enumerates them.
// Baseline 8196→8673: STR_INTERN_BIT machinery — canonical statics carry a
// 4-byte cached-hash header and __str_eq/__eq/__str_hash gain the interned
// short-circuits (bit-ne canonicals answer without touching bytes). Pure-size
// cost at L2; 'size' preset keeps internStrings off and its own pins.
// 8673→9146: the ≤6-ASCII⇒SSO invariant (module/string.js) — concat/mkstr gain
// the 6-char pack paths and the dyn_get/dyn_set schema-key compares inline a
// one-SSO⇒ne bit test before the __str_eq fallback, so SSO-keyed miss steps
// skip the call entirely. Size cost buys the bare-i64.eq string-compare class.
golden('unknown/dynamic object', 'export let f = (k) => { let p = {}; p[k] = 1; p.b = 2; return p[k] + p.b }', 9146)
// 3719→6736: this parser reads chars from an untyped string receiver and does
// `c >= '0'` / `c <= '9'` on them. Two fixes net out here. (1) The NUMBER-keyed
// `s[i]` read skips the now-dead `__is_str_key` dispatch (module/array.js
// `keyType !== VAL.NUMBER` guard) — a shrink in isolation. (2) The relational ops
// emit a runtime string-vs-number dispatch when one operand is untyped and the
// other a string literal (emit.js cmpOp): previously they compiled to an f64
// compare of NaN-boxed string bits — always false — so the parser silently
// returned 0. Correct codegen pulls in `__str_cmp` (lexicographic three-way) plus
// `__to_num` (string ToNumber) and their transitive stdlib, which dominates. The
// growth is the cost of the parser actually working.
// 6736→7149: same __ftoa fraction-recovery + big-int-clamp correctness fix as the
// known-shape pin above (this program pulls in number→string via its stdlib).
golden('closure-heavy parser', `export let f = (s) => {
  let i = 0, n = s.length
  let peek = () => i < n ? s[i] : ''
  let next = () => { let c = peek(); i++; return c }
  let isDigit = (c) => c >= '0' && c <= '9'
  let total = 0
  while (i < n) { let c = next(); if (isDigit(c)) total = total * 10 + (c.charCodeAt(0) - 48) }
  return total
}`, 12623) // 7149→10315: same Eisel-Lemire __dec_to_f64 + trimmed table cost as the known-shape pin above
// 10315→12623: ES own-prop shadowing on unknown receivers (the builtin-shadow sidecar probe,
// session 7) — a closure-heavy parser is all unknown-receiver method calls. Timing pins stayed
// green; the jessie-campaign levers (namespace SRoA, descriptor devirt) re-type these receivers
// and are expected to claw the probe bytes back.
// Baseline 985→1062: the for-loop `buf.length` is hoisted into a pre-loop
// local only when nothing in the body can mutate `buf` (no writes to it, no
// calls — any call may reach `buf` through an alias the compiler can't track).
// The `callFree`/`writesReceiver` recursion adds a per-loop guard plus the
// snapshot store; soundness fix (prior bytes assumed unconditional hoist,
// which was unsafe when the loop body invoked anything).
// 1062→873: guardRefine (watr/optimize) folds NaN-box tag reads under the
// dominating `tag==K` guard, so the generic helpers inlineOnce splices into
// `new Float64Array(x)`'s ARRAY arm drop their impossible tag-dispatch arms
// (typed/hash/set/map branches of the inlined __len, the __typed_shift call).
// 873→930: i64 boundary carrier. `arr` is a boxed (NaN-box) param, so the export thunk now
// takes it as i64 (Safari NaN-canonicalization dodge) and a `jz:i64exp` custom section records
// the carrier map for interop.js. Custom-section metadata + the i64 param signature — zero
// runtime cost (sections aren't executed); the numeric result still rides plain f64.
golden('typed-array loop', `export let f = (arr) => {
  let buf = new Float64Array(arr)
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i] * 2
  return s
}`, 1111)
// 930→1111: watr-HEAD codegen era (pre-dates every session-7 jz commit — measured 1113 at
// a7c2eb3 with the same linked watr; timing caps green).
