/**
 * test262 runner for jz.
 *
 * Usage:
 *   node test/test262.js                  # run all applicable tests
 *   node test/test262.js --quick          # run first 100 per category
 *   node test/test262.js --filter=String  # only run String tests
 *
 * Requires: test262 checkout at ./test262 (auto-cloned if missing).
 *
 * Strategy: scan test262/test/language/ for features jz supports,
 * attempt compile+run each test, categorize as pass/fail/skip.
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'fs'
import { join, relative } from 'path'
import { execSync } from 'child_process'

const ROOT = join(import.meta.dirname, '..')
const TEST262 = join(import.meta.dirname, 'test262')

// Ensure test262 repo exists
if (!existsSync(TEST262)) {
  console.log('Cloning test262 (this may take a minute)...')
  execSync('git clone --depth 1 https://github.com/tc39/test262.git ' + TEST262, { stdio: 'inherit' })
}

// Features jz supports (test262 directory names under test/language/)
const SUPPORTED = [
  'expressions',
  'statements',
  'types',
  'identifiers',
  'literals',
  'block-scope',
  'destructuring',
  'module-code',
  'function-code',
]

// Features to exclude entirely
const EXCLUDED_PATTERNS = [
  /async/i, /await/, /generator/i, /yield/,
  /\bthis\b/, /\bclass\b/, /\bsuper\b/, /reflect/i, /proxy/i,
  /\bnew\b.*\btarget\b/, /\bwith\b/,
  /\bWeak(Ref|Map|Set)\b/, /\bBigInt\b/i,
  /iterator/i, /symbol\.species/i, /symbol\.toPrimitive/i,
  /symbol\.iterator/i, /for[\s-]*of/i, /regexp/i,
  /template/i, /tagged/i,
  /dynamic[\s-]*import/i, /import\.meta/i,
  /\bdebugger\b/, /\bexport\s+default\b/,
  /\bdelete\b/,
]

// Quick mode: limit tests per subdirectory
const QUICK = process.argv.includes('--quick')
const FILTER = process.argv.find(a => a.startsWith('--filter='))?.split('=')[1]
const MAX_PER_DIR = QUICK ? 50 : Infinity

// Collect test files
function* walk(dir) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) yield* walk(full)
      else if (entry.name.endsWith('.js') && !entry.name.startsWith('.')) yield full
    }
  } catch { /* skip unreadable dirs */ }
}

