import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

for (const id of ['scriptc', 'tslang']) test(`${id} bench: native artifact, source preservation, parity, failures and paired reuse`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz competitor '))
  try {
    const bin = join(dir, id), builds = join(dir, 'builds'), mode = join(dir, 'mode')
    const json = join(dir, 'results.json')
    const hook = join(dir, 'deadline.mjs'), pid = join(dir, 'pid')
    const hang = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pid)}, String(process.pid)); setInterval(() => {}, 1000)`
    // Keep the real subprocess termination path, shortening only its deadline:
    // long enough for the hanging stand-in to start and write its pid on a
    // loaded machine (a second was not), short of the minute it replaces.
    writeFileSync(hook, `import cp from 'node:child_process'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const spawn = cp.spawnSync, exec = cp.execFileSync
const mode = readFileSync(${JSON.stringify(mode)}, 'utf8')
const deadline = (opts, ms) => {
  if (opts?.timeout !== ms || opts.killSignal !== 'SIGKILL') throw new Error('missing hard deadline')
  return mode.endsWith('-hang') ? { ...opts, timeout: 5000 } : opts
}
cp.execFileSync = (cmd, args, opts) => exec(cmd, args,
  cmd === ${JSON.stringify(bin)} && !args.includes('--version') ? deadline(opts, 120_000) : opts)
