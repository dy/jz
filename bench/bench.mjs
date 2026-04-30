#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BENCH_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = join(BENCH_DIR, '..')
const LIB = join(BENCH_DIR, '_lib')
const BUILD = process.env.JZ_BENCH_BUILD_DIR || join(tmpdir(), 'jz-bench')
const WABT_W2C_DIR = process.env.WABT_W2C_DIR || '/Users/div/projects/wabt/wasm2c'
const LOCAL_PORFFOR_BIN = '/tmp/jz-bench-tools/node_modules/.bin/porf'
const PORFFOR_BIN = process.env.PORFFOR_BIN || (existsSync(LOCAL_PORFFOR_BIN) ? LOCAL_PORFFOR_BIN : 'porf')
const PORFFOR_TIMEOUT_MS = Number(process.env.PORFFOR_TIMEOUT_MS || 5000)
const BUN_BIN = process.env.BUN_BIN || 'bun'
const DENO_BIN = process.env.DENO_BIN || 'deno'
const HERMES_BIN = process.env.HERMES_BIN || 'hermes'
const GRAALJS_BIN = process.env.GRAALJS_BIN || 'graaljs'
const SPIDERMONKEY_BIN = process.env.SPIDERMONKEY_BIN || ''

mkdirSync(BUILD, { recursive: true })

const CASE_NAMES = {
  biquad: 'biquad filter cascade',
  mat4: 'mat4 multiply',
  poly: 'polymorphic reduce',
  bitwise: 'bitwise mix',
  tokenizer: 'tokenizer scan',
  callback: 'callback map',
  aos: 'AoS to SoA',
  json: 'JSON parse walk',
}

const has = cmd => cmd.includes('/') ? existsSync(cmd) : spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0
const versionText = cmd => {
  try {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' })
    return `${r.stdout || ''}${r.stderr || ''}`
  } catch {
    return ''
  }
}
const canRun = cmd => {
  try { return spawnSync(cmd, ['--help'], { stdio: 'ignore' }).status === 0 }
  catch { return false }
}
const firstAvailable = cmds => cmds.find(cmd => has(cmd)) || ''
const spiderMonkeyBin = () => {
  if (SPIDERMONKEY_BIN) return SPIDERMONKEY_BIN
  return firstAvailable(['spidermonkey', 'sm', 'js128', 'js115', 'js102', 'js'])
}
const graalJsBin = () => {
  if (has(GRAALJS_BIN)) return GRAALJS_BIN
  if (has('js') && /graal/i.test(versionText('js'))) return 'js'
  return ''
}
const cIdent = s => s.replace(/[^A-Za-z0-9_]/g, '_')
const build = (...p) => join(BUILD, ...p)
const caseBuild = c => build(c.id)

const discoverCases = () => readdirSync(BENCH_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(BENCH_DIR, d.name, `${d.name}.js`)))
  .map(d => {
    const dir = join(BENCH_DIR, d.name)
    return {
      id: d.name,
      name: CASE_NAMES[d.name] || d.name,
      dir,
      js: join(dir, `${d.name}.js`),
      c: existsSync(join(dir, `${d.name}.c`)) ? join(dir, `${d.name}.c`) : null,
      rs: existsSync(join(dir, `${d.name}.rs`)) ? join(dir, `${d.name}.rs`) : null,
      go: existsSync(join(dir, `${d.name}.go`)) ? join(dir, `${d.name}.go`) : null,
      zig: existsSync(join(dir, `${d.name}.zig`)) ? join(dir, `${d.name}.zig`) : null,
      as: existsSync(join(dir, `${d.name}.as.ts`)) ? join(dir, `${d.name}.as.ts`) : null,
      py: existsSync(join(dir, `${d.name}.py`)) ? join(dir, `${d.name}.py`) : null,
      npy: existsSync(join(dir, `${d.name}.npy.py`)) ? join(dir, `${d.name}.npy.py`) : null,
      wat: existsSync(join(dir, `${d.name}.wat`)) ? join(dir, `${d.name}.wat`) : null,
      watRun: existsSync(join(dir, 'run-wat.mjs')) ? join(dir, 'run-wat.mjs') : null,
      flat: existsSync(join(dir, `${d.name}-flat.js`)) ? join(dir, `${d.name}-flat.js`) : null,
    }
  })
  .sort((a, b) => Object.keys(CASE_NAMES).indexOf(a.id) - Object.keys(CASE_NAMES).indexOf(b.id))

