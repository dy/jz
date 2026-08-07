/**
 * Release gate for the performance CLAIM (audit P0 2026-07-25): the committed
 * reference dataset (bench/results.json, the M4 reference machine) must be
 * CURRENT, COMPLETE, and WINNING before the claim ships. Unlike test/bench.js
 * (which measures THIS machine and treats ratios informationally on CI), this
 * gate reads only committed evidence and hard-fails — wired into
 * `prepublishOnly`, run explicitly via `npm run test:claims`.
 *
 *   1. FRESH    — no compiler-source commit may postdate the snapshot's
 *                 meta.commit: stale evidence proves nothing about HEAD.
 *   2. COMPLETE — every named rival (wasm, JIT, porf-native) contributes
 *                 parity-valid rows over ≥ COVERAGE_FLOOR of the corpus;
 *                 an absent or token lane is an uncontested (= unproven) claim.
 *   3. WINNING  — strict per-case leadership AND no case beyond the shared
 *                 jitter band, for BOTH promises: "fastest wasm" (CLAIM_RIVALS)
 *                 and "outruns the JIT" (JIT_RIVALS). Band rows are ties,
 *                 never leads; red rows void the claim outright.
 */
import test from 'tst'
import { ok } from 'tst/assert.js'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { machineState } from '../bench/machine-state.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WASM_BAND_TOL = 1.05   // keep in lockstep with test/bench.js
// The named rivals of the claim. Unlike test/bench.js's availability-filtered
// list (what can run HERE), the reference dataset must contest ALL of them.
// (Porffor left the wasm field with its 2026 rewrite — it contests from the
// native band as `porf-native`, presence-gated below, geomean-pinned in
// test/bench.js.)
const CLAIM_RIVALS = ['c-wasm', 'rust-wasm', 'go-wasm', 'tinygo', 'zig-wasm', 'as']
// The OTHER published promise — "outruns the JIT" — same committed-evidence
// discipline as the wasm claim (audit 2026-07-28: it was ungated; the snapshot
// held 19 JIT losses across 9 cases that no test surfaced). Every JS-runtime
// lane in the reference dataset counts; absence of a lane is a coverage hole,
// not a pass (same COVERAGE_FLOOR as the wasm rivals).
const JIT_RIVALS = ['v8', 'deno', 'bun', 'jsc']
// V8-family engines (node's V8, Deno's V8) get the full strict-leadership claim on
// every case, no exception. Bun and JSC (both JavaScriptCore) carry the scoped
// exception below — split out so a lane's engine family, not its runtime name,
// decides which claim it's held to.
const V8_FAMILY_RIVALS = ['v8', 'deno']
const JSC_FAMILY_RIVALS = ['bun', 'jsc']
// DECIDED CLAIM SCOPING 2026-08-01 (.work/todo.md "DECISIONS EXECUTED 2026-08-01" +
// evidence "VM + DICT DISSECTED: HARD TAILS, ~0% CLOSABLE" 2026-07-31): the
// tight-integer-loop class (register-VM dispatch, hash-probe chains, checksum
// accumulation) is where JSC's adaptive JIT specializes hot integer loops beyond
// what an AOT-compiled wasm module can match at this size. Dissected exhaustively —
// WAT already optimal (vm's opcode chain is O(1) br_table, fully inlined, pure i32;
// dict's probe chain carries zero bounds checks, AND-mask proven; Liftoff/tier-up
// tiering confound ruled out) — and on every one of these cases jz still leads
// EVERY V8-family engine and EVERY AOT wasm rival (c/rust/go/zig/AS/MoonBit). This
// is JSC's rival EXECUTION MODEL winning on its own turf (adaptive JIT on JS source
// vs AOT wasm in V8), not a jz codegen deficiency — no emission lever exists at the
// WAT level. Precedent: the same honest-boundary discipline the M4-reference-
// machine scoping above already applies to the whole suite (name the scope a claim
// holds over instead of quietly excluding what falls outside it). These (case,
// rival) pairs are exempt from strict leadership below but still gated by a sanity
// band (JSC_EXCEPTION_BAND_TOL) — a regression tripwire, not a claim.
const TIGHT_INT_LOOP_CASES = ['vm', 'dict', 'crc32']
// Not a leadership bar. If a bun/jsc lead on these cases ever widens past 1.5×
// that's a real jz regression, not just the standing rival-execution-model gap.
const JSC_EXCEPTION_BAND_TOL = 1.5
// Minimum per-rival coverage as a FRACTION of the corpus (audit 2026-07-28:
// the old ">=5 rows" floor let 5 successes from a 60-case corpus count as
// "contested"). 0.7 is set from real corpus portability, not convenience: the
// least-portable maintained lanes (go/zig families) genuinely port 43/60 =
// 0.72 of cases; a healthy lane clears 0.7, a token lane cannot.
const COVERAGE_FLOOR = 0.7
// DECIDED CLAIM SCOPING 2026-08-01 (.work/todo.md "DECISIONS EXECUTED 2026-08-01" +
// evidence "SIZE BAND DIAGNOSED: HONEST FLOOR" 2026-07-30): the size claim is
// par-or-smaller than AssemblyScript BY GEOMEAN, not strict-smaller — a control
// experiment proved the 1.02-1.05x band is dominantly the JS-SEMANTICS TAX: AS's
// bench ports wrap every array access in `unchecked()` (compiling them WITH
// assertions is byte-identical output, i.e. AS's baseline assumes zero bounds
// checking unconditionally), while jz pays real guards because JS out-of-bounds
// semantics are load-bearing (an OOB read yields `undefined`, a write drops
// silently — ir.js's rationale). Mirrors test/bench.js's SIZE_GEOMEAN_MAX.
const SIZE_GEOMEAN_MAX = 1.05
// Compiler-source scope for freshness: a commit touching only tests/docs/site
// doesn't invalidate perf evidence; one touching these does.
// EVERY codegen input (audit 2026-07-27: the old allowlist missed package.json/
// package-lock.json — dependency upgrades like the watr 5.7.12 determinism fix
// change emitted code — and layout.js). Kept as an explicit list because the
// repo also holds non-codegen trees (tests/site/bench evidence); the watr
// version is additionally cross-checked against the snapshot's meta below.
const SOURCE_SCOPE = ['src', 'module', 'jzify', 'index.js', 'interop.js', 'layout.js', 'package.json', 'package-lock.json']

