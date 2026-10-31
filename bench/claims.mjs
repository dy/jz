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
/** A ratio inside the band is a tie, never a lead. */
export const WASM_BAND_TOL = 1.05

/** The claim classes as [label, rivals]. */
export const CLAIM_CLASSES = [
  ['wasm', CLAIM_RIVALS],
  ['v8', V8_FAMILY_RIVALS],
  ['jsc', JSC_FAMILY_RIVALS],
]

/** Named exceptions: a case one claim class holds to a band instead of leadership,
 *  jz over the class's fastest rival by the reference medians. Measurement earns an
 *  entry: the case's code shown optimal against that class, or the same code leading
 *  on some CPUs and trailing on others. An `open` entry is the one other kind, a gap
 *  the owner accepts for the release while it is worked on: a dynamic program (a
 *  parser, a compiler) where the JIT speculates on what each site has seen and jz's
 *  wasm carries only what it proves for every input. Each is a tripwire, not a claim:
 *  the gate (test/bench-claims.js) fails the moment the case leaves its band, and the
 *  entry goes the commit jz leads on every runner. The class `rss` holds a case of the
 *  peak-RSS claim (test/_memory-floor.js) to a band of jz's peak over V8's. `cause` is
 *  the measured cause in a line, `evidence` where it was measured. */
export const CLAIM_EXCEPTIONS = [
  {
    case: 'vm', class: 'wasm', band: 1.12,
    cause: 'the same run_kernel code leads or trails by CPU: jz over the fastest wasm rival 0.751× on EPYC 9V74 (Zen 4), 0.763× on an Apple M4, 1.071-1.075× on EPYC 7763 (Zen 3, rust-wasm), 1.100× on EPYC 9V45 (Zen 5, c-wasm); 21 x64 instructions an interpreted op beside Rust\'s 21, and jz\'s dispatch jmp crosses a 64-byte line',
    evidence: 'reference runs 397e75bd (9V74), e65988e2 (9V45), e62d7a1c, 2c8f08ac and a841739a (7763), the run_kernel WAT byte-identical across them; the x64 code from node 24.22.1 --print-wasm-code',
  },
  {
    case: 'vm', class: 'jsc', band: 1.5,
    cause: "JSC's adaptive JIT runs the register VM's dispatch loop faster than V8 runs jz's wasm, whose loop is one fully inlined br_table over pure i32 (1.21-1.23× on EPYC 7763, 1.12× on EPYC 9V45)",
    evidence: "PLAN.md, the vm row of 'Active focus, September 25'; reference runs e62d7a1c, 2c8f08ac, a841739a",
  },
  {
    case: 'dict', class: 'jsc', band: 1.5,
    cause: "JSC's JIT runs the hash-probe chain faster than V8 runs jz's, which carries no bounds checks under a proven mask (four-round median 1.408, six-round repeat 1.350)",
    evidence: "PLAN.md, the dict row of 'Active focus, September 25'",
  },
  {
    case: 'crc32', class: 'jsc', band: 1.5,
    cause: 'V8 adds the table base as a wrapped 32-bit word before each table load where JSC indexes base plus scaled index (paired 1.401; about 1.26 with the table at a constant address)',
    evidence: "PLAN.md, the crc32 row of 'Active focus, September 25'",
  },
  {
    case: 'watr', class: 'jsc', band: 1.45, open: true,
    cause: "the JIT speculates on the shapes and kinds each site has seen (inline caches, deoptimizing on a miss) where jz's wasm carries only what it proves for every input; per-site shape caches in the wasm could close it, so the gap is not shown irreducible",
    evidence: 'reference runs 4922687e (EPYC 7763: watr 1.122× deno, 1.137× bun; jessie 1.070× jsc; jz 1.158× v8, 1.245× bun) and 825566d4 (watr 1.211× v8, 1.366× bun; jessie 1.127× jsc)',
  },
  {
    case: 'jessie', class: 'jsc', band: 1.2, open: true,
    cause: "the JIT speculates on the shapes and kinds each site has seen (inline caches, deoptimizing on a miss) where jz's wasm carries only what it proves for every input; per-site shape caches in the wasm could close it, so the gap is not shown irreducible",
    evidence: 'reference runs 4922687e (EPYC 7763: watr 1.122× deno, 1.137× bun; jessie 1.070× jsc; jz 1.158× v8, 1.245× bun) and 825566d4 (watr 1.211× v8, 1.366× bun; jessie 1.127× jsc)',
  },
  {
    case: 'jz', class: 'jsc', band: 1.35, open: true,
    cause: "the JIT speculates on the shapes and kinds each site has seen (inline caches, deoptimizing on a miss) where jz's wasm carries only what it proves for every input; per-site shape caches in the wasm could close it, so the gap is not shown irreducible",
    evidence: 'reference runs 4922687e (EPYC 7763: watr 1.122× deno, 1.137× bun; jessie 1.070× jsc; jz 1.158× v8, 1.245× bun) and 825566d4 (watr 1.211× v8, 1.366× bun; jessie 1.127× jsc)',
  },
  {
    case: 'webaudio', class: 'rss', band: 1.15, open: true,
    cause: "V8's compiled code for the speed build's 1.19 MB of wasm, about 13 MB resident, where the heap's high-water mark is 4.5 MB (the size build's 376 KB peaks at 70.0 MB)",
    evidence: 'reference run 4922687e (1.102×); paired local runs at d9c9e3a4 (75.7 MB against V8\'s 70.2 MB)',
  },
]
/** The cases a claim class holds to a band: case → its exception. */
export const exceptionsOf = label => new Map(CLAIM_EXCEPTIONS.filter(e => e.class === label).map(e => [e.case, e]))

