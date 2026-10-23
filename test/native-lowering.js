import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDED, toolchain } from '../scripts/native/compile.mjs'

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
    if (args.some(a => a.endsWith('/native/wasi.c'))) {
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
  if (cmd === 'which' && ['wasm2c', 'clang'].includes(args[0])) return { status: 0, stdout: '/usr/bin/' + args[0] + '\\n' }
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

// ── scripts/native/compile.mjs: a jz program as a native executable ─────────
// Built for real: wasm2c, its runtime and a C compiler must be present (CI's
// bench workflow installs them); elsewhere these skip with the reason below.
const COMPILE = join(ROOT, 'scripts/native/compile.mjs')
const NATIVE = toolchain()
const WASMTIME = spawnSync('wasmtime', ['--version'], { stdio: 'ignore' }).status === 0
if (NATIVE.error) console.log(`# native executable tests skipped: ${NATIVE.error}`)
else if (!WASMTIME) console.log('# wasmtime not installed: native executables are checked against node only')

const scratchDir = (name, fn) => {
  const dir = mkdtempSync(join(tmpdir(), `jz-native-${name}-`))
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
// The program's source, its native executable, and on request its wasi module.
const build = (dir, name, src, wasi = true) => {
  const js = join(dir, `${name}.mjs`), bin = join(dir, name), wasm = join(dir, `${name}.wasm`)
  writeFileSync(js, src)
  execFileSync(process.execPath, [COMPILE, js, '-o', bin], { stdio: 'pipe' })
  if (wasi) execFileSync(process.execPath, [join(ROOT, 'cli.js'), js, '--host', 'wasi', '-o', wasm], { stdio: 'pipe' })
  return { js, bin, wasm }
}

// discussion #116's Chrome Native Messaging host, its loop at top level so that
// `node host.mjs` runs it too: 4-byte little-endian length, UTF-8 JSON body.
const NM_HOST = `import fs from 'fs'
const readFull = (buf) => {
  let n = 0
  while (n < buf.length) {
    const r = fs.readSync(0, buf, n, buf.length - n)
    if (r === 0) return false
    n += r
  }
  return true
}
const head = new Uint8Array(4), h = new Uint8Array(4)
const serve = () => {
  const body = new Uint8Array(head[0] | head[1] << 8 | head[2] << 16 | head[3] << 24)
  if (!readFull(body)) return false
  const out = new TextEncoder().encode(JSON.stringify({ echo: JSON.parse(new TextDecoder().decode(body)) }))
  h[0] = out.length; h[1] = out.length >> 8; h[2] = out.length >> 16; h[3] = out.length >> 24
  fs.writeSync(1, h)
  fs.writeSync(1, out)
  return true
}
while (readFull(head) && serve());
`

test('native executable: a Native Messaging host answers byte for byte as node and wasmtime do', { skip: !!NATIVE.error }, () => scratchDir('nm', dir => {
  const { js, bin, wasm } = build(dir, 'host', NM_HOST)
  const frame = s => { const b = Buffer.from(s), h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]) }
  const pad = n => `{"pad":"${'x'.repeat(n - 10)}"}`  // a JSON body of exactly n bytes
  const msgs = ['{"ping":true}', pad(0xc8), '{"msg":"héllo ✓ 𝄞","n":[1,2.5,-3,1e21,0.1],"o":{"a":null,"b":[true,false]}}',
    pad(300000), pad(1 << 20)]
  ok(msgs.some(m => Buffer.byteLength(m) & 0x80) && Buffer.byteLength(msgs.at(-1)) === 1 << 20, 'length bytes >= 0x80 and a 1 MiB body')
  // A message cut off by EOF ends the loop without a reply, as an EOF between messages does.
  const input = Buffer.concat([...msgs.map(frame), Buffer.from([10, 0, 0, 0, 0x7b, 0x7d])])
  // A pipe hands the 1 MiB body over in partial reads, so readFull's loop runs.
  const run = (cmd, args) => spawnSync(cmd, args, { input, maxBuffer: 64 << 20 })

  const node = run(process.execPath, [js])
  is(node.status, 0, 'node exits cleanly')
  const replies = []
  for (let at = 0; at < node.stdout.length; at += 4 + node.stdout.readUInt32LE(at))
    replies.push(node.stdout.subarray(at + 4, at + 4 + node.stdout.readUInt32LE(at)).toString())
  is(replies.map(r => JSON.parse(r).echo), msgs.map(m => JSON.parse(m)), 'node: one framed echo per complete message')

  const native = run(bin, [])
  is(native.status, 0, 'native exits 0 at EOF')
  is(String(native.stderr), '', 'native writes nothing to stderr')
  ok(native.stdout.equals(node.stdout), `native = node, ${node.stdout.length} bytes`)
  // The module `jz host.mjs --host wasi` wrote, tail calls kept, built as it is.
  execFileSync(process.execPath, [COMPILE, wasm, '-o', `${bin}-wasm`], { stdio: 'pipe' })
  ok(run(`${bin}-wasm`, []).stdout.equals(node.stdout), 'native from the --host wasi .wasm = node')
  if (WASMTIME) {
    const wt = run('wasmtime', [wasm])
    is(wt.status, 0, 'wasmtime exits 0 at EOF')
    ok(wt.stdout.equals(node.stdout), 'wasmtime = node')
  }
}))

test('native executable: every WASI import jz emits, and errno through try/catch and a trap', { skip: !!NATIVE.error }, () => scratchDir('wasi', dir => {
  const { bin, wasm } = build(dir, 'all', `import fs from 'fs'
fs.write('note.txt', 'héllo ✓')
const s = fs.read('note.txt')
const r = new Uint8Array(64)
crypto.getRandomValues(r)
let nz = 0
for (let i = 0; i < 64; i++) if (r[i]) nz++
console.log(s, s.length, nz > 40, Date.now() > 1.7e12, performance.now() >= 0)
`)
  is(WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(wasm))).map(i => i.name).sort(), [...PROVIDED].sort(),
    'the program imports every function the shim provides')
  const expected = 'héllo ✓ 7 true true true\n'
  // fd 3, the first preopen, is the working directory.
  is(execFileSync(bin, { cwd: dir, encoding: 'utf8' }), expected, 'native: path_open/fd_read/fd_write/fd_close/fd_filestat_get/random_get/clock_time_get')
  is(readFileSync(join(dir, 'note.txt'), 'utf8'), 'héllo ✓', 'native: the file holds UTF-8')
  if (WASMTIME) is(execFileSync('wasmtime', ['--dir', '.', wasm], { cwd: dir, encoding: 'utf8' }), expected, 'wasmtime --dir . agrees')

  const errno = build(dir, 'errno', `import fs from 'fs'
const b = new Uint8Array(1)
try { fs.readSync(99, b, 0, 1) } catch (e) { console.log('caught', e) }
fs.readSync(99, b, 0, 1)
console.log('not reached')
`, false)
  const r2 = spawnSync(errno.bin, { encoding: 'utf8' })
  is(r2.stdout, 'caught 8\n', 'a bad descriptor throws WASI EBADF (8), caught by try/catch')
  is(r2.status, 134, 'an uncaught throw traps with exit status 134, as wasmtime does')
  ok(/^wasm trap: /.test(r2.stderr), 'the trap reason goes to stderr')
}))
