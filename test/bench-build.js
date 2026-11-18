import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '../index.js'
import { instantiate } from '../interop.js'
import { compileJzAt } from '../bench/_lib/compile.js'
import { mix } from '../bench/_lib/benchlib.js'
import { releaseBytes, wasmStrippedBytes } from '../bench/_lib/release-bytes.js'
import { FIRST_MS, SETTLE_MS, countOf, settle, settleSource } from '../bench/_lib/passes.js'
import vm from 'node:vm'
import { compile as watr } from 'watr'
import { agreement, exactAgreement, channelsAgree, agrees } from '../bench/_audiojs/compare.mjs'

const ROOT = join(import.meta.dirname, '..')

// The host ABI's tests run one pass (JZ_BENCH_PASSES=first); the pass rule has its own below.
const runHost = (source, passes = 'first') => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-bench-host-'))
  try {
    const file = join(dir, 'case.wasm')
    writeFileSync(file, compile(source, { host: 'js', optimize: { alloc: false }, imports: {
      env: { logResult: { params: 5 } },
      performance: { now: { params: 0, returns: 'number' } },
      'optional-device': { absent: { params: 0 } },
    } }))
    const result = spawnSync(process.execPath, [join(ROOT, 'bench/_lib/run-jz-host.mjs'), file], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 26, env: { ...process.env, JZ_BENCH_PASSES: passes },
    })
    if (result.error) throw result.error
    return result
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('bench host: deferred initialization completes before the first kernel call', () => {
  const result = runHost(`
    const data = new Float64Array([performance.now() >= 0 ? 7 : 0])
    export function main() { env.logResult(0, data[0], data.length, 1, 1) }
  `)
  is(result.status, 0, result.stderr)
  is(result.stdout.trim(), 'median_us=0 checksum=7 samples=1 stages=1 runs=1\npasses=1')
})

test('bench host: deferred initialization and host globals use the runtime bridge once', () => {
  const result = runHost(`
    const host = globalThis
    host.__jzBenchInitCount = (host.__jzBenchInitCount || 0) + 1
    const data = new Float64Array([host.Math.abs(-7)])
    function run(n) {
      let sum = 0
      for (let i = 0; i < n; i++) sum += data[0]
      env.logResult(0, sum + host.__jzBenchInitCount * 100, n, 1, 1)
    }
    export function main() {
      run(0); run(2); run(2); run(1); run(0)
    }
  `)
  is(result.status, 0, result.stderr)
  is(result.stdout.trim().split('\n'), [...[0, 2, 2, 1, 0].map(n =>
    `median_us=0 checksum=${100 + 7 * n} samples=${n} stages=1 runs=1`), 'passes=1'])
})

test('bench host: absent graph imports stay undefined and the clock returns numbers', () => {
  const result = runHost(`
    import { absent } from 'optional-device'
    export function main() {
      const start = performance.now(), end = performance.now()
      const result = absent() === undefined && end >= start && start >= 0
      env.logResult(0, result ? 1 : 0, 0, 1, 1)
    }
  `)
  is(result.status, 0, result.stderr)
  is(result.stdout.trim(), 'median_us=0 checksum=1 samples=0 stages=1 runs=1\npasses=1')
})

test('bench host: missing entry points and unsupported host calls fail visibly', () => {
  const missing = runHost('export function other() { return 1 }')
  is(missing.status, 2)
  ok(missing.stderr.includes('wasm has no exported main()'))
  const unsupported = runHost('export function main() { return globalThis.__jzMissingBenchMethod() }')
  is(unsupported.status, 1)
  ok(unsupported.stderr.includes('__jzMissingBenchMethod'), 'the missing method names the failure')
  is(unsupported.stdout, '', 'a failure cannot report benchmark results')
})

// The pass rule (bench/_lib/passes.js) on a fake clock: a pass of `ms` each, the start of
// every pass, and the count the rule answers, which must be the passes it ran.
const settled = async (ms, n) => {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  let now = 0
  const starts = []
  Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true, writable: true })
  try { is(await settle(() => { starts.push(now); now += ms }, n), starts.length, 'the rule answers the passes it ran') }
  finally { Object.defineProperty(globalThis, 'performance', real) }
  return starts
}

