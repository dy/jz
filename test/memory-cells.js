// Memory gate: a loop that keeps only its last result runs in the memory of one
// pass, wherever the loop stands and however it is reached, at every level that
// optimizes and on both hosts.
//
// One pass makes a decoder's frame: four channels of 4,096 samples and the record
// that holds them, 66 KB. A thousand passes that keep only the last are 64 MB where
// each pass's memory stays, and a few passes' worth where it goes as the next
// begins (emit/control-flow.js iterationRelease, the frame's restore, the JS host's
// compaction). A cell is one way of writing that loop (SHAPES) at one level on one
// host; its measure is what a call of a thousand passes grows the memory by on a
// fresh instance, the same on every machine.
//  (a) Every cell answers what Node answers. A difference is a miscompile, never
//      listed.
//  (b) A cell is bounded: it grows by no more than BOUND. One that keeps every
//      pass is a gap, and a gap has a name: GAPS lists each with the cells it
//      covers and its cause. A cell kept under no name fails; so does a cell a
//      name covers once it is bounded, so the list holds what the compiler does
//      and only shrinks.
// `node test/memory-cells.js --show` prints every cell of this host with what it
// grows; under JZ_TEST_HOST=wasi, the WASI host's.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { HOST, stressed } from './_matrix.js'
import { jz, oracle } from './util.js'

const PASSES = 1000
// what a bounded cell may grow by: 256 passes' worth, a quarter of what keeping all takes
const BOUND = 256 * 65536
const LEVELS = [1, 2, 3, 'size', 'speed']

const DEC = `const decoder = () => { let buf = new Uint8Array(0); return { decode(chunk) { buf = buf.length ? chunk : chunk; const out = []
    for (let k = 0; k < 4; k++) { const d = new Float32Array(4096); d[0] = chunk[k] + k; out.push(d) }
    buf = buf.subarray(1); return { channelData: out, rate: 44100 } } } }
  const decode = (src) => decoder().decode(src)
  const checked = (src) => { const out = decoder().decode(src); if (!out.channelData.length) throw new Error('no frame'); return out }
  const scanned = (src) => { const out = decoder().decode(src); let k = 0; for (let i = 0; i < 4; i++) { if (out.channelData[i][0] > 2) break; k++ } out.rate = k; return out }\n`
const HEAD = `const src = new Uint8Array(64); for (let i = 0; i < 64; i++) src[i] = i\n    let out = null`
const TAIL = `return out === null ? -1 : out.channelData[3][0] + out.channelData.length + out.rate`
const main = (body, before = '') => `${DEC}${before}  export let f = (n) => { ${HEAD}\n    ${body}\n    ${TAIL} }`

// Where the loop stands and how it is reached; each keeps the last pass's result alone.
const SHAPES = {
  'a for loop': main(`for (let i = 0; i < n; i++) out = decode(src)`),
  'a while loop': main(`let i = 0; while (i < n) { out = decode(src); i++ }`),
  'a do loop': main(`let i = 0; if (n > 0) do { out = decode(src); i++ } while (i < n)`),
  'a for-of loop': main(`const xs = new Int32Array(n); for (const x of xs) out = decode(src)`),
  'two loops nested': main(`for (let i = 0; i < n; i++) for (let r = 0; r < 2; r++) out = decode(src)`),
  'a callee that throws': main(`for (let i = 0; i < n; i++) out = checked(src)`),
  'a callee that breaks a loop of its own': main(`for (let i = 0; i < n; i++) out = scanned(src)`),
  'an arrow called once': main(`const pass = (m) => { for (let r = 0; r < m; r++) out = decode(src) }\n    pass(n)`),
  'an arrow called in a loop': main(`const once = () => { for (let r = 0; r < 2; r++) out = decode(src) }\n    for (let i = 0; i < n; i++) once()`),
  'an arrow that throws, called in a loop': main(`const once = () => { for (let r = 0; r < 2; r++) { out = decode(src); if (!out.channelData.length) throw new Error('no frame') } }\n    for (let i = 0; i < n; i++) once()`),
  'an arrow calling a callee that breaks, called in a loop': main(`const once = () => { for (let r = 0; r < 2; r++) out = scanned(src) }\n    for (let i = 0; i < n; i++) once()`),
  'a function of the module': main(`out = work(n, src)`, `  const work = (n, src) => { let out = null; for (let i = 0; i < n; i++) out = decode(src); return out }\n`),
  'a method': main(`out = new Runner().run(n, src)`, `  class Runner { constructor() { this.ran = 0 } run(n, src) { let out = null; for (let i = 0; i < n; i++) { out = decode(src); this.ran++ } return out } }\n`),
  'a method of an object': main(`out = runner.run(n, src)`, `  const runner = { ran: 0, run(n, src) { let out = null; for (let i = 0; i < n; i++) { out = decode(src); this.ran++ } return out } }\n`),
  'a module binding': main(`for (let i = 0; i < n; i++) last = decode(src)\n    out = last`, `  let last = null\n`),
  'a field of an object made before the loop': main(`const hold = { last: null }\n    for (let i = 0; i < n; i++) hold.last = decode(src)\n    out = hold.last`),
  'an element of an array made before the loop': main(`const hold = [null]\n    for (let i = 0; i < n; i++) hold[0] = decode(src)\n    out = hold[0]`),
}

