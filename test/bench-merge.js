// Fast-refresh tooling pins (bench/README.md Pieces 1-2):
// bench/bench.mjs's `--merge` and `--verify-anchors` flags. This file tests
// the TOOLING, not the corpus — every probe is scoped to one cheap case
// (`--cases=mat4 --targets=jz`, plus the 3 fixed anchor rows --verify-anchors
// itself re-measures). Every
// probe writes into a scratch copy of bench/results.json — the committed file
// is read-only here, never touched.
//
// Standalone runner: `node test/bench-merge.js`.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
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
process.on('exit', () => rmSync(scratchDir, { recursive: true, force: true }))
let scratchN = 0
const freshCopy = () => {
  const p = join(scratchDir, `results-${scratchN++}.json`)
  copyFileSync(REFERENCE, p)
  return p
}
// Keep real builds, execution and checksums; control only the three anchor
// timings. Consecutive real samples can drift beyond 10% on a shared runner.
// This hook exists only in the test subprocess and never writes public evidence.
const timingHook = join(scratchDir, 'anchor-timing.mjs')
writeFileSync(timingHook, String.raw`import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const spawn = cp.spawnSync
cp.spawnSync = (cmd, args, opts) => {
  const result = spawn(cmd, args, opts)
  if (result.status === 0 && args.some(a => /\/(?:mat4\.c|fft\.c|synth\.as)\.wasm$/.test(a)))
    result.stdout = result.stdout.replace(/median_us=\d+/, 'median_us=' + process.env.JZ_TEST_ANCHOR_US)
  return result
}
syncBuiltinESMExports()
`)
const run = (args, medianUs = 1000) => execFileSync(process.execPath, ['--import', timingHook, BENCH, ...args], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, JZ_TEST_ANCHOR_US: String(medianUs) },
})
const runExpectFail = (args, medianUs) => {
  try { return { status: 0, out: run(args, medianUs) } }
  catch (e) { return { status: e.status, out: `${e.stdout || ''}${e.stderr || ''}` } }
}

const reference = JSON.parse(readFileSync(REFERENCE, 'utf8'))
const freshAnchoredCopy = () => {
  const scratch = freshCopy(), seed = JSON.parse(readFileSync(scratch, 'utf8'))
  seed.meta.anchors = { pass: true,
    pairs: [{ case: 'mat4', target: 'c-wasm', storedUs: 1000, freshUs: 1000, ratio: 1, pass: true }],
    ratios: { 'c-wasm×mat4': 1 } }
  writeFileSync(scratch, JSON.stringify(seed))
  return scratch
}

test('bench publication: documentation preserves evidence; changed inputs and history do not', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/bench.yml'), 'utf8')
  const guard = workflow.match(/^            if ! git merge-base[\s\S]*?^            fi\n/m)?.[0]
  ok(guard, 'exercise the publication guard used by CI')
  const cwd = mkdtempSync(join(scratchDir, 'publish-'))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Bench test')
  git('config', 'user.email', 'bench@example.invalid')
  const commit = (file, value) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true })
    writeFileSync(join(cwd, file), value)
    git('add', '--', file)
    git('commit', '-qm', file)
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    return git('rev-parse', 'HEAD')
  }
  const measured = commit('src/compiler.js', 'original')
  const allowed = (sha = measured) => execFileSync('bash', ['-c', guard + '\nprintf "publish allowed\\n"'], {
    cwd, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: sha },
  }).includes('publish allowed')
  ok(allowed(), 'an unchanged source tip can publish')
  for (const file of ['PLAN.md', 'bench/README.md', 'bench/bench.svg', 'bench/index.html', '.work/probe.js', 'LICENSE', 'bench/results.json', 'bench/results-ci.json']) {
    commit(file, 'updated')
    ok(allowed(), `${file} does not invalidate the measured inputs`)
  }
  for (const file of ['src/compiler.js', 'package-lock.json', 'bench/kernel/kernel.js', '.github/workflows/bench.yml']) {
    const before = git('rev-parse', 'HEAD')
    const current = commit(file, 'changed')
    ok(!allowed(before), `${file} prevents the older snapshot from publishing`)
    ok(allowed(current), 'a fresh measurement can publish')
  }
  const beforeDelete = git('rev-parse', 'HEAD')
  git('rm', '--', 'bench/kernel/kernel.js')
  git('commit', '-qm', 'remove kernel')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  ok(!allowed(beforeDelete), 'removing a benchmark input also invalidates the snapshot')
  const current = git('rev-parse', 'HEAD')
  const other = git('commit-tree', 'HEAD^{tree}', '-m', 'unrelated history, identical files')
  git('update-ref', 'refs/remotes/origin/main', other)
  ok(!allowed(current), 'identical files cannot bypass the ancestry check')
})