test('bench passes: the pass after the settling time is counted, a long first pass alone', async () => {
  is(await settled(100), [0, 100, 200, 300], 'a short pass repeats until SETTLE_MS, then once more')
  is(await settled(SETTLE_MS), [0, SETTLE_MS], 'a pass of the settling time runs twice')
  is(await settled(FIRST_MS - 1), [0, FIRST_MS - 1], 'a first pass short of FIRST_MS runs twice')
  is(await settled(FIRST_MS), [0], 'a first pass of FIRST_MS counts as it is')
  is(await settled(1, countOf('first')), [0], 'the old protocol runs the first pass alone')
  is(await settled(FIRST_MS, countOf('2')), [0, FIRST_MS], 'a count runs that many passes, however long')
  ok((await settled(7)).at(-1) >= SETTLE_MS, 'the counted pass begins after the settling time')
  is(countOf(undefined), 0, 'unset, the rule')
  let thrown = null
  try { countOf('frist') } catch (e) { thrown = e.message }
  ok(thrown?.includes("'first' or a count"), 'a value of the switch it does not know fails, never runs the rule unasked')
})

// The shells run the rule from source text (bench.mjs writeFlat): it prints its count too.
test('bench passes: the shells\' rule prints its count after the last pass', async () => {
  const out = [], line = 'median_us=1 checksum=1 samples=1 stages=1 runs=1'
  await vm.runInNewContext(`const main = () => console.log('${line}')\n;${settleSource('main')}`,
    { console: { log: s => out.push(s) }, performance })
  ok(out.length > 2, `${out.length - 1} passes`)
  is(out.at(-1), `passes=${out.length - 1}`, 'the count follows the last pass and counts every line')
  is([...new Set(out.slice(0, -1))], [line], 'every other line a pass\'s')
})

// FIRST_MS proves a long first pass's timed runs began after SETTLE_MS only while its
// warm-ups are at least SETTLE_MS / FIRST_MS of its runs, in every case and held-out driver.
test('bench passes: every program warms up the share of its runs FIRST_MS takes', () => {
  const programs = readdirSync(join(ROOT, 'bench'), { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(ROOT, 'bench', d.name, `${d.name}.js`)))
    .map(d => join('bench', d.name, `${d.name}.js`)).concat('scripts/heldout.mjs')
  const short = programs.filter(file => {
    const src = readFileSync(join(ROOT, file), 'utf8')
    const w = +/\bN_WARMUP = (\d+)/.exec(src)?.[1], r = +/\bN_RUNS = (\d+)/.exec(src)?.[1]
    return !(w / (w + r) >= SETTLE_MS / FIRST_MS)
  })
  ok(programs.length > 100, `${programs.length} programs read`)
  is(short, [], 'warm-ups under the share, or no N_WARMUP and N_RUNS to read')
})

test('bench host: a pass is a fresh instance, repeated until the engine has run it the settling time', () => {
  const source = `
    let calls = 0
    export function main() { calls++; env.logResult(calls, 7 + calls, 1, 1, 1) }
  `
  const rule = runHost(source, '')
  is(rule.status, 0, rule.stderr)
  const lines = rule.stdout.trim().split('\n'), count = lines.pop()
  ok(lines.length > 2, `${lines.length} passes`)
  is(count, `passes=${lines.length}`, 'the rule\'s count, after the last pass, is the lines printed')
  is([...new Set(lines)], ['median_us=1 checksum=8 samples=1 stages=1 runs=1'], 'every pass starts its module state over')
  is(runHost(source).stdout.trim(), `${lines[0]}\npasses=1`, 'JZ_BENCH_PASSES=first runs the first pass alone')
})

