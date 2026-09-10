// Differential FUZZER — the seeded suite gate and the exploratory CLI over the
// generators in test/_fuzz.js: random programs from the jz subset, each run as plain
// JavaScript (ground truth, since "valid jz = valid JS") and as jz-compiled WASM at
// every optimize level, asserting the results agree. A disagreement is a miscompile;
// the run is deterministic (seeded) and self-shrinks the failing program to a
// minimal reproducer.
//
// Run modes:
//   node test/fuzz.js                      exploratory: 2000 random programs
//   node test/fuzz.js --count=20000        longer sweep
//   node test/fuzz.js --seed=12345         reproduce/diagnose one program (verbose)
//   node test/fuzz.js --opt=0,2 --inputs=40
//   npm test                               the seeded gate below (deterministic)
//
// @module test/fuzz
import test from 'tst'
import { ok } from 'tst/assert.js'
import {
  fuzz, fuzzTyped, fuzzTypedMap, fuzzTypedInt, fuzzTypedIntMinMax, fuzzTypedIVSR, fuzzTypedByteScan, fuzzLoopBound,
  check, report, DEFAULTS, genScalarProgram as genProgram, scalarSource as toSource,
} from './_fuzz.js'

// ─────────────────────────────────────────────────────────────────────────────
// Suite gate — deterministic, modest counts so `npm test` stays green + fast.
// Exploratory long runs go through the CLI below.
// ─────────────────────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`
// KNOWN-OPEN miscompiles the fuzzer already surfaced (seeds in the gate range).
// The gate is a RATCHET: it fails only on a *new* divergence, so `npm test` stays
// green while these are tracked, and any regression introduced by a code change
// trips immediately. Fixing a bug → delete its seed(s) here so the ratchet tightens.
// All known clusters fixed — the ratchet is now empty, so ANY divergence fails CI.
// History (fixed): `%` semantics (exact __rem); Math rounding elided after param
// reassign (intCertainMap seeds f64 params false); ToInt32 of large f64 (__toint32
// i64 bit-surgery); opt3 reassign-after-%0; opt2 ternary-in-return stack imbalance
// (watr branch-fold preserves block type); i32 arithmetic overflow at the int32
// boundary — a full-range bitwise/imul operand feeding `*`/`-`/unary-`-` now widens
// to f64 (isFullRangeI32; `+` stays i32 — the ToInt32-sunk accumulator op).
const KNOWN_OPEN = new Set([])
// JZ_FUZZ_GATE scales the gate seed counts (0 < scale ≤ 1). The kernel-target CI
// leg (JZ_TEST_TARGET=jz.wasm on a 2-core runner) compiles every fuzz program
// through the wasm kernel — full 200×4 alone exceeds GitHub's 6-hour job limit.
// Local runs and the native CI legs keep the full gate.
const GATE_SCALE = Math.min(1, Math.max(0.05, +process.env.JZ_FUZZ_GATE || 1))
const N = (n) => Math.max(5, Math.round(n * GATE_SCALE))
const GATE = { count: N(200), seedStart: 1, inputs: 12, inputSeed: 7, optLevels: [0, 1, 2, 3], cfg: DEFAULTS }
if (!isMain) {
  test('fuzz: no new miscompiles in seeds 1..200 × opt {0,1,2,3}', () => {
    const findings = fuzz(GATE)
    ok(findings.invalid === 0, `generator emitted ${findings.invalid} malformed programs — scope bug`)
    const fresh = findings.filter(f => !KNOWN_OPEN.has(f.seed))
    ok(fresh.length === 0, fresh.length
      ? `NEW miscompile(s) — a change regressed the compiler:\n\n${fresh.map(f => report(f, GATE)).join('\n\n')}`
      : `no regressions (${findings.length} known-open)`)
  })
  test('fuzz: Float64Array element ops match JS in seeds 1..100 × opt {0,1,2,3}', () => {
    const findings = fuzzTyped({ ...GATE, count: N(100) })
    ok(findings.length === 0, findings.length
      ? `typed-array divergence:\n\n${findings.map(f => `seed=${f.seed} ${f.kind}${f.idx != null ? ` idx=${f.idx}` : ''} jz=${f.got} js=${f.want}\n  ${f.src}`).join('\n\n')}`
      : 'jz Float64Array == JS')
  })
  test('fuzz: Float64Array pure-map (incl. ?:) matches JS in seeds 1..120 × opt {0,1,2,3}', () => {
    const findings = fuzzTypedMap({ ...GATE, count: N(120) })
    ok(findings.length === 0, findings.length
      ? `typed-map divergence:\n\n${findings.map(f => `seed=${f.seed} ${f.kind}${f.idx != null ? ` idx=${f.idx}` : ''} jz=${f.got} js=${f.want}\n  ${f.src}`).join('\n\n')}`
      : 'jz Float64Array map == JS')
  })
  test('fuzz: Int32Array map + i32 sum reduction matches JS in seeds 1..120 × opt {0,1,2,3}', () => {
    const findings = fuzzTypedInt({ ...GATE, count: N(120) })
    ok(findings.length === 0, findings.length
      ? `typed-int divergence:\n\n${findings.map(f => `seed=${f.seed} ${f.kind} jz=${f.got} js=${f.want}\n  ${f.src}`).join('\n\n')}`
      : 'jz Int32Array == JS')
  })
  test('fuzz: Int32Array min/max reduction matches JS in seeds 1..120 × opt {0,1,2,3}', () => {
    const findings = fuzzTypedIntMinMax({ ...GATE, count: N(120) })
    ok(findings.length === 0, findings.length
      ? `typed-int-minmax divergence:\n\n${findings.map(f => `seed=${f.seed} ${f.kind} jz=${f.got} js=${f.want}\n  ${f.src}`).join('\n\n')}`
      : 'jz Int32Array min/max == JS')
  })
  test('fuzz: Int32Array affine break/continue loop (IV strength reduction) matches JS', () => {
    const findings = fuzzTypedIVSR({ ...GATE, count: N(120) })
    ok(findings.length === 0, findings.length
      ? `typed-ivsr divergence:\n\n${findings.map(f => `seed=${f.seed} ${f.kind} jz=${f.got} js=${f.want}\n  ${f.src}`).join('\n\n')}`
      : 'jz IV-SR == JS')
  })
  test('fuzz: Uint8Array memchr byte scan (SIMD i8x16) matches JS in seeds 1..120 × opt {0,1,2,3}', () => {
    const findings = fuzzTypedByteScan({ ...GATE, count: N(120) })
    ok(findings.length === 0, findings.length
      ? `byte-scan divergence:\n\n${findings.map(f => `seed=${f.seed} ${f.kind} jz=${f.got} js=${f.want}\n  ${f.src}`).join('\n\n')}`
      : 'jz byte-scan == JS')
  })
  test('fuzz: param-bounded loops (narrowLoopBound vs NaN/±Inf/<=) match JS in seeds 1..120 × opt {0,1,2,3}', () => {
    const findings = fuzzLoopBound({ ...GATE, count: N(120) })
    ok(findings.length === 0, findings.length
      ? `loop-bound divergence:\n\n${findings.map(f => `seed=${f.seed} ${f.kind} args=[${f.args}] jz=${f.got} js=${f.want}\n  ${f.src}`).join('\n\n')}`
      : 'jz param-bound loops == JS')
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI.
// ─────────────────────────────────────────────────────────────────────────────
if (isMain) {
  const arg = (name, def) => {
    const m = process.argv.find(a => a.startsWith(`--${name}=`))
    return m ? m.slice(name.length + 3) : def
  }
  const optLevels = arg('opt', '0,1,2,3').split(',').map(Number)
  const single = arg('seed', null)
  const opts = {
    count: single != null ? 1 : Number(arg('count', 2000)),
    seedStart: single != null ? Number(single) : Number(arg('seedStart', 1)),
    inputs: Number(arg('inputs', 20)),
    inputSeed: Number(arg('inputSeed', 7)),
    optLevels, cfg: DEFAULTS, maxFindings: Number(arg('maxFindings', 20)),
  }
  if (process.argv.includes('--typed-int')) {
    // FUZZ-1: Int32Array map + i32 sum reduction (exercises (i32±i32)|0 fold), jz vs JS.
    const t0 = performance.now()
    const findings = fuzzTypedInt(opts)
    console.log(`fuzzed ${opts.count} typed-int programs (seeds ${opts.seedStart}..${opts.seedStart + opts.count - 1}), opt {${optLevels}} — ${(performance.now() - t0).toFixed(0)}ms`)
    if (!findings.length) console.log('✓ no divergence — jz Int32Array == JS for every program')
    else {
      console.log(`✗ ${findings.length} finding(s):\n`)
      for (const f of findings) console.log(`seed=${f.seed} kind=${f.kind}${f.opt != null ? ` opt=${f.opt}` : ''}\n  jz=${f.got} js=${f.want}${f.err ? ` err=${f.err}` : ''}\n  ${f.src}\n`)
      process.exit(1)
    }
  } else if (process.argv.includes('--typed-map')) {
    // FUZZ-1: pure Float64Array element map (vectorizes), jz vs JS, element-wise.
    const t0 = performance.now()
    const findings = fuzzTypedMap(opts)
    console.log(`fuzzed ${opts.count} typed-map programs (seeds ${opts.seedStart}..${opts.seedStart + opts.count - 1}), opt {${optLevels}} — ${(performance.now() - t0).toFixed(0)}ms`)
    if (!findings.length) console.log('✓ no divergence — jz Float64Array map == JS for every program')
    else {
      console.log(`✗ ${findings.length} finding(s):\n`)
      for (const f of findings) console.log(`seed=${f.seed} kind=${f.kind}${f.opt != null ? ` opt=${f.opt}` : ''}${f.idx != null ? ` idx=${f.idx}` : ''}\n  jz=${f.got} js=${f.want}${f.err ? ` err=${f.err}` : ''}\n  ${f.src}\n`)
      process.exit(1)
    }
  } else if (process.argv.includes('--typed')) {
    // FUZZ-1: Float64Array element read/write/loop/reduce, jz vs JS.
    const t0 = performance.now()
    const findings = fuzzTyped(opts)
    console.log(`fuzzed ${opts.count} typed-array programs (seeds ${opts.seedStart}..${opts.seedStart + opts.count - 1}), opt {${optLevels}} — ${(performance.now() - t0).toFixed(0)}ms`)
    if (!findings.length) console.log('✓ no divergence — jz Float64Array == JS for every program')
    else {
      console.log(`✗ ${findings.length} finding(s):\n`)
      for (const f of findings) console.log(`seed=${f.seed} kind=${f.kind}${f.opt != null ? ` opt=${f.opt}` : ''}${f.idx != null ? ` idx=${f.idx}` : ''}\n  jz=${f.got} js=${f.want}${f.err ? ` err=${f.err}` : ''}\n  ${f.src}\n`)
      process.exit(1)
    }
  } else if (single != null) {
    const prog = genProgram(Number(single), opts.cfg)
    console.log(toSource(prog))
    const r = check(prog, opts)
    console.log(r ? `DIVERGENCE:\n${report({ seed: Number(single), ...r, prog }, opts)}` : 'ok — matches JS at all opt levels')
  } else {
    const t0 = performance.now()
    const findings = fuzz(opts)
    const ms = performance.now() - t0
    const st = findings.stats
    console.log(`fuzzed ${opts.count} programs (seeds ${opts.seedStart}..${opts.seedStart + opts.count - 1}), opt {${optLevels}}, ${opts.inputs} inputs each — ${ms.toFixed(0)}ms${findings.invalid ? `  (${findings.invalid} malformed — generator scope bug!)` : ''}`)
    console.log(`  inputs: ${st.compared} compared, ${st.skipped} skipped (i32 contract exceeded), ${st.nonNumeric} non-numeric`)
    if (!findings.length) console.log('✓ no divergence — jz wasm == JS for every program at every opt level')
    else {
      console.log(`✗ ${findings.length} finding(s):\n`)
      for (const f of findings) console.log(report(f, opts) + '\n')
      process.exit(1)
    }
  }
}
