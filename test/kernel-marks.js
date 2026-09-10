// The kernel's heap diagnostics (scripts/phase-marks.js), driven as they run in
// the kernel: the recorder compiled by jz and instantiated, so every claim below
// is about jz's own runtime, not a host mock. A phase name is a static string
// and a record two typed-array slots, so recording and reading back allocate
// nothing; the arena rewind `_clear` performs (the checkpoint's `__park_rewind`
// calls the same `__clear`) leaves the records in place.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { readFileSync } from 'node:fs'
import { compile, _compileInProcess } from '../index.js'
import { instantiate } from '../interop.js'
import { readMarks, phaseDeltas } from '../scripts/kernel-marks.mjs'
import { PHASE_NAMES } from '../scripts/phase-marks.js'
import { levels } from './_matrix.js'

const RECORDER = readFileSync(new URL('../scripts/phase-marks.js', import.meta.url), 'utf8')
// The driver: records like compileAst's profiler hook does, and measures the
// heap around what it drives. `grow` allocates, so the program has an arena.
const DRIVER = `
import { recordPhase, resetMarks, markStage, markTape, phasesDone, phaseCapacity, setPhaseCapacity, phaseNameAt, phaseHeapAt, stageHeap, tapeNodes, tapeCapacity } from './phase-marks.js'
export { resetMarks, phasesDone, phaseCapacity, setPhaseCapacity, phaseNameAt, phaseHeapAt, stageHeap, tapeNodes, tapeCapacity }
const NAMES = ['summary', 'plan:collectFacts', 'link', 'not-a-phase']
export let record = (k, cycle) => { const h0 = __heap_mark(); for (let i = 0; i < k; i++) recordPhase(NAMES[i % cycle]); return __heap_mark() - h0 }
export let stage = (s) => { const h0 = __heap_mark(); markStage(s); markTape(11, 16); return __heap_mark() - h0 }
export let readback = () => { const h0 = __heap_mark(); let n = 0; const done = phasesDone(); for (let i = 0; i < done; i++) { if (phaseNameAt(i).length > 0 && phaseHeapAt(i) > 0) n++ } stageHeap(0); tapeNodes(); return (__heap_mark() - h0) * 1000000 + n }
export let grow = (n) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = 'x' + i; return a.length }
export let heap = () => __heap_mark() >>> 0
let stamp = 0
export const writeStamp = v => { stamp = v }
export const readStamp = () => stamp
`
const kernel = (optimize = 2) => {
  const wasm = compile(DRIVER, { modules: { './phase-marks.js': RECORDER }, optimize })
  return instantiate(wasm, { memory: 256 })
}

for (const optimize of levels(false, 1, 2, 3)) test(`kernel marks: first/repeated recording and readback allocate nothing O${optimize || 0}`, () => {
  const k = kernel(optimize), ex = k.exports
  const start = ex.heap()
  is(ex.record(1, 3), 0, 'the first record')
  is(ex.heap(), start, 'the host independently observes no first-store allocation')
  is(ex.record(255, 3), 0, '255 more, the records full')
  is(ex.stage(1), 0, 'a stage mark and the tape figures')
  is(ex.readback(), 256, '256 records read, 0 bytes')
  const beforeRead = ex.heap(), m = readMarks(k)
  is(ex.heap(), beforeRead, 'the host reader allocates nothing in the kernel')
  is(m.phases.length, 256); is(m.phasesDone, 256); is(m.phasesDropped, 0)
  is(m.phases[0].name, 'summary'); is(m.phases[1].name, 'summary'); is(m.phases[2].name, 'plan:collectFacts'); is(m.phases[3].name, 'link'); is(m.phases[255].name, 'link')
  ok(m.phases.every((p, i) => p.heap > 0 && (i === 0 || p.heap >= m.phases[i - 1].heap)), 'heap marks, never decreasing')
  is(m.heapEmit, m.phases[255].heap, 'the stage mark after the last record'); is(m.tapeNodes, 11); is(m.tapeCapacity, 16)
  ok(phaseDeltas(m).every(d => d.bytes >= 0))
})

test('kernel marks: a phase past the capacity is counted, not recorded, through the recorder itself', () => {
  const k = kernel(), ex = k.exports
  is(ex.record(300, 3), 0, '300 records into 256 slots allocate nothing')
  let m = readMarks(k)
  is(m.phasesDone, 300); is(m.phases.length, 256); is(m.phasesDropped, 44)
  ex.setPhaseCapacity(8); ex.resetMarks()
  is(ex.record(20, 3), 0)
  m = readMarks(k)
  is(m.phasesDone, 20); is(m.phases.length, 8); is(m.phasesDropped, 12); is(m.phases[7].name, 'plan:collectFacts')
  ex.setPhaseCapacity(1000); is(ex.phaseCapacity(), 256, 'never above the records'); ex.setPhaseCapacity(-1); is(ex.phaseCapacity(), 0)
  ex.resetMarks(); ex.record(3, 3); m = readMarks(k); is(m.phases.length, 0); is(m.phasesDropped, 3)
  ex.setPhaseCapacity(256)
})

