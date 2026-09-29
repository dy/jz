import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

// Only the bootstrap orchestrator supplies this pair, for a private build made
// during this invocation. No mtime cache, no fallback to dist, no rebuild after
// a read/validation failure. selfBuild(root) itself always stays fresh.
export const kernelHash = bytes => createHash('sha256').update(bytes).digest('hex')
export function sharedKernel(fresh, env = process.env) {
  let bytes, failure
  return () => {
    if (failure) throw failure
    if (bytes) return bytes
    try {
      const path = env.JZ_SELF_TEST_KERNEL, hash = env.JZ_SELF_TEST_KERNEL_SHA256
      if (!path && !hash) return bytes = fresh()
      if (!path || !hash) throw new Error('Shared test kernel requires both its path and SHA256')
      const data = readFileSync(path)
      if (kernelHash(data) !== hash) throw new Error('Shared test kernel SHA256 mismatch')
      new WebAssembly.Module(data)
      return bytes = data
    } catch (e) { failure = e; throw e }
  }
}
