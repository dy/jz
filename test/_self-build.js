import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// A gate owns its build result, not whatever happens to exist in dist/.
// Failure is sticky for this run: later tests must neither retry nor consume
// an older artifact after the build test fails.
export function selfBuild(root = ROOT) {
  let bytes, failure
  return () => {
    if (failure) throw failure
    if (bytes) return bytes
    try {
      const dir = mkdtempSync(join(tmpdir(), 'jz-self-build-'))
      const out = join(dir, 'jz.wasm')
      let built
      try {
        const r = spawnSync(process.execPath, [join(root, 'scripts/self-compile-build.mjs'), out], {
          cwd: root, encoding: 'utf8', timeout: 1_200_000,
        })
        if (r.error || r.signal || r.status !== 0) {
          throw new Error(`self-compile build exit ${r.status}${r.signal ? ` (${r.signal})` : ''}\n${r.error?.message || ''}\n${r.stdout || ''}${r.stderr || ''}`)
        }
        built = readFileSync(out)
        new WebAssembly.Module(built)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      // Publish only after validation AND cleanup succeed.
      return bytes = built
    } catch (e) {
      failure = e
      throw e
    }
  }
}

// A private kernel built with test-only source overlays (test/_self-overlay-build.mjs):
// the same sticky-failure contract, its own artifact, never dist/.
export function selfBuildWith(overlays, root = ROOT) {
  let bytes, failure
  return () => {
    if (failure) throw failure
    if (bytes) return bytes
    try {
      const dir = mkdtempSync(join(tmpdir(), 'jz-self-overlay-'))
      const out = join(dir, 'jz.wasm')
      let built
      try {
        const r = spawnSync(process.execPath, [join(root, 'test/_self-overlay-build.mjs'), out, JSON.stringify(overlays)], {
          cwd: root, encoding: 'utf8', timeout: 1_200_000,
        })
        if (r.error || r.signal || r.status !== 0) {
          throw new Error(`self-compile overlay build exit ${r.status}${r.signal ? ` (${r.signal})` : ''}\n${r.error?.message || ''}\n${r.stdout || ''}${r.stderr || ''}`)
        }
        built = readFileSync(out)
        new WebAssembly.Module(built)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      return bytes = built
    } catch (e) {
      failure = e
      throw e
    }
  }
}

export const selfBytes = selfBuild()
