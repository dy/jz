import { PHASE_RECORDS } from './phase-marks.js'

const READERS = ['phasesDone', 'phaseCapacity', 'phaseNameAt', 'phaseHeapAt', 'stageHeap', 'tapeNodes', 'tapeCapacity', 'phaseCheckpoints', 'phaseDeclines']

/**
 * The kernel's heap diagnostics (scripts/phase-marks.js) as one record, read
 * from an instantiated kernel after a compile, a thrown compile error or a trap:
 * the heap pointer after the front, after emit and link, after watr and after
 * the checkpoint; every phase compileAst timed, by name, with the heap after it;
 * the phases the kernel counted past its record capacity (`setPhaseCapacity`
 * lowers it); the tape's node count and column capacity; the phase checkpoints
 * taken (a phase's result parked and the arena rewound to the phase's mark) and declined
 * (the phase wrote into older storage, or its result cannot be parked), each verdict with the phase's
 * mark, the escape flag it read and whether the durable logs held. A mark of 0 is a stage
 * that did not complete. Every read is a call into the kernel that allocates
 * nothing there; the strings come back through the interop's memory reader.
 * @param {{ exports: object, memory: { read(v: any): any } }} self - an `instantiate` result
 */
export function readMarks(self) {
  const ex = self.exports
  if (READERS.some(name => typeof ex[name] !== 'function'))
    throw new Error('Kernel heap diagnostics are unavailable or outdated; rebuild the kernel before reading marks')
  const phasesDone = ex.phasesDone(), capacity = ex.phaseCapacity()
  if (!Number.isSafeInteger(phasesDone) || phasesDone < 0 ||
      !Number.isInteger(capacity) || capacity < 0 || capacity > PHASE_RECORDS)
    throw new Error('Invalid kernel heap diagnostic count or capacity')
  const recorded = Math.min(phasesDone, capacity)
  const phases = []
  for (let i = 0; i < recorded; i++) {
    const name = self.memory.read(ex.phaseNameAt(i)), record = { name, heap: ex.phaseHeapAt(i) }
    // a verdict's record carries what it judged by (scripts/phase-marks.js verdictAt), where the kernel records it
    if (typeof ex.verdictAt === 'function' && name.startsWith('checkpoint:') && name !== 'checkpoint:compacted')
      record.verdict = { mark: ex.verdictAt(i, 0), flag: ex.verdictAt(i, 1), durable: ex.verdictAt(i, 2) === 1, serial: ex.verdictAt(i, 3) }
    phases.push(record)
  }
  return {
    heapFront: ex.stageHeap(0), heapEmit: ex.stageHeap(1), heapOptimize: ex.stageHeap(2), heapCheckpoint: ex.stageHeap(3),
    phases, phasesDone, phasesDropped: phasesDone - recorded,
    tapeNodes: ex.tapeNodes(), tapeCapacity: ex.tapeCapacity(),
    checkpoints: ex.phaseCheckpoints(), declines: ex.phaseDeclines(),
  }
}

/** The allocation between consecutive completions: each phase's heap minus the mark before it
 *  (the front's mark first). A phase nested in another completes first, so a delta is the
 *  bytes allocated since the previous completion, not a phase's inclusive cost. */
export function phaseDeltas(marks) {
  let prev = marks.heapFront
  return marks.phases.map(({ name, heap }) => { const d = heap - prev; prev = heap; return { name, bytes: d } })
}
