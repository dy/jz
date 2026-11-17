import { runFiles } from './_run.js'

const TESTS = [
  'runner',
  'test-infrastructure',
  'bench-build',
  'errors',
  'source-map',
  'error-location',
  'identifiers',
  'to-primitive',
  'property-order',
  'math',
  'pmath',
  'stdlib-kernels',
  'math-ulp',
  'math-entry',
  'simd-intrinsics',
  'bytebeat',
  'floatbeat',
  'imports',
  'dynamic-import',
  'resolve',
  'statements',
  'multi-return',
  'types',
  'pointers',
  'data',
  'destruct',
  'closures',
  'function-props',
  'classes',
  'class-members',
  'method-receivers',
  'array-methods',
  'array-holes',
  'numeric-arrays',
  'features',
  'feature-gating',
  'strings',
  'missing-plus',
  'symbols',
  'rest-params',
  'spread',
  'object-rest',
  'member-targets',
  'number',
  'unknown-sum',
  'builtin-globals',
  'json',
  'date',
  'wasi',
  'web-smoke',
  'site',
  'guide',
  'webglobals',
  'std',
  'snapshot',
  'static-storage',
  'fixed-memory',
  'mem',
  'allocation',
  'frame-effects',
  'value-number',
  'schedule',
  'lazy-select',
  'split-funcs',
  'inline-tiny',
  'lanes',
  'buffer',
  'resizable-buffer',
  'host-globals',
  'host-classes',
  'websocket-server',
  'typed-ctors',
  'workers',
  'generators',
  'iterator-params',
  'async',
  'async-factory',
  'regex',
  'simd',
  'cli',
  'options',
  'objects',
  'js-parity',
  'conditional-spread',
  'dyn-keys',
  'interop',
  'array-holes-interop',
  'abi',
  'external',
  'watr',
  'optimizer-words',
  'optimizer-licm',
  'optimizer-unroll',
  'optimizer-devirt',
  'optimizer-promote',
  'optimizer-induction',
  'optimizer-passes',
  'optimizer-inline',
  'optimizer-branches',
  'optimizer-versioning',
  'optimizer-word-numbers',
  'optimizer-nan-canon',
  'optimizer-schedule',
  'optimizer-cursors',
  'optimizer-typed-bounds',
  'optimizer-array-reads',
  'optimizer-array-bounds',
  'tape',
  'summary',
  'summary-queries',
  'summary-keys',
  'bigint-boundary',
  'reachability',
  'reachability-mutants',
  'self-families',
  'interval-proof',
  'element-bounds',
  'licm-typed-views',
  'licm-float32',
  'licm-loop-bounds',
  'flow-range',
  'store-merge',
  'const-seed',
  'guarded-update',
  'quantize',
  'prefilter',
  'present-init',
  'missing-arith',
  'super-order',
  'definite-init',
  'missing-read',
  'throwing-read',
  'number-or-missing',
  'typed-fill',
  'typed-copy',
  'typed-sort',
  'typed-length',
  'length-words',
  'declare-unseen-keys',
  'integral-loops',
  'boxed-counters',
  'rules',
  'index-words',
  'buffer-alias',
  'unswitch-loops',
  'reciprocal-loops',
  'single-compare',
  'record-lanes',
  'nullable-arrays',
  'chosen-calls',
  'loop-fields',
  'absent-member',
  'mixed-read',
  'literal-digits',
  'called-args',
  'object-reads',
  'kind-split',
  'remainder',
  'elem-heads',
  'offset-bound',
  'select-order',
  'pointer-join',
  'union-kinds',
  'captured-counters',
  'typed-rebound',
  'late-field',
  'index-key',
  'primitive-store',
  'num-shadow',
  'guarded-clone',
  'host-closure',
  'typed-any-view',
  'kind-tests',
  'advanced-index',
  'variant-result',
  'call-boundary',
  'call-release',
  'compact',
  'typed-payload',
  'typed-decode',
  'typed-store',
  'typed-wide-index',
  'index-width',
  'counter-width',
  'shift-precedence',
  'loop-step',
  'normalize',
  'field-cse',
  'tag-literals',
  'scalar-record',
  'array-load-cse',
  'guarded-read',
  'shift-remainder',
  'scalar-unroll',
  'fixed-length',
  'element-numbers',
  'definite-assign',
  'number-eq',
  'index-store',
  'array-scan',
  'present-receiver',
  'block-present',
  'header-hoist',
  'iterate-present',
  'param-range',
  'typed-present',
  'fn-alias',
  'forward-store',
  'mem-alias',
  'address',
  'static-scratch',
  'static-locals',
  'iteration-release',
  'held-number',
  'split-bindings',
  'module-scratch',
  'unread-globals',
  'parse-list',
  'alias',
  'float32',
  'constants',
  'splice',
  'loop-invariants',
  'held-method',
  'held-regex',
  'unroll-cost',
  'sentinel-guard',
  'twin-locals',
  'carry-elements',
  'carry-stores',
  'sink-stores',
  'share-quotients',
  'skip-latches',
  'extreme-guards',
  'relaxed-extremes',
  'exit-tests',
  'still-loads',
  'pair-tests',
  'carry-keys',
  'array-view',
  'param-defaults',
  'accessor-enumeration',
  'passes',
  'dyn-closure-tables',
  'preeval',
  'inference',
  'audit-regressions',
  'node-keys',
  'pass-table',
  'effects',
  'provenance-inference',
  'speculate',
  'unsigned',
  'word-locals',
  'tested-counter',
  'guard-views',
  'inline-pure-leaf',
  'inline-dispatch',
  'lean-dict',
  'int-narrow', 'numbering',
  'specialize', 'guards', 'inline-args', 'inline-hoist', 'inline-cycles', 'growth', 'push', 'forward-hops',
  'store-int32',
  'present-number',
  'sequence-values', 'bigint-division', 'bigint-tag',
  'perf',
  'timers',
  'invariants',
  'refactor-oracle',
  'layout-kinds',
  'struct-inline',
  'pow',
  'pow-base',
  'pow-int',
  'relaxed-float',
  'wat-invariants',
  'loop-square',
  'inplace-store',
  'slot-hazards',
  'never-grown',
  'abrupt-oob',
  'hoist-loop-global',
  'iteration',
  'slp',
  'cond-vectorize',
  'vector-legality',
  'loop-forms',
  'vector-dependence',
  'boxed-counters-population',
  'rules-population',
  'try-population',
  'finalizer-population',
  'reentry-population',
  'uint-loops-population',
  'bound-wrap-population',
  'uint-division-population',
  'counter-widths-population',
  'vector-alias-population',
  'vector-order-population',
  'vector-narrow-population',
  'alias-fuzz-population',
  'box-tier-population',
  'box-population',
  'box-forms-population',
  'box-probe-population',
  'bound-tier-population',
  'float-reduction-population',
  'single-compare-population',
  'compare-population',
  'record-lanes-population',
  'lane-convert-population',
  'view-order-population',
  'handler-population',
  'reset-population',
  'map-population',
  'start-population',
  'store-population',
  'durable-join-population',
  'elem-population',
  'plain-lift-population',
  'float-order-population',
  'licm-population',
  'constant-reads-population',
  'compact-stress',
  'unswitch-typed-param',
  'wide-accumulator',
  'runtime-inspect',
  'differential',
  'fuzz',
  'determinism',
  'session-reentrancy',
  'grid-current',
  'perf-ratchet',
  'spellings',
  'data-forms',
  'vector-coverage',
  'parser-bugs',
  'self-build',
  'kernel-gate',
  'kernel-marks',
  'self-checkpoint',
  'self-compile',
  'self-compile-source',
  'self-compile-includes',
  'eager-stdlib-parity',
  'jsstring',
  'booleans',
  'bool-number',
  'bool-null',
  'bigint-slots',
  'warnings',
  'deopt',
  'minimal-output',
  'bench-svg',
  'bench-shards',
  'bench-porffor',
  'bench-perry',
  'bench-competitors',
  'bench-memory',
  'bench-c',
  'native-lowering',
  'kernel-parity',
  'kernel-oracle',
  'headline',
  'examples',
]

import { statSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { cpus, loadavg } from 'node:os'
import { fileURLToPath } from 'node:url'
import { suiteArgs, suiteOf, splits } from './_suites.js'
import { shards } from './_jobs.js'
import { runTasks, suiteJobs, legOf } from '../scripts/test-tasks.mjs'
const { suite, list, files: argFilters, jobs: jobsArg, costs } = suiteArgs(process.argv.slice(2), process.env.JZ_TEST_TARGET === 'jz.wasm')
// A whole core or generated run may be split over processes; named files and a
// suite whose files share artifacts run in this one (test/_suites.js).
const splittable = !argFilters.length && splits(suite)
if (jobsArg != null && !splittable) throw new Error('--jobs splits a whole core or generated run; named files and the other suites run in one process')

// Files that are wholly host-bridge / host-runtime: their compile inputs depend
// on host options (imports/host globals, external js objects, CLI argv, host
// timers, multi-module graphs) or a different target (WASI command entry) that
// the jz.wasm kernel — which takes a single raw AST and owns compile internally —
// never receives. They cannot run on the self-compile leg by construction (not value
// miscompiles), and some throw uncaught (calling the real globalThis.fetch, or
// `Unknown module './src/compile.js'`) which would abort the run. Skip them under
// JZ_TEST_TARGET=jz.wasm so test:wasm is a clean signal of genuine self-compile
// correctness. Mixed files keep their per-test `onKernel()` guards instead.
//   - watr: compiles the watr WAT library, which is a multi-file module graph
//     (`import … from './src/compile.js'` etc.); the kernel takes one parsed AST
//     and has no host module resolver, so every case reports "Unknown module".
//   - warnings: every case asserts on the compile-time advisory channel
//     (`opts.warnings` Map / `inspect`), which the kernel — returning only IR —
//     never populates. Wholly metadata, not value behaviour; nothing to self-compile.
//   - perf-ratchet: a codegen-shape ratchet that compiles at optimize:2 and counts
//     loop-body ops vs a committed baseline. The kernel runs optimize:false (ignores
//     the level), so its op counts don't match the baseline — and it's not a value
//     test anyway. Excluded; the in-process leg owns it.
//   - spellings: loop-body op counts and SIMD presence per loop spelling at level 2
//     and 'speed' against a committed table; excluded for perf-ratchet's reason.
//   - data-forms: the same counts per form a program holds its data in, against a
//     committed table; excluded for the same reason.
//   - vector-coverage: SIMD presence per alias-battery loop at level 2 and 'speed'
//     against a committed table; excluded for the same reason.
//   - self-compile-source: a host-side scan of the self-compile kernel's own source for
//     labeled-statement misparses. Reads src via parse/jzify directly, never the
//     compiler-under-test, so the kernel leg would only re-run it identically.
//
// Optimizer-shape class (kernel runs optimize:false; shape asserts can't match
// — same as perf-ratchet above): simd, optimizer-*, never-grown, slot-hazards.
const KERNEL_EXCLUDE = new Set(['imports', 'external', 'cli', 'options', 'web-smoke', 'snapshot', 'timers', 'wasi', 'watr', 'warnings', 'perf-ratchet', 'spellings', 'data-forms', 'vector-coverage', 'unswitch-typed-param', 'bench-c', 'native-lowering', 'kernel-parity', 'kernel-oracle',
  'runner', 'bench-build', 'source-map', // JS entry/CLI options and debug metadata are outside the kernel ABI
  'guide', // runs the guide's examples against the browser bundle web-smoke builds, not the kernel
  // never-grown: value-correct in-kernel; ONE structural assert (raw-base WAT
  // shape) is an optimization-parity gap like unswitch — re-excluded 2026-07-22
  'never-grown',
  'self-compile-source', 'self-compile-includes', 'self-checkpoint', 'abi', 'examples', 'bench-porffor', 'bench-perry', 'bench-competitors', 'bench-memory',
  'pass-table', // the optimizer's order as data, read in the host: the kernel leg would run it again unchanged
  'effects', // the effects summary and the passes that ask it, called in the host on hand-written IR
  'eager-stdlib-parity', 'refactor-oracle',   // native harnesses: opts._eagerStdlib passthrough and scripts/refactor-oracle.mjs drive the Node compile() directly
  'simd', 'slot-hazards', 'struct-inline',
  'optimizer-words', 'optimizer-licm', 'optimizer-unroll', 'optimizer-devirt', 'optimizer-promote', 'optimizer-induction', 'optimizer-passes', 'optimizer-inline', 'optimizer-branches', 'optimizer-versioning', 'optimizer-word-numbers', 'optimizer-nan-canon', 'optimizer-schedule', 'optimizer-cursors', 'optimizer-typed-bounds', 'optimizer-array-reads', 'optimizer-array-bounds',
  ])
  // Files whose compile inputs are the same on every leg — measured, not assumed: each was run
  // under the default, opt0, opt3 and wasi legs with every in-process compile hashed (source
  // plus the options after the env defaults merge), and the four hash sets were identical.
  // They build the kernel, spawn tooling, or pass every option themselves, so a leg cannot
  // change what they test: the default leg owns them and the opt0/opt3/wasi legs skip them
  // (about 6 minutes a leg). Naming a file on the command line runs it on any leg.
const LEG_INVARIANT = new Set([
  'runner', 'test-infrastructure', // host test-runner lifecycle; no compiler inputs
  'bench-build', // fixed host and size options, CLI subprocess
  'source-map', // fixed debug build, V8 debugger and CLI in the JS host
  'pmath', // the benchmark's fixed JS host and speed build on every leg
  'self-checkpoint', 'self-build', 'self-compile-source', 'kernel-marks', 'eager-stdlib-parity',
  'reachability-mutants', 'bench-c', 'bench-porffor', 'bench-perry', 'bench-competitors', 'bench-memory', 'bench-svg', 'bench-shards', 'cli', 'native-lowering',
  'headline', 'site', 'guide', 'web-smoke',
])
// Files that choose their own optimize levels (an explicit `optimize` on every
// compile; fuzz and wat-invariants sweep {0,1,2,3} themselves) but compile under the
// leg's host: the opt0/opt3 legs skip them, the wasi leg keeps them.
const OPT_INVARIANT = new Set(['fuzz', 'wat-invariants', 'kernel-gate', 'perf-ratchet', 'spellings', 'data-forms', 'vector-coverage', 'refactor-oracle', 'self-compile-includes', 'snapshot', 'vector-dependence'])
const onOptLeg = process.env.JZ_TEST_OPTIMIZE != null, onHostLeg = !!process.env.JZ_TEST_HOST
const legSkips = (name) => (onOptLeg && (LEG_INVARIANT.has(name) || OPT_INVARIANT.has(name))) || (onHostLeg && LEG_INVARIANT.has(name))

const target = process.env.JZ_TEST_TARGET
if (target && target !== 'jz.wasm') throw new Error(`Unknown JZ_TEST_TARGET '${target}'; use jz.wasm and set JZ_KERNEL to the compiler file`)
const onKernelTarget = target === 'jz.wasm'

const selected = (argFilters.length
  ? TESTS.filter(name => argFilters.includes(name))
  : TESTS.filter(name => suite === 'all' || suiteOf(name) === suite)
).filter(name => argFilters.includes(name) || !((onKernelTarget && (KERNEL_EXCLUDE.has(name) || suiteOf(name) === 'bootstrap' || name === 'test-infrastructure')) || legSkips(name)))

if (argFilters.length && selected.length !== argFilters.length) {
  const known = new Set(TESTS)
  const missing = argFilters.filter(name => !known.has(name))
  throw new Error(`Unknown test file(s): ${missing.join(', ')}`)
}

// test/native-costs.json: each file's [CPU seconds, tests, assertions] by suite and leg.
// --costs times every file of this run (test/_run.js): a run of named files prints the
// times, a whole suite writes them over its row once every file is timed, counting the
// tests that failed, and an ordinary run never writes.
const COSTS = new URL('./native-costs.json', import.meta.url), row = `${suite}-${legOf()}`, load = loadavg()[0]
if (costs && onKernelTarget) throw new Error('--costs times the native legs; the hosted suite has test/hosted-costs.json')
if (costs && process.env.TST_GREP) throw new Error('--costs times whole files; TST_GREP would time a part of each')

// Listing is side-effect free: do not load the compiler or any test fixtures.
if (list) { console.log(selected.join('\n')); process.exit(0) }

function record(times, failed, processes) {
  const missing = selected.filter(f => !times[f])
  if (missing.length) return console.error(`--costs: ${row} not written: no time for ${missing.join(', ')}`)
  const table = JSON.parse(readFileSync(COSTS, 'utf8')), files = {}
  for (const f of selected) files[f] = [Math.round(times[f][0] * 10) / 10, times[f][1], times[f][2]]
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).stdout?.trim() || 'an unknown commit'
  const measured = `${new Date().toISOString().slice(0, 10)} at ${commit} on ${cpus()[0]?.model}, ${processes === 1 ? 'one process' : `${processes} processes at a time`}, load average ${Math.round(load)} at the start and ${Math.round(loadavg()[0])} at the end${failed ? `, ${failed} test${failed > 1 ? 's' : ''} failed` : ''}`
  table.runs = Object.fromEntries(Object.entries({ ...table.runs, [row]: { measured, files } }).sort(([a], [b]) => a < b ? -1 : 1))
  writeFileSync(COSTS, JSON.stringify(table, null, 1).replace(/\[\n\s+([^\]]*?)\n\s+\]/g, (_, items) => `[${items.split(/,\n\s+/).join(', ')}]`) + '\n')
  console.log(`--costs: ${row} written: ${selected.length} files, ${Math.round(Object.values(files).reduce((sum, [s]) => sum + s, 0))} CPU seconds`)
}

