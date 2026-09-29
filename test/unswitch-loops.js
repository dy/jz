// A loop that tests a name it never writes runs as a copy for each answer
// (plan/unswitch-loops.js): each copy keeps its answer's arms and gives its
// own declarations fresh names, so a value a copy computes has the kind of
// its arm. A kernel taking a mono buffer or a list of channels reads
// `x = stereo ? (L[i] + R[i]) * 0.5 : L[i]` as a number in the stereo copy,
// where the sum after it adds numbers; in the mono copy `x` may be a channel.
import test from 'tst'
import { is } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const src = `const mono = new Float32Array([0.5, -1, 2, 0.25]), left = new Float32Array([1, 2, 3, 4]), right = new Float32Array([4, 3, 2, 1])
const mix = (data, g) => {
  let stereo = data[0]?.length !== undefined
  let L = stereo ? data[0] : data, R = stereo ? data[1] : null, acc = 0
  for (let i = 0; i < L.length; i++) {
    let x = stereo ? (L[i] + R[i]) * 0.5 : L[i]
    acc = acc * g + x
    if (stereo) { L[i] = x; R[i] = -x } else L[i] = x * 2
  }
  return acc
}
export let run = (which, g) => which ? mix([left, right], g) : mix(mono, g)
export let peek = () => [...mono, ...left, ...right].join()`

test('unswitch loops: each answer runs its own arms, as the host runs them', () => {
  for (const optimize of levels(0, 2, 3)) {
    const host = oracle(src), m = run(src, { optimize })
    for (const [which, g] of [[0, 0.5], [1, 0.5], [1, 2], [0, 1], [1, 1]]) is(m.run(which, g), host.run(which, g), `run(${which}, ${g}) at ${optimize}`)
    is(m.peek(), host.peek(), `the buffers after at ${optimize}`)
  }
})

test('unswitch loops: the stereo copy adds numbers', () => {
  if (belowOpt(2)) return
  // the loops of `mix`, and the sums in each the summary cannot hold to numbers
  const loops = (text) => {
    const f = funcWat(text, 'mix'), out = []
    for (let at = f.indexOf('(loop'); at >= 0; at = f.indexOf('(loop', at + 1)) {
      let depth = 0, end = at
      do { const c = f[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < f.length)
      out.push(f.slice(at, end))
    }
    return out.map(l => (l.match(/call \$__add_slow/g) || []).length)
  }
  const on = loops(wat(src, { optimize: 2 })), off = loops(wat(src, { optimize: { level: 2, unswitchLoops: false } }))
  is(off.join(), '2', 'one loop: the channels\' sum and the running sum may both concatenate')
  is(on.join(), '1,1', 'a copy for each answer, one sum each that may concatenate: the stereo copy\'s running sum adds numbers')
})
