// ArrayBuffer (PTR.BUFFER) tests: allocation, JS↔JZ round-trip, typed-array
// interop (subview, reinterpret), .byteLength/.byteOffset, ArrayBuffer.isView,
// buf.slice, DataView aliasing.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'

// === Allocation + byteLength ===

test('new ArrayBuffer(n) — basic allocation + byteLength', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(16)
      return buf.byteLength
    }
  `)
  is(exports.main(), 16)
})

test('ArrayBuffer .byteOffset is 0', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(32)
      return buf.byteOffset
    }
  `)
  is(exports.main(), 0)
})

// === JS → JZ round-trip ===

test('JS ArrayBuffer → JZ — passed in, read byteLength', () => {
  const { exports } = jz(`export let check = (buf) => buf.byteLength`)
  const ab = new ArrayBuffer(24)
  is(exports.check(ab), 24)
})

test('JS DataView → JZ — unwraps underlying buffer', () => {
  const { exports } = jz(`export let check = (buf) => buf.byteLength`)
  const ab = new ArrayBuffer(12)
  const dv = new DataView(ab)
  is(exports.check(dv), 12)
})

// === JZ → JS round-trip ===

test('JZ ArrayBuffer → JS — returns native ArrayBuffer', () => {
  const { exports } = jz(`export let make = () => new ArrayBuffer(40)`)
  const out = exports.make()
  ok(out instanceof ArrayBuffer, 'is ArrayBuffer')
  is(out.byteLength, 40)
})

// === Subview: new TypedArray(buf, offset, length) ===

test('subview — reads aliased bytes from parent at offset', () => {
  // new TypedArray(buf, off, len) is a true view: reads alias the parent buffer.
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(16)
      let dv = new DataView(buf)
      dv.setUint8(2, 33)
      dv.setUint8(3, 44)
      let sub = new Uint8Array(buf, 2, 4)
      return sub[0] * 1000 + sub[1]
    }
  `)
  is(exports.main(), 33044)
})

test('subview — writes alias the parent buffer', () => {
  // Writes to a subview must be visible when reading the same bytes through the parent.
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(16)
      let sub = new Uint8Array(buf, 4, 4)
      sub[0] = 10; sub[1] = 20; sub[2] = 30; sub[3] = 40
      let dv = new DataView(buf)
      return dv.getUint8(4) + dv.getUint8(5) + dv.getUint8(6) + dv.getUint8(7)
    }
  `)
  is(exports.main(), 100)
})

test('subview — parent writes visible through view', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(16)
      let sub = new Uint8Array(buf, 4, 4)
      let dv = new DataView(buf)
      dv.setUint8(4, 1); dv.setUint8(5, 2); dv.setUint8(6, 3); dv.setUint8(7, 4)
      return sub[0] + sub[1] + sub[2] + sub[3]
    }
  `)
  is(exports.main(), 10)
})

test('subview — parent bytes outside window untouched', () => {
  // Regression: previously, new Uint8Array(buf, off, len) placed a header at
  // (off - 8), clobbering parent buffer bytes. Descriptor-backed views no longer write
  // into parent memory, so surrounding bytes must stay intact.
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(16)
      let a = new Uint8Array(buf)
      a[6] = 99; a[7] = 100
      let sub = new Uint8Array(buf, 8, 4)
      return a[6] + a[7]
    }
  `)
  is(exports.main(), 199)
})

test('subview — .byteOffset returns offset into parent', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(32)
      let sub = new Uint32Array(buf, 8, 4)
      return sub.byteOffset
    }
  `)
  is(exports.main(), 8)
})

test('subview — .byteLength returns view byte count', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(32)
      let sub = new Uint32Array(buf, 8, 4)
      return sub.byteLength
    }
  `)
  is(exports.main(), 16)  // 4 × 4-byte ints
})

test('subview — .length returns view element count', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(32)
      let sub = new Uint32Array(buf, 8, 4)
      return sub.length
    }
  `)
  is(exports.main(), 4)
})

test('subview — .buffer returns the parent ArrayBuffer', () => {
  // sub.buffer must return a BUFFER whose byteLength matches the parent, not the view.
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(32)
      let sub = new Uint32Array(buf, 8, 4)
      return sub.buffer.byteLength
    }
  `)
  is(exports.main(), 32)
})

test('subview — stride respected for non-byte element types', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(32)
      let sub = new Uint32Array(buf, 8, 4)
      sub[0] = 0x11223344; sub[3] = 0x55667788
      let dv = new DataView(buf)
      // Little-endian: byte 8 = 0x44, byte 20 = 0x88
      return dv.getUint8(8) * 1000 + dv.getUint8(20)
    }
  `)
  is(exports.main(), 68 * 1000 + 136)  // 0x44=68, 0x88=136
})

// === Reinterpret: new TypedArray(buf) ===

test('reinterpret — Uint8Array from fresh ArrayBuffer', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(8)
      let view = new Uint8Array(buf)
      return view.length
    }
  `)
  is(exports.main(), 8)
})

test('reinterpret — Uint32Array length = byteLength / 4', () => {
  // Regression: previously, new Uint32Array(buf) used buf.length directly,
  // yielding wrong length for multi-byte stride. Now divides by stride.
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(16)
      let view = new Uint32Array(buf)
      return view.length
    }
  `)
  is(exports.main(), 4)
})

test('reinterpret — Float64Array length = byteLength / 8', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(32)
      let view = new Float64Array(buf)
      return view.length
    }
  `)
  is(exports.main(), 4)
})

