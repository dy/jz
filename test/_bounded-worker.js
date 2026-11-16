// The worker of test/_bounded.js: compiles a job's source once, runs each of its runs on an
// instance of its own, and says where it is as it goes, so a run that never returns can be
// named when the test stops it.
import { parentPort, workerData } from 'node:worker_threads'
import { instantiate } from '../interop.js'
import { compile } from './util.js'

// The leg's compiler, as test/index.js sets it for the main thread: a worker's modules are its own.
if (process.env.JZ_TEST_TARGET === 'jz.wasm') {
  const [{ setCompileTarget }, { compileViaKernel }] = await Promise.all([import('../src/compiler.js'), import('./kernel-target.js')])
  setCompileTarget(compileViaKernel)
}

const { port, flags } = workerData
const show = v => Object.is(v, -0) ? '-0' : String(v)

parentPort.on('message', ({ src, optimize, calls = [], runs }) => {
  let out
  try {
    const host = {}
    let back = 0
    const imports = { host: Object.fromEntries(calls.map(([cb, ex]) => [cb, () => (back++, host.ex[ex]())])) }
    const wasm = compile(src, { optimize, imports })
    const results = runs.map((run, r) => {
      const { exports, memory } = instantiate(wasm, { imports })
      host.ex = exports
      return run.map(([name, args], c) => {
        Atomics.store(flags, 1, r); Atomics.store(flags, 2, c)
        // (`@reset`: the instance's memory.reset(), the round's end)
        try { return name === '@reset' ? (memory.reset(), 'reset') : show(exports[name](...args)) } catch (e) { return `throws: ${String(e?.message ?? e).split('\n')[0]}` }
      })
    })
    out = { results, calls: back }
  } catch (e) { out = { error: String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ') } }
  port.postMessage(out)
  Atomics.store(flags, 0, 1)
  Atomics.notify(flags, 0)
})