// ── --merge: byte-preservation + provenance ─────────────────────────────────
test('bench --merge: unmeasured case is byte-preserved', () => {
  const scratch = freshCopy()
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--allow-unanchored'])
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(JSON.stringify(merged.cases.fft) === JSON.stringify(reference.cases.fft),
    'untouched case "fft" was not byte-preserved by --merge')
  ok(Object.keys(merged.cases).length === Object.keys(reference.cases).length,
    `case count changed: ${Object.keys(merged.cases).length} vs ${Object.keys(reference.cases).length}`)
})

test('bench --merge: unmeasured targets within the measured case are byte-preserved', () => {
  const scratch = freshCopy()
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--allow-unanchored'])
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  for (const tid of Object.keys(reference.cases.mat4.targets)) {
    if (tid === 'jz') continue
    ok(JSON.stringify(merged.cases.mat4.targets[tid]) === JSON.stringify(reference.cases.mat4.targets[tid]),
      `mat4.${tid} was not byte-preserved by --merge`)
  }
})

test('bench --merge: measured row gains fresh data and measuredAt provenance', () => {
  const scratch = freshCopy()
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--allow-unanchored'])
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  const jzRow = merged.cases.mat4.targets.jz
  ok(jzRow.measuredAt === HEAD_SHA, `mat4.jz.measuredAt = ${jzRow.measuredAt}, expected HEAD ${HEAD_SHA}`)
  ok(jzRow.medianUs > 0, 'mat4.jz.medianUs missing after merge')
  ok(jzRow.parity === 'ok', `mat4.jz.parity = ${jzRow.parity}, expected 'ok' (checksum unchanged)`)
})

test('bench --merge: meta.invocations preserves entries for targets not touched this run', () => {
  const scratch = freshCopy()
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--allow-unanchored'])
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(Object.keys(merged.meta.invocations).length === Object.keys(reference.meta.invocations).length,
    `--merge with a narrow --targets= collapsed meta.invocations: ${Object.keys(merged.meta.invocations).length} entries vs ${Object.keys(reference.meta.invocations).length} stored`)
  for (const [tid, cmd] of Object.entries(reference.meta.invocations)) {
    if (tid === 'jz') continue
    ok(merged.meta.invocations[tid] === cmd, `meta.invocations.${tid} lost/changed by an unrelated --merge run: ${merged.meta.invocations[tid]} vs ${cmd}`)
  }
  ok(merged.meta.invocations.jz === reference.meta.invocations.jz, 'meta.invocations.jz should reflect the freshly measured target (unchanged command, but must not be dropped)')
})

test('bench --merge: mixed-vintage rows set meta.partial; meta.commit is HEAD', () => {
  const scratch = freshCopy()
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--allow-unanchored'])
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(merged.meta.partial === true, 'meta.partial not set despite mixed-vintage rows (most rows carry no measuredAt yet)')
  ok(merged.meta.commit === HEAD_SHA, `meta.commit = ${merged.meta.commit}, expected ${HEAD_SHA}`)
})

test('bench --merge: parity is scored against the stored reference checksum, not a single-row vote', () => {
  const scratch = freshCopy()
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--allow-unanchored'])
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(merged.cases.mat4.ref === reference.cases.mat4.ref,
    `merged mat4.ref ${merged.cases.mat4.ref} != stored ${reference.cases.mat4.ref} — a lone re-measured row must not out-vote the established reference checksum`)
})

