// Exercise the native lane without requiring the external compiler in core CI.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

test('Perry bench lane: native globals, paired reuse, parity, failures, and hard deadlines', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'jz perry bench '))
  try {
    const perry = join(scratch, 'perry')
    const builds = join(scratch, 'builds')
    const mode = join(scratch, 'mode')
    const json = join(scratch, 'results.json')
    const pid = join(scratch, 'pid')
    const hook = join(scratch, 'deadline.mjs')
    const hang = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pid)}, String(process.pid)); setInterval(() => {}, 1000)`
    // Exercise real process termination without waiting the production 60/120s.
    // Reject a soft deadline before spawning, so a regression cannot hang CI.
    writeFileSync(hook, `import cp from 'node:child_process'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const mode = readFileSync(${JSON.stringify(mode)}, 'utf8')
const spawn = cp.spawnSync, exec = cp.execFileSync
const deadline = (opts, ms) => {
  if (opts?.timeout !== ms || opts.killSignal !== 'SIGKILL') throw new Error('missing hard deadline')
  return { ...opts, timeout: 1000 }
}
cp.spawnSync = (cmd, args, opts) => {
  if (cmd === '/usr/bin/time' && mode === 'no-time') return { status: 1 }
  if (mode === 'run-hang' && [cmd, ...args].some(a => a.endsWith('-perry'))) {
    if (!cmd.endsWith('-perry')) throw new Error('bounded executable is wrapped')
    opts = deadline(opts, 60_000)
  }
  return spawn(cmd, args, opts)
}
cp.execFileSync = (cmd, args, opts) => {
  if (mode === 'compile-hang' && cmd === process.env.PERRY_BIN && args[0] === 'compile') opts = deadline(opts, 120_000)
  return exec(cmd, args, opts)
}
syncBuiltinESMExports()
`)
    writeFileSync(mode, 'ok')
    writeFileSync(perry, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('perry 0.5.test'); process.exit(0) }
if (args[0] !== 'compile' || args.includes('--enable-js-runtime')) process.exit(2)
if (args[args.indexOf('--fp-contract') + 1] !== 'off' || !args.includes('--cache-dir')) process.exit(3)
const src = fs.readFileSync(args[1], 'utf8')
if (/__benchGlobal|^var performance =/m.test(src)) process.exit(4)
if (!src.includes('performance.now()') || !src.endsWith('main()\\n')) process.exit(5)
if (process.env.PERRY_NO_UPDATE_CHECK !== '1' || process.env.PERRY_UPDATE_MODE !== 'off') process.exit(6)
const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8')
if (mode === 'fail') { console.error('intentional Perry compile failure'); process.exit(7) }
if (mode === 'compile-hang') { ${hang} }
else {
fs.appendFileSync(${JSON.stringify(builds)}, 'build\\n')
const out = args[args.indexOf('-o') + 1]
const body = mode === 'run-hang' ? ${JSON.stringify(hang)} : mode === 'empty' ? '' :
  mode === 'exit' ? 'console.error("intentional runtime failure"); process.exit(9)' :
  'console.log("median_us=10 checksum=' + (mode === 'wrong' ? '1' : '633180752') + ' samples=1048576 stages=1 runs=21")'
fs.writeFileSync(out, '#!/usr/bin/env node\\n' + body + '\\n')
fs.chmodSync(out, 0o755)
}
`)
    chmodSync(perry, 0o755)
    const bench = (args = [], bin = perry) => execFileSync(process.execPath, [
      '--import', hook, join(ROOT, 'bench/bench.mjs'), '--cases=alpha', '--targets=perry', ...args,
    ], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PERRY_BIN: bin, JZ_BENCH_BUILD_DIR: join(scratch, 'build'), JZ_BENCH_WEB_DIR: join(scratch, 'web') },
    })
    const count = () => readFileSync(builds, 'utf8').trim().split('\n').length
    const read = () => JSON.parse(readFileSync(json, 'utf8'))

    bench([`--json=${json}`, '--paired=1'])
    is(count(), 1, 'paired rounds reuse the binary compiled in the warm round')
    is(read().meta.versions.perry, 'perry 0.5.test', 'release identity is recorded')
    ok(read().meta.invocations.perry.includes('--fp-contract off'), 'compiler flags are recorded')
    is(read().cases.alpha.targets.perry.parity, 'ok', 'checksum agrees with the corpus oracle')
    ok(read().cases.alpha.targets.perry.bytes > 0, 'size is the compiled artifact')
    is(read().cases.alpha.targets.perry.memKb, null, 'bounded execution does not claim time(1) memory data')

    const baseline = read()
    baseline.cases.alpha.targets.v8 = { medianUs: 20, bytes: 30, parity: 'ok' }
    writeFileSync(json, JSON.stringify(baseline))
    writeFileSync(mode, 'wrong')
    bench([`--json=${json}`, '--merge', '--allow-unanchored'])
    is(count(), 2, 'a new invocation rebuilds instead of trusting an unidentified compiler cache')
    const wrong = read().cases.alpha.targets.perry
    is(wrong.parity, 'DIFF', `wrong answers remain visible and ineligible for comparisons: ${JSON.stringify(wrong)}`)
    is(read().cases.alpha.targets.v8, baseline.cases.alpha.targets.v8, 'unmeasured siblings survive')

    for (const [state, reason] of [
      ['fail', /intentional Perry compile failure/],
      ['empty', /unparseable stdout/],
      ['exit', /exit 9: intentional runtime failure/],
      ['compile-hang', /ETIMEDOUT/],
      ['run-hang', /timeout after 60000ms/],
    ]) {
      writeFileSync(json, JSON.stringify(baseline))
      writeFileSync(mode, state)
      rmSync(pid, { force: true })
      bench([`--json=${json}`, '--merge', '--allow-unanchored'])
      const failed = read().cases.alpha.targets.perry
      is(failed.status, 'fail', `${state}: failure replaces stale success`)
      ok(reason.test(failed.reason), `${state}: ${failed.reason}`)
      is(failed.medianUs, undefined, `${state}: no stale timing survives`)
      is(read().cases.alpha.targets.v8, baseline.cases.alpha.targets.v8, `${state}: sibling evidence survives`)
      if (state.endsWith('-hang')) {
        const child = Number(readFileSync(pid, 'utf8'))
        throws(() => process.kill(child, 0), /ESRCH/, `${state}: SIGTERM-ignoring process is gone`)
      }
    }
    writeFileSync(mode, 'no-time')
    bench(['--targets=v8', `--json=${json}`])
    is(read().cases.alpha.targets.v8.parity, 'ok', 'unbounded sibling runs when time(1) rejects resource queries')
    is(read().cases.alpha.targets.v8.memKb, null, 'unavailable time(1) leaves sibling RSS unmeasured')
    ok(bench([], join(scratch, 'missing-perry')).includes('[skip] perry'), 'absent toolchain skips cleanly')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
