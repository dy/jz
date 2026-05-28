import { parentPort, workerData } from 'worker_threads'
import jz, { compile as jsCompile, compileBundle } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'
import watrCompile from 'watr/compile'
import { resolve } from 'path'

const { sample, jzRoot, timeoutMs } = workerData
const timer = setTimeout(() => {
  parentPort.postMessage({ err: `kernel compile timed out after ${timeoutMs}ms` })
  process.exit(0)
}, timeoutMs)

try {
  const g = resolveModuleGraph(resolve(jzRoot, 'src/compile/index.js'), { resolveNode: true })
  const inst = jz(g.code, {
    jzify: true,
    modules: g.modules,
    memory: 8192,
    optimize: false,
    selfHost: true,
  })
  const compileFn = inst.exports.compile ?? inst.exports.default
  const bundle = compileBundle(sample, { jzify: true })
  const kernelMod = compileFn(bundle.ast, bundle)
  const jzBin = watrCompile(kernelMod)
  const hostBin = jsCompile(sample, { jzify: true, optimize: false })
  let firstMismatch
  for (let i = 0; i < jzBin.length; i++) {
    if (jzBin[i] !== hostBin[i]) { firstMismatch = { i, jz: jzBin[i], host: hostBin[i] }; break }
  }
  clearTimeout(timer)
  parentPort.postMessage({
    kernelMod: [kernelMod[0]],
    jzBinLen: jzBin.length,
    hostBinLen: hostBin.length,
    firstMismatch,
  })
} catch (e) {
  clearTimeout(timer)
  parentPort.postMessage({ err: e.message?.split('\n')[0] || String(e) })
}
