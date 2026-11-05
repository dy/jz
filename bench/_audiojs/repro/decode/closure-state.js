// Class: a reader object from a factory, { unary, read }, whose methods are closures over mutable
// integer state (pos, cache, n). Each call goes through call_indirect with the boxed closure ABI;
// the captured lets live in f64 heap cells, loaded, truncated, converted and stored on every call.
// TTA: makeBits(bytes) → br.unary(), br.read(k) per sample. Controls: the same reader on module-level
// lets with plain functions; the same reader as one function with its state in locals.
const B = new Uint8Array(1 << 20)
for (let i = 0, x = 1; i < B.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; B[i] = x >>> 24 }
function makeBits(buf) {
  let pos = 0, cache = 0, n = 0
  function fill() { cache = (cache | (buf[pos++] << n)) >>> 0; n += 8 }
  function bit() { if (!n) fill(); let b = cache & 1; cache >>>= 1; n--; return b }
  function unary() { let c = 0; while (bit()) c++; return c }
  function read(k) { if (!k) return 0; while (n < k) fill(); let v = (cache & ((1 << k) - 1)) >>> 0; cache = (cache >>> k) >>> 0; n -= k; return v }
  return { unary, read }
}
export function closures() { let br = makeBits(B), s = 0; for (let i = 0; i < 1500000; i++) { let u = br.unary(); s = (s + (u << 3) + br.read(3)) | 0 } return s }

let gbuf = B, gpos = 0, gcache = 0, gn = 0
function gfill() { gcache = (gcache | (gbuf[gpos++] << gn)) >>> 0; gn += 8 }
function gbit() { if (!gn) gfill(); let b = gcache & 1; gcache >>>= 1; gn--; return b }
function gunary() { let c = 0; while (gbit()) c++; return c }
function gread(k) { if (!k) return 0; while (gn < k) gfill(); let v = (gcache & ((1 << k) - 1)) >>> 0; gcache = (gcache >>> k) >>> 0; gn -= k; return v }
export function globals() { gpos = 0; gcache = 0; gn = 0; let s = 0; for (let i = 0; i < 1500000; i++) { let u = gunary(); s = (s + (u << 3) + gread(3)) | 0 } return s }

export function locals() {
  let buf = B, pos = 0, cache = 0, n = 0, s = 0
  for (let i = 0; i < 1500000; i++) {
    let u = 0
    for (;;) { if (!n) { cache = (cache | (buf[pos++] << n)) >>> 0; n += 8 } let b = cache & 1; cache >>>= 1; n--; if (!b) break; u++ }
    while (n < 3) { cache = (cache | (buf[pos++] << n)) >>> 0; n += 8 }
    let v = (cache & 7) >>> 0; cache = (cache >>> 3) >>> 0; n -= 3
    s = (s + (u << 3) + v) | 0
  }
  return s
}
