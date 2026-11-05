// PCM-family gap classes as minimal kernels (k*) beside their controls (c*), each called with interleaved stereo bytes.
// Same file runs under V8 and through jz. Input: interleaved stereo bytes from the host.

// ── G1: typed array made by `new T(...)` with T a parameter (decode-wav samples()) ──
function samples(raw, T, n) { return new T(raw.buffer, raw.byteOffset, n) }
export function k1(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: nCh } = hdr, n = raw.length >> 1, frames = n / nCh | 0
  let s = samples(raw, Uint16Array, n), ch = [new Float32Array(frames), new Float32Array(frames)]
  for (let c = 0; c < nCh; c++) for (let x = ch[c], i = 0, k = c; i < frames; i++, k += nCh) x[i] = (s[k] << 16 >> 16) / 32768
  return ch
}
export function c1(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: nCh } = hdr, n = raw.length >> 1, frames = n / nCh | 0
  let s = new Uint16Array(raw.buffer, raw.byteOffset, n), ch = [new Float32Array(frames), new Float32Array(frames)]
  for (let c = 0; c < nCh; c++) for (let x = ch[c], i = 0, k = c; i < frames; i++, k += nCh) x[i] = (s[k] << 16 >> 16) / 32768
  return ch
}
// float32 form: the constructor chosen by a conditional (decode-wav float32/64)
export function k1f(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: nCh, bitDepth } = hdr, n = raw.length >> 2, frames = n / nCh | 0
  let s = samples(raw, bitDepth === 64 ? Float64Array : Float32Array, n), ch = [new Float32Array(frames), new Float32Array(frames)]
  for (let c = 0; c < nCh; c++) for (let x = ch[c], i = 0, k = c; i < frames; i++, k += nCh) x[i] = s[k]
  return ch
}
export function c1f(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: nCh } = hdr, n = raw.length >> 2, frames = n / nCh | 0
  let s = new Float32Array(raw.buffer, raw.byteOffset, n), ch = [new Float32Array(frames), new Float32Array(frames)]
  for (let c = 0; c < nCh; c++) for (let x = ch[c], i = 0, k = c; i < frames; i++, k += nCh) x[i] = s[k]
  return ch
}
// G1 control without the stride counter: index computed from i (isolates G2)
export function c1i(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: nCh } = hdr, n = raw.length >> 1, frames = n / nCh | 0
  let s = new Uint16Array(raw.buffer, raw.byteOffset, n), ch = [new Float32Array(frames), new Float32Array(frames)]
  for (let c = 0; c < nCh; c++) for (let x = ch[c], i = 0; i < frames; i++) x[i] = (s[i * nCh + c] << 16 >> 16) / 32768
  return ch
}

// ── G3: running byte offset stepped in the inner loop, declared by the outer one (decode-caf) ──
export function k3(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: ch, flags } = hdr, isLE = flags & 2, framesCount = (raw.length / 4 / ch) | 0
  let dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  let channelData = Array.from({ length: ch }, () => new Float32Array(framesCount))
  for (let i = 0, off = 0; i < framesCount; i++)
    for (let c = 0; c < ch; c++, off += 4)
      channelData[c][i] = dv.getFloat32(off, !!isLE)
  return channelData
}
export function c3(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: ch, flags } = hdr, isLE = flags & 2, framesCount = (raw.length / 4 / ch) | 0
  let dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  let channelData = Array.from({ length: ch }, () => new Float32Array(framesCount))
  for (let i = 0; i < framesCount; i++)
    for (let c = 0; c < ch; c++)
      channelData[c][i] = dv.getFloat32((i * ch + c) * 4, !!isLE)
  return channelData
}
// G4 control: channel-major, one channel array per outer iteration
export function c3c(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: ch, flags } = hdr, isLE = flags & 2, framesCount = (raw.length / 4 / ch) | 0
  let dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  let channelData = Array.from({ length: ch }, () => new Float32Array(framesCount))
  for (let c = 0; c < ch; c++) { let x = channelData[c]; for (let i = 0; i < framesCount; i++) x[i] = dv.getFloat32((i * ch + c) * 4, !!isLE) }
  return channelData
}

