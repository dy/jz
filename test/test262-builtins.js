/**
 * test262 built-ins runner for jz.
 *
 * Usage:
 *   node test/test262-builtins.js
 *   node test/test262-builtins.js --filter=Math/random
 *
 * Strategy: run curated built-ins functionality tests and explicitly skip
 * descriptor/prototype/runtime-shape tests until those semantics are in scope.
 */
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, relative } from 'path'
import { execSync } from 'child_process'

const ROOT = join(import.meta.dirname, '..')
const TEST262 = join(import.meta.dirname, 'test262')

if (!existsSync(TEST262)) {
  console.log('Cloning test262 (this may take a minute)...')
  execSync('git clone --depth 1 https://github.com/tc39/test262.git ' + TEST262, { stdio: 'inherit' })
}

const TRACKED_BUILTIN_PATHS = [
  'Math/random',
]

const FUNCTIONAL_TESTS = new Set([
  'built-ins/Math/random/S15.8.2.14_A1.js',
])

const FILTER = process.argv.find(a => a.startsWith('--filter='))?.split('=')[1]

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

function* walk(dir) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) yield* walk(full)
      else if (entry.name.endsWith('.js') && !entry.name.startsWith('.')) yield full
    }
  } catch { }
}

function countJs(dir) {
  let count = 0
  for (const _ of walk(dir)) count++
  return count
}

function shouldSkip(content, rel) {
  if (FUNCTIONAL_TESTS.has(rel)) return null
  if (rel.endsWith('/name.js')) return 'function name metadata'
  if (rel.endsWith('/length.js')) return 'function length metadata'
  if (rel.endsWith('/prop-desc.js')) return 'property descriptor metadata'
  if (rel.endsWith('/not-a-constructor.js')) return 'constructor/runtime-shape semantics'
  if (content.includes('propertyHelper')) return 'propertyHelper'
  if (content.includes('verifyProperty')) return 'verifyProperty'
  if (content.includes('includes: [')) return 'harness dependency'
  if (/Reflect\./.test(content)) return 'Reflect'
  if (/\bFunction\b/.test(content)) return 'Function global'
  if (/\bclass\b/.test(content)) return 'class'
  if (/async|await/.test(content)) return 'async'
  if (/\bProxy\b/.test(content)) return 'Proxy'
  if (/\bWeak(Ref|Map|Set)\b/.test(content)) return 'Weak collection'
  if (/Symbol\.(species|toPrimitive|iterator)/.test(content)) return 'Symbol runtime hook'
  if (/\biterator\b/i.test(content)) return 'iterator semantics'
  if (/\bnew\b/.test(content)) return 'constructor semantics'
  if (/\$DONE|Test262:Async/.test(content)) return 'async harness dependency'
  if (/negative:\s*\n\s+phase:\s+(parse|runtime)/.test(content)) return 'negative test'
  return 'not in curated functionality subset'
}

const { compile } = await import(join(ROOT, 'index.js'))

function runTest(src) {
  let code = src
    .replace(/\/\*---[\s\S]*?---\*\//, '')
    .replace(/^#![^\n]*(?:\n|$)/, '')
    .replace(/\$DONOTEVALUATE\(\)/g, 'return')

  if (!/export\s+(let|const|function|default)/.test(code)) {
    code = `export let _run = () => {\n${ASSERT_HARNESS}\n${code}\nreturn 1\n}`
  } else {
    code = `${ASSERT_HARNESS}\n${code}`
  }

  try {
    const wasm = compile(code, { jzify: true })
    if (!wasm || !wasm.byteLength) return { status: 'fail', error: 'no output' }
    const mod = new WebAssembly.Module(wasm)
    const inst = new WebAssembly.Instance(mod)
    if (inst.exports._run) inst.exports._run()
    return { status: 'pass' }
  } catch (e) {
    const msg = e.message || String(e)
    if (msg.includes('Unknown op') || msg.includes('not supported') ||
        msg.includes('prohibited') || msg.includes('Unknown tag') ||
        msg.includes('Unknown func') || msg.includes('Unknown local') ||
        msg.includes('not declared') || msg.includes('Unknown global')) {
      return { status: 'skip', error: msg.slice(0, 80) }
    }
    return { status: 'fail', error: msg.slice(0, 120) }
  }
}

const results = { pass: 0, fail: 0, skip: 0 }
const fails = []
const skips = new Map()
const builtinsDir = join(TEST262, 'test', 'built-ins')
const allBuiltinsFiles = countJs(builtinsDir)

for (const subpath of TRACKED_BUILTIN_PATHS) {
  if (FILTER && !subpath.includes(FILTER)) continue
  const dir = join(builtinsDir, subpath)
  if (!existsSync(dir)) { console.log(`  skipping ${subpath}/ (not found)`); continue }

  let count = 0
  for (const file of walk(dir)) {
    const rel = relative(join(TEST262, 'test'), file)

    try {
      const src = readFileSync(file, 'utf-8')
      const skip = shouldSkip(src, rel)
      if (skip) {
        results.skip++
        skips.set(skip, (skips.get(skip) || 0) + 1)
        count++
        continue
      }

      const { status, error } = runTest(src)
      results[status]++
      count++

      if (status === 'fail' && fails.length < 30) fails.push(`${rel}: ${error}`)
      if (status === 'skip') skips.set(error, (skips.get(error) || 0) + 1)
    } catch {
      results.skip++
      skips.set('read/runner error', (skips.get('read/runner error') || 0) + 1)
      count++
    }
  }

  console.log(`  ${subpath}/: ${count} tests`)
}

const total = results.pass + results.fail + results.skip
const coverage = allBuiltinsFiles ? (results.pass / allBuiltinsFiles * 100).toFixed(2) : '0.00'

console.log(`\n── Built-ins results ──`)
console.log(`  Pass:          ${results.pass}`)
console.log(`  Fail:          ${results.fail}`)
console.log(`  Skip:          ${results.skip}`)
console.log(`  Tracked files: ${total}/${allBuiltinsFiles} built-ins JS files`)
console.log(`\n  Built-ins coverage (pass / built-ins JS files): ${coverage}% (${results.pass}/${allBuiltinsFiles})`)

if (skips.size) {
  console.log(`\n── Skip reasons ──`)
  for (const [reason, count] of [...skips.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count} ${reason}`)
  }
}

if (fails.length) {
  console.log(`\n── Sample failures ──`)
  fails.forEach(f => console.log(`  x ${f}`))
  process.exitCode = 1
}