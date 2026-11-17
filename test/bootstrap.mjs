// One fresh ordinary kernel per invocation, plus the independently built
// checkpoint overlay. Child processes release their entire Wasm working set.
// --recursive adds the recursive compiler check; --full adds it and the hosted
// suite; --hosted=<i>/<n> runs only slice i of n of the hosted suite, on a kernel of
// its own (CI's matrix: .github/workflows/self-compile.yml).
//
// The hosted suite is every file `node test/index.js --suite=all` runs on the
// kernel (JZ_TEST_TARGET=jz.wasm), each in a process of its own: every compile there
// takes a fresh kernel instance, so the compiler under test carries nothing from one
// file to the next, and a file can no longer lean on host state an earlier file left
// (a test that reads the host compiler's session compiles in-process first). The
// slices pack the files by their measured seconds (test/hosted-costs.json, _jobs.js
// slices), every file in exactly one; a slice runs its dearest files first, over the
// idle cores or JZ_TEST_JOBS. A fresh process runs the kernel's baseline-tier code,
// whose frames are larger than the optimized code a long process reaches: there
// splice.js's sum of 90 calls needs between 984 KB (V8's default stack) and 1100 KB,
// so a hosted file gets twice the default.
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateBuild } from '../scripts/private-build.mjs'
import { kernelHash } from './_shared-kernel.js'
import { slices, measured } from './_jobs.js'
import { runTasks, legEnv, suiteJobs } from '../scripts/test-tasks.mjs'

const args = process.argv.slice(2), [mode] = args
const slice = /^--hosted=([1-9]\d*)\/([1-9]\d*)$/.exec(mode ?? '')
if (args.length > 1 || mode && !['--full', '--recursive'].includes(mode) && !(slice && +slice[1] <= +slice[2]))
  throw new Error('Usage: node test/bootstrap.mjs [--full|--recursive|--hosted=<i>/<n>]')
const root = fileURLToPath(new URL('..', import.meta.url))
const hosted = { JZ_TEST_TARGET: 'jz.wasm' }

// The files of the hosted slice, dearest first; none unless asked.
function hostedFiles() {
  if (mode !== '--full' && !slice) return []
  const [i, n] = slice ? [+slice[1], +slice[2]] : [1, 1]
  const r = spawnSync(process.execPath, ['test/index.js', '--suite=all', '--list'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...legEnv(hosted) } })
  if (r.error || r.status !== 0) throw new Error(`hosted suite listing failed\n${r.error?.message || r.stderr}`)
  const all = r.stdout.trim().split('\n').filter(Boolean)
  const cost = measured(all, JSON.parse(readFileSync(new URL('./hosted-costs.json', import.meta.url), 'utf8')).seconds)
  const { files, weight } = slices(all, cost, n)[i - 1]
  console.log(`bootstrap: hosted suite slice ${i}/${n}: ${files.length} of ${all.length} files, ${Math.round(weight / 60)} min of measured file time`)
  return files.toSorted((a, b) => cost(b) - cost(a))
}

const files = hostedFiles()
const dir = mkdtempSync(join(tmpdir(), 'jz-bootstrap-'))
let failed = false
try {
  console.log('bootstrap: building a fresh compiler (no dist cache)')
  const built = privateBuild(root, 'scripts/self-compile-build.mjs', [], { label: 'bootstrap build' })
  const path = join(dir, 'jz.wasm')
  writeFileSync(path, built.bytes)
  console.log(`bootstrap: built ${built.bytes.length} bytes in ${(built.ms / 1000).toFixed(1)}s`)
  const shared = { JZ_SELF_TEST_KERNEL: path, JZ_SELF_TEST_KERNEL_SHA256: kernelHash(built.bytes) }
  const parts = slice ? [] : [
    { name: 'self-roundtrip', args: ['test/index.js', 'self-compile'], env: legEnv(shared) },
    { name: 'kernel-parity', args: ['test/index.js', 'kernel-parity', 'kernel-oracle'], env: legEnv({ ...shared, JZ_TEST_SWEEP: '1' }) },
    { name: 'checkpoint', args: ['test/index.js', 'self-checkpoint'], env: legEnv(shared) },
    ...(mode ? [{ name: 'recursive', args: ['scripts/kernel-gate.mjs', '--kernel', path, '--gate', 'recursive'], env: legEnv() }] : []),
  ]
  const suite = files.map(f => ({ name: `hosted-${f}`, args: ['--stack-size=1968', 'test/index.js', f], env: legEnv({ ...hosted, JZ_KERNEL: path }) }))
  const results = parts.length ? await runTasks(parts, { jobs: 1, cwd: root, timeout: 14_400_000 }) : []
  if (suite.length) results.push(...await runTasks(suite, { jobs: suiteJobs(process.env.JZ_TEST_JOBS || undefined, suite.length), cwd: root }))
  failed = results.some(r => r.code !== 0)
} finally { rmSync(dir, { recursive: true, force: true }) }
process.exitCode = failed ? 1 : 0
