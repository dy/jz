// The kernel's internal checkpoints (scripts/self.js checkpoint: park the
// assembled module with link's and the optimizer's inputs before link, and
// the optimized IR before the encoder, into the lane above the heap; finish,
// rewind the arena, unpark) on small programs, through a private kernel whose
// differences from the fresh self build are test overlays
// (test/_self-overlay-build.mjs): both branches made unconditional (the
// shipping threshold, `__heap_large`, is untouched), test-only
// entries beside compileSelf (WAT text through the same checkpointIR, the
// recorder's writers, a census of the IR's literal forms) and one labeled
// failure inside watr's encoder for a program exporting `__fail_after_unpark`.
// Every claim is against jz's own runtime: the forced kernel's output is
// compared byte for byte with the untouched fresh kernel's, executed, and
// reinstantiated from a copy taken before the next compile; the heap
// diagnostics show the rewind and stay readable and writable after it. This is
// checkpoint evidence for the instrumented kernel on small programs, not
// production bootstrap or recursive certification: a checkpoint at the shipping
// threshold (1 GB of growth) is not exercised here.
//
// Run: node test/self-checkpoint.js   (two fresh kernel builds; minutes)
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import watrCompile from 'watr/compile'
import { instantiate } from '../interop.js'
import { readMarks, phaseDeltas } from '../scripts/kernel-marks.mjs'
import { PHASE_RECORDS } from '../scripts/phase-marks.js'
import { selfBytes, selfBuildWith } from './_self-build.js'
import { realpathSync } from 'node:fs'

// Test-only entries beside compileSelf. __checkpointWat runs WAT text through
// the pipeline's tail and, by mode, encodes it directly (0), through the
// checkpoint as parsed (1: quoted strings) or through the checkpoint after
// every quoted string became watr's byte array (2: the form the kernel's
// in-place cleanup leaves in a node it already encoded once). __irForms counts
// a compiled program's IR literal forms: quoted strings, byte arrays, ordinary
// arrays.
const TEST_ENTRIES = `
// test-only (test/self-checkpoint.js)
export { recordPhase, markStage } from '${realpathSync(new URL('../scripts/phase-marks.js', import.meta.url))}'
const __forms = (node, acc) => {
  if (!Array.isArray(node)) { if (typeof node === 'string' && node.charCodeAt(0) === 34) acc[0]++; return acc }
  if (typeof node.valueOf() === 'string') { acc[1]++; return acc }
  acc[2]++
  for (let i = 0; i < node.length; i++) __forms(node[i], acc)
  return acc
}
const __toBytes = (node) => {
  if (!Array.isArray(node)) return typeof node === 'string' && node.charCodeAt(0) === 34 ? watrStr(node) : node
  if (typeof node.valueOf() === 'string') return node
  for (let i = 0; i < node.length; i++) node[i] = __toBytes(node[i])
  return node
}
export function __irForms(source, optJSON) {
  setupSelf(0, optJSON)
  const acc = __forms(optimizeTail(emitIR(front(source, 0, 0)), ctx.transform.optimize), [0, 0, 0])
  return acc[0] + ',' + acc[1] + ',' + acc[2]
}
export function __checkpointWat(text, optJSON, mode) {
  setupSelf(0, optJSON)
  let ir = optimizeTail(watrParse(text), ctx.transform.optimize)
  if (mode === 2) ir = __toBytes(ir)
  return watrCompile(mode ? checkpointIR(ir) : ir)
}
`
// The self graph's import specifiers are already the modules' absolute paths.
const watrSrc = file => realpathSync(new URL(`../node_modules/watr/src/${file}`, import.meta.url))
const FORCED = selfBuildWith({
  'scripts/self.js': [
    // the one behavioral change: both checkpoints run on every compile instead of past 1 GB of growth
    ['if (__heap_large(heapMark)) { const kept = checkpoint([assembled, cfg, facts]);', 'if (1) { const kept = checkpoint([assembled, cfg, facts]);'],
    ['__heap_large(heapMark) ? checkpoint(optimized) : optimized', 'checkpoint(optimized)'],
    ["import watrPrint from '", `import watrParse from '${watrSrc('parse.js')}'\nimport { str as watrStr } from '${watrSrc('util.js')}'\nimport watrPrint from '`],
    ['export default function compileSelf(', TEST_ENTRIES + 'export default function compileSelf('],
  ],
  // the labeled failure, inside the encoder's export handling: after the unpark on this kernel
  'watr/src/compile.js': [[
    '        ctx.export.push([nm, [kind, items.length]])\n',
    '        if (nm.valueOf() === \'"__fail_after_unpark"\') throw new Error(\'test-only failure in the encoder, after the unpark: export "__fail_after_unpark"\')\n        ctx.export.push([nm, [kind, items.length]])\n',
  ]],
})
// module/core.js: the park lane's end. __park_begin grows the instance's memory to
// it: that is address space the engine reserves (memory.buffer.byteLength); the OS
// commits pages as they are touched. The heap cursor (`__heap`) is a third figure.
const PARK_END = 0xFFFFFFF0

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
// a `valueOf()` (watr/src/util.js `str`), not a JS string. A program with such a
// wrapper is where the checkpoint had never produced a valid module.
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
  ok(memoryBytes(forced) >= PARK_END - 0xFFFF && memoryBytes(forced) > memBefore, `the park lane grew the instance's memory, its address space, to the lane's end (${memoryBytes(forced)} bytes; from ${memBefore})`)
  ok(same(fromForced, fromNormal), `the output through park → rewind → unpark → encode is the direct output, ${fromNormal.length} bytes`)
  is(run(fromForced), A_OUT, 'and it executes')
  is(mf.phases.map(p => p.name).join(' '), mn.phases.map(p => p.name).join(' '), 'the same phases, recorded and readable after the rewind')
  // The first checkpoint falls before link: the records up to it rise, link's is below the front's mark.
  const linkAt = mf.phases.findIndex(p => p.name === 'link')
  ok(linkAt > 0, 'link is recorded after the rewind')
  ok(mf.phases.slice(0, linkAt).every((p, i) => p.heap >= (i ? mf.phases[i - 1].heap : mf.heapFront)), 'the records before the checkpoint are intact')
  ok(mf.phases[linkAt].heap < mf.heapFront, `link ran below the front's mark (${mf.phases[linkAt].heap} < ${mf.heapFront})`)
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

