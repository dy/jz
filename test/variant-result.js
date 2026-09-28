// A specialization variant keeps its origin's result ABI. The origin's result
// was narrowed to an unboxed record pointer (`results: ['i32']` with `ptrKind`);
// a clone that copied only the result type emitted the i32 as a number and
// truncated the record's box to 0, so the caller read slot 0 of address 0
// (compile/variant.js). The program is @audio/stretch-psola with its
// dependency, reduced while jz kept returning a number where V8 returns a
// Float32Array; the helper bodies are stubs.
import test from 'tst'
import { levels } from './_matrix.js'
import { agree } from './util.js'

const src = `function wsola(data, opts) {
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
export let f = () => [kind(psola(new Float32Array(64), { factor: 2.5, sampleRate: 48000 })), kind(psola({ factor: 2 }, {})), psolaBatch(new Float32Array(8), { factor: 1 }).length]`

for (const optimize of levels(0, 1, 2, 3, 'size'))
  test(`variant result: a specialized clone returns its origin's pointer result at ${optimize}`, () => {
    agree(src, 'f', [], { optimize }, `at ${optimize}`)
  })
