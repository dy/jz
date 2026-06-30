#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'
import { renderBenchSvg } from '../scripts/bench-svg.mjs'

const BENCH_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = join(BENCH_DIR, '..')
const LIB = join(BENCH_DIR, '_lib')
const BUILD = process.env.JZ_BENCH_BUILD_DIR || join(tmpdir(), 'jz-bench')
const WABT_W2C_DIR = process.env.WABT_W2C_DIR || '/Users/div/projects/wabt/wasm2c'
// wasm2c lowers v128/SIMD ops through the SIMDe header set (`#include <simde/wasm/simd128.h>`),
// vendored in wabt's third_party. Without it on the include path, every SIMD-emitting
// jz case fails to compile to native. Derive it from WABT_W2C_DIR; override via SIMDE_DIR.
const SIMDE_DIR = process.env.SIMDE_DIR || join(WABT_W2C_DIR, '..', 'third_party', 'simde')
// Shared zig timing/print helper (the zig sibling of _lib/bench.h). zig 0.16
// forbids `@import` outside the root file's directory, so the .zig cases reach it
// as a named module via `--dep bench -Mbench=…` rather than a relative path.
const ZIG_LIB = join(LIB, 'bench.zig')
const zigModuleArgs = src => ['--dep', 'bench', `-Mroot=${src}`, `-Mbench=${ZIG_LIB}`]
// Shared MoonBit timing/checksum helper, compiled into each case's `src` package.
const MOONBIT_LIB = join(LIB, 'bench.mbt')
const BUN_BIN = process.env.BUN_BIN || 'bun'
const DENO_BIN = process.env.DENO_BIN || 'deno'
const SHERMES_BIN = process.env.SHERMES_BIN || 'shermes'
const GRAALJS_BIN = process.env.GRAALJS_BIN || 'graaljs'
const SPIDERMONKEY_BIN = process.env.SPIDERMONKEY_BIN || ''
const JSC_BIN = process.env.JSC_BIN || ''
const PORF_BIN = process.env.PORF_BIN || 'porf'

mkdirSync(BUILD, { recursive: true })

const CASE_NAMES = {
  biquad: 'biquad filter cascade',
  mat4: 'mat4 multiply',
  poly: 'polymorphic reduce',
  bitwise: 'bitwise mix',
  tokenizer: 'tokenizer scan',
  callback: 'callback map',
  aos: 'AoS to SoA',
  mandelbrot: 'mandelbrot escape',
  json: 'JSON parse+walk (single literal source)',
  sort: 'in-place heapsort',
  crc32: 'CRC-32 table hash',
  matmul: 'matrix multiply (A·Bᵀ)',
  heat: '2-D heat diffusion (5-point stencil)',
  conv2d: 'int8 conv2d layer (NN inference)',
  qoi: 'QOI image codec (encode + decode)',
  hash: 'MurmurHash3 (x86 32-bit)',
  lz: 'LZSS compress + inflate',
  base64: 'Base64 encode + decode',
  wav: 'WAV PCM-16 encode',
  raytrace: 'sphere ray tracer (closest-hit + Lambert)',
  noise: 'Perlin fBm noise field',
  radixsort: 'LSD radix sort (u32 keys)',
  levenshtein: 'Levenshtein edit-distance DP',
  nqueens: 'N-Queens bitmask backtracking',
  dict: 'open-addressing hash table',
  sieve: 'Sieve of Eratosthenes',
  vm: 'bytecode interpreter dispatch',
  spmv: 'sparse matrix×vector (CSR)',
  watr: 'watr WAT compiler',
  jessie: 'jessie parser',
  jz: 'jz JS compiler (self-host)',
}

