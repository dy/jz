/**
 * self.js — the jz compiler packaged as a single `source → wasm bytes` function,
 * the exact form compiled to wasm for self-compiling. `npm run build` compiles THIS
 * to dist/jz.wasm; the resulting module's `default(source)` is jz, compiled by jz.
 *
 * It bundles the whole pipeline — parse (jessie) → jzify → prepare → compile →
 * watr-encode — so the wasm takes a source string and returns wasm bytes with no
 * host help. index.js's host-facing `compile()` wraps the same pipeline with
 * imports/memory/profiling/interop, none of which the self-compile wasm needs (or can
 * run); this is why the self-compile entry is its own minimal, interop-free module and
 * lives in the build layer rather than in the sealed compiler source.
 */
import { DBG_INVARIANTS, assertCtxInvariants } from '../src/debug.js'
import { parse } from '../src/parse.js'
import { compile as watrCompile } from 'watr'
import watrPrint from 'watr/print'
import { ctx, initWarnings, setLinkDemand } from '../src/ctx.js'
import prepare, { GLOBALS } from '../src/prepare/index.js'
import { frontHalf } from '../src/front.js'
import { beginSession, configureDiagnostics, configureMemory } from '../src/session.js'
import { assemble, linkAssembled, tailFacts } from '../src/compile/index.js'
import { configureFixedMemory, verifyFixedScratch, verifyFixedMemory } from '../src/compile/fixed-memory.js'

import { emitter, emissionHooks } from '../src/compile/emit.js'
import { watrTail } from '../src/optimize/watr-tail.js'
import { T, resetTape, fromWat, toWat, tapeState, restoreTape } from '../src/ir/tape.js'
import { linkPasses } from '../src/link/index.js'
import { resetMarks, recordPhase, recordVerdict, openPhase, closePhase, markStage, markTape, countCheckpoint, countDecline, STAGE_FRONT, STAGE_EMIT, STAGE_OPTIMIZE, STAGE_CHECKPOINT } from './phase-marks.js'
import jzify from '../jzify/index.js'

// Final-optimizer tail shared with the host pipeline: its inputs are the
// compile context's facts read once (tailFacts), so it runs after the arena
// was rewound; watr option policy remains owned by watr-tail.js.
function optimizeTail(module, cfg, facts = tailFacts(cfg)) {
  return watrTail(module, cfg, facts)
}

// Shared front half of every kernel entry: reset ctx, apply the option JSON,
// parse + lower. `optJSON` is the one options channel across the wasm ABI —
// a JSON string of the host-facing `opts.optimize` value (level number, alias
// string, or per-pass object via resolveOptimize), falsy → optimize off.
// Every public compile entry also accepts sourceType as its final ABI argument.
//
// beginSession resets the fact store and DOLLAR's backing Map each compile.
// In-kernel these objects live in the bump arena: an entry retained across
// _clear could otherwise point into reused storage.

function setupSelf(strict, optJSON, modulesJSON, host, buildJSON) {
  resetMarks()
  const build = buildJSON ? JSON.parse(buildJSON) : null
  // Session lifecycle — the SAME beginSession native setupCtx runs
  // (src/session.js): ctx reset, every cache clear, watr name-uids, warnings,
  // strict/host/optimize normalization, post-reset invariants. Only the wasm-ABI
  // unmarshaling (JSON strings, 0-defaults) and the kernel's transform
  // injections remain here.
  beginSession({
    emitter, globals: GLOBALS,
    hooks: emissionHooks(),
    optimize: optJSON ? JSON.parse(optJSON) : false,
    strict: !!strict, host: host || undefined, alloc: build?.alloc,
  })
  ctx.transform.jzify = jzify
  ctx.transform.parse = parse    // module bundling (prepareModule) parses imported sources — same injection native does
  ctx.transform.phaseCheckpoint = checkpointPhase   // a phase's result alone kept past its arena growth (below)
  // Bundled-module sources (the native opts.modules channel): one JSON dict
  // over the wasm ABI — prepare's import resolution reads importSources the
  // same way native does.
  // reset() already clears the source-graph authority. Populate it only when
  // this compile actually received opts.modules; never inherit the compiler's
  // own build graph into a later user compile.
  if (modulesJSON) ctx.module.importSources = JSON.parse(modulesJSON)
  if (build) {
    configureDiagnostics(build)
    configureMemory(build)
    configureFixedMemory(build.fixedMemory)
    if (build.imports) {
      ctx.module.hostImports = build.imports
      for (const mod of Object.values(build.imports))
        for (const name of Object.keys(mod))
          if (typeof mod[name] === 'string') mod[name] = Number(mod[name])
    }
    if (build.externalImports) setLinkDemand('external')
    if (build.compactCollections) ctx.transform.compactCollections = true
  }
}

