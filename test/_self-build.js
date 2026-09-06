import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateBuild } from '../scripts/private-build.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// A gate owns its build result, not whatever happens to exist in dist/. The
// transaction is scripts/private-build.mjs's; failure is sticky for this run:
// later consumers must neither retry nor consume an older artifact after the
// build fails, whatever failed.
function sticky(root, script, args, label, prefix) {
  let bytes, failure
  return () => {
    if (failure) throw failure
    if (bytes) return bytes
    try { return bytes = privateBuild(root, script, args, { label, prefix }).bytes }
    catch (e) { failure = e; throw e }
  }
}

/** The fresh self build (scripts/self-compile-build.mjs). */
export const selfBuild = (root = ROOT) => sticky(root, 'scripts/self-compile-build.mjs', [], 'self-compile build', 'jz-self-build-')

/** A private kernel built with test-only source overlays (test/_self-overlay-build.mjs): the same transaction, its own artifact. */
export const selfBuildWith = (overlays, root = ROOT) =>
  sticky(root, 'test/_self-overlay-build.mjs', [JSON.stringify(overlays)], 'self-compile overlay build', 'jz-self-overlay-')

export const selfBytes = selfBuild()
