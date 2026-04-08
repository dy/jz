import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'

function run(code) {
  const wasm = compile(code)
  return new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports
}

// === Array.from ===

test('Array.from - shallow copy', () => {
  is(run('export let main = () => { let a = [1,2,3]; let b = Array.from(a); return b[0]+b[1]+b[2] }').main(), 6)
})

test('Array.from - independent copy', () => {
  is(run('export let main = () => { let a = [1,2,3]; let b = Array.from(a); b[0] = 99; return a[0] }').main(), 1)
})

test('Array.from - length preserved', () => {
  is(run('export let main = () => { let a = [10,20,30,40]; return Array.from(a).length }').main(), 4)
})

// === SIMD Float64Array (f64x2 — 2 elements per vector) ===

test('SIMD f64x2 - map multiply', () => {
  is(run(`export let main = () => {
    let buf = new Float64Array(8)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4; buf[4]=5; buf[5]=6; buf[6]=7; buf[7]=8
    let r = buf.map(x => x * 2)
    return r[0] + r[3] + r[7]
  }`).main(), 26) // 2+8+16
})

test('SIMD f64x2 - map add', () => {
  is(run(`export let main = () => {
    let buf = new Float64Array(4)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4
    let r = buf.map(x => x + 10)
    return r[0] + r[3]
  }`).main(), 25) // 11+14
})

test('SIMD f64x2 - map divide', () => {
  is(run(`export let main = () => {
    let buf = new Float64Array(4)
    buf[0]=2; buf[1]=4; buf[2]=6; buf[3]=8
    let r = buf.map(x => x / 2)
    return r[0] + r[1] + r[2] + r[3]
  }`).main(), 10)
})

test('SIMD f64x2 - odd length (remainder)', () => {
  is(run(`export let main = () => {
    let buf = new Float64Array(5)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4; buf[4]=5
    let r = buf.map(x => x * 3)
    return r[4]
  }`).main(), 15)
})

// === SIMD Float32Array (f32x4 — 4 elements per vector) ===

test('SIMD f32x4 - map multiply', () => {
  is(run(`export let main = () => {
    let buf = new Float32Array(8)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4; buf[4]=5; buf[5]=6; buf[6]=7; buf[7]=8
    let r = buf.map(x => x * 2)
    return r[0]+r[1]+r[2]+r[3]+r[4]+r[5]+r[6]+r[7]
  }`).main(), 72) // 2+4+6+8+10+12+14+16
})

test('SIMD f32x4 - map with remainder', () => {
  is(run(`export let main = () => {
    let buf = new Float32Array(6)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4; buf[4]=5; buf[5]=6
    let r = buf.map(x => x + 10)
    return r[0]+r[1]+r[2]+r[3]+r[4]+r[5]
  }`).main(), 81) // 11+12+13+14+15+16
})

// === SIMD Int32Array (i32x4 — 4 elements per vector) ===

test('SIMD i32x4 - map multiply', () => {
  is(run(`export let main = () => {
    let buf = new Int32Array(8)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4; buf[4]=5; buf[5]=6; buf[6]=7; buf[7]=8
    let r = buf.map(x => x * 3)
    return r[0]+r[1]+r[2]+r[3]+r[4]+r[5]+r[6]+r[7]
  }`).main(), 108)
})

test('SIMD i32x4 - map add', () => {
  is(run(`export let main = () => {
    let buf = new Int32Array(4)
    buf[0]=10; buf[1]=20; buf[2]=30; buf[3]=40
    let r = buf.map(x => x + 5)
    return r[0]+r[1]+r[2]+r[3]
  }`).main(), 120)
})

test('SIMD i32x4 - bitwise AND', () => {
  is(run(`export let main = () => {
    let buf = new Int32Array(4)
    buf[0]=255; buf[1]=170; buf[2]=85; buf[3]=65280
    let r = buf.map(x => x & 240)
    return r[0]+r[1]+r[2]+r[3]
  }`).main(), 480)
})

test('SIMD i32x4 - shift left', () => {
  is(run(`export let main = () => {
    let buf = new Int32Array(4)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4
    let r = buf.map(x => x << 2)
    return r[0]+r[1]+r[2]+r[3]
  }`).main(), 40)
})

