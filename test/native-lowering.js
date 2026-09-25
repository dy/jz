import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const POST = join(ROOT, 'scripts/native/postprocess-watr.awk')
const fixture = `#define FORCE_READ_INT(var) __asm__("" ::"r"(var));
#define FORCE_READ_FLOAT(var) __asm__("" ::"f"(var));
#define DEFINE_STORE(name, t1, t2)
DEFINE_STORE(i64_store32, u32, u64)
#define SIMD_FORCE_READ(var) __asm__("" ::"w"(var));
// clang-format on
static void init_globals(w2c_kernel* instance) {
}
static struct wasm_multi_0x2 w2c_kernel_f0(w2c_kernel * instance, u32 x) {
}
u32 w2c_kernel_main(w2c_kernel* instance) {
}
f64 w2c_kernel_wide(w2c_kernel* instance, f64 a, f64 b, f64 c,
    f64 d, f64 e) {
}
void wasm2c_kernel_instantiate(w2c_kernel* instance, void* imports) {
}
`

test('native wasm2c postprocess is module-generic and fail-closed', () => {
  const out = execFileSync('awk', ['-f', POST], { input: fixture, encoding: 'utf8' })
  is((out.match(/_md = instance->w2c_memory\.data/g) || []).length, 3,
    'injects generated scalar, struct-return, and wrapped-signature functions only')
  ok(!/__asm__/.test(out), 'removes WABT FORCE_READ barriers')
  ok(/#define i32_load\(mem, addr\)/.test(out), 'shadows scalar memory helpers')
  ok(/#define v128_load\(mem, addr\).*_md/.test(out), 'shadows SIMD memory helpers')
  ok(!/init_globals[^}]*_md/s.test(out), 'does not read memory before initialization')
  ok(!/wasm2c_kernel_instantiate[^}]*_md/s.test(out), 'does not touch lifecycle functions')

  const bad = spawnSync('awk', ['-f', POST], { input: 'void f(void) {}\n', encoding: 'utf8' })
  ok(bad.status !== 0, 'generator-format drift fails instead of silently losing tuning')
})

test('native bench adapters: installed/source headers and current/legacy w2c2 ABIs', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'jz native adapters '))
  try {
    const hook = join(scratch, 'tools.mjs')
    writeFileSync(hook, `import cp from 'node:child_process'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const exec = cp.execFileSync, spawn = cp.spawnSync
const mode = process.env.JZ_NATIVE_ABI, modern = mode === 'current'
cp.execFileSync = (cmd, args, opts) => {
  if (cmd === 'wasm2c') {
    writeFileSync(args[args.indexOf('-o') + 1], ${JSON.stringify(fixture)})
    return Buffer.alloc(0)
  }
  if (cmd === process.env.W2C2_BIN) {
    const mod = modern ? 'm7_alphant' : 'alphant'
    writeFileSync(args[1].replace(/\\.c$/, '.h'), mode === 'unknown' ? '' :
      'typedef struct ' + mod + 'Instance {};\\nwasmMemory* ' + mod + (modern ? 'Export6_memory(' : '_memory('))
    return Buffer.alloc(0)
  }
  if (cmd === 'clang') {
    assert(args.includes('-lm'), 'link math runtime on Linux')
    if (args.some(a => a.endsWith('-w2c-host.c'))) {
      assert(args.includes('-I' + process.env.WABT_W2C_DIR), 'runtime source headers')
      assert(args.includes('-I' + process.env.JZ_NATIVE_INCLUDE), 'public runtime headers')
    } else {
      const host = readFileSync(args.find(a => a.endsWith('-w2c2-host.c')), 'utf8')
      const mod = modern ? 'm7_alphant' : 'alphant'
      for (const symbol of [mod + 'Instance', mod + 'Instantiate', mod + 'FreeInstance',
        mod + (modern ? 'Export6_memory' : '_memory'), mod + (modern ? 'Export4_main' : '_main'),
        modern ? 'i22_wasiX5FsnapshotX5Fpreview18_fdX5Fwrite(wasmModuleInstance* inst' : 'wasi_snapshot_preview1__fd_write(void* inst',
        modern ? 'i22_wasiX5FsnapshotX5Fpreview114_clockX5FtimeX5Fget(wasmModuleInstance* inst' : 'wasi_snapshot_preview1__clock_time_get(void* inst'])
        assert(host.includes(symbol), symbol)
    }
    writeFileSync(args[args.indexOf('-o') + 1], 'native artifact')
    return Buffer.alloc(0)
  }
  return exec(cmd, args, opts)
}
cp.spawnSync = (cmd, args, opts) => {
  if (cmd === '/usr/bin/time') return { status: 1 }
  if (cmd === 'which' && ['wasm2c', 'clang'].includes(args[0])) return { status: 0 }
  if (/alpha-w2c2?$/.test(cmd)) return { status: 0, stdout: 'median_us=10 checksum=633180752 samples=1 stages=1 runs=1', stderr: '' }
  return spawn(cmd, args, opts)
}
syncBuiltinESMExports()
`)
    for (const mode of ['legacy', 'current', 'unknown']) {
      const dir = join(scratch, mode), installed = mode === 'current'
      const runtime = installed ? join(dir, 'share/wabt/wasm2c') : join(dir, 'wasm2c')
      const include = installed ? join(dir, 'include') : runtime
      mkdirSync(runtime, { recursive: true })
      mkdirSync(include, { recursive: true })
      for (const file of [join(include, 'wasm-rt.h'), join(runtime, 'wasm-rt-impl.c'), join(dir, 'w2c2_base.h'), join(dir, 'w2c2')])
        writeFileSync(file, '')
      const json = join(dir, 'results.json')
      execFileSync(process.execPath, ['--import', hook, join(ROOT, 'bench/bench.mjs'),
        '--targets=jz-w2c,jz-w2c2', '--cases=alpha', `--json=${json}`], {
        encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, WABT_W2C_DIR: runtime, WABT_INCLUDE_DIR: '',
          W2C2_DIR: dir, W2C2_BIN: join(dir, 'w2c2'), JZ_NATIVE_ABI: mode, JZ_NATIVE_INCLUDE: include,
          JZ_BENCH_BUILD_DIR: join(dir, 'build'), JZ_BENCH_WEB_DIR: join(dir, 'web') },
      })
      const rows = JSON.parse(readFileSync(json, 'utf8')).cases.alpha.targets
      is(rows['jz-w2c'].parity, 'ok', `${mode}: WABT headers and linking`)
      if (mode === 'unknown') {
        is(rows['jz-w2c2'].status, 'fail', 'unrecognized generated API fails closed')
        ok(rows['jz-w2c2'].reason.includes('unrecognized w2c2 instance declaration'))
      } else is(rows['jz-w2c2'].parity, 'ok', `${mode}: imports, exports and lifecycle agree`)
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