// A module of MoonBit's shape (`moon build --target wasm`: WASI's fd_write, moonrun's two
// clock imports, `memory` and `_start`) run by _lib/run-moonbit.mjs. Its `_start` adds one
// to the checksum's digit in its memory before printing: a reused instance would answer 9.
test('bench moonbit: moonrun\'s imports under Node, a fresh instance a pass, by the rule', () => {
  const line = 'median_us=1 checksum=7 samples=1 stages=1 runs=1\n', at = 16, digit = at + line.indexOf('7')
  const bytes = watr(`(module
    (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
    (import "__moonbit_time_unstable" "instant_now" (func $now (result externref)))
    (import "__moonbit_time_unstable" "instant_elapsed_as_secs_f64" (func $since (param externref) (result f64)))
    (memory (export "memory") 1)
    (data (i32.const ${at}) "${line.replace('\n', '\\0a')}")
    (func (export "_start") (local $t externref)
      (local.set $t (call $now))
      (i32.store8 (i32.const ${digit}) (i32.add (i32.load8_u (i32.const ${digit})) (i32.const 1)))
      (if (f64.lt (call $since (local.get $t)) (f64.const 0)) (then unreachable))
      (i32.store (i32.const 0) (i32.const ${at}))
      (i32.store (i32.const 4) (i32.const ${line.length}))
      (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))))`)
  const dir = mkdtempSync(join(tmpdir(), 'jz-bench-moonbit-'))
  try {
    const file = join(dir, 'src.wasm')
    writeFileSync(file, bytes)
    const run = passes => spawnSync(process.execPath, ['--no-warnings', join(ROOT, 'bench/_lib/run-moonbit.mjs'), file],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 26, env: { ...process.env, JZ_BENCH_PASSES: passes } })
    const rule = run('')
    is(rule.status, 0, rule.stderr)
    const lines = rule.stdout.trim().split('\n'), count = lines.pop()
    ok(lines.length > 2, `${lines.length} passes`)
    is(count, `passes=${lines.length}`, 'the rule\'s count is the lines printed')
    is([...new Set(lines)], [line.trim().replace('checksum=7', 'checksum=8')], 'every pass a fresh instance, the clock read')
    is(run('first').stdout, `${line.replace('checksum=7', 'checksum=8')}passes=1\n`, 'JZ_BENCH_PASSES=first runs the first pass alone')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bench build: every committed workload is a valid JavaScript module', () => {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
    import { readdirSync, readFileSync, existsSync } from 'node:fs'
    import { join } from 'node:path'
    import { SourceTextModule } from 'node:vm'
    const bench = join(process.argv[1], 'bench')
    for (const entry of readdirSync(bench, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue
      const file = join(bench, entry.name, entry.name + '.js')
      if (existsSync(file)) new SourceTextModule(readFileSync(file, 'utf8'), { identifier: file })
    }
  `, ROOT], { encoding: 'utf8', timeout: 30000 })
  if (result.error) throw result.error
  is(result.status, 0, result.stderr)
})

// A NaN's bits in a Float64Array are the engine's to choose, and the CPU's: x64
// sets the sign of a NaN an invalid operation makes, arm64 does not.
test('bench build: the stdlib sweeps hash a NaN as one encoding', () => {
  for (const file of ['scripts/stdlib-probe.mjs', 'bench/stdlib-dists/stdlib-dists.js', 'bench/stdlib-special/stdlib-special.js']) {
    const body = readFileSync(join(ROOT, file), 'utf8').match(/\nconst checksum = \(out\) => \{[\s\S]*?\n\}/)?.[0]
    ok(body, `${file}: the sweep's checksum`)
    const checksum = new Function('mix', `${body}; return checksum`)(mix)
    const a = new Float64Array([1.5, NaN, -0.25]), b = new Float64Array(a), u = new BigUint64Array(b.buffer)
    u[1] = 0xfff8000000000000n
    is(checksum(b), checksum(a), `${file}: a NaN's sign is not hashed`)
    u[1] = 0x7ff8000000000001n
    is(checksum(b), checksum(a), `${file}: nor its payload`)
    b[2] = 0.25
    ok(checksum(b) !== checksum(a), `${file}: a number's sign is`)
  }
})

