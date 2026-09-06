// The one private build transaction behind every gate kernel (test/_self-build.js's
// loaders, scripts/kernel-gate.mjs --build): a builder script run once into its own
// temporary directory, its output read and validated as a module before anything
// is published, the directory removed whether or not that succeeded, never a
// fallback to dist/. Every failure (the subprocess, its exit status or signal, a
// subprocess error beside an exit of zero, the read, validation, setup or cleanup)
// throws; the caller decides whether a failure is sticky.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * @param {string} root      the checkout whose builder runs
 * @param {string} script    builder script path relative to root; writes its wasm to argv[2]
 * @param {string[]} args    arguments after the output path
 * @param {{ label?: string, prefix?: string, timeout?: number }} [opts]
 * @returns {{ bytes: Buffer, ms: number, stdout: string, stderr: string }}
 */
export function privateBuild(root, script, args = [], { label = 'private build', prefix = 'jz-private-build-', timeout = 1_200_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const out = join(dir, 'jz.wasm')
  const t0 = Date.now()
  try {
    const r = spawnSync(process.execPath, [join(root, script), out, ...args], { cwd: root, encoding: 'utf8', timeout })
    if (r.error || r.signal || r.status !== 0) {
      throw new Error(`${label} exit ${r.status}${r.signal ? ` (${r.signal})` : ''}\n${r.error?.message || ''}\n${r.stdout || ''}${r.stderr || ''}`)
    }
    const bytes = readFileSync(out)
    new WebAssembly.Module(bytes)
    return { bytes, ms: Date.now() - t0, stdout: r.stdout || '', stderr: r.stderr || '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
