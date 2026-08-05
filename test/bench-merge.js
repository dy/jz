// Fast-refresh tooling pins (.work/fast-refresh-design.md Pieces 1-2):
// bench/bench.mjs's `--merge` and `--verify-anchors` flags. This file tests
// the TOOLING, not the corpus — every probe is scoped to one cheap case
// (`--cases=mat4 --targets=jz`, plus the 3 fixed anchor rows --verify-anchors
// itself re-measures) so the whole file runs in seconds, not minutes. Every
// probe writes into a scratch copy of bench/results.json — the committed file
// is read-only here, never touched.
//
// Standalone runner: `node test/bench-merge.js`.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'tst'
import { ok } from 'tst/assert.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BENCH = join(ROOT, 'bench/bench.mjs')
const REFERENCE = join(ROOT, 'bench/results.json')
const HEAD_SHA = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()

const scratchDir = mkdtempSync(join(tmpdir(), 'jz-bench-merge-'))
let scratchN = 0
const freshCopy = () => {
  const p = join(scratchDir, `results-${scratchN++}.json`)
  copyFileSync(REFERENCE, p)
  return p
}
const run = args => execFileSync('node', [BENCH, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const runExpectFail = args => {
  try { execFileSync('node', [BENCH, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return { status: 0, out: '' } }
  catch (e) { return { status: e.status, out: `${e.stdout || ''}${e.stderr || ''}` } }
}

const reference = JSON.parse(readFileSync(REFERENCE, 'utf8'))

// ── --merge: byte-preservation + provenance ─────────────────────────────────
test('bench --merge: unmeasured case is byte-preserved', () => {
  const scratch = freshCopy()
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge'])
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(JSON.stringify(merged.cases.fft) === JSON.stringify(reference.cases.fft),
    'untouched case "fft" was not byte-preserved by --merge')
  ok(Object.keys(merged.cases).length === Object.keys(reference.cases).length,
    `case count changed: ${Object.keys(merged.cases).length} vs ${Object.keys(reference.cases).length}`)
})

test('bench --merge: unmeasured targets within the measured case are byte-preserved', () => {
  const scratch = freshCopy()
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge'])
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  for (const tid of Object.keys(reference.cases.mat4.targets)) {
    if (tid === 'jz') continue
    ok(JSON.stringify(merged.cases.mat4.targets[tid]) === JSON.stringify(reference.cases.mat4.targets[tid]),
      `mat4.${tid} was not byte-preserved by --merge`)
  }
})

test('bench --merge: measured row gains fresh data and measuredAt provenance', () => {
  const scratch = freshCopy()
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge'])
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  const jzRow = merged.cases.mat4.targets.jz
  ok(jzRow.measuredAt === HEAD_SHA, `mat4.jz.measuredAt = ${jzRow.measuredAt}, expected HEAD ${HEAD_SHA}`)
  ok(jzRow.medianUs > 0, 'mat4.jz.medianUs missing after merge')
  ok(jzRow.parity === 'ok', `mat4.jz.parity = ${jzRow.parity}, expected 'ok' (checksum unchanged)`)
})

test('bench --merge: mixed-vintage rows set meta.partial; meta.commit is HEAD', () => {
  const scratch = freshCopy()
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge'])
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(merged.meta.partial === true, 'meta.partial not set despite mixed-vintage rows (most rows carry no measuredAt yet)')
  ok(merged.meta.commit === HEAD_SHA, `meta.commit = ${merged.meta.commit}, expected ${HEAD_SHA}`)
})

test('bench --merge: parity is scored against the stored reference checksum, not a single-row vote', () => {
  const scratch = freshCopy()
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge'])
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(merged.cases.mat4.ref === reference.cases.mat4.ref,
    `merged mat4.ref ${merged.cases.mat4.ref} != stored ${reference.cases.mat4.ref} — a lone re-measured row must not out-vote the established reference checksum`)
})

test('bench: without --merge, a full --json run is schema-identical to the pre-merge shape (no measuredAt/partial/anchors)', () => {
  const scratch = freshCopy()
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`])
  const out = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(out.meta.partial === undefined, 'meta.partial should not appear without --merge')
  ok(out.meta.anchors === undefined, 'meta.anchors should not appear without --verify-anchors')
  ok(out.cases.mat4.targets.jz.measuredAt === undefined, 'measuredAt should not appear without --merge')
})

// ── --verify-anchors: pass path ─────────────────────────────────────────────
// Comparing against the COMMITTED reference (captured at some earlier moment,
// possibly under different machine load) makes a hard pass/fail assertion on
// live timing inherently a little flaky at the 1.10× tolerance edge — that
// edge sensitivity is the point of the mechanism, not a test bug. So: measure
// the anchor rivals for real ONCE into a scratch baseline, then immediately
// re-measure via --verify-anchors against that just-written baseline — two
// live samples moments apart, same machine state, which is what "pass path"
// actually means to prove (the mechanism agrees with itself), decoupled from
// however much the committed reference happens to have drifted since it was
// recorded.
const freshAnchorBaseline = () => {
  const scratch = freshCopy()
  run(['--cases=mat4,fft,synth', '--targets=c-wasm,as', `--json=${scratch}`, '--merge'])
  return scratch
}

test('bench --verify-anchors: passes and certifies stored evidence on an unperturbed machine', () => {
  const scratch = freshAnchorBaseline()
  const out = run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--verify-anchors'])
  ok(/\[anchors\] PASS/.test(out), `expected anchors PASS in output:\n${out.slice(-1500)}`)
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(merged.meta.anchors?.pass === true, `meta.anchors.pass not true: ${JSON.stringify(merged.meta.anchors)}`)
  ok(merged.meta.anchors.pairs.length === 3, `expected the default 3 anchor pairs, got ${merged.meta.anchors.pairs.length}`)
  for (const p of merged.meta.anchors.pairs)
    ok(p.pass === true && p.ratio <= 1.10, `anchor ${p.target}×${p.case} did not pass: ratio ${p.ratio}`)
})

test('bench --verify-anchors=1: takes the first N of the seed list', () => {
  const scratch = freshAnchorBaseline()
  const out = run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--verify-anchors=1'])
  ok(/\[anchors\] PASS/.test(out), `expected anchors PASS in output:\n${out.slice(-1500)}`)
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(merged.meta.anchors.pairs.length === 1, `--verify-anchors=1 should check exactly 1 pair, got ${merged.meta.anchors.pairs.length}`)
})

// ── --verify-anchors: fail path (perturbed scratch copy) ────────────────────
test('bench --verify-anchors: detects drift and exits nonzero on a perturbed stored baseline', () => {
  // Start from a just-measured baseline (see freshAnchorBaseline above) so the
  // TWO pairs we don't perturb stay reliably within tolerance — only the one
  // pair we deliberately break should fail.
  const scratch = freshAnchorBaseline()
  const perturbed = JSON.parse(readFileSync(scratch, 'utf8'))
  perturbed.cases.mat4.targets['c-wasm'].medianUs = 1   // impossibly fast — forces a hard drift
  writeFileSync(scratch, JSON.stringify(perturbed, null, 1))

  const { status, out } = runExpectFail(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--verify-anchors'])
  ok(status !== 0 && status != null, `expected nonzero exit on anchor drift, got ${status}`)
  ok(/DRIFT DETECTED/.test(out), `expected a drift report in output:\n${out.slice(-1500)}`)

  const written = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(written.meta.anchors?.pass === false, `meta.anchors.pass should be false: ${JSON.stringify(written.meta.anchors)}`)
  const bad = written.meta.anchors.pairs.find(p => p.case === 'mat4' && p.target === 'c-wasm')
  ok(bad && bad.pass === false && bad.ratio > 1.10, `the perturbed anchor pair should be flagged failed: ${JSON.stringify(bad)}`)
  const good = written.meta.anchors.pairs.filter(p => p !== bad)
  ok(good.every(p => p.pass === true), `unperturbed anchor pairs should still pass: ${JSON.stringify(good)}`)
  // the merge write still happened despite the anchor failure — the drift
  // report doesn't block the (already-measured) data from landing.
  ok(Object.keys(written.cases).length === Object.keys(reference.cases).length,
    'merge should still complete (all cases present) even when anchors fail')
})
