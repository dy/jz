import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const indexPath = resolve(root, 'test/index.js')
const timeboxPath = resolve(root, 'scripts/timebox.mjs')

const timeoutMs = Number(process.argv[2] || 3000)
const mode = process.argv[3] || 'files'

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error('Usage: node scripts/test-segments.mjs <timeout-ms> [files|prefix]')
  process.exit(2)
}

const imports = readFileSync(indexPath, 'utf8')
  .split('\n')
  .map(line => line.match(/^import\s+'(.+)'$/)?.[1])
  .filter(Boolean)

if (!imports.length) {
  console.error('No test imports found in test/index.js')
  process.exit(1)
}

const runCommand = (args) => new Promise(resolveRun => {
  const started = Date.now()
  const child = spawn(process.execPath, [timeboxPath, String(timeoutMs), process.execPath, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })

  child.on('exit', code => {
    resolveRun({
      code: code ?? 1,
      ms: Date.now() - started,
      stdout,
      stderr,
    })
  })
})

const summarize = text => {
  const lines = text.trim().split('\n').filter(Boolean)
  const picks = lines.filter(line => /^(►|×|actual:|expected:|Timed out)/.test(line.trim()))
  return (picks.length ? picks : lines).slice(-6).join(' | ')
}

async function runFiles() {
  let failures = 0
  const results = []

  for (const spec of imports) {
    const file = resolve(root, 'test', spec.slice(2))
    const result = await runCommand([file])
    const status = result.code === 0 ? 'OK' : result.code === 124 ? 'TIMEOUT' : 'FAIL'
    results.push({ spec, ...result, status })
    console.log(`${status.padEnd(7)} ${String(result.ms).padStart(5)}ms  ${spec}`)

    if (result.code !== 0) {
      failures++
      const snippet = summarize(result.stderr || result.stdout)
      if (snippet) console.log(`         ${snippet}`)
    }
  }

  console.log('--- slowest files ---')
  for (const result of [...results].sort((left, right) => right.ms - left.ms).slice(0, 5)) {
    console.log(`${result.status.padEnd(7)} ${String(result.ms).padStart(5)}ms  ${result.spec}`)
  }

  process.exit(failures ? 1 : 0)
}

async function runPrefixes() {
  const dir = mkdtempSync(resolve(tmpdir(), 'jz-test-prefix-'))

  try {
    for (let i = 0; i < imports.length; i++) {
      const spec = imports[i]
      const file = resolve(dir, `prefix-${String(i + 1).padStart(2, '0')}.mjs`)
      writeFileSync(file, `${imports.slice(0, i + 1).map(line => `import ${JSON.stringify(pathToFileURL(resolve(root, 'test', line.slice(2))).href)}`).join('\n')}\n`)

      const result = await runCommand([file])
      const status = result.code === 0 ? 'OK' : result.code === 124 ? 'TIMEOUT' : 'FAIL'
      console.log(`${status.padEnd(7)} ${String(result.ms).padStart(5)}ms  prefix ${String(i + 1).padStart(2, '0')} through ${spec}`)

      if (result.code !== 0) {
        const snippet = summarize(result.stderr || result.stdout)
        if (snippet) console.log(`         ${snippet}`)
        process.exit(result.code === 124 ? 124 : 1)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (mode === 'files') await runFiles()
else if (mode === 'prefix') await runPrefixes()
else {
  console.error(`Unknown mode: ${mode}`)
  process.exit(2)
}