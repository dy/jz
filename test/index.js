const TESTS = [
  'errors',
  'math',
  'simd-intrinsics',
  'bytebeat',
  'imports',
  'statements',
  'multi-return',
  'types',
  'pointers',
  'data',
  'destruct',
  'closures',
  'classes',
  'array-methods',
  'features',
  'feature-gating',
  'strings',
  'symbols',
  'rest-params',
  'spread',
  'number',
  'json',
  'date',
  'wasi',
  'web-smoke',
  'webglobals',
  'snapshot',
  'mem',
  'buffer',
  'workers',
  'generators',
  'async',
  'regex',
  'simd',
  'cli',
  'objects',
  'conditional-spread',
  'dyn-keys',
  'interop',
  'abi',
  'external',
  'watr',
  'optimizer',
  'passes',
  'dyn-closure-tables',
  'preeval',
  'inference',
  'provenance-inference',
  'speculate',
  'unsigned',
  'perf',
  'timers',
  'invariants',
  'layout-kinds',
  'pow-ulp',
  'pow-fold-ulp',
  'fifthroot-ulp',
  'wat-invariants',
  'loop-square',
  'inplace-store',
  'slot-hazards',
  'never-grown',
  'bool-identity',
  'abrupt-oob',
  'hoist-loop-global',
  'iteration',
  'slp',
  'cond-vectorize',
  'unswitch-typed-param',
  'differential',
  'fuzz',
  'determinism',
  'session-reentrancy',
  'grid-current',
  'perf-ratchet',
  'parser-bugs',
  'transform',
  'self-compile-source',
  'self-compile-includes',
  'jsstring',
  'booleans',
  'warnings',
  'forin-deopt',
  'deopt',
  'minimal-output',
  'bench-svg',
  'bench-c',
  'native-lowering',
  'kernel-parity',
  'kernel-oracle',
  'headline',
  'examples',
]

