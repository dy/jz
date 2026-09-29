// One fresh ordinary kernel per invocation, plus the independently built
// checkpoint overlay. Child processes release their entire Wasm working set.
// --full adds the hosted suite and the recursive compiler check.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateBuild } from '../scripts/private-build.mjs'
import { kernelHash } from './_shared-kernel.js'
import { runTasks, legEnv } from '../scripts/test-tasks.mjs'

const args = process.argv.slice(2)
if (args.some(a => !['--full', '--recursive'].includes(a)) || args.length > 1) throw new Error('Usage: node test/bootstrap.mjs [--full|--recursive]')
const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'jz-bootstrap-'))
let failed = false
try {
  console.log('bootstrap: building a fresh compiler (no dist cache)')
  const built = privateBuild(root, 'scripts/self-compile-build.mjs', [], { label: 'bootstrap build' })
  const path = join(dir, 'jz.wasm')
  writeFileSync(path, built.bytes)
  console.log(`bootstrap: built ${built.bytes.length} bytes in ${(built.ms / 1000).toFixed(1)}s`)
  const shared = { JZ_SELF_TEST_KERNEL: path, JZ_SELF_TEST_KERNEL_SHA256: kernelHash(built.bytes) }
  const tasks = [
    { name: 'self-roundtrip', args: ['test/index.js', 'self-compile'], env: legEnv(shared) },
    { name: 'kernel-parity', args: ['test/index.js', 'kernel-parity', 'kernel-oracle'], env: legEnv({ ...shared, JZ_TEST_SWEEP: '1' }) },
    { name: 'checkpoint', args: ['test/index.js', 'self-checkpoint'], env: legEnv(shared) },
  ]
  if (args.includes('--full')) tasks.push(
    { name: 'hosted-suite', args: ['test/index.js', '--suite=all'], env: legEnv({ ...shared, JZ_KERNEL: path, JZ_TEST_TARGET: 'jz.wasm' }) },
  )
  if (args.length) tasks.push(
    { name: 'recursive', args: ['scripts/kernel-gate.mjs', '--kernel', path, '--gate', 'recursive'], env: legEnv() },
  )
  const results = await runTasks(tasks, { jobs: 1, cwd: root, timeout: 14_400_000 })
  failed = results.some(r => r.code !== 0)
} finally { rmSync(dir, { recursive: true, force: true }) }
process.exitCode = failed ? 1 : 0