// The size column counts a module without debug info, names or toolchain
// metadata, and keeps every other custom section: jz's interop reads its own.
test('bench build: the size column strips debug info and names, in a component\'s modules too', () => {
  const leb = n => { const out = []; do { out.push(n & 0x7f | (n >= 0x80 ? 0x80 : 0)); n >>>= 7 } while (n); return Buffer.from(out) }
  const section = (id, body) => Buffer.concat([Buffer.from([id]), leb(body.length), body])
  const custom = (name, size) => section(0, Buffer.concat([leb(name.length), Buffer.from(name), Buffer.alloc(size, 7)]))
  const core = Buffer.from(compile('export let f = (x) => x * 2'))
  const keep = custom('jz:abi', 40)
  const module = Buffer.concat([core, custom('.debug_info', 300), custom('name', 90), keep, custom('producers', 20), custom('target_features', 9)])
  is(wasmStrippedBytes(module), core.length + keep.length, 'debug, name and toolchain sections go, a runtime\'s stays')
  const component = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]), custom('producers', 30), section(1, module)])
  const inner = core.length + keep.length
  is(wasmStrippedBytes(component), 8 + 1 + leb(inner).length + inner, 'a nested core module is stripped in place')
  const dir = mkdtempSync(join(tmpdir(), 'jz-release-bytes-'))
  try {
    writeFileSync(join(dir, 'case.js'), 'export let main = () => 1\n')
    is(releaseBytes(join(dir, 'case.js'), join(dir, 'tmp')), 26, 'a source counts as it is')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('audio comparison: every channel and encoded byte contributes to the verdict', () => {
  const left = Float32Array.of(1, 2), right = Float32Array.of(3, 4)
  is(agrees(channelsAgree([left, right], [left, right.slice()])), true)
  is(agrees(channelsAgree([left, right], [left, Float32Array.of(3, 5)])), false, 'a matching left channel cannot hide a wrong right channel')
  is(agrees(channelsAgree([left, right], [left])), false, 'a missing channel fails')
  const bytes = new Uint8Array(1 << 20).fill(255), changed = bytes.slice()
  changed[changed.length - 1]--
  is(agrees(agreement(bytes, changed)), true, 'this single-byte difference lies above the DSP rounding threshold')
  is(agrees(exactAgreement(bytes, changed)), false, 'encoded bytes still require exact parity')
  is(agrees(exactAgreement(bytes, bytes.slice())), true)
})

test('audio comparison: rounding, zero and invalid results have explicit verdicts', () => {
  is(agrees(agreement(Float64Array.of(1, 2), Float64Array.of(1, 2 + 1e-10))), true)
  is(agrees(agreement(Float64Array.of(1, 2), Float64Array.of(1, 3))), false)
  is(agrees(agreement(Float64Array.of(0), Float64Array.of(-0))), true, 'signed zero has zero numerical error')
  is(agrees(agreement(Float64Array.of(1), Float64Array.of(NaN))), false)
  is(agrees(agreement(Float64Array.of(1, 2), Float64Array.of(1))), false)
  is(agrees(agreement(Float64Array.of(1), Float64Array.of(1 + 10 ** (-99.9 / 20)))), false, 'rounding the reported dB cannot cross the acceptance threshold')
  is(agrees('99 dB'), false)
  is(agrees('100 dB'), true)
})

for (const id of ['worley', 'stdlib-erf']) test(`bench build: ${id} size binary agrees with the unchanged JavaScript workload`, async () => {
  const entry = join(ROOT, 'bench', id, `${id}.js`)
  const bytes = compileJzAt({ id, js: entry }, { level: 'size' })
  let actual, expected
  const wasm = instantiate(bytes, { imports: {
    env: { logResult: (...row) => { actual = row; actual[1] >>>= 0 } },
    performance: { now: () => performance.now() },
  } }).exports
  const node = await import(entry)
  const log = console.log
  console.log = line => {
    const m = /^median_us=(\d+) checksum=(\d+) samples=(\d+) stages=(\d+) runs=(\d+)$/.exec(line)
    if (!m) throw Error(`unexpected bench output: ${line}`)
    expected = m.slice(1).map(Number)
  }
  try { node.main() } finally { console.log = log }
  wasm.main()
  ok(actual && expected, 'both targets reported')
  is(actual.slice(1), expected.slice(1), 'checksum and workload metadata agree')
})

test('bench build: a failed size compilation fails the command and names the cause', () => {
  const script = join(ROOT, 'scripts/bench-size.mjs')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    const read = fs.readFileSync
    fs.readFileSync = (path, ...args) => String(path).endsWith('/bench/lz/lz.js')
      ? 'export let main = () => {' : read(path, ...args)
    syncBuiltinESMExports()
    process.argv = [process.execPath, ${JSON.stringify(script)}, 'lz', '--json']
    await import(${JSON.stringify(new URL('../scripts/bench-size.mjs', import.meta.url).href)})
  `], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: '' } })
  if (result.error) throw result.error
  is(result.status, 1, 'a blank size cannot be a successful run')
  ok(result.stderr.includes('lz: jz compilation failed:'), 'the failing case and compiler error are visible')
  ok(result.stdout.includes('SIZE lz jz= '), 'the record retains the failed case')
})

test('bench build: an isolated compiler crash preserves the failure and later size rows', () => {
  const script = join(ROOT, 'scripts/bench-size.mjs')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import cp from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    const spawn = cp.spawnSync
    cp.spawnSync = (cmd, args, opts) => args?.some(a => a.endsWith('/compile-jz-self.mjs'))
      ? { status: null, signal: 'SIGABRT', stderr: 'heap exhausted' } : spawn(cmd, args, opts)
    syncBuiltinESMExports()
    process.argv = [process.execPath, ${JSON.stringify(script)}, 'jz', 'lz', '--json']
    await import(${JSON.stringify(new URL('../scripts/bench-size.mjs', import.meta.url).href)})
  `], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: '' } })
  if (result.error) throw result.error
  is(result.status, 1, 'the crashed row fails the whole command')
  ok(result.stderr.includes('jz: jz compilation failed: compiler benchmark size build terminated by SIGABRT: heap exhausted'), 'case, signal and cause survive')
  ok(result.stdout.includes('SIZE jz jz= '), 'the crashed case remains in the results')
  ok(/SIZE lz jz=\d+ /.test(result.stdout), 'the following case still compiles')
})

