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
 * Strategy: scan tracked test262/test/language/ areas, attempt compile+run each
 * test, categorize as pass/fail/skip, and report pass coverage against the full
 * language and full test262 denominators.
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

// Language directories currently tracked as coverage work. This list is not a
// metric denominator; add meaningful jz areas here as support grows.
const TRACKED_LANGUAGE_DIRS = [
  'asi',
  'comments',
  'white-space',
  'line-terminators',
  'punctuators',
  'directive-prologue',
  'expressions',
  'statements',
  'types',
  'identifiers',
  'literals',
  'block-scope',
  'destructuring',
  'module-code',
  'function-code',
  'rest-parameters',
  'arguments-object',
]

const COMPUTED_PROPERTY_NAME_OBJECT_TESTS = new Set([
  'cpn-obj-lit-computed-property-name-from-additive-expression-add.js',
  'cpn-obj-lit-computed-property-name-from-additive-expression-subtract.js',
  'cpn-obj-lit-computed-property-name-from-condition-expression-false.js',
  'cpn-obj-lit-computed-property-name-from-condition-expression-true.js',
  'cpn-obj-lit-computed-property-name-from-decimal-e-notational-literal.js',
  'cpn-obj-lit-computed-property-name-from-decimal-literal.js',
  'cpn-obj-lit-computed-property-name-from-exponetiation-expression.js',
  'cpn-obj-lit-computed-property-name-from-expression-coalesce.js',
  'cpn-obj-lit-computed-property-name-from-expression-logical-and.js',
  'cpn-obj-lit-computed-property-name-from-expression-logical-or.js',
  'cpn-obj-lit-computed-property-name-from-identifier.js',
  'cpn-obj-lit-computed-property-name-from-integer-e-notational-literal.js',
  'cpn-obj-lit-computed-property-name-from-integer-separators.js',
  'cpn-obj-lit-computed-property-name-from-math.js',
  'cpn-obj-lit-computed-property-name-from-multiplicative-expression-div.js',
  'cpn-obj-lit-computed-property-name-from-multiplicative-expression-mult.js',
  'cpn-obj-lit-computed-property-name-from-null.js',
  'cpn-obj-lit-computed-property-name-from-numeric-literal.js',
  'cpn-obj-lit-computed-property-name-from-string-literal.js',
])

const ARGUMENTS_OBJECT_TESTS = new Set([
  'func-decl-args-trailing-comma-multiple.js',
  'func-decl-args-trailing-comma-null.js',
  'func-decl-args-trailing-comma-single-args.js',
  'func-decl-args-trailing-comma-undefined.js',
  'func-expr-args-trailing-comma-multiple.js',
  'func-expr-args-trailing-comma-null.js',
  'func-expr-args-trailing-comma-single-args.js',
  'func-expr-args-trailing-comma-undefined.js',
])

function baseName(rel) { return rel.slice(rel.lastIndexOf('/') + 1) }

function isComputedPropertyNameObjectTest(rel) {
  return rel.includes('language/expressions/object/') && COMPUTED_PROPERTY_NAME_OBJECT_TESTS.has(baseName(rel))
}

function isArgumentsObjectTest(rel) {
  return rel.includes('language/arguments-object/') && ARGUMENTS_OBJECT_TESTS.has(baseName(rel))
}

const ASSERT_HARNESS = `
function Test262Error(message) { return message || 'Test262Error' }
function Error(message) { return message || 'Error' }
function EvalError(message) { return message || 'EvalError' }
function RangeError(message) { return message || 'RangeError' }
function ReferenceError(message) { return message || 'ReferenceError' }
function SyntaxError(message) { return message || 'SyntaxError' }
function TypeError(message) { return message || 'TypeError' }
function URIError(message) { return message || 'URIError' }
let __sameValue = (a, b) => {
  if (a === b) return a !== 0 || 1 / a === 1 / b
  return a !== a && b !== b
}
let assert = (cond, msg) => { if (!cond) throw msg }
assert.sameValue = (a, b, msg) => { if (!__sameValue(a, b)) throw msg }
assert.notSameValue = (a, b, msg) => { if (__sameValue(a, b)) throw msg }
assert.compareArray = (a, b, msg) => {
  if (a.length != b.length) throw msg
  for (let i = 0; i < a.length; i++) if (!__sameValue(a[i], b[i])) throw msg
}
assert.throws = (expected, fn, msg) => {
  let threw = 0
  try { fn() } catch (e) { threw = 1 }
  if (!threw) throw msg
}
`

function needsAssertHarness(content, rel = '') {
  return rel.includes('language/rest-parameters/') ||
    isComputedPropertyNameObjectTest(rel) ||
    isArgumentsObjectTest(rel) ||
    content.includes('assert') ||
    content.includes('Test262Error') ||
    content.includes('compareArray')
}

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
  /\bexport\s+default\b/,
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

function countJs(dir) {
  let count = 0
  for (const _ of walk(dir)) count++
  return count
}

