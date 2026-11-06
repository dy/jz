// decode-wav.js — WAV decode, 16-bit stereo PCM: @audio/decode-wav from @audio/decode a27428a (MIT), bundled by
// scripts/decode-cases.mjs: the package's own code with the module seams gone, nothing
// rewritten. Input: a 10 s 16-bit stereo WAV the program writes (two tones over shaped noise).
// Regenerate the case there, never edit it.
import { checksumU32, medianUs, mix, printResult } from '../_lib/benchlib.js'

// ../@audio/decode/packages/decode-wav/decode-wav.js
var EMPTY = Object.freeze({ channelData: [], sampleRate: 0 });
var WAV_CODECS = { 1: "pcm", 3: "float", 6: "alaw", 7: "ulaw", 2: "ms", 17: "ima" };
var IMA_STEP = new Int16Array([7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767]);
var IMA_IDX = new Int8Array([-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]);
var MS_ADAPT = new Int16Array([230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230]);
var MS_DEFAULT_COEFS = [[256, 0], [512, -256], [0, 0], [192, 64], [240, 0], [460, -208], [392, -232]];
var ALAW_TBL = new Int16Array(256);
var ULAW_TBL = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let ax = i ^ 85, seg = ax >> 4 & 7, val = ((ax & 15) << 4) + 8;
  if (seg) val = val + 256 << seg - 1;
  ALAW_TBL[i] = ax & 128 ? val : -val;
  let ux = ~i & 255;
  seg = ux >> 4 & 7;
  val = ((ux & 15) << 3) + 132;
  val <<= seg;
  ULAW_TBL[i] = ux & 128 ? 132 - val : val - 132;
}
function decode(src) {
  let dec = decoder();
  try {
    return dec.decode(src instanceof Uint8Array ? src : new Uint8Array(src));
  } finally {
    dec.free();
  }
}
function decoder() {
  let hdr = null, left = null, freed = false, dataLeft = Infinity;
  return {
    decode(data) {
      if (freed) throw Error("Decoder already freed");
      if (!data || !data.byteLength) return EMPTY;
      let chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (left) {
        chunk = cat(left, chunk);
        left = null;
      }
      if (!hdr) {
        hdr = scanWavHdr(chunk);
        if (!hdr) {
          left = chunk.slice();
          return EMPTY;
        }
        dataLeft = hdr.dataSize > 0 && hdr.dataSize < 4294967295 ? hdr.dataSize : Infinity;
        chunk = chunk.subarray(hdr.dataStart);
      }
      if (dataLeft <= 0) return EMPTY;
      let fb = hdr.blockSize;
      let avail = Math.min(chunk.length, dataLeft);
      let complete = Math.floor(avail / fb) * fb;
      if (!complete) {
        if (chunk.length && dataLeft > chunk.length) left = chunk.slice();
        return EMPTY;
      }
      dataLeft -= complete;
      let rest = chunk.subarray(complete);
      if (rest.length && dataLeft > 0) left = rest.subarray(0, Math.min(rest.length, dataLeft)).slice();
      return decodeRaw(chunk.subarray(0, complete), hdr);
    },
    flush() {
      left = null;
      return EMPTY;
    },
    free() {
      freed = true;
      left = null;
      hdr = null;
    }
  };
}
function cat(a, b) {
  let r = new Uint8Array(a.length + b.length);
  r.set(a);
  r.set(b, a.length);
  return r;
}
function s4(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}
function scanWavHdr(b) {
  if (b.length >= 4 && s4(b, 0) !== "RIFF") throw TypeError("Not a WAV file");
  if (b.length < 12) return null;
  let dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (s4(b, 8) !== "WAVE") throw TypeError("Not a WAV file");
  let pos = 12, fmt = null;
  while (pos + 8 <= b.length) {
    let type = s4(b, pos), size = dv.getUint32(pos + 4, true);
    if (type === "fmt ") {
      if (pos + 24 > b.length) return null;
      let fid = dv.getUint16(pos + 8, true);
      if (fid === 65534) {
        if (pos + 48 > b.length) return null;
        fid = dv.getUint16(pos + 32, true);
      }
      let codec = WAV_CODECS[fid];
      if (!codec) throw TypeError("Unsupported WAV format: 0x" + fid.toString(16));
      fmt = {
        codec,
        channels: dv.getUint16(pos + 10, true),
        sampleRate: dv.getUint32(pos + 12, true),
        blockSize: dv.getUint16(pos + 20, true),
        bitDepth: dv.getUint16(pos + 22, true)
      };
      if (codec === "ima" || codec === "ms") {
        if (pos + 8 + size > b.length) return null;
        let nCh = fmt.channels, ba = fmt.blockSize;
        let cbSize = dv.getUint16(pos + 24, true);
        fmt.samplesPerBlock = cbSize >= 2 ? dv.getUint16(pos + 26, true) : 0;
        if (codec === "ima") {
          if (!fmt.samplesPerBlock) fmt.samplesPerBlock = 1 + (ba / nCh - 4) * 2;
        } else {
          if (!fmt.samplesPerBlock) fmt.samplesPerBlock = 2 + (ba - 7 * nCh) * 2 / nCh;
          let nCoef = cbSize >= 4 ? dv.getUint16(pos + 28, true) : 0;
          let coefs = [];
          for (let i = 0; i < nCoef; i++)
            coefs.push([dv.getInt16(pos + 30 + i * 4, true), dv.getInt16(pos + 32 + i * 4, true)]);
          fmt.coefs = coefs.length ? coefs : MS_DEFAULT_COEFS;
        }
      }
    } else if (type === "data") {
      if (!fmt) return null;
      return { ...fmt, dataStart: pos + 8, dataSize: size };
    }
    pos += 8 + size;
  }
  return null;
}
function decodeRaw(raw, hdr) {
  let { channels: nCh, bitDepth, codec, sampleRate, blockSize } = hdr;
  if (codec === "ima") return decodeImaWav(raw, hdr);
  if (codec === "ms") return decodeMsWav(raw, hdr);
  let frames = Math.floor(raw.length / blockSize);
  if (!frames) return EMPTY;
  let ch = Array.from({ length: nCh }, () => new Float32Array(frames));
  let n = frames * nCh, p = 0;
  let isFloat = codec === "float";
  if (codec === "alaw" || codec === "ulaw") {
    let tbl = codec === "alaw" ? ALAW_TBL : ULAW_TBL;
    for (let i = 0; i < frames; i++) for (let c = 0; c < nCh; c++) ch[c][i] = tbl[raw[p++]] / 32768;
  } else if (isFloat && (bitDepth === 64 || bitDepth === 32)) {
    let s = samples(raw, bitDepth === 64 ? Float64Array : Float32Array, n);
    for (let c = 0; c < nCh; c++) for (let x = ch[c], i = 0, k = c; i < frames; i++, k += nCh) x[i] = s[k];
  } else if (bitDepth === 8) {
    let t = U8_TBL ?? (U8_TBL = scale(256, (u) => u - 128, 128));
    for (let c = 0; c < nCh; c++) for (let x = ch[c], i = 0, k = c; i < frames; i++, k += nCh) x[i] = t[raw[k]];
  } else if (bitDepth === 16) {
    let s = samples(raw, Uint16Array, n), t = S16_TBL ?? (S16_TBL = scale(65536, (u) => u << 16 >> 16, 32768));
    for (let c = 0; c < nCh; c++) for (let x = ch[c], i = 0, k = c; i < frames; i++, k += nCh) x[i] = t[s[k]];
  } else if (bitDepth === 24) {
    for (let c = 0; c < nCh; c++) for (let x = ch[c], i = 0, k = c * 3; i < frames; i++, k += nCh * 3) {
      x[i] = ((raw[k] | raw[k + 1] << 8 | raw[k + 2] << 16) << 8 >> 8) / 8388608;
    }
  } else if (bitDepth === 32) {
    let s = samples(raw, Int32Array, n);
    for (let c = 0; c < nCh; c++) for (let x = ch[c], i = 0, k = c; i < frames; i++, k += nCh) {
      x[i] = s[k] / 2147483648;
    }
  } else {
    throw TypeError("Unsupported WAV bit depth: " + bitDepth);
  }
  return { channelData: ch, sampleRate };
}
var U8_TBL = null;
var S16_TBL = null;
function scale(n, signed, full) {
  let t = new Float32Array(n);
  for (let u = 0; u < n; u++) t[u] = signed(u) / full;
  return t;
}
var LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function samples(raw, T, n) {
  let w = T.BYTES_PER_ELEMENT, len = n * w;
  if (!LE) {
    let b = new Uint8Array(len);
    for (let i = 0; i < len; i += w) for (let j = 0; j < w; j++) b[i + j] = raw[i + w - 1 - j];
    raw = b;
  } else if (raw.byteOffset % w) raw = raw.slice(0, len);
  return new T(raw.buffer, raw.byteOffset, n);
}
function decodeImaWav(raw, hdr) {
  let { channels: nCh, blockSize: ba, samplesPerBlock: spb, sampleRate } = hdr;
  let nBlocks = Math.floor(raw.length / ba);
  let ch = Array.from({ length: nCh }, () => new Float32Array(nBlocks * spb));
  let dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let blk = 0; blk < nBlocks; blk++) {
    let base = blk * ba, outBase = blk * spb;
    let pred = new Int32Array(nCh), idx = new Int32Array(nCh), cnt = new Int32Array(nCh);
    for (let c = 0; c < nCh; c++) {
      pred[c] = dv.getInt16(base + c * 4, true);
      idx[c] = Math.min(raw[base + c * 4 + 2], 88);
      ch[c][outBase] = pred[c] / 32768;
      cnt[c] = 1;
    }
    let p = base + nCh * 4, nWords = Math.ceil((spb - 1) / 8);
    for (let w = 0; w < nWords; w++) {
      for (let c = 0; c < nCh; c++, p += 4) {
        let out = ch[c], pr = pred[c], ix = idx[c];
        for (let n = 0; n < 4; n++) {
          let byte = raw[p + n];
          for (let half = 0; half < 2; half++) {
            let nib = half === 0 ? byte & 15 : byte >> 4;
            let step = IMA_STEP[ix];
            let diff = (2 * (nib & 7) + 1) * step >> 3;
            pr += nib & 8 ? -diff : diff;
            if (pr > 32767) pr = 32767;
            else if (pr < -32768) pr = -32768;
            ix += IMA_IDX[nib];
            if (ix < 0) ix = 0;
            else if (ix > 88) ix = 88;
            if (cnt[c] < spb) out[outBase + cnt[c]++] = pr / 32768;
          }
        }
        pred[c] = pr;
        idx[c] = ix;
      }
    }
  }
  return { channelData: ch, sampleRate };
}
function decodeMsWav(raw, hdr) {
  let { channels: nCh, blockSize: ba, samplesPerBlock: spb, sampleRate, coefs } = hdr;
  let nBlocks = Math.floor(raw.length / ba);
  let ch = Array.from({ length: nCh }, () => new Float32Array(nBlocks * spb));
  let dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let predIdx = new Int32Array(nCh), delta = new Int32Array(nCh), s1 = new Int32Array(nCh), s2 = new Int32Array(nCh);
  let expand = (nib, c) => {
    let signed = nib >= 8 ? nib - 16 : nib;
    let co = coefs[predIdx[c]];
    let pr = s1[c] * co[0] + s2[c] * co[1] >> 8;
    pr += signed * delta[c];
    if (pr > 32767) pr = 32767;
    else if (pr < -32768) pr = -32768;
    s2[c] = s1[c];
    s1[c] = pr;
    delta[c] = MS_ADAPT[nib] * delta[c] >> 8;
    if (delta[c] < 16) delta[c] = 16;
    return pr / 32768;
  };
  for (let blk = 0; blk < nBlocks; blk++) {
    let base = blk * ba, outBase = blk * spb, p = base;
    for (let c = 0; c < nCh; c++) predIdx[c] = Math.min(raw[p++], coefs.length - 1);
    for (let c = 0; c < nCh; c++) {
      delta[c] = dv.getInt16(p, true);
      p += 2;
    }
    for (let c = 0; c < nCh; c++) {
      s1[c] = dv.getInt16(p, true);
      p += 2;
    }
    for (let c = 0; c < nCh; c++) {
      s2[c] = dv.getInt16(p, true);
      p += 2;
    }
    for (let c = 0; c < nCh; c++) {
      ch[c][outBase] = s2[c] / 32768;
      ch[c][outBase + 1] = s1[c] / 32768;
    }
    let cnt = 2;
    if (nCh === 1) {
      while (cnt < spb) {
        let byte = raw[p++];
        ch[0][outBase + cnt++] = expand(byte >> 4, 0);
        if (cnt < spb) ch[0][outBase + cnt++] = expand(byte & 15, 0);
      }
    } else {
      while (cnt < spb) {
        let byte = raw[p++];
        ch[0][outBase + cnt] = expand(byte >> 4, 0);
        ch[1][outBase + cnt] = expand(byte & 15, 1);
        cnt++;
      }
    }
  }
  return { channelData: ch, sampleRate };
}

const N_RUNS = 21
const N_WARMUP = 5
const REPS = 1

const input = () => {
  const n = 441000, data = n * 4, b = new Uint8Array(44 + data), dv = new DataView(b.buffer)
  const tag = (o, s) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i) }
  tag(0, 'RIFF'); dv.setUint32(4, 36 + data, true); tag(8, 'WAVE'); tag(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, 44100, true)
  dv.setUint32(28, 44100 * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); tag(36, 'data'); dv.setUint32(40, data, true)
  let s = 0x1234abcd | 0, lp = 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    lp = lp * 0.96 + ((s >>> 0) / 4294967296 * 2 - 1) * 0.04
    const t = i / 44100, l = 0.4 * Math.sin(2 * Math.PI * 220 * t) + lp, r = 0.4 * Math.sin(2 * Math.PI * 330 * t) - lp
    dv.setInt16(44 + i * 4, Math.round(l * 32767), true); dv.setInt16(46 + i * 4, Math.round(r * 32767), true)
  }
  return b
}

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
