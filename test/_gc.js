import v8 from 'node:v8'
import vm from 'node:vm'
import { isMainThread } from 'node:worker_threads'

let gc = globalThis.gc
if (!gc && isMainThread) {
  v8.setFlagsFromString('--expose-gc')
  gc = vm.runInNewContext('gc')
  v8.setFlagsFromString('--no-expose-gc')
}

// Call only after a test/program's instances have left the stack. Wasm memory
// is outside V8's managed heap. Batches bound GC overhead; a byte threshold
// handles a few large instances sooner. Workers inherit --expose-gc from Node.
export function collector(collect = gc) {
  let completed = 0, previous = process.memoryUsage()
  return (force = false) => {
    if (!collect) return
    const mem = process.memoryUsage()
    if (force || ++completed >= 32 || mem.external - previous.external >= 64 * 1024 * 1024 || mem.rss - previous.rss >= 128 * 1024 * 1024) {
      collect()
      completed = 0
      previous = process.memoryUsage()
    }
  }
}
export const collect = collector()
