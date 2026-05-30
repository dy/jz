const TESTS = [
  'errors',
  'math',
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
  'mem',
  'buffer',
  'regex',
  'simd',
  'cli',
  'objects',
  'interop',
  'external',
  'watr',
  'optimizer',
  'inference',
  'unsigned',
  'perf',
  'timers',
  'invariants',
  'differential',
  'fuzz',
  'determinism',
  'parser-bugs',
  'jsstring',
  'booleans',
  'warnings',
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
const KERNEL_EXCLUDE = new Set(['imports', 'external', 'cli', 'timers', 'wasi', 'watr', 'warnings'])
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

for (const name of selected) await import(`./${name}.js`)
