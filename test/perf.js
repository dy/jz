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

test('perf: mandelbrot — WASM competitive with JS', () => {
  const { exports: { mandelbrot } } = jz('export let mandelbrot = (cx, cy, max) => { let zx = 0, zy = 0, i = 0; while (zx*zx + zy*zy < 4 && i < max) { let tx = zx*zx - zy*zy + cx; zy = 2*zx*zy + cy; zx = tx; i++ } return i }')
  const jsMandelbrot = (cx, cy, max) => { let zx = 0, zy = 0, i = 0; while (zx*zx + zy*zy < 4 && i < max) { let tx = zx*zx - zy*zy + cx; zy = 2*zx*zy + cy; zx = tx; i++ } return i }

  is(mandelbrot(-0.5, 0.5, 100), jsMandelbrot(-0.5, 0.5, 100))
  is(mandelbrot(0, 0, 1000), jsMandelbrot(0, 0, 1000))

  const N = 200000
  const jsTime = bench(() => jsMandelbrot(-0.5, 0.5, 100), N)
  const wasmTime = bench(() => mandelbrot(-0.5, 0.5, 100), N)
  console.log(`  mandelbrot x${N}: JS ${jsTime.toFixed(1)}ms, WASM ${wasmTime.toFixed(1)}ms, ratio ${(jsTime / wasmTime).toFixed(2)}x`)
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
}`, 937)