// === .buffer accessor ===

test('.buffer — from typed array returns an ArrayBuffer', () => {
  const { exports } = jz(`
    export let main = () => {
      let arr = new Uint32Array(4)
      arr[0] = 1; arr[1] = 2; arr[2] = 3; arr[3] = 4
      let buf = arr.buffer
      return buf.byteLength
    }
  `)
  is(exports.main(), 16)  // 4 elements × 4 bytes
})

test('.buffer — from DataView is the underlying BUFFER', () => {
  const { exports } = jz(`
    export let main = () => {
      let ab = new ArrayBuffer(24)
      let dv = new DataView(ab)
      return dv.buffer.byteLength
    }
  `)
  is(exports.main(), 24)
})

// === ArrayBuffer.isView ===

test('ArrayBuffer.isView — typed array is a view', () => {
  const { exports } = jz(`
    export let main = () => {
      let arr = new Uint8Array(8)
      return ArrayBuffer.isView(arr)
    }
  `)
  is(exports.main(), 1)
})

test('ArrayBuffer.isView — plain ArrayBuffer is NOT a view', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(8)
      return ArrayBuffer.isView(buf)
    }
  `)
  is(exports.main(), 0)
})

test('ArrayBuffer.isView — plain array is NOT a view', () => {
  const { exports } = jz(`
    export let main = () => {
      let arr = [1, 2, 3]
      return ArrayBuffer.isView(arr)
    }
  `)
  is(exports.main(), 0)
})

// === buf.slice ===

test('buf.slice(begin, end) — basic byte-range copy', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(16)
      let dv = new DataView(buf)
      dv.setUint8(0, 10); dv.setUint8(1, 20); dv.setUint8(2, 30); dv.setUint8(3, 40)
      dv.setUint8(4, 50); dv.setUint8(5, 60); dv.setUint8(6, 70); dv.setUint8(7, 80)
      let sub = buf.slice(2, 6)
      let sd = new DataView(sub)
      return sub.byteLength * 1000000 + sd.getUint8(0) * 1000 + sd.getUint8(3)
    }
  `)
  // byteLength=4, sd[0]=30, sd[3]=60 → 4000000 + 30000 + 60 = 4030060
  is(exports.main(), 4030060)
})

test('buf.slice() — no args returns full copy', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(8)
      let view = new Uint8Array(buf)
      view[0] = 7
      let copy = buf.slice()
      return copy.byteLength
    }
  `)
  is(exports.main(), 8)
})

test('buf.slice — modifying copy does not affect original', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(4)
      let view = new Uint8Array(buf)
      view[0] = 42
      let copy = buf.slice()
      let cv = new Uint8Array(copy)
      cv[0] = 99
      return view[0]
    }
  `)
  is(exports.main(), 42)
})

// === DataView aliasing (retains byte-level aliasing) ===

test('DataView — reads typed array bytes from same buffer', () => {
  // DataView is a passthrough of BUFFER, so aliasing works via shared memory.
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(4)
      let u8 = new Uint8Array(buf)
      u8[0] = 0xAA; u8[1] = 0xBB; u8[2] = 0xCC; u8[3] = 0xDD
      // DataView unchanged passthrough can be used for byteLength
      let dv = new DataView(buf)
      return dv.byteLength
    }
  `)
  is(exports.main(), 4)
})

// === Zero-copy aliasing: reinterpret shares underlying storage ===

test('aliasing — typed array view writes visible through DataView', () => {
  // new Uint8Array(buf) is a zero-copy reinterpret. Writes to the view must
  // appear when the same bytes are read back via a DataView on the same buffer.
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(4)
      let u8 = new Uint8Array(buf)
      u8[0] = 7; u8[1] = 9
      let dv = new DataView(buf)
      return dv.getUint8(0) * 100 + dv.getUint8(1)
    }
  `)
  is(exports.main(), 709)
})

test('aliasing — DataView writes visible through reinterpret typed array', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(4)
      let dv = new DataView(buf)
      dv.setUint8(0, 11); dv.setUint8(3, 22)
      let u8 = new Uint8Array(buf)
      return u8[0] * 100 + u8[3]
    }
  `)
  is(exports.main(), 1122)
})

test('aliasing — different typed array views on same buffer share bytes', () => {
  // Uint32 write, read back little-endian via Uint8 view: byte 0 = low byte.
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(4)
      let u32 = new Uint32Array(buf)
      u32[0] = 0xDEADBEEF
      let u8 = new Uint8Array(buf)
      return u8[0]
    }
  `)
  is(exports.main(), 0xEF)
})

test('aliasing — .buffer on typed array is the same storage', () => {
  // arr.buffer returns an aliased BUFFER pointing at arr's data. Writes via
  // a DataView constructed from .buffer must be visible through arr.
  const { exports } = jz(`
    export let main = () => {
      let arr = new Uint8Array(4)
      arr[0] = 1; arr[1] = 2
      let buf = arr.buffer
      let dv = new DataView(buf)
      dv.setUint8(2, 77)
      return arr[0] + arr[1] + arr[2]
    }
  `)
  is(exports.main(), 80)
})

test('aliasing — typed-array .byteLength matches parent buffer', () => {
  const { exports } = jz(`
    export let main = () => {
      let buf = new ArrayBuffer(16)
      let u32 = new Uint32Array(buf)
      return u32.byteLength * 1000 + u32.length
    }
  `)
  is(exports.main(), 16004)  // byteLength=16, length=4
})