// ── G5: callee reached with a subarray view at one site, an owned array at another (decode-aiff) ──
function pcmBE(b, p, channels, frames, nCh) {
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nCh; c++) {
      let v = (b[p] << 8) | b[p + 1]; p += 2
      channels[c][i] = (v > 32767 ? v - 65536 : v) / 32768
    }
}
export function k5(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { nCh } = hdr, frames = Math.floor(raw.length / (2 * nCh))
  let channelData = Array.from({ length: nCh }, () => new Float32Array(frames))
  pcmBE(raw.subarray(0, frames * 2 * nCh), 0, channelData, frames, nCh)
  return channelData
}
export function c5(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { nCh } = hdr, frames = Math.floor(raw.length / (2 * nCh))
  let channelData = Array.from({ length: nCh }, () => new Float32Array(frames))
  pcmBE(raw, 0, channelData, frames, nCh)
  return channelData
}
// G3 on bytes: same callee shape, offset computed instead of stepped
function pcmBEi(b, p, channels, frames, nCh) {
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nCh; c++) {
      let q = p + (i * nCh + c) * 2, v = (b[q] << 8) | b[q + 1]
      channels[c][i] = (v > 32767 ? v - 65536 : v) / 32768
    }
}
export function c5i(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { nCh } = hdr, frames = Math.floor(raw.length / (2 * nCh))
  let channelData = Array.from({ length: nCh }, () => new Float32Array(frames))
  pcmBEi(raw.subarray(0, frames * 2 * nCh), 0, channelData, frames, nCh)
  return channelData
}