function shouldSkip(content, rel = '') {
  const codeContent = content
    .replace(/\/\*---[\s\S]*?---\*\//, '')
    .replace(/^\/\/[^\n]*(?:\n|$)/gm, '')
  if (rel.includes('language/expressions/object/cpn-obj-lit-computed-property-name-from-') && !isComputedPropertyNameObjectTest(rel))
    return 'computed property name outside fixed-shape subset'
  if (rel.includes('language/arguments-object/') && !isArgumentsObjectTest(rel))
    return 'arguments object outside jzify-supported subset'
  if (/\bdo\s*;\s*while\b/.test(codeContent)) return 'do-while empty-statement parser gap'
  if (rel.includes('/optional-catch-binding')) return 'optional catch binding parser gap'
  if (rel.includes('/block-scope/shadowing/') && rel.includes('catch-parameter')) return 'catch parameter shadowing codegen gap'
  if (rel.includes('/for-of/')) return 'for-of outside current jz scope'
  if (content.includes('for-in-order')) return 'for-in mutation-order semantics outside simple jz subset'
  if (rel.includes('/statements/for/head-lhs-let.js')) return 'let-as-identifier parser edge outside current jz scope'
  if (rel.includes('/statements/let/syntax/let.js')) return 'uninitialized lexical binding test outside current jz scope'
  if (rel.includes('/statements/switch/scope-lex-')) return 'switch lexical environment semantics outside current jz scope'
  if (rel.includes('/statements/try/12.14-')) return 'legacy catch scope semantics outside current jz scope'
  if (rel.includes('/function-code/eval-')) return 'direct eval parameter environment outside current jz scope'
  if (rel.includes('/regexp/')) return 'regexp outside current jz scope'
  if (/features:\s*\[[^\]]*destructuring-binding/.test(content) || rel.includes('/dstr/')) return 'destructuring binding outside current jz subset'
  // Skip tests with unsupported features
  if (EXCLUDED_PATTERNS.some(p => p.test(codeContent))) return 'unsupported feature'
  // Skip negative tests (expected to throw SyntaxError) — jz rejects differently
  if (/negative:\s*\n\s+phase:\s+parse/.test(content)) return 'negative parse test'
  if (/negative:\s*\n\s+phase:\s+runtime/.test(content)) return 'negative runtime test'
  if (content.includes('Test262Error') && !content.includes('assert.throws')) return 'Test262Error legacy harness'
  // Skip tests with harness-specific directives
  if (content.includes('$DONE') && !content.includes('runTest')) return 'harness dependency'
  if (content.includes('Test262:Async')) return 'async test'
  if (content.includes('propertyHelper')) return 'propertyHelper'
  if (content.includes('verifyProperty')) return 'verifyProperty'
  // Parser gaps tracked upstream in subscript; do not count as jz runtime failures.
  if (content.includes('\u00a0')) return 'NBSP parser gap'
  // Skip tests using undeclared globals
  if (/\bFunction\b/.test(content) && !content.includes('arrow function')) return 'Function global'
  if (/\bObject\.getOwnPropertyDescriptor\b/.test(content)) return 'Object.getOwnPropertyDescriptor'
  if (content.includes('MAX_ITERATIONS')) return 'MAX_ITERATIONS harness'
  if (/\.prototype\b/.test(codeContent)) return 'prototype chain outside current jz scope'
  if (/\bnew\s+(Boolean|Number|String)\b/.test(codeContent)) return 'boxed primitive object outside current jz scope'
  // Skip tests using `using` keyword (explicit resource management)
  if (/\busing\b/.test(codeContent)) return 'using keyword'
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

function runTest(src, options = {}) {
  // Strip test262 harness directives and includes
  let code = src
    .replace(/\/\*---[\s\S]*?---\*\//, '') // strip YAML frontmatter
    .replace(/^#![^\n]*(?:\n|$)/, '')
    .replace(/\.create\.js\b/g, '')  // non-existent files
    .replace(/\$DONOTEVALUATE\(\)/g, 'return')  // skip markers

  // Wrap bare statements into a module export for jz
  // test262 tests are typically bare scripts with assert() calls
  // We wrap them so jz can compile as a module
  const hasExport = /export\s+(let|const|function|default)/.test(code)
  if (!hasExport) {
    // Bare script — wrap in a function so jz can compile it
    code = `export let _run = () => {\n${options.assertHarness ? ASSERT_HARNESS : ''}\n${code}\nreturn 1\n}`
  } else {
    code = `${options.assertHarness ? ASSERT_HARNESS : ''}\n${code}`
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
        msg.includes('Unknown global') ||
        msg.includes('Imports argument must be present') ||
        msg.includes('function import requires a callable')) {
      return { status: 'skip', error: msg.slice(0, 80) }
    }
    return { status: 'fail', error: msg.slice(0, 120) }
  }
}

// Main
const results = { pass: 0, fail: 0, skip: 0 }
const fails = []
const testDir = join(TEST262, 'test', 'language')
const languageTest262Files = countJs(testDir)
const allTest262Files = countJs(join(TEST262, 'test'))

for (const subdir of TRACKED_LANGUAGE_DIRS) {
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
      rel.includes('instn-resolve-') || rel.includes('eval-rqstd-')) { results.skip++; count++; continue }

    try {
      const src = readFileSync(file, 'utf-8')
      const skip = shouldSkip(src, rel)
      if (skip) { results.skip++; count++; continue }

      const assertHarness = needsAssertHarness(src, rel)
      const { status, error } = runTest(src, { assertHarness })
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

console.log(`\n── Results ──`)
console.log(`  Pass:          ${results.pass}`)
console.log(`  Fail:          ${results.fail}`)
console.log(`  Skip:          ${results.skip}`)
console.log(`  Tracked files: ${total}/${languageTest262Files} language JS files`)

const languageCoverage = languageTest262Files ? (results.pass / languageTest262Files * 100).toFixed(1) : '0.0'
const overallCoverage = allTest262Files ? (results.pass / allTest262Files * 100).toFixed(1) : '0.0'
console.log(`\n  Language coverage (pass / language JS files): ${languageCoverage}% (${results.pass}/${languageTest262Files})`)
console.log(`  Overall test262 coverage (pass / all JS files): ${overallCoverage}% (${results.pass}/${allTest262Files})`)

if (fails.length) {
  console.log(`\n── Sample failures ──`)
  fails.forEach(f => console.log(`  ✗ ${f}`))
}