// The canonical front half shared with index.js. preEval must run: omitting it
// changes constant-folded result bits and output shape between host and kernel.
function front(source, strict, sourceType) {
  return frontHalf(source, {
    strict, sourceType: sourceType || 'jz', jzify,
    afterPrepare: DBG_INVARIANTS ? () => assertCtxInvariants(ctx, 'post-prepare') : undefined,
  })
}

function emitIR(ast) {
  const module = linkAssembled(assemble(ast, stageMarks), stageMarks)
  if (DBG_INVARIANTS) assertCtxInvariants(ctx, 'post-compile')
  return module
}

const PARK_NULL = 0
const PARK_UNDEFINED = 1
const PARK_FALSE = 2
const PARK_TRUE = 3
const PARK_NUMBER = 4
const PARK_STRING = 5
const PARK_BIGINT = 6
const PARK_ARRAY = 7
const PARK_OBJECT = 8
const PARK_MAP = 9
const PARK_SET = 10
const PARK_STRREF = 11
const PARK_INT = 12
const PARK_REF = 13
const PARK_I32S = 14
const PARK_F64S = 15

// A string is written once, the first time; every later occurrence is its
// index in the order of first writes (an IR's op names and local names
// repeat per node). A 32-bit integer is written as one. The table is the
// park's own, handed down the walk: a checkpoint taken inside a phase files
// nothing into module state.
function parkString(text, strings) {
  const ref = strings.get(text)
  if (ref !== undefined) { __park_write_u8(PARK_STRREF); __park_write_u32(ref); return }
  strings.set(text, strings.size)
  __park_write_u8(PARK_STRING); __park_write_str(text)
}

// A heap value a phase did not allocate lies below the phase's mark: it is kept
// by its bits, never copied (an AST node, a function record, a signature the
// narrowing writes onto). The mark is 0 outside a phase checkpoint.
let parkMark = 0
const parked = value => parkMark !== 0 && (__ptr_offset(value) >>> 0) < parkMark
// A value the lane cannot carry (a function, a typed array of another kind
// than the tape's columns): the park fails as a whole, and the lane is abandoned.
let parkFailed = false