// ── G6: per-sample arrow closure over typed state + an array-of-arrays table (decode-wav ms-adpcm) ──
const ADAPT = new Int16Array([230,230,230,230,307,409,512,614,768,614,512,409,307,230,230,230])
const COEFS = [[256,0],[512,-256],[0,0],[192,64],[240,0],[460,-208],[392,-232]]
export function k6(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: nCh, coefs } = hdr, n = raw.length, out = [new Float32Array(n), new Float32Array(n)]
  let predIdx = new Int32Array(nCh), delta = new Int32Array(nCh).fill(16), s1 = new Int32Array(nCh), s2 = new Int32Array(nCh)
  for (let c = 0; c < nCh; c++) predIdx[c] = c + 1
  let expand = (nib, c) => {
    let signed = nib >= 8 ? nib - 16 : nib
    let co = coefs[predIdx[c]]
    let pr = (s1[c] * co[0] + s2[c] * co[1]) >> 8
    pr += signed * delta[c]
    if (pr > 32767) pr = 32767; else if (pr < -32768) pr = -32768
    s2[c] = s1[c]; s1[c] = pr
    delta[c] = (ADAPT[nib] * delta[c]) >> 8
    if (delta[c] < 16) delta[c] = 16
    return pr / 32768
  }
  for (let p = 0; p < n; p++) { let byte = raw[p]; out[0][p] = expand(byte >> 4, 0); out[1][p] = expand(byte & 0x0F, 1) }
  return out
}
// control a: the table flat in an Int16Array (pair per predictor), the closure kept
export function c6a(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: nCh, coefs } = hdr, n = raw.length, out = [new Float32Array(n), new Float32Array(n)]
  let flat = new Int16Array(coefs.length * 2)
  for (let j = 0; j < coefs.length; j++) { flat[2 * j] = coefs[j][0]; flat[2 * j + 1] = coefs[j][1] }
  let predIdx = new Int32Array(nCh), delta = new Int32Array(nCh).fill(16), s1 = new Int32Array(nCh), s2 = new Int32Array(nCh)
  for (let c = 0; c < nCh; c++) predIdx[c] = c + 1
  let expand = (nib, c) => {
    let signed = nib >= 8 ? nib - 16 : nib
    let q = predIdx[c] * 2
    let pr = (s1[c] * flat[q] + s2[c] * flat[q + 1]) >> 8
    pr += signed * delta[c]
    if (pr > 32767) pr = 32767; else if (pr < -32768) pr = -32768
    s2[c] = s1[c]; s1[c] = pr
    delta[c] = (ADAPT[nib] * delta[c]) >> 8
    if (delta[c] < 16) delta[c] = 16
    return pr / 32768
  }
  for (let p = 0; p < n; p++) { let byte = raw[p]; out[0][p] = expand(byte >> 4, 0); out[1][p] = expand(byte & 0x0F, 1) }
  return out
}
// control b: the same body as a module function (no closure), array-of-arrays table kept
function expandFn(nib, c, coefs, predIdx, s1, s2, delta) {
  let signed = nib >= 8 ? nib - 16 : nib
  let co = coefs[predIdx[c]]
  let pr = (s1[c] * co[0] + s2[c] * co[1]) >> 8
  pr += signed * delta[c]
  if (pr > 32767) pr = 32767; else if (pr < -32768) pr = -32768
  s2[c] = s1[c]; s1[c] = pr
  delta[c] = (ADAPT[nib] * delta[c]) >> 8
  if (delta[c] < 16) delta[c] = 16
  return pr / 32768
}
export function c6b(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: nCh, coefs } = hdr, n = raw.length, out = [new Float32Array(n), new Float32Array(n)]
  let predIdx = new Int32Array(nCh), delta = new Int32Array(nCh).fill(16), s1 = new Int32Array(nCh), s2 = new Int32Array(nCh)
  for (let c = 0; c < nCh; c++) predIdx[c] = c + 1
  for (let p = 0; p < n; p++) { let byte = raw[p]; out[0][p] = expandFn(byte >> 4, 0, coefs, predIdx, s1, s2, delta); out[1][p] = expandFn(byte & 0x0F, 1, coefs, predIdx, s1, s2, delta) }
  return out
}
// control c: coefs a module constant instead of a record field
export function c6c(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: nCh } = hdr, coefs = COEFS, n = raw.length, out = [new Float32Array(n), new Float32Array(n)]
  let predIdx = new Int32Array(nCh), delta = new Int32Array(nCh).fill(16), s1 = new Int32Array(nCh), s2 = new Int32Array(nCh)
  for (let c = 0; c < nCh; c++) predIdx[c] = c + 1
  let expand = (nib, c) => {
    let signed = nib >= 8 ? nib - 16 : nib
    let co = coefs[predIdx[c]]
    let pr = (s1[c] * co[0] + s2[c] * co[1]) >> 8
    pr += signed * delta[c]
    if (pr > 32767) pr = 32767; else if (pr < -32768) pr = -32768
    s2[c] = s1[c]; s1[c] = pr
    delta[c] = (ADAPT[nib] * delta[c]) >> 8
    if (delta[c] < 16) delta[c] = 16
    return pr / 32768
  }
  for (let p = 0; p < n; p++) { let byte = raw[p]; out[0][p] = expand(byte >> 4, 0); out[1][p] = expand(byte & 0x0F, 1) }
  return out
}
export { COEFS }
// The header record, read from the bytes as a decoder reads it (host sets bytes 0..3).
function parse(raw) {
  let ch = raw[0] | raw[1] << 8
  return { channels: ch, nCh: ch, flags: raw[2], bitDepth: raw[5] === 7 ? 64 : 32, coefs: raw[3] ? [[raw[4], raw[5]]] : COEFS }
}

// ── narrowing G5: the pcmBE loop inline (channels local), and with two local channel arrays ──
export function c5L(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { nCh } = hdr, frames = Math.floor(raw.length / (2 * nCh)), b = raw, p = 0
  let channels = Array.from({ length: nCh }, () => new Float32Array(frames))
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nCh; c++) {
      let v = (b[p] << 8) | b[p + 1]; p += 2
      channels[c][i] = (v > 32767 ? v - 65536 : v) / 32768
    }
  return channels
}
export function c5S(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { nCh } = hdr, frames = Math.floor(raw.length / (2 * nCh)), b = raw, p = 0
  let channels = Array.from({ length: nCh }, () => new Float32Array(frames))
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nCh; c++) {
      let v = (b[p] << 8) | b[p + 1]; p += 2
      channels[c][i] = (v << 16 >> 16) / 32768
    }
  return channels
}
// one callee, one caller: is it the param ABI?
function pcmBE1(b, p, channels, frames, nCh) {
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nCh; c++) {
      let v = (b[p] << 8) | b[p + 1]; p += 2
      channels[c][i] = (v > 32767 ? v - 65536 : v) / 32768
    }
}
export function c5one(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { nCh } = hdr, frames = Math.floor(raw.length / (2 * nCh))
  let channelData = Array.from({ length: nCh }, () => new Float32Array(frames))
  pcmBE1(raw, 0, channelData, frames, nCh)
  return channelData
}

