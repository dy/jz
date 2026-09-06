// The kernel's internal checkpoint (scripts/self.js checkpointIR: park the WAT
// IR into the lane above the heap, finish, rewind the arena, unpark, encode) on
// small programs, through a private kernel whose only difference from the
// fresh self build is a test overlay making the branch unconditional
// (test/_self-overlay-build.mjs; the shipping threshold, `__heap_large`, is
// untouched). Every claim is against jz's own runtime: the forced kernel's
// output is compared byte for byte with the untouched fresh kernel's, executed,
// and reinstantiated from a copy taken before the next compile; the heap
// diagnostics show the rewind and stay readable after it. This is checkpoint
// evidence for the instrumented kernel, not production bootstrap or recursive
// certification.
//
// Run: node test/self-checkpoint.js   (two fresh kernel builds; minutes)
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { instantiate } from '../interop.js'
import { readMarks, phaseDeltas } from '../scripts/kernel-marks.mjs'
import { selfBytes, selfBuildWith } from './_self-build.js'

// The one overlay: checkpointIR runs on every compile instead of past 1 GB of growth.
const FORCED = selfBuildWith({ 'scripts/self.js': [['__heap_large(heapMark) ? checkpointIR(optimized) : optimized', 'checkpointIR(optimized)']] })
const PARK_END = 0xFFFFFFF0   // module/core.js: the park lane's end, memory grown to it by __park_begin

let normal, forced
const kernels = () => {
  normal ??= instantiate(selfBytes(), { memory: 8192 })
  forced ??= instantiate(FORCED(), { memory: 8192 })
  return { normal, forced }
}
const heap = k => k.instance.exports.__heap.value >>> 0
const memoryBytes = k => k.instance.exports.memory.buffer.byteLength
const OPT = k => k.memory.String('2')
// Compile through the kernel and copy the output out of its memory at once: the
// next compile, `_clear()` or a rewind may reuse the bytes' place.
const compileOn = (k, src) => {
  const out = k.exports.default(k.memory.String(src), 0, OPT(k))
  const bin = k.memory.read(out)
  const bytes = new Uint8Array(bin instanceof Uint8Array ? bin : new Uint8Array(bin))
  if (!WebAssembly.validate(bytes)) throw new Error('compile returned invalid wasm')
  return bytes
}
const run = bytes => instantiate(bytes).exports.main()
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const A = 'export let main = () => 3 + 4 * 5', A_OUT = 23
// B's main has a statement body, so it exports through a `$main$exp` boundary wrapper,
// whose `(export "main")` is WAT text watr parsed: the export name is a byte array with
// a `valueOf()` (watr/src/util.js `str`), not a JS string. Every real program has one.
const B = 'let inc = x => x + 1; export let main = () => { const v = inc(10); return v }', B_OUT = 11
const C = 'const xs = [1, 2, 3]; export let main = () => "hello".length + xs.length + xs[1]', C_OUT = 10

test('checkpoint: the forced kernel parks, rewinds, unparks and encodes; its output is the fresh kernel\'s, byte for byte', () => {
  const { normal, forced } = kernels()
  const memBefore = memoryBytes(forced)
  const fromNormal = compileOn(normal, A)
  const fromForced = compileOn(forced, A)
  const mn = readMarks(normal), mf = readMarks(forced)
  ok(mn.heapCheckpoint >= mn.heapOptimize && mn.heapCheckpoint > 0, `the fresh kernel takes no checkpoint on a small program (${mn.heapOptimize} → ${mn.heapCheckpoint})`)
  ok(mf.heapCheckpoint > 0 && mf.heapCheckpoint < mf.heapOptimize, `the forced kernel rewound: heap after watr ${mf.heapOptimize}, after the checkpoint ${mf.heapCheckpoint}`)
  ok(mf.heapCheckpoint < mf.heapFront, 'the rewind returned below the front\'s mark (the post-init mark), the unparked IR above it')
  ok(memoryBytes(forced) >= PARK_END - 0xFFFF && memoryBytes(forced) > memBefore, `the park lane grew memory to its end (${memoryBytes(forced)} bytes)`)
  ok(same(fromForced, fromNormal), `the output through park → rewind → unpark → encode is the direct output, ${fromNormal.length} bytes`)
  is(run(fromForced), A_OUT, 'and it executes')
  is(mf.phases.map(p => p.name).join(' '), mn.phases.map(p => p.name).join(' '), 'the same phases, recorded and readable after the rewind')
  ok(mf.phases.every((p, i) => p.heap >= (i ? mf.phases[i - 1].heap : mf.heapFront)), 'the records before the checkpoint are intact')
  const h0 = heap(forced)
  readMarks(forced); readMarks(forced)
  is(heap(forced), h0, 'reading the records after the checkpoint allocates nothing in the kernel')
})

