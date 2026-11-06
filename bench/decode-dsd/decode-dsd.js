// decode-dsd.js — DSD decode, DSF DSD64 stereo to 88.2 kHz PCM: @audio/decode-dsd from @audio/decode a27428a (MIT), bundled by
// scripts/decode-cases.mjs: the package's own code with the module seams gone, nothing
// rewritten. Input: a 0.25 s DSD64 DSF of two tones through a second-order sigma-delta modulator, written in the program.
// Regenerate the case there, never edit it.
import { checksumU32, medianUs, mix, printResult } from '../_lib/benchlib.js'

// ../@audio/decode/packages/decode-dsd/decode-dsd.js
var EMPTY = Object.freeze({ channelData: [], sampleRate: 0 });
var REV8 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = i, r = 0;
  for (let b = 0; b < 8; b++) {
    r = r << 1 | v & 1;
    v >>= 1;
  }
  REV8[i] = r;
}
function besselI0(x) {
  let sum = 1, term = 1, k = 1;
  const y = x * x / 4;
  while (k < 64 && term > sum * 1e-16) {
    term *= y / (k * k);
    sum += term;
    k++;
  }
  return sum;
}
function kaiserBeta(A) {
  if (A > 50) return 0.1102 * (A - 8.71);
  if (A >= 21) return 0.5842 * Math.pow(A - 21, 0.4) + 0.07886 * (A - 21);
  return 0;
}
function kaiserLength(A, dw) {
  return Math.max(4, Math.ceil((A - 8) / (2.285 * dw)));
}
function designLowpass(fc, fs, N, beta) {
  const h = new Float64Array(N), M = (N - 1) / 2, wc = 2 * Math.PI * fc / fs, i0b = besselI0(beta);
  let sum = 0;
  for (let n = 0; n < N; n++) {
    const m = n - M;
    const sinc = m === 0 ? wc / Math.PI : Math.sin(wc * m) / (Math.PI * m);
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - (m / M) ** 2))) / i0b;
    h[n] = sinc * w;
    sum += h[n];
  }
  for (let n = 0; n < N; n++) h[n] /= sum;
  return h;
}
var STAGE1_TAPS = 192;
var STOPBAND_DB = 100;
function buildStage1(dsdRate, opts) {
  const outRate = dsdRate / 8;
  const cutoff = (opts.cutoff ?? 0.45) * outRate;
  const stopband = opts.stopband ?? STOPBAND_DB;
  const N = (opts.length && opts.ratio === 8 ? opts.length : STAGE1_TAPS) | 0;
  const evenN = N + (N & 1);
  const beta = kaiserBeta(stopband);
  const h = designLowpass(cutoff, dsdRate, evenN, beta);
  const HTAPS = evenN / 2;
  const half = h.subarray(HTAPS);
  const CTABLES = Math.ceil(HTAPS / 8);
  const tables = Array.from({ length: CTABLES }, () => new Float32Array(256));
  const acc = new Float64Array(CTABLES);
  for (let byteVal = 0; byteVal < 256; byteVal++) {
    acc.fill(0);
    for (let bit = 0; bit < 8; bit++) {
      const sign = (byteVal >> 7 - bit & 1) * 2 - 1;
      for (let t = 0; t < CTABLES; t++) {
        const tapIdx = t * 8 + bit;
        acc[t] += sign * (tapIdx < HTAPS ? half[tapIdx] : 0);
      }
    }
    for (let t = 0; t < CTABLES; t++) tables[CTABLES - 1 - t][byteVal] = acc[t];
  }
  return { CTABLES, tables, outRate, taps: evenN, cutoff, stopband };
}
function makeStage1Channel(stage1) {
  const { CTABLES, tables } = stage1;
  let size = 4;
  while (size < CTABLES * 2) size <<= 1;
  const MASK = size - 1;
  const buf = new Uint8Array(size);
  let pos = 0;
  return {
    push(byte) {
      buf[pos] = byte;
      const p = pos - CTABLES & MASK;
      buf[p] = REV8[buf[p]];
      let sum = 0;
      for (let i = 0; i < CTABLES; i++) {
        const a = buf[pos - i & MASK];
        const b = buf[pos - (CTABLES * 2 - 1) + i & MASK];
        sum += tables[i][a] + tables[i][b];
      }
      pos = pos + 1 & MASK;
      return sum;
    }
  };
}
function buildStage2(rateIn, ratio, opts) {
  const outRate = rateIn / ratio;
  const cutoff = (opts.cutoff ?? 0.45) * outRate;
  const stopband = opts.stopband ?? STOPBAND_DB;
  const df = outRate - 2 * cutoff;
  if (df <= 0) throw Error("cutoff too high for alias-free decimation (must be < 0.5\xD7 output rate)");
  const beta = kaiserBeta(stopband);
  let N = opts.length || kaiserLength(stopband, 2 * Math.PI * df / rateIn);
  N += N & 1;
  const h = designLowpass(cutoff, rateIn, N, beta);
  return { h, N, outRate, cutoff, stopband };
}
function makeStage2Channel(stage2, ratio) {
  const { h, N } = stage2;
  const half = N / 2;
  let hist = new Float64Array(N - 1);
  let pos = 0;
  return {
    // input: Float64Array of new stage-1-rate samples. Returns Float32Array decimated output.
    push(input) {
      const total = hist.length + input.length;
      const buf = new Float64Array(total);
      buf.set(hist);
      buf.set(input, hist.length);
      const globalStart = pos - hist.length;
      let j = ((N - 1 - globalStart) % ratio + ratio) % ratio;
      if (j < N - 1) j += ratio * Math.ceil((N - 1 - j) / ratio);
      const out = [];
      for (; j < total; j += ratio) {
        let sum = 0;
        const base = j - (N - 1);
        for (let n = 0; n < half; n++) sum += h[n] * (buf[base + n] + buf[j - n]);
        out.push(sum);
      }
      hist = buf.subarray(total - (N - 1)).slice();
      pos += input.length;
      return Float32Array.from(out);
    }
  };
}
function str4(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}
function u32le(b, o) {
  return (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
}
function u64le(b, o) {
  return u32le(b, o) + u32le(b, o + 4) * 4294967296;
}
function u32be(b, o) {
  return (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
}
function u64be(b, o) {
  return u32be(b, o) * 4294967296 + u32be(b, o + 4);
}
function u16be(b, o) {
  return b[o] << 8 | b[o + 1];
}
function scanDsfHeader(buf) {
  if (buf.length < 12) return null;
  if (str4(buf, 0) !== "DSD ") throw Error("Not a DSF file");
  if (buf.length < 28) return null;
  if (u64le(buf, 4) !== 28) throw Error("Not a DSF file");
  const fileSize = u64le(buf, 12);
  const metaPointer = u64le(buf, 20);
  if (buf.length < 92) return null;
  if (str4(buf, 28) !== "fmt ") throw Error("Malformed DSF: missing fmt chunk");
  const fmtSize = u64le(buf, 32);
  if (fmtSize < 52) throw Error("Malformed DSF: fmt chunk too small");
  if (u32le(buf, 40) !== 1) throw Error("Unsupported DSF format version");
  if (u32le(buf, 44) !== 0) throw Error("Unsupported DSF format id (not raw DSD)");
  const channels = u32le(buf, 52);
  if (!channels) throw Error("Malformed DSF: zero channels");
  const dsdRate = u32le(buf, 56);
  const bitsPerSample = u32le(buf, 60);
  if (bitsPerSample !== 1 && bitsPerSample !== 8) throw Error("Unsupported DSF bits-per-sample: " + bitsPerSample);
  const sampleCount = u64le(buf, 64);
  const blockSize = u32le(buf, 72);
  if (blockSize <= 0) throw Error("Malformed DSF: invalid block size");
  const dataHdr = 28 + fmtSize;
  if (buf.length < dataHdr + 12) return null;
  if (str4(buf, dataHdr) !== "data") throw Error("Malformed DSF: missing data chunk");
  const dataChunkSize = u64le(buf, dataHdr + 4);
  const dataStart = dataHdr + 12;
  const dataSize = Math.max(0, dataChunkSize - 12);
  return { container: "dsf", dsdRate, channels, bitsPerSample, sampleCount, blockSize, dataStart, dataSize, fileSize, metaPointer };
}
function readChunkHdr(buf, off) {
  if (off + 12 > buf.length) return null;
  return { id: str4(buf, off), size: u64be(buf, off + 4), bodyStart: off + 12 };
}
function scanDffHeader(buf) {
  if (buf.length < 16) return null;
  if (str4(buf, 0) !== "FRM8") throw Error("Not a DFF file");
  if (str4(buf, 12) !== "DSD ") throw Error("Not a DFF file");
  let off = 16, dsdRate = 0, channels = 0, chanIds = [], sawFver = false, sawProp = false;
  while (true) {
    const ck = readChunkHdr(buf, off);
    if (!ck) return null;
    const bodyEnd = ck.bodyStart + ck.size;
    const next = bodyEnd + (ck.size & 1);
    if (ck.id === "FVER") {
      if (bodyEnd > buf.length) return null;
      sawFver = true;
    } else if (ck.id === "PROP") {
      if (ck.bodyStart + 4 > buf.length) return null;
      if (str4(buf, ck.bodyStart) !== "SND ") throw Error("Unsupported DFF property type");
      let p = ck.bodyStart + 4;
      while (p < bodyEnd) {
        const sub = readChunkHdr(buf, p);
        if (!sub) return null;
        const subEnd = sub.bodyStart + sub.size;
        if (subEnd > buf.length) return null;
        if (sub.id === "FS  ") dsdRate = u32be(buf, sub.bodyStart);
        else if (sub.id === "CHNL") {
          channels = u16be(buf, sub.bodyStart);
          chanIds = [];
          for (let c = 0; c < channels; c++) chanIds.push(str4(buf, sub.bodyStart + 2 + c * 4));
        } else if (sub.id === "CMPR") {
          const compType = str4(buf, sub.bodyStart);
          if (compType === "DST ") throw Error("Unsupported: DST");
          if (compType !== "DSD ") throw Error("Unsupported DFF compression: " + compType);
        }
        p = subEnd + (sub.size & 1);
      }
      sawProp = true;
    } else if (ck.id === "DSD ") {
      if (!sawFver || !sawProp) throw Error("Malformed DFF: DSD chunk before FVER/PROP");
      if (!dsdRate || !channels) throw Error("Malformed DFF: missing FS or CHNL");
      return { container: "dff", dsdRate, channels, chanIds, dataStart: ck.bodyStart, dataSize: ck.size };
    } else if (ck.id === "DST ") {
      throw Error("Unsupported: DST");
    }
    if (bodyEnd > buf.length) return null;
    off = next;
  }
}
var VALID_RATIOS = [8, 16, 32, 64];
function catBytes(a, b) {
  const r = new Uint8Array(a.length + b.length);
  r.set(a);
  r.set(b, a.length);
  return r;
}
function decoder(opts = {}) {
  let header = null, carry = null, freed = false;
  let stage1 = null, stage1Ch = [], stage2 = null, stage2Ch = null, ratio = 8;
  let dataConsumed = 0;
  let finalEmitted = 0;
  let finalLimit = Infinity;
  function setupFilters(h) {
    if (opts.sampleRate) {
      const r = Math.round(h.dsdRate / opts.sampleRate);
      if (!VALID_RATIOS.includes(r) || Math.abs(h.dsdRate / r - opts.sampleRate) > 1e-6)
        throw Error("Unsupported sampleRate: " + opts.sampleRate + " (dsdRate/8, /16, /32 or /64 only)");
      ratio = r;
    } else ratio = opts.ratio && VALID_RATIOS.includes(opts.ratio) ? opts.ratio : 32;
    stage1 = buildStage1(h.dsdRate, { ...opts, ratio });
    stage1Ch = Array.from({ length: h.channels }, () => makeStage1Channel(stage1));
    if (ratio > 8) {
      stage2 = buildStage2(stage1.outRate, ratio / 8, opts);
      stage2Ch = Array.from({ length: h.channels }, () => makeStage2Channel(stage2, ratio / 8));
    }
    if (h.container === "dsf" && h.sampleCount) finalLimit = Math.floor(h.sampleCount / ratio);
  }
  function decodeFrames(bytes) {
    const nCh = header.channels;
    const outCh = [];
    if (header.container === "dsf") {
      const blockSize = header.blockSize, group = blockSize * nCh;
      const groups = bytes.length / group;
      for (let c = 0; c < nCh; c++) {
        const s1 = new Float64Array(groups * blockSize);
        let o = 0;
        for (let g = 0; g < groups; g++) {
          const base = g * group + c * blockSize;
          for (let i = 0; i < blockSize; i++) {
            const byte = header.bitsPerSample === 1 ? REV8[bytes[base + i]] : bytes[base + i];
            s1[o++] = stage1Ch[c].push(byte);
          }
        }
        outCh.push(stage2 ? stage2Ch[c].push(s1) : Float32Array.from(s1));
      }
    } else {
      const nFrames = bytes.length / nCh;
      const s1 = Array.from({ length: nCh }, () => new Float64Array(nFrames));
      for (let f = 0, o = 0; f < nFrames; f++, o += nCh)
        for (let c = 0; c < nCh; c++) s1[c][f] = stage1Ch[c].push(bytes[o + c]);
      for (let c = 0; c < nCh; c++) outCh.push(stage2 ? stage2Ch[c].push(s1[c]) : Float32Array.from(s1[c]));
    }
    return outCh;
  }
  function trim(channelData) {
    if (finalEmitted >= finalLimit) return channelData.map(() => new Float32Array(0));
    const room = finalLimit - finalEmitted;
    const len = channelData[0]?.length ?? 0;
    if (len <= room) {
      finalEmitted += len;
      return channelData;
    }
    finalEmitted = finalLimit;
    return channelData.map((c) => c.subarray(0, room));
  }
  return {
    decode(data) {
      if (freed) throw Error("Decoder already freed");
      if (!data || !data.byteLength) return EMPTY;
      let buf = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (carry) {
        buf = catBytes(carry, buf);
        carry = null;
      }
      if (!header) {
        if (buf.length < 4) {
          carry = buf;
          return EMPTY;
        }
        const h = str4(buf, 0) === "FRM8" ? scanDffHeader(buf) : scanDsfHeader(buf);
        if (!h) {
          carry = buf;
          return EMPTY;
        }
        header = h;
        setupFilters(h);
        buf = buf.subarray(h.dataStart);
        dataConsumed = 0;
      }
      const remaining = header.dataSize - dataConsumed;
      if (remaining <= 0) return EMPTY;
      if (buf.length > remaining) buf = buf.subarray(0, remaining);
      const frame = header.container === "dsf" ? header.blockSize * header.channels : header.channels;
      const complete = Math.floor(buf.length / frame) * frame;
      if (!complete) {
        carry = buf.length ? buf.slice() : null;
        return EMPTY;
      }
      if (buf.length > complete) carry = buf.subarray(complete).slice();
      dataConsumed += complete;
      const channelData = trim(decodeFrames(buf.subarray(0, complete)));
      return { channelData, sampleRate: ratio > 8 ? stage2.outRate : stage1.outRate };
    },
    flush() {
      if (!header || !carry || !carry.length) {
        carry = null;
        return EMPTY;
      }
      const frame = header.container === "dsf" ? header.blockSize * header.channels : header.channels;
      const padded = new Uint8Array(Math.ceil(carry.length / frame) * frame);
      padded.set(carry);
      carry = null;
      dataConsumed += padded.length;
      const channelData = trim(decodeFrames(padded));
      return { channelData, sampleRate: ratio > 8 ? stage2.outRate : stage1.outRate };
    },
    free() {
      freed = true;
      header = null;
      carry = null;
      stage1 = null;
      stage1Ch = [];
      stage2 = null;
      stage2Ch = null;
    }
  };
}
function decode(src, opts) {
  const dec = decoder(opts);
  try {
    const head = dec.decode(src instanceof Uint8Array ? src : new Uint8Array(src));
    const tail = dec.flush();
    if (!head.channelData.length) return tail;
    if (!tail.channelData.length) return head;
    return {
      channelData: head.channelData.map((c, i) => {
        const r = new Float32Array(c.length + tail.channelData[i].length);
        r.set(c);
        r.set(tail.channelData[i], c.length);
        return r;
      }),
      sampleRate: head.sampleRate
    };
  } finally {
    dec.free();
  }
}

const N_RUNS = 21
const N_WARMUP = 5
const REPS = 1

const input = () => {
  const rate = 2822400, n = rate >> 2, block = 4096, nb = Math.ceil((n >> 3) / block)
  const data = new Uint8Array(nb * block * 2)
  for (let c = 0; c < 2; c++) {
    let x1 = 0, x2 = 0, y = -1
    for (let i = 0; i < n; i++) {
      const xin = 0.5 * Math.sin(2 * Math.PI * (c ? 1500 : 1000) * i / rate)
      x1 += xin - y; x2 += x1 - y; y = x2 >= 0 ? 1 : -1
      const byte = i >> 3
      if (y > 0) data[(((byte / block) | 0) * 2 + c) * block + byte % block] |= 1 << (i & 7)
    }
  }
  const b = new Uint8Array(28 + 52 + 12 + data.length), dv = new DataView(b.buffer)
  const tag = (o, s) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i) }
  const u64 = (o, v) => { dv.setUint32(o, v >>> 0, true); dv.setUint32(o + 4, Math.floor(v / 4294967296), true) }
  tag(0, 'DSD '); u64(4, 28); u64(12, b.length); u64(20, 0)
  tag(28, 'fmt '); u64(32, 52); dv.setUint32(40, 1, true); dv.setUint32(44, 0, true); dv.setUint32(48, 2, true); dv.setUint32(52, 2, true)
  dv.setUint32(56, rate, true); dv.setUint32(60, 1, true); u64(64, n); dv.setUint32(72, block, true); dv.setUint32(76, 0, true)
  tag(80, 'data'); u64(84, 12 + data.length); b.set(data, 92)
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
  const once = () => { for (let r = 0; r < REPS; r++) out = decode(src, { sampleRate: 88200 }) }
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
