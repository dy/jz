// A file has one owner. The full gate runs every owner; the core matrix never
// starts a bootstrap build or a generated population sweep implicitly.
const bootstrap = new Set(['self-compile', 'self-checkpoint', 'kernel-parity', 'kernel-oracle'])
const generated = new Set(['fuzz', 'wat-invariants', 'perf-ratchet'])
const integration = new Set([
  'pmath', 'watr', 'examples', 'refactor-oracle', 'reachability-mutants',
  'web-smoke', 'site', 'guide', 'headline', 'cli', 'bench-build',
  'bench-c', 'native-lowering', 'bench-porffor', 'bench-perry', 'bench-competitors', 'bench-memory', 'bench-svg',
])
export const SUITES = ['core', 'integration', 'generated', 'bootstrap']
export const suiteOf = name => bootstrap.has(name) ? 'bootstrap' : generated.has(name) ? 'generated' : integration.has(name) ? 'integration' : 'core'

export function suiteArgs(args, kernel = false) {
  let suite = kernel ? 'all' : 'core', list = false, seen = false
  const files = []
  for (const arg of args) {
    if (arg === '--list') list = true
    else if (arg.startsWith('--suite=')) {
      if (seen) throw new Error('--suite may be specified only once')
      seen = true
      suite = arg.slice(8)
      if (suite !== 'all' && !SUITES.includes(suite)) throw new Error(`Unknown suite '${suite}'; use ${[...SUITES, 'all'].join(', ')}`)
    } else if (arg.startsWith('-')) throw new Error(`Unknown test argument '${arg}'`)
    else files.push(arg.replace(/^test\//, '').replace(/\.js$/, ''))
  }
  if (new Set(files).size !== files.length) throw new Error('A test file was selected more than once')
  return { suite, list, files }
}
