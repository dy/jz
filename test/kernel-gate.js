// The kernel gate runner (scripts/kernel-gate.mjs) and its verdicts
// (scripts/kernel-gate-judge.mjs) on fixture kernels, forged worker reports and
// synthetic measurements: the corpus's authored expectations against Node, the
// argument validation, kernel provenance, the runner's failure modes, and every
// way a gate could turn green without earning it. No real kernel is built here;
// the build transaction itself is test/self-build.js's.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '../index.js'
import { PROGRAMS } from '../scripts/kernel-gate-corpus.js'
import { deriveStatus, judgeMemory, judgeSpeed, median, validateReport } from '../scripts/kernel-gate-judge.mjs'
import { onKernel } from './_matrix.js'

const ROOT = new URL('..', import.meta.url).pathname
const RUNNER = join(ROOT, 'scripts/kernel-gate.mjs')
const sha = (b) => createHash('sha256').update(b).digest('hex')
const run = (args, env = {}) => {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 300_000, env: { ...process.env, ...env } })
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }
}
const READERS = "export { PHASE_NAMES, PHASE_RECORDS, phaseCapacity, setPhaseCapacity, phasesDone, phaseNameAt, phaseHeapAt, stageHeap, tapeNodes, tapeCapacity } from './phase-marks.js'\n"
const marks = readFileSync(join(ROOT, 'scripts/phase-marks.js'), 'utf8')
const fixture = (body, readers = true) => compile((readers ? READERS : '') + `export default (source, strict, optJSON) => { ${body} }`, { modules: { './phase-marks.js': marks }, optimize: 1 })
const GARBAGE = 'return new Uint8Array([1, 2, 3])'
const withDir = (fn) => { const dir = mkdtempSync(join(tmpdir(), 'jz-gate-')); try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) } }
const manifestOf = (path) => JSON.parse(readFileSync(path, 'utf8'))

