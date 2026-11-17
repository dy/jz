// The rivals and bands of the published speed claims. One definition for the
// release gate (test/bench-claims.js), the ledger (scripts/ledger.mjs) and the
// harness's contenders (bench/bench.mjs --contenders). A lane is timed after its
// engine's tiers settle, and the first pass is recorded beside it (_lib/passes.js).
import { timedBenchmarkRow } from '../assets/headline.js'

/** "Fastest wasm": every wasm producer the reference dataset must contest, each built
 *  strict (LANE_FLAGS): no fast-math, no multiply-add contracted to one rounding. */
export const CLAIM_RIVALS = ['c-wasm', 'rust-wasm', 'go-wasm', 'tinygo', 'zig-wasm', 'as']
/** The rivals' own float relaxation beside jz's: the C ports with -ffast-math. */
export const FAST_RIVALS = ['c-wasm-fast']
/** "Outruns the JIT", by engine family. */
export const V8_FAMILY_RIVALS = ['v8', 'deno']
export const JSC_FAMILY_RIVALS = ['bun', 'jsc']
export const JIT_RIVALS = [...V8_FAMILY_RIVALS, ...JSC_FAMILY_RIVALS]
/** A ratio inside the band is a tie, never a lead: it passes the gate and is printed
 *  as a target. 8% by the owner's ruling of 2026-11-17 ("5-8% can be said ties"),
 *  5% before it. */
export const WASM_BAND_TOL = 1.08

/** The compiler's source: every input of what jz emits (test/bench-claims.js says why each
 *  is listed). Evidence is stale past a commit that changes one, and a held-out program's
 *  first contact measures none changed since its registration (bench/heldout/lane.mjs). */
export const SOURCE_SCOPE = ['src', 'module', 'jzify', 'index.js', 'interop.js', 'wasi.js', 'layout.js', 'layout-kinds.js', 'err-codes.js', 'package.json', 'package-lock.json']

/** The flags each claim lane is built with: one definition for the harness's builds,
 *  the dataset's record of them (meta.invocations, LANE_CMDS) and the test that pins
 *  them (test/bench-claims.js). jz is timed at 'speed', where its float rewrites may
 *  round otherwise than JavaScript (README, "Float results at 'speed'"); `jz-exact` is
 *  the same build at JavaScript's float results; jz's bytes are its size build. The
 *  rivals build as their compilers do by default for speed, which keeps the source's
 *  float order: clang with no fast-math and no contraction (`-ffp-contract=off`), rustc
 *  and zig with no float relaxation (zig's ReleaseFast leaves its float mode strict),
 *  asc with none to offer. AssemblyScript's bytes are `-Oz --converge`, the expansion
 *  of its `-Osize` (asc 0.28's options table). */
