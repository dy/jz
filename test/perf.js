// Performance regression tests — jz WASM must be competitive with JS
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import jz, { compile } from '../index.js'

// Helper: time N iterations, return ms
function bench(fn, n) {
  // Warmup
  for (let i = 0; i < Math.min(n, 100); i++) fn()
  const t = performance.now()
  for (let i = 0; i < n; i++) fn()
  return performance.now() - t
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
  ok(wasmTime < jsTime * 1.2, `fib: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 1.2`)
})

test('perf: mandelbrot escape grid — WASM faster than JS', () => {
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
  ok(wasmTime < jsTime * 1.2, `mandelbrot: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 1.2`)
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
  ok(wasmTime < jsTime * 1.2, `typed sum: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 1.2`)
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
  ok(wasmTime < jsTime * 1.2, `biquad: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 1.2`)
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
  ok(wasmTime < jsTime * 1.2, `mat4: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 1.2`)
})

test('perf: poly bimorphic sum — WASM faster than JS', () => {
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
  ok(wasmTime < jsTime * 1.2, `poly: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 1.2`)
})

test('perf: bitwise i32 chain — WASM faster than JS', () => {
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
  ok(wasmTime < jsTime * 1.2, `bitwise: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 1.2`)
})

test('perf: tokenizer scan — WASM faster than JS', () => {
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
  ok(wasmTime < jsTime * 1.2, `tokenizer: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 1.2`)
})

test('perf: callback Array.map — WASM faster than JS', () => {
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
  ok(wasmTime < jsTime * 1.2, `callback: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 1.2`)
})