// Cases whose source pulls in a real multi-file library: the whole relative-
// import graph resolves to canonical absolute-path keys (same as the CLI).
// `jz` additionally resolves bare node_modules specifiers (watr) — its
// workload IS the compiler (scripts/self.js), so the jz row runs the full
// self-host: jz.wasm compiling JavaScript.
const GRAPH_CASES = new Set(['jessie', 'jz'])
// Self-referential 'compiler' cases (jz/watr/jessie compiling code) are excluded
// from the headline geomean SVG + bench page — a different question from the
// cross-language kernel comparison. Still runnable via --cases and gated in
// test/bench.js.
const HIDDEN_FROM_GEOMEAN = new Set(['watr', 'jessie', 'jz'])
const graphSources = (c) => {
  const g = resolveModuleGraph(c.js, { resolveNode: c.id === 'jz' })
  return { code: g.code, modules: g.modules }
}
// The jz case embeds the whole compiler: its static data segment alone is
// ~450 kB, so the module needs more than the 1-page default to instantiate.
// 64 pages (4 MB) initial; the allocator's geometric memory.grow covers the
// compile arena from there at no measurable cost (browser-friendly floor).
const caseMemory = (c) => c.id === 'jz' ? { memory: 64 } : {}

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
// Safari's engine: the standalone `jsc` shell (same JavaScriptCore as WebKit/Safari).
// Installed via `jsvu --engines=javascriptcore` (→ ~/.jsvu/bin/jsc); set JSC_BIN to override.
const jscBin = () => JSC_BIN || firstAvailable(['jsc', join(process.env.HOME || '', '.jsvu/bin/jsc')])
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
      mbt: existsSync(join(dir, `${d.name}.mbt`)) ? join(dir, `${d.name}.mbt`) : null,
      as: existsSync(join(dir, `${d.name}.as.ts`)) ? join(dir, `${d.name}.as.ts`) : null,
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
const jzHostWasmPath = c => join(caseBuild(c), `${c.id}-host.wasm`)
// Size column reads a dedicated -Os build: the `jz` row reports its SMALLEST
// wasm (the size-tier compile) alongside its FASTEST time (the speed-tier host
// build that `run` measures) — each axis shows jz's best profile, mirroring how
// a real deployment picks -Os for footprint-critical and speed for hot paths.
const jzSizeWasmPath = c => join(caseBuild(c), `${c.id}-size.wasm`)
const flatPath = c => join(caseBuild(c), `${c.id}-flat.js`)
const shermesBinPath = c => join(caseBuild(c), `${c.id}-shermes`)
const rustPath = c => join(caseBuild(c), `${c.id}-rust`)
const goPath = c => join(caseBuild(c), `${c.id}-go`)
const zigPath = c => join(caseBuild(c), `${c.id}-zig`)
const asWasmPath = c => join(caseBuild(c), `${c.id}.as.wasm`)
// AS size column reads its -Osize build (asc's own size tier), the fair mirror
// of jz's -Os size column — each compiler's smallest vs each compiler's fastest.
const asSizeWasmPath = c => join(caseBuild(c), `${c.id}.as.size.wasm`)
// Rival sources compiled to wasm32-wasi (run in node's V8 — same engine as jz):
const rustWasmPath = c => join(caseBuild(c), `${c.id}.rust.wasm`)
const goWasmPath = c => join(caseBuild(c), `${c.id}.go.wasm`)
const zigWasmPath = c => join(caseBuild(c), `${c.id}.zig.wasm`)
const cWasmPath = c => join(caseBuild(c), `${c.id}.c.wasm`)

const compileJz = c => {
  // `jz-wasmtime` / `jz-w2c` consume the wasm standalone — no JS host. Lower
  // `console.log` / `performance.now` to WASI Preview 1 so the module's
  // imports are all satisfiable by wasmtime / wasm-rt without per-target shims.
  // `-O3` (= the `speed` preset compileJzHost uses for the V8 target): without it the CLI
  // defaulted to level 2, silently under-compiling the standalone targets — no reduceUnroll /
  // rotateLoops / inlineFns / relaxedSimd. That cost up to 3.5× on Cranelift (dotprod 760→215µs,
  // hashjoin 11.8k→6.5k, lz 27k→15k), so the wasmtime/w2c rows under-represented jz vs every rival.
  execFileSync('node', [join(ROOT, 'cli.js'), c.js, '--host', 'wasi', '-O3', '-o', wasmPath(c)], { cwd: BENCH_DIR, stdio: 'pipe' })
}

const benchlibHostSource = () => {
  const src = readFileSync(join(LIB, 'benchlib.js'), 'utf8')
  const out = src.replace(`export let printResult = (medianUs, checksum, samples, stages, runs) => {
  console.log(\`median_us=\${medianUs} checksum=\${checksum} samples=\${samples} stages=\${stages} runs=\${runs}\`)
}`, `export let printResult = (medianUs, checksum, samples, stages, runs) => {
  env.logResult(medianUs, checksum, samples, stages, runs)
}`)
  if (out === src) throw Error('failed to patch benchlib printResult for jz')
  return out
}

const watrModuleSources = () => ({
  './watr-compile.js': `import compileWatr from '../../node_modules/watr/src/compile.js'\nexport const compile = (src) => compileWatr(src)\n`,
  '../../node_modules/watr/src/compile.js': readFileSync(join(ROOT, 'node_modules/watr/src/compile.js'), 'utf8'),
  './encode.js': readFileSync(join(ROOT, 'node_modules/watr/src/encode.js'), 'utf8'),
  './const.js': readFileSync(join(ROOT, 'node_modules/watr/src/const.js'), 'utf8'),
  './parse.js': readFileSync(join(ROOT, 'node_modules/watr/src/parse.js'), 'utf8'),
  './util.js': readFileSync(join(ROOT, 'node_modules/watr/src/util.js'), 'utf8'),
})

// Build a case's host wasm at a given optimize level. `level: 'speed'` is the
// row's timed/run build; `level: 'size'` is the -Os build the size column reads.
// Both offload formatting via env.logResult (the benchlibHostSource patch), so
// the comparison to AS — which offloads via @external logLine — is like-for-like.
const compileJzAt = (c, optimize) => {
  const isWatr = c.id === 'watr'
  // Graph cases resolve their whole import graph (GRAPH_CASES), then swap the
  // real benchlib for the env.logResult-patched host build.
  const isGraph = GRAPH_CASES.has(c.id)
  let code, modules
  if (isGraph) {
    ;({ code, modules } = graphSources(c))
    modules[resolve(LIB, 'benchlib.js')] = benchlibHostSource()
  } else {
    code = readFileSync(c.js, 'utf8')
    modules = {
      '../_lib/benchlib.js': benchlibHostSource(),
      ...(isWatr ? watrModuleSources() : {}),
    }
  }
  return compile(code, {
    jzify: isWatr || isGraph,
    modules,
    imports: {
      env: { logResult: { params: 5 } },
      performance: { now: { params: 0, returns: 'number' } },
    },
    optimize,
    alloc: false,
    ...caseMemory(c),
  })
}