// ── parsed WAT literals through the actual checkpoint ─────────────────────────
// Why parkValue may call valueOf on an array: the transport domain is watr's IR,
// the compiler's own output, whose arrays are exactly two kinds. An ordinary
// node is a plain Array (Array.prototype.valueOf returns the array itself, not a
// string) and parks element by element; a string literal watr's cleanup turned
// into a byte array carries its own valueOf returning the quoted source text
// (watr/src/util.js `str`), and watr's encoder discriminates the two by that
// same test (watr/src/compile.js `isStr`). No user object ever enters the tree,
// so the serializer applies the consumer's discriminator, not a coercion rule.
const utf8 = s => [...new TextEncoder().encode(s)]
const WAT = `(module
  (import "env" "print" (func $print (param i32)))
  (import "ünï ✓" "x\\"y\\\\z" (func $imp))
  (memory (export "memory") 1)
  (data (i32.const 0) "")
  (data (i32.const 0) "\\"quoted\\" back\\\\slash")
  (data (i32.const 32) "\\00nul\\00")
  (data (i32.const 48) "héllo ✓ 😀")
  (data (i32.const 64) "\\e2\\9c\\93\\ff\\7f")
  (data (i32.const 80) "\\u{1F600}\\n\\t\\r")
  (func (export "ünï") (result i32) (i32.const 1))
  (func (export "") (result i32) (i32.const 2))
  (func (export "a\\"b\\\\c") (result i32) (i32.const 3))
  (func (export "run") (call $print (i32.const 7)) (call $imp))
  (@custom "jz:test" "\\01\\02")
)`
const DATA = [
  [0, utf8('"quoted" back\\slash')], [32, [0, ...utf8('nul'), 0]], [48, utf8('héllo ✓ 😀')],
  [64, [0xe2, 0x9c, 0x93, 0xff, 0x7f]], [80, [...utf8('😀'), 10, 9, 13]],
]

