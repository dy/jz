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
// timers) or a different target (WASI command entry) that the jz.wasm kernel —
// which takes a raw AST and owns compile internally — never receives. They
// cannot run on the self-host leg by construction (not value miscompiles), and
// some throw uncaught (calling the real globalThis.fetch) which would abort the
// run. Skip them under JZ_TEST_TARGET=jz.wasm so test:wasm is a clean signal of
// genuine self-host correctness. Mixed files keep their per-test `onKernel()`
// guards instead.
const KERNEL_EXCLUDE = new Set(['imports', 'external', 'cli', 'timers', 'wasi'])
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