const parseLine = stdout => {
  const m = stdout.match(/median_us=(\d+)\s+checksum=(-?\d+)\s+samples=(\d+)\s+stages=(\d+)\s+runs=(\d+)/)
  if (!m) return null
  return { medianUs: +m[1], checksum: (+m[2]) >>> 0, samples: +m[3], stages: +m[4], runs: +m[5] }
}

const runProc = (argv, opts = {}) => {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: BENCH_DIR,
    encoding: 'utf8',
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
  })
  if (r.error?.code === 'ETIMEDOUT') return { error: `timeout after ${opts.timeout}ms` }
  if (r.status !== 0) return { error: `exit ${r.status}: ${(r.stderr || r.stdout || r.signal || '').trim().slice(0, 240)}` }
  const parsed = parseLine(r.stdout)
  if (!parsed) return { error: `unparseable stdout: ${(r.stdout || r.stderr || '').trim().slice(0, 240)}` }
  return parsed
}

const tryRun = (id, c, prep, argv, opts = {}) => {
  try {
    mkdirSync(caseBuild(c), { recursive: true })
    if (prep) prep()
    const parsed = runProc(argv, opts)
    return parsed.error ? { id, error: parsed.error } : { id, ...parsed }
  } catch (e) {
    return { id, error: e.message }
  }
}

const wasmPath = c => join(caseBuild(c), `${c.id}.wasm`)
const flatPath = c => join(caseBuild(c), `${c.id}-flat.js`)
const rustPath = c => join(caseBuild(c), `${c.id}-rust`)
const goPath = c => join(caseBuild(c), `${c.id}-go`)
const zigPath = c => join(caseBuild(c), `${c.id}-zig`)
const asWasmPath = c => join(caseBuild(c), `${c.id}.as.wasm`)

const compileJz = c => {
  execFileSync('node', [join(ROOT, 'cli.js'), c.js, '-o', wasmPath(c)], { cwd: BENCH_DIR, stdio: 'pipe' })
}