// ── narrowing G6: no closure, no state arrays: the predictor in locals ──
export function c6d(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { coefs } = hdr, n = raw.length, L = new Float32Array(n), R = new Float32Array(n)
  let a0 = coefs[1][0], a1 = coefs[1][1], b0 = coefs[2][0], b1 = coefs[2][1]
  let s1a = 0, s2a = 0, da = 16, s1b = 0, s2b = 0, db = 16
  for (let p = 0; p < n; p++) {
    let byte = raw[p], nib = byte >> 4, sg = nib >= 8 ? nib - 16 : nib
    let pr = ((s1a * a0 + s2a * a1) >> 8) + sg * da
    if (pr > 32767) pr = 32767; else if (pr < -32768) pr = -32768
    s2a = s1a; s1a = pr; da = (ADAPT[nib] * da) >> 8; if (da < 16) da = 16
    L[p] = pr / 32768
    nib = byte & 15; sg = nib >= 8 ? nib - 16 : nib
    pr = ((s1b * b0 + s2b * b1) >> 8) + sg * db
    if (pr > 32767) pr = 32767; else if (pr < -32768) pr = -32768
    s2b = s1b; s1b = pr; db = (ADAPT[nib] * db) >> 8; if (db < 16) db = 16
    R[p] = pr / 32768
  }
  return [L, R]
}
// closure kept, output to two locals instead of out[0][p]
export function c6e(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: nCh, coefs } = hdr, n = raw.length, L = new Float32Array(n), R = new Float32Array(n)
  let predIdx = new Int32Array(nCh), delta = new Int32Array(nCh).fill(16), s1 = new Int32Array(nCh), s2 = new Int32Array(nCh)
  for (let c = 0; c < nCh; c++) predIdx[c] = c + 1
  let expand = (nib, c) => {
    let signed = nib >= 8 ? nib - 16 : nib
    let co = coefs[predIdx[c]]
    let pr = (s1[c] * co[0] + s2[c] * co[1]) >> 8
    pr += signed * delta[c]
    if (pr > 32767) pr = 32767; else if (pr < -32768) pr = -32768
    s2[c] = s1[c]; s1[c] = pr
    delta[c] = (ADAPT[nib] * delta[c]) >> 8
    if (delta[c] < 16) delta[c] = 16
    return pr / 32768
  }
  for (let p = 0; p < n; p++) { let byte = raw[p]; L[p] = expand(byte >> 4, 0); R[p] = expand(byte & 0x0F, 1) }
  return [L, R]
}
// float copy with computed index (G2 on the float path)
export function c1fi(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: nCh } = hdr, n = raw.length >> 2, frames = n / nCh | 0
  let s = new Float32Array(raw.buffer, raw.byteOffset, n), ch = [new Float32Array(frames), new Float32Array(frames)]
  for (let c = 0; c < nCh; c++) for (let x = ch[c], i = 0; i < frames; i++) x[i] = s[i * nCh + c]
  return ch
}

