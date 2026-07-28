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
// Minimum per-rival coverage as a FRACTION of the corpus (audit 2026-07-28:
// the old ">=5 rows" floor let 5 successes from a 60-case corpus count as
// "contested"). 0.7 is set from real corpus portability, not convenience: the
// least-portable maintained lanes (go/zig families) genuinely port 43/60 =
// 0.72 of cases; a healthy lane clears 0.7, a token lane cannot.
const COVERAGE_FLOOR = 0.7
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

// Per-case jz-vs-best-rival ratios for a rival set: [id, ratio, who].
const caseRatios = rivals => {
  const out = []
  for (const [id, c] of Object.entries(cases)) {
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
// proves tolerance, not leadership). Both gate the release, for BOTH promises
// (fastest-wasm vs CLAIM_RIVALS; outruns-the-JIT vs JIT_RIVALS).
const strictTest = (label, rivals) => test(`claims: strict leadership — jz beats the best ${label} on every case`, () => {
  const notLed = caseRatios(rivals).filter(([, r]) => r >= 1.0)
    .map(([id, r, who]) => `${id} ${r.toFixed(3)}× (${who})`)
  ok(notLed.length === 0, `strict ${label} leadership unproven on ${notLed.length} case(s): ${notLed.join(', ')}`)
})

const bandTest = (label, rivals) => test(`claims: no red cases — jz within the band of the best ${label} everywhere`, () => {
  const red = [], band = []
  for (const [id, r, who] of caseRatios(rivals)) {
    if (r > WASM_BAND_TOL) red.push(`${id} ${r.toFixed(3)}× (${who})`)
    else if (r >= 1.0) band.push(`${id} ${r.toFixed(3)}× (${who})`)
  }
  if (band.length) console.log(`  band (ties, not leads): ${band.join(', ')}`)
  ok(red.length === 0, `red cases void the ${label} claim: ${red.join(', ')}`)
})

strictTest('wasm rival', CLAIM_RIVALS)
bandTest('wasm rival', CLAIM_RIVALS)
strictTest('JIT', JIT_RIVALS)
bandTest('JIT', JIT_RIVALS)
