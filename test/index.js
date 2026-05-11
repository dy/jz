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
  'methods',
  'features',
  'feature-gating',
  'strings',
  'symbols',
  'rest-params',
  'spread',
  'number-methods',
  'json',
  'date',
  'wasi',
  'mem',
  'buffer',
  'regex',
  'simd',
  'cli',
  'object-regressions',
  'external',
  'watr',
  'optimizer',
  'perf',
  'timers',
  'test262-regressions',
  'semantic-invariants',
]

const argFilters = process.argv.slice(2)
  .filter(arg => !arg.startsWith('-'))
  .map(arg => arg.replace(/^test\//, '').replace(/\.js$/, ''))

const selected = argFilters.length
  ? TESTS.filter(name => argFilters.includes(name))
  : TESTS

if (argFilters.length && selected.length !== argFilters.length) {
  const known = new Set(TESTS)
  const missing = argFilters.filter(name => !known.has(name))
  throw new Error(`Unknown test file(s): ${missing.join(', ')}`)
}

for (const name of selected) await import(`./${name}.js`)