function parkValue(value, strings) {
  if (value === null) { __park_write_u8(PARK_NULL); return }
  if (value === undefined) { __park_write_u8(PARK_UNDEFINED); return }
  if (value === false) { __park_write_u8(PARK_FALSE); return }
  if (value === true) { __park_write_u8(PARK_TRUE); return }
  if (typeof value === 'number') {
    if ((value | 0) === value && (value !== 0 || 1 / value > 0)) { __park_write_u8(PARK_INT); __park_write_u32(value); return }
    __park_write_u8(PARK_NUMBER); __park_write_f64(value); return
  }
  if (typeof value === 'string') { parkString(value, strings); return }
  if (typeof value === 'bigint') { __park_write_u8(PARK_BIGINT); __park_write_i64(value); return }
  // The tape's columns (src/ir/tape.js): their bytes, whole.
  if (value instanceof Int32Array) {
    if (parked(value)) { __park_write_u8(PARK_REF); __park_write_ref(value); return }
    __park_write_u8(PARK_I32S); __park_write_u32(value.length); __park_write_bytes(__ptr_offset(value), value.length << 2)
    return
  }
  if (value instanceof Float64Array) {
    if (parked(value)) { __park_write_u8(PARK_REF); __park_write_ref(value); return }
    __park_write_u8(PARK_F64S); __park_write_u32(value.length); __park_write_bytes(__ptr_offset(value), value.length << 3)
    return
  }
  if (Array.isArray(value)) {
    if (parked(value)) { __park_write_u8(PARK_REF); __park_write_ref(value); return }
    // A WAT string literal watr parsed (the stdlib's and the boundary wrappers'
    // text) is a byte array whose valueOf() is its quoted source text
    // (watr/src/util.js `str`); the bytes alone lose it. Park the text: watr's
    // assembler converts a quoted string back to the same literal.
    const text = value.valueOf()
    if (typeof text === 'string') { parkString(text, strings); return }
    __park_write_u8(PARK_ARRAY)
    __park_write_u32(value.length)
    for (let i = 0; i < value.length && !parkFailed; i++) parkValue(value[i], strings)
    return
  }
  if (value instanceof Map) {
    if (parked(value)) { __park_write_u8(PARK_REF); __park_write_ref(value); return }
    __park_write_u8(PARK_MAP)
    __park_write_u32(value.size)
    for (const [k, v] of value) { if (parkFailed) return; parkValue(k, strings); parkValue(v, strings) }
    return
  }
  if (value instanceof Set) {
    if (parked(value)) { __park_write_u8(PARK_REF); __park_write_ref(value); return }
    __park_write_u8(PARK_SET)
    __park_write_u32(value.size)
    for (const v of value) { if (parkFailed) return; parkValue(v, strings) }
    return
  }
  if (value != null && typeof value === 'object') {
    if (parked(value)) { __park_write_u8(PARK_REF); __park_write_ref(value); return }
    const keys = Object.keys(value)
    __park_write_u8(PARK_OBJECT)
    __park_write_u32(keys.length)
    for (let i = 0; i < keys.length && !parkFailed; i++) {
      __park_write_str(keys[i])
      parkValue(value[keys[i]], strings)
    }
    return
  }
  parkFailed = true
}

function unparkValue(strings) {
  const tag = __park_read_u8()
  if (tag === PARK_NULL) return null
  if (tag === PARK_UNDEFINED) return undefined
  if (tag === PARK_FALSE) return false
  if (tag === PARK_TRUE) return true
  if (tag === PARK_NUMBER) return __park_read_f64()
  if (tag === PARK_INT) return __park_read_u32() | 0
  if (tag === PARK_STRING) { const text = __park_read_str(); strings.push(text); return text }
  if (tag === PARK_STRREF) return strings[__park_read_u32() >>> 0]
  if (tag === PARK_BIGINT) return __park_read_i64()
  if (tag === PARK_REF) return __park_read_ref()
  if (tag === PARK_I32S) { const len = __park_read_u32() >>> 0, out = new Int32Array(len); __park_read_bytes(__ptr_offset(out), len << 2); return out }
  if (tag === PARK_F64S) { const len = __park_read_u32() >>> 0, out = new Float64Array(len); __park_read_bytes(__ptr_offset(out), len << 3); return out }
  if (tag === PARK_ARRAY) {
    const len = __park_read_u32() >>> 0
    const out = new Array(len)
    for (let i = 0; i < len; i++) out[i] = unparkValue(strings)
    return out
  }
  if (tag === PARK_OBJECT) {
    const len = __park_read_u32() >>> 0
    const out = {}
    for (let i = 0; i < len; i++) out[__park_read_str()] = unparkValue(strings)
    return out
  }
  if (tag === PARK_MAP) {
    const len = __park_read_u32() >>> 0
    const out = new Map()
    for (let i = 0; i < len; i++) { const k = unparkValue(strings); out.set(k, unparkValue(strings)) }
    return out
  }
  if (tag === PARK_SET) {
    const len = __park_read_u32() >>> 0
    const out = new Set()
    for (let i = 0; i < len; i++) out.add(unparkValue(strings))
    return out
  }
  throw new TypeError(`Invalid parked WAT IR tag ${tag}`)
}

function park(value) {
  __park_begin()
  parkFailed = false
  parkValue(value, new Map())
  if (parkFailed) return false
  __park_finish()
  return true
}
function unpark() {
  return unparkValue([])
}

