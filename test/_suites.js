import { positiveInteger } from '../scripts/test-tasks.mjs'

// A file has one owner. The full gate runs every owner; the core matrix never
// starts a bootstrap build or a generated population sweep implicitly.
const bootstrap = new Set(['self-compile', 'self-checkpoint', 'kernel-parity', 'kernel-oracle'])
const generated = new Set(['fuzz', 'wat-invariants', 'perf-ratchet', 'spellings', 'data-forms', 'vector-coverage', 'vector-dependence', 'boxed-counters-population', 'rules-population', 'try-population', 'finalizer-population', 'reentry-population', 'uint-loops-population', 'bound-wrap-population', 'uint-division-population', 'counter-widths-population', 'vector-alias-population', 'vector-order-population', 'vector-narrow-population', 'alias-fuzz-population', 'box-tier-population', 'box-population', 'box-forms-population', 'box-probe-population', 'bound-tier-population', 'float-reduction-population', 'view-order-population', 'lane-convert-population', 'handler-population', 'reset-population', 'map-population', 'start-population', 'store-population', 'durable-join-population', 'elem-population', 'single-compare-population', 'record-lanes-population', 'plain-lift-population', 'float-order-population', 'licm-population', 'constant-reads-population', 'compare-population', 'compact-stress', 'limits'])
const integration = new Set([
  'pmath', 'watr', 'examples', 'refactor-oracle', 'reachability-mutants',
  'web-smoke', 'site', 'guide', 'headline', 'cli', 'bench-build',
  'bench-c', 'native-lowering', 'bench-porffor', 'bench-perry', 'bench-competitors', 'bench-memory', 'bench-svg', 'bench-shards',
])
export const SUITES = ['core', 'integration', 'generated', 'bootstrap']
export const suiteOf = name => bootstrap.has(name) ? 'bootstrap' : generated.has(name) ? 'generated' : integration.has(name) ? 'integration' : 'core'
// The quick tier (`--suite=quick`, npm run test:quick), what a writer runs after every
// edit: core files only, owned there, a cheap one or two for each subject of the
// compiler, the determinism and pass-table gates, and the cheapest pins of each family
// of passes. test/test-infrastructure.js holds it to 600 CPU seconds on the default
// leg's row of test/native-costs.json, under two minutes at 8 jobs.
export const QUICK = new Set([
  // the gates: one compile a source, the passes' order and registry
  'determinism', 'session-reentrancy', 'node-keys', 'pass-table', 'passes',
  // parse, rejections, jzify (classes, arguments, async and generators), prepare
  'parse-list', 'shift-precedence', 'identifiers', 'error-location',
  'definite-init', 'rest-params', 'conditional-spread', 'async-factory',
  'normalize', 'preeval', 'fn-alias', 'builtin-globals',
  // compile: plan, analyze, narrow, emit
  'inline-args', 'inline-hoist', 'inline-cycles', 'constants', 'lanes', 'held-number', 'unread-globals', 'offset-bound', 'loop-invariants', 'scalar-unroll', 'unswitch-loops', 'reciprocal-loops', 'object-reads',
  'const-seed', 'variant-result', 'guarded-clone', 'bigint-boundary',
  'multi-return', 'pointers', 'number-or-missing', 'number-eq', 'unknown-sum', 'index-key', 'remainder',
  // (a string the runtime makes: a wrong constant in toUpperCase's kernel fails it, and no other file here)
  'mixed-read',
  'scalar-record', 'tag-literals', 'chosen-calls', 'iterate-present',
  // summary, type, kind
  'summary-keys', 'absent-member', 'element-numbers', 'param-range', 'flow-range', 'loop-square', 'kind-tests',
  // link, the tape, assemble and the stdlib pull, the ABI and the host boundary, layout
  'tape', 'source-map', 'runtime-inspect', 'eager-stdlib-parity', 'self-compile-includes',
  'abi', 'array-holes-interop', 'layout-kinds', 'elem-heads',
  // module/ (the runtime) and the memory plans
  'math-entry', 'math-ulp', 'pow-int', 'typed-copy', 'length-words', 'held-regex', 'date', 'workers',
  'fixed-memory', 'static-storage', 'growth', 'snapshot', 'feature-gating',
  // wrong-code corpora against Node
  'differential', 'self-families',
  // one or more pins a family of passes: rules, LICM, narrowing, loads and stores, branches,
  // the speed tier's, inlining, versioning, unrolling, devirtualization, representation,
  // canons, vector lifts, watr's tail
  'rules', 'address', 'licm-typed-views', 'hoist-loop-global', 'int-narrow', 'numbering', 'forward-store', 'static-scratch', 'store-merge', 'still-loads',
  'optimizer-branches', 'select-order', 'pair-tests', 'skip-latches', 'extreme-guards', 'carry-stores', 'share-quotients', 'shift-remainder',
  'inline-tiny', 'specialize', 'wide-accumulator', 'unroll-cost', 'optimizer-unroll', 'dyn-closure-tables', 'optimizer-promote', 'slot-hazards', 'optimizer-nan-canon',
  'slp', 'cond-vectorize', 'simd-intrinsics', 'schedule', 'lazy-select',
])
export const inSuite = (name, suite) => suite === 'all' || (suite === 'quick' ? QUICK.has(name) : suiteOf(name) === suite)
// A core or generated file compiles in its own process and leaves nothing behind,
// so a run of them may be split over processes. An integration or bootstrap file
// builds what a later one reads (web-smoke's bundle for guide): their order and
// their one process are part of the test.
export const splits = suite => suite === 'core' || suite === 'generated' || suite === 'quick'

export function suiteArgs(args, kernel = false) {
  let suite = kernel ? 'all' : 'core', list = false, costs = false, seen = false, jobs, slice
  const files = []
  for (const arg of args) {
    if (arg === '--list') list = true
    else if (arg === '--costs') costs = true
    else if (arg.startsWith('--slice=')) {
      const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(arg.slice(8))
      if (slice || !m || +m[1] > +m[2]) throw new Error(`--slice=<i>/<n>, once, with i from 1 to n, not '${arg}'`)
      slice = [+m[1], +m[2]]
    }
    else if (arg.startsWith('--jobs=')) {
      if (jobs != null) throw new Error('--jobs may be specified only once')
      jobs = positiveInteger(arg.slice(7), '--jobs')
    }
    else if (arg.startsWith('--suite=')) {
      if (seen) throw new Error('--suite may be specified only once')
      seen = true
      suite = arg.slice(8)
      if (suite !== 'all' && suite !== 'quick' && !SUITES.includes(suite)) throw new Error(`Unknown suite '${suite}'; use ${[...SUITES, 'quick', 'all'].join(', ')}`)
    } else if (arg.startsWith('-')) throw new Error(`Unknown test argument '${arg}'`)
    else files.push(arg.replace(/^test\//, '').replace(/\.js$/, ''))
  }
  if (new Set(files).size !== files.length) throw new Error('A test file was selected more than once')
  return { suite, list, files, jobs, costs, slice }
}
