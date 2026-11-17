/**
 * Release gate for the performance CLAIM: the committed reference dataset
 * (bench/results.json, or JZ_BENCH_RESULTS from CI) must be CURRENT, COMPLETE,
 * and WINNING before the claim ships. Unlike test/bench.js (which measures THIS
 * machine and treats ratios informationally on CI), this gate reads pinned
 * evidence and hard-fails — wired into `prepublishOnly`, run explicitly via `npm
 * run test:claims`. JZ_MEMORY_RESULTS can name a complete benchmark JSON
 * snapshot for the same release's RSS gate.
 *
 *   1. FRESH: no compiler-source commit may postdate any JZ row's
 *                 measuredAt (or meta.commit for a full snapshot): a partial
 *                 rival-only merge must not make carried JZ evidence look fresh.
 *   2. COMPLETE — every named rival (wasm, JIT, porf-native) contributes
 *                 parity-valid rows over ≥ COVERAGE_FLOOR of the corpus;
 *                 an absent or token lane is an uncontested (= unproven) claim.
 *   3. WINNING  — no case beyond the tie band (bench/claims.mjs WASM_BAND_TOL),
 *                 for BOTH promises: "fastest wasm" (CLAIM_RIVALS) and "outruns
 *                 the JIT" (JIT_RIVALS). A row inside the band is a tie: it
 *                 passes, is printed as a target and is never called a lead;
 *                 red rows void the claim outright.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { correctBenchmarkRow, timedBenchmarkRow } from '../assets/headline.js'
import { machineState } from '../bench/machine-state.mjs'
import { PORFFOR_RELEASE, PORFFOR_REV, porfforEvidenceMatches, porfforFloor } from './_porffor-floor.js'
import { MEMORY_CASES, memoryFloor } from './_memory-floor.js'
import { baseOf, CLAIM_CLASSES, CLAIM_EXCEPTIONS, CLAIM_RIVALS, CLAIM_UNMET, claimOf, CONTESTED_FLOOR, contenders, exceptionsOf, FAST_RIVALS, JIT_RIVALS, LANE_CMDS, LANE_FLAGS, PARITY_EXEMPT, SOURCE_SCOPE, unmetOf, WASM_BAND_TOL } from '../bench/claims.mjs'
import { appendEntries, chainProblems, contactProblems, entryProblems, heldoutFigures, LANES, MANIFEST, RECORD, registrationProblem, registrationProblems, rowOf } from '../bench/heldout/lane.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// The named rivals of the claim. Unlike test/bench.js's availability-filtered
// list (what can run HERE), the reference dataset must contest ALL of them.
// (Porffor left the wasm field with its 2026 rewrite — it contests from the
// native band as `porf-native`, presence-gated below, geomean-pinned in
// test/bench.js.)
// The OTHER published promise — "outruns the JIT" — same committed-evidence
// discipline as the wasm claim (audit 2026-07-28: it was ungated; the snapshot
// held 19 JIT losses across 9 cases that no test surfaced). Every JS-runtime
// lane in the reference dataset counts; absence of a lane is a coverage hole,
// not a pass (same COVERAGE_FLOOR as the wasm rivals).
// V8-family engines (node's V8, Deno's V8) and bun/JSC (both JavaScriptCore) are
// separate classes, so a lane's engine family, not its runtime name, decides which
// claim it is held to. A case a class excepts by name (bench/claims.mjs
// CLAIM_EXCEPTIONS: its measured cause and evidence) leaves that class's band
// test and answers to its own band instead: a tripwire, not a claim.
// Minimum per-rival coverage as a FRACTION of the corpus (audit 2026-07-28:
// the old ">=5 rows" floor let 5 successes from a 60-case corpus count as
// "contested"). 0.7 is set from real corpus portability, not convenience: the
// least-portable maintained lanes (go/zig families) genuinely port 43/60 =
// 0.72 of cases; a healthy lane clears 0.7, a token lane cannot.
const COVERAGE_FLOOR = 0.7
// SUPERSEDED 2026-08-28 (perf/size-leadership campaign — the owner's literal bar is
// "ALWAYS smaller than AssemblyScript, ×1, per case"): the geomean-only scoping
// decided 2026-08-01 is kept below as an aggregate backstop, but strict per-case
// leadership is now ALSO asserted (see "claims: size — jz strictly smaller..." below)
// — geomean alone let roughly half the corpus run larger than AS while staying green.
// Mirrors test/bench.js's SIZE_GEOMEAN_MAX.
const SIZE_GEOMEAN_MAX = 1.05
// Compiler-source scope for freshness: a commit touching only tests/docs/site
// doesn't invalidate perf evidence; one touching these does.
// EVERY codegen input (audit 2026-07-27: the old allowlist missed package.json/
// package-lock.json — dependency upgrades like the watr 5.7.12 determinism fix
// change emitted code — and layout.js). Kept as an explicit list because the
// repo also holds non-codegen trees (tests/site/bench evidence); the watr
// version is additionally cross-checked against the snapshot's meta below.
// The list is bench/claims.mjs SOURCE_SCOPE, which the held-out lane shares.

const resultsPath = process.env.JZ_BENCH_RESULTS || join(ROOT, 'bench/results.json')
const res = JSON.parse(readFileSync(resultsPath, 'utf8'))
const memoryPath = process.env.JZ_MEMORY_RESULTS || resultsPath
const memorySnapshot = memoryPath === resultsPath ? res : JSON.parse(readFileSync(memoryPath, 'utf8'))
const cases = res.cases

const staleCompilerCommits = base => {
  if (typeof base !== 'string' || !/^[0-9a-f]{7,40}$/.test(base)) throw Error(`invalid measured commit: ${base}`)
  const opts = { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }
  execFileSync('git', ['merge-base', '--is-ancestor', base, 'HEAD'], opts)
  return execFileSync('git', ['log', '--oneline', `${base}..HEAD`, '--', ...SOURCE_SCOPE], opts).trim()
}

test('claims: reference evidence covers the complete benchmark corpus', () => {
  const expected = readdirSync(join(ROOT, 'bench'), { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(ROOT, 'bench', d.name, `${d.name}.js`)))
    .map(d => d.name)
  const missing = expected.filter(name => !cases[name] && !PENDING_CASES.has(name))
  ok(missing.length === 0, `reference evidence is missing cases: ${missing.join(', ')}`)
})

const collectJzEvidence = snapshot => {
  const byBase = new Map()
  const missing = []
  let evidencedRows = 0
  for (const [name, c] of Object.entries(snapshot.cases)) {
    const row = c.targets?.jz
    if (!timedBenchmarkRow(row)) continue
    evidencedRows++
    const base = 'measuredAt' in row ? row.measuredAt : (!snapshot.meta?.partial ? snapshot.meta?.commit : null)
    if (!base) { missing.push(name); continue }
    const names = byBase.get(base)
    if (names) names.push(name)
    else byBase.set(base, [name])
  }
  return { byBase, missing, evidencedRows }
}

test('claims freshness: partial snapshots use each valid JZ row, not the merge commit', () => {
  const partial = collectJzEvidence({
    meta: { commit: 'new-head', partial: true },
    cases: {
      valid: { targets: { jz: { parity: 'ok', medianUs: 1, measuredAt: 'old-run' } } },
      missing: { targets: { jz: { parity: 'ok', medianUs: 1 } } },
      wrong: { targets: { jz: { parity: 'DIFF', medianUs: 1, measuredAt: 'old-run' } } },
      failed: { targets: { jz: { status: 'fail', measuredAt: 'old-run' } } },
      zero: { targets: { jz: { parity: 'ok', medianUs: 0, measuredAt: 'old-run' } } },
    },
  })
  is(partial.evidencedRows, 2, 'only positive parity-valid JZ rows support the claim')
  is(partial.byBase.get('old-run')?.join(','), 'valid', 'row provenance wins over meta.commit')
  is(partial.byBase.has('new-head'), false, 'partial meta.commit is not used as measurement provenance')
  is(partial.missing.join(','), 'missing', 'partial rows without measuredAt are rejected')

  const full = collectJzEvidence({
    meta: { commit: 'full-run' },
    cases: {
      valid: { targets: { jz: { parity: 'ok', medianUs: 1 } } },
      empty: { targets: { jz: { parity: 'ok', medianUs: 1, measuredAt: '' } } },
      null: { targets: { jz: { parity: 'ok', medianUs: 1, measuredAt: null } } },
    },
  })
  is(full.byBase.get('full-run')?.join(','), 'valid', 'full snapshots fall back to meta.commit')
  is(full.missing.join(','), 'empty,null', 'an explicit invalid row stamp never borrows fresh snapshot metadata')
})

test('claims: compiler inputs are committed before evidence can be fresh', () => {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', ...SOURCE_SCOPE],
    { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).trim()
  ok(!dirty, dirty ? `compiler inputs have uncommitted changes:\n${dirty}` : 'compiler inputs are committed')
})

test('claims: reference evidence is fresh (no compiler commits past any JZ row)', () => {
  const metaBase = res.meta?.commit
  const validMetaBase = typeof metaBase === 'string' && /^[0-9a-f]{7,40}$/.test(metaBase)
  ok(validMetaBase, validMetaBase ? `results.json meta.commit ${metaBase}` : `results.json meta.commit missing/malformed: ${metaBase}`)

  // A partial merge's meta.commit names the write, not every carried JZ run.
  // Full snapshots have no row stamps and use meta.commit.
  const { byBase, missing, evidencedRows } = collectJzEvidence(res)
  ok(evidencedRows >= Math.ceil(Object.keys(cases).length * COVERAGE_FLOOR),
    `${evidencedRows} parity-valid JZ rows carry the performance claim`)
  ok(missing.length === 0, missing.length
    ? `reference has ${missing.length} JZ row(s) without valid measurement provenance: ${missing.slice(0, 12).join(', ')}`
    : 'every JZ evidence row has measurement provenance')

  const staleGroups = []
  for (const [base, names] of byBase) {
    try {
      const stale = staleCompilerCommits(base)
      if (stale) staleGroups.push({ base, names, stale, n: stale.split('\n').length })
    } catch (e) {
      ok(false, `freshness check failed to run (bad JZ row measuredAt ${base}?): ${String(e.message).slice(0, 120)}`)
      return
    }
  }
  const staleRows = staleGroups.reduce((n, x) => n + x.names.length, 0)
  const detail = staleGroups.map(x =>
    `${x.names.length} row(s) @ ${x.base}: ${x.n} compiler commit(s) newer\n${x.stale.split('\n').slice(0, 4).join('\n')}`
  ).join('\n')
  ok(staleRows === 0, staleRows
    ? `reference dataset is STALE: ${staleRows} JZ row(s) predate compiler-source changes; re-run those rows at HEAD:\n${detail}`
    : 'all JZ evidence rows postdate compiler-source changes')

  // The dependency axis the path scope can't see from inside the snapshot: the
  // watr that produced the evidence must be the watr installed now.
  const snapWatr = res.meta?.versions?.watr
  const nowWatr = JSON.parse(readFileSync(join(ROOT, 'node_modules/watr/package.json'), 'utf8')).version
  ok(snapWatr === nowWatr, `reference dataset compiled with watr ${snapWatr}, installed is ${nowWatr} — re-run the reference bench`)
})

// PARTIAL evidence must be anchor-verified: `bench/bench.mjs --merge` can
// leave the dataset mixing vintages — freshly re-measured jz rows alongside
// untouched rival rows from an earlier commit. That's only honest evidence
// if a `--verify-anchors` run in the same session certified the untouched
// rival rows still hold at today's machine state (meta.anchors.pass). A
// partial dataset with no passing anchor check is unverified drift risk, not
// proof.
test('claims: partial (mixed-vintage) evidence requires a passing anchors check (meta.partial ⇒ meta.anchors.pass)', () => {
  if (!res.meta?.partial) { ok(true, 'not a partial refresh (meta.partial unset) — anchors not required'); return }
  ok(res.meta?.anchors?.pass === true,
    `meta.partial is true but meta.anchors.pass is not true (${JSON.stringify(res.meta?.anchors)}) — re-run with --verify-anchors before shipping a partial refresh`)
  // audit-#14 item 8: a CARRIED verdict (bench.mjs stamps carried:true when a
  // merge rides a prior run's anchors through) certifies a DIFFERENT machine
  // state than the one this evidence's own meta records — it cannot back a
  // partial refresh.
  ok(!res.meta.anchors.carried,
    `meta.partial is true but the anchors verdict is carried from a prior run (carried:true) — a same-invocation --verify-anchors pass is required for partial evidence`)
})

// VALIDITY — machine-state sanity for timing evidence (audit-#13 hygiene item
// 2b, bench/machine-state.mjs). The WARM/MEMORY-FLOOR false-red campaign ("WARM
// + MEMORY-FLOOR reds RESOLVED as ENVIRONMENT" status, 2026-08-06) found LIVE
// that swap pressure alone explains multi-percent timing drift with zero code
// change — every fresh timing write now carries meta.machineState; this gate
// holds it to a sane bound so a future regression report can rule out "the
// machine was swapping" before chasing a phantom code cause.
const SWAP_SANE_BOUND_MB = 4096
test('VALIDITY: reference evidence carries machineState within the swap-pressure sane bound', () => {
  const state = res.meta?.machineState
  ok(state, 'committed reference carries no machineState — regenerate bench/results.json via --json/--merge (machine-state capture is unconditional there)')
  if (!state) return
  ok(state.swapUsedMB == null || state.swapUsedMB < SWAP_SANE_BOUND_MB,
    `committed evidence's machineState.swapUsedMB=${state.swapUsedMB}MB exceeds the ${SWAP_SANE_BOUND_MB}MB sane bound — timing evidence recorded under swap pressure is validity-suspect; re-measure on a quieter (post-reboot) machine`)
})

// Live-machine validity (audit-#13 item 2b, inverted per audit-#14 item 9):
// the earlier form asserted swap IS elevated ("KNOWN-BAD documented-red"),
// which turned a bad environment into a green row — the exact disguise the
// validity mechanism exists to prevent. The WARM/MEMORY-FLOOR campaign
// (2026-08-06) established that elevated swap alone explains multi-percent
// timing drift with zero code change.
const _liveState = machineState()
const _liveInvalid = _liveState.swapUsedMB != null && _liveState.swapUsedMB >= SWAP_SANE_BOUND_MB
;(_liveInvalid ? test.todo : test)('VALIDITY: live machine swap pressure below the sane bound (timing evidence is embargoed while this is TODO)', () => {
  if (_liveState.swapUsedMB == null) { ok(true, 'swapUsedMB unavailable on this platform/host (non-darwin, or sysctl missing) — nothing to validate live'); return }
  ok(!_liveInvalid,
    `live swapUsedMB=${_liveState.swapUsedMB}MB exceeds the ${SWAP_SANE_BOUND_MB}MB sane bound — timing/memory evidence gathered now is validity-suspect; reboot before measuring`)
})

// Memory uses the same full benchmark snapshot by default. An explicitly
// supplied memory run must prove its own provenance and machine validity too.
test('claims: memory evidence is fresh (no compiler commits past its measured commit)', () => {
  const base = memorySnapshot.meta?.commit
  const validBase = typeof base === 'string' && /^[0-9a-f]{7,40}$/.test(base)
  ok(validBase, `${memoryPath}: missing measured commit`)
  if (!validBase) return
  ok(!memorySnapshot.meta.partial, 'memory evidence is one complete run, each case on one machine')
  const nowWatr = JSON.parse(readFileSync(join(ROOT, 'node_modules/watr/package.json'), 'utf8')).version
  ok(memorySnapshot.meta.versions?.watr === nowWatr, 'memory evidence uses the installed watr')
  const swap = memorySnapshot.meta.machineState?.swapUsedMB
  ok(!!memorySnapshot.meta.machineState && (swap == null || swap < SWAP_SANE_BOUND_MB), 'memory evidence carries valid machine state')
  // RSS is independent of timing. Validate the provenance of both sides of
  // each memory comparison, including rows with no medianUs measurement.
  const bases = new Set([base])
  for (const name of MEMORY_CASES) for (const target of ['jz', 'v8']) {
    const row = memorySnapshot.cases?.[name]?.targets?.[target]
    if (row && 'measuredAt' in row) bases.add(row.measuredAt)
  }
  for (const measured of bases) {
    let stale
    try {
      stale = staleCompilerCommits(measured)
    } catch (e) {
      ok(false, `memory freshness check failed to run (bad commit ${measured}?): ${String(e.message).slice(0, 120)}`)
      continue
    }
    const n = stale ? stale.split('\n').length : 0
    ok(n === 0, `memory evidence is STALE: ${n} compiler-source commit(s) postdate ${memoryPath}'s commit ${measured}:\n${stale.split('\n').slice(0, 8).join('\n')}`)
  }
})

test('claims: allocation-heavy cases use no more peak RSS than V8', () => {
  const { missing, losses, held } = memoryFloor(memorySnapshot.cases, exceptionsOf('rss'))
  if (held.length) console.log(`  held: ${held.map(([name, ratio]) => `${name} ${ratio.toFixed(3)}× (band ${exceptionsOf('rss').get(name).band}×)`).join(', ')}`)
  ok(missing.length === 0, `missing correct, measured memory rows: ${missing.join(', ')}`)
  ok(losses.length === 0, `JZ/V8 peak-RSS losses: ${losses.map(([name, ratio]) => `${name} ${ratio.toFixed(3)}×`).join(', ')}`)
})

// Same native-lowering caps previously checked by test/bench.js against the
// stored snapshot. Keep reference verdicts together so CI can check a fresh
// dataset without first requiring the obsolete one to pass.
const W2C_GEOMEAN_MAX = 1.35, W2C_CASE_MAX = 3.5
test('claims: jz-w2c native lowering within regression bands', () => {
  const ratios = []
  for (const [name, c] of Object.entries(cases)) {
    const jz = c.targets?.jz, w2c = c.targets?.['jz-w2c']
    if (timedBenchmarkRow(jz) && timedBenchmarkRow(w2c))
      ratios.push([name, w2c.medianUs / jz.medianUs])
  }
  ok(ratios.length >= 20, `too few jz-w2c rows (${ratios.length}) — native lane missing from the evidence refresh`)
  for (const [name, x] of ratios)
    ok(x <= W2C_CASE_MAX, `${name}: w2c/jz ${x.toFixed(2)}× > ${W2C_CASE_MAX}× — native-lowering blowup`)
  const gm = Math.exp(ratios.reduce((s, [, x]) => s + Math.log(x), 0) / ratios.length)
  ok(gm <= W2C_GEOMEAN_MAX, `w2c/jz geomean ${gm.toFixed(3)}× > ${W2C_GEOMEAN_MAX}×`)
})

// The builds the claims are made of (bench/claims.mjs LANE_FLAGS, which the harness
// builds from and records): jz timed at 'speed', its float rewrites on; the exact lane
// the same build with them off; jz's bytes its size build; every strict rival without a
// float relaxation; the fast C lane the strict one with -ffast-math alone added; the
// AssemblyScript bytes at -Oz --converge, as CONTRIBUTING and bench/README state them.
const RELAXES = /fast-math|^-Ofast$|associative-math|reciprocal-math|no-signed-zeros|finite-math|ffp-contract=(fast|on)/
test('claims: the claim lanes build with the pinned flags', () => {
  is(LANE_FLAGS.jz, { level: 'speed' }, "jz's time at 'speed'")
  is(LANE_FLAGS['jz-exact'], { level: 'speed', relaxedFloat: false }, 'the exact lane: speed at JavaScript\'s floats')
  is(LANE_FLAGS['jz-size'], { level: 'size' }, "jz's bytes at 'size'")
  for (const lane of ['c-wasm', 'rust-wasm', 'zig-wasm', 'tinygo', 'as', 'as-size'])
    ok(!LANE_FLAGS[lane].some(f => RELAXES.test(f)), `${lane}: no float relaxation (${LANE_FLAGS[lane].join(' ')})`)
  ok(LANE_FLAGS['c-wasm'].includes('-ffp-contract=off'), 'c-wasm: no multiply-add contracted')
  is(LANE_FLAGS['c-wasm-fast'].filter(f => f !== '-ffast-math'), LANE_FLAGS['c-wasm'].filter(f => f !== '-ffp-contract=off'), 'c-wasm-fast: c-wasm with -ffast-math for its float mode')
  ok(LANE_FLAGS['c-wasm-fast'].includes('-ffast-math'), 'c-wasm-fast: -ffast-math')
  is(LANE_FLAGS['as-size'].slice(0, 2), ['-Oz', '--converge'], "AssemblyScript's bytes at -Oz --converge")
  for (const doc of ['CONTRIBUTING.md'])
    ok(readFileSync(join(ROOT, doc), 'utf8').includes('asc -Oz --converge'), `${doc} states the size lane's flags`)
  for (const [lane, cmd] of Object.entries(LANE_CMDS)) ok(typeof cmd === 'string' && cmd.length > 0, `${lane}: an invocation recorded`)
})

// The docs state only what the committed datasets show: bench/README.md's tables and every
// figure README.md and the landing mark are written from them (scripts/bench-readme.mjs),
// and a figure that differs fails here. A dataset under test that is not committed (the
// publication gate's merge) leaves the docs to the publisher, which rewrites them with it.
test('claims: the docs\' measured figures are the committed datasets\' (scripts/bench-readme.mjs --check)', () => {
  if (process.env.JZ_BENCH_RESULTS) { ok(true, `${resultsPath} is not the committed dataset: the publisher rewrites the docs from it`); return }
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/bench-readme.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' })
  ok(r.status === 0, `docs and datasets disagree:\n${r.stdout}${r.stderr}`)
})

test('claims: the evidence was measured by the pinned builds (meta.invocations)', () => {
  const recorded = res.meta?.invocations ?? {}
  const off = Object.entries(LANE_CMDS).filter(([lane, cmd]) => recorded[lane] !== cmd)
    .map(([lane, cmd]) => `${lane}: recorded ${JSON.stringify(recorded[lane] ?? null)}, built ${JSON.stringify(cmd)}`)
  ok(off.length === 0, `claim lanes the evidence measured otherwise than they build now (${off.length}):\n${off.join('\n')}`)
})

test('claims: contenders are the fastest stored rivals of each class, with jz and Porffor', () => {
  const row = medianUs => ({ medianUs, parity: 'ok' })
  const c = { targets: { jz: row(100), 'c-wasm': row(120), as: row(110), 'rust-wasm': row(300), tinygo: { status: 'fail', reason: 'no build' },
    v8: row(200), deno: row(190), bun: row(150), 'porf-native': row(900) } }
  is(contenders(c, 2).join(','), 'jz,jz-exact,as,c-wasm,deno,v8,bun,porf-native', 'two per class, ranked by the stored median; a failed lane is unranked; the exact lane beside jz')
  is(contenders(c, 1).join(','), 'jz,jz-exact,as,deno,bun,porf-native', 'one per class')
  is(contenders(c, 2, ['jz', 'c-wasm', 'rust-wasm', 'v8']).join(','), 'jz,c-wasm,rust-wasm,v8', 'ranked among the selected lanes')
  is(contenders(c, 1, ['jz', 'jz-w2c', 'nat', 'as', 'tinygo']).join(','), 'jz,as,jz-w2c,nat', 'a selected lane no claim ranks is measured as selected')
  is(contenders({ targets: { ...c.targets, 'c-wasm-fast': row(105) } }, 1, ['jz', 'jz-exact', 'c-wasm', 'c-wasm-fast', 'as']).join(','), 'jz,jz-exact,c-wasm-fast,as',
    'the fast C lane is a wasm rival; the strict class ranks its own nearest')
  is(contenders(undefined, 2).join(','), 'jz,jz-exact,c-wasm,rust-wasm,go-wasm,tinygo,zig-wasm,as,c-wasm-fast,v8,deno,bun,jsc,porf-native',
    'a case without evidence measures every rival: no class can rank it')
  is(contenders({ targets: { jz: row(100), 'jz-w2c': row(90), v8: row(200) } }, 1, ['jz', 'jz-w2c', 'c-wasm', 'as', 'v8', 'deno', 'bun', 'porf-native']).join(','),
    'jz,c-wasm,as,v8,bun,porf-native,jz-w2c', 'a class with no timed row measures its selected lanes; a ranked class keeps its nearest')
})

// A --contenders refresh measures the nearest rivals of each class per case: the
// claim class is contested on a case when any of its lanes has a timed row there,
// over the cases the claims cover (the pending ones have no rival at all) that the
// class has a program for: a wasm producer contests a case only beside its source
// in that producer's language (bench/<case>/<case>.c, .rs, .go, .zig, .as.ts, the
// bench's lanes), which a library's own JavaScript (stdlib, pmndrs/math) has none
// of; an engine or Porffor runs every case's JavaScript.
const WASM_SOURCES = ['.c', '.rs', '.go', '.zig', '.as.ts']
const wasmSource = id => WASM_SOURCES.some(ext => existsSync(join(ROOT, 'bench', id, id + ext)))
// Over only the cases it has a source for, the wasm class must race nearly all of
// them: COVERAGE_FLOOR sizes one lane's portability, not a class over its own field.
const SOURCED_FLOOR = 0.95
// A wasm producer's program for a case, the source its lane compiles.
const RIVAL_SOURCE = { 'c-wasm': '.c', 'c-wasm-fast': '.c', 'rust-wasm': '.rs', 'go-wasm': '.go', tinygo: '.go', 'zig-wasm': '.zig', as: '.as.ts' }
test('claims: every named rival is contested (coverage ≥ floor of the corpus)', () => {
  const covered = Object.entries(cases).filter(([id]) => !PENDING_CASES.has(id))
  for (const [label, rivals] of [...CLAIM_CLASSES, ['porffor', ['porf-native']]]) {
    const field = claimOf(label) === 'wasm' ? covered.filter(([id]) => wasmSource(id)) : covered
    const needCovered = Math.ceil(field.length * (claimOf(label) === 'wasm' ? SOURCED_FLOOR : COVERAGE_FLOOR))
    const rows = field.filter(([, c]) => rivals.some(r => timedBenchmarkRow(c.targets?.[r]))).length
    ok(rows >= needCovered, `claim class '${label}' is contested on ${rows}/${field.length} cases (floor ${needCovered})${res.meta?.contenders ? ` under --contenders=${res.meta.contenders}` : ''}`)
  }
  if (res.meta?.contenders) return
  // Every lane measured: each rival over the cases it has a program for.
  for (const rival of [...CLAIM_RIVALS, ...FAST_RIVALS, ...JIT_RIVALS, 'porf-native']) {
    const ext = RIVAL_SOURCE[rival]
    const field = Object.keys(cases).filter(id => !ext || existsSync(join(ROOT, 'bench', id, id + ext)))
    const need = Math.ceil(field.length * COVERAGE_FLOOR)
    const rows = field.filter(id => timedBenchmarkRow(cases[id].targets?.[rival])).length
    ok(rows >= need, `rival '${rival}' has ${rows}/${field.length} parity-valid rows (floor ${need}) — the claim is uncontested against it`)
  }
})

test('claims: every JZ timing outside PARITY_EXEMPT has correct-result parity', () => {
  const invalid = Object.entries(cases)
    .filter(([id, c]) => !PARITY_EXEMPT.has(id) && !timedBenchmarkRow(c.targets?.jz))
    .map(([id, c]) => `${id}:${c.targets?.jz?.parity || c.targets?.jz?.status || 'missing'}`)
  ok(invalid.length === 0, invalid.length
    ? `JZ rows without correct timing evidence: ${invalid.join(', ')}`
    : 'every JZ timing outside PARITY_EXEMPT has correct-result parity')
})

test('Porffor floor: ties pass, losses surface, and invalid rows do not compare', () => {
  const row = (jz, porf) => ({ targets: { jz, 'porf-native': porf } })
  const floor = porfforFloor({
    tie: row({ parity: 'ok', medianUs: 10, bytes: 20 }, { parity: 'ok', medianUs: 10, bytes: 20 }),
    loss: row({ parity: 'ok', medianUs: 10, bytes: 20 }, { parity: 'ok', medianUs: 5, bytes: 10 }),
    fma: row({ parity: 'ok', medianUs: 10, bytes: 20 }, { parity: 'fma', medianUs: 20, bytes: 40 }),
    wrong: row({ parity: 'ok', medianUs: 10, bytes: 20 }, { parity: 'DIFF', medianUs: 1, bytes: 1 }),
    failed: row({ parity: 'ok', medianUs: 10, bytes: 20 }, { status: 'fail', parity: 'ok', medianUs: 1, bytes: 1 }),
    zero: row({ parity: 'ok', medianUs: 0, bytes: 0 }, { parity: 'ok', medianUs: 1, bytes: 1 }),
  })
  is(floor.speed.map(([name]) => name).join(','), 'tie,loss,fma', 'FMA rows count; wrong, failed, and zero rows do not')
  is(floor.size.map(([name]) => name).join(','), 'tie,loss,fma', 'the same validity boundary governs artifact size')
  is(floor.speedLosses.map(([name]) => name).join(','), 'loss', 'an exact tie passes and a speed loss is named')
  is(floor.sizeLosses.map(([name]) => name).join(','), 'loss', 'an exact tie passes and a size loss is named')
  is(+floor.speedGeomean.toFixed(6), 1, 'runtime geomean includes the tie, loss, and FMA row')
  is(+floor.sizeGeomean.toFixed(6), 1, 'size geomean includes the tie, loss, and FMA row')
  const empty = porfforFloor({})
  is(empty.speedGeomean, null, 'zero comparable speed rows produce null, not NaN')
  is(empty.sizeGeomean, null, 'zero comparable size rows produce null, not NaN')
})

test('claims: JZ does not lose to pinned Porffor native by case or geomean', () => {
  const version = res.meta?.versions?.porffor || ''
  ok(porfforEvidenceMatches(version), `Porffor evidence ${version || 'missing'}; required ${PORFFOR_RELEASE} ${PORFFOR_REV.slice(0, 7)}`)
  // Over the cases the claims cover: a pending case answers to no claim, the floor included.
  const { speed, size, speedLosses, sizeLosses, speedGeomean, sizeGeomean } = porfforFloor(Object.fromEntries(Object.entries(cases).filter(([id]) => !PENDING_CASES.has(id))))
  const need = Math.ceil(Object.keys(cases).filter(id => !PENDING_CASES.has(id)).length * COVERAGE_FLOOR)
  ok(speed.length >= need, `${speed.length} comparable Porffor speed rows (need ${need})`)
  ok(size.length >= need, `${size.length} comparable Porffor size rows (need ${need})`)
  ok(speedLosses.length === 0, speedLosses.length
    ? `Porffor speed wins: ${speedLosses.map(([name, ratio]) => `${name} ${(1 / ratio).toFixed(3)}×`).join(', ')}`
    : `JZ leads all ${speed.length} comparable Porffor speed rows`)
  ok(sizeLosses.length === 0, sizeLosses.length
    ? `Porffor artifact-size wins: ${sizeLosses.map(([name, ratio]) => `${name} ${(1 / ratio).toFixed(3)}×`).join(', ')}`
    : `JZ is smaller on all ${size.length} comparable Porffor rows`)
  ok(speedGeomean >= 1, `porf-native/jz runtime geomean ${speedGeomean?.toFixed(3) ?? 'missing'}×`)
  ok(sizeGeomean >= 1, `porf-native/jz artifact-byte geomean ${sizeGeomean?.toFixed(3) ?? 'missing'}×`)
})

// Per-case jz-vs-best-rival ratios for a rival set: [id, ratio, who]. `ids`
// (optional Set) restricts which cases are considered — used to carve a
// class's named exceptions out of its claim; `source` is the evidence.
// Cases the claims do not yet cover: a library's own code or a workload class added to
// the corpus that jz does not lead on every runner yet (AGENTS.md's "tracked as todo in
// the gate until jz takes the lead — never silently accepted"):
// - stdlib-exp led V8, bun and JSC on every runner sampled (Neoverse-N2, EPYC
//   7763/9V45/9V74, Xeon 8370C/8573C) and every engine on an Apple M4, and trailed deno
//   2.9.8 on x64 (1.20-1.61×). deno 2.9.8 embeds V8 15.0, node 24 V8 13.6, and runs the
//   kernel's JavaScript 1.65-2.2× faster on arm64 (Neoverse-N2, 29.2 ms against 48.2)
//   as on x64: the newer engine's gain, not the ISA's, with no work skipped (each of
//   the 2^20 results is stored to a Float64Array the checksum reads). jz's own gap: its
//   loop ran as V8's baseline code, since V8 replaces code between calls only and the
//   void export's boundary wrapper hid the once-entered function from loopPasses
//   (split-funcs.js); optimized, it runs 0.49× that time on an M4 (5.8 ms against
//   11.7).
// - fabrik runs ~70 µs a round, so its verdict is V8's tier-up race: the rounds
//   of one process read 0.50-1.69× its own base build, and 9 of 22 probe runs saw
//   V8 or deno ahead; the latest CI reference (EPYC 7763) reads jz 146 µs, V8
//   1.339× and deno 1.197× faster. Kept as functions of their own, `forward` and
//   `backward` compile in 1 ms each and still land after the last round. Leading
//   here takes baseline code faster than V8's optimized JavaScript.
// - stringify, jsontransform, mapstr, mapint, mapobj, setops and async, the JSON, Map
//   and Set, and async workloads added on 2026-11-03: jz trailed the V8-family engines
//   on all seven, the Rust and AssemblyScript wasm ports on the four Map and Set cases,
//   and Porffor on async (an Apple M4, loaded: mapstr 1.97× Node, async 2.99× Node and
//   1.51× Porffor after its job-queue rework); their work is in progress.
// - jsonroundtrip, arraynumeric and arraydowngrade, Perry's benchmark suite
//   (PerryTS/perry benchmarks/suite) added on 2026-11-03, paired on an Apple M4 at
//   load 10 to 14: jsonroundtrip leads node (0.66×), deno, bun and every wasm port
//   and trails the jsc shell (1.08×); arraynumeric leads every engine (node 0.64×,
//   jsc 0.88×) and trails C → wasm (1.11×), its increment storing each sum through a
//   NaN-canonicalizing select where clang's loop loads, adds and stores;
//   arraydowngrade trails every engine (node 5.4×, deno 6.5×, bun and jsc 6.1×) and
//   the C, Rust and AssemblyScript wasm ports (1.53×, 3.77×, 2.27×): its `arr[i] + 1`
//   over slots of number, object and string is the dynamic add in a loop that may
//   allocate, so each element also pays the in-loop collector's heap and iterator
//   tests, a forwarding check of the array's header, a bounds and a hole test.
// Excluded from the band test, the Porffor floor and the corpus-coverage
// test until the todo below flips; a case leaves this set the commit it leads.
const PENDING_CASES = new Set(['stdlib-exp', 'polytri', 'fabrik', 'stringify', 'jsontransform', 'mapstr', 'mapint', 'mapobj', 'setops', 'async',
  'jsonroundtrip', 'arraynumeric', 'arraydowngrade'])

// A claimed case answers for jz with a timed, parity-valid row: a failed, wrong or
// missing JZ row leaves no ratio, and the claims then held without it. Only a case
// whose stored checksum no lane reproduces (the libm-divergent probes) carries no
// claim to hold jz to; it is named, not dropped in silence.
const describeRow = row => row == null ? 'missing'
  : row.status != null ? `${row.status}${row.reason ? ` (${String(row.reason).split('\n')[0].slice(0, 100)})` : ''}`
    : !correctBenchmarkRow(row) ? `parity ${row.parity ?? 'unknown'}` : 'no positive timing'
const claimEvidence = (source, pending = PENDING_CASES, lane = 'jz') => {
  const missing = [], uncontested = []
  for (const [id, c] of Object.entries(source)) {
    const jz = c.targets?.[lane]
    if (pending.has(id) || timedBenchmarkRow(jz) || lane !== 'jz' && NO_EXACT.has(id)) continue
    if (jz != null && jz.status == null && !Object.values(c.targets).some(correctBenchmarkRow)) uncontested.push(id)
    else missing.push(`${id}: ${describeRow(jz)}`)
  }
  return { missing, uncontested }
}
// The self-compile case runs no exact lane: a second build of the compiler is most of an
// hour, and no wasm rival contests it (bench/bench.mjs, the jz-exact lane).
const NO_EXACT = new Set(['jz'])

test('claims: a claimed case without a timed JZ row fails by name', () => {
  const timed = { parity: 'ok', medianUs: 1 }, diff = { parity: 'DIFF', medianUs: 1 }
  const { missing, uncontested } = claimEvidence({
    led: { targets: { jz: timed, v8: timed } },
    failed: { targets: { jz: { status: 'fail', reason: 'compiler benchmark build exceeded 3600s' }, v8: timed } },
    absent: { targets: { v8: timed } },
    wrong: { targets: { jz: diff, v8: timed } },
    untimed: { targets: { jz: { parity: 'ok', medianUs: 0 }, v8: timed } },
    probe: { targets: { jz: diff, v8: diff } },
    failedProbe: { targets: { jz: { status: 'fail' }, v8: diff } },
    pending: { targets: { jz: { status: 'fail' }, v8: timed } },
  }, new Set(['pending']))
  is(missing, ['failed: fail (compiler benchmark build exceeded 3600s)', 'absent: missing', 'wrong: parity DIFF', 'untimed: no positive timing', 'failedProbe: fail'],
    'a failed, missing, wrong or untimed JZ row is named; a pending case answers to no claim')
  is(uncontested, ['probe'], 'only a JZ row that ran where no lane reproduces the checksum carries no claim')
})

test('claims: every claimed case carries a timed, parity-valid JZ row', () => {
  const { missing, uncontested } = claimEvidence(cases)
  if (uncontested.length) console.log(`  uncontested (no lane reproduces the stored checksum): ${uncontested.join(', ')}`)
  ok(missing.length === 0, missing.length
    ? `claimed cases without a timed, parity-valid JZ row: ${missing.join('; ')}`
    : 'every claimed case carries a timed, parity-valid JZ row')
})

test('claims: every claimed case carries a timed, parity-valid row of the exact lane (jz-exact)', () => {
  const { missing } = claimEvidence(cases, PENDING_CASES, 'jz-exact')
  ok(missing.length === 0, missing.length
    ? `claimed cases without a timed, parity-valid jz-exact row (${missing.length}): ${missing.slice(0, 12).join('; ')}${missing.length > 12 ? '; …' : ''}`
    : 'every claimed case carries a timed, parity-valid jz-exact row')
})

const caseRatios = (rivals, ids = null, source = cases, base = 'jz') => {
  const out = []
  for (const [id, c] of Object.entries(source)) {
    if (ids ? !ids.has(id) : PENDING_CASES.has(id)) continue
    const jz = c.targets?.[base]
    if (!timedBenchmarkRow(jz)) continue
    let best = null, who = null
    for (const rival of rivals) {
      const t = c.targets?.[rival]
      if (!timedBenchmarkRow(t)) continue
      if (best == null || t.medianUs < best) { best = t.medianUs; who = rival }
    }
    if (best != null) out.push([id, jz.medianUs / best, who])
  }
  return out
}

// One test a class, for every promise this file enforces (fastest-wasm vs
// CLAIM_RIVALS; outruns-the-JIT vs the V8-family / bun-jsc splits below): a case
// past the band is red and fails; a case inside it is a tie, which passes and is
// printed, since a tie is a target and never a lead.
const bandTest = (label, rivals, ids = null, base = 'jz', tol = WASM_BAND_TOL) => test(`claims: no red cases — ${base} leads or ties (within ${tol}×) the best ${label} everywhere`, () => {
  const red = [], band = []
  for (const [id, r, who] of caseRatios(rivals, ids, cases, base)) {
    if (r > tol) red.push(`${id} ${r.toFixed(3)}× (${who})`)
    else if (r >= 1.0) band.push(`${id} ${r.toFixed(3)}× (${who})`)
  }
  if (band.length) console.log(`  ties, to lead: ${band.join(', ')}`)
  ok(red.length === 0, `red cases void the ${label} claim: ${red.join(', ')}`)
})

// Each claim class over the cases it claims: every case but the pending ones, the
// ones it excepts by name (bench/claims.mjs CLAIM_EXCEPTIONS), which answer to
// their bands below, and the ones it does not lead yet (CLAIM_UNMET), a todo.
const NAMES = { wasm: 'wasm rival, strict or -ffast-math (jz at speed, relaxed floats)', 'wasm-exact': 'wasm rival built strict (jz-exact, JavaScript\'s floats)', v8: 'V8-family JIT (v8/node, deno)', jsc: 'bun/jsc JIT' }
const RIVALS = Object.fromEntries(CLAIM_CLASSES)
for (const [label, rivals] of CLAIM_CLASSES) {
  const excepted = exceptionsOf(label), unmet = unmetOf(label)
  const name = NAMES[label] + (excepted.size ? ` (outside its named exceptions: ${[...excepted.keys()].join(', ')})` : '')
    + (unmet.size ? ` (unmet: ${[...unmet].join(', ')})` : '')
  const ids = new Set(Object.keys(cases).filter(id => !PENDING_CASES.has(id) && !excepted.has(id) && !unmet.has(id)))
  bandTest(name, rivals, ids, baseOf(label))
}

// What each class actually contests: the claimed cases where its jz lane and at least one
// rival carry a timed, correct row. A class whose rivals vanish from a case leaves that
// case out of its band test in silence; the count makes it seen and the floor
// (bench/claims.mjs CONTESTED_FLOOR) makes it fail.
const contested = (source = cases, pending = PENDING_CASES) => Object.fromEntries(CLAIM_CLASSES.map(([label, rivals]) => {
  const excepted = exceptionsOf(label), unmet = unmetOf(label)
  const ids = new Set(Object.keys(source).filter(id => !pending.has(id) && !excepted.has(id) && !unmet.has(id)))
  return [label, caseRatios(rivals, ids, source, baseOf(label)).length]
}))
test('claims: the cases each class contests are counted, each class at its floor', () => {
  const n = contested()
  console.log(`  contested: ${CLAIM_CLASSES.map(([label]) => `${label} ${n[label]} (floor ${CONTESTED_FLOOR[label]})`).join(', ')}`)
  for (const [label] of CLAIM_CLASSES) {
    ok(Number.isInteger(CONTESTED_FLOOR[label]), `${label}: a floor`)
    ok(n[label] >= CONTESTED_FLOOR[label], `class '${label}' contests ${n[label]} cases, under its floor of ${CONTESTED_FLOOR[label]}`)
  }
})
test('claims: a contested case needs the class\'s jz lane and a rival, both timed and correct', () => {
  const t = { parity: 'ok', medianUs: 1 }, wrong = { parity: 'DIFF', medianUs: 1 }
  const n = contested({
    both: { targets: { jz: t, 'jz-exact': t, 'c-wasm': t, v8: t, bun: t } },
    noExact: { targets: { jz: t, 'c-wasm': t } },
    fastOnly: { targets: { jz: t, 'jz-exact': t, 'c-wasm-fast': t } },
    wrongRival: { targets: { jz: t, 'jz-exact': t, 'c-wasm': wrong, v8: wrong } },
    pending: { targets: { jz: t, 'jz-exact': t, 'c-wasm': t } },
  }, new Set(['pending']))
  is(n, { wasm: 3, 'wasm-exact': 1, v8: 1, jsc: 1 }, 'the exact class needs jz-exact; the fast C lane contests the relaxed class alone; a wrong row contests nothing; a pending case nothing')
})
test.todo('claims: the unmet cases lead their class (CLAIM_UNMET)', () => {
  const notLed = CLAIM_UNMET.flatMap(e => {
    const [row] = caseRatios(RIVALS[e.class], new Set([e.case]))
    return row && row[1] < 1 ? [] : [`${e.case} vs ${e.class} ${row ? `${row[1].toFixed(3)}× (${row[2]})` : 'unmeasured'}`]
  })
  ok(notLed.length === 0, `not led: ${notLed.join(', ')}`)
})
test('claims: the unmet table is well formed', () => {
  const seen = new Set()
  for (const e of CLAIM_UNMET) {
    const key = `${e.case}/${e.class}`
    ok(cases[e.case] != null || existsSync(join(ROOT, 'bench', e.case, `${e.case}.js`)), `${key}: a case of the corpus`)
    ok(!PENDING_CASES.has(e.case), `${key}: a pending case answers to no claim`)
    ok(RIVALS[e.class] != null, `${key}: a claim class (${Object.keys(RIVALS).join(', ')})`)
    ok(!exceptionsOf(e.class).has(e.case), `${key}: unmet or excepted, not both`)
    for (const field of ['cause', 'evidence'])
      ok(typeof e[field] === 'string' && e[field].trim().length > 0 && !e[field].includes('\n'), `${key}: a one-line ${field}`)
    ok(!seen.has(key), `${key}: named once`)
    seen.add(key)
  }
})
// A pending case that leads every class it is contested in is promoted, or the gate
// fails: the hedge goes the commit jz leads (AGENTS.md "removed the commit jz leads"). A
// class counts where any rival has a timed, correct row; there the class's jz lane must
// have one too and lead strictly, or the case does not lead it. A case no class contests
// leads nothing.
const leadsEveryClass = (c) => {
  let any = false
  for (const [label, rivals] of CLAIM_CLASSES) {
    if (!rivals.some(r => timedBenchmarkRow(c.targets?.[r]))) continue
    any = true
    const [row] = caseRatios(rivals, new Set(['x']), { x: c }, baseOf(label))
    if (!row || row[1] >= 1) return false
  }
  return any
}
const promotable = (source = cases, pending = PENDING_CASES) => [...pending].filter(id => source[id] && leadsEveryClass(source[id]))
test('claims: a pending case that leads every class is promoted', () => {
  const ready = promotable()
  console.log(`  pending: ${[...PENDING_CASES].map(id => `${id}${!cases[id] ? ' (unmeasured)' : ready.includes(id) ? ' (leads every class)' : ''}`).join(', ')}`)
  ok(ready.length === 0, `pending cases that lead every class they are contested in, to promote out of PENDING_CASES: ${ready.join(', ')}`)
})
test('claims: promotion asks for a strict lead in every contested class, the exact lane included', () => {
  const r = (medianUs) => ({ parity: 'ok', medianUs })
  const ready = promotable({
    leads: { targets: { jz: r(90), 'jz-exact': r(95), 'c-wasm': r(100), v8: r(200), bun: r(150) } },
    tie: { targets: { jz: r(100), 'jz-exact': r(95), 'c-wasm': r(100), v8: r(200), bun: r(150) } },
    exactTrails: { targets: { jz: r(90), 'jz-exact': r(110), 'c-wasm': r(100), v8: r(200), bun: r(150) } },
    noExact: { targets: { jz: r(90), 'c-wasm': r(100), v8: r(200), bun: r(150) } },
    jsOnly: { targets: { jz: r(90), v8: r(200), deno: r(180), bun: r(150) } },
    alone: { targets: { jz: r(90) } },
  }, new Set(['leads', 'tie', 'exactTrails', 'noExact', 'jsOnly', 'alone', 'unmeasured']))
  is(ready, ['leads', 'jsOnly'], 'a tie, a trailing or missing exact lane, no rival or no row keep a case pending')
})

// NAMED EXCEPTIONS — each excepted case against its class's fastest rival:
// within its band it holds (a lead says the entry may go), past it the gate fails.
// A case the evidence does not time is reported, not passed as held.
// (a class that is the entry's claim measured another way, wasm-exact for wasm, answers to it with its own lane)
const exceptionVerdicts = (source = cases, table = CLAIM_EXCEPTIONS.filter(e => RIVALS[e.class])) => table.flatMap(e =>
  CLAIM_CLASSES.filter(([label]) => claimOf(label) === e.class).map(([label, rivals]) => {
    const [row] = caseRatios(rivals, new Set([e.case]), source, baseOf(label))
    return { ...e, class: label, ratio: row?.[1] ?? null, who: row?.[2] ?? null }
  }))
const verdictText = v => `${v.case} vs ${v.class} ${v.ratio == null ? 'unmeasured' : `${v.ratio.toFixed(3)}× (${v.who})`}, band ${v.band}×`

test('claims: the named-exception table is well formed', () => {
  const corpus = new Set(readdirSync(join(ROOT, 'bench'), { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(ROOT, 'bench', d.name, `${d.name}.js`))).map(d => d.name))
  const seen = new Set()
  for (const e of CLAIM_EXCEPTIONS) {
    const key = `${e.case}/${e.class}`
    ok(corpus.has(e.case), `${key}: a case of the corpus`)
    // the size bar holds every case with an AssemblyScript port, pending or not
    const size = e.class === 'size'
    ok(size || !PENDING_CASES.has(e.case), `${key}: a pending case answers to no claim, so to no exception`)
    ok(RIVALS[e.class] != null || e.class === 'rss' && MEMORY_CASES.includes(e.case) || size && existsSync(join(ROOT, 'bench', e.case, `${e.case}.as.ts`)),
      `${key}: a claim class (${Object.keys(RIVALS).join(', ')}), rss for a memory case (${MEMORY_CASES.join(', ')}), or size for a case with an AssemblyScript port`)
    ok(e.open == null || e.open === true, `${key}: open is true or absent`)
    ok(!size || e.open === true, `${key}: a size exception is the owner's, open`)
    // a size band measures bytes a port leaves out, not a timing's spread
    const max = size ? 6 : 2
    ok(typeof e.band === 'number' && e.band > 1 && e.band <= max, `${key}: a band above 1 (a tie needs no exception) and at most ${max}`)
    for (const field of ['cause', 'evidence'])
      ok(typeof e[field] === 'string' && e[field].trim().length > 0 && !e[field].includes('\n'), `${key}: a one-line ${field}`)
    ok(!seen.has(key), `${key}: named once`)
    seen.add(key)
  }
})

test('claims: an excepted case holds to its band and fails past it', () => {
  const row = (jz, rival) => ({ targets: { jz: { parity: 'ok', medianUs: jz }, 'c-wasm': { parity: 'ok', medianUs: rival }, jsc: { parity: 'DIFF', medianUs: 1 } } })
  const table = [{ case: 'held', class: 'wasm', band: 1.1 }, { case: 'broken', class: 'wasm', band: 1.1 },
    { case: 'led', class: 'wasm', band: 1.1 }, { case: 'wrong', class: 'jsc', band: 1.5 }]
  const verdicts = exceptionVerdicts({ held: row(109, 100), broken: row(111, 100), led: row(90, 100), wrong: row(100, 100) }, table)
  is(verdicts.map(v => `${v.class}:${v.ratio == null ? null : +v.ratio.toFixed(2)}`).join(), 'wasm:1.09,wasm-exact:null,wasm:1.11,wasm-exact:null,wasm:0.9,wasm-exact:null,jsc:null',
    'ratios against the class\'s fastest timed rival, the exact class on its own lane (here unmeasured); a wrong rival row times nothing')
  is(verdicts.filter(v => v.ratio != null && v.ratio > v.band).map(v => v.case).join(), 'broken', 'only the case past its band breaks')
})

test('claims: named exceptions — each excepted case stays within its band', () => {
  const verdicts = exceptionVerdicts()
  const broken = verdicts.filter(v => v.ratio != null && v.ratio > v.band)
  const held = verdicts.filter(v => v.ratio != null && v.ratio <= v.band)
  const unmeasured = verdicts.filter(v => v.ratio == null)
  if (held.length) console.log(`  held: ${held.map(verdictText).join('; ')}`)
  if (unmeasured.length) console.log(`  unmeasured: ${unmeasured.map(verdictText).join('; ')}`)
  ok(broken.length === 0, `named exception past its band, a regression the exception does not cover: ${broken.map(v => `${verdictText(v)} — ${v.cause}`).join('; ')}`)
})

// SIZE — the owner's bar (2026-08-28 tightened; supersedes the
// par-or-geomean-only scoping this block used to carry): jz wasm must be
// strictly smaller than AssemblyScript's on EVERY comparable case, ×1, not just
// by geomean. Both checks read only committed evidence (bench/results.json),
// consistent with this file's own architecture (test/bench.js is the
// live-measurement counterpart).
test('claims: size — jz strictly smaller than AssemblyScript on every comparable case', () => {
  const notLed = [], held = [], excepted = exceptionsOf('size')
  for (const [id, c] of Object.entries(cases)) {
    const jz = c.targets?.jz, as = c.targets?.as
    if (!correctBenchmarkRow(jz) || !correctBenchmarkRow(as) || !(jz.bytes > 0) || !(as.bytes > 0)) continue
    const ratio = jz.bytes / as.bytes, e = excepted.get(id)
    if (e && ratio <= e.band) held.push(`${id} ${ratio.toFixed(3)}× (band ${e.band}×)`)
    else if (jz.bytes >= as.bytes) notLed.push(`${id} ${ratio.toFixed(3)}× (${jz.bytes}B / ${as.bytes}B)`)
  }
  if (held.length) console.log(`  held: ${held.join(', ')}`)
  ok(notLed.length === 0, `strict size leadership unproven on ${notLed.length} case(s): ${notLed.join(', ')}`)
})

test(`claims: size — jz geomean bytes vs AssemblyScript stays within the ${SIZE_GEOMEAN_MAX}× par band`, () => {
  const ratios = []
  for (const c of Object.values(cases)) {
    const jz = c.targets?.jz, as = c.targets?.as
    if (!correctBenchmarkRow(jz) || !correctBenchmarkRow(as) || !(jz.bytes > 0) || !(as.bytes > 0)) continue
    ratios.push(jz.bytes / as.bytes)
  }
  ok(ratios.length > 0, 'no jz/as size-comparable cases found')
  const smaller = ratios.filter(r => r < 1).length
  const geomean = Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length)
  console.log(`  size geomean jz/as: ${geomean.toFixed(3)}× (${smaller}/${ratios.length} cases smaller)`)
  ok(geomean <= SIZE_GEOMEAN_MAX, `size geomean jz/as ${geomean.toFixed(3)}× exceeds the ${SIZE_GEOMEAN_MAX}× par band`)
})

// ── The held-out lane (bench/heldout/manifest.json, bench/heldout/lane.mjs): programs jz was
// never tuned on, measured once on first contact by .github/workflows/heldout.yml, the only
// writer of the record (bench/heldout.json). With no record the lane is unmeasured. Its
// fixture (bench/heldout/fixture: programs in the sets' shapes, written for these tests)
// stands in for the sets, which are never read here.
const HELDOUT = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8'))
const FIXTURE = 'bench/heldout/fixture/manifest.json'
const FIXTURE_MANIFEST = JSON.parse(readFileSync(join(ROOT, FIXTURE), 'utf8'))
const programCount = m => m.sets.reduce((n, s) => n + s.programs.length, 0)

test('heldout: the record holds, or the lane is unmeasured', () => {
  const path = join(ROOT, RECORD)
  if (!existsSync(path)) { ok(true, `the held-out lane is unmeasured: no ${RECORD} yet`); return }
  const { entries } = JSON.parse(readFileSync(path, 'utf8'))
  const problems = [...chainProblems(entries), ...contactProblems(entries), ...entryProblems(entries, HELDOUT), ...registrationProblems(entries)]
  ok(problems.length === 0, `${RECORD} does not hold (${problems.length}):\n${problems.slice(0, 12).join('\n')}`)
  console.log(`  held-out: ${entries.length} entries, ${entries.filter(e => e.contact === 'first').length} first contacts of ${programCount(HELDOUT)} programs`)
})

test('heldout: the manifest pins every program of each set, how it is run and how it is checked', () => {
  const ids = new Set()
  for (const set of HELDOUT.sets) {
    ok(/^[\w.-]+\/[\w.-]+$/.test(set.repo) && /^[0-9a-f]{40}$/.test(set.commit), `${set.id}: an upstream repository at a full commit`)
    ok(set.licence?.path && /^[0-9a-f]{40}$/.test(set.licence.blob) && set.licence.states, `${set.id}: its licence as its own file states it`)
    ok(set.programs.length > 0, `${set.id}: its programs`)
    for (const p of set.programs) {
      ok(!ids.has(p.id) && p.id.startsWith(`${set.id}-`), `${p.id}: one id, its set's`)
      ids.add(p.id)
      ok(/^[0-9a-f]{40}$/.test(p.blob) && p.path, `${p.id}: pinned by its blob id`)
      ok(set.interface === 'awfy' ? Number.isInteger(p.inner)
        : set.interface === 'clbg' ? p.arg != null && set.checks.some(c => c.path === p.check?.path) : false, `${p.id}: how it is run and checked`)
      if ('notMeasured' in p) ok(typeof p.notMeasured === 'string' && p.notMeasured.trim().length > 0, `${p.id}: marked not measured, and why`)
    }
  }
  const about = HELDOUT.about.join(' ')
  ok(about.includes('needs new programs registered for it'), 'the header says a release that quotes the lane needs new programs')
  ok(about.includes('What no test can hold, the owner keeps'), 'and names the rule no test can hold')
  ok(about.includes('notMeasured'), 'and what a program marked not measured is')
})

const heldoutCli = (...args) => spawnSync(process.execPath, [join(ROOT, 'scripts/heldout.mjs'), ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 300_000, env: { ...process.env, GITHUB_STEP_SUMMARY: '' } })

test('heldout: drivers made from each set\'s interface pass V8\'s check, and a file not as pinned is refused (the fixture)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-heldout-'))
  try {
    const M = `--manifest=${FIXTURE}`, R = `--record=${join(dir, 'record.json')}`
    const made = (src, cases) => {
      for (const r of [heldoutCli('fetch', join(dir, src), M, R), heldoutCli('generate', join(dir, src), join(dir, cases), M)]) is(r.status, 0, r.stderr)
      return JSON.parse(readFileSync(join(dir, cases, 'index.json'), 'utf8'))
    }
    const index = made('src', 'cases')
    is(index.programs.filter(p => p.driver).length, programCount(FIXTURE_MANIFEST), 'a driver for every program')
    const check = heldoutCli('check', join(dir, 'cases'), join(dir, 'src'), M)
    is(check.status, 0, `V8 runs every driver and passes each set's check, but the programs marked not measured:\n${check.stdout}${check.stderr}`)
    // the two marked so (sloppy, forks): V8 runs each as a script, not through the harness
    const line = id => check.stdout.split('\n').find(l => l.includes(` ${id}: `)) ?? ''
    ok(line('fx-clbg-sloppy').startsWith('out  ') && line('fx-clbg-sloppy').includes('V8 did not run it: ReferenceError: n is not defined'),
      `a sloppy script, its driver an ES module, throws, and the line says what V8 threw: ${line('fx-clbg-sloppy')}`)
    ok(line('fx-clbg-forks').startsWith('out  ') && line('fx-clbg-forks').includes('V8 did not run its check: TypeError'),
      `a program that forks a worker of the running script does not run in the check: ${line('fx-clbg-forks')}`)
    ok(check.stdout.includes('6 of 8 programs pass their check in V8; 2 not measured (marked notMeasured, and failing in V8)'), 'and the totals count them')
    // bench.mjs, which a contact runs over the drivers, takes none of a program marked not measured
    const cases = spawnSync(process.execPath, [join(ROOT, 'bench/bench.mjs'), '--list'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, JZ_BENCH_CASES_DIR: join(dir, 'cases') } })
    const measured = FIXTURE_MANIFEST.sets.flatMap(s => s.programs).filter(p => !p.notMeasured).map(p => p.id)
    is(cases.stdout.trim().split('\n').sort().join(), measured.sort().join(), `bench.mjs takes every other program and neither marked one:\n${cases.stdout}${cases.stderr}`)
    // a mark taken out fails the dry check, and so does one on a program that passes
    const marks = JSON.parse(readFileSync(join(ROOT, FIXTURE), 'utf8'))
    const clbg = marks.sets.find(s => s.id === 'fx-clbg').programs
    delete clbg.find(p => p.id === 'fx-clbg-sloppy').notMeasured
    clbg.find(p => p.id === 'fx-clbg-harmonic').notMeasured = 'marked by this test'
    writeFileSync(join(dir, 'marks.json'), JSON.stringify(marks))
    const Mk = `--manifest=${join(dir, 'marks.json')}`
    is(heldoutCli('generate', join(dir, 'src'), join(dir, 'cases-marks'), Mk, '--sets=fx-clbg').status, 0, 'the drivers of the marks moved')
    const moved = heldoutCli('check', join(dir, 'cases-marks'), join(dir, 'src'), Mk, '--sets=fx-clbg')
    is(moved.status, 1, `a dry check with a mark taken out or misplaced fails:\n${moved.stdout}`)
    ok(moved.stdout.includes('FAIL fx-clbg-sloppy: V8 did not run it'), 'a program V8 does not run through the harness, unmarked, fails it')
    ok(moved.stdout.includes('FAIL fx-clbg-harmonic: passes in V8') && moved.stdout.includes('the mark no longer holds'), 'and a marked program that passes fails it: a mark ends with its reason')
    is(made('src2', 'cases2').programs.map(p => p.driver).join(), index.programs.map(p => p.driver).join(), 'the same pinned files make the same drivers wherever they are made')
    const driver = readFileSync(join(dir, 'cases/fx-clbg-bitmap/fx-clbg-bitmap.js'), 'utf8')
    ok(/\nimport \{[^}]+\} from '\.\.\/_lib\/benchlib\.js'\n/.test(driver) && /\nexport \{ run as main \}\n$/.test(driver), 'a driver is a case as bench.mjs takes one')
    const m = JSON.parse(readFileSync(join(ROOT, FIXTURE), 'utf8'))
    m.sets[0].programs[0].blob = '0'.repeat(40)
    writeFileSync(join(dir, 'other.json'), JSON.stringify(m))
    const other = heldoutCli('fetch', join(dir, 'src3'), `--manifest=${join(dir, 'other.json')}`, R)
    ok(other.status !== 0 && other.stderr.includes('the manifest pins'), 'a file other than its pinned blob is refused')
    writeFileSync(join(dir, 'record.json'), JSON.stringify({ entries: [{ source: { repo: `local:${m.sets[0].local}`, path: m.sets[0].programs[0].path, sha256: 'f'.repeat(64) }, files: {} }] }))
    const changed = heldoutCli('fetch', join(dir, 'src4'), M, R)
    ok(changed.status !== 0 && changed.stderr.includes('the record first stored'), 'a file other than the sha256 the record first stored is refused')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// The fixture's run, its rows as bench.mjs wrote them on an Apple M4 Max (jz, jz-exact and
// V8 measured, paired; porf-native and jsc stand-in failures of their own kinds): the
// AWFY-shaped programs do not compile under jz (esbuild's CommonJS wrapper, `summary: no
// fixpoint`), nor does cores (Node's own modules), roots is wrong under jz, harmonic and
// bitmap run. sloppy and forks are marked not measured: no lane runs them.
const FIXTURE_RUN = (() => {
  const fail = (reason, stage) => ({ status: 'fail', reason, ...(stage && { stage }) })
  const noFixpoint = fail('summary: no fixpoint\n    at solve (src/summary/solve.js)', 'build')
  const noModule = fail('Unknown module \'node:module\': not a built-in and not registered', 'build')
  return {
    'fx-clbg-cores': { jz: noModule, 'jz-exact': noModule, v8: { medianUs: 90, parity: 'ok' } },
    'fx-awfy-squares': { jz: noFixpoint, 'jz-exact': noFixpoint, v8: { medianUs: 36, parity: 'ok' } },
    'fx-awfy-evaluated': { jz: noFixpoint, 'jz-exact': noFixpoint, v8: { medianUs: 2, parity: 'ok' } },
    'fx-clbg-harmonic': { jz: { medianUs: 350, parity: 'ok' }, 'jz-exact': { medianUs: 353, parity: 'ok' }, v8: { medianUs: 368, parity: 'ok' }, 'porf-native': fail('timeout after 300s', 'timeout') },
    'fx-clbg-bitmap': { jz: { medianUs: 332, parity: 'ok' }, 'jz-exact': { medianUs: 350, parity: 'ok' }, v8: { medianUs: 212, parity: 'ok' }, jsc: fail('exit 3: Exception: TypeError: undefined is not a function') },
    'fx-clbg-roots': { jz: { medianUs: 11, parity: 'DIFF' }, 'jz-exact': { medianUs: 11, parity: 'DIFF' }, v8: { medianUs: 23, parity: 'ok' } },
  }
})()
const fixtureEntries = () => FIXTURE_MANIFEST.sets.flatMap(set => set.programs.filter(p => !p.notMeasured).map(p => ({
  program: p.id, set: set.id,
  source: { repo: `local:${set.local}`, commit: null, path: p.path, blob: p.blob, sha256: 'e'.repeat(64) },
  files: {}, driver: 'd'.repeat(64), compiler: 'c'.repeat(40), registered: 'c'.repeat(40), contact: 'first',
  run: { id: 'fixture', url: null, date: '2026-11-15 05:00 UTC', machine: { platform: 'darwin', arch: 'arm64', cpu: 'Apple M4 Max' }, versions: { node: 'v24.11.1' } },
  oracle: { checksum: 1, check: 'ok' },
  rows: Object.fromEntries(LANES.map(lane => [lane, rowOf(FIXTURE_RUN[p.id][lane], true)])),
})))

test('heldout: every lane\'s failure is a row of its kind (the fixture\'s run)', () => {
  const rows = Object.fromEntries(fixtureEntries().map(e => [e.program, e.rows]))
  is(rows['fx-awfy-evaluated'].jz.result, 'compile', 'a build that fails: does not compile')
  is(rows['fx-awfy-evaluated'].jz.message, 'summary: no fixpoint', 'with the message\'s first line')
  is(rows['fx-clbg-roots'].jz.result, 'wrong', 'a result the oracle does not give: wrong')
  is(rows['fx-clbg-harmonic']['porf-native'].result, 'timeout', 'a run past the limit: timeout')
  is(rows['fx-clbg-bitmap'].jsc.result, 'trap', 'a run that fails: traps')
  is(rows['fx-clbg-bitmap'].deno.result, 'absent', 'a lane that did not run: a row that says so')
  is(rows['fx-clbg-cores'].jz.message, 'Unknown module \'node:module\': not a built-in and not registered', 'a program that needs Node\'s modules does not compile under jz')
  is(rows['fx-clbg-harmonic'].jz.result, 'ok')
  is(rowOf({ medianUs: 5, parity: 'ok' }, false).result, 'unverified', 'a result is not known right where V8 fails the set\'s own check')
  is(rowOf({ medianUs: 5, parity: 'unclassified' }, true).result, 'unverified', 'nor where V8 gave no oracle')
})

test('heldout: the record\'s chain, contacts and entries hold, and each way of breaking them fails (the fixture)', () => {
  const good = appendEntries([], fixtureEntries()), e = fixtureEntries()
  is([...chainProblems(good), ...contactProblems(good), ...entryProblems(good, FIXTURE_MANIFEST)].join('\n'), '', 'the fixture\'s record holds')
  const edited = good.map((x, i) => i === 2 ? { ...x, rows: { ...x.rows, jz: { result: 'ok', medianUs: 1 } } } : x)
  ok(chainProblems(edited).some(p => p.startsWith('entry 3')), 'an entry edited after it was stored breaks the chain')
  ok(chainProblems(good.slice(1)).length > 0, 'and so does one removed')
  ok(contactProblems(appendEntries(good, [e[4]])).some(p => p.includes('a second first contact of fx-clbg-roots')), 'a program measured again is no second first contact')
  is(contactProblems(appendEntries(good, [{ ...e[4], contact: 'tuned' }])).length, 0, 'it is stored beside the first, marked tuned')
  ok(contactProblems(appendEntries([], [{ ...e[0], contact: 'tuned' }])).length > 0, 'and tuned with no first contact before it fails')
  ok(entryProblems(appendEntries([], [{ ...e[2], rows: { jz: { result: 'ok' } } }]), FIXTURE_MANIFEST).some(p => p.includes('deno has no row')), 'every lane has a row')
  ok(entryProblems(appendEntries([], [{ ...e[1], rows: { ...e[1].rows, jz: { result: 'compile' } } }]), FIXTURE_MANIFEST).some(p => p.includes('says nothing of why')), 'a failure says why')
  ok(entryProblems(appendEntries([], [{ ...e[0], source: { ...e[0].source, blob: '0'.repeat(40) } }]), FIXTURE_MANIFEST).some(p => p.includes('the manifest pins')), 'an entry measured the program the manifest pins')
})

test('heldout: the record job appends each run to main\'s record, chained, and leaves the checkout alone (a bare origin)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-heldout-publish-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', GITHUB_STEP_SUMMARY: '' }
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    const origin = join(dir, 'origin.git'), work = join(dir, 'work')
    git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin)
    git(dir, 'clone', '--quiet', origin, work)
    const add = (files, message) => {
      for (const f of files) { mkdirSync(dirname(join(work, f)), { recursive: true }); if (f !== 'package.json') copyFileSync(join(ROOT, f), join(work, f)) }
      git(work, 'add', '--', ...files)
      git(work, 'commit', '--quiet', '-m', message)
      return git(work, 'rev-parse', 'HEAD')
    }
    writeFileSync(join(work, 'package.json'), '{"type":"module"}')
    add(['package.json', 'scripts/heldout.mjs', 'bench/heldout/lane.mjs', 'bench/claims.mjs', 'assets/headline.js', 'bench/_lib/benchlib.js'], 'the scripts')
    const registered = add([FIXTURE], 'register the fixture')
    git(work, 'push', '--quiet', 'origin', 'main')
    // one run's evidence, as the measuring job uploads it
    const cases = join(dir, 'run/cases'), bench = join(dir, 'run/bench.json')
    mkdirSync(cases, { recursive: true })
    // (a program marked not measured has a driver for the check and no case: bench.mjs has no row of it)
    const programs = FIXTURE_MANIFEST.sets.flatMap(set => set.programs.map(p => ({ id: p.id, set: set.id, interface: set.interface, path: p.path, blob: p.blob,
      sha256: 'e'.repeat(64), ...(p.notMeasured && { notMeasured: p.notMeasured }), source: { repo: `local:${set.local}`, commit: null }, files: {}, driver: 'd'.repeat(64) })))
    const measured = programs.filter(p => !p.notMeasured)
    writeFileSync(join(cases, 'index.json'), JSON.stringify({ manifest: FIXTURE, esbuild: '0.28.2', programs }))
    writeFileSync(join(cases, 'check.json'), JSON.stringify(Object.fromEntries(programs.map(p => [p.id, p.notMeasured ? `not measured: ${p.notMeasured}` : 'ok']))))
    const benchOf = ps => JSON.stringify({ meta: { commit: registered.slice(0, 9), date: '2026-11-15 05:00 UTC', host: { platform: 'linux', arch: 'x64', cpu: 'fixture' }, versions: { node: 'v24.11.1', jz: '1.0.3' } },
      cases: Object.fromEntries(ps.map(p => [p.id, { ref: 1, targets: FIXTURE_RUN[p.id] ?? {} }])) })
    writeFileSync(bench, benchOf(measured))
    const publish = () => spawnSync(process.execPath, [join(work, 'scripts/heldout.mjs'), 'record', cases, bench, `--manifest=${FIXTURE}`, '--publish'], { cwd: work, encoding: 'utf8', env })
    const onMain = () => JSON.parse(execFileSync('git', ['--git-dir', origin, 'show', 'main:bench/heldout.json'], { encoding: 'utf8' })).entries
    const r = publish()
    is(r.status, 0, r.stdout + r.stderr)
    const first = onMain()
    is(first.map(e => e.program).join(), measured.map(p => p.id).join(), 'an entry a program measured, none of a program marked not measured')
    ok(r.stdout.includes('fx-clbg-sloppy: registered, not measured: a script of sloppy mode') && r.stdout.includes('fx-clbg-forks: registered, not measured: it forks'), `which the run names, with why:\n${r.stdout}`)
    ok(first.every(e => e.contact === 'first' && e.registered === registered && e.compiler === registered), 'each a first contact of the compiler it was registered under')
    is(chainProblems(first).join('\n'), '', 'chained')
    ok(!existsSync(join(work, 'bench/heldout.json')) && git(work, 'rev-parse', 'HEAD') === registered, 'the checkout stays as it was')
    const again = publish()
    is(again.status, 0, again.stdout + again.stderr)
    const both = onMain()
    ok(both.length === 2 * first.length && both.slice(first.length).every(e => e.contact === 'tuned'), 'a program run again is stored beside its first contact, as tuned')
    is([...chainProblems(both), ...contactProblems(both)].join('\n'), '', 'and the record holds')
    // a run with a row of a program marked not measured is recorded not at all
    const leaked = join(dir, 'run/leaked.json'), local = join(dir, 'local.json')
    writeFileSync(leaked, benchOf(programs))
    const refused = spawnSync(process.execPath, [join(work, 'scripts/heldout.mjs'), 'record', cases, leaked, `--manifest=${FIXTURE}`, `--record=${local}`], { cwd: work, encoding: 'utf8', env })
    ok(refused.status !== 0 && refused.stderr.includes('measured it, where the manifest marks it notMeasured') && !existsSync(local), `a bench row of a program marked not measured stops the record:\n${refused.stderr}`)
    // a contact refuses a program registered before a compiler change, but none marked not measured
    add(['src/ast.js'], 'a compiler change')
    const stale = spawnSync(process.execPath, [join(work, 'scripts/heldout.mjs'), 'registered', cases, `--manifest=${FIXTURE}`], { cwd: work, encoding: 'utf8', env })
    is(stale.status, 1, stale.stdout + stale.stderr)
    ok(measured.every(p => stale.stdout.includes(`refused: ${p.id}:`)) && !/refused: fx-clbg-(sloppy|forks)/.test(stale.stdout), `every program measured is refused, no program marked not measured:\n${stale.stdout}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('heldout: a first contact measures the compiler its program was registered under (git)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-heldout-git-'))
  const git = (...a) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  const commit = (files, message) => {
    for (const [f, s] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), s) }
    git('add', '--', ...Object.keys(files))
    git('commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  try {
    git('init', '-q')
    const manifest = date => `{"sets":[{"programs":[\n{"id":"fx-p","registered":"${date}"}\n]}]}\n`
    const c0 = commit({ 'src/a.js': '1\n' }, 'the compiler')
    const c1 = commit({ [MANIFEST]: manifest('d1') }, 'register fx-p')
    const c2 = commit({ 'README.md': 'docs\n' }, 'docs')
    const c3 = commit({ 'src/a.js': '2\n' }, 'a compiler change')
    const c4 = commit({ [MANIFEST]: manifest('d2') }, 'register fx-p again')
    const c5 = commit({ [MANIFEST]: manifest('d3'), 'src/a.js': '3\n' }, 'register fx-p beside a compiler change')
    const at = c => registrationProblem('fx-p', c, { cwd: dir })
    ok(at(c0).problem?.includes('does not register it'), 'a contact before its registration is refused')
    is(at(c1).problem, null, 'one at its registration is not')
    is(at(c2).registered, c1, 'its registration is the last commit that changed its line')
    is(at(c2).problem, null, 'and one after it, with no compiler change, is not')
    ok(at(c3).problem?.includes('compiler source changed'), 'one after a compiler change is refused')
    is(at(c4).registered, c4, 'a registration again moves it')
    is(at(c4).problem, null, 'and the contact after it stands')
    ok(at(c5).problem?.includes('changes compiler source'), 'a registration that changes the compiler is refused')
    const first = (compiler, registered) => ({ program: 'fx-p', contact: 'first', compiler, registered })
    is(registrationProblems([first(c2, c1)], { cwd: dir }).length, 0, 'the gate holds a first contact of its registration\'s compiler')
    is(registrationProblems([first(c3, c1)], { cwd: dir }).length, 1, 'and fails one of a compiler changed since')
    is(registrationProblems([first(c2, c0)], { cwd: dir }).length, 1, 'and one that records another registration than git gives')
    is(registrationProblems([{ ...first(c3, c1), contact: 'tuned' }], { cwd: dir }).length, 0, 'a tuned measurement claims no first contact')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('heldout: the lane\'s figures count every program of a set, failures in the denominator (the fixture)', () => {
  const entries = appendEntries([], fixtureEntries())
  const fig = heldoutFigures({ entries }, FIXTURE_MANIFEST)
  is(fig['heldout-fx-awfy-runs'], '0 of 2', 'neither AWFY-shaped program compiles under jz')
  is(fig['heldout-fx-clbg-runs'], '2 of 6 (2 not measured)', 'roots is wrong under jz and cores does not compile: counted, not left out; sloppy and forks, marked not measured, counted and named')
  is(fig['heldout-runs'], '2 of 8 (2 not measured)', 'every set together')
  ok(/^\d+\.\d\d× over 2 of 6$/.test(fig['heldout-fx-clbg-v8']), `V8's time over jz's, over the programs both run right, of every program: ${fig['heldout-fx-clbg-v8']}`)
  is(heldoutFigures({ entries: entries.slice(1) }, FIXTURE_MANIFEST)['heldout-runs'], 'unmeasured (5 of 8 run, 2 not measured)', 'a set not run whole is unmeasured')
  is(heldoutFigures({ entries: [] }, FIXTURE_MANIFEST)['heldout-runs'], 'unmeasured', 'and with no record, the lane')
  const tuned = appendEntries(entries, [{ ...fixtureEntries()[0], contact: 'tuned', rows: fixtureEntries()[2].rows }])
  is(heldoutFigures({ entries: tuned }, FIXTURE_MANIFEST)['heldout-runs'], '2 of 8 (2 not measured)', 'a tuned measurement moves no figure')
  const contacted = appendEntries(entries, [{ ...fixtureEntries()[2], program: 'fx-clbg-sloppy' }])
  is(heldoutFigures({ entries: contacted }, FIXTURE_MANIFEST)['heldout-fx-clbg-runs'], '3 of 6 (1 not measured)', 'a first contact counts, marked or not: a mark holds out only a program never measured')
  // a doc's figure for the lane is the record's (scripts/bench-readme.mjs --check)
  const dir = mkdtempSync(join(tmpdir(), 'jz-heldout-fig-'))
  try {
    const record = join(dir, 'heldout.json'), doc = join(dir, 'README.md')
    writeFileSync(record, JSON.stringify({ entries }))
    const docs = text => {
      writeFileSync(doc, text)
      return spawnSync(process.execPath, [join(ROOT, 'scripts/bench-readme.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8',
        env: { ...process.env, JZ_BENCH_README: doc, JZ_FIG_DOCS: '', JZ_HELDOUT_RECORD: record, JZ_HELDOUT_MANIFEST: join(ROOT, FIXTURE) } })
    }
    const right = docs('jz runs <!-- fig:heldout-fx-clbg-runs -->2 of 6 (2 not measured)<!-- /fig --> of them.\n')
    is(right.status, 0, `the record's figure stands:\n${right.stdout}${right.stderr}`)
    const dropped = docs('jz runs <!-- fig:heldout-fx-clbg-runs -->2 of 5 (2 not measured)<!-- /fig --> of them.\n')
    ok(dropped.status === 1 && dropped.stderr.includes('heldout-fx-clbg-runs reads 2 of 5'), 'a figure that leaves a failure out of its denominator fails')
    const unmarked = docs('jz runs <!-- fig:heldout-fx-clbg-runs -->2 of 4<!-- /fig --> of them.\n')
    ok(unmarked.status === 1 && unmarked.stderr.includes('heldout-fx-clbg-runs reads 2 of 4'), 'and so does one that leaves out the programs not measured')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
