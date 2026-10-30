// console.log and performance.now for componentize-qjs, whose QuickJS has
// neither: the line (ASCII, as every case prints) goes to wasi:cli/stdout, the
// clock is the monotonic one, in nanoseconds. The componentize-qjs lane
// prepends this to the program (bench.mjs componentSource).
import stdout from 'wasi:cli/stdout@0.2.0'
import clock from 'wasi:clocks/monotonic-clock@0.2.0'

globalThis.console = { log: (...args) => {
  const s = args.join(' ') + '\n', bytes = []
  for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff)
  stdout.getStdout().blockingWriteAndFlush(bytes)
} }
globalThis.performance = { now: () => Number(clock.now()) / 1e6 }
