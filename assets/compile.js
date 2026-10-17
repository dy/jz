// jz's compile, off the main thread. dist/jz.js is 3.5 MB and an optimized compile can take seconds; in a
// worker neither blocks a frame, a click or the first paint. `compile(src, opts)` resolves to what jz's own
// compile returns (wasm bytes, or WAT text under `wat: true`) and rejects with its error message.
// This one file is both sides: imported by a page it exports `compile`; started as a worker it compiles.
if (typeof document === 'undefined') {
  const jz = import('../dist/jz.js')
  onmessage = async ({ data: { id, src, opts } }) => {
    try {
      const { compile } = await jz, t = performance.now()
      const out = compile(src, opts), ms = performance.now() - t
      const data = typeof out === 'string' ? out : out.slice()   // its own buffer, so the transfer moves only the module
      postMessage({ id, out: data, ms }, typeof data === 'string' ? [] : [data.buffer])
    } catch (e) { postMessage({ id, error: String(e?.message ?? e) }) }
  }
}

let worker, seq = 0
const calls = new Map()
const spawn = () => {
  const w = new Worker(import.meta.url, { type: 'module' })
  w.onmessage = ({ data: { id, out, ms, error } }) => {
    const call = calls.get(id)
    calls.delete(id)
    if (error === undefined) call?.resolve({ out, ms })
    else call?.reject(new Error(error))
  }
  w.onerror = e => {   // the compiler failed to load: every pending call fails, the next one starts afresh
    e.preventDefault()
    for (const { reject } of calls.values()) reject(new Error(e.message || 'Compiler unavailable'))
    calls.clear(); worker = null
  }
  return w
}

// → { out, ms }: the compiler's output and its own compile time, without the messaging around it
export const compile = (src, opts = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  calls.set(id, { resolve, reject })
  ;(worker ??= spawn()).postMessage({ id, src, opts })
})
