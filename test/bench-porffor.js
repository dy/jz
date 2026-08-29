import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'tst'
import { is, ok } from 'tst/assert.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BENCH = join(ROOT, 'bench/bench.mjs')
const METRIC = 'median_us=10 checksum=633180752 samples=1 stages=1 runs=1'

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  ...opts,
})

const lines = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)

test('Porffor bench lane: timer variants, cache identity, dirty checkout, and failed merge', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'jz porffor bench '))
  try {
    const checkout = join(scratch, 'porffor checkout')
    const build = join(scratch, 'build')
    const mode = join(scratch, 'mode')
    const runtimeMode = join(scratch, 'runtime-mode')
    const executions = join(scratch, 'executions')
    const builds = join(scratch, 'builds')
    const porf = join(checkout, 'porf')
    const marker = join(checkout, 'compiler-source.js')
    const shell = join(scratch, 'spidermonkey')
    mkdirSync(checkout)
    writeFileSync(mode, 'ok')
    writeFileSync(runtimeMode, 'ok')
    writeFileSync(marker, 'A\n')
    const nativeProgram = `#!/usr/bin/env node
const fs = require('node:fs')
let count = 0
try { count = Number(fs.readFileSync(${JSON.stringify(executions)}, 'utf8')) || 0 } catch {}
fs.writeFileSync(${JSON.stringify(executions)}, String(++count))
const runtimeMode = fs.readFileSync(${JSON.stringify(runtimeMode)}, 'utf8').trim()
if (runtimeMode === 'fail-warm-once' && count === 1) {
  console.error('intentional warm failure')
  process.exit(9)
}
if ((runtimeMode === 'fail-counted-once' && count === 2) ||
    (runtimeMode === 'fail-after-warm' && count > 1)) {
  console.error('intentional counted failure')
  process.exit(9)
}
const wrong = ${JSON.stringify(METRIC.replace('checksum=633180752', 'checksum=1'))}
const zero = ${JSON.stringify(METRIC.replace('median_us=10', 'median_us=0'))}
console.log(runtimeMode === 'zero' || (runtimeMode === 'zero-counted' && count > 1) ? zero :
  (runtimeMode === 'wrong-counted' && count > 1) ||
  (runtimeMode === 'wrong-counted-once' && count === 2) ||
  (runtimeMode === 'wrong-first-round' && (count === 2 || count === 3)) ? wrong : ${JSON.stringify(METRIC)})
`
    writeFileSync(porf, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('alpha 1'); process.exit(0) }
if (args[0] === '--help') process.exit(0)
if (args[0] !== 'native') process.exit(2)
if (fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim() === 'fail') {
  console.error('intentional compiler failure')
  process.exit(7)
}
const src = fs.readFileSync(args[1], 'utf8')
if (/^var performance =/m.test(src)) {
  console.error('Porffor received the shell timer shim')
  process.exit(8)
}
fs.appendFileSync(${JSON.stringify(builds)}, 'build\\n')
const out = args[args.indexOf('-o') + 1]
fs.writeFileSync(out, ${JSON.stringify(nativeProgram)})
fs.chmodSync(out, 0o755)
`)
    chmodSync(porf, 0o755)
    writeFileSync(shell, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--help' || args[0] === '--version') process.exit(0)
const src = fs.readFileSync(args[0], 'utf8')
if (!/^var performance =/m.test(src)) process.exit(9)
console.log(${JSON.stringify(METRIC)})
`)
    chmodSync(shell, 0o755)

    const git = args => run('git', args, { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git(['init', '-q'])
    git(['config', 'user.email', 'bench-test@example.invalid'])
    git(['config', 'user.name', 'bench test'])
    git(['add', 'porf', 'compiler-source.js'])
    git(['commit', '-qm', 'A'])
    git(['tag', 'alpha-3'])

    const bench = (targets = 'porf-native', args = [], env = {}) => run(process.execPath, [
      BENCH, '--cases=alpha', `--targets=${targets}`, ...args,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORF_BIN: porf,
        SPIDERMONKEY_BIN: shell,
        JZ_BENCH_BUILD_DIR: build,
        JZ_BENCH_WEB_DIR: join(scratch, 'web'),
        ...env,
      },
    })

    const first = bench('spidermonkey,porf-native')
    ok(first.includes(`reference_checksum=633180752`), 'both fake targets preserve the alpha checksum')
    is(lines(builds).length, 1, 'first Porffor run compiles once')
    const caseBuild = join(build, 'alpha')
    const shellFlat = readFileSync(join(caseBuild, 'alpha-flat.js'), 'utf8')
    const porfFlat = readFileSync(join(caseBuild, 'alpha-porf-flat.js'), 'utf8')
    ok(/^var performance =/m.test(shellFlat), 'shell flat source keeps the timer shim')
    ok(!/^var performance =/m.test(porfFlat), 'Porffor flat source uses native performance')

    bench()
    is(lines(builds).length, 1, 'A to A reuses the cached Porffor binary')
    const paired = bench('spidermonkey,porf-native', ['--paired=1'])
    ok(/spidermonkey\/porf-native/.test(paired), 'paired reuse keeps both timer variants runnable')
    is(lines(builds).length, 1, 'paired warm and counted rounds reuse one Porffor build')

    rmSync(join(caseBuild, 'alpha-porfnat'))
    bench()
    is(lines(builds).length, 2, 'a stamp without its compiled artifact rebuilds')

    writeFileSync(join(caseBuild, 'alpha-porf-flat.js'), `${porfFlat}\n// stale generated input\n`)
    bench()
    is(lines(builds).length, 3, 'changed flat input invalidates the compiled artifact')
    ok(!readFileSync(join(caseBuild, 'alpha-porf-flat.js'), 'utf8').includes('stale generated input'),
      'flat input is restored from benchmark sources before compilation')

    writeFileSync(join(caseBuild, '.prep-porf-native'), 'corrupt identity')
    bench()
    is(lines(builds).length, 4, 'a corrupt prep stamp rebuilds instead of failing or reusing')

    writeFileSync(marker, 'B\n')
    git(['add', 'compiler-source.js'])
    git(['commit', '-qm', 'B'])
    bench()
    is(lines(builds).length, 5, 'A to committed B invalidates the Porffor cache')
    ok(readFileSync(join(caseBuild, '.prep-porf-native'), 'utf8').includes(git(['rev-parse', '--short', 'HEAD'])),
      'prep stamp records the compiler revision that built the binary')

    writeFileSync(marker, 'dirty B\n')
    bench()
    bench()
    is(lines(builds).length, 7, 'dirty checkouts rebuild on every invocation')
    writeFileSync(marker, 'B\n')

    const standalonePorf = join(scratch, 'standalone-porf')
    copyFileSync(porf, standalonePorf)
    chmodSync(standalonePorf, 0o755)
    const buildsBeforeStandalone = lines(builds).length
    bench('porf-native', [], { PORF_BIN: standalonePorf })
    bench('porf-native', [], { PORF_BIN: standalonePorf })
    is(lines(builds).length, buildsBeforeStandalone + 2,
      'a path-backed compiler without readable Git identity never reuses persistent artifacts')

    const bareBinDir = join(scratch, 'bare-bin')
    const barePorf = join(bareBinDir, 'porf-standalone')
    mkdirSync(bareBinDir)
    copyFileSync(porf, barePorf)
    chmodSync(barePorf, 0o755)
    const buildsBeforeBare = lines(builds).length
    const bareEnv = { PORF_BIN: 'porf-standalone', PATH: `${bareBinDir}${delimiter}${process.env.PATH}` }
    bench('porf-native', [], bareEnv)
    bench('porf-native', [], bareEnv)
    is(lines(builds).length, buildsBeforeBare + 2,
      'a PATH-backed compiler with version text but no Git identity never reuses persistent artifacts')

    const json = join(scratch, 'results.json')
    const sibling = { medianUs: 20, bytes: 30, parity: 'ok', measuredAt: 'older' }
    const writeBaseline = () => writeFileSync(json, JSON.stringify({
      meta: { invocations: { v8: 'node alpha.js' } },
      cases: {
        alpha: {
          name: 'alpha', samples: 1, stages: 1, runs: 1, ref: 633180752,
          targets: {
            v8: sibling,
            'porf-native': { medianUs: 10, bytes: 40, parity: 'ok', measuredAt: 'older' },
          },
          paired: {
            'v8/porf-native': { ratios: [2], median: 2 },
            'v8/as': { ratios: [3], median: 3 },
          },
        },
      },
    }))

    writeBaseline()
    writeFileSync(executions, '0')
    writeFileSync(runtimeMode, 'fail-warm-once')
    const warmOut = bench('porf-native', [`--json=${json}`, '--merge', '--paired=1', '--allow-unanchored'])
    ok(warmOut.includes('retrying in counted rounds'), 'a warm failure is visible even when counted rounds recover')
    const warmRecovered = JSON.parse(readFileSync(json, 'utf8')).cases.alpha
    is(warmRecovered.targets['porf-native'].parity, 'ok', 'an uncounted warm failure does not override complete counted rounds')
    is(warmRecovered.paired['v8/porf-native'], undefined, 'refreshing a target invalidates its stale pair')
    is(warmRecovered.paired['v8/as'].median, 3, 'a pair between untouched targets survives the merge')

    writeBaseline()
    writeFileSync(executions, '0')
    writeFileSync(runtimeMode, 'fail-counted-once')
    bench('spidermonkey,porf-native', [`--json=${json}`, '--merge', '--paired=1', '--allow-unanchored'])
    const partialFailed = JSON.parse(readFileSync(json, 'utf8')).cases.alpha
    is(partialFailed.targets['porf-native'].status, 'fail', 'one failed counted position invalidates the target row')
    is(partialFailed.paired['spidermonkey/porf-native'], undefined, 'a partial round cannot produce a fresh pair verdict')
    is(partialFailed.paired['v8/porf-native'], undefined, 'a counted failure removes the stale pair verdict')
    is(partialFailed.paired['v8/as'].median, 3, 'counted failure preserves pairs unrelated to the failed target')

    writeBaseline()
    writeFileSync(executions, '0')
    writeFileSync(runtimeMode, 'wrong-counted')
    bench('spidermonkey,porf-native', [`--json=${json}`, '--merge', '--paired=1', '--allow-unanchored'])
    const wrong = JSON.parse(readFileSync(json, 'utf8')).cases.alpha
    is(wrong.targets['porf-native'].parity, 'DIFF', 'a consistently wrong counted result remains measured and labeled')
    is(wrong.paired['spidermonkey/porf-native'], undefined, 'a wrong result receives no fresh pair ratio')

    writeBaseline()
    writeFileSync(executions, '0')
    writeFileSync(runtimeMode, 'wrong-counted-once')
    bench('spidermonkey,porf-native', [`--json=${json}`, '--merge', '--paired=1', '--allow-unanchored'])
    const inconsistent = JSON.parse(readFileSync(json, 'utf8')).cases.alpha.targets['porf-native']
    is(inconsistent.status, 'fail', 'different checksums within a counted round invalidate the target')
    ok(inconsistent.reason.includes('checksums differ'), 'checksum inconsistency is retained as the failure reason')

    writeBaseline()
    writeFileSync(executions, '0')
    writeFileSync(runtimeMode, 'wrong-first-round')
    bench('spidermonkey,porf-native', [`--json=${json}`, '--merge', '--paired=1', '--allow-unanchored'])
    const roundMismatch = JSON.parse(readFileSync(json, 'utf8')).cases.alpha.targets['porf-native']
    is(roundMismatch.status, 'fail', 'a checksum change between complete counted rounds invalidates the target')
    ok(roundMismatch.reason.includes('counted round checksums differ'),
      'cross-round checksum inconsistency is distinguished from a partial round')

    writeBaseline()
    writeFileSync(executions, '0')
    writeFileSync(runtimeMode, 'wrong-counted')
    const wrongOnlyOut = bench('porf-native', [`--json=${json}`, '--merge', '--paired=1', '--allow-unanchored'])
    ok(wrongOnlyOut.includes('DIFF'), 'a target-only wrong refresh prints without a valid ratio baseline')
    is(JSON.parse(readFileSync(json, 'utf8')).cases.alpha.targets['porf-native'].parity, 'DIFF',
      'a target-only wrong refresh replaces stale success')

    writeBaseline()
    writeFileSync(executions, '0')
    writeFileSync(runtimeMode, 'zero')
    const zeroOut = bench('porf-native', [`--json=${json}`, '--merge', '--allow-unanchored'])
    const zeroRow = JSON.parse(readFileSync(json, 'utf8')).cases.alpha
    is(zeroRow.targets['porf-native'].medianUs, 0, 'a zero timing remains visible as measured evidence')
    is(zeroRow.targets['porf-native'].parity, 'ok', 'zero timing keeps its independent checksum classification')
    is(zeroRow.paired['v8/porf-native'], undefined, 'a zero-timing refresh invalidates its stale pair')
    ok(!zeroOut.includes('Infinity') && !zeroOut.includes('NaN'), 'zero timing emits no ratio or throughput fiction')

    writeBaseline()
    writeFileSync(executions, '0')
    writeFileSync(runtimeMode, 'zero-counted')
    bench('porf-native', [`--json=${json}`, '--merge', '--paired=1', '--allow-unanchored'])
    const countedZero = JSON.parse(readFileSync(json, 'utf8')).cases.alpha.targets['porf-native']
    is(countedZero.status, 'fail', 'a zero timing in a counted round invalidates the target')
    ok(countedZero.reason.includes('invalid median_us=0'), 'counted zero retains the timing failure reason')

    writeBaseline()
    writeFileSync(executions, '0')
    writeFileSync(runtimeMode, 'fail-after-warm')
    bench('porf-native', [`--json=${json}`, '--merge', '--paired=1', '--allow-unanchored'])
    const pairedFailed = JSON.parse(readFileSync(json, 'utf8')).cases.alpha
    is(pairedFailed.targets['porf-native'].status, 'fail', 'a warm success followed by counted failures replaces stale success')
    ok(pairedFailed.targets['porf-native'].reason.includes('intentional counted failure'), 'counted failure reason is retained')
    is(pairedFailed.paired['v8/porf-native'], undefined, 'an all-round failure removes the stale pair verdict')

    writeBaseline()
    writeFileSync(runtimeMode, 'ok')
    writeFileSync(mode, 'fail')
    const failedOut = bench('porf-native', [`--json=${json}`, '--merge', '--allow-unanchored'], { JZ_BENCH_REBUILD: '1' })
    ok(failedOut.includes('FAIL:'), 'the harness emits the current colon-delimited failure line')
    const merged = JSON.parse(readFileSync(json, 'utf8'))
    const failed = merged.cases.alpha.targets['porf-native']
    is(failed.status, 'fail', 'failure-only merge replaces the stale successful Porffor row')
    ok(failed.reason.includes('intentional compiler failure'), 'failure reason is retained')
    is(failed.measuredAt, merged.meta.commit, 'failed attempt receives the write commit as provenance')
    ok(/^[0-9a-f]{7,40}$/.test(failed.measuredAt), 'failed provenance is a git revision')
    is(JSON.stringify(merged.cases.alpha.targets.v8), JSON.stringify(sibling), 'failure merge preserves sibling targets')
    is(merged.cases.alpha.paired['v8/porf-native'], undefined, 'compiler failure removes the stale pair verdict')
    is(merged.cases.alpha.paired['v8/as'].median, 3, 'compiler failure preserves unrelated pair evidence')
    is(merged.cases.alpha.ref, 633180752, 'failure merge preserves the established checksum')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
