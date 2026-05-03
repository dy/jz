/**
 * Classify test262 failures by error type.
 * Run: node test/test262-classify.mjs
 */
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, relative } from 'path'

const ROOT = import.meta.dirname
const TEST262 = join(ROOT, 'test262')

const SUPPORTED = ['expressions','statements','types','identifiers','literals','block-scope','destructuring','module-code','function-code']

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

function* walk(dir) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) yield* walk(full)
      else if (entry.name.endsWith('.js') && !entry.name.startsWith('.')) yield full
    }
  } catch {}
}

function shouldSkip(content) {
  if (EXCLUDED_PATTERNS.some(p => p.test(content))) return true
  if (/negative:\s*\n\s+phase:\s+parse/.test(content)) return true
  if (content.includes('$DONE') && !content.includes('runTest')) return true
  if (content.includes('Test262:Async')) return true
  if (content.includes('propertyHelper')) return true
  if (content.includes('verifyProperty')) return true
  if (content.includes('compareArray')) return true
  if (content.includes('Test262Error')) return true
  if (content.includes('assert.')) return true
  if (content.includes('assertThrows') || content.includes('assert.throws')) return true
  if (/\bFunction\b/.test(content) && !content.includes('arrow function')) return true
  if (content.includes('import ') && content.includes('_FIXTURE')) return true
  if (content.includes('import ') && /\bfrom\s+['"]\.\/[^'"]+_FIXTURE/.test(content)) return true
  return false
}

const mod = await import('../index.js')
const compile = mod.default.compile || mod.compile

function runTest(src) {
  let code = src.replace(/\/\*---[\s\S]*?---\*\//, '').replace(/\.create\.js\b/g, '').replace(/\$DONOTEVALUATE\(\)/g, 'return')
  const hasExport = /export\s+(let|const|function|default)/.test(code)
  if (!hasExport) code = 'export let _run = () => {\n' + code + '\nreturn 1\n}'
  try {
    const wasm = compile(code, { jzify: true })
    if (!wasm || !wasm.byteLength) return { status: 'fail', error: 'no output' }
    const m = new WebAssembly.Module(wasm)
    const inst = new WebAssembly.Instance(m)
    if (inst.exports._run) inst.exports._run()
    return { status: 'pass' }
  } catch (e) {
    return { status: 'fail', error: (e.message || '').slice(0, 200) }
  }
}

const testDir = join(TEST262, 'test', 'language')
const fails = []

for (const subdir of SUPPORTED) {
  const dir = join(testDir, subdir)
  if (!existsSync(dir)) continue
  for (const file of walk(dir)) {
    const rel = relative(TEST262, file)
    if (rel.includes('dynamic-import') || rel.includes('import.meta') ||
        rel.includes('export-expname') || rel.includes('import-attributes') ||
        rel.includes('top-level-await')) continue
    try {
      const src = readFileSync(file, 'utf-8')
      if (shouldSkip(src)) continue
      const { status, error } = runTest(src)
      if (status === 'fail') fails.push({ file: rel, error })
    } catch {}
  }
}

// Classify by error prefix
const byError = {}
for (const f of fails) {
  const key = f.error.replace(/@\+?\d+$/,'').replace(/at \d+:\d+/, 'at N:N').slice(0, 80)
  if (!byError[key]) byError[key] = { count: 0, files: [] }
  byError[key].count++
  if (byError[key].files.length < 3) byError[key].files.push(f.file)
}

console.log('TOTAL FAILURES:', fails.length)
console.log('')
const sorted = Object.entries(byError).sort((a, b) => b[1].count - a[1].count)
for (const [key, { count, files }] of sorted) {
  console.log(`${count}x | ${key}`)
  for (const f of files) console.log(`     ${f}`)
  console.log('')
}
