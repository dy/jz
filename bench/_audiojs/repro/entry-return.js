// @audio/stretch-psola 1.x with its dependency @audio/stretch-wsola, bundled and reduced
// while jz kept returning a number from the entry where V8 returns a Float32Array:
// f() is [2] under V8 and [6] under jz at every optimize level except `false`.
// Helper bodies were cut to stubs on the way, so the helpers no longer return what the
// package's do; the unreduced package fails the same way (the stretch-psola atom traps,
// tune-snap, which calls it, returns the dry signal).
function wsola(data, opts) {
  return new Float32Array(data.length);
}
function writer2(s) {
}
function pitchContour(data, minP, maxP, defP, opts = {}) {
}
function voicedWeights(contour) {
}
function marks(data, contour, minP, maxP) {
}
function render(data, outLen, factor, markPos, periods, voiced, minP, maxP) {
  return 0;
}
function psolaBatchCore(data, opts) {
  let factor = opts?.factor ?? 1;
  if (factor === 1) return { out: new Float32Array(data), contour: null };
  let minP = 96, maxP = 600, defP = 348;
  let n = data.length;
  let outLen = Math.round(n * factor);
  if (n < maxP * 6) return { out: wsola(data, { factor }), contour: null };
  let contour = pitchContour(data, minP, maxP, defP, {});
  let { markPos, periods, voiced } = marks(data, contour, minP, maxP);
  let voicedCount = 0;
  let { out, norm } = render(data, outLen, factor, markPos, periods, voiced, minP, maxP);
  if (voicedCount < voiced.length * 0.95) {
    for (let i = 0; i < outLen; i++) {
    }
  }
  return { out, contour };
}
function psolaBatch(data, opts) {
  return psolaBatchCore(data, opts).out;
}
function psolaStream(opts) {
  let factor = opts?.factor ?? 1;
  let inBuf = new Float32Array(64);
  function segment(len, f2 = factor) {
    let seg = inBuf.slice(0, len);
    let { out, contour } = psolaBatchCore(seg, { factor: f2 });
  }
}
function psola(data, opts) {
  if (Array.isArray(data) && (data[0] instanceof Float32Array || data[0] instanceof Float64Array)) return data.map((ch) => psola(ch, opts));
  if (!(data instanceof Float32Array)) return writer2(psolaStream(data));
  return psolaBatch(data, opts);
}
let kind = (o) => typeof o === 'function' ? 1 : o instanceof Float32Array ? 2 : Array.isArray(o) ? 3 : o == null ? 4 : typeof o === 'object' ? 5 : typeof o === 'number' ? 6 : 8
export let f = () => [kind(psola(new Float32Array(64), { factor: 2.5, sampleRate: 48000 }))]