const argFilters = process.argv.slice(2)
  .filter(arg => !arg.startsWith('-'))
  .map(arg => arg.replace(/^test\//, '').replace(/\.js$/, ''))

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
//   - self-compile-source: a host-side scan of the self-compile kernel's own source for
//     labeled-statement misparses. Reads src via parse/jzify directly, never the
//     compiler-under-test, so the kernel leg would only re-run it identically.
//
// KERNEL-LEG DEBT (2026-07-15 per-file bisect, scratchpad/kernel-bisect.mjs —
// each entry is a RECORDED kernel bug or leg-mismatch, not a permanent skip;
// burn the list down as the kernel fixes land, re-including each file):
//   HANGS (in-kernel infinite loop, 420 s fence): errors, parser-bugs,
//     transform — one nonterminating compile each; needs in-file bisection
//     before per-test guards are possible. (generators/async cleared
//     2026-07-25 — see the dated notes below the list.)
//   Module-resolver class (kernel takes one AST, no host resolver — same as
//     `watr` above, per-test onKernel guards pending): destruct, closures,
//     inference.
//   Optimizer-shape class (kernel runs optimize:false; shape asserts can't
//     match — same as perf-ratchet above): simd, optimizer, never-grown,
//     slot-hazards.
//   (2026-07-25: no remaining recorded kernel VALUE bugs in this list — the
//   json shaped-parser asserts cleared with the elemOrigin fix; what's left
//   above is hang-bisection debt and leg-mismatch classes, not value bugs.)
const KERNEL_EXCLUDE = new Set(['imports', 'external', 'cli', 'web-smoke', 'snapshot', 'timers', 'wasi', 'watr', 'warnings', 'perf-ratchet', 'unswitch-typed-param', 'bench-c', 'native-lowering', 'kernel-parity', 'kernel-oracle',
  // never-grown: value-correct in-kernel; ONE structural assert (raw-base WAT
  // shape) is an optimization-parity gap like unswitch — re-excluded 2026-07-22
  'never-grown',
  'self-compile-source', 'self-compile-includes', 'abi', 'examples',
  'transform',   // 'features' cleared 2026-07-23: 49/49 green once the kernel parsed literal-key shorthand methods (SKM family fix)
  // 'errors','parser-bugs','destruct','closures','json' UN-EXCLUDED FOR GOOD
  // 2026-07-27: the frontier hunt fixed two of the three order-shifted rows
  // (Array.isArray-as-value closure-support + bool-identity closure-ABI Bad
  // int) — full kernel leg with these five in is baseline-clean.
  // 'inference' cleared 2026-07-28: the census row was never order-dependent —
  // `new Set(undefined)` threw the __iter_arr for-of TypeError when the
  // compiler ran self-compiled (prepare's own `new Set(skip)`); the Set
  // constructor is now spec-correct (nullish iterable → empty set,
  // __iter_arr_ctor) and the whole exclusions burn-down is COMPLETE.
  'simd', 'optimizer', 'slot-hazards',
  // 'objects','strings','spread' cleared 2026-07-23: reassigned-param val
  // poisoning fixed the Array.isArray const-fold class (analyze.js declared-
  // guard) — 14 kernel value bugs cleared in one fix; json keeps 2 structural
  // shaped-parser-selection asserts (parity gap, not value bugs).
  ])  // 'speculate' cleared 2026-07-23: narrowed-param versioning-guard fix
  // 'async','generators' cleared 2026-07-25: two roots — (1) closure-path boxed
  // cells now allocate before body emission (mutually-recursive const arrows no
  // longer capture stale null cells; every machine compiled hollow before);
  // (2) asI32 wraps mod 2^32 per ES ToInt32 (bare trunc_sat saturated
  // negative-f64 hi-words → static completion objects read null).
  // 'statements','data','preeval' cleared 2026-07-24: bigint-carrier fold
  // guards (numLiteralNode zero-exemption, WIDE_BIGINT rational-carry gate,
  // structural subnormal fold guards in prepare/pre-eval/emitNeg); the one
  // deep-carrier row (-1n<0n at O2, watr-in-kernel dynamic-compare) is
  // onKernel-curated in statements.js with the mechanism.
  // 'pow-fold-ulp','fifthroot-ulp' cleared 2026-07-24: three stacked kernel gaps
  // peeled in powResolvePool — regex ctrl-char pattern escapes (→ manual scan),
  // startsWith positional arg dropped (→ slice-compare), obj[numVar] object
  // read (→ dense arrays for type/lastUse/regOf).
const onKernelTarget = process.env.JZ_TEST_TARGET === 'jz.wasm'

const selected = (argFilters.length
  ? TESTS.filter(name => argFilters.includes(name))
  : TESTS
).filter(name => !(onKernelTarget && !argFilters.includes(name) && KERNEL_EXCLUDE.has(name)))

if (argFilters.length && selected.length !== argFilters.length) {
  const known = new Set(TESTS)
  const missing = argFilters.filter(name => !known.has(name))
  throw new Error(`Unknown test file(s): ${missing.join(', ')}`)
}

// JZ_TEST_TARGET=jz.wasm — run the whole suite against the self-compiled jz.wasm
// kernel instead of the in-process compiler. Set the target BEFORE importing any
// test file (they import jz from ../index.js — the same module singleton).
if (process.env.JZ_TEST_TARGET === 'jz.wasm') {
  const [{ _setCompileTarget }, { compileViaKernel }] = await Promise.all([
    import('../index.js'), import('./kernel-target.js'),
  ])
  _setCompileTarget(compileViaKernel)
}

// Full GC between test files. Every test instantiates fresh wasm modules whose
// Memory lives OUTSIDE the JS heap — thousands of dead instances add ~zero GC
// pressure (the JS heap stays small, major GC never fires) and the suite's RSS
// balloons to tens of GB before the process exits. A forced collection after
// each file frees the previous file's instances and returns their memories to
// the OS, bounding RSS to roughly one file's working set. --expose-gc is
// enabled from inside (v8 flag + a scratch context) so npm scripts stay flag-free.
import v8 from 'node:v8'
import vm from 'node:vm'
v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc')
v8.setFlagsFromString('--no-expose-gc')

for (const name of selected) { await import(`./${name}.js`); gc() }