test('checkpoint: WAT literals (empty, quotes, backslashes, NUL, UTF-8, escaped bytes, names, data, custom) park as text or as bytes and encode the same', () => {
  const { forced } = kernels()
  const encode = mode => new Uint8Array(forced.memory.read(forced.exports.__checkpointWat(forced.memory.String(WAT), 0, mode)))
  const direct = encode(0), asText = encode(1), asBytes = encode(2)
  ok(same(asText, direct), `parsed quoted strings through park → unpark → encode: the direct bytes (${direct.length})`)
  ok(same(asBytes, direct), 'watr byte arrays (own valueOf) through the checkpoint: the same bytes')
  ok(same(direct, watrCompile(WAT)), 'and the host\'s watr encodes the text to the same module')
  const mod = new WebAssembly.Module(asBytes)
  is(WebAssembly.Module.exports(mod).map(e => e.name), ['memory', 'ünï', '', 'a"b\\c', 'run'], 'export names, the empty one included')
  is(WebAssembly.Module.imports(mod).map(i => `${i.module}/${i.name}`), ['env/print', 'ünï ✓/x"y\\z'], 'import names')
  is([...WebAssembly.Module.customSections(mod, 'jz:test')[0] ? new Uint8Array(WebAssembly.Module.customSections(mod, 'jz:test')[0]) : []], [1, 2], 'the custom section\'s bytes')
  let printed = -1, called = 0
  const inst = new WebAssembly.Instance(mod, { env: { print: v => { printed = v } }, 'ünï ✓': { 'x"y\\z': () => { called++ } } })
  const mem = new Uint8Array(inst.exports.memory.buffer)
  for (const [at, bytes] of DATA) is([...mem.subarray(at, at + bytes.length)], bytes, `the data segment at ${at}`)
  inst.exports.run()
  is(printed, 7); is(called, 1)
  is(inst.exports['']() + inst.exports['ünï']() + inst.exports['a"b\\c'](), 6)
})

// A program whose literals survive to run time (returned, not folded) and a host
// import (`print`). jz's parser takes ASCII identifiers only: UTF-8 export and
// import names are the WAT test's above. The escapes are the `\u{…}` form: the
// kernel decodes `\xHH` and `\uHHHH` above 0x7f through the runtime's
// String.fromCharCode, which writes one byte (test/kernel-differential.js), and
// that is not the checkpoint's concern.
const L = `export let e = () => ""
export let q = () => 'a"b\\\\c'
export let nul = () => "\\0x\\0"
export let u = () => "héllo ✓ 😀"
export let esc = () => "\\x7f\\u{ff}\\u{100}\\u{1F600}"
export let uni = () => 5
export let main = () => { console.log("out ✓"); return e().length + q().length + nul().length + u().length + esc().length + uni() }`

test('checkpoint: a program\'s own literals through the forced kernel are the fresh kernel\'s, and read back as themselves', () => {
  const { normal, forced } = kernels()
  const forms = k => k.memory.read(k.exports.__irForms(k.memory.String(L), OPT(k)))
  // In the kernel every literal reaches the checkpoint as watr's byte array: watr's
  // optimizer sizes the module through the encoder's cleanup, which the self build
  // specializes to work in place (scripts/build-profile.mjs), so the quoted strings
  // the emitter and the stdlib parser produce are converted before the tail returns.
  const [quoted, bytes, arrays] = forms(forced).split(',').map(Number)
  ok(bytes > 0 && arrays > 0, `the IR carries byte arrays and ordinary arrays (${quoted} quoted, ${bytes} byte arrays, ${arrays} arrays)`)
  const l = compileOn(forced, L)
  ok(same(l, compileOn(normal, L)), 'the fresh kernel\'s bytes')
  const logged = []
  const ex = instantiate(l, { imports: { env: { print: s => logged.push(s) } } }).exports
  is(ex.e(), ''); is(ex.q(), 'a"b\\c'); is(ex.nul(), '\0x\0'); is(ex.u(), 'héllo ✓ 😀'); is(ex.esc(), '\x7f\xffĀ😀'); is(ex.uni(), 5)
  is(typeof ex.main(), 'number'); is(logged, ['out ✓'], 'the import is called with the literal')
  const again = compileOn(forced, L), after = compileOn(forced, A)
  ok(same(again, l) && same(after, compileOn(normal, A)), 'L again, then A: the same bytes')
  is(instantiate(l).exports.u(), 'héllo ✓ 😀', 'the retained bytes still carry the literal')
})