const compileJzHost = c => {
  // All benches compile at level 'speed' — full watr inlining + L3 cap/hash
  // tuning. If any pass at this level produces wrong checksums or crashes,
  // that's an optimizer bug to be fixed, not a reason to back off. This is the
  // build `run` times; the size column reads compileJzSize's -Os build instead.
  const wasm = compileJzAt(c, { level: 'speed', ...(process.env.JZ_SIMD ? { vectorizeLaneLocal: true } : {}) })
  writeFileSync(jzHostWasmPath(c), wasm)
}

// -Os build for the size column — jz's smallest wasm for this case (no unroll /
// inline body-duplication the speed tier trades bytes for). Same source, same
// host imports, same memory; only the optimize tier differs.
const compileJzSize = c => {
  writeFileSync(jzSizeWasmPath(c), compileJzAt(c, { level: 'size' }))
}

const writeFlat = c => {
  let out = `const __benchGlobal = typeof globalThis !== 'undefined' ? globalThis : this
if (typeof __benchGlobal.console === 'undefined' && typeof print === 'function') __benchGlobal.console = { log: print }
// Timer: JSC's shell exposes high-res preciseTime() (seconds) but a Spectre-clamped
// performance.now (~0.2ms) — too coarse for µs kernels; prefer preciseTime where present
// (JSC, SpiderMonkey). Else the engine's own performance.now, else dateNow / Date.now.
if (typeof preciseTime === 'function') __benchGlobal.performance = { now: () => preciseTime() * 1000 }
else if (typeof __benchGlobal.performance === 'undefined') __benchGlobal.performance = { now: typeof dateNow === 'function' ? dateNow : () => Date.now() }
`
  let src = readFileSync(c.js, 'utf8')
  if (src.includes('../_lib/benchlib.js')) {
    out += readFileSync(join(LIB, 'benchlib.js'), 'utf8').replace(/\bexport let\b/g, 'const') + '\n'
    src = src.replace(/import\s+\{[^}]+\}\s+from\s+['"]\.\.\/_lib\/benchlib\.js['"]\s*\n?/g, '')
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
const javyWasmPath = c => join(caseBuild(c), `${c.id}.javy.wasm`)
const tinygoWasmPath = c => join(caseBuild(c), `${c.id}.tinygo.wasm`)
const moonbitProjDir = c => join(caseBuild(c), 'mbt')
const moonbitWasmPath = c => join(moonbitProjDir(c), '_b', 'wasm', 'release', 'build', 'src', 'src.wasm')
const w2cBinPath = c => join(caseBuild(c), `${c.id}-w2c`)
const natBinPath = c => join(caseBuild(c), `${c.id}-nat`)
const natgccBinPath = c => join(caseBuild(c), `${c.id}-natgcc`)

// macOS clang/gcc from the Command Line Tools can carry a default sysroot
// pointing at an SDK that no longer exists (a stale MacOSX<ver>.sdk after an
// Xcode bump), so <stdio.h> isn't found and EVERY .c silently fails to compile —
// which is exactly why `nat` quietly drops out of a local bench run. Resolve a
// real SDK via xcrun (fallback: the CLT unversioned symlink) and pass -isysroot.
const macSysrootArgs = (() => {
  if (process.platform !== 'darwin') return []
  const ok = p => { try { return p && existsSync(p) ? p : null } catch { return null } }
  let xc = ''
  try { xc = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).stdout.trim() } catch {}
  const sdk = ok(xc) || ok('/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk')
  return sdk ? ['-isysroot', sdk] : []
})()

const targets = {
  nat: {
    name: 'native C (clang -O3)',
    available: c => !!c.c && has('clang'),
    bin: natBinPath,
    run: c => tryRun('nat', c, () => {
      // native-tuned, symmetric with rustc -C target-cpu=native (arm64 clang rejects -march=native)
      execFileSync('clang', ['-O3', process.arch === 'arm64' ? '-mcpu=native' : '-march=native', '-ffp-contract=off', ...macSysrootArgs, '-o', natBinPath(c), c.c], { cwd: BENCH_DIR, stdio: 'pipe' })
      try { execFileSync('strip', [natBinPath(c)], { cwd: BENCH_DIR, stdio: 'pipe' }) } catch {}
    }, [natBinPath(c)]),
  },
  natgcc: {
    name: 'native C (gcc -O3)',
    available: c => !!c.c && has('gcc') && spawnSync('gcc', ['--version'], { encoding: 'utf8' }).stdout.includes('gcc'),
    bin: natgccBinPath,
    run: c => tryRun('natgcc', c, () => {
      execFileSync('gcc', ['-O3', '-ffp-contract=off', ...macSysrootArgs, '-o', natgccBinPath(c), c.c], { cwd: BENCH_DIR, stdio: 'pipe' })
      try { execFileSync('strip', [natgccBinPath(c)], { cwd: BENCH_DIR, stdio: 'pipe' }) } catch {}
    }, [natgccBinPath(c)]),
  },
  rust: {
    name: 'Rust (rustc -O)',
    available: c => !!c.rs && has('rustc'),
    bin: rustPath,
    run: c => tryRun('rust', c, () => {
      execFileSync('rustc', ['-C', 'opt-level=3', '-C', 'target-cpu=native', '-C', 'link-arg=-s', '-o', rustPath(c), c.rs], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, [rustPath(c)]),
  },
  go: {
    name: 'Go (gc)',
    available: c => !!c.go && has('go'),
    bin: goPath,
    run: c => tryRun('go', c, () => {
      const goCache = build('go-cache')
      mkdirSync(goCache, { recursive: true })
      execFileSync('go', ['build', '-ldflags=-s -w', '-o', goPath(c), c.go], {
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
      const zigCache = build('zig-cache')
      const zigGlobalCache = build('zig-global-cache')
      mkdirSync(zigCache, { recursive: true })
      mkdirSync(zigGlobalCache, { recursive: true })
      execFileSync('zig', ['build-exe', '-O', 'ReleaseFast', '-femit-bin=' + zigPath(c), '--cache-dir', zigCache, '--global-cache-dir', zigGlobalCache, ...zigModuleArgs(c.zig)], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, [zigPath(c)]),
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
    run: c => tryRun('deno', c, null, [DENO_BIN, 'run', '--allow-read', '--allow-env', join(LIB, 'run-v8.mjs'), c.js]),
  },
  bun: {
    name: 'JavaScriptCore (bun)',
    available: () => has(BUN_BIN),
    bin: c => c.js,
    run: c => tryRun('bun', c, null, [BUN_BIN, join(LIB, 'run-v8.mjs'), c.js]),
  },
  // Safari's engine — the standalone JavaScriptCore shell. Runs the flat source like
  // SpiderMonkey/GraalJS (no ES modules / Node APIs); writeFlat shims print + preciseTime.
  jsc: {
    name: 'JavaScriptCore (jsc)',
    available: () => !!jscBin(),
    bin: flatPath,
    run: c => tryRun('jsc', c, () => writeFlat(c), [jscBin(), flatPath(c)]),
  },
  spidermonkey: {
    name: 'SpiderMonkey shell',
    available: () => !!spiderMonkeyBin(),
    bin: flatPath,
    run: c => tryRun('spidermonkey', c, () => writeFlat(c), [spiderMonkeyBin(), flatPath(c)]),
  },
  // Static Hermes — AOT JS → native via C/LLVM. Hand-run reference point:
  // build `shermes` from facebook/hermes (needs the LLVM toolchain) and point
  // SHERMES_BIN at it. Untyped JS compiles too (stays dynamic, still AOT).
  shermes: {
    name: 'Static Hermes (shermes -O → native)',
    available: () => has(SHERMES_BIN),
    bin: shermesBinPath,
    run: c => tryRun('shermes', c, () => {
      writeFlat(c)
      execFileSync(SHERMES_BIN, ['-O', flatPath(c), '-o', shermesBinPath(c)], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, [shermesBinPath(c)]),
  },
  graaljs: {
    name: 'GraalJS',
    available: () => !!graalJsBin(),
    bin: flatPath,
    run: c => tryRun('graaljs', c, () => writeFlat(c), [graalJsBin(), flatPath(c)]),
  },
  porf: {
    name: 'Porffor',
    available: () => has(PORF_BIN),
    bin: flatPath,
    // --allocator-chunks=128 lifts the default 1 MB malloc budget so larger
    // typed arrays (biquad: 3.84 MB, aos: 0.4 MB) don't OOB at runtime.
    run: c => tryRun('porf', c, () => writeFlat(c), [PORF_BIN, '--allocator-chunks=128', 'run', flatPath(c)]),
  },
  jz: {
    name: 'jz → V8 wasm',
    available: () => has('node'),
    // Size column = the -Os build (jz's smallest); timing = the speed build.
    bin: jzSizeWasmPath,
    run: c => tryRun('jz', c, () => { compileJzHost(c); compileJzSize(c) }, ['node', join(LIB, 'run-jz-host.mjs'), jzHostWasmPath(c)]),
  },
  as: {
    name: 'AssemblyScript (asc -O3)',
    available: c => !!c.as && has('asc'),
    // Size column = asc -Osize (AS's smallest); timing = the -O3 speed build —
    // the fair mirror of jz's split (each compiler's best size vs best speed).
    bin: asSizeWasmPath,
    run: c => tryRun('as', c, () => {
      execFileSync('asc', [c.as, '-O3', '--runtime', 'stub', '--noAssert', '-o', asWasmPath(c)], { cwd: BENCH_DIR, stdio: 'pipe' })
      execFileSync('asc', [c.as, '-Osize', '--runtime', 'stub', '--noAssert', '-o', asSizeWasmPath(c)], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, ['node', join(LIB, 'run-as.mjs'), asWasmPath(c)]),
  },
  // ── Rivals compiled to wasm32-wasi, run in node's V8 — the honest apples-to-apples
  //    axis (jz ships wasm; so does Rust/Go/Zig/C here). Native stays only as a labeled
  //    reference. Each rival is its own unmodified self-timing source. ──
  'rust-wasm': {
    name: 'Rust → wasm (V8)',
    available: c => !!c.rs && has('rustc'),
    bin: rustWasmPath,
    run: c => tryRun('rust-wasm', c, () => {
      execFileSync('rustc', ['--target', 'wasm32-wasip1', '-C', 'opt-level=3', '-o', rustWasmPath(c), c.rs], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, ['node', '--no-warnings', join(LIB, 'run-wasi.mjs'), rustWasmPath(c)]),
  },
  'go-wasm': {
    name: 'Go → wasm (V8)',
    available: c => !!c.go && has('go'),
    bin: goWasmPath,
    run: c => tryRun('go-wasm', c, () => {
      const goCache = build('go-cache')
      mkdirSync(goCache, { recursive: true })
      execFileSync('go', ['build', '-ldflags=-s -w', '-o', goWasmPath(c), c.go], { cwd: BENCH_DIR, stdio: 'pipe', env: { ...process.env, GOOS: 'wasip1', GOARCH: 'wasm', GOCACHE: goCache } })
    }, ['node', '--no-warnings', join(LIB, 'run-wasi.mjs'), goWasmPath(c)]),
  },
  // zig 0.16's std.Io / Io.File.stdout writer is silent under node:wasi, and so is
  // wasi-libc (`-lc`) — both swallow stdout. So the cases time via the WASI
  // clock_time_get import and print via fd_write directly (shared _lib/bench.zig),
  // and the wasm build links NO libc. Verified under node:wasi AND wasmtime.
  'zig-wasm': {
    name: 'Zig → wasm (V8)',
    available: c => !!c.zig && has('zig'),
    bin: zigWasmPath,
    run: c => tryRun('zig-wasm', c, () => {
      const zigCache = build('zig-cache')
      const zigGlobalCache = build('zig-global-cache')
      mkdirSync(zigCache, { recursive: true })
      mkdirSync(zigGlobalCache, { recursive: true })
      execFileSync('zig', ['build-exe', '-target', 'wasm32-wasi', '-O', 'ReleaseFast', '-femit-bin=' + zigWasmPath(c), '--cache-dir', zigCache, '--global-cache-dir', zigGlobalCache, ...zigModuleArgs(c.zig)], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, ['node', '--no-warnings', join(LIB, 'run-wasi.mjs'), zigWasmPath(c)]),
  },
  'c-wasm': {
    name: 'C → wasm (V8)',
    available: c => !!c.c && has('zig'),   // zig cc bundles clang + wasi-libc (no emcc/wasi-sdk needed)
    bin: cWasmPath,
    run: c => tryRun('c-wasm', c, () => {
      execFileSync('zig', ['cc', '-target', 'wasm32-wasi', '-O3', '-ffp-contract=off', '-o', cWasmPath(c), c.c], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, ['node', '--no-warnings', join(LIB, 'run-wasi.mjs'), cWasmPath(c)]),
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
      execFileSync('clang', ['-O3', '-ffp-contract=off', ...macSysrootArgs, `-I${WABT_W2C_DIR}`, ...(existsSync(SIMDE_DIR) ? [`-I${SIMDE_DIR}`] : []), host, cFile, join(WABT_W2C_DIR, 'wasm-rt-impl.c'), join(WABT_W2C_DIR, 'wasm-rt-mem-impl.c'), '-o', w2cBinPath(c)], { cwd: BENCH_DIR, stdio: 'pipe' })
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
  // Javy — JS→wasm by embedding QuickJS. A FENCED reference, never in the headline
  // geomean (SVG_TARGETS): it ships a full interpreter, so it answers "JS in a wasm
  // interpreter" — a different question from the compiled-code field jz competes in
  // (see bench/README.md). Runs the same flat source the JS engines do.
  javy: {
    name: 'Javy (QuickJS-in-wasm)',
    available: () => has('javy'),
    bin: javyWasmPath,
    run: c => tryRun('javy', c, () => {
      writeFlat(c)
      execFileSync('javy', ['compile', flatPath(c), '-o', javyWasmPath(c)], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, ['node', '--no-warnings', join(LIB, 'run-javy.mjs'), javyWasmPath(c)]),
  },
  // TinyGo — the same .go sources as `go`/`go-wasm`, through LLVM instead of the gc
  // runtime: a much smaller/leaner wasm than `GOOS=wasip1`. A real wasm-band rival
  // (reuses the Go corpus, no new sources). Limited stdlib — cases it can't compile
  // surface as honest coverage misses.
  tinygo: {
    name: 'TinyGo → wasm (V8)',
    available: c => !!c.go && has('tinygo'),
    bin: tinygoWasmPath,
    run: c => tryRun('tinygo', c, () => {
      execFileSync('tinygo', ['build', '-target=wasip1', '-opt=2', '-no-debug', '-o', tinygoWasmPath(c), c.go], { cwd: BENCH_DIR, stdio: 'pipe' })
    }, ['node', '--no-warnings', join(LIB, 'run-wasi.mjs'), tinygoWasmPath(c)]),
  },
  // MoonBit — its own wasm-first language, compiled to the linear-memory `wasm`
  // backend and run on moonrun (MoonBit's V8-based wasm runner, which supplies the
  // monotonic clock the timing uses — like jz-wasmtime runs on wasmtime). The case
  // .mbt drops into a generated single-package project alongside the shared
  // _lib/bench.mbt helper; `moon build --release` emits the standalone wasm.
  moonbit: {
    name: 'MoonBit → wasm (moonrun)',
    available: c => !!c.mbt && has('moon') && has('moonrun'),
    bin: moonbitWasmPath,
    run: c => tryRun('moonbit', c, () => {
      const proj = moonbitProjDir(c)
      mkdirSync(join(proj, 'src'), { recursive: true })
      writeFileSync(join(proj, 'moon.mod'), 'name = "bench/case"\nversion = "0.1.0"\n')
      writeFileSync(join(proj, 'src', 'moon.pkg'), 'import {\n  "moonbitlang/core/bench" @bench,\n}\noptions(\n  "is-main": true,\n)\n')
      copyFileSync(MOONBIT_LIB, join(proj, 'src', 'bench.mbt'))
      copyFileSync(c.mbt, join(proj, 'src', 'main.mbt'))
      execFileSync('moon', ['build', '--target', 'wasm', '--release', '--target-dir', join(proj, '_b')], { cwd: proj, stdio: 'pipe' })
    }, ['moonrun', moonbitWasmPath(c)]),
  },
}

// Exact invocation per target — emitted into results.json meta so the bench
// page methodology table renders from data, not a hand-maintained copy.
// <case> stands for the case id.
const TARGET_CMDS = {
  nat: 'clang -O3 -march=native -ffp-contract=off <case>.c',
  natgcc: 'gcc -O3 -ffp-contract=off <case>.c',
  rust: 'rustc -C opt-level=3 -C target-cpu=native <case>.rs',
  go: 'go build -ldflags="-s -w" <case>.go',
  zig: 'zig build-exe <case>.zig -O ReleaseFast (shared _lib/bench.zig)',
  numpy: 'python3 <case>.npy.py',
  wat: 'wat2wasm <case>.wat → node run-wat.mjs (V8 wasm)',
  v8: 'node run-v8.mjs <case>.js',
  deno: 'deno run --allow-read --allow-env run-v8.mjs <case>.js',
  bun: 'bun run-v8.mjs <case>.js',
  spidermonkey: 'js <case>-flat.js',
  jsc: 'jsc <case>-flat.js',
  shermes: 'shermes -O <case>-flat.js -o <case>',
  graaljs: 'graaljs <case>-flat.js',
  porf: 'porf --allocator-chunks=128 run <case>-flat.js',
  jz: "time: compile(src, { optimize: 'speed' }); size: compile(src, { optimize: 'size' }) → node (V8 wasm)",
  as: 'time: asc <case>.as.ts -O3; size: asc <case>.as.ts -Osize (--runtime stub --noAssert)',
  'rust-wasm': 'rustc --target wasm32-wasip1 -C opt-level=3 <case>.rs → node (V8 wasm)',
  'go-wasm': 'GOOS=wasip1 GOARCH=wasm go build <case>.go → node (V8 wasm)',
  'zig-wasm': 'zig build-exe -target wasm32-wasi -O ReleaseFast <case>.zig (no libc) → node (V8 wasm)',
  'c-wasm': 'zig cc -target wasm32-wasi -O3 -ffp-contract=off <case>.c → node (V8 wasm)',
  'jz-wasmtime': 'jz --host wasi -O3 <case>.js → wasmtime --invoke main',
  'jz-w2c': 'jz --host wasi -O3 → wasm2c → clang -O3 -ffp-contract=off',
  jawsm: 'jawsm <case>.js → node (V8 wasm)',
  javy: 'javy compile <case>-flat.js → node (V8 wasm) · fenced interpreter reference',
  tinygo: 'tinygo build -target=wasip1 -opt=2 <case>.go → node (V8 wasm)',
  moonbit: 'moon build --target wasm --release <case>.mbt → moonrun (V8 wasm)',
}

const allCases = discoverCases()
const caseById = Object.fromEntries(allCases.map(c => [c.id, c]))
const targetIds = Object.keys(targets)
const targetIdWidth = Math.max(11, ...targetIds.map(id => id.length))
let selectedCases = allCases.map(c => c.id)
let selectedTargets = targetIds

// --json[=path]: write bench/results.json (consumed by bench/index.html) plus
// per-case browser wasm artifacts under bench/web/ for the live in-page runner.
// --emit-web: write only bench/web/*.wasm (skip all measurement) — the cheap
// path pages.yml runs to (re)build the live-runner artifacts at deploy time.
let JSON_PATH = null
let EMIT_WEB = false
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--targets=')) selectedTargets = arg.slice(10).split(',').filter(Boolean)
  else if (arg.startsWith('--cases=')) selectedCases = arg.slice(8).split(',').filter(Boolean)
  else if (arg.startsWith('--workloads=')) selectedCases = arg.slice(12).split(',').filter(Boolean)
  else if (arg === '--json') JSON_PATH = join(BENCH_DIR, 'results.json')
  else if (arg.startsWith('--json=')) JSON_PATH = resolve(arg.slice(7))
  else if (arg === '--emit-web') EMIT_WEB = true
  // Bare args are CASES first (the documented `bench.mjs mat4` form): `jz` is
  // both a case (the self-host compiler workload) and a target — the case
  // wins; select the target via --targets=jz.
  else if (caseById[arg]) selectedCases = [arg]
  else if (targetIds.includes(arg)) selectedTargets = [arg]
  else { console.error(`unknown case/target: ${arg}`); process.exitCode = 2 }
}
const jsonOut = { meta: null, cases: {} }
if (process.exitCode) process.exit(process.exitCode)

for (const id of selectedTargets) if (!targets[id]) { console.error(`unknown target: ${id}`); process.exit(2) }
for (const id of selectedCases) if (!caseById[id]) { console.error(`unknown case: ${id}`); process.exit(2) }

// --emit-web: compile just the page's playable cases to bench/web/*.wasm and
// stop — no measurement, no native/JS-engine toolchains. The cheap step
// pages.yml runs to (re)build the live in-page runner's artifacts at deploy.
// Self-host rows (jz/watr/jessie) are hidden from the page, so they're never
// emitted — that's the multi-MB jz.wasm we keep out of the deploy entirely.
if (EMIT_WEB) {
  const { built } = emitWebWasm(selectedCases.filter(cid => !HIDDEN_FROM_GEOMEAN.has(cid)))
  console.log(`wrote bench/web/{${built.join(',')}}.wasm`)
  process.exit(0)
}

// Per-(case, target) valid medians, collected to drive the geomean bench.svg.
const grid = {}
// The engines in bench/bench.svg — the corpus headline: jz vs the WASM field
// (Rust/Go/C/Zig compiled to wasm, AssemblyScript, Porffor — all run in node's
// V8, apples-to-apples with jz) and V8 (plain JS). native C is the lone non-wasm
// row, kept as a labeled speed-of-light reference (the aggregate ceiling), never
// a beat-claim. Per case (bench/index.html) native gets its OWN fair lane —
// jz-w2c (jz → wasm2c → clang) vs the native toolchains — so a native binary
// never races jz-wasm directly; this corpus headline keeps native C as the
// ceiling. A target with no data on a run is simply skipped.
const SVG_TARGETS = [
  { id: 'jz', label: 'JZ', sub: '-O3' },
  { id: 'c-wasm', label: 'C', sub: 'clang → wasm' },
  { id: 'rust-wasm', label: 'Rust', sub: 'rustc → wasm' },
  { id: 'go-wasm', label: 'Go', sub: 'gc → wasm' },
  { id: 'zig-wasm', label: 'Zig', sub: 'zig → wasm' },
  { id: 'moonbit', label: 'MoonBit', sub: 'moonrun → wasm' },
  { id: 'as', label: 'AssemblyScript', sub: 'asc -O3' },
  { id: 'porf', label: 'Porffor', sub: 'JS → wasm' },
  { id: 'v8', label: 'V8', sub: 'Node (JS)' },
  { id: 'nat', label: 'native C', sub: 'clang -O3 · ref' },
]

for (const cid of selectedCases) {
  const c = caseById[cid]
  console.log(`\n# ${c.name} (${c.id})`)
  const results = []
  // Targets that were AVAILABLE (toolchain present + source exists) but failed to
  // compile or run — the honest "did not compile" signal. Distinct from a skip
  // (toolchain absent / no source for this case), which is simply not measured.
  const failures = []
  for (const tid of selectedTargets) {
    const t = targets[tid]
    if (!t.available(c)) {
      console.log(`[skip] ${tid.padEnd(targetIdWidth)} ${t.name}`)
      continue
    }
    process.stdout.write(`[run]  ${tid.padEnd(targetIdWidth)} ${t.name} … `)
    const r = t.run(c)
    if (r.error) { console.log(`FAIL — ${r.error}`); failures.push({ id: tid, reason: r.error }); continue }
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
  // Known FMA-fusion parity classes (Go's arm64 backend force-fuses a*b+c to
  // FMADDD — no flag to disable it — so its recurrence/butterfly rounding differs
  // by the last ulp; still IEEE-correct, same algorithm). One alternate checksum
  // per case, measured on arm64.
  const fmaChecksums = { biquad: 3650557234, fft: 4196606268, synth: 1018085448, nbody: 587496398, lorenz: 1903597547, raytrace: 2776628753 }
  const fmaCs = fmaChecksums[c.id]

  const csCounts = {}
  for (const r of results) {
    if (r.checksum === fmaCs) continue
    csCounts[r.checksum] = (csCounts[r.checksum] || 0) + 1
  }
  const refCs = +(Object.entries(csCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? results[0].checksum)
  // Record correct-result medians for the geomean SVG (a DIFF result is excluded).
  grid[cid] = {}
  for (const r of results) if (r.checksum === refCs || r.checksum === fmaCs) grid[cid][r.id] = r.medianUs
  const nat = results.find(r => r.id === 'nat')
  const baseline = nat || [...results].sort((a, b) => a.medianUs - b.medianUs)[0]

  if (JSON_PATH) {
    jsonOut.cases[c.id] = {
      name: c.name,
      samples: results[0].samples, stages: results[0].stages, runs: results[0].runs,
      ref: refCs,
      targets: Object.fromEntries([
        ...results.map(r => [r.id, {
          medianUs: r.medianUs,
          bytes: r.bytes ?? null,
          parity: r.checksum === refCs ? 'ok' : r.checksum === fmaCs ? 'fma' : 'DIFF',
        }]),
        // Attempted-but-failed targets carry their reason (no medianUs) so the page
        // can render coverage honestly instead of silently dropping the row.
        ...failures.map(f => [f.id, { status: 'fail', reason: f.reason }]),
      ]),
    }
  }

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

// Regenerate bench/bench.svg from freshly measured geomeans — only when every
// non-hidden case ran (a filtered run can't clobber the committed artifact with
// partial data). The SVG geomean excludes the self-referential cases anyway, so
// the slow self-host rows need not run to refresh it. ratio = geomean(engine / jz)
// over correct-result cases both ran.
const svgCases = allCases.map(c => c.id).filter(cid => !HIDDEN_FROM_GEOMEAN.has(cid))
if (svgCases.every(cid => selectedCases.includes(cid))) {
  const geoCases = selectedCases.filter(cid => !HIDDEN_FROM_GEOMEAN.has(cid))
  const rows = []
  for (const t of SVG_TARGETS) {
    const ratios = []
    for (const cid of geoCases) {
      const g = grid[cid]
      if (g && g[t.id] != null && g.jz != null) ratios.push(g[t.id] / g.jz)
    }
    if (!ratios.length) continue
    const geo = Math.exp(ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length)
    rows.push({ label: t.label, ratio: geo, sub: t.id === 'porf' ? `runs ${ratios.length} / ${geoCases.length}` : t.sub })
  }
  if (rows.length > 1 && rows.some(r => r.label === 'JZ')) {
    renderBenchSvg(rows, geoCases.length)
    console.log(`\nwrote bench/bench.svg — ${rows.map(r => `${r.label} ${r.ratio.toFixed(2)}×`).join('  ')}`)
  }
}

// Compile the page's playable cases to bench/web/<case>.wasm for the live
// in-browser runner. Default js-host lowering, so jz/interop's instantiate()
// wires console/perf with zero custom imports. The compile is timed (median of
// 3) — the same number the page measures live in the visitor's tab. Returns
// { built:[ids], compileMs:{id} }; callers pass the playable set, so the hidden
// self-host rows' multi-MB wasm is never written.
function emitWebWasm(caseIds) {
  const webDir = join(BENCH_DIR, 'web')
  mkdirSync(webDir, { recursive: true })
  const built = []
  const compileMs = {}
  for (const cid of caseIds) {
    const c = caseById[cid]
    try {
      const isWatr = c.id === 'watr'
      const isGraph = GRAPH_CASES.has(c.id)
      let code, modules
      if (isGraph) {
        ;({ code, modules } = graphSources(c))
        modules[resolve(LIB, 'benchlib.js')] = readFileSync(join(LIB, 'benchlib.js'), 'utf8')
      } else {
        code = readFileSync(c.js, 'utf8')
        modules = {
          '../_lib/benchlib.js': readFileSync(join(LIB, 'benchlib.js'), 'utf8'),
          ...(isWatr ? watrModuleSources() : {}),
        }
      }
      const opts = { jzify: isWatr || isGraph, modules, optimize: { level: 'speed' }, ...caseMemory(c) }
      let wasm
      const times = []
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now()
        wasm = compile(code, opts)
        times.push(performance.now() - t0)
      }
      writeFileSync(join(webDir, `${c.id}.wasm`), wasm)
      compileMs[cid] = +times.sort((a, b) => a - b)[1].toFixed(1)
      built.push(cid)
    } catch (e) {
      console.error(`[web] ${cid}: ${String(e.message || e).split('\n')[0]}`)
    }
  }
  return { built, compileMs }
}

// ── --json: machine-readable snapshot + browser wasm artifacts ───────────────
if (JSON_PATH) {
  const ver = cmd => versionText(cmd).trim().split('\n')[0] || null
  const usedTargets = new Set()
  for (const c of Object.values(jsonOut.cases)) for (const tid of Object.keys(c.targets)) usedTargets.add(tid)
  jsonOut.meta = {
    date: new Date().toISOString().slice(0, 10),
    commit: (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() } catch { return null } })(),
    host: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? null },
    versions: Object.fromEntries(Object.entries({
      jz: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
      node: process.version,
      asc: has('asc') && ver('asc'),
      porffor: has(PORF_BIN) && ver(PORF_BIN),
      bun: has(BUN_BIN) && ver(BUN_BIN),
      deno: has(DENO_BIN) && ver(DENO_BIN),
      clang: has('clang') && ver('clang'),
    }).filter(([, v]) => v)),
    invocations: Object.fromEntries([...usedTargets].filter(tid => TARGET_CMDS[tid]).map(tid => [tid, TARGET_CMDS[tid]])),
  }

  // Per-case wasm for the in-page runner (playable cases only — the self-host
  // rows are hidden from the page, so their multi-MB artifacts never ship).
  // compileMs lands back on each case as the page's live compile-time reference.
  const { built, compileMs } = emitWebWasm(selectedCases.filter(cid => !HIDDEN_FROM_GEOMEAN.has(cid)))
  for (const [cid, ms] of Object.entries(compileMs)) if (jsonOut.cases[cid]) jsonOut.cases[cid].compileMs = ms
  writeFileSync(JSON_PATH, JSON.stringify(jsonOut, null, 1))
  console.log(`\nwrote ${JSON_PATH} + bench/web/{${built.join(',')}}.wasm`)
}