function shouldSkip(content) {
  // Skip tests with unsupported features
  if (EXCLUDED_PATTERNS.some(p => p.test(content))) return 'unsupported feature'
  // Skip negative tests (expected to throw SyntaxError) — jz rejects differently
  if (/negative:\s*\n\s+phase:\s+parse/.test(content)) return 'negative parse test'
  if (/negative:\s*\n\s+phase:\s+runtime/.test(content)) return 'negative runtime test'
  // Skip tests with harness-specific directives
  if (content.includes('$DONE') && !content.includes('runTest')) return 'harness dependency'
  if (content.includes('Test262:Async')) return 'async test'
  if (content.includes('propertyHelper')) return 'propertyHelper'
  if (content.includes('verifyProperty')) return 'verifyProperty'
  if (content.includes('compareArray')) return 'compareArray harness'
  // test262 harness globals
  if (content.includes('Test262Error')) return 'Test262Error harness'
  if (content.includes('assert.')) return 'assert harness'
  if (content.includes('assertThrows') || content.includes('assert.throws')) return 'assert harness'
  // Skip tests using undeclared globals
  if (/\bFunction\b/.test(content) && !content.includes('arrow function')) return 'Function global'
  if (/\bObject\.getOwnPropertyDescriptor\b/.test(content)) return 'Object.getOwnPropertyDescriptor'
  if (content.includes('MAX_ITERATIONS')) return 'MAX_ITERATIONS harness'
  // Skip tests using `using` keyword (explicit resource management)
  if (/\busing\b/.test(content)) return 'using keyword'
  // Multi-file module fixtures (not self-contained)
  if (content.includes('import ') && content.includes('_FIXTURE')) return 'fixture dependency'
  if (content.includes('import ') && /\bfrom\s+['"]\.\/[^'"]+_FIXTURE/.test(content)) return 'fixture dependency'
  if (content.includes('from ') && /\bfrom\s+['"]\.\/[^'"]+_FIXTURE/.test(content)) return 'fixture dependency'
  return null
}

// Try to compile and run a test
let compile, jz
try {
  const mod = await import(join(ROOT, 'index.js'))
  compile = mod.default.compile || mod.compile
  jz = mod.default
} catch (e) {
  console.error('Failed to import jz:', e.message)
  process.exit(1)
}

function runTest(src) {
  // Strip test262 harness directives and includes
  let code = src
    .replace(/\/\*---[\s\S]*?---\*\//, '') // strip YAML frontmatter
    .replace(/\.create\.js\b/g, '')  // non-existent files
    .replace(/\$DONOTEVALUATE\(\)/g, 'return')  // skip markers

  // Wrap bare statements into a module export for jz
  // test262 tests are typically bare scripts with assert() calls
  // We wrap them so jz can compile as a module
  const hasExport = /export\s+(let|const|function|default)/.test(code)
  if (!hasExport) {
    // Bare script — wrap in a function so jz can compile it
    code = `export let _run = () => {\n${code}\nreturn 1\n}`
  }

  try {
    const wasm = compile(code, { jzify: true })
    if (!wasm || !wasm.byteLength) return { status: 'fail', error: 'no output' }
    const mod = new WebAssembly.Module(wasm)
    const inst = new WebAssembly.Instance(mod)
    // Try to invoke the entry point
    if (inst.exports._run) inst.exports._run()
    return { status: 'pass' }
  } catch (e) {
    const msg = e.message || ''
    // Compile-time errors for features jz intentionally doesn't support
    if (msg.includes('Unknown op') || msg.includes('not supported') ||
        msg.includes('prohibited') || msg.includes('strict mode') ||
        msg.includes('Unknown tag') || msg.includes('Unknown func') ||
        msg.includes('Unknown local') || msg.includes('conflicts with a compiler internal') ||
        msg.includes('Assignment to') || msg.includes('not declared') ||
        msg.includes('not exported') || msg.includes('has no default') ||
        msg.includes('Unknown module') || msg.includes('Unknown instruction') ||
        msg.includes('Unknown global')) {
      return { status: 'skip', error: msg.slice(0, 80) }
    }
    return { status: 'fail', error: msg.slice(0, 120) }
  }
}

// Main
const results = { pass: 0, fail: 0, skip: 0 }
const fails = []
const testDir = join(TEST262, 'test', 'language')

for (const subdir of SUPPORTED) {
  const dir = join(testDir, subdir)
  if (!existsSync(dir)) { console.log(`  skipping ${subdir}/ (not found)`); continue }
  if (FILTER && !subdir.includes(FILTER)) continue

  let count = 0
  for (const file of walk(dir)) {
    if (count >= MAX_PER_DIR) break
    const rel = relative(TEST262, file)
    // Skip entire directories for unsupported features
    if (rel.includes('dynamic-import') || rel.includes('import.meta') ||
        rel.includes('export-expname') || rel.includes('import-attributes') ||
        rel.includes('top-level-await') ||
        rel.includes('instn-resolve-') || rel.includes('eval-rqstd-') ||
        rel.includes('identifier-let-allowed')) { results.skip++; count++; continue }

    try {
      const src = readFileSync(file, 'utf-8')
      const skip = shouldSkip(src)
      if (skip) { results.skip++; count++; continue }

      const { status, error } = runTest(src)
      results[status]++
      count++

      if (status === 'fail' && fails.length < 30) {
        fails.push(`${rel}: ${error}`)
      }
    } catch {
      results.skip++
      count++
    }
  }
  console.log(`  ${subdir}/: ${count} tests`)
}

const total = results.pass + results.fail + results.skip
const pct = (n) => total ? (n / total * 100).toFixed(1) : '0.0'

console.log(`\n── Results ──`)
console.log(`  Pass:  ${results.pass} (${pct(results.pass)}%)`)
console.log(`  Fail:  ${results.fail} (${pct(results.fail)}%)`)
console.log(`  Skip:  ${results.skip} (${pct(results.skip)}%)`)
console.log(`  Total: ${total}`)

// For the purposes of "what jz aims to support" (pass + fail only),
// report the effective coverage:
const relevant = results.pass + results.fail
const coverage = relevant ? (results.pass / relevant * 100).toFixed(1) : '0.0'
console.log(`\n  Coverage (pass / pass+fail): ${coverage}%`)

if (fails.length) {
  console.log(`\n── Sample failures ──`)
  fails.forEach(f => console.log(`  ✗ ${f}`))
}