/** Unmet cases: a case a claim class claims where jz does not lead yet. No band
 *  holds it: the gate lists it as todo until jz leads, the README names it beside
 *  the claim, and the entry goes the commit jz leads on every runner. `cause` is
 *  what is measured of the gap in a line, `evidence` where it was measured. */
export const CLAIM_UNMET = [
  {
    case: 'watr', class: 'v8',
    cause: "V8 runs jz's wasm as baseline (Liftoff) code until its optimizing compile lands, and the timed run lasts about 3 ms on CI, so most rounds run baseline code; optimized, jz runs 0.59× V8's time (--no-liftoff)",
    evidence: 'reference run 4922687e (EPYC 7763: 1.122× deno); probe runs 41131902865 and 41141556353 (1.112× by default, 0.590× under --no-liftoff)',
  },
  {
    case: 'jz', class: 'v8',
    cause: "not established: the self-compile case runs 1.02× V8 on an Apple M4 and 1.158× on EPYC 7763, and peaks at 1451 MB resident against V8's 453 MB",
    evidence: 'reference run 4922687e; local profile at 072827ee (Apple M4 Max)',
  },
]
/** The cases a claim class claims and does not lead yet. */
export const unmetOf = label => new Set(CLAIM_UNMET.filter(e => e.class === label).map(e => e.case))

/** The lanes measured for a case under --contenders: jz, the `n` fastest rivals of each
 *  claim class by the stored evidence, Porffor, and every selected lane no claim ranks
 *  (jz's own native lanes, the reference C). A rival with no timed row for the case
 *  cannot be ranked and waits for a full refresh, unless its class has no timed row at
 *  all (a case new to the corpus): a class the evidence cannot rank measures every one
 *  of its lanes. `lanes` is the selection (every lane when null), so a rival absent
 *  from it is neither ranked nor measured. */
const RANKED = new Set([...CLAIM_RIVALS, ...JIT_RIVALS, 'porf-native'])
export const contenders = (caseEvidence, n, lanes = null) => {
  const rows = caseEvidence?.targets ?? {}
  const fastest = rivals => {
    const here = rivals.filter(r => !lanes || lanes.includes(r)), timed = here.filter(r => timedBenchmarkRow(rows[r]))
    return timed.length ? timed.sort((a, b) => rows[a].medianUs - rows[b].medianUs).slice(0, n) : here
  }
  return ['jz', ...CLAIM_CLASSES.flatMap(([, rivals]) => fastest(rivals)), ...fastest(['porf-native']),
    ...(lanes ?? []).filter(l => l !== 'jz' && !RANKED.has(l))]
}