/**
 * Park a value (arrays, records, strings, numbers, Maps, Sets, the tape's
 * typed columns) in the binary lane, rewind the arena to its post-init mark and read the value back: what
 * the compile allocated before is gone, the value alone remains. Every
 * reader after a checkpoint takes its inputs from the value: `ctx` is stale.
 */
function checkpoint(value) {
  if (!park(value)) throw new TypeError('Cannot checkpoint a WAT IR value: a function or a typed array the lane cannot carry in it')
  __park_rewind()
  return unpark()
}
const checkpointIR = checkpoint

/**
 * A phase checkpoint (ctx.transform.phaseCheckpoint; src/summary/index.js
 * summarize takes one per solve): run the phase and, if it grew the arena past
 * PHASE_MIN, park its result with every value from before the phase kept by
 * reference, rewind the arena to the phase's mark and read the result back.
 * The phase's own allocations are gone; the result alone remains above the
 * mark. The rewind runs only where the escape flag says the phase wrote into
 * nothing older than itself (`__park_safe`, the flag of optimize/arena-rewind.js
 * read over the phase as a rewound frame reads it over a call) and the result
 * is data the lane carries worth less than half the growth; otherwise the
 * phase keeps what it made reachable, its memory compacted. A phase
 * that grew less keeps its result in place: parking costs the result's size.
 * Phases nest (compile/index.js `phase`, plan's sweeps, the solve inside them):
 * what a mark saves lives in this frame's locals.
 */
const PHASE_MIN = 16 * 1024 * 1024
function checkpointPhase(run) {
  const mark = __park_mark(), state = __durable_state()
  const esave = __park_enter(), lsave = __park_low_enter(), bsave = __park_base_enter(mark)
  const serial = openPhase(mark >>> 0)
  const out = run()
  closePhase()
  let kept = out
  if (__heap_since(mark) >= PHASE_MIN) {
    // Safe: no escape below the mark, and no durable log grew (a durable
    // collection first touched inside the phase is written into storage from
    // before every mark). The verdict is recorded for the diagnostics before
    // the phase's own record.
    let verdict = 'checkpoint:unsafe'
    const esc = __esc_get() >>> 0, durable = __durable_state() === state
    if (__park_safe(mark) && durable) {
      parkMark = mark >>> 0
      verdict = !park(out) ? 'checkpoint:unparkable' : !__park_worth(mark) ? 'checkpoint:unworthy' : 'checkpoint:taken'
      parkMark = 0
    }
    if (verdict === 'checkpoint:taken') { __park_rewind_to(mark, state); kept = unpark(); countCheckpoint() }
    else countDecline()
    recordVerdict(verdict, mark >>> 0, esc, durable ? 1 : 0, serial)
    // A phase that wrote into older storage, or whose result the lane cannot
    // carry, keeps what it made reachable and no more: its memory compacted
    // (module/core.js `__gc_phase`), the result and the phase's own captures
    // among the roots. A result worth more than half the growth stays as it is.
    if (verdict === 'checkpoint:unsafe' || verdict === 'checkpoint:unparkable') {
      const top = __heap_mark()
      kept = __gc_phase(mark, out, run)
      if (__heap_mark() !== top) recordPhase('checkpoint:compacted')
    }
  }
  __park_end(esave, bsave, lsave)
  return kept
}

// Heap diagnostics: scripts/phase-marks.js records them, scripts/kernel-marks.mjs
// reads them through these exports, after a trap or a thrown compile error too.
export { PHASE_NAMES, PHASE_RECORDS, phaseCapacity, setPhaseCapacity, phasesDone, phaseNameAt, phaseHeapAt, stageHeap, tapeNodes, tapeCapacity, phaseCheckpoints, phaseDeclines, verdictAt, phaseOpenAddr } from './phase-marks.js'
const stageMarks = { time(name, fn) { const out = fn(); recordPhase(name); return out } }

/**
 * @param {string} source - JS source
 * @param {boolean} [strict] - enforce the pure canonical subset (skip jzify)
 * @param {string} [optJSON] - optimize config as JSON (level / alias / per-pass object)
 * @returns {Uint8Array} compiled wasm bytes
 */
