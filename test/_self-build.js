import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// The one private build transaction behind every gate kernel: a builder script
// run once into its own temporary directory, its output read and validated as
// a module before anything is published, the directory removed whether or not
// that succeeded, and never a fallback to dist/. A gate owns its build result,
// not whatever happens to exist in dist/. Failure is sticky for this run: later
// consumers must neither retry nor consume an older artifact after the build
// fails, whatever failed (the subprocess, its exit status or signal, a
// subprocess error beside an exit of zero, the read, validation, setup or
// cleanup).
function build(root, script, args, label, prefix) {
  let bytes, failure
  return () => {
    if (failure) throw failure
    if (bytes) return bytes
    try {
      const dir = mkdtempSync(join(tmpdir(), prefix))
      const out = join(dir, 'jz.wasm')
      let built
      try {
        const r = spawnSync(process.execPath, [join(root, script), out, ...args], {
          cwd: root, encoding: 'utf8', timeout: 1_200_000,
        })
        if (r.error || r.signal || r.status !== 0) {
          throw new Error(`${label} exit ${r.status}${r.signal ? ` (${r.signal})` : ''}\n${r.error?.message || ''}\n${r.stdout || ''}${r.stderr || ''}`)
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

/** The fresh self build (scripts/self-compile-build.mjs). */
export const selfBuild = (root = ROOT) => build(root, 'scripts/self-compile-build.mjs', [], 'self-compile build', 'jz-self-build-')

/** A private kernel built with test-only source overlays (test/_self-overlay-build.mjs): the same transaction, its own artifact. */
export const selfBuildWith = (overlays, root = ROOT) =>
  build(root, 'test/_self-overlay-build.mjs', [JSON.stringify(overlays)], 'self-compile overlay build', 'jz-self-overlay-')

export const selfBytes = selfBuild()