const writeFlat = c => {
  let out = `const __benchGlobal = typeof globalThis !== 'undefined' ? globalThis : this
if (typeof __benchGlobal.console === 'undefined' && typeof print === 'function') __benchGlobal.console = { log: print }
if (typeof __benchGlobal.performance === 'undefined') __benchGlobal.performance = { now: typeof dateNow === 'function' ? dateNow : () => Date.now() }
`
  let src = readFileSync(c.js, 'utf8')
  if (src.includes('../_lib/benchlib.js')) {
    out += readFileSync(join(LIB, 'benchlib.js'), 'utf8').replace(/\bexport let\b/g, 'const') + '\n'
    src = src.replace(/^import\s+\{[^}]+\}\s+from\s+['"]\.\.\/_lib\/benchlib\.js['"]\s*\n/, '')
  }
  out += src.replace(/\bexport let main\b/, 'const main') + '\nmain()\n'
  writeFileSync(flatPath(c), out)
}

const w2cHost = (c, hFile) => {
  const mod = cIdent(c.id)
  return `#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "wasm-rt.h"
#include "${hFile}"

w2c_${mod}* g_inst = NULL;

u32 w2c_wasi__snapshot__preview1_fd_write(struct w2c_wasi__snapshot__preview1* ctx,
                                          u32 fd, u32 iovs_ptr, u32 iovs_len,
                                          u32 nwritten_ptr) {
  (void)ctx;
  uint8_t* mem = (uint8_t*)w2c_${mod}_memory(g_inst)->data;
  u32 total = 0;
  for (u32 i = 0; i < iovs_len; i++) {
    u32 buf_ptr, buf_len;
    memcpy(&buf_ptr, mem + iovs_ptr + i * 8, 4);
    memcpy(&buf_len, mem + iovs_ptr + i * 8 + 4, 4);
    if (fd == 1) fwrite(mem + buf_ptr, 1, buf_len, stdout);
    total += buf_len;
  }
  memcpy(mem + nwritten_ptr, &total, 4);
  return 0;
}

u32 w2c_wasi__snapshot__preview1_clock_time_get(struct w2c_wasi__snapshot__preview1* ctx,
                                                u32 clock_id, u64 precision,
                                                u32 time_ptr) {
  (void)ctx; (void)clock_id; (void)precision;
  uint8_t* mem = (uint8_t*)w2c_${mod}_memory(g_inst)->data;
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  u64 ns = (u64)ts.tv_sec * 1000000000ull + (u64)ts.tv_nsec;
  memcpy(mem + time_ptr, &ns, 8);
  return 0;
}

int main(void) {
  wasm_rt_init();
  w2c_${mod} inst;
  g_inst = &inst;
  wasm2c_${mod}_instantiate(&inst, NULL);
  w2c_${mod}_main(&inst);
  wasm2c_${mod}_free(&inst);
  wasm_rt_free();
  return 0;
}
`
}

const watWasmPath = c => join(caseBuild(c), `${c.id}-wat.wasm`)
const jawsmWasmPath = c => join(caseBuild(c), `${c.id}-jawsm.wasm`)
const w2cBinPath = c => join(caseBuild(c), `${c.id}-w2c`)
const natBinPath = c => join(caseBuild(c), `${c.id}-nat`)
const natgccBinPath = c => join(caseBuild(c), `${c.id}-natgcc`)

const targets = {
  nat: {
    name: 'native C (clang -O3)',
    available: c => !!c.c && has('clang'),
    bin: natBinPath,
    run: c => tryRun('nat', c, () => {
      execFileSync('clang', ['-O3', '-ffp-contract=off', '-o', natBinPath(c), c.c], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, [natBinPath(c)]),
  },
  natgcc: {
    name: 'native C (gcc -O3)',
    available: c => !!c.c && has('gcc') && spawnSync('gcc', ['--version'], { encoding: 'utf8' }).stdout.includes('gcc'),
    bin: natgccBinPath,
    run: c => tryRun('natgcc', c, () => {
      execFileSync('gcc', ['-O3', '-ffp-contract=off', '-o', natgccBinPath(c), c.c], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, [natgccBinPath(c)]),
  },
  rust: {
    name: 'Rust (rustc -O)',
    available: c => !!c.rs && has('rustc'),
    bin: rustPath,
    run: c => tryRun('rust', c, () => {
      execFileSync('rustc', ['-C', 'opt-level=3', '-C', 'target-cpu=native', '-o', rustPath(c), c.rs], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, [rustPath(c)]),
  },
  go: {
    name: 'Go (gc)',
    available: c => !!c.go && has('go'),
    bin: goPath,
    run: c => tryRun('go', c, () => {
      const goCache = build('go-cache')
      mkdirSync(goCache, { recursive: true })
      execFileSync('go', ['build', '-o', goPath(c), c.go], {
        cwd: BENCH_DIR,
        stdio: 'pipe',
        env: { ...process.env, GOCACHE: goCache },
      })
    }, [goPath(c)]),
  },
  zig: {
    name: 'Zig (ReleaseFast)',
    available: c => !!c.zig && has('zig'),
    bin: zigPath,
    run: c => tryRun('zig', c, () => {
      execFileSync('zig', ['build-exe', c.zig, '-O', 'ReleaseFast', '-femit-bin=' + zigPath(c)], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, [zigPath(c)]),
  },
  python: {
    name: 'Python (CPython)',
    available: c => !!c.py && has('python3'),
    bin: c => c.py,
    run: c => tryRun('python', c, null, ['python3', c.py]),
  },
  numpy: {
    name: 'Python (NumPy)',
    available: c => !!c.npy && has('python3') && spawnSync('python3', ['-c', 'import numpy'], { stdio: 'ignore' }).status === 0,
    bin: c => c.npy,
    run: c => tryRun('numpy', c, null, ['python3', c.npy]),
  },
  wat: {
    name: 'hand-WAT → V8 wasm',
    available: c => !!c.watRun && has('node') && has('wat2wasm'),
    bin: c => existsSync(watWasmPath(c)) ? watWasmPath(c) : (c.wat || null),
    run: c => tryRun('wat', c, null, ['node', c.watRun]),
  },
  v8: {
    name: 'V8 (node)',
    available: () => has('node'),
    bin: c => c.js,
    run: c => tryRun('v8', c, null, ['node', join(LIB, 'run-v8.mjs'), c.js]),
  },
  deno: {
    name: 'V8 (deno)',
    available: () => has(DENO_BIN),
    bin: c => c.js,
    run: c => tryRun('deno', c, null, [DENO_BIN, 'run', '--allow-read', join(LIB, 'run-v8.mjs'), c.js]),
  },
  bun: {
    name: 'JavaScriptCore (bun)',
    available: () => has(BUN_BIN),
    bin: c => c.js,
    run: c => tryRun('bun', c, null, [BUN_BIN, join(LIB, 'run-v8.mjs'), c.js]),
  },
  spidermonkey: {
    name: 'SpiderMonkey shell',
    available: () => !!spiderMonkeyBin(),
    bin: flatPath,
    run: c => tryRun('spidermonkey', c, () => writeFlat(c), [spiderMonkeyBin(), flatPath(c)]),
  },
  hermes: {
    name: 'Hermes',
    available: () => has(HERMES_BIN),
    bin: flatPath,
    run: c => tryRun('hermes', c, () => writeFlat(c), [HERMES_BIN, flatPath(c)]),
  },
  graaljs: {
    name: 'GraalJS',
    available: () => !!graalJsBin(),
    bin: flatPath,
    run: c => tryRun('graaljs', c, () => writeFlat(c), [graalJsBin(), flatPath(c)]),
  },
  qjs: {
    name: 'QuickJS (qjs)',
    available: () => has('qjs'),
    bin: flatPath,
    run: c => tryRun('qjs', c, () => writeFlat(c), ['qjs', '--std', flatPath(c)]),
  },
  jz: {
    name: 'jz → V8 wasm',
    available: () => has('node'),
    bin: wasmPath,
    run: c => tryRun('jz', c, () => compileJz(c), ['node', join(LIB, 'run-wasm.mjs'), wasmPath(c)]),
  },
  as: {
    name: 'AssemblyScript (asc -O3)',
    available: c => !!c.as && has('asc'),
    bin: asWasmPath,
    run: c => tryRun('as', c, () => {
      execFileSync('asc', [c.as, '-O3', '--runtime', 'stub', '--noAssert', '-o', asWasmPath(c)], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, ['node', join(LIB, 'run-as.mjs'), asWasmPath(c)]),
  },
  porffor: {
    name: 'Porffor (wasm, -O3)',
    available: () => canRun(PORFFOR_BIN),
    bin: flatPath,
    run: c => tryRun('porffor', c, () => writeFlat(c), [PORFFOR_BIN, '-O3', flatPath(c)], { timeout: PORFFOR_TIMEOUT_MS }),
  },
  'jz-wasmtime': {
    name: 'jz → wasmtime',
    available: () => has('wasmtime'),
    bin: wasmPath,
    run: c => tryRun('jz-wasmtime', c, () => compileJz(c), ['wasmtime', '--invoke', 'main', wasmPath(c)]),
  },
  'jz-w2c': {
    name: 'jz → wasm2c → clang -O3',
    available: () => has('wasm2c') && has('clang') && existsSync(join(WABT_W2C_DIR, 'wasm-rt-impl.c')),
    bin: w2cBinPath,
    run: c => tryRun('jz-w2c', c, () => {
      compileJz(c)
      const cFile = join(caseBuild(c), `${c.id}-w2c.c`)
      const hFile = `${c.id}-w2c.h`
      const host = join(caseBuild(c), `${c.id}-w2c-host.c`)
      execFileSync('wasm2c', [wasmPath(c), '-o', cFile], { cwd: BENCH_DIR, stdio: 'pipe' })
      writeFileSync(host, w2cHost(c, hFile))
      execFileSync('clang', ['-O3', '-ffp-contract=off', `-I${WABT_W2C_DIR}`, host, cFile, join(WABT_W2C_DIR, 'wasm-rt-impl.c'), join(WABT_W2C_DIR, 'wasm-rt-mem-impl.c'), '-o', w2cBinPath(c)], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, [w2cBinPath(c)]),
  },
  jawsm: {
    name: 'jawsm (wasm)',
    available: () => has('jawsm'),
    bin: jawsmWasmPath,
    run: c => tryRun('jawsm', c, () => {
      execFileSync('jawsm', [c.js, '-o', jawsmWasmPath(c)], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, ['node', join(LIB, 'run-wasm.mjs'), jawsmWasmPath(c)]),
  },
}

const allCases = discoverCases()
const caseById = Object.fromEntries(allCases.map(c => [c.id, c]))
const targetIds = Object.keys(targets)
const targetIdWidth = Math.max(11, ...targetIds.map(id => id.length))
let selectedCases = allCases.map(c => c.id)
let selectedTargets = targetIds

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--targets=')) selectedTargets = arg.slice(10).split(',').filter(Boolean)
  else if (arg.startsWith('--cases=')) selectedCases = arg.slice(8).split(',').filter(Boolean)
  else if (arg.startsWith('--workloads=')) selectedCases = arg.slice(12).split(',').filter(Boolean)
  else if (targetIds.includes(arg)) selectedTargets = [arg]
  else if (caseById[arg]) selectedCases = [arg]
  else { console.error(`unknown case/target: ${arg}`); process.exitCode = 2 }
}
if (process.exitCode) process.exit(process.exitCode)

for (const id of selectedTargets) if (!targets[id]) { console.error(`unknown target: ${id}`); process.exit(2) }
for (const id of selectedCases) if (!caseById[id]) { console.error(`unknown case: ${id}`); process.exit(2) }

for (const cid of selectedCases) {
  const c = caseById[cid]
  console.log(`\n# ${c.name} (${c.id})`)
  const results = []
  for (const tid of selectedTargets) {
    const t = targets[tid]
    if (!t.available(c)) {
      console.log(`[skip] ${tid.padEnd(targetIdWidth)} ${t.name}`)
      continue
    }
    process.stdout.write(`[run]  ${tid.padEnd(targetIdWidth)} ${t.name} … `)
    const r = t.run(c)
    if (r.error) { console.log(`FAIL — ${r.error}`); continue }
    console.log(`${r.medianUs} µs  cs=${r.checksum}`)
    results.push(r)
  }

  if (!results.length) continue

  const fmtSize = bytes => {
    if (bytes == null) return '—'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }
  const sizeOf = id => {
    const t = targets[id]
    if (!t.bin) return null
    const p = t.bin(c)
    if (!p || !existsSync(p)) return null
    try { return statSync(p).size } catch { return null }
  }

  for (const r of results) r.bytes = sizeOf(r.id)
  // Known parity classes per case — currently just FMA-fused biquad on arm64 NEON.
  const fmaChecksums = { biquad: 1814592024 }
  const fmaCs = fmaChecksums[c.id]

  const csCounts = {}
  for (const r of results) {
    if (r.checksum === fmaCs) continue
    csCounts[r.checksum] = (csCounts[r.checksum] || 0) + 1
  }
  const refCs = +(Object.entries(csCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? results[0].checksum)
  const nat = results.find(r => r.id === 'nat')
  const baseline = nat || [...results].sort((a, b) => a.medianUs - b.medianUs)[0]

  console.log()
  console.log(`samples=${results[0].samples} stages=${results[0].stages} runs=${results[0].runs} reference_checksum=${refCs}`)
  console.log(`  ${'target'.padEnd(28)}  ${'median'.padStart(10)}  ${'×base'.padStart(8)}  ${'throughput'.padStart(10)}  ${'size'.padStart(10)}  ${'parity'.padStart(8)}`)
  console.log(`  ${'-'.repeat(28)}  ${'-'.repeat(10)}  ${'-'.repeat(8)}  ${'-'.repeat(10)}  ${'-'.repeat(10)}  ${'-'.repeat(8)}`)
  for (const r of [...results].sort((a, b) => a.medianUs - b.medianUs)) {
    const ms = (r.medianUs / 1000).toFixed(2) + ' ms'
    const ratio = (r.medianUs / baseline.medianUs).toFixed(2) + '×'
    const throughput = (r.samples / r.medianUs).toFixed(2)
    const size = fmtSize(r.bytes)
    const parity = r.checksum === refCs ? 'ok'
      : r.checksum === fmaCs ? 'fma'
      : 'DIFF'
    console.log(`  ${targets[r.id].name.padEnd(28)}  ${ms.padStart(10)}  ${ratio.padStart(8)}  ${throughput.padStart(10)}  ${size.padStart(10)}  ${parity.padStart(8)}`)
  }
}