// ── real bodies, verbatim: decode-wav samples(), decode-caf decodeLPCM() ──
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
function samplesR(raw, T, n) {
	let w = T.BYTES_PER_ELEMENT, len = n * w
	if (!LE) {
		let b = new Uint8Array(len)
		for (let i = 0; i < len; i += w) for (let j = 0; j < w; j++) b[i + j] = raw[i + w - 1 - j]
		raw = b
	} else if (raw.byteOffset % w) raw = raw.slice(0, len)
	return new T(raw.buffer, raw.byteOffset, n)
}
function decodeLPCM(data, flags, bits, ch) {
	let isFloat = flags & 1, isLE = flags & 2
	let bytesPerSample = bits >> 3
	let totalSamples = (data.length / bytesPerSample) | 0
	let framesCount = (totalSamples / ch) | 0
	if (!framesCount) return []

	let dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
	let channelData = Array.from({ length: ch }, () => new Float32Array(framesCount))

	if (isFloat && bits === 32) {
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < ch; c++, off += 4)
				channelData[c][i] = dv.getFloat32(off, !!isLE)
	} else if (isFloat && bits === 64) {
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < ch; c++, off += 8)
				channelData[c][i] = dv.getFloat64(off, !!isLE)
	} else if (bits === 32) {
		let norm = 1 / 2147483648
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < ch; c++, off += 4)
				channelData[c][i] = dv.getInt32(off, !!isLE) * norm
	} else if (bits === 24) {
		let norm = 1 / 8388608
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < ch; c++, off += 3) {
				let s
				if (!isLE) s = (data[off] << 16) | (data[off + 1] << 8) | data[off + 2]
				else s = data[off] | (data[off + 1] << 8) | (data[off + 2] << 16)
				if (s & 0x800000) s |= ~0xFFFFFF
				channelData[c][i] = s * norm
			}
	} else if (bits === 16) {
		let norm = 1 / 32768
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < ch; c++, off += 2)
				channelData[c][i] = dv.getInt16(off, !!isLE) * norm
	} else if (bits === 8) {
		let norm = 1 / 128
		for (let i = 0, off = 0; i < framesCount; i++)
			for (let c = 0; c < ch; c++, off++)
				channelData[c][i] = dv.getInt8(off) * norm
	} else {
		throw Error('CAF: unsupported LPCM bit depth ' + bits)
	}

	return channelData
}
export function k1r(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: nCh } = hdr, n = raw.length >> 1, frames = n / nCh | 0
  let s = samplesR(raw, Uint16Array, n), ch = [new Float32Array(frames), new Float32Array(frames)]
  for (let c = 0; c < nCh; c++) for (let x = ch[c], i = 0, k = c; i < frames; i++, k += nCh) x[i] = (s[k] << 16 >> 16) / 32768
  return ch
}
export function k1rf(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: nCh, bitDepth } = hdr, n = raw.length >> 2, frames = n / nCh | 0
  let s = samplesR(raw, bitDepth === 64 ? Float64Array : Float32Array, n), ch = [new Float32Array(frames), new Float32Array(frames)]
  for (let c = 0; c < nCh; c++) for (let x = ch[c], i = 0, k = c; i < frames; i++, k += nCh) x[i] = s[k]
  return ch
}
// CAF: the package's decodeLPCM over a view of the bytes, flags and depth from the header bytes
export function k3r(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  return decodeLPCM(raw.subarray(0, raw.length - 4), hdr.flags | 1, hdr.bitDepth, hdr.channels)
}
export function k3o(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  return decodeLPCM(raw, hdr.flags | 1, hdr.bitDepth, hdr.channels)
}

// ── G3 controls: the same DataView loop with the offset an int32 expression, and with a literal channel count ──
export function c3s(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src), hdr = parse(raw)
  let { channels: ch, flags } = hdr, isLE = flags & 2, framesCount = (raw.length / 4 / ch) | 0
  let dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  let channelData = Array.from({ length: ch }, () => new Float32Array(framesCount))
  for (let i = 0; i < framesCount; i++)
    for (let c = 0; c < ch; c++)
      channelData[c][i] = dv.getFloat32((i * ch + c) << 2, !!isLE)
  return channelData
}
export function c3k(src) { let raw = src instanceof Uint8Array ? src : new Uint8Array(src)
  let ch = 2, isLE = raw[2] & 2, framesCount = (raw.length / 4 / ch) | 0
  let dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  let channelData = Array.from({ length: ch }, () => new Float32Array(framesCount))
  for (let i = 0, off = 0; i < framesCount; i++)
    for (let c = 0; c < ch; c++, off += 4)
      channelData[c][i] = dv.getFloat32(off, !!isLE)
  return channelData
}