test('checkpoint: a boundary-wrapped export, a string literal and an array survive park → unpark → encode', () => {
  const { normal, forced } = kernels()
  const b = compileOn(forced, B)   // was: `Bad export name` from watr's encoder, the parked byte array having lost its valueOf
  ok(same(b, compileOn(normal, B)), 'B through the checkpoint is the fresh kernel\'s B')
  is(run(b), B_OUT)
  const c = compileOn(forced, C)
  ok(same(c, compileOn(normal, C)), 'a data segment and an array literal through the checkpoint')
  is(run(c), C_OUT)
})

test('checkpoint: empty → empty, A → A, A → B at once, and B on a fresh instance agree with the fresh kernel', () => {
  const { normal, forced } = kernels()
  const e1 = compileOn(forced, ''), e2 = compileOn(forced, '')
  ok(same(e1, e2) && same(e1, compileOn(normal, '')), 'empty twice, and the fresh kernel\'s empty')
  is(typeof instantiate(e1).exports.main, 'undefined', 'an empty program has no entry')
  const a1 = compileOn(forced, A), a2 = compileOn(forced, A)
  ok(same(a1, a2), 'A → A')
  const b = compileOn(forced, B)
  ok(same(b, compileOn(normal, B)), 'B right after A is the fresh kernel\'s B')
  is(run(b), B_OUT)
  const fresh = instantiate(FORCED(), { memory: 8192 })
  ok(same(compileOn(fresh, B), b), 'B first on a fresh forced instance is the same B')
  const mb = readMarks(forced)
  ok(mb.heapCheckpoint > 0 && mb.heapCheckpoint < mb.heapOptimize, 'every compile on the forced kernel checkpointed')
  is(run(a1), A_OUT, 'A\'s retained bytes, copied before B, still execute')
  is(run(a2), A_OUT)
})

test('checkpoint: a source error, then A; the abrupt path reports its last completed phase; the other entry points between', () => {
  const { normal, forced } = kernels()
  throws(() => compileOn(forced, 'export let f = ('), 'a parse error rejects')
  let m = readMarks(forced)
  is(m.phasesDone, 0); is(m.heapFront, 0); is(m.heapCheckpoint, 0, 'nothing completed, no checkpoint')
  const a = compileOn(forced, A)
  ok(same(a, compileOn(normal, A)), 'A after the error is the fresh kernel\'s A')
  // abrupt in emit: the BigInt `>>>` the emitter rejects; the checkpoint never runs
  throws(() => compileOn(forced, 'export let f = (n) => { let b = 1n + BigInt(n); return b >>> 2 }'), /unsigned right shift/)
  m = readMarks(forced)
  is(m.phases[m.phases.length - 1].name, 'publishParameterAbi', 'the last completed phase; emitFuncs did not complete')
  ok(m.heapFront > 0 && m.heapEmit === 0 && m.heapOptimize === 0 && m.heapCheckpoint === 0, 'no stage after the front completed')
  ok(phaseDeltas(m).every(d => d.bytes >= 0))
  // the entries that do not encode, between checkpointed compiles: each records from zero, none rewinds
  const wat = forced.memory.read(forced.exports.compileWat(forced.memory.String(A), 0, OPT(forced)))
  is(wat, normal.memory.read(normal.exports.compileWat(normal.memory.String(A), 0, OPT(normal))), 'compileWat prints the same IR')
  m = readMarks(forced); ok(m.phasesDone > 0 && m.heapCheckpoint === 0 && m.heapEmit === 0, 'compileWat: phases recorded, no stage marks')
  forced.exports.compileWarnings(forced.memory.String(A), 0, OPT(forced))
  is(readMarks(forced).phasesDone, m.phasesDone, 'compileWarnings records the same phases from zero')
  forced.exports.compileDiag(forced.memory.String(A), 0, OPT(forced))
  ok(readMarks(forced).phasesDone > 0 && readMarks(forced).phasesDone <= m.phasesDone, 'compileDiag records the front\'s emit phases from zero')
  const again = compileOn(forced, A)
  ok(same(again, a), 'A after the other entries, checkpointed again, is the same A')
  m = readMarks(forced); ok(m.heapCheckpoint > 0 && m.heapCheckpoint < m.heapOptimize)
  is(run(again), A_OUT)
})

test('checkpoint: _clear() keeps its meaning beside the checkpoint; retained bytes reinstantiate after everything', () => {
  const { normal, forced } = kernels()
  const a = compileOn(forced, A)
  const marks = readMarks(forced)
  forced.exports._clear()
  is(JSON.stringify(readMarks(forced)), JSON.stringify(marks), 'the records read the same after _clear()')
  const b = compileOn(forced, B)
  const mb = readMarks(forced)
  ok(mb.heapCheckpoint > 0 && mb.heapCheckpoint < mb.heapOptimize, 'the compile after _clear() checkpointed as before')
  ok(same(b, compileOn(normal, B)))
  is(run(a), A_OUT, 'A\'s bytes, copied before _clear() and B, execute')
  is(run(b), B_OUT)
  const reinstantiated = instantiate(a)
  is(reinstantiated.exports.main(), A_OUT, 'and reinstantiate')
})