test('SIMD i32x4 - with remainder', () => {
  is(run(`export let main = () => {
    let buf = new Int32Array(6)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4; buf[4]=5; buf[5]=6
    let r = buf.map(x => x * 10)
    return r[0]+r[1]+r[2]+r[3]+r[4]+r[5]
  }`).main(), 210)
})

// === SIMD Uint32Array ===

test('SIMD u32x4 - map multiply', () => {
  is(run(`export let main = () => {
    let buf = new Uint32Array(8)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4; buf[4]=5; buf[5]=6; buf[6]=7; buf[7]=8
    let r = buf.map(x => x * 2)
    return r[0]+r[1]+r[2]+r[3]+r[4]+r[5]+r[6]+r[7]
  }`).main(), 72)
})

// === TypedArray type-aware indexing ===

test('Int32Array - type-aware read/write', () => {
  is(run(`export let main = () => {
    let buf = new Int32Array(3)
    buf[0] = 100; buf[1] = 200; buf[2] = 300
    return buf[0] + buf[1] + buf[2]
  }`).main(), 600)
})

test('Float32Array - type-aware read/write', () => {
  const r = run(`export let main = () => {
    let buf = new Float32Array(2)
    buf[0] = 1.5; buf[1] = 2.5
    return buf[0] + buf[1]
  }`).main()
  ok(Math.abs(r - 4) < 0.01, `Expected ~4, got ${r}`)
})

// === TypedArray.from ===

test('Uint8Array.from: basic', () => {
  is(run(`export let main = () => {
    let a = Uint8Array.from([65, 66, 67])
    return a[0] + a[1] + a[2]
  }`).main(), 198)
})

test('Int32Array.from: basic', () => {
  is(run(`export let main = () => {
    let a = Int32Array.from([10, 20, 30])
    return a.length
  }`).main(), 3)
})

test('Float64Array.from: preserves values', () => {
  const r = run(`export let main = () => {
    let a = Float64Array.from([1.5, 2.5, 3.5])
    return a[0] + a[2]
  }`).main()
  ok(Math.abs(r - 5) < 0.01)
})

// === Uint32Array full range ===

test('Uint32Array - large values (> 2^31)', () => {
  is(run(`export let main = () => {
    let buf = new Uint32Array(2)
    buf[0] = 3000000000
    buf[1] = 4000000000
    return buf[0]
  }`).main(), 3000000000)
})

// === TypedArray.map scalar fallback (non-SIMD types) ===

test('Int16Array.map scalar fallback', () => {
  is(run(`export let main = () => {
    let buf = new Int16Array(3)
    buf[0] = 1; buf[1] = 2; buf[2] = 3
    let r = buf.map(x => x + 5)
    return r[0] + r[1] + r[2]
  }`).main(), 21)  // 6+7+8
})

test('Uint8Array.map scalar fallback', () => {
  is(run(`export let main = () => {
    let buf = new Uint8Array(4)
    buf[0] = 10; buf[1] = 20; buf[2] = 30; buf[3] = 40
    let r = buf.map(x => x * 2)
    return r[0] + r[3]
  }`).main(), 100)  // 20+80
})

// === Chained typed-array indexing (expression, not named var) ===

test('Int16Array.map chained index', () => {
  is(run(`export let main = () => {
    let buf = new Int16Array(3)
    buf[0] = 8; buf[1] = 9; buf[2] = 10
    return buf.map(x => x + 1)[1]
  }`).main(), 10)
})

// Verify SIMD generates v128 instructions
test('SIMD - generates v128 instructions', () => {
  const wat = compile(`export let main = () => {
    let buf = new Float64Array(4)
    buf[0]=1; buf[1]=2; buf[2]=3; buf[3]=4
    let r = buf.map(x => x * 2)
    return r[0]
  }`, { wat: true })
  ok(wat.includes('v128.load'), 'should contain v128.load')
  ok(wat.includes('f64x2.mul'), 'should contain f64x2.mul')
  ok(wat.includes('v128.store'), 'should contain v128.store')
})