for (const optimize of levels(false, 1, 2, 3)) test(`kernel marks: capacities and read indices have integer bounds O${optimize || 0}`, () => {
  const k = kernel(optimize), ex = k.exports
  for (const [input, capacity] of [[1.5, 1], [0.5, 0], [NaN, 0], [-0, 0], [-Infinity, 0], [Infinity, 256], [255.9, 255]]) {
    ex.setPhaseCapacity(input); ex.resetMarks()
    is(ex.phaseCapacity(), capacity, `capacity ${input}`)
    is(ex.record(3, 3), 0)
    const m = readMarks(k), recorded = Math.min(3, capacity)
    is(m.phases.length, recorded); is(m.phasesDropped, 3 - recorded)
  }
  ex.setPhaseCapacity(1); ex.record(3, 3); ex.stage(0)
  is(readMarks(k).phasesDropped, 2)
  ex.setPhaseCapacity(256)
  is(ex.phasesDone(), 0, 'raising the limit starts a new recording, not stale slots')
  is(ex.stageHeap(0), 0, 'stage marks belong to that recording too')
  is(readMarks(k).phases.length, 0)
  ex.record(3, 3); ex.stage(0)
  for (const index of [-1, 0.5, 3, 256, NaN, Infinity]) {
    is(ex.phaseNameAt(index), '', `name index ${index}`)
    is(ex.phaseHeapAt(index), 0, `heap index ${index}`)
  }
  for (const index of [-1, 0.5, 4, NaN, Infinity]) is(ex.stageHeap(index), 0, `stage ${index}`)
  is(ex.phaseNameAt(-0), 'summary', '-0 is index zero')
})

test('kernel marks: a name the table lacks records as `other`; the table names every phase compileAst times', () => {
  const k = kernel(), ex = k.exports
  ex.record(4, 4)
  is(readMarks(k).phases.map(p => p.name).join(' '), 'summary plan:collectFacts link other')
  // every phase a native compile times, through the same profiler hook the kernel installs, is in the table
  const profile = {}
  _compileInProcess('class P { x = 1; len() { return this.x } }; const a = [new P()]; export let f = (n) => { let s = 0; for (let i = 0; i < n; i++) s += a[i % 1].len(); return s }; export let g = (m) => { const o = {}; o["k" + m] = m; return JSON.stringify(o) }', { optimize: 3, profile })
  const timed = new Set(profile.entries.map(e => e.name).filter(n => !['parse', 'liftIIFE', 'jzify', 'prepare', 'preEval', 'compile', 'watOptimize', 'watCleanup', 'watrCompile', 'watrPrint', 'snapshotInit', 'lateLink'].includes(n)))
  const missing = [...timed].filter(n => !PHASE_NAMES.includes(n))
  is(missing.join(' '), '', 'every timed phase is named')
})

test('kernel marks: stale or malformed reader state fails explicitly', () => {
  throws(() => readMarks({exports:{}, memory:{read:v=>v}}), /rebuild the kernel/)
  const fake = {
    exports: {phasesDone:()=>0, phaseCapacity:()=>256,
      phaseNameAt:()=>{throw Error('unexpected record read')}, phaseHeapAt:()=>0,
      stageHeap:()=>0, tapeNodes:()=>0, tapeCapacity:()=>0},
    memory: {read:v=>v},
  }
  for (const [done, capacity] of [[NaN,256], [-1,256], [1.5,256], [0,NaN], [0,Infinity], [0,257], [0,1.5], [0,-1]]) {
    fake.exports.phasesDone = () => done; fake.exports.phaseCapacity = () => capacity
    throws(() => readMarks(fake), /Invalid kernel heap diagnostic/, `${done}/${capacity}`)
  }
})

test('kernel marks: a reset starts from zero; records survive the arena rewind and further allocation', () => {
  const k = kernel(), ex = k.exports
  ex.record(5, 3); ex.stage(0); ex.stage(3)
  const before = readMarks(k)
  is(before.phases.length, 5); ok(before.heapFront > 0 && before.heapCheckpoint > 0)
  const heapBefore = ex.heap()
  ex.grow(4000)
  const heapGrown = ex.heap()
  ok(heapGrown > heapBefore, 'the arena grew')
  ex.writeStamp(7); is(ex.readStamp(), 7)
  ex._clear()   // __clear mechanism only, NOT the full park/rewind/unpark pipeline
  is(ex.readStamp(), 0, 'ordinary mutable globals still reset')
  ok(ex.heap() < heapGrown && ex.heap() <= heapBefore, 'the arena rewound')
  ex.grow(4000); ex.grow(4000)
  const after = readMarks(k)
  is(JSON.stringify(after), JSON.stringify(before), 'the records as they were, through the rewind and 8000 allocations')
  ex.resetMarks()
  const zero = readMarks(k)
  is(zero.phases.length, 0); is(zero.phasesDone, 0); is(zero.heapFront, 0); is(zero.heapCheckpoint, 0); is(zero.tapeNodes, 0)
  is(ex.record(2, 3), 0, 'recording after the rewind still allocates nothing')
  is(readMarks(k).phasesDone, 2, 'counted afresh')
})