test('kernel gate: the corpus expectations are what Node computes for each source', async () => {
  if (onKernel()) return
  const dir = mkdtempSync(join(tmpdir(), 'jz-gate-corpus-'))
  try {
    for (const p of PROGRAMS) {
      writeFileSync(join(dir, 'm.mjs'), p.src)
      const js = await import(pathToFileURL(join(dir, 'm.mjs')).href + '?' + Math.random())
      for (const [fn, args, expected] of p.calls) ok(Object.is(js[fn](...args), expected), `${p.name}: ${fn}(${args.map(a => JSON.stringify(a)).join(', ')}) = ${JSON.stringify(expected)}`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('kernel gate: every argument is validated before a gate runs', () => {
  if (onKernel()) return
  withDir(dir => {
    writeFileSync(join(dir, 'g.wasm'), fixture(GARBAGE))
    const k = ['--kernel', join(dir, 'g.wasm')]
    for (const [args, message] of [
      [['--gate', 'sequences'], 'name the kernel exactly once'],
      [[...k, '--build', '--gate', 'sequences'], 'name the kernel exactly once'],
      [['--kernel', join(dir, 'none.wasm'), '--gate', 'sequences'], 'no kernel at'],
      [[...k, '--gate', 'nope'], 'unknown gate nope'],
      [[...k, '--gate', ','], '--gate names no gate'],
      [[...k, '--gate', 'sequences,sequences'], 'a gate is named twice'],
      [[...k, '--gate'], '--gate needs a value'],
      [[...k, '--corpus', 'huge', '--gate', 'sequences'], 'unknown corpus huge'],
      [[...k, '--levels', '1,7', '--gate', 'sequences'], '--levels must list levels 0-3'],
      [[...k, '--levels', '1,1', '--gate', 'sequences'], 'a level is listed twice'],
      [[...k, '--tolerance', '-0.1', '--gate', 'sequences'], '--tolerance must be a finite number'],
      [[...k, '--tolerance', 'abc', '--gate', 'sequences'], '--tolerance must be a finite number'],
      [[...k, '--speed-tolerance', 'NaN', '--gate', 'sequences'], '--speed-tolerance must be a finite number'],
      [[...k, '--timeout', '0', '--gate', 'sequences'], '--timeout must be a finite integer ≥ 1'],
      [[...k, '--timeout', '2.5', '--gate', 'sequences'], '--timeout must be a finite integer'],
      [[...k, '--load-limit', '-1', '--gate', 'sequences'], '--load-limit must be a finite number'],
      [[...k, '--gate', 'sequences', '--gate', 'speed'], '--gate given twice'],
      [[...k, '--frobnicate', '--gate', 'sequences'], 'unknown argument --frobnicate'],
      [[...k, '--gate', 'speed', '--baseline-kernel', join(dir, 'none.wasm')], 'no baseline kernel at'],
    ]) {
      const r = run(args)
      is(r.status, 2, `${args.join(' ')}: usage exit`)
      ok(r.out.includes(message), `${args.join(' ')}: ${message}`)
    }
    writeFileSync(join(dir, 'bad.wasm'), new Uint8Array([1, 2, 3]))
    const invalid = run(['--kernel', join(dir, 'bad.wasm'), '--gate', 'sequences'])
    is(invalid.status, 2); ok(invalid.out.includes('is not valid wasm'))
  })
})

test('kernel gate: a kernel without the diagnostics ABI, one whose output is not wasm, one that throws and one that hangs each fail their gate', () => {
  if (onKernel()) return
  withDir(dir => {
    writeFileSync(join(dir, 'stale.wasm'), fixture('return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])', false))
    const stale = run(['--kernel', join(dir, 'stale.wasm'), '--gate', 'sequences', '--json', join(dir, 'stale.json')])
    is(stale.status, 1); is(manifestOf(join(dir, 'stale.json')).status.sequences, 'red'); ok(stale.out.includes('unavailable or outdated'), 'the stale diagnostics ABI is named')

    writeFileSync(join(dir, 'garbage.wasm'), fixture(GARBAGE))
    const garbage = run(['--kernel', join(dir, 'garbage.wasm'), '--gate', 'sequences', '--json', join(dir, 'garbage.json')])
    is(garbage.status, 1)
    const g = manifestOf(join(dir, 'garbage.json'))
    is(g.status.sequences, 'red'); ok(g.gates.sequences.cases.every(c => c.error === 'output is not valid wasm' || c.status === 'red'), 'invalid output is the recorded error')
    ok(g.gates.sequences.cases.every(c => c.completed === false || c.name === 'retained bytes execute after everything'), 'no case counts as completed')
    is(g.certified, false); is(g.kernel.origin, 'unknown', 'no sidecar: origin unknown')

    writeFileSync(join(dir, 'throws.wasm'), fixture('throw new Error("fixture compile failure")'))
    const throws = run(['--kernel', join(dir, 'throws.wasm'), '--gate', 'sequences', '--json', join(dir, 'throws.json')])
    is(throws.status, 1)
    const t = manifestOf(join(dir, 'throws.json'))
    ok(t.gates.sequences.cases.some(c => c.error?.includes('fixture compile failure') && c.failurePhase === 'front'), 'the thrown error and its phase are recorded')
    is(t.gates.sequences.cases.find(c => c.name === 'source error').status, 'green', 'a rejected source counts as the error it is')

    writeFileSync(join(dir, 'hang.wasm'), fixture('let i = 0; while (true) i++; return i'))
    const hang = run(['--kernel', join(dir, 'hang.wasm'), '--gate', 'sequences', '--timeout', '3000', '--json', join(dir, 'hang.json')])
    is(hang.status, 1); const h = manifestOf(join(dir, 'hang.json'))
    is(h.status.sequences, 'red'); ok(/timeout after 3000 ms/.test(h.gates.sequences.why), 'a hang is a timeout, not a pass')
  })
})

test('kernel gate: provenance: a sidecar attests the bytes it names, for the graph it names; anything else is not a certification', () => {
  if (onKernel()) return
  withDir(dir => {
    const bytes = fixture('return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])')   // an empty valid module: sequences all red but "source error"
    writeFileSync(join(dir, 'k.wasm'), bytes)
    // a sidecar naming other bytes
    writeFileSync(join(dir, 'k.wasm.build.json'), JSON.stringify({ kernelSha256: 'f'.repeat(64), graphSha256: 'x' }))
    let m = (run(['--kernel', join(dir, 'k.wasm'), '--gate', 'sequences', '--json', join(dir, 'a.json')]), manifestOf(join(dir, 'a.json')))
    is(m.kernel.origin, 'sidecar names other bytes'); is(m.kernel.matchesRunner, false); is(m.certified, false)
    // a sidecar for these bytes, for another graph
    writeFileSync(join(dir, 'k.wasm.build.json'), JSON.stringify({ kernelSha256: sha(bytes), graphSha256: 'not this graph', watr: { contentSha256: 'x' }, profile: {} }))
    m = (run(['--kernel', join(dir, 'k.wasm'), '--gate', 'sequences', '--json', join(dir, 'b.json')]), manifestOf(join(dir, 'b.json')))
    is(m.kernel.origin, 'attested'); is(m.kernel.matchesRunner, false); ok(/another graph/.test(m.kernel.why)); is(m.certified, false)
    // a sidecar for these bytes and this checkout: attested and matching (the verdicts stay what the bytes earn)
    writeFileSync(join(dir, 'k.wasm.build.json'), JSON.stringify({ kernelSha256: sha(bytes), graphSha256: m.runnerProvenance.graphSha256, watr: m.runnerProvenance.watr, profile: m.runnerProvenance.profile }))
    m = (run(['--kernel', join(dir, 'k.wasm'), '--gate', 'sequences', '--json', join(dir, 'c.json')]), manifestOf(join(dir, 'c.json')))
    is(m.kernel.origin, 'attested'); is(m.kernel.matchesRunner, true); is(m.status.sequences, 'red'); is(m.certified, false)
    ok(typeof m.runnerProvenance.graphSha256 === 'string' && m.runnerProvenance.graphSha256.length === 64 && m.runnerProvenance.watr.files > 0 && Array.isArray(m.runnerProvenance.dirtySources), 'the runner records its own graph, dependency content and dirty sources')
  })
})

test('kernel gate: a worker report is trusted only when whole, finite, complete and consistent, from a worker that exited well', () => {
  if (onKernel()) return
  withDir(dir => {
    writeFileSync(join(dir, 'k.wasm'), fixture(GARBAGE))
    const worker = (body) => { const p = join(dir, 'worker.mjs'); writeFileSync(p, `const gate = process.argv[process.argv.indexOf('--worker') + 1]\n${body}`); return p }
    const seq = ['empty', 'empty again', 'A', 'A again', 'B at once', 'B on a fresh instance', 'source error', 'A after the error', 'retained bytes execute after everything']
    const report = (cases, status, extra = '') => `process.stdout.write('\\n' + JSON.stringify({ gate, status: ${JSON.stringify(status)}, peakRssMiB: 10, cases: ${JSON.stringify(cases)} }) + '\\n')${extra}`
    const green = seq.map(name => ({ name, status: 'green', heap: 1, memoryBytes: 65536, completed: true }))
    const gate = (w, extraArgs = []) => { run(['--kernel', join(dir, 'k.wasm'), '--gate', 'sequences', '--json', join(dir, 'w.json'), ...extraArgs], { JZ_KERNEL_GATE_WORKER: w }); return manifestOf(join(dir, 'w.json')) }
    let m = gate(worker(report(green, 'green')))
    is(m.status.sequences, 'green', 'a whole, consistent report from a clean exit is taken'); ok(m.testOnlyWorker, 'and the manifest says a test worker produced it')
    m = gate(worker(report(green.map((c, i) => i ? c : { ...c, status: 'red' }), 'green')))
    is(m.status.sequences, 'red'); ok(/contradicts its cases/.test(m.gates.sequences.why), 'a green status over a red case is malformed')
    m = gate(worker(report(green.slice(1), 'green')))
    is(m.status.sequences, 'red'); ok(/missing: empty/.test(m.gates.sequences.why), 'a missing case is malformed')
    m = gate(worker(report([...green, { name: 'extra', status: 'green' }], 'green')))
    ok(/unexpected: extra/.test(m.gates.sequences.why), 'an unknown case is malformed')
    m = gate(worker(report([...green.slice(0, -1), { ...green[0] }], 'green')))
    ok(/named twice/.test(m.gates.sequences.why), 'a duplicate case is malformed')
    m = gate(worker(report(green.map(c => ({ ...c, heap: '1000' })), 'green')))
    ok(/heap is not finite/.test(m.gates.sequences.why), 'a metric that is not a finite number is malformed (JSON has no Infinity to carry)')
    m = gate(worker(report(green, 'certified')))
    ok(/not a gate report/.test(m.gates.sequences.why), 'an unknown status is malformed')
    m = gate(worker(report(green, 'green', '; process.exit(1)')))
    is(m.status.sequences, 'red'); ok(/worker exit 1.*not trusted/.test(m.gates.sequences.why), 'a green report from a failed worker is not trusted')
    m = gate(worker(report(green, 'green', '; process.kill(process.pid, "SIGTERM")')))
    is(m.status.sequences, 'red'); ok(/killed by SIGTERM/.test(m.gates.sequences.why))
    m = gate(worker(`process.stdout.write('not json\\n')`))
    is(m.status.sequences, 'red'); ok(/no report from the worker/.test(m.gates.sequences.why), 'an exit of zero without a report is red')
    m = gate(worker(report(green.map(c => ({ ...c, status: 'incomplete' })), 'incomplete')))
    is(m.status.sequences, 'incomplete')
    const r = run(['--kernel', join(dir, 'k.wasm'), '--gate', 'sequences'], { JZ_KERNEL_GATE_WORKER: worker(report(green.map(c => ({ ...c, status: 'incomplete' })), 'incomplete')) })
    is(r.status, 3, 'an incomplete gate exits 3, never like a certification'); ok(r.out.includes('certified: false'))
  })
})

test('kernel gate: memory judges only a complete, compatible, completed row set; a failed compile is not an improvement', () => {
  if (onKernel()) return
  withDir(dir => {
    writeFileSync(join(dir, 'garbage.wasm'), fixture(GARBAGE))
    run(['--kernel', join(dir, 'garbage.wasm'), '--gate', 'sequences,memory', '--json', join(dir, 'a.json')])
    const a = manifestOf(join(dir, 'a.json'))
    is(a.status.memory, 'incomplete'); ok(a.gates.memory.rows.length > 0, 'heap figures recorded'); ok(a.gates.memory.why.includes('no --baseline'))
    ok(a.gates.memory.metrics.memoryBytes.includes('park lane') && a.gates.memory.metrics.peakRssMiB.includes('gate process'), 'the metrics are named for what they measure')
    run(['--kernel', join(dir, 'garbage.wasm'), '--gate', 'sequences,memory', '--baseline', join(dir, 'a.json'), '--json', join(dir, 'b.json')])
    const b = manifestOf(join(dir, 'b.json'))
    is(b.status.memory, 'incomplete'); ok(/not compiled to completion on both sides/.test(b.gates.memory.why), 'garbage compiles never completed: nothing to compare')
    run(['--kernel', join(dir, 'garbage.wasm'), '--gate', 'sequences,memory', '--corpus', 'small', '--baseline', join(dir, 'a.json'), '--json', join(dir, 'c.json')])
    ok(/another corpus/.test(manifestOf(join(dir, 'c.json')).gates.memory.why), 'a baseline from another corpus is not comparable')
  })
  // the verdict itself, on synthetic rows
  const rows = [{ gate: 'functional', name: 'x O1', level: 1, completed: true, heap: 1000, memoryBytes: 65536 }, { gate: 'functional', name: 'y O1', level: 1, completed: true, heap: 2000, memoryBytes: 65536 }]
  const baseline = (over = {}) => ({ corpus: 'small', levels: [1], runnerProvenance: { profile: { optimize: 1 } }, gates: { memory: { rows: rows.map(r => ({ ...r })), peakRssMiB: { functional: 100 }, ...over } } })
  const judge = (mine, base, peaks = { functional: 100 }) => judgeMemory({ rows: mine, peaks, baseline: base, size: 'small', levels: [1], profile: { optimize: 1 }, tolerance: 0.1 })
  is(judge(rows, baseline()).status, 'green', 'the same figures: green')
  is(judge(rows.map(r => ({ ...r, heap: r.heap * 1.2 })), baseline()).status, 'red', '20% more heap: red')
  is(judge(rows, baseline(), { functional: 200 }).status, 'red', 'a doubled process peak: red, judged apart from the heap')
  is(judge(rows.slice(0, 1), baseline()).status, 'incomplete', 'a baseline row this run lacks: incomplete, not green on the one that matched')
  is(judge(rows.map((r, i) => i ? { ...r, completed: false, heap: 10 } : r), baseline()).status, 'incomplete', 'a failed compile with a lower heap is no improvement')
  is(judge(rows, baseline({ rows: [] })).status, 'incomplete', 'a baseline without rows judges nothing')
  is(judgeMemory({ rows, peaks: {}, baseline: { ...baseline(), corpus: 'medium' }, size: 'small', levels: [1], profile: { optimize: 1 }, tolerance: 0.1 }).status, 'incomplete', 'another corpus')
})

test('kernel gate: speed is judged only on validated, attested, unloaded runs, against an explicit threshold', () => {
  if (onKernel()) return
  withDir(dir => {
    writeFileSync(join(dir, 'garbage.wasm'), fixture(GARBAGE))
    writeFileSync(join(dir, 'base.wasm'), fixture(GARBAGE))
    const m = (run(['--kernel', join(dir, 'garbage.wasm'), '--gate', 'speed', '--corpus', 'small', '--baseline-kernel', join(dir, 'base.wasm'), '--load-limit', '1000', '--json', join(dir, 's.json')]), manifestOf(join(dir, 's.json')))
    is(m.status.speed, 'incomplete', 'a kernel whose output is not valid is never timed into a verdict')
    ok(m.gates.speed.cases.every(c => c.status === 'incomplete' && /baseline:/.test(c.why) && c.ratio == null), 'each case names the failed check and carries no ratio')
    const none = (run(['--kernel', join(dir, 'garbage.wasm'), '--gate', 'speed', '--corpus', 'small', '--json', join(dir, 'n.json')]), manifestOf(join(dir, 'n.json')))
    ok(/no --baseline-kernel/.test(none.gates.speed.cases[0].why))
    const loaded = (run(['--kernel', join(dir, 'garbage.wasm'), '--gate', 'speed', '--corpus', 'small', '--baseline-kernel', join(dir, 'base.wasm'), '--load-limit', '0', '--json', join(dir, 'l.json')]), manifestOf(join(dir, 'l.json')))
    ok(/not an unloaded machine/.test(loaded.gates.speed.cases[0].why), 'a loaded machine is incomplete before any timing')
  })
  // the verdict itself, on synthetic timings
  const j = (candidate, extra = {}) => judgeSpeed({ baseline: [10, 11, 10, 12], candidate, tolerance: 0.1, loadBefore: 0.5, loadAfter: 0.6, loadLimit: 2, ...extra })
  is(j([10, 11, 10, 12]).status, 'green'); is(j([10, 11, 10, 12]).ratio, 1)
  is(j([15, 16, 15, 17]).status, 'red', '1.5x: red'); ok(/slower than the baseline/.test(j([15, 16, 15, 17]).why))
  is(j([11, 11, 11, 12]).status, 'green', 'within the tolerance')
  is(j([10, 11, 10, 12], { loadAfter: 3 }).status, 'incomplete', 'load after the case: incomplete, not a green ratio')
  is(j([10, 11, 10, 12], { loadBefore: 2 }).status, 'incomplete', 'load at the limit before the case: incomplete')
  is(j([NaN, NaN, NaN, NaN]).status, 'incomplete', 'no finite ratio')
  is(median([3, 1, 2]), 2); is(median([4, 1, 3, 2]), 2.5)
})

test('kernel gate: the report and status rules, on their own', () => {
  is(deriveStatus([]), 'green'); is(deriveStatus([{ status: 'green' }, { status: 'incomplete' }]), 'incomplete'); is(deriveStatus([{ status: 'incomplete' }, { status: 'red' }]), 'red')
  const ok1 = { gate: 'g', status: 'green', peakRssMiB: 1, cases: [{ name: 'a', status: 'green', ms: 1 }] }
  is(validateReport('g', ok1, ['a']), null)
  is(validateReport('h', ok1, ['a']), 'not a gate report', 'another gate\'s report')
  is(validateReport('g', { ...ok1, peakRssMiB: NaN }, ['a']), 'non-finite peak')
  is(validateReport('g', { ...ok1, cases: [{ status: 'green' }] }, null), 'a case without a name, or named twice')
  is(validateReport('g', { ...ok1, cases: [{ name: 'a', status: 'ok' }] }, ['a']), 'case a: status "ok"')
  is(validateReport('g', { ...ok1, cases: [{ name: 'a', status: 'green', ratio: -Infinity }] }, ['a']), 'case a: ratio is not finite')
  is(validateReport('g', ok1, ['a', 'b']), 'cases missing: b')
  is(validateReport('g', { ...ok1, status: 'red' }, ['a']), 'status red contradicts its cases (green)')
  is(validateReport('g', ok1, null), null, 'a gate without a fixed case set accepts any names')
})