cp.spawnSync = (cmd, args, opts) => {
  if ([cmd, ...args].some(a => a.endsWith('-${id}'))) {
    if (!cmd.endsWith('-${id}')) throw new Error('bounded executable is wrapped')
    opts = deadline(opts, 60_000)
  }
  return spawn(cmd, args, opts)
}
syncBuiltinESMExports()
`)
    writeFileSync(mode, 'ok')
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2)
if (args[0] === '--version') { console.log('${id === 'tslang' ? 'TypeScript Compiler:\\n  tslang version test' : 'scriptc test'}'); process.exit(0) }
const id = ${JSON.stringify(id)}
const srcPath = args.find(a => a.endsWith(id === 'tslang' ? '.ts' : '.js'))
const src = fs.readFileSync(srcPath, 'utf8')
if (/__benchGlobal|^var performance =/m.test(src) || args.includes('--dynamic')) process.exit(2)
if (id === 'scriptc' && args[0] !== 'build') process.exit(3)
if (id === 'tslang') {
  for (const flag of ['--emit=exe', '--opt', '--opt_level=3', '--relocation-model=pic'])
    if (!args.includes(flag)) process.exit(4)
  if (!args.some(a => a.startsWith('--obj=') && fs.existsSync(a.slice(6)))) process.exit(5)
  if (!src.includes('declare function jz_bench_now(): number;')) process.exit(6)
}
const kernel = fs.readFileSync(${JSON.stringify(join(ROOT, 'bench/alpha/alpha.js'))}, 'utf8')
const original = kernel.slice(kernel.indexOf('const W =')).replace('export let main', 'const main')
if (!src.includes(original) || !src.endsWith('main()\\n')) process.exit(7)
fs.appendFileSync(${JSON.stringify(builds)}, 'build\\n')
const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8')
if (mode === 'fail') { console.error('unsupported fixture'); process.exit(8) }
if (mode === 'no-artifact') process.exit(0)
if (mode === 'compile-hang') { ${hang} }
else {
const out = args[args.indexOf('-o') + 1]
// The successful stand-in executes the actual unchanged JavaScript workload.
const body = mode === 'run-hang' ? ${JSON.stringify(hang)} : mode === 'empty' ? '' :
  mode === 'exit' ? 'console.error("runtime fixture"); process.exit(9)' :
  mode === 'wrong' ? 'console.log("median_us=10 checksum=1 samples=1 stages=1 runs=1")' :
  src.replace(/^declare function jz_bench_now[^\\n]*\\nconst performance[^\\n]*\\n/, '')
fs.writeFileSync(out, '#!/usr/bin/env node\\n' + body)
fs.chmodSync(out, 0o755)
}
`)
    chmodSync(bin, 0o755)
    const run = (args = [], compiler = bin) => execFileSync(process.execPath, [
      '--import', hook, join(ROOT, 'bench/bench.mjs'), `--targets=${id}`, '--cases=alpha', '--no-web', ...args,
    ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, [id.toUpperCase() + '_BIN']: compiler,
        JZ_BENCH_BUILD_DIR: join(dir, 'build'), JZ_BENCH_WEB_DIR: join(dir, 'web') } })
    const read = () => JSON.parse(readFileSync(json, 'utf8'))
    run([`--json=${json}`, '--paired=1'])
    is(readFileSync(builds, 'utf8'), 'build\n', 'paired rounds compile once')
    is(existsSync(join(dir, 'web/alpha.wasm')), false, 'competitor-only data refresh needs no JZ browser build')
    is(read().cases.alpha.targets[id].parity, 'ok', 'unchanged workload matches Node oracle')
    ok(read().cases.alpha.targets[id].bytes > 0, 'artifact size is recorded')
    is(read().meta.versions[id], id === 'tslang' ? 'tslang version test' : 'scriptc test')
    ok(read().meta.invocations[id].includes(id + ' '), 'invocation is recorded')
    const baseline = read()
    const version = baseline.meta.versions[id]
    baseline.meta.versions[id] = 'previous competitor version'
    baseline.cases.alpha.targets.v8 = { medianUs: 20, parity: 'ok' }
    baseline.meta.versions.watr = 'previous codegen version'
    baseline.meta.versions.perry = 'previous Perry version'
    for (const [state, reason] of [
      ['no-artifact', /did not produce/], ['wrong'], ['fail', /unsupported fixture/],
      ['empty', /unparseable stdout/], ['exit', /exit 9: runtime fixture/],
      ['compile-hang', /ETIMEDOUT/], ['run-hang', /timeout after 60000ms/],
    ]) {
      writeFileSync(mode, state)
      writeFileSync(json, JSON.stringify(baseline))
      rmSync(pid, { force: true })
      run([`--json=${json}`, '--merge', '--allow-unanchored'])
      const result = read()
      const row = result.cases.alpha.targets[id]
      is(result.cases.alpha.targets.v8, baseline.cases.alpha.targets.v8, 'unmeasured sibling survives')
      is(result.meta.versions.watr, baseline.meta.versions.watr, 'untouched JZ keeps its actual codegen version')
      is(result.meta.versions.perry, baseline.meta.versions.perry, 'absent compiler keeps the version behind its stored rows')
      is(result.meta.versions[id], version, 'refreshed compiler records its current version')
      if (state === 'wrong') is(row.parity, 'DIFF', 'wrong answer cannot enter ratios')
      else {
        is(row.status, 'fail', `${state}: error replaces stale success`)
        ok(reason.test(row.reason), `${state}: ${row.reason}`)
        is(row.medianUs, undefined, 'failed row carries no old timing')
      }
      if (state.endsWith('-hang')) {
        const child = +readFileSync(pid, 'utf8')
        throws(() => process.kill(child, 0), /ESRCH/, `${state}: child is dead despite ignoring SIGTERM`)
      }
    }
    is(readFileSync(builds, 'utf8').trim().split('\n').length, 8, 'separate runs rebuild')
    writeFileSync(json, JSON.stringify(baseline))
    ok(run([`--json=${json}`, '--merge', '--allow-unanchored'], join(dir, 'missing')).includes(`[skip] ${id}`), 'missing compiler skips')
    is(read().cases, baseline.cases, 'missing compiler preserves all recorded cases')
    is(read().meta.versions, baseline.meta.versions, 'missing compiler preserves recorded versions')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tov bench: ported source only, checkout identity, parity and failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz tov '))
  try {
    const bin = join(dir, 'tov'), mode = join(dir, 'mode'), json = join(dir, 'results.json')
    const checkout = join(dir, 'src')
    const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim()
    execFileSync('git', ['init', '-q', checkout])
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'tov')
    writeFileSync(mode, 'ok')
    // Stand-in compiler: accepts only the case's own port, emits a binary that
    // prints mandelbrot's oracle checksum (or a failure, per mode).
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2)
if (args[0] === '--version') { console.log('tov 0.0.1'); process.exit(0) }
if (args[0] !== 'build' || args[1] !== ${JSON.stringify(join(ROOT, 'bench/mandelbrot/mandelbrot.tov'))}) process.exit(2)
const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8')
if (mode === 'fail') { console.error('error[T0301] fixture'); process.exit(3) }
const cs = mode === 'wrong' ? 1 : 3520419621
const out = args[args.indexOf('-o') + 1]
fs.writeFileSync(out, '#!/bin/sh\\necho median_us=10 checksum=' + cs + ' samples=65536 stages=256 runs=21\\n')
fs.chmodSync(out, 0o755)
`)
    chmodSync(bin, 0o755)
    const run = (compiler = bin, src = checkout) => execFileSync(process.execPath, [
      join(ROOT, 'bench/bench.mjs'), '--targets=tov', '--cases=mandelbrot,alpha', '--no-web', `--json=${json}`,
    ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TOV_BIN: compiler, TOV_DIR: src,
      JZ_BENCH_BUILD_DIR: join(dir, 'build'), JZ_BENCH_WEB_DIR: join(dir, 'web') } })
    const read = () => JSON.parse(readFileSync(json, 'utf8'))
    ok(run().includes('[skip] tov'), 'a case without a .tov port is skipped')
    const r = read()
    is(r.cases.mandelbrot.targets.tov.parity, 'ok', 'port checksum matches the corpus oracle')
    ok(r.cases.mandelbrot.targets.tov.bytes > 0, 'artifact size is recorded')
    is(r.cases.alpha?.targets.tov, undefined, 'unported case has no row')
    is(r.meta.versions.tov, `tov 0.0.1 [git ${git('log', '-1', '--format=%h %cs')}]`, 'version names the checkout commit')
    ok(r.meta.invocations.tov.startsWith('tov build <case>.tov'), 'invocation is recorded')
    run(bin, join(dir, 'no-checkout'))
    is(read().meta.versions.tov, 'tov 0.0.1', 'without a checkout the version text stands alone')
    writeFileSync(mode, 'wrong')
    run()
    is(read().cases.mandelbrot.targets.tov.parity, 'DIFF', 'wrong answer is labeled')
    writeFileSync(mode, 'fail')
    run()
    const failed = read().cases.mandelbrot.targets.tov
    is(failed.status, 'fail', 'rejected port records a failure')
    ok(/T0301/.test(failed.reason), 'the compiler diagnostic is kept: ' + failed.reason)
    ok(run(join(dir, 'missing')).includes('[skip] tov'), 'missing compiler skips')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
