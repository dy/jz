// The rivals and bands of the published speed claims. One definition for the
// release gate (test/bench-claims.js), the ledger (scripts/ledger.mjs) and the
// harness's contenders (bench/bench.mjs --contenders).
import { timedBenchmarkRow } from '../assets/headline.js'

/** "Fastest wasm": every wasm producer the reference dataset must contest. */
export const CLAIM_RIVALS = ['c-wasm', 'rust-wasm', 'go-wasm', 'tinygo', 'zig-wasm', 'as']
/** "Outruns the JIT", by engine family. */
export const V8_FAMILY_RIVALS = ['v8', 'deno']
export const JSC_FAMILY_RIVALS = ['bun', 'jsc']
export const JIT_RIVALS = [...V8_FAMILY_RIVALS, ...JSC_FAMILY_RIVALS]
/** Cases where bun/jsc are held to the sanity band instead of leadership. */
export const TIGHT_INT_LOOP_CASES = ['vm', 'dict', 'crc32']
export const JSC_EXCEPTION_BAND_TOL = 1.5
/** A ratio inside the band is a tie, never a lead. */
export const WASM_BAND_TOL = 1.05

/** The claim classes as [label, rivals, exempt cases]. */
export const CLAIM_CLASSES = [
  ['wasm', CLAIM_RIVALS, []],
  ['v8', V8_FAMILY_RIVALS, []],
  ['jsc', JSC_FAMILY_RIVALS, TIGHT_INT_LOOP_CASES],
]

/** The lanes that can contest a case: jz, the `n` fastest rivals of each claim class by
 *  the stored evidence, and Porffor, among the `lanes` selected (every lane by default).
 *  A rival with no timed row for the case cannot be ranked and waits for a full refresh. */
export const contenders = (caseEvidence, n, lanes = null) => {
  const rows = caseEvidence?.targets ?? {}
  const fastest = rivals => rivals.filter(r => (!lanes || lanes.includes(r)) && timedBenchmarkRow(rows[r]))
    .sort((a, b) => rows[a].medianUs - rows[b].medianUs).slice(0, n)
  return ['jz', ...CLAIM_CLASSES.flatMap(([, rivals]) => fastest(rivals)), ...fastest(['porf-native'])]
}