function compileModule(source, strict, optJSON, modulesJSON, host, sourceType, buildJSON) {
  const heapMark = __heap_mark()
  setupSelf(strict, optJSON, modulesJSON, host, buildJSON)
  // The front is a phase like assemble's: what it made and nothing reaches goes.
  const ast = checkpointPhase(() => front(source, strict, sourceType))
  markStage(STAGE_FRONT)
  // The assembled module and the inputs of every pass after it: a large
  // compile decodes the module onto the tape and checkpoints the tape with
  // link's and the optimizer's inputs, so the front's and the analyses'
  // allocations and the tree the tape was decoded from are released before
  // link and the optimizer run.
  const assembled = assemble(ast, stageMarks)
  let cfg = ctx.transform.optimize
  let facts = tailFacts(cfg)
  if (DBG_INVARIANTS) assertCtxInvariants(ctx, 'post-compile')
  let module
  if (__heap_large(heapMark)) {
    resetTape()
    const root = fromWat(assembled.module)
    const kept = checkpoint([tapeState(), root, assembled.link, cfg, facts])
    restoreTape(kept[0]); cfg = kept[3]; facts = kept[4]
    // Each of link's passes is a phase: what it made and left unreached goes
    // before the next one runs and before the tape is read back.
    const linkFacts = kept[2]
    linkFacts.phase = checkpointPhase
    module = stageMarks.time('link', () => { linkPasses(kept[1], linkFacts); return toWat(kept[1]) })
  }
  else module = linkAssembled(assembled, stageMarks)
  markStage(STAGE_EMIT)
  markTape(T.n, T.op.length)
  verifyFixedScratch(module, facts.fixedMemory)
  const optimized = optimizeTail(module, cfg, facts)
  verifyFixedMemory(optimized, facts.fixedMemory)
  markStage(STAGE_OPTIMIZE)
  const checkpointed = __heap_large(heapMark) ? checkpoint(optimized) : optimized
  markStage(STAGE_CHECKPOINT)
  return checkpointed
}

export default function compileSelf(source, strict, optJSON, modulesJSON, host, sourceType, buildJSON) {
  return watrCompile(compileModule(source, strict, optJSON, modulesJSON, host, sourceType, buildJSON))
}

/**
 * Compile-time advisories variant: runs the same pipeline with the advisory sink
 * enabled and returns the collected warning entries as JSON. The advise passes
 * (plan/advise.js, plan/scope.js, narrow.js) all fire inside compileAst, gated on
 * `ctx.warnings`, so the kernel computes the exact same advisories native does — it
 * just surfaces them through this entry instead of the host's `opts.warnings` sink.
 * Lets the self-compile leg satisfy the `warningsFor()` tests faithfully.
 * @returns {string} JSON array of `{ code, message, ... }` entries
 */
export function compileWarnings(source, strict, optJSON, modulesJSON, host, sourceType, buildJSON) {
  setupSelf(strict, optJSON, modulesJSON, host, buildJSON)
  const sink = { entries: [] }
  initWarnings(sink)
  optimizeTail(emitIR(front(source, strict, sourceType)), ctx.transform.optimize)
  initWarnings(null)
  return JSON.stringify(sink.entries)
}

// Both output formats consume the same optimized, checkpointed module. Text
// output must release dead analysis allocations before the printer grows strings.
export function compileWat(source, strict, optJSON, modulesJSON, host, sourceType, buildJSON) {
  return watrPrint(compileModule(source, strict, optJSON, modulesJSON, host, sourceType, buildJSON))
}

/**
 * Self-compile divergence diagnostics: run the same pipeline with the internal
 * diagnostic sink armed (resolveIncludes + assemble's global-snapshot sweep
 * record what they resolved) and return the records as JSON. Running this
 * HOST-side and KERNEL-side on the same input and diffing the two JSON
 * strings names the first divergent fact behind a host/kernel byte drift —
 * the archaeology channel for the parity work (.work/archive/todo.md, jz.wasm item).
 * @returns {string} JSON of { resolve: [...], sweep: {...} }
 */
export function compileDiag(source, strict, optJSON) {
  setupSelf(strict, optJSON)
  ctx.core.diagSink = {}
  emitIR(front(source, strict))
  return JSON.stringify(ctx.core.diagSink)
}