test('bench: a new case uses its pinned oracle without replacing an existing reference', () => {
  const scratch = freshCopy()
  const seed = JSON.parse(readFileSync(scratch, 'utf8'))
  seed.cases.entity = { ref: null, targets: {} }
  writeFileSync(scratch, JSON.stringify(seed))
  run(['--cases=entity', '--targets=v8', `--json=${scratch}`])
  const measured = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(measured.cases.entity.ref === 1275530752, 'entity uses the independently verified checksum')
  ok(measured.cases.entity.targets.v8.parity === 'ok', 'a fresh row is classified against that oracle')

  measured.cases.entity.ref = 0
  writeFileSync(scratch, JSON.stringify(measured))
  run(['--cases=entity', '--targets=v8', `--json=${scratch}`])
  const changed = JSON.parse(readFileSync(scratch, 'utf8')).cases.entity
  ok(changed.ref === 0 && changed.targets.v8.parity === 'DIFF', 'a stored reference is never replaced by the fallback or the latest result')
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
// Build the baseline through the real CLI using controlled anchor timings.
const freshAnchorBaseline = () => {
  const scratch = freshCopy()
  run(['--cases=mat4,fft,synth', '--targets=c-wasm,as', `--json=${scratch}`, '--merge', '--allow-unanchored'])
  return scratch
}

test('bench --verify-anchors: equal timings certify stored evidence', () => {
  const scratch = freshAnchorBaseline()
  const out = run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--verify-anchors'])
  ok(/\[anchors\] PASS/.test(out), `expected anchors PASS in output:\n${out.slice(-1500)}`)
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(merged.meta.anchors?.pass === true, `meta.anchors.pass not true: ${JSON.stringify(merged.meta.anchors)}`)
  ok(merged.meta.anchors.pairs.length === 3, `expected the default 3 anchor pairs, got ${merged.meta.anchors.pairs.length}`)
  for (const p of merged.meta.anchors.pairs)
    ok(p.pass === true && p.storedUs === 1000 && p.freshUs === 1000 && p.ratio === 1,
      `anchor ${p.target}×${p.case} did not use the controlled timing: ${JSON.stringify(p)}`)
})

test('bench --verify-anchors: accepts the 10% boundary and rejects drift in either direction or zero timing', () => {
  const baseline = freshAnchorBaseline()
  for (const [medianUs, pass] of [[1100, true], [1101, false], [910, true], [909, false], [0, false]]) {
    const scratch = freshCopy()
    copyFileSync(baseline, scratch)
    const before = readFileSync(scratch, 'utf8')
    const { status, out } = runExpectFail([
      '--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--verify-anchors=1',
    ], medianUs)
    ok(pass ? status === 0 : status != null && status !== 0, `${medianUs} µs: ${out.slice(-1500)}`)
    if (pass) {
      const pair = JSON.parse(readFileSync(scratch, 'utf8')).meta.anchors.pairs[0]
      ok(pair.pass && pair.freshUs === medianUs, 'the accepted verdict records this invocation')
    } else {
      ok(/refusing to write partial evidence/.test(out), 'failed timing refuses the merge')
      ok(readFileSync(scratch, 'utf8') === before, 'rejection preserves every byte')
    }
  }
})

test('bench --verify-anchors=1: takes the first N of the seed list', () => {
  const scratch = freshAnchorBaseline()
  const out = run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--verify-anchors=1'])
  ok(/\[anchors\] PASS/.test(out), `expected anchors PASS in output:\n${out.slice(-1500)}`)
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(merged.meta.anchors.pairs.length === 1, `--verify-anchors=1 should check exactly 1 pair, got ${merged.meta.anchors.pairs.length}`)
})

test('bench --verify-anchors: a wrong stored checksum row cannot certify timing', () => {
  const scratch = freshAnchorBaseline()
  const stored = JSON.parse(readFileSync(scratch, 'utf8'))
  stored.cases.mat4.targets['c-wasm'].parity = 'DIFF'
  writeFileSync(scratch, JSON.stringify(stored, null, 1))
  const { status, out } = runExpectFail([
    '--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge',
    '--verify-anchors=1', '--allow-unanchored',
  ])
  ok(status !== 0 && /no accepted stored baseline/.test(out),
    `wrong-result anchor row should fail closed:\n${out.slice(-1500)}`)
  const pair = JSON.parse(readFileSync(scratch, 'utf8')).meta.anchors.pairs[0]
  ok(pair.pass === false && pair.ratio == null, `wrong-result anchor produced a ratio: ${JSON.stringify(pair)}`)
})

// ── --verify-anchors: fail path (perturbed scratch copy) ────────────────────
test('bench --verify-anchors: detects drift, exits nonzero, and now REFUSES the write (audit-#13 hygiene item 2a)', () => {
  // Start from a just-measured baseline (see freshAnchorBaseline above) so the
  // TWO pairs we don't perturb stay reliably within tolerance — only the one
  // pair we deliberately break should fail.
  const scratch = freshAnchorBaseline()
  const perturbed = JSON.parse(readFileSync(scratch, 'utf8'))
  perturbed.cases.mat4.targets['c-wasm'].medianUs = 1   // impossibly fast — forces a hard drift
  writeFileSync(scratch, JSON.stringify(perturbed, null, 1))
  const before = readFileSync(scratch, 'utf8')

  const { status, out } = runExpectFail(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--verify-anchors'])
  ok(status !== 0 && status != null, `expected nonzero exit on anchor drift, got ${status}`)
  ok(/DRIFT DETECTED/.test(out), `expected a drift report in output:\n${out.slice(-1500)}`)
  // Superseded by the structural write guard: DRIFT is a CONFIRMED-bad machine
  // state, same category as "never checked" from the writer's point of view —
  // both mean this run's own freshly-measured row is exactly as unconfirmed as
  // the untouched rival rows are. The write is refused outright, matching the
  // never-verified reject-path pin below, not merely reported and shipped.
  ok(/refusing to write partial evidence/.test(out), `expected the write-refusal message in output:\n${out.slice(-1500)}`)
  ok(readFileSync(scratch, 'utf8') === before, 'refused write on anchor drift must leave the file untouched (no partial write, no stale anchors overwrite)')
})

test('bench --verify-anchors + --allow-unanchored: DRIFT is still reported and still exits nonzero, but the write proceeds with the false verdict recorded', () => {
  const scratch = freshAnchorBaseline()
  const perturbed = JSON.parse(readFileSync(scratch, 'utf8'))
  perturbed.cases.mat4.targets['c-wasm'].medianUs = 1
  writeFileSync(scratch, JSON.stringify(perturbed, null, 1))

  // DRIFT DETECTED alone still sets a nonzero exit (a real machine-state
  // finding, independent of whether the write itself is allowed) — so this is
  // runExpectFail, not run(), even with the escape hatch supplied.
  const { status, out } = runExpectFail(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--verify-anchors', '--allow-unanchored'])
  ok(status !== 0 && status != null, `expected nonzero exit on anchor drift even with --allow-unanchored, got ${status}`)
  ok(/DRIFT DETECTED/.test(out), `expected a drift report in output:\n${out.slice(-1500)}`)
  ok(!/refusing to write/.test(out), `--allow-unanchored should bypass the write refusal:\n${out.slice(-1500)}`)

  const written = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(written.meta.anchors?.pass === false, `meta.anchors.pass should be false: ${JSON.stringify(written.meta.anchors)}`)
  const bad = written.meta.anchors.pairs.find(p => p.case === 'mat4' && p.target === 'c-wasm')
  ok(bad && bad.pass === false && bad.ratio > 1.10, `the perturbed anchor pair should be flagged failed: ${JSON.stringify(bad)}`)
  const good = written.meta.anchors.pairs.filter(p => p !== bad)
  ok(good.every(p => p.pass === true), `unperturbed anchor pairs should still pass: ${JSON.stringify(good)}`)
  ok(Object.keys(written.cases).length === Object.keys(reference.cases).length,
    '--allow-unanchored should still complete the merge (all cases present) despite the anchor failure')
})

// ── partial+unanchored structural write guard (audit-#13 hygiene item 2a) ──
// The a9269390 manual restore proved the hole: a narrow --merge with neither
// --verify-anchors (this run) nor a carried prior PASS verdict can still
// land meta.partial=true evidence with NOTHING backing the untouched rival
// rows' trustworthiness. The writer now refuses that write structurally
// (nonzero exit, no file touched) instead of relying on a downstream reader
// (test/bench-claims.js's own meta.partial ⇒ meta.anchors.pass check) to
// catch it after the fact — a check a hand-edited/restored file can bypass
// entirely, which is exactly what happened.
test('bench --merge: REJECT path — partial merge with no anchors verdict at all (neither fresh nor carried) refuses the write', () => {
  // A plain --json (no --merge) write never carries a meta.anchors field
  // (pinned above) — start there, then merge again on top of it so the
  // second run's PREV genuinely has nothing to carry forward.
  const scratch = join(scratchDir, `no-anchors-${scratchN++}.json`)
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`])
  const before = readFileSync(scratch, 'utf8')
  ok(JSON.parse(before).meta.anchors === undefined, 'setup: fresh plain write should carry no anchors field')

  const { status, out } = runExpectFail(['--cases=fft', '--targets=jz', `--json=${scratch}`, '--merge'])
  ok(status !== 0 && status != null, `expected nonzero exit when partial evidence has no anchors backing it, got ${status}`)
  ok(/refusing to write partial evidence/.test(out), `expected the write-refusal message in output:\n${out.slice(-1500)}`)
  ok(readFileSync(scratch, 'utf8') === before, 'refused write must leave the file untouched')
})

test('bench --merge: REJECT path — a carried prior PASS anchors verdict does NOT satisfy the guard (audit-#14 item 8: same-invocation only)', () => {
  // A prior verdict cannot certify the machine state of this invocation.
  const scratch = freshAnchoredCopy()
  const before = readFileSync(scratch, 'utf8')
  const { status, out } = runExpectFail(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge'])
  ok(status !== 0 && status != null, `expected nonzero exit when only a carried verdict backs a partial merge, got ${status}`)
  ok(/SAME-INVOCATION anchors pass/.test(out), `expected the same-invocation refusal message:\n${out.slice(-1500)}`)
  ok(readFileSync(scratch, 'utf8') === before, 'refused write must leave the file untouched')
})

test('bench --merge --allow-unanchored: a carried verdict rides through stamped carried:true (record kept, guard-inert)', () => {
  const scratch = freshAnchoredCopy()
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--allow-unanchored'])
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(merged.meta.anchors?.pass === true, 'the carried verdict itself should ride through unchanged')
  ok(merged.meta.anchors?.carried === true, 'a carried verdict must be stamped carried:true so downstream guards (test/bench-claims.js) can reject it for partial evidence')
})

test('bench --merge: PASS path — a fresh THIS-run --verify-anchors PASS satisfies the guard even with no carried prior verdict', () => {
  const scratch = join(scratchDir, `fresh-anchors-${scratchN++}.json`)
  run(['--cases=mat4,fft,synth', '--targets=c-wasm,as,jz', `--json=${scratch}`])
  ok(JSON.parse(readFileSync(scratch, 'utf8')).meta.anchors === undefined, 'setup: fresh plain write should carry no anchors field')

  const out = run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--verify-anchors'])
  ok(!/refusing to write/.test(out), `a fresh this-run PASS should not trigger the write refusal:\n${out.slice(-1500)}`)
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(merged.meta.partial === true, 'setup: this merge should still be partial (mixed-vintage)')
  ok(merged.meta.anchors?.pass === true, `expected a fresh passing anchors verdict: ${JSON.stringify(merged.meta.anchors)}`)
})

test('bench --merge --allow-unanchored: escape hatch lets a partial, wholly-unverified merge write anyway', () => {
  const scratch = join(scratchDir, `no-anchors-allow-${scratchN++}.json`)
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`])
  ok(JSON.parse(readFileSync(scratch, 'utf8')).meta.anchors === undefined, 'setup: fresh plain write should carry no anchors field')

  const out = run(['--cases=fft', '--targets=jz', `--json=${scratch}`, '--merge', '--allow-unanchored'])
  ok(!/refusing to write/.test(out), `--allow-unanchored should bypass the refusal:\n${out.slice(-1500)}`)
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(merged.meta.partial === true, 'setup: this merge should still be partial (mixed-vintage)')
  ok(merged.meta.anchors === undefined, 'meta.anchors should still be absent — --allow-unanchored writes without fabricating a verdict')
  ok(merged.cases.mat4 && merged.cases.fft, 'both the carried mat4 row and the freshly measured fft row should be present')
})

// ── --merge shrink-guard (audit-#12 item 4) ─────────────────────────────────
// An agent's naive `--merge` once silently fell through to a plain full-file
// overwrite when PREV failed to load, dropping 59/60 cases from the committed
// bench/results.json (recovered by hand). These pin the fix: --merge refuses
// (nonzero exit, NO WRITE) rather than risk narrowing the corpus, and
// --merge-allow-shrink is the explicit way to still do it on purpose.
test('bench --merge: refuses (no write) when there is no file at JSON_PATH to merge into', () => {
  const scratch = join(scratchDir, `missing-${scratchN++}.json`)   // never created — no freshCopy()
  const { status, out } = runExpectFail(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge'])
  ok(status !== 0 && status != null, `expected nonzero exit when PREV is missing, got ${status}`)
  ok(/--merge:.*no existing file/.test(out), `expected a "no existing file" refusal in output:\n${out.slice(-800)}`)
  ok(!existsSync(scratch), 'refused --merge must not write the file at all')
})

test('bench --merge: refuses (no write) when the file at JSON_PATH is unparseable', () => {
  const scratch = join(scratchDir, `corrupt-${scratchN++}.json`)
  writeFileSync(scratch, '{ this is not valid json')
  const before = readFileSync(scratch, 'utf8')
  const { status, out } = runExpectFail(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge'])
  ok(status !== 0 && status != null, `expected nonzero exit when PREV is unparseable, got ${status}`)
  ok(/--merge:.*failed to parse/.test(out), `expected a "failed to parse" refusal in output:\n${out.slice(-800)}`)
  ok(readFileSync(scratch, 'utf8') === before, 'refused --merge must not touch the corrupt file')
})

test('bench --merge-allow-shrink: escape hatch lets --merge proceed with no PREV to merge into', () => {
  const scratch = join(scratchDir, `fresh-${scratchN++}.json`)
  const out = run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--merge-allow-shrink'])
  ok(existsSync(scratch), '--merge-allow-shrink should still write when PREV is missing')
  const written = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(written.cases.mat4?.targets?.jz, `expected a fresh mat4/jz row in the allow-shrink write:\n${out.slice(-500)}`)
  ok(!written.cases.fft, 'a fresh (non-merged) write should only contain the selected case, confirming no PREV was merged in')
})

test('bench --merge: a narrow --cases=/--targets= merge never shrinks case or target counts (shrink-guard does not false-positive)', () => {
  const scratch = freshCopy()
  run(['--cases=mat4', '--targets=jz', `--json=${scratch}`, '--merge', '--allow-unanchored'])
  const merged = JSON.parse(readFileSync(scratch, 'utf8'))
  ok(Object.keys(merged.cases).length >= Object.keys(reference.cases).length,
    'a narrow --merge must never end up with fewer cases than PREV')
  for (const [cid, prevCase] of Object.entries(reference.cases)) {
    const finalTargets = Object.keys(merged.cases[cid]?.targets || {})
    const prevTargets = Object.keys(prevCase.targets || {})
    ok(finalTargets.length >= prevTargets.length,
      `case '${cid}': merged targets (${finalTargets.length}) fewer than PREV's (${prevTargets.length})`)
  }
})
