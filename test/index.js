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
  'snapshot',
  'mem',
  'buffer',
  'workers',
  'regex',
  'simd',
  'cli',
  'objects',
  'interop',
  'abi',
  'external',
  'watr',
  'optimizer',
  'preeval',
  'inference',
  'provenance-inference',
  'speculate',
  'unsigned',
  'perf',
  'timers',
  'invariants',
  'pow-ulp',
  'wat-invariants',
  'loop-square',
  'inplace-store',
  'slot-hazards',
  'never-grown',
  'bool-identity',
  'hoist-loop-global',
  'iteration',
  'slp',
  'cond-vectorize',
  'unswitch-typed-param',
  'differential',
  'fuzz',
  'determinism',
  'grid-current',
  'perf-ratchet',
  'parser-bugs',
  'selfhost-source',
  'selfhost-includes',
  'jsstring',
  'booleans',
  'warnings',
  'forin-deopt',
  'deopt',
  'minimal-output',
  'bench-svg',
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
// never receives. They cannot run on the self-host leg by construction (not value
// miscompiles), and some throw uncaught (calling the real globalThis.fetch, or
// `Unknown module './src/compile.js'`) which would abort the run. Skip them under
// JZ_TEST_TARGET=jz.wasm so test:wasm is a clean signal of genuine self-host
// correctness. Mixed files keep their per-test `onKernel()` guards instead.
//   - watr: compiles the watr WAT library, which is a multi-file module graph
//     (`import … from './src/compile.js'` etc.); the kernel takes one parsed AST
//     and has no host module resolver, so every case reports "Unknown module".
//   - warnings: every case asserts on the compile-time advisory channel
//     (`opts.warnings` Map / `inspect`), which the kernel — returning only IR —
//     never populates. Wholly metadata, not value behaviour; nothing to self-host.
//   - perf-ratchet: a codegen-shape ratchet that compiles at optimize:2 and counts
//     loop-body ops vs a committed baseline. The kernel runs optimize:false (ignores
//     the level), so its op counts don't match the baseline — and it's not a value
//     test anyway. Excluded; the in-process leg owns it.
//   - selfhost-source: a host-side scan of the self-host kernel's own source for
//     labeled-statement misparses. Reads src via parse/jzify directly, never the
//     compiler-under-test, so the kernel leg would only re-run it identically.
const KERNEL_EXCLUDE = new Set(['imports', 'external', 'cli', 'web-smoke', 'snapshot', 'timers', 'wasi', 'watr', 'warnings', 'perf-ratchet', 'wat-invariants', 'loop-square', 'slp', 'cond-vectorize', 'unswitch-typed-param', 'selfhost-source', 'selfhost-includes', 'abi', 'examples'])
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

// JZ_TEST_TARGET=jz.wasm — run the whole suite against the self-hosted jz.wasm
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