const res = JSON.parse(readFileSync(join(ROOT, 'bench/results.json'), 'utf8'))
const cases = res.cases

test('claims: reference evidence is fresh (no compiler commits past meta.commit)', () => {
  const base = res.meta?.commit
  ok(typeof base === 'string' && base.length >= 7, `results.json meta.commit missing/malformed: ${base}`)
  let stale
  try {
    stale = execFileSync('git', ['log', '--oneline', `${base}..HEAD`, '--', ...SOURCE_SCOPE],
      { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).trim()
  } catch (e) {
    ok(false, `freshness check failed to run (bad meta.commit ${base}?): ${String(e.message).slice(0, 120)}`)
    return
  }
  const n = stale ? stale.split('\n').length : 0
  ok(n === 0, `reference dataset is STALE: ${n} compiler-source commit(s) postdate its meta.commit ${base} — re-run the reference bench at HEAD:\n${stale.split('\n').slice(0, 8).join('\n')}`)
  // The dependency axis the path scope can't see from inside the snapshot: the
  // watr that produced the evidence must be the watr installed now.
  const snapWatr = res.meta?.versions?.watr
  const nowWatr = JSON.parse(readFileSync(join(ROOT, 'node_modules/watr/package.json'), 'utf8')).version
  ok(snapWatr === nowWatr, `reference dataset compiled with watr ${snapWatr}, installed is ${nowWatr} — re-run the reference bench`)
})

// PARTIAL evidence must be anchor-verified (fast-refresh tightening,
// bench/README.md): `bench/bench.mjs --merge` can leave the
// dataset mixing vintages — freshly re-measured jz rows alongside untouched
// rival rows from an earlier commit. That's only honest evidence if a
// `--verify-anchors` run in the same session certified the untouched rival
// rows still hold at today's machine state (meta.anchors.pass). A partial
// dataset with no passing anchor check is unverified drift risk, not proof.
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
// 2b, bench/machine-state.mjs). The WARM/MEMORY-FLOOR false-red campaign
// (.work/todo.md §deletion-sweep "WARM + MEMORY-FLOOR reds RESOLVED as
// ENVIRONMENT" status, 2026-08-06) found LIVE that swap pressure alone
// explains multi-percent timing drift with zero code change — every fresh
// timing write now carries meta.machineState; this gate holds it to a sane
// bound so a future regression report can rule out "the machine was
// swapping" before chasing a phantom code cause.
const SWAP_SANE_BOUND_MB = 4096
// audit-#14 item 9: evidence WITHOUT machineState must not read as a green
// validity pass — while the field is absent the gate is a visible TODO
// (pending, counts as neither pass nor fail), and becomes a real enforced
// bound the moment a refresh writes the field. Self-healing: no manual flip.
;(res.meta?.machineState ? test : test.todo)('VALIDITY: committed evidence carries machineState within the swap-pressure sane bound', () => {
  const state = res.meta?.machineState
  ok(state, 'committed reference carries no machineState — regenerate bench/results.json via --json/--merge (machine-state capture is unconditional there)')
  ok(state.swapUsedMB == null || state.swapUsedMB < SWAP_SANE_BOUND_MB,
    `committed evidence's machineState.swapUsedMB=${state.swapUsedMB}MB exceeds the ${SWAP_SANE_BOUND_MB}MB sane bound — timing evidence recorded under swap pressure is validity-suspect; re-measure on a quieter (post-reboot) machine`)
})

// Live-machine validity (audit-#13 item 2b, inverted per audit-#14 item 9):
// the earlier form asserted swap IS elevated ("KNOWN-BAD documented-red"),
// which turned a bad environment into a green row — the exact disguise the
// validity mechanism exists to prevent. Now the assertion always points the
// RIGHT way (swap below bound) and registration self-selects: while the live
// machine is invalid the gate is a visible TODO (pending, not a pass); once
// a reboot clears the swap it becomes a real passing test with no edit. The
// WARM/MEMORY-FLOOR campaign (2026-08-06) established that elevated swap
// alone explains multi-percent timing drift with zero code change.
const _liveState = machineState()
const _liveInvalid = _liveState.swapUsedMB != null && _liveState.swapUsedMB >= SWAP_SANE_BOUND_MB
;(_liveInvalid ? test.todo : test)('VALIDITY: live machine swap pressure below the sane bound (timing evidence is embargoed while this is TODO)', () => {
  if (_liveState.swapUsedMB == null) { ok(true, 'swapUsedMB unavailable on this platform/host (non-darwin, or sysctl missing) — nothing to validate live'); return }
  ok(!_liveInvalid,
    `live swapUsedMB=${_liveState.swapUsedMB}MB exceeds the ${SWAP_SANE_BOUND_MB}MB sane bound — timing/memory evidence gathered now is validity-suspect; reboot before measuring`)
})

// MEMORY freshness — same discipline as the FRESH test above, applied to the
// separate GOAL-MEMORY evidence file (.work/memcheck-results.csv, the jz-wasmtime
// vs moonrun peak-RSS comparison). It isn't part of results.json — regenerated on
// its own cadence — so it carries its own `# commit:` header and needs its own
// staleness check, or a compiler change could silently invalidate the memory goal
// while results.json's freshness test stays green.
test('claims: memory evidence is fresh (no compiler commits past memcheck-results.csv\'s commit)', () => {
  const csv = readFileSync(join(ROOT, '.work/memcheck-results.csv'), 'utf8')
  const m = csv.match(/^#\s*commit:\s*([0-9a-f]{7,40})\s*$/m)
  ok(m, 'memcheck-results.csv missing a "# commit: <hash>" header — cannot verify freshness')
  const base = m[1]
  let stale
  try {
    stale = execFileSync('git', ['log', '--oneline', `${base}..HEAD`, '--', ...SOURCE_SCOPE],
      { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).trim()
  } catch (e) {
    ok(false, `memory freshness check failed to run (bad commit ${base}?): ${String(e.message).slice(0, 120)}`)
    return
  }
  const n = stale ? stale.split('\n').length : 0
  ok(n === 0, `memory evidence is STALE: ${n} compiler-source commit(s) postdate memcheck-results.csv's commit ${base} — regenerate .work/memcheck-results.csv at HEAD:\n${stale.split('\n').slice(0, 8).join('\n')}`)
})

const parityRows = rival => {
  let rows = 0
  for (const c of Object.values(cases)) {
    const t = c.targets?.[rival]
    if (t && t.medianUs > 0 && t.parity === 'ok') rows++
  }
  return rows
}

test('claims: every named rival is contested (coverage ≥ floor of the corpus)', () => {
  const total = Object.keys(cases).length
  const need = Math.ceil(total * COVERAGE_FLOOR)
  for (const rival of [...CLAIM_RIVALS, ...JIT_RIVALS, 'porf-native']) {
    const rows = parityRows(rival)
    ok(rows >= need, `rival '${rival}' has ${rows}/${total} parity-valid rows (floor ${need}) — the claim is uncontested against it`)
  }
})

// Per-case jz-vs-best-rival ratios for a rival set: [id, ratio, who]. `ids`
// (optional Set) restricts which cases are considered — used to carve the
// JSC tight-integer-loop exception out of the general bun/jsc claim.
const caseRatios = (rivals, ids = null) => {
  const out = []
  for (const [id, c] of Object.entries(cases)) {
    if (ids && !ids.has(id)) continue
    const jz = c.targets?.jz
    if (!jz || !(jz.medianUs > 0)) continue
    let best = null, who = null
    for (const rival of rivals) {
      const t = c.targets?.[rival]
      if (!t || !(t.medianUs > 0) || t.parity !== 'ok') continue
      if (best == null || t.medianUs < best) { best = t.medianUs; who = rival }
    }
    if (best != null) out.push([id, jz.medianUs / best, who])
  }
  return out
}

// STRICT LEADERSHIP — the actual claim: jz strictly faster than the best rival
// on every case. Separate from the band test below (audit: a ≤1.05 band row
// proves tolerance, not leadership). Both gate the release, for every promise
// this file enforces (fastest-wasm vs CLAIM_RIVALS; outruns-the-JIT vs the
// V8-family / bun-jsc splits below).
const strictTest = (label, rivals, ids = null) => test(`claims: strict leadership — jz beats the best ${label} on every case`, () => {
  const notLed = caseRatios(rivals, ids).filter(([, r]) => r >= 1.0)
    .map(([id, r, who]) => `${id} ${r.toFixed(3)}× (${who})`)
  ok(notLed.length === 0, `strict ${label} leadership unproven on ${notLed.length} case(s): ${notLed.join(', ')}`)
})

const bandTest = (label, rivals, ids = null, tol = WASM_BAND_TOL) => test(`claims: no red cases — jz within the band of the best ${label} everywhere`, () => {
  const red = [], band = []
  for (const [id, r, who] of caseRatios(rivals, ids)) {
    if (r > tol) red.push(`${id} ${r.toFixed(3)}× (${who})`)
    else if (r >= 1.0) band.push(`${id} ${r.toFixed(3)}× (${who})`)
  }
  if (band.length) console.log(`  band (ties, not leads): ${band.join(', ')}`)
  ok(red.length === 0, `red cases void the ${label} claim: ${red.join(', ')}`)
})

strictTest('wasm rival', CLAIM_RIVALS)
bandTest('wasm rival', CLAIM_RIVALS)

// JIT claim, split by engine family (DECIDED CLAIM SCOPING 2026-08-01, see
// TIGHT_INT_LOOP_CASES above): V8-family gets the unscoped claim over the full
// corpus; bun/jsc get it everywhere EXCEPT the documented tight-integer-loop
// exception, which instead gets its own sanity-band tripwire below.
const nonExceptionIds = new Set(Object.keys(cases).filter(id => !TIGHT_INT_LOOP_CASES.includes(id)))
strictTest('V8-family JIT (v8/node, deno)', V8_FAMILY_RIVALS)
bandTest('V8-family JIT (v8/node, deno)', V8_FAMILY_RIVALS)
strictTest('bun/jsc JIT (outside the tight-integer-loop exception)', JSC_FAMILY_RIVALS, nonExceptionIds)
bandTest('bun/jsc JIT (outside the tight-integer-loop exception)', JSC_FAMILY_RIVALS, nonExceptionIds)

test('claims: documented exception — tight-integer-loop cases (vm/dict/crc32) stay within the 1.5× sanity band of bun/jsc', () => {
  const exceptionIds = new Set(TIGHT_INT_LOOP_CASES)
  const red = caseRatios(JSC_FAMILY_RIVALS, exceptionIds).filter(([, r]) => r > JSC_EXCEPTION_BAND_TOL)
    .map(([id, r, who]) => `${id} ${r.toFixed(3)}× (${who})`)
  ok(red.length === 0, `tight-integer-loop exception exceeded its ${JSC_EXCEPTION_BAND_TOL}× sanity band on ${red.length} case(s): ${red.join(', ')} — a real regression, not the documented rival-execution-model gap`)
})

// SIZE — par-or-smaller by geomean vs AssemblyScript, not strict-smaller (see
// SIZE_GEOMEAN_MAX above). Scoped to the `optimize:'size'` byte counts every
// case with a parity-valid `as` row carries.
test(`claims: size — jz geomean bytes vs AssemblyScript stays within the ${SIZE_GEOMEAN_MAX}× par band`, () => {
  const ratios = []
  for (const c of Object.values(cases)) {
    const jz = c.targets?.jz, as = c.targets?.as
    if (!jz || !as || !(jz.bytes > 0) || !(as.bytes > 0) || as.parity !== 'ok') continue
    ratios.push(jz.bytes / as.bytes)
  }
  ok(ratios.length > 0, 'no jz/as size-comparable cases found')
  const smaller = ratios.filter(r => r < 1).length
  const geomean = Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length)
  console.log(`  size geomean jz/as: ${geomean.toFixed(3)}× (${smaller}/${ratios.length} cases smaller)`)
  ok(geomean <= SIZE_GEOMEAN_MAX, `size geomean jz/as ${geomean.toFixed(3)}× exceeds the ${SIZE_GEOMEAN_MAX}× par band`)
})
