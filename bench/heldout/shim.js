// The host a Benchmarks Game program of the held-out lane meets (manifest.json,
// interface 'clbg'): its size in process.argv[2], its output through console.log and
// process.stdout.write. The output is hashed as it is written (FNV-1a over every
// character code or byte, in order) and kept whole only for the set's own check.
// esbuild injects `process` and `console` in place of the host's in the program alone
// (scripts/heldout.mjs), under names of their own, so the driver's own output and every
// lane's host are untouched and every lane runs the program against the same host.
let hash = 0x811c9dc5 | 0, keep = false, kept = []

const put = (c) => {
  hash = Math.imul(hash ^ c, 0x01000193)
  if (keep) kept.push(c)
}

const write = (s) => {
  if (typeof s === 'string') for (let i = 0; i < s.length; i++) put(s.charCodeAt(i))
  else for (let i = 0; i < s.length; i++) put(s[i])
  return true
}

const programProcess = { argv: ['node', 'program'], stdout: { write } }
const programConsole = { log: (...args) => write(args.join(' ') + '\n') }
export { programProcess as process, programConsole as console }

export const __heldout = {
  // a run of the program at size `arg`; `whole` keeps its output for the check
  start: (arg, whole) => {
    programProcess.argv = ['node', 'program', arg]
    hash = 0x811c9dc5 | 0
    keep = whole
    kept = []
  },
  hash: () => hash >>> 0,
  output: () => kept,
}
