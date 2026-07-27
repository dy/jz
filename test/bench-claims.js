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
 *   2. COMPLETE — every named wasm rival contributes parity-valid rows;
 *                 an absent rival is an uncontested (= unproven) claim.
 *   3. WINNING  — no case may trail its best comparable wasm rival beyond
 *                 the shared jitter band; band rows are ties, never leads,
 *                 and red rows void the "fastest wasm" claim outright.
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

test('claims: every named wasm rival is contested (parity-valid rows present)', () => {
  for (const rival of CLAIM_RIVALS) {
    let rows = 0
    for (const c of Object.values(cases)) {
      const t = c.targets?.[rival]
      if (t && t.medianUs > 0 && t.parity === 'ok') rows++
    }
    ok(rows >= 5, `rival '${rival}' has ${rows} parity-valid row(s) in the reference dataset (need ≥5) — the claim is uncontested against it`)
  }
})

test('claims: Porffor contested via its native artifact (porf-native rows present)', () => {
  let rows = 0
  for (const c of Object.values(cases)) {
    const t = c.targets?.['porf-native']
    if (t && t.medianUs > 0 && t.parity === 'ok') rows++
  }
  ok(rows >= 5, `porf-native has ${rows} parity-valid row(s) in the reference dataset (need ≥5) — Porffor is uncontested in the evidence`)
})

// STRICT LEADERSHIP — the actual "fastest wasm" claim: jz strictly faster than
// the best rival on every case. Separate from the band test below (audit: a
// ≤1.05 band row proves tolerance, not leadership). Both gate the release.
test('claims: strict leadership — jz beats the best wasm rival on every case', () => {
  const notLed = []
  for (const [id, c] of Object.entries(cases)) {
    const jz = c.targets?.jz
    if (!jz || !(jz.medianUs > 0)) continue
    let best = null, who = null
    for (const rival of CLAIM_RIVALS) {
      const t = c.targets?.[rival]
      if (!t || !(t.medianUs > 0) || t.parity !== 'ok') continue
      if (best == null || t.medianUs < best) { best = t.medianUs; who = rival }
    }
    if (best == null) continue
    const ratio = jz.medianUs / best
    if (ratio >= 1.0) notLed.push(`${id} ${ratio.toFixed(3)}× (${who})`)
  }
  ok(notLed.length === 0, `strict leadership unproven on ${notLed.length} case(s): ${notLed.join(', ')}`)
})

test('claims: no red cases — jz within the band of the best wasm rival everywhere', () => {
  const red = [], band = []
  for (const [id, c] of Object.entries(cases)) {
    const jz = c.targets?.jz
    if (!jz || !(jz.medianUs > 0)) continue
    let best = null, who = null
    for (const rival of CLAIM_RIVALS) {
      const t = c.targets?.[rival]
      if (!t || !(t.medianUs > 0) || t.parity !== 'ok') continue
      if (best == null || t.medianUs < best) { best = t.medianUs; who = rival }
    }
    if (best == null) continue
    const ratio = jz.medianUs / best
    if (ratio > WASM_BAND_TOL) red.push(`${id} ${ratio.toFixed(3)}× (${who})`)
    else if (ratio >= 1.0) band.push(`${id} ${ratio.toFixed(3)}× (${who})`)
  }
  if (band.length) console.log(`  band (ties, not leads): ${band.join(', ')}`)
  ok(red.length === 0, `red cases void the fastest-wasm claim: ${red.join(', ')}`)
})
