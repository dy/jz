// Work that may not return, run in a worker thread the test stops at a limit: a program that
// loops forever is a failed assertion, not a hung suite. `bounded(job, ms)` hands the worker
// (test/_bounded-worker.js) a job: `src` compiled once at `optimize`, then each of `runs` on an
// instance of its own, a list of [export, args] called in order (`@reset` for the instance's
// `memory.reset()`); `calls` the host imports, each [import, export], an import that calls the
// export back. Answers come back as strings, a throw as `throws: <message>`. Returns { results,
// calls } (the calls back), or { hung: [run, call] }: where the job was when the limit came.
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads'

let worker = null, port = null, flags = null
const start = () => {
  // [done, the run, the call]
  flags = new Int32Array(new SharedArrayBuffer(12))
  const channel = new MessageChannel()
  port = channel.port1
  worker = new Worker(new URL('./_bounded-worker.js', import.meta.url), { workerData: { port: channel.port2, flags }, transferList: [channel.port2] })
  worker.unref()
}

export function bounded(job, ms) {
  if (!worker) start()
  Atomics.store(flags, 0, 0)
  worker.postMessage(job)
  if (Atomics.wait(flags, 0, 0, ms) === 'timed-out' && Atomics.load(flags, 0) === 0) {
    const hung = [Atomics.load(flags, 1), Atomics.load(flags, 2)]
    worker.terminate()
    worker = null
    return { hung }
  }
  const { message } = receiveMessageOnPort(port)
  if (message.error) throw new Error(`bounded: ${message.error}`)
  return message
}
