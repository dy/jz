// The kernel gate runner (scripts/kernel-gate.mjs) on fixture kernels: the corpus's
// authored expectations against Node, and the runner's own failure modes without
// building a real kernel. A fixture kernel is a small jz program with the
// diagnostics readers and a `default` of the chosen behavior.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '../index.js'
import { PROGRAMS } from '../scripts/kernel-gate-corpus.js'
import { onKernel } from './_matrix.js'

const ROOT = new URL('..', import.meta.url).pathname
const RUNNER = join(ROOT, 'scripts/kernel-gate.mjs')
const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 300_000, ...opts })
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }
}
const READERS = "export { PHASE_NAMES, PHASE_RECORDS, phaseCapacity, setPhaseCapacity, phasesDone, phaseNameAt, phaseHeapAt, stageHeap, tapeNodes, tapeCapacity } from './phase-marks.js'\n"
const marks = readFileSync(join(ROOT, 'scripts/phase-marks.js'), 'utf8')
const fixture = (body, readers = true) => compile((readers ? READERS : '') + `export default (source, strict, optJSON) => { ${body} }`, { modules: { './phase-marks.js': marks }, optimize: 1 })

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

test('kernel gate: the kernel must be named; a missing or invalid file rejects before any gate', () => {
  if (onKernel()) return
  const none = run(['--gate', 'sequences'])
  is(none.status, 2); ok(none.out.includes('name the kernel'), 'no kernel named')
  const missing = run(['--kernel', join(tmpdir(), 'no-such-kernel.wasm'), '--gate', 'sequences'])
  is(missing.status, 2); ok(missing.out.includes('no kernel at'))
  const dir = mkdtempSync(join(tmpdir(), 'jz-gate-'))
  try {
    writeFileSync(join(dir, 'bad.wasm'), new Uint8Array([1, 2, 3]))
    const invalid = run(['--kernel', join(dir, 'bad.wasm'), '--gate', 'sequences'])
    is(invalid.status, 2); ok(invalid.out.includes('is not valid wasm'))
    const unknown = run(['--kernel', join(dir, 'bad.wasm'), '--gate', 'nope'])
    is(unknown.status, 2); ok(unknown.out.includes('unknown gate nope'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('kernel gate: a kernel without the diagnostics ABI, one whose output is not wasm, one that throws and one that hangs each fail their gate', () => {
  if (onKernel()) return
  const dir = mkdtempSync(join(tmpdir(), 'jz-gate-'))
  const manifest = name => JSON.parse(readFileSync(join(dir, name + '.json'), 'utf8'))
  try {
    writeFileSync(join(dir, 'stale.wasm'), fixture('return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])', false))
    const stale = run(['--kernel', join(dir, 'stale.wasm'), '--gate', 'sequences', '--json', join(dir, 'stale.json')])
    is(stale.status, 1); is(manifest('stale').status.sequences, 'red'); ok(stale.out.includes('unavailable or outdated'), 'the stale diagnostics ABI is named')

    writeFileSync(join(dir, 'garbage.wasm'), fixture('return new Uint8Array([1, 2, 3])'))
    const garbage = run(['--kernel', join(dir, 'garbage.wasm'), '--gate', 'sequences', '--json', join(dir, 'garbage.json')])
    is(garbage.status, 1)
    const g = manifest('garbage')
    is(g.status.sequences, 'red'); ok(g.gates.sequences.cases.every(c => c.error === 'output is not valid wasm' || c.status === 'red'), 'invalid output is the recorded error')
    ok(g.build.kernelSha256.length === 64 && g.jz.graphSha256.length === 64 && typeof g.watr.srcSha256 === 'string', 'the manifest carries the hashes')

    writeFileSync(join(dir, 'throws.wasm'), fixture('throw new Error("fixture compile failure")'))
    const throws = run(['--kernel', join(dir, 'throws.wasm'), '--gate', 'sequences', '--json', join(dir, 'throws.json')])
    is(throws.status, 1)
    const t = manifest('throws')
    ok(t.gates.sequences.cases.some(c => c.error?.includes('fixture compile failure') && c.failurePhase === 'front'), 'the thrown error and its phase are recorded')
    ok(t.gates.sequences.cases.find(c => c.name === 'source error').status === 'green', 'a rejected source counts as the error it is')

    writeFileSync(join(dir, 'hang.wasm'), fixture('let i = 0; while (true) i++; return i'))
    const hang = run(['--kernel', join(dir, 'hang.wasm'), '--gate', 'sequences', '--timeout', '3000', '--json', join(dir, 'hang.json')])
    is(hang.status, 1); const h = manifest('hang')
    is(h.status.sequences, 'red'); ok(/timeout after 3000 ms/.test(h.gates.sequences.why), 'a hang is a timeout, not a pass')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('kernel gate: memory judges only against a baseline; speed is incomplete without one or on a loaded machine', () => {
  if (onKernel()) return
  const dir = mkdtempSync(join(tmpdir(), 'jz-gate-'))
  try {
    writeFileSync(join(dir, 'garbage.wasm'), fixture('return new Uint8Array([1, 2, 3])'))
    run(['--kernel', join(dir, 'garbage.wasm'), '--gate', 'sequences,memory,speed', '--json', join(dir, 'a.json')])
    const a = JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'))
    is(a.status.memory, 'incomplete'); ok(a.gates.memory.rows.length > 0, 'heap figures recorded'); ok(a.gates.memory.why.includes('no --baseline'))
    is(a.status.speed, 'incomplete'); ok(/no --baseline-kernel|not an unloaded machine/.test(a.gates.speed.cases[0].why))
    run(['--kernel', join(dir, 'garbage.wasm'), '--gate', 'sequences,memory', '--baseline', join(dir, 'a.json'), '--json', join(dir, 'b.json')])
    const b = JSON.parse(readFileSync(join(dir, 'b.json'), 'utf8'))
    is(b.status.memory, 'green'); is(b.gates.memory.compared, a.gates.memory.rows.length, 'every case compared against the baseline')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
