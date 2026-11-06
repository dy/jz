// decode-tta.js — TTA decode, 16-bit stereo: @audio/decode-tta from @audio/decode a27428a (MIT), bundled by
// scripts/decode-cases.mjs: the package's own code with the module seams gone, nothing
// rewritten. Input: the package's fixture stereo16.tta (31510 bytes), embedded.
// Regenerate the case there, never edit it.
import { checksumU32, medianUs, mix, printResult } from '../_lib/benchlib.js'

// ../@audio/decode/packages/decode-tta/decode-tta.js
var EMPTY = Object.freeze({ channelData: [], sampleRate: 0 });
var CRC_TABLE = (() => {
  let t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf, start = 0, end = buf.length) {
  let crc = 4294967295;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 255] ^ crc >>> 8;
  return (crc ^ 4294967295) >>> 0;
}
function makeBits(buf) {
  let pos = 0, cache = 0, n = 0;
  function fill() {
    cache = (cache | buf[pos++] << n) >>> 0;
    n += 8;
  }
  function bit() {
    if (!n) fill();
    let b = cache & 1;
    cache >>>= 1;
    n--;
    return b;
  }
  function unary() {
    let c = 0;
    while (bit()) c++;
    return c;
  }
  function read(k) {
    if (!k) return 0;
    while (n < k) fill();
    let mask = k === 32 ? 4294967295 : (1 << k) - 1;
    let v = (cache & mask) >>> 0;
    cache = cache >>> k >>> 0;
    n -= k;
    return v;
  }
  return { unary, read };
}
var SHIFT1 = new Uint32Array(41);
for (let i = 0; i < 32; i++) SHIFT1[i] = 1 << i >>> 0;
for (let i = 32; i < 40; i++) SHIFT1[i] = 2147483648;
SHIFT1[40] = 4294967295;
var SHIFT16 = SHIFT1.subarray(4);
var FILTER_SHIFT = [10, 9, 10];
function initChannel(shift) {
  return {
    qm: new Int32Array(8),
    dx: new Int32Array(8),
    dl: new Int32Array(8),
    error: 0,
    shift,
    round: 1 << shift - 1,
    k0: 10,
    k1: 10,
    sum0: SHIFT16[10],
    sum1: SHIFT16[10],
    predictor: 0
  };
}
function hybridFilter(ch, value) {
  let { qm, dx, dl } = ch;
  if (ch.error < 0) for (let i = 0; i < 8; i++) qm[i] -= dx[i];
  else if (ch.error > 0) for (let i = 0; i < 8; i++) qm[i] += dx[i];
  let sum = ch.round;
  for (let i = 0; i < 8; i++) sum = sum + Math.imul(dl[i], qm[i]) | 0;
  dx[0] = dx[1];
  dx[1] = dx[2];
  dx[2] = dx[3];
  dx[3] = dx[4];
  dl[0] = dl[1];
  dl[1] = dl[2];
  dl[2] = dl[3];
  dl[3] = dl[4];
  dx[4] = dl[4] >> 30 | 1;
  dx[5] = (dl[5] >> 30 | 2) & ~1;
  dx[6] = (dl[6] >> 30 | 2) & ~1;
  dx[7] = (dl[7] >> 30 | 4) & ~3;
  ch.error = value;
  value = value + (sum >> ch.shift) | 0;
  dl[4] = -dl[5];
  dl[5] = -dl[6];
  dl[6] = value - dl[7];
  dl[7] = value;
  dl[5] += dl[6];
  dl[4] += dl[5];
  return value;
}
function decodeValue(br, ch, predShift) {
  let unary = br.unary(), depth, k;
  if (unary === 0) {
    depth = 0;
    k = ch.k0;
  } else {
    depth = 1;
    k = ch.k1;
    unary--;
  }
  let value = k ? (unary << k) + br.read(k) : unary;
  if (depth === 1) {
    ch.sum1 = ch.sum1 + value - (ch.sum1 >>> 4) >>> 0;
    if (ch.k1 > 0 && ch.sum1 < SHIFT16[ch.k1]) ch.k1--;
    else if (ch.sum1 > SHIFT16[ch.k1 + 1]) ch.k1++;
    value += SHIFT1[ch.k0];
  }
  ch.sum0 = ch.sum0 + value - (ch.sum0 >>> 4) >>> 0;
  if (ch.k0 > 0 && ch.sum0 < SHIFT16[ch.k0]) ch.k0--;
  else if (ch.sum0 > SHIFT16[ch.k0 + 1]) ch.k0++;
  value = value & 1 ? value + 1 >> 1 : -(value >> 1);
  value = hybridFilter(ch, value);
  let p = ch.predictor;
  value = value + ((p << predShift) - p >> predShift) | 0;
  ch.predictor = value;
  return value;
}
function scale(v, byteSize) {
  return v / (byteSize === 1 ? 128 : byteSize === 2 ? 32768 : 8388608);
}
function decodeFrame(bytes, hdr, nSamples) {
  let n = bytes.length;
  if (n < 4 || crc32(bytes, 0, n - 4) !== readU32(bytes, n - 4)) return null;
  let { channels, byteSize, filterShift, predShift } = hdr;
  let chans = new Array(channels);
  for (let c = 0; c < channels; c++) chans[c] = initChannel(filterShift);
  let out = new Array(channels);
  for (let c = 0; c < channels; c++) out[c] = new Float32Array(nSamples);
  let br = makeBits(bytes), raw = new Int32Array(channels);
  for (let s = 0; s < nSamples; s++) {
    for (let c = 0; c < channels; c++) raw[c] = decodeValue(br, chans[c], predShift);
    if (channels > 1) {
      raw[channels - 1] = raw[channels - 1] + (raw[channels - 2] / 2 | 0) | 0;
      for (let c = channels - 2; c >= 0; c--) raw[c] = raw[c + 1] - raw[c] | 0;
    }
    for (let c = 0; c < channels; c++) out[c][s] = scale(raw[c], byteSize);
  }
  return out;
}
function readU16(b, o) {
  return b[o] | b[o + 1] << 8;
}
function readU32(b, o) {
  return (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
}
function id3v2Size(b) {
  let size = (b[6] & 127) << 21 | (b[7] & 127) << 14 | (b[8] & 127) << 7 | b[9] & 127;
  return 10 + size + (b[5] & 16 ? 10 : 0);
}
function parseHeader(b, off) {
  let format = readU16(b, off + 4);
  let channels = readU16(b, off + 6);
  let bitsPerSample = readU16(b, off + 8);
  let sampleRate = readU32(b, off + 10);
  let dataLength = readU32(b, off + 14);
  let crc = readU32(b, off + 18);
  if (crc32(b, off, off + 18) !== crc) throw Error("TTA: header CRC mismatch");
  if (format !== 1) throw Error("TTA: unsupported format " + format + " (only PCM streams are decoded)");
  if (!channels || channels > 16) throw Error("TTA: invalid channel count " + channels);
  let byteSize = Math.ceil(bitsPerSample / 8);
  if (byteSize < 1 || byteSize > 3) throw Error("TTA: unsupported bit depth " + bitsPerSample + " (8/16/24-bit only)");
  if (!(sampleRate > 0 && sampleRate <= 8388607)) throw Error("TTA: invalid sample rate " + sampleRate);
  let frameLen = Math.floor(sampleRate * 256 / 245);
  let totalFrames, lastFrameLen;
  if (dataLength === 0) {
    totalFrames = 0;
    lastFrameLen = 0;
  } else {
    lastFrameLen = dataLength % frameLen || frameLen;
    totalFrames = Math.floor(dataLength / frameLen) + (lastFrameLen < frameLen ? 1 : 0);
  }
  if (totalFrames < 0 || totalFrames > 5e6) throw Error("TTA: implausible frame count " + totalFrames);
  return {
    channels,
    bitsPerSample,
    byteSize,
    sampleRate,
    dataLength,
    frameLen,
    lastFrameLen,
    totalFrames,
    filterShift: FILTER_SHIFT[byteSize - 1],
    predShift: byteSize === 1 ? 4 : 5
  };
}
function cat(a, b) {
  let r = new Uint8Array(a.length + b.length);
  r.set(a);
  r.set(b, a.length);
  return r;
}
function merge(parts, hdr) {
  if (!parts.length) return EMPTY;
  let total = parts.reduce((s, p) => s + p[0].length, 0);
  let channelData = Array.from({ length: hdr.channels }, (_, c) => {
    let o = new Float32Array(total), off = 0;
    for (let p of parts) {
      o.set(p[c], off);
      off += p[c].length;
    }
    return o;
  });
  return { channelData, sampleRate: hdr.sampleRate };
}
function decoder() {
  let skip = null;
  let hdr = null;
  let frameSizes = null;
  let frameIdx = 0;
  let left = null;
  let freed = false;
  let errors = 0;
  function decode2(data) {
    if (freed) throw Error("Decoder already freed");
    if (!data || !data.byteLength) return EMPTY;
    let chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (left) {
      chunk = cat(left, chunk);
      left = null;
    }
    if (!hdr) {
      if (skip === null) {
        if (chunk.length < 3) {
          left = chunk.slice();
          return EMPTY;
        }
        if (chunk[0] === 73 && chunk[1] === 68 && chunk[2] === 51) {
          if (chunk.length < 10) {
            left = chunk.slice();
            return EMPTY;
          }
          skip = id3v2Size(chunk);
        } else skip = 0;
      }
      if (chunk.length < skip + 4) {
        left = chunk.slice();
        return EMPTY;
      }
      if (!(chunk[skip] === 84 && chunk[skip + 1] === 84 && chunk[skip + 2] === 65 && chunk[skip + 3] === 49))
        throw TypeError("Not a TTA file");
      if (chunk.length < skip + 22) {
        left = chunk.slice();
        return EMPTY;
      }
      hdr = parseHeader(chunk, skip);
      chunk = chunk.subarray(skip + 22);
    }
    if (!frameSizes) {
      let need = hdr.totalFrames * 4 + 4;
      if (chunk.length < need) {
        left = chunk.slice();
        return EMPTY;
      }
      let sizes = new Uint32Array(hdr.totalFrames);
      for (let i = 0; i < hdr.totalFrames; i++) sizes[i] = readU32(chunk, i * 4);
      if (crc32(chunk, 0, hdr.totalFrames * 4) !== readU32(chunk, hdr.totalFrames * 4))
        throw Error("TTA: seek-table CRC mismatch");
      frameSizes = sizes;
      chunk = chunk.subarray(need);
    }
    let parts = [];
    while (frameIdx < hdr.totalFrames) {
      let want = frameSizes[frameIdx];
      if (chunk.length < want) {
        left = chunk.slice();
        return merge(parts, hdr);
      }
      let nSamples = frameIdx === hdr.totalFrames - 1 ? hdr.lastFrameLen : hdr.frameLen;
      let out = decodeFrame(chunk.subarray(0, want), hdr, nSamples);
      if (out) parts.push(out);
      else errors++;
      chunk = chunk.subarray(want);
      frameIdx++;
    }
    return merge(parts, hdr);
  }
  return {
    decode: decode2,
    /** Drop any trailing incomplete header/seek-table/frame bytes. */
    flush() {
      left = null;
      return EMPTY;
    },
    free() {
      freed = true;
      left = null;
    },
    /** Frames dropped so far for a CRC32 mismatch. */
    get errors() {
      return errors;
    }
  };
}
function decode(src) {
  let dec = decoder();
  try {
    return dec.decode(src instanceof Uint8Array ? src : new Uint8Array(src));
  } finally {
    dec.free();
  }
}

const unbase64 = (s) => {
  const t = new Uint8Array(128), A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < 64; i++) t[A.charCodeAt(i)] = i
  const pad = s.charCodeAt(s.length - 1) === 61 ? s.charCodeAt(s.length - 2) === 61 ? 2 : 1 : 0
  const n = (s.length >> 2) * 3 - pad, out = new Uint8Array(n)
  for (let i = 0, o = 0; i < s.length; i += 4) {
    const v = t[s.charCodeAt(i)] << 18 | t[s.charCodeAt(i + 1)] << 12 | t[s.charCodeAt(i + 2)] << 6 | t[s.charCodeAt(i + 3)]
    if (o < n) out[o++] = v >> 16 & 255
    if (o < n) out[o++] = v >> 8 & 255
    if (o < n) out[o++] = v & 255
  }
  return out
}

const N_RUNS = 21
const N_WARMUP = 5
const REPS = 4

const TTA =
  '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'
const input = () => unbase64(TTA)

const checksum = (channels) => {
  let h = 0x811c9dc5 | 0
  for (let c = 0; c < channels.length; c++) h = mix(h, checksumU32(new Uint32Array(channels[c].buffer, channels[c].byteOffset, channels[c].length)))
  return h >>> 0
}

const run = () => {
  const src = input()
  let out = null
  const once = () => { for (let r = 0; r < REPS; r++) out = decode(src) }
  for (let i = 0; i < N_WARMUP; i++) once()
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    once()
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksum(out.channelData), out.channelData.length * out.channelData[0].length * REPS, 1, N_RUNS)
}

export { run as main }