test('perf: aos object rows — WASM faster than JS', () => {
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
  ok(wasmTime < jsTime * 1.2, `aos: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 1.2`)
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
  const wat = compile('export let f = (arr) => { let buf = new Float64Array(arr); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i]; return s }', { wat: true })
  // .length emits as f64, so i should be f64 to avoid per-iter convert
  const loopMatch = wat.match(/\(loop[^]*?\(br \$loop/s)
  if (loopMatch) {
    const converts = (loopMatch[0].match(/f64\.convert_i32/g) || []).length
    ok(converts === 0, `expected 0 i32->f64 converts inside loop, got ${converts}`)
  }
})

test('codegen: no-arg scalar allocator rewinds heap on return', () => {
  const src = `
    export let f = () => {
      let a = new Float64Array(4)
      a[0] = 7
      return a[0] | 0
    }
  `
  const wat = compile(src, { wat: true, optimize: { watr: false } })
  const body = wat.match(/\(func \$f[\s\S]*?\n  \)/)?.[0] || ''
  ok(/heap_save/.test(body), 'expected heap save local')
  ok(/global\.set \$__heap/.test(body), 'expected heap restore before return')
  const { instance } = jz(src, { optimize: { watr: false } })
  const before = instance.exports._alloc(0)
  for (let i = 0; i < 20; i++) is(instance.exports.f(), 7)
  const after = instance.exports._alloc(0)
  is(after, before, 'heap pointer should be unchanged across rewound scalar calls')
})

test('codegen: loop counter widens to f64 when compared to f64 param', () => {
  const wat = compile('export let f = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s }', { wat: true })
  // When compared against f64 param n, i should be f64 to avoid per-iter convert
  ok(wat.includes('(local $i f64)'), 'loop counter i should be f64 when compared to f64 param')
})

test('codegen: pure scalar function — minimal binary', () => {
  const wasm = compile('export let add = (a, b) => a + b')
  // Pure scalar: no arrays, strings, objects. Should be tiny.
  ok(wasm.byteLength < 150, `pure scalar add should be < 150 bytes, got ${wasm.byteLength}`)
})

test('compile profile reports phase timings', () => {
  const profile = {}
  const wasm = compile('export let add = (a, b) => a + b', { profile })
  ok(wasm.byteLength > 0, 'compile still returns wasm bytes')
  for (const name of ['parse', 'prepare', 'compile', 'plan', 'watrCompile'])
    ok(typeof profile.totals?.[name] === 'number', `expected ${name} timing`)
  ok(profile.totals.compile >= profile.totals.plan, 'compile timing should include plan timing')
})

test('compile profileNames emits wasm function name section', () => {
  const src = 'let helper = (x) => x <= 0 ? 1 : helper(x - 1) + 1; export let add = (a, b) => helper(a) + b'
  const plain = compile(src)
  is(WebAssembly.Module.customSections(new WebAssembly.Module(plain), 'name').length, 0)

  const named = compile(src, { profileNames: true })
  const names = functionNames(named).map(([, name]) => name)
  ok(names.includes('add'), 'exported function name should be present')
  ok(names.includes('helper'), 'internal function name should be present')
})

// === JSON shape inference (shapeStrs) ===
//
// Bench convention writes `let SRC = '{...}'` to defeat compile-time JSON.parse
// folding. shapeStrs preserves shape knowledge across that boundary so the walk
// side gets direct `f64.load offset=N` slot loads instead of falling back to
// `__dyn_get_*`/`__to_num`/`__is_str_key`.

test('codegen: JSON.parse(let SRC) walk uses slot loads — no __dyn_get/__to_num', () => {
  const wat = compile(`
    let SRC = '{"items":[{"id":1,"v":10}],"meta":{"k":7}}'
    export let walk = () => {
      let o = JSON.parse(SRC)
      return o.meta.k + o.items[0].id
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

  const N = 5000
  const jsTime = bench(jsWalk, N)
  const wasmTime = bench(walk, N)
  console.log(`  json walk x${N}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  ok(wasmTime < jsTime * 1.2, `json walk: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 1.2`)
})

test('perf: watr WAT compiler — WASM competitive with JS', async () => {
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
    './src/parse.js':   watrSrc('parse.js'),
    './src/print.js':   watrSrc('print.js'),
    './src/polyfill.js':watrSrc('polyfill.js'),
    './src/optimize.js':watrSrc('optimize.js'),
    './encode.js':      watrSrc('encode.js'),
    './const.js':       watrSrc('const.js'),
    './parse.js':       watrSrc('parse.js'),
    './util.js':        watrSrc('util.js'),
  }
  const watrJs = readFileSync(new URL('../node_modules/watr/watr.js', import.meta.url), 'utf8')
  const { exports: { compile: jzCompile } } = jz(watrJs, { jzify: true, modules: ENTRY, memoryPages: 4096 })
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
  // Mirror bench shape: 24 stages per measurement (matching bench/watr/watr.js
  // N_ITERS=24). Outer N is small because jz's bump allocator grows monotonically
  // across calls (no per-call arena reset yet). The bench medians 21 single-render
  // samples; we approximate by measuring N=10 single-stage iterations so memory
  // pressure stays bench-realistic.
  const ITERS = 24
  const jsRun = () => { for (let k = 0; k < ITERS; k++) jsCompile(corpus[k % 3]) }
  const wasmRun = () => { for (let k = 0; k < ITERS; k++) jzCompile(corpus[k % 3]) }
  // sanity: bytes match for one of the corpora
  const a = jsCompile(WAT_CORE), b = jzCompile(WAT_CORE)
  is(a.length, b.length, 'watr: jz vs native compile binary length')

  const N = 10
  const jsTime = bench(jsRun, N)
  const wasmTime = bench(wasmRun, N)
  console.log(`  watr (3 corpora x${ITERS}) x${N}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
  ok(wasmTime < jsTime * 1.5, `watr: WASM ${wasmTime.toFixed(1)}ms should be < JS ${jsTime.toFixed(1)}ms * 1.5`)
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
const golden = (name, src, expected) => test(`golden size: ${name}`, () => {
  const wasm = compile(src)
  const actual = wasm.byteLength
  const tol = Math.max(20, Math.round(expected * 0.05 / 10) * 10)
  ok(Math.abs(actual - expected) <= tol,
    `${name}: expected ${expected}±${tol} bytes, got ${actual}`)
})

golden('known-shape object', 'export let f = (x) => { let p = { x: x, y: x * 2, z: x + 1 }; return p.x + p.y + p.z }', 4387)
golden('unknown/dynamic object', 'export let f = (k) => { let p = {}; p[k] = 1; p.b = 2; return p[k] + p.b }', 7385)
golden('closure-heavy parser', `export let f = (s) => {
  let i = 0, n = s.length
  let peek = () => i < n ? s[i] : ''
  let next = () => { let c = peek(); i++; return c }
  let isDigit = (c) => c >= '0' && c <= '9'
  let total = 0
  while (i < n) { let c = next(); if (isDigit(c)) total = total * 10 + (c.charCodeAt(0) - 48) }
  return total
}`, 3235)
golden('typed-array loop', `export let f = (arr) => {
  let buf = new Float64Array(arr)
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i] * 2
  return s
}`, 1022)