export const LANE_FLAGS = {
  jz: { level: 'speed' },
  'jz-exact': { level: 'speed', relaxedFloat: false },
  'jz-size': { level: 'size' },
  'c-wasm': ['-target', 'wasm32-wasi', '-msimd128', '-O3', '-ffp-contract=off'],
  'c-wasm-fast': ['-target', 'wasm32-wasi', '-msimd128', '-O3', '-ffast-math'],
  'rust-wasm': ['--target', 'wasm32-wasip1', '-C', 'opt-level=3', '-C', 'target-feature=+simd128'],
  'zig-wasm': ['-target', 'wasm32-wasi', '-mcpu=generic+simd128', '-O', 'ReleaseFast'],
  tinygo: ['-target=wasip1', '-opt=2', '-no-debug'],
  as: ['-O3', '--runtime', 'stub', '--noAssert'],
  'as-size': ['-Oz', '--converge', '--runtime', 'stub', '--noAssert'],
}
// (a level alone is written as the option takes it, `'speed'`, the record's form before the table)
const optimizeText = o => Object.keys(o).length === 1 && 'level' in o ? `'${o.level}'` : `{ ${Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : v}`).join(', ')} }`
/** The record of each claim lane's build in the dataset (meta.invocations), from LANE_FLAGS. */
export const LANE_CMDS = {
  jz: `time: compile(src, { optimize: ${optimizeText(LANE_FLAGS.jz)} }); size: compile(src, { optimize: ${optimizeText(LANE_FLAGS['jz-size'])} }) → node (V8 wasm)`,
  'jz-exact': `compile(src, { optimize: ${optimizeText(LANE_FLAGS['jz-exact'])} }) → node (V8 wasm)`,
  'c-wasm': `zig cc ${LANE_FLAGS['c-wasm'].join(' ')} <case>.c → node (V8 wasm)`,
  'c-wasm-fast': `zig cc ${LANE_FLAGS['c-wasm-fast'].join(' ')} <case>.c → node (V8 wasm)`,
  'rust-wasm': `rustc ${LANE_FLAGS['rust-wasm'].join(' ')} <case>.rs → node (V8 wasm)`,
  'zig-wasm': `zig build-exe ${LANE_FLAGS['zig-wasm'].join(' ')} <case>.zig (no libc) → node (V8 wasm)`,
  tinygo: `tinygo build ${LANE_FLAGS.tinygo.join(' ')} <case>.go → node (V8 wasm)`,
  'go-wasm': 'GOOS=wasip1 GOARCH=wasm go build <case>.go → node (V8 wasm)',
  as: `time: asc <case>.as.ts ${LANE_FLAGS.as.join(' ')}; size: asc <case>.as.ts ${LANE_FLAGS['as-size'].join(' ')}`,
}
/** Cases the gate does not require a correct JZ timing for: the compiler workloads
 *  (watr, jessie, the jz self-compile, whose build can outlast a runner). They enter
 *  every aggregate; only this check passes over them. (The colour probes left it on
 *  2026-11-14: hashed at 16 significant bits, every engine's libm and jz's agree.) */
export const PARITY_EXEMPT = new Set(['watr', 'jessie', 'jz'])

/** The claim classes as [label, rivals]. "Fastest wasm" is held twice, like against
 *  like: `wasm`, the jz lane (relaxed floats) against the best of the strict rivals and
 *  the fast ones; `wasm-exact`, the jz-exact lane (JavaScript's floats) against the
 *  strict rivals. */
export const CLAIM_CLASSES = [
  ['wasm', [...CLAIM_RIVALS, ...FAST_RIVALS]],
  ['wasm-exact', CLAIM_RIVALS],
  ['v8', V8_FAMILY_RIVALS],
  ['jsc', JSC_FAMILY_RIVALS],
]
/** The jz lane a class times, where it is not `jz`. */
export const CLASS_BASE = { 'wasm-exact': 'jz-exact' }
export const baseOf = label => CLASS_BASE[label] ?? 'jz'
/** A class that is a claim measured another way answers to that claim's named
 *  exceptions and unmet cases: `wasm-exact` is "fastest wasm" as `wasm` is. */
const CLAIM_OF = { 'wasm-exact': 'wasm' }
export const claimOf = label => CLAIM_OF[label] ?? label
/** The floor of cases each class contests: claimed cases (not pending, excepted or
 *  unmet) where its jz lane and at least one of its rivals carry a timed, correct row.
 *  Set from the reference run of 2026-11-14 (3420027c: wasm 76, v8 and jsc 82 each);
 *  wasm-exact takes wasm's, its lane running every case jz runs but the self-compile,
 *  which no wasm rival contests. A floor only rises: a lane lost on a case shows here
 *  before it leaves a claim vacuous. */
export const CONTESTED_FLOOR = { wasm: 76, 'wasm-exact': 76, v8: 82, jsc: 82 }

/** Named exceptions: a case one claim class holds to a band instead of leadership,
 *  jz over the class's fastest rival by the reference medians. Measurement earns an
 *  entry: the case's code shown optimal against that class, or the same code leading
 *  on some CPUs and trailing on others. An `open` entry is the one other kind, a gap
 *  the owner accepts for the release while it is worked on: a dynamic program (a
 *  parser, a compiler) where the JIT speculates on what each site has seen and jz's
 *  wasm carries only what it proves for every input. Each is a tripwire, not a claim:
 *  the gate (test/bench-claims.js) fails the moment the case leaves its band, and the
 *  entry goes the commit jz leads on every runner. The class `rss` holds a case of the
 *  peak-RSS claim (test/_memory-floor.js) to a band of jz's peak over V8's; the class
 *  `size` a case of the size bar (jz's size build strictly under `asc -Oz`) to a band
 *  of jz's bytes over AssemblyScript's, where the port is not the program the JS states.
 *  `cause` is the measured cause in a line, `evidence` where it was measured. */
export const CLAIM_EXCEPTIONS = [
  {
    case: 'vm', class: 'wasm', band: 1.12,
    cause: 'the same run_kernel code leads or trails by CPU: jz over the fastest wasm rival 0.751× on EPYC 9V74 (Zen 4), 0.763× on an Apple M4, 1.071-1.075× on EPYC 7763 (Zen 3, rust-wasm), 1.100× on EPYC 9V45 (Zen 5, c-wasm); 21 x64 instructions an interpreted op beside Rust\'s 21, and jz\'s dispatch jmp crosses a 64-byte line',
    evidence: 'reference runs 397e75bd (9V74), e65988e2 (9V45), e62d7a1c, 2c8f08ac and a841739a (7763), the run_kernel WAT byte-identical across them; the x64 code from node 24.22.1 --print-wasm-code',
  },
  {
    case: 'vm', class: 'jsc', band: 1.5,
    cause: "JSC's adaptive JIT runs the register VM's dispatch loop faster than V8 runs jz's wasm, whose loop is one fully inlined br_table over pure i32 (1.21-1.23× on EPYC 7763, 1.12× on EPYC 9V45)",
    evidence: "`git show c41d43f10:PLAN.md`, the vm row of 'Active focus, September 25'; reference runs e62d7a1c, 2c8f08ac, a841739a",
  },
  {
    case: 'dict', class: 'jsc', band: 1.5,
    cause: "JSC's JIT runs the hash-probe chain faster than V8 runs jz's, which carries no bounds checks under a proven mask (four-round median 1.408, six-round repeat 1.350)",
    evidence: "`git show c41d43f10:PLAN.md`, the dict row of 'Active focus, September 25'",
  },
  {
    case: 'crc32', class: 'jsc', band: 1.5,
    cause: 'V8 adds the table base as a wrapped 32-bit word before each table load where JSC indexes base plus scaled index (paired 1.401; about 1.26 with the table at a constant address)',
    evidence: "`git show c41d43f10:PLAN.md`, the crc32 row of 'Active focus, September 25'",
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
  {
    case: 'arraydowngrade', class: 'size', band: 5, open: true,
    cause: "AssemblyScript's port is a closed tagged union that appends the literal '[object Object]1' and reads NaN where JS concatenates, so it carries no Number::toString or ToNumber of a string; jz carries both (3.9 and 2.3 kB of its 12.2) until it proves which slots hold the object and the string: `checksum + arr[0]` concatenates where slot 0 may be the string, and benchlib's mix converts that checksum",
    evidence: "size build at e61b0ba3 (12,184 B; 4.93× asc -Oz's 2,470 B on an M4, 4.83× the 2,523 B of bench run 41843261059, which measured 14,632 B at 03c853cb), the record's keyed read a guard since b9cf12ac",
  },
]
/** The cases a claim class holds to a band: case → its exception. */
export const exceptionsOf = label => new Map(CLAIM_EXCEPTIONS.filter(e => e.class === claimOf(label)).map(e => [e.case, e]))

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
  // the @audio/decode codecs (scripts/decode-cases.mjs), the packages' own code: open work
  // that .work/decode.md tracks class by class; each leaves the list the commit jz leads it
  {
    case: 'decode-qoa', class: 'v8',
    cause: "after the element-range facts the frame loop is all i32; what remains is the slice loop's 19 int16 loads per sample with the LMS history and weights stored and reloaded every iteration, and the DataView offset kept in f64 (about 5%)",
    evidence: 'paired six rounds, 2026-11-06, Apple M4 Max: 0.81× (V8 time over jz time)',
  },
  {
    case: 'decode-wav', class: 'v8',
    cause: "not established for this input: the decode loop runs typed since the closure-set copies, and the lab's controls leave its secondary channel stride and the 16-bit table read as the remaining candidates",
    evidence: 'paired six rounds, 2026-11-06, Apple M4 Max: 0.84× (V8 time over jz time)',
  },
  {
    case: 'decode-tta', class: 'v8',
    cause: "the bit reader's position and fill count stay Number cells (unbounded counters), the unary counter a guarded i64, and the channel record's u32 slots read through an i64 truncation and a select",
    evidence: 'paired six rounds, 2026-11-06, Apple M4 Max: 0.93× (V8 time over jz time)',
  },
  {
    case: 'decode-alac', class: 'v8',
    cause: 'a tie, not a lead: the adaptive Golomb decoder (dynDecomp), 43% of 16-bit time after the range fixes, is not examined yet',
    evidence: 'paired six rounds, 2026-11-06, Apple M4 Max: 1.01× (V8 time over jz time), inside the tie band',
  },
]
/** The cases a claim class claims and does not lead yet. */
export const unmetOf = label => new Set(CLAIM_UNMET.filter(e => e.class === claimOf(label)).map(e => e.case))

/** The lanes measured for a case under --contenders: jz and the jz lanes the classes
 *  time (jz-exact), the `n` fastest rivals of each claim class by the stored evidence,
 *  Porffor, and every selected lane no claim ranks (jz's own native lanes, the reference
 *  C). A rival with no timed row for the case cannot be ranked and waits for a full
 *  refresh, unless its class has no timed row at all (a case new to the corpus): a class
 *  the evidence cannot rank measures every one of its lanes. `lanes` is the selection
 *  (every lane when null), so a rival absent from it is neither ranked nor measured. */
const BASES = ['jz', ...Object.values(CLASS_BASE)]
const RANKED = new Set([...BASES, ...CLAIM_RIVALS, ...FAST_RIVALS, ...JIT_RIVALS, 'porf-native'])
export const contenders = (caseEvidence, n, lanes = null) => {
  const rows = caseEvidence?.targets ?? {}
  const fastest = rivals => {
    const here = rivals.filter(r => !lanes || lanes.includes(r)), timed = here.filter(r => timedBenchmarkRow(rows[r]))
    return timed.length ? timed.sort((a, b) => rows[a].medianUs - rows[b].medianUs).slice(0, n) : here
  }
  return [...new Set([...BASES.filter(b => b === 'jz' || !lanes || lanes.includes(b)),
    ...CLAIM_CLASSES.flatMap(([, rivals]) => fastest(rivals)), ...fastest(['porf-native']),
    ...(lanes ?? []).filter(l => !RANKED.has(l))])]
}