// ── recording after the real rewind; capacity across checkpoints ─────────────
test('checkpoint: recording after the rewind allocates nothing, first and repeated; capacity zero, overflow and reset hold across checkpoints', () => {
  const { normal, forced } = kernels()
  const aFresh = compileOn(normal, A), bFresh = compileOn(normal, B)
  compileOn(forced, A)   // a real checkpoint: the arena rewound, the unparked IR above the reset mark
  const m0 = readMarks(forced)
  ok(m0.heapCheckpoint > 0 && m0.heapCheckpoint < m0.heapOptimize)
  const NAMES = m0.phases.map(p => p.name)
  // inputs prepared before the measured calls: the name strings live in the arena already
  const listed = forced.memory.String('summary'), unlisted = forced.memory.String('no such phase')
  const h0 = heap(forced)
  forced.exports.recordPhase(listed)
  is(heap(forced), h0, 'the first recording after the rewind allocates nothing')
  for (let i = 0; i < 300; i++) forced.exports.recordPhase(i & 1 ? unlisted : listed)
  forced.exports.markStage(1)
  is(heap(forced), h0, '300 more recordings past the capacity, an unlisted name among them, and a stage mark allocate nothing')
  const m1 = readMarks(forced)
  is(m1.phasesDone, m0.phasesDone + 301, 'every recording counted')
  is(m1.phases.length, Math.min(m1.phasesDone, PHASE_RECORDS), 'recorded up to the capacity')
  is(m1.phasesDropped, m1.phasesDone - PHASE_RECORDS, 'the overflow reported')
  is(m1.phases[m0.phasesDone].name, 'summary'); is(m1.phases[m0.phasesDone + 1].name, 'summary'); is(m1.phases[m0.phasesDone + 2].name, 'other')
  ok(m1.phases.slice(m0.phasesDone).every(p => p.heap === h0), 'each record holds the heap at its recording')
  is(m1.heapEmit, h0, 'the stage mark too'); is(m1.heapCheckpoint, m0.heapCheckpoint, 'the checkpoint\'s mark untouched')
  // capacity zero across a checkpoint
  forced.exports.setPhaseCapacity(0)
  ok(same(compileOn(forced, A), aFresh), 'A with capacity 0 is the fresh kernel\'s A')
  let m = readMarks(forced)
  is(m.phases.length, 0); is(m.phasesDone, m0.phasesDone); is(m.phasesDropped, m0.phasesDone, 'counted, none recorded')
  ok(m.heapCheckpoint > 0 && m.heapCheckpoint < m.heapOptimize, 'the checkpoint ran and its stage mark is kept with capacity 0')
  // overflow at 3
  forced.exports.setPhaseCapacity(3)
  ok(same(compileOn(forced, B), bFresh))
  m = readMarks(forced)
  is(m.phases.map(p => p.name), NAMES.slice(0, 3), 'the first three phases recorded')
  is(m.phasesDropped, m.phasesDone - 3); ok(m.heapCheckpoint > 0 && m.heapCheckpoint < m.heapOptimize)
  // reset to the full capacity
  forced.exports.setPhaseCapacity(PHASE_RECORDS)
  ok(same(compileOn(forced, A), aFresh))
  m = readMarks(forced)
  is(m.phases.map(p => p.name), NAMES, 'the full record again'); is(m.phasesDropped, 0)
  is(readMarks(forced).phaseCapacity ?? PHASE_RECORDS, PHASE_RECORDS)
})

// ── a failure after the unpark, inside the encoder ───────────────────────────
const FAIL = 'export let __fail_after_unpark = () => 1\nexport let main = () => 2'

test('checkpoint: a failure in the encoder after the unpark is attributed past the checkpoint stage; diagnostics and earlier output hold; the next compile recovers', () => {
  const { normal, forced } = kernels()
  const a = compileOn(forced, A)
  is(run(compileOn(normal, FAIL)), 2, 'the fresh kernel, without the injection, compiles the program')
  throws(() => compileOn(forced, FAIL), /test-only failure in the encoder, after the unpark: export "__fail_after_unpark"/)
  const m = readMarks(forced)
  ok(m.heapFront > 0 && m.heapEmit > 0 && m.heapOptimize >= m.heapEmit, 'front, emit and watr completed')
  ok(m.heapCheckpoint > 0 && m.heapCheckpoint < m.heapOptimize, 'the checkpoint completed and rewound: the failure is after it, in the encoder')
  is(m.phases.map(p => p.name).join(' '), readMarks(normal).phases.map(p => p.name).join(' '), 'every phase record is intact')
  ok(phaseDeltas(m).every(d => d.bytes >= 0 || d.name === 'link'), 'every delta rises but link\'s, recorded after the first rewind')
  is(run(a), A_OUT, 'the earlier output is intact')
  const again = compileOn(forced, A)
  ok(same(again, a), 'A right after the failure is the same A'); is(run(again), A_OUT)
  const b = compileOn(forced, B)
  ok(same(b, compileOn(normal, B)), 'then B, checkpointed, is the fresh kernel\'s B'); is(run(b), B_OUT)
  throws(() => compileOn(forced, FAIL), /test-only failure/, 'the failure repeats on demand')
  ok(same(compileOn(forced, A), a), 'and recovery repeats')
})