// jz-base builds a case through the checkout at JZ_BASE_ROOT, from that
// checkout's copy of the case: a module-graph case resolves its benchlib (the
// host patch the base's bench build keys by its own path) and its dependencies
// from the case file, and this tree's copy took them from here.
test('bench build: jz-base builds the base checkout\'s own copy of a case', () => {
  const base = mkdtempSync(join(tmpdir(), 'jz-bench-base-')), build = mkdtempSync(join(tmpdir(), 'jz-bench-build-'))
  try {
    mkdirSync(join(base, 'bench/_lib'), { recursive: true })
    mkdirSync(join(base, 'bench/jessie'), { recursive: true })
    writeFileSync(join(base, 'bench/jessie/jessie.js'), '')
    // the base's bench build answers the case file it was handed
    writeFileSync(join(base, 'bench/_lib/compile.js'), 'export const compileJzAt = c => new TextEncoder().encode(c.js)\n')
    spawnSync(process.execPath, [join(ROOT, 'bench/bench.mjs'), '--targets=jz-base', '--cases=jessie'], {
      env: { ...process.env, JZ_BASE_ROOT: base, JZ_BENCH_BUILD_DIR: build }, encoding: 'utf8', timeout: 120000,
    })
    is(readFileSync(join(build, 'jessie/jessie-base-host.wasm'), 'utf8'), join(base, 'bench/jessie/jessie.js'), 'the speed build')
    is(readFileSync(join(build, 'jessie/jessie-base-size.wasm'), 'utf8'), join(base, 'bench/jessie/jessie.js'), 'the size build')
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(build, { recursive: true, force: true })
  }
})