// The named gaps: [name, the cells it covers, its cause]. A cell: { shape, level, host }.
// The first name that covers a cell is its gap.
const CLOSURES = new Set(['an arrow that throws, called in a loop', 'an arrow calling a callee that breaks, called in a loop'])
const COMPACTED = new Set(['a for-of loop', 'two loops nested', 'an arrow called in a loop', 'a method of an object', 'a module binding'])
const GAPS = [
  ['level 1 and the size tier release no iteration',
    (c) => c.level === 1 || c.level === 'size',
    'The walk a release keeps what escaped by is two kilobytes of runtime, off at the size tier, memory for size (optimize/config.js arenaReach, which iterationRelease needs); level 1 runs neither. The loop keeps every pass.'],
  ['an arrow that stays a closure',
    (c) => CLOSURES.has(c.shape),
    'An arrow whose body throws, or holds a `break` spliced in with a callee, is not spliced into the function around it (plan/inline.js inlinableLambdaBody) and stays a closure. Its loop assigns a binding of that function through a captured cell, which no release names: every pass stays, on either host.'],
  ['a loop only the JS host\'s compaction bounds',
    (c) => c.host === 'wasi' && COMPACTED.has(c.shape),
    'The loop\'s own release keeps a pass of these (a loop inside the loop that carries the result, an iterator\'s loop, a method of an object literal, a module binding the pass assigns), and what bounds them on the JS host is its compaction (51 pages; with optimize.compact off, as many as under WASI). WASI has none (module/core/stub-log.js compactOn).'],
]

const key = (c) => `${c.shape} / ${c.level} / ${c.host}`
const cells = () => Object.keys(SHAPES).flatMap(shape => LEVELS.map(level => ({ shape, level, host: HOST })))
const gapOf = (c) => GAPS.find(([, covers]) => covers(c)) ?? null
// what a call of PASSES passes grows the memory by, on a fresh instance
const grown = (c) => {
  const { exports, memory } = jz(SHAPES[c.shape], { optimize: c.level })
  const at = memory.buffer.byteLength
  exports.f(PASSES)
  return memory.buffer.byteLength - at
}

if (process.argv.includes('--show')) {
  for (const c of cells()) {
    let g
    try { g = grown(c) } catch (e) { g = String(e.message).split('\n')[0] }
    console.log(`${key(c)}  ${typeof g === 'number' ? `${g / 65536} pages  ${g <= BOUND ? 'bounded' : 'KEPT'}` : `throws ${g}`}${gapOf(c) ? `  gap: ${gapOf(c)[0]}` : ''}`)
  }
} else {
  test('memory cells: every way of writing the loop answers what Node answers', () => {
    for (const [shape, src] of Object.entries(SHAPES)) for (const level of LEVELS) {
      // (one instance each: a module binding carries a pass's result from call to call, as the host's)
      const m = jz(src, { optimize: level }).exports, host = oracle(src)
      for (const n of [0, 1, 7]) is(m.f(n), host.f(n), `${shape} at ${level}: f(${n})`)
    }
  })

  test('memory cells: a loop that keeps its last result runs in the memory of one pass, or its gap is named', () => {
    // (under the stress form every chance to compact is taken and the walk's scratch grows the memory: no policy holds there)
    if (stressed()) return
    for (const c of cells()) {
      const g = grown(c), gap = gapOf(c)
      if (gap) ok(g > BOUND, `${key(c)}: listed under "${gap[0]}", and grows ${g / 65536} pages${g > BOUND ? '' : ': the gap closed, take the cell out of GAPS'}`)
      else ok(g <= BOUND, `${key(c)}: grows ${g / 65536} pages for a thousand passes, under no named gap`)
    }
  })

  test('memory cells: every named gap covers a cell of some host', () => {
    const all = Object.keys(SHAPES).flatMap(shape => LEVELS.flatMap(level => ['js', 'wasi'].map(host => ({ shape, level, host }))))
    for (const [name, covers, cause] of GAPS) {
      ok(all.some(covers), `"${name}" covers a cell`)
      ok(typeof cause === 'string' && cause.length > 0, `"${name}" has a cause`)
    }
  })
}