// A splittable run spreads over the idle cores (scripts/test-tasks.mjs), or the count
// --jobs or JZ_TEST_JOBS names: each process takes a contiguous run of files,
// named to it, and runs them as below.
const jobs = splittable ? suiteJobs(jobsArg ?? (process.env.JZ_TEST_JOBS || undefined), selected.length) : 1
if (jobs > 1) {
  // A file's size stands in for its time, unknown before it runs. Three runs to a
  // process, the heaviest started first, so the light ones level the finish.
  const size = name => statSync(new URL(`./${name}.js`, import.meta.url)).size
  const runs = shards(selected, size, jobs * 3).map(files => ({ files, size: files.reduce((sum, f) => sum + size(f), 0) })).sort((a, b) => b.size - a.size)
  const results = await runTasks(runs.map(({ files }) => ({
    name: `${suite}-${files[0]}`, args: [fileURLToPath(import.meta.url), ...costs ? ['--costs'] : [], ...files], env: { JZ_TEST_JOBS: '1' },
  })), { jobs })
  // The totals are each run's last summary: a test may print a nested run's own.
  const totals = {}, times = {}
  for (const r of results) {
    const log = r.log ? readFileSync(r.log, 'utf8') : '', last = {}
    for (const [, key, n] of log.matchAll(/^# (\w+) (\d+)$/gm)) last[key] = Number(n)
    for (const key in last) totals[key] = (totals[key] || 0) + last[key]
    Object.assign(times, JSON.parse([...log.matchAll(/^# costs (.*)$/gm)].at(-1)?.[1] ?? '{}'))
  }
  console.log(Object.entries(totals).map(([key, n]) => `# ${key} ${n}`).join('\n'))
  if (costs) record(times, totals.fail || 0, jobs)
  process.exit(results.some(r => r.code) ? 1 : 0)
}

// JZ_TEST_TARGET=jz.wasm — run the whole suite against the self-compiled jz.wasm
// kernel instead of the in-process compiler. Set the target BEFORE importing any
// test file (their compiles all pass through src/compiler.js — the same module singleton).
if (onKernelTarget) {
  const [{ setCompileTarget }, { compileViaKernel }] = await Promise.all([
    import('../src/compiler.js'), import('./kernel-target.js'),
  ])
  setCompileTarget(compileViaKernel)
}

// The leg's defaults (JZ_TEST_OPTIMIZE, JZ_TEST_HOST, JZ_TEST_STRICT) for every
// in-process compile, installed before any test file compiles.
await import('./_env.js')
const result = await runFiles(selected.map(name => new URL(`./${name}.js`, import.meta.url).href), { costs })
if (costs) {
  const times = Object.fromEntries(selected.map((f, i) => [f, result.costs[i]]))
  if (argFilters.length) console.log(`# costs ${JSON.stringify(times)}`)
  else record(times, result.failed.length, 1)
}
process.exit(result.failed.length ? 1 : 0)